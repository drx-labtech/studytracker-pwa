const DB_NAME = "studytracker";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("subjects")) {
        const s = db.createObjectStore("subjects", { keyPath: "id", autoIncrement: true });
        s.createIndex("name", "name", { unique: true });
      }

      if (!db.objectStoreNames.contains("sessions")) {
        const s = db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
        s.createIndex("subject_id", "subject_id", { unique: false });
        s.createIndex("start_day", "start_day", { unique: false }); // YYYY-MM-DD (start_time 기준)
        s.createIndex("end_time", "end_time", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

export async function initDB() {
  const db = await openDB();
  return db;
}

export async function listSubjects(db) {
  return new Promise((resolve, reject) => {
    const store = tx(db, "subjects");
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result.sort((a,b)=>a.id-b.id));
    req.onerror = () => reject(req.error);
  });
}

export async function addSubject(db, name) {
  name = (name ?? "").trim();
  if (!name) throw new Error("항목 이름이 비어 있습니다.");
  return new Promise((resolve, reject) => {
    const store = tx(db, "subjects", "readwrite");
    const req = store.add({ name });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      if (req.error?.name === "ConstraintError") reject(new Error("이미 존재하는 항목입니다."));
      else reject(req.error);
    };
  });
}

export async function getActiveSession(db) {
  // end_time == null 인 세션 1개만 허용
  return new Promise((resolve, reject) => {
    const store = tx(db, "sessions");
    const req = store.getAll();
    req.onsuccess = () => {
      const active = req.result.filter(s => s.end_time == null).sort((a,b)=> (a.start_time > b.start_time ? 1 : -1))[0];
      resolve(active ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function startSession(db, subject_id, minutes) {
  const active = await getActiveSession(db);
  if (active) throw new Error("이미 진행 중인 세션이 있습니다.");

  const start = new Date();
  const end = new Date(start.getTime() + minutes * 60000);
  const start_day = start.toISOString().slice(0,10); // start_time 기준(PC 버전 통일)

  const rec = {
    subject_id,
    start_time: start.toISOString(),
    planned_end_time: end.toISOString(),
    end_time: null,
    duration_min: null,
    start_day,
  };

  return new Promise((resolve, reject) => {
    const store = tx(db, "sessions", "readwrite");
    const req = store.add(rec);
    req.onsuccess = () => resolve({ id: req.result, ...rec });
    req.onerror = () => reject(req.error);
  });
}

export async function endSessionNow(db) {
  const active = await getActiveSession(db);
  if (!active) throw new Error("진행 중인 세션이 없습니다.");

  const end = new Date();
  const start = new Date(active.start_time);
  const dur = Math.max(0, Math.ceil((end - start) / 60000));

  const updated = { ...active, end_time: end.toISOString(), duration_min: dur };

  return new Promise((resolve, reject) => {
    const store = tx(db, "sessions", "readwrite");
    const req = store.put(updated);
    req.onsuccess = () => resolve(updated);
    req.onerror = () => reject(req.error);
  });
}

export async function statsToday(db) {
  const day = new Date().toISOString().slice(0,10);
  return statsByStartDay(db, day);
}

export async function statsByStartDay(db, day) {
  const [subjects, sessions] = await Promise.all([listSubjects(db), listEndedSessions(db)]);
  const mapName = new Map(subjects.map(s => [s.id, s.name]));

  const sums = new Map(); // subject_id -> minutes
  for (const s of sessions) {
    if (s.start_day === day) {
      sums.set(s.subject_id, (sums.get(s.subject_id) ?? 0) + (s.duration_min ?? 0));
    }
  }

  const rows = [];
  for (const sub of subjects) {
    rows.push({ name: sub.name, minutes: sums.get(sub.id) ?? 0 });
  }
  return rows;
}

export async function renameSubject(db, subjectId, newName) {
  newName = (newName || "").trim();
  if (!newName) throw new Error("새 항목명은 비어 있을 수 없습니다.");

  return new Promise((resolve, reject) => {
    const tx = db.transaction("subjects", "readwrite");
    const store = tx.objectStore("subjects");

    const req = store.get(subjectId);
    req.onsuccess = () => {
      const obj = req.result;
      if (!obj) return reject(new Error("항목을 찾을 수 없습니다."));
      obj.name = newName;

      const put = store.put(obj);
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  });
}


export async function statsTotal(db) {
  const [subjects, sessions] = await Promise.all([listSubjects(db), listEndedSessions(db)]);
  const sums = new Map();
  for (const s of sessions) {
    sums.set(s.subject_id, (sums.get(s.subject_id) ?? 0) + (s.duration_min ?? 0));
  }
  return subjects.map(sub => ({ name: sub.name, minutes: sums.get(sub.id) ?? 0 }));
}


export async function resetAllSessions(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// "오늘"만 삭제(로컬 Date 기준) - start_time이 Date로 파싱 가능한 문자열이라고 가정
export async function resetTodaySessions(db) {
  const start = new Date();
  start.setHours(0,0,0,0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");

    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const v = cursor.value;

      const t = new Date(v.start_time);
      if (t >= start && t < end) cursor.delete();

      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}



async function listEndedSessions(db) {
  return new Promise((resolve, reject) => {
    const store = tx(db, "sessions");
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result.filter(s => s.end_time != null));
    req.onerror = () => reject(req.error);
  });
}

export async function exportAll(db) {
  const [subjects, sessions] = await Promise.all([
    new Promise((res, rej) => { const r = tx(db,"subjects").getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }),
    new Promise((res, rej) => { const r = tx(db,"sessions").getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }),
  ]);
  return { version: 1, exported_at: new Date().toISOString(), subjects, sessions };
}

export async function importAll(db, payload) {
  if (!payload || !Array.isArray(payload.subjects) || !Array.isArray(payload.sessions)) {
    throw new Error("백업 파일 형식이 올바르지 않습니다.");
  }

  // 전체 덮어쓰기(단순)
  await new Promise((resolve, reject) => {
    const t = db.transaction(["subjects","sessions"], "readwrite");
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);

    t.objectStore("subjects").clear();
    t.objectStore("sessions").clear();

    for (const s of payload.subjects) t.objectStore("subjects").add(s);
    for (const s of payload.sessions) t.objectStore("sessions").add(s);
  });
}

export async function deleteSubject(db, subjectId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("subjects", "readwrite");
    const store = tx.objectStore("subjects");

    const req = store.delete(subjectId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function resetSubjectSessions(db, subjectId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    const req = store.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const v = cursor.value;
      if (Number(v.subject_id) === Number(subjectId)) cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

