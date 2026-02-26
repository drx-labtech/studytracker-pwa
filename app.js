import {
  initDB, listSubjects, addSubject,
  getActiveSession, startSession, endSessionNow,
  statsToday, statsTotal, renameSubject,
  exportAll, importAll, resetTodaySessions, resetAllSessions, 
  deleteSubject
} from "./db.js";

alert("app.js loaded");

let db = null;
let lastSubjectId = null;
let lastMinutes = null;
let tickTimer = null;
let autoEnding = false;

const $ = (id) => document.getElementById(id);

function isoNowKSTLike() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function minutesFromUI() {
  const custom = ($("customMin").value || "").trim();
  if (custom) {
    const n = Number(custom);
    if (!Number.isFinite(n) || n <= 0) throw new Error("직접입력(분)은 1 이상의 숫자여야 합니다.");
    return Math.floor(n);
  }
  const activeChip = document.querySelector(".chip.active");
  if (!activeChip) throw new Error("프리셋 또는 직접입력(분)을 설정하세요.");
  return Number(activeChip.dataset.min);
}

async function refreshSubjects(selectKeep=true) {
  const subs = await listSubjects(db);
  const sel = $("subjectSelect");
  const prev = selectKeep ? sel.value : null;

  sel.innerHTML = "";
  for (const s of subs) {
    const opt = document.createElement("option");
    opt.value = String(s.id);
    opt.textContent = s.name;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function renderStats(container, rows) {
  container.innerHTML = "";
  let total = 0;
  for (const r of rows) {
    total += r.minutes;
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<div>${r.name}</div><div>${r.minutes}분 (${(r.minutes/60).toFixed(1)}h)</div>`;
    container.appendChild(div);
  }
  return total;
}

async function refreshStats() {
  const today = await statsToday(db);
  const total = await statsTotal(db);

  // 분 기준 내림차순(많이 한 순)
  today.sort((a,b)=>b.minutes-a.minutes);
  total.sort((a,b)=>b.minutes-a.minutes);

  const t1 = renderStats($("todayStats"), today);
  $("todayTotal").textContent = `총합: ${t1}분 (${(t1/60).toFixed(1)}시간)`;

  const t2 = renderStats($("totalStats"), total);
  $("totalTotal").textContent = `총합: ${t2}분 (${(t2/60).toFixed(1)}시간)`;
}

function setStatus(text) {
  $("sessionStatus").textContent = text || "";
}

function setCountdown(text) {
  $("countdown").textContent = text || "";
}

function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function refreshSessionUI() {
  const active = await getActiveSession(db);

  $("endBtn").disabled = !active;
  $("repeatBtn").disabled = !!active || lastSubjectId == null || lastMinutes == null;
  $("startBtn").disabled = !!active;

  if (!active) {
    setStatus("진행 중인 세션: 없음");
    $("countdown").className = "countdown done"; // ⬅ 추가
    setCountdown("");
    stopTick();
    return;
  }

  // ✅ 추가: subject_id → 과목명 찾기
  const subs = await listSubjects(db);
  const map = new Map(subs.map(s => [Number(s.id), s.name]));
  const subjectName = map.get(Number(active.subject_id)) ?? "(알 수 없음)";

  const start = new Date(active.start_time);
  const end = new Date(active.planned_end_time);
  const mins = Math.max(1, Math.ceil((end - start) / 60000));

  //setStatus(`진행 중인 세션\n시작: ${start.toLocaleString()}\n종료(예정): ${end.toLocaleString()}\n총 ${mins}분`);

  // ✅ 여기 setStatus에 subjectName만 끼워넣기
  setStatus(
    `진행 중인 세션: ${subjectName}\n` +
    `시작: ${start.toLocaleString()}\n` +
    `종료(예정): ${end.toLocaleString()}\n` +
    `총 ${mins}분`
  );


  stopTick();
   tickTimer = setInterval(async () => {
     const now = new Date();

     const totalSec = Math.floor((end - start) / 1000);
     const remainSec = Math.floor((end - now) / 1000);

     if (remainSec <= 0) {
       if (autoEnding) return;     // 중복 방지
       autoEnding = true;

       stopTick();                 // interval 끊기
       drawRing(1);

       // 완료 표시(원하면 문구는 바꿔도 됨)
       setCountdown("완료");

       // ✅ 핵심: DB 세션 자동 종료
       await endSessionNow(db);
       playEndAlarm(10000);   // 알람 소리 추가 

       autoEnding = false;

       // ✅ UI/통계 갱신 → active가 없어져서 repeatBtn 활성화됨
       await refreshSessionUI();
       await refreshStats();
       return;
     }



     const progress = Math.max(
       0,
       Math.min(1, 1 - remainSec / totalSec)
     );

     const mm = Math.floor(remainSec / 60);
     const ss = remainSec % 60;

     $("countdown").className = "countdown running"; // ⬅ 추가
     setCountdown(`${mm}분 ${String(ss).padStart(2,"0")}초 남음`);
     drawRing(progress);   // ⭐ 여기!
   }, 1000);

}

function wirePresetButtons() {
  document.querySelectorAll(".chip").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      $("customMin").value = ""; // 프리셋 선택 시 직접입력 비움
    });
  });

  $("customMin").addEventListener("input", () => {
    if (($("customMin").value || "").trim()) {
      document.querySelectorAll(".chip").forEach(b => b.classList.remove("active"));
    }
  });
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function drawRing(progress) {
  const canvas = document.getElementById("ringCanvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const r = w / 2 - 10;

  ctx.clearRect(0, 0, w, h);

  // 기본: 주황색 원 (처음엔 꽉 차 있음)
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#ff8a00";
  ctx.lineWidth = 12;
  ctx.stroke();

  // 경과 시간: 회색이 점점 덮음
  if (progress > 0) {
    ctx.beginPath();
    ctx.arc(
      w / 2,
      h / 2,
      r,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * progress
    );
    ctx.strokeStyle = "#e5e5e8";
    ctx.lineWidth = 12;
    ctx.lineCap = "butt";
    ctx.stroke();
  }
}

function playEndAlarm(ms = 10000) {
  try {
    // 모바일 진동(가능하면)
    if (navigator.vibrate) navigator.vibrate([200, 200, 200, 200, 200]);

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();

    const endAt = ctx.currentTime + ms / 1000;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(ctx.destination);

    // "삐-삐-"처럼 0.25초 울리고 0.25초 쉬기
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(gain);
    osc.start();

    const tick = () => {
      const t = ctx.currentTime;
      if (t >= endAt) {
        gain.gain.setValueAtTime(0.0001, t);
        osc.stop(t + 0.05);
        ctx.close();
        return;
      }
      // on
      gain.gain.setValueAtTime(0.25, t);
      // off
      gain.gain.setValueAtTime(0.0001, t + 0.25);
      setTimeout(tick, 500);
    };
    tick();
  } catch (e) {
    // 오디오가 막히는 브라우저도 있으니 조용히 무시
  }
}




async function main() {
  db = await initDB();

  // 기본 항목이 없으면 하나 만들어주기(첫 실행 UX)
  const subs = await listSubjects(db);
  if (subs.length === 0) {
    await addSubject(db, "공부");
  }

  await refreshSubjects();
  wirePresetButtons();

  // clock
  setInterval(()=> $("now").textContent = isoNowKSTLike(), 500);

  $("addSubjectBtn").addEventListener("click", async () => {
    try {
      const name = ($("newSubject").value || "").trim();
      await addSubject(db, name);
      $("newSubject").value = "";
      await refreshSubjects(false);
      await refreshStats();
    } catch (e) {
      alert(String(e.message || e));
    }
  });

  $("subjectSelect").addEventListener("change", () => {
    const name = $("subjectSelect").selectedOptions[0]?.textContent;
    $("renameSubject").value = name || "";
  });



  $("startBtn").addEventListener("click", async () => {
    try {
      //const subject_id = Number($("subjectSelect").value);
      const raw = $("subjectSelect").value;                 // ✅ 추가 (raw 선언)
      if (!raw) throw new Error("항목을 먼저 추가/선택하세요.");  // ✅ 추가

      const subject_id = Number(raw);                       // ✅ 여기서 subject_id 만들기
      const minutes = minutesFromUI();

      lastSubjectId = subject_id;
      lastMinutes = minutes;

      await startSession(db, subject_id, minutes);
      await refreshSessionUI();
      await refreshStats();
    } catch (e) {
      alert(String(e.message || e));
    }
  });

  $("endBtn").addEventListener("click", async () => {
    try {
      await endSessionNow(db);
      await refreshSessionUI();
      await refreshStats();
    } catch (e) {
      alert(String(e.message || e));
    }
  });

  $("repeatBtn").addEventListener("click", async () => {
    try {
      if (lastSubjectId == null || lastMinutes == null) return;
      await startSession(db, lastSubjectId, lastMinutes);
      await refreshSessionUI();
      await refreshStats();
    } catch (e) {
      alert(String(e.message || e));
    }
  });

  $("exportBtn").addEventListener("click", async () => {
    const payload = await exportAll(db);
    downloadJSON(`StudyTracker_backup_${new Date().toISOString().slice(0,10)}.json`, payload);
  });

  $("importFile").addEventListener("change", async (evt) => {
    const f = evt.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const payload = JSON.parse(text);
      await importAll(db, payload);
      await refreshSubjects(false);
      await refreshSessionUI();
      await refreshStats();
      alert("가져오기 완료");
    } catch (e) {
      alert(String(e.message || e));
    } finally {
      evt.target.value = "";
    }
  });

  $("deleteSubjectBtn").addEventListener("click", async () => {
    const id = Number($("subjectSelect").value);
    if (!id) return;

    const name = $("subjectSelect").selectedOptions[0]?.textContent;
   // if (!confirm(`"${name}" 항목을 삭제할까요?\n(기존 기록은 유지됩니다)`)) return;
    const mode = confirm(
    `"${name}" 항목을 삭제합니다.\n\n` +
    `확인 = 항목+기록(세션)까지 완전 삭제\n` +
    `취소 = 항목만 삭제(기록 유지)`
    );

    try {
      //if (mode) {
      //  await resetSubjectSessions(db, id); // 기록부터 삭제
      //}
      await deleteSubject(db, id);
      await refreshSubjects(false);
      await refreshStats();
    } catch (e) {
      alert(String(e.message || e));
    }
  });

  $("renameSubjectBtn").addEventListener("click", async () => {
    try {
      const id = Number($("subjectSelect").value);
      const newName = ($("renameSubject").value || "").trim();
      if (!id) throw new Error("변경할 항목을 선택하세요.");
      if (!newName) throw new Error("변경할 이름을 입력하세요.");

      await renameSubject(db, id, newName);
      $("renameSubject").value = "";
      await refreshSubjects(false);
      await refreshStats();
    } catch (e) {
      alert(String(e.message || e));
    }
  });

$("resetTodayBtn").addEventListener("click", async () => {
  if (!confirm("오늘 기록을 모두 삭제할까요? (되돌릴 수 없음)")) return;
  try {
    await endSessionNow(db).catch(()=>{});
    await resetTodaySessions(db);
    await refreshSessionUI();
    await refreshStats();
  } catch (e) {
    alert(String(e.message || e));
  }
});

$("resetAllBtn").addEventListener("click", async () => {
  if (!confirm("전체 기록을 모두 삭제할까요? (되돌릴 수 없음)")) return;
  try {
    await endSessionNow(db).catch(()=>{});
    await resetAllSessions(db);
    await refreshSessionUI();
    await refreshStats();
  } catch (e) {
    alert(String(e.message || e));
  }
});

  await refreshSessionUI();
  await refreshStats();

  //PWA 등록
 if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then(() => {
      console.log("Service Worker registered");
    })
    .catch((err) => {
      console.error("Service Worker registration failed:", err);
    });
}
}
main();


