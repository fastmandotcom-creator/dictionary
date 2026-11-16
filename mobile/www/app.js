/* dict-learn v2.0 — Adaptive SRS, CEFR A1-C2 curriculum, offline dictionary
 * search, multilingual active practice, and Passive Audio Learning.
 *
 * DOM contract (tests/mobile_app_harness.mjs & tests/mobile_journey.mjs) is
 * preserved: every legacy / v1.x id still exists and behaves compatibly, and
 * all v2.0 DOM additions are null-guarded.
 */
(function () {
  var INTERVALS = { hard: 1, ok: 3, good: 7 };
  var concepts = [], conceptRank = {}, langs = [], drills = {}, cache = {}, queue = [], idx = 0;

  // active-production & session state
  var drill = null;        // { s, h, lang }
  var fill = null;         // { row, blank, answer, lang }
  var conj = null;         // { targetKey, correct, options, lang }
  var soundOn = true;
  var wantSettings = false;
  var sessionDone = false;
  var sessionStats = { learned: 0, remembered: 0, correct: 0, practice: 0 };
  var requeued = {};
  var sessionHardIds = [];
  var undoStack = [];
  var cefrLevel = "all";
  var batchNum = 1;
  var seenBatchIds = {};
  var searchIndexKey = "";
  var searchIndexList = [];
  var cardExTarget = "";
  var cardExLang = "en";
  var audioStats = null;
  var audioPreviewTracks = [];
  var audioPreviewIndex = 0;
  var audioEnrichReq = "";
  var audioCardCache = {};
  var appBootReady = false;
  var pendingOpenAudio = false;

  // Demo mode (?lite=1) + lazy drill-pack loading. The full drills.json is
  // the heaviest payload (~23 MB); the app boots on concepts+langs so the
  // first card shows fast, and practice panels show a friendly notice until
  // the pack lands. E2E + quick demos use the bundled lite subset.
  var LITE = !!(window.location && /[?&]lite=1/.test(window.location.search || ""));
  var drillsReady = null;
  function dataBase() { return LITE ? "data/lite" : "data"; }
  function fmt(n) { try { return Number(n).toLocaleString("vi-VN"); } catch (e) { return String(n); } }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------------- utilities & CEFR ----------------
  function pad(n) { return String(n).padStart(2, "0"); }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function iso(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function pairKey() { return "dict_srs_v2_" + base() + "_" + target(); }
  function $(id) { return document.getElementById(id); }
  function base() { return $("base") ? $("base").value : "vi"; }
  function target() { return $("target") ? $("target").value : "en"; }
  function sessionLen() {
    var el = $("sessionlen");
    return el ? parseInt(el.value || "50", 10) : 50;
  }
  function cefrOf(id) {
    var r = conceptRank[id];
    if (r === undefined) return "A1";
    if (r < 2000) return "A1";
    if (r < 4000) return "A2";
    if (r < 6000) return "B1";
    if (r < 8000) return "B2";
    if (r < 10000) return "C1";
    return "C2";
  }
  function inCefrFilter(id, level) {
    var lv = level || cefrLevel || "all";
    return lv === "all" || cefrOf(id) === lv;
  }
  function foldText(s) {
    var str = String(s || "").toLowerCase();
    if (str.normalize) {
      str = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    return str.replace(/đ/g, "d").replace(/\s+/g, " ").trim();
  }
  function normalizeAnswer(s) {
    return String(s || "")
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[.,!?;:"()\[\]¡¿。、！？…—–]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function toast(msg, kind) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = kind || "";
    t.classList.remove("hidden");
    if (t._timer) clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.add("hidden"); }, 2600);
  }

  // ---------------- SRS store (M3.1) ----------------
  var srsCache = {};
  function readSrs() { return srsCache[pairKey()] || {}; }
  function persistSrs() {
    if (!window.SrsStore) return Promise.resolve();
    return window.SrsStore.set(pairKey(), readSrs()).catch(function () {});
  }
  function loadSrs() {
    if (!window.SrsStore) { srsCache[pairKey()] = srsCache[pairKey()] || {}; return Promise.resolve(srsCache[pairKey()]); }
    return window.SrsStore.get(pairKey()).then(function (obj) {
      obj = obj || {};
      if (!Object.keys(obj).length) {
        try {
          var legacy = JSON.parse(localStorage.getItem(pairKey()) || "{}");
          if (legacy && Object.keys(legacy).length) obj = legacy;
        } catch (e) {}
      }
      srsCache[pairKey()] = obj;
      return obj;
    }, function () { srsCache[pairKey()] = srsCache[pairKey()] || {}; return srsCache[pairKey()]; });
  }

  // ---------------- language data ----------------
  function loadLang(code) {
    if (cache[code]) return Promise.resolve(cache[code]);
    return fetch("data/lang/" + code + ".json").then(function (r) { return r.json(); }).then(function (data) {
      cache[code] = data;
      return data;
    });
  }

  // Speak a word. On Android the native DictTTS plugin (duosub-study port) is
  // preferred; on the web, window.speechSynthesis. Auto-play (every card)
  // stays silent on failure; only an interactive tap (the "Nghe từ" button,
  // passed as interactive=true) surfaces the result and a fix hint.
  function speak(text, lang, interactive) {
    if (!text || !soundOn) return Promise.resolve(false);
    var onDone = function (out) {
      if (!out || out.cancelled) return false;
      var ok = !!out.ok;
      var skipNoVoice = (interactive === "no-voice-custom" && out.result === "no-voice");
      if (!ok && interactive && !skipNoVoice && window.TTS && TTS.message) {
        var msg = TTS.message();
        if (msg) toast("🔇 " + msg, "bad");
      }
      return ok;
    };
    if (window.TTS) return window.TTS.speak(text, lang).then(onDone);
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return Promise.resolve(false);
    var u = new SpeechSynthesisUtterance(text);
    u.lang = TTS_map(lang);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    return Promise.resolve(true);
  }
  function TTS_map(lang) {
    switch (lang) { case "zh": return "zh-CN"; case "pt": return "pt-BR"; case "vi": return "vi-VN"; default: return lang; }
  }
  function sampleWordFor(lang) {
    switch (lang) {
      case "vi": return "xin chào";
      case "ja": return "こんにちは";
      case "ko": return "안녕하세요";
      case "zh": case "zh-CN": case "cmn": return "你好";
      case "fr": return "bonjour";
      case "de": return "hallo";
      case "es": return "hola";
      case "ru": return "привет";
      case "ar": return "مرحبا";
      default: return "hello";
    }
  }

  // ---------------- Adaptive SM-2 Lite SRS & home stats ----------------
  function computeNextSrs(prev, kind) {
    var hasReps = !!(prev && ((prev.reps != null && prev.reps >= 1) || (prev.reps == null && (prev.grade === "ok" || prev.grade === "good"))));
    var prevIv = prev ? (prev.interval || INTERVALS[prev.grade] || 3) : 0;
    var prevReps = prev ? (prev.reps != null ? prev.reps : (prev.grade === "hard" ? 0 : 1)) : 0;
    var prevEase = prev && prev.ease ? prev.ease : (prev ? 2.2 : 2.3);
    var prevLapses = prev && prev.lapses ? prev.lapses : 0;

    var interval, reps, ease, lapses;
    if (!hasReps) {
      if (kind === "hard") {
        interval = 1; reps = 0;
        ease = Math.max(1.3, +(prev ? (prevEase - 0.1) : 2.0).toFixed(2));
        lapses = prevLapses + 1;
      } else if (kind === "ok") {
        interval = 3; reps = 1;
        ease = prev && prev.ease ? prev.ease : 2.1;
        lapses = prevLapses;
      } else {
        interval = 7; reps = 1;
        ease = prev && prev.ease ? prev.ease : 2.3;
        lapses = prevLapses;
      }
    } else {
      if (kind === "hard") {
        interval = 1; reps = 0;
        ease = Math.max(1.3, +(prevEase - 0.2).toFixed(2));
        lapses = prevLapses + 1;
      } else if (kind === "ok") {
        interval = Math.min(180, Math.max(3, Math.round(prevIv * 1.4)));
        reps = prevReps + 1;
        ease = Math.max(1.3, +(prevEase - 0.05).toFixed(2));
        lapses = prevLapses;
      } else {
        interval = Math.min(365, Math.max(7, Math.round(prevIv * prevEase)));
        reps = prevReps + 1;
        ease = Math.min(2.8, +(prevEase + 0.1).toFixed(2));
        lapses = prevLapses;
      }
    }
    return {
      grade: kind,
      due: iso(interval),
      last: todayISO(),
      interval: interval,
      reps: reps,
      ease: ease,
      lapses: lapses
    };
  }

  function srsStatusBadge(rec) {
    if (!rec) return { text: "Mới", cls: "" };
    var iv = rec.interval || INTERVALS[rec.grade] || 1;
    if (iv >= 14 || (rec.reps != null && rec.reps >= 2)) {
      return { text: "Thuộc · " + iv + "n", cls: "is-good" };
    }
    if (rec.grade === "hard") return { text: "Cần ôn · " + iv + "n", cls: "is-bad" };
    return { text: "Đang học · " + iv + "n", cls: "is-warn" };
  }

  function srsCounts() {
    var srs = readSrs();
    var today = todayISO(), due = 0, total = 0, mastered = 0, learning = 0;
    Object.keys(srs).forEach(function (id) {
      total++;
      var rec = srs[id];
      if (!rec) return;
      if (rec.due && rec.due <= today) due++;
      var iv = rec.interval || INTERVALS[rec.grade] || 1;
      if (iv >= 14 || (rec.reps != null && rec.reps >= 2)) mastered++;
      else learning++;
    });
    return { total: total, due: due, mastered: mastered, learning: learning };
  }

  function todayGrades() {
    var srs = readSrs();
    var t = todayISO();
    var n = 0;
    Object.keys(srs).forEach(function (id) {
      if (srs[id] && srs[id].last && String(srs[id].last).slice(0, 10) === t) n++;
    });
    return n;
  }

  function streakDays() {
    var srs = readSrs();
    var days = {};
    Object.keys(srs).forEach(function (id) {
      if (srs[id] && srs[id].last) days[String(srs[id].last).slice(0, 10)] = 1;
    });
    var n = 0;
    var d = new Date();
    if (!days[todayISO()]) d.setDate(d.getDate() - 1); // streak survives if today not done yet
    while (days[todayISOFor(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
    function todayISOFor(dt) {
      return dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
    }
  }

  function syncCefrUI() {
    var sum = $("cefr-summary");
    if (sum) {
      if (cefrLevel === "all") {
        sum.textContent = "Tất cả A1–C2 (" + fmt(concepts.length) + " từ)";
      } else {
        var cnt = 0;
        for (var i = 0; i < concepts.length; i++) if (cefrOf(concepts[i]) === cefrLevel) cnt++;
        sum.textContent = "Cấp " + cefrLevel + " · " + fmt(cnt) + " từ";
      }
    }
    var box = $("cefr-filter");
    if (box && box.querySelectorAll) {
      var btns = box.querySelectorAll(".cefr-pill");
      for (var k = 0; k < btns.length; k++) {
        var lv = btns[k].getAttribute("data-level") || "all";
        btns[k].classList.toggle("is-active", lv === cefrLevel);
      }
    }
  }

  function renderHome() {
    var c = srsCounts();
    var total = concepts.length;
    $("stat-learned").textContent = fmt(c.total);
    $("stat-total").textContent = fmt(total);
    var pct = total ? Math.min(100, Math.round((c.total / total) * 100)) : 0;
    $("learned-bar").style.width = pct + "%";
    var todayN = todayGrades();
    $("stat-today").textContent = String(todayN);
    $("stat-streak").textContent = String(streakDays());

    if ($("stat-learning")) $("stat-learning").textContent = fmt(c.learning);
    if ($("stat-mastered")) $("stat-mastered").textContent = fmt(c.mastered);
    if ($("stat-due")) $("stat-due").textContent = fmt(c.due);

    var passiveToday = audioStats ? Object.keys(audioStats.todayHeardIds || {}).length : 0;
    var goalTarget = sessionLen();
    var goalDone = todayN + passiveToday;
    var goalPct = goalTarget ? Math.min(100, Math.round((goalDone / goalTarget) * 100)) : 0;
    if ($("daily-goal-text")) {
      $("daily-goal-text").textContent = goalDone >= goalTarget
        ? ("🎉 Đạt mục tiêu hôm nay (" + goalDone + " / " + goalTarget + ")")
        : ("Mục tiêu hôm nay: " + goalDone + " / " + goalTarget + " từ");
    }
    if ($("daily-goal-bar")) $("daily-goal-bar").style.width = goalPct + "%";

    syncCefrUI();

    var lvTag = cefrLevel !== "all" ? (" [" + cefrLevel + "]") : "";
    var sb = $("startbtn");
    if (idx > 0 && idx < queue.length && !sessionDone) {
      sb.textContent = "📖 Học tiếp Bộ #" + batchNum + " (từ " + (idx + 1) + "/" + queue.length + ")" + lvTag + " →";
    } else if (c.total === 0 && batchNum === 1) {
      sb.textContent = "Bắt đầu học " + sessionLen() + " từ mới" + lvTag + " →";
    } else if (c.due > 0 && batchNum === 1) {
      sb.textContent = "📖 Ôn " + c.due + " từ đến hạn (Bộ #1)" + lvTag + " →";
    } else {
      sb.textContent = "📖 Vào học Bộ #" + batchNum + " (" + (queue.length || sessionLen()) + " từ)" + lvTag + " →";
    }

    // onboarding only for brand-new users
    var seen = false;
    try { seen = !!localStorage.getItem("dictlearn_onboard_" + pairKey()); } catch (e) {}
    $("onboard").classList.toggle("hidden", seen || c.total > 0);
    updateSessionStatus();
    updateAudioHomeMeta();
  }

  function resetBatchHistory() {
    batchNum = 1;
    seenBatchIds = {};
  }

  function uniqueIds(list) {
    var seen = {}, out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var cid = list[i];
      if (cid && !seen[cid]) { seen[cid] = true; out.push(cid); }
    }
    return out;
  }

  function updateBatchButtons() {
    var n = queue.length || sessionLen();
    var nextN = sessionLen();
    var nextBatch = batchNum + 1;
    var active = window.AudioPlayer ? window.AudioPlayer.getState() : null;
    var audioProgressed = !!(active && active.status !== "idle" && active.index > 0);
    var studyProgressed = (idx > 0 || sessionDone);
    if ($("session-replay")) {
      $("session-replay").textContent = "↺ Đặt lại đầu Bộ #" + batchNum;
      $("session-replay").disabled = !(studyProgressed || audioProgressed);
    }
    if ($("session-next-batch")) $("session-next-batch").textContent = "⏭ Đổi sang Bộ #" + nextBatch + " (" + nextN + " từ kế)";
    if ($("study-replay")) {
      $("study-replay").textContent = "↺ Học lại từ 1/" + n;
      $("study-replay").disabled = !studyProgressed;
    }
    if ($("study-next-batch")) $("study-next-batch").textContent = "⏭ Qua Bộ #" + nextBatch + " (" + nextN + " từ)";
    if ($("audio-replay")) $("audio-replay").textContent = "↺ Nghe lại từ 1/" + n;
    if ($("audio-next-batch")) $("audio-next-batch").textContent = "⏭ Qua Bộ #" + nextBatch + " (" + nextN + " từ)";
  }

  function updateSessionStatus() {
    var el = $("session-status");
    var active = window.AudioPlayer ? window.AudioPlayer.getState() : null;
    var lvTxt = cefrLevel === "all" ? "A1–C2" : cefrLevel;
    if (el) {
      if (active && (active.status === "playing" || active.status === "paused") && active.total) {
        el.textContent = "Bộ #" + batchNum + " · " +
          (active.status === "playing" ? "Đang nghe " : "Tạm dừng ") +
          ((active.index || 0) + 1) + " / " + active.total + " (" + lvTxt + ")";
      } else if (queue.length && idx > 0 && idx < queue.length && !sessionDone) {
        el.textContent = "Bộ #" + batchNum + " (" + queue.length + " từ · " + lvTxt + ") · đang ở " + (idx + 1) + " / " + queue.length;
      } else {
        var n = queue.length || sessionLen();
        el.textContent = "Bộ #" + batchNum + " · " + n + " từ (" + lvTxt + ") · đồng bộ Thẻ ↔ Nghe";
      }
    }
    updateBatchButtons();
  }

  function updateAudioHomeMeta() {
    var sub = $("audio-home-sub");
    if (!sub) return;
    var active = window.AudioPlayer ? window.AudioPlayer.getState() : null;
    if (active && (active.status === "playing" || active.status === "paused") && active.word) {
      var posTxt = active.total ? (" (" + ((active.index || 0) + 1) + "/" + active.total + ")") : "";
      sub.textContent = (active.status === "playing" ? "Đang phát: " : "Đang tạm dừng: ") + active.word + posTxt + " · " + (active.meaning || "");
      return;
    }
    var heardToday = audioStats ? Object.keys(audioStats.todayHeardIds || {}).length : 0;
    if (queue.length && idx > 0 && idx < queue.length && !sessionDone) {
      sub.textContent = "Tiếp tục nghe Bộ #" + batchNum + " từ vị trí " + (idx + 1) + " / " + queue.length;
    } else if (queue.length) {
      sub.textContent = "Phát ngầm Bộ #" + batchNum + " (" + queue.length + " từ)" +
        (heardToday > 0 ? (" · Hôm nay đã nghe " + heardToday + " từ") : " · nghe cả khi tắt màn hình");
    } else {
      sub.textContent = "Nghe nghĩa → từ học ×2 → ví dụ song ngữ cả khi tắt màn hình";
    }
  }

  function buildQueue(customIds, opts) {
    var excludeSeen = !!(opts && opts.excludeSeen);
    var cycled = false;
    sessionDone = false;
    sessionStats = { learned: 0, remembered: 0, correct: 0, practice: 0 };
    requeued = {};
    sessionHardIds = [];
    undoStack = [];
    if (customIds && customIds.length) {
      queue = customIds.slice();
      idx = 0;
      updateProgress();
      updateSessionStatus();
      return false;
    }
    var srs = readSrs();
    var t = todayISO();
    function collectCandidates(ignoreSeen) {
      var due = [], fresh = [];
      for (var i = 0; i < concepts.length; i++) {
        var cid = concepts[i];
        if (!inCefrFilter(cid)) continue;
        if (!ignoreSeen && excludeSeen && seenBatchIds[cid]) continue;
        var rec = srs[cid];
        if (rec && rec.due && rec.due <= t) due.push(cid);
        else if (!rec) fresh.push(cid);
      }
      var list = due.concat(fresh);
      if (!list.length && cefrLevel !== "all") {
        for (var j = 0; j < concepts.length; j++) {
          var bCid = concepts[j];
          if (!inCefrFilter(bCid)) continue;
          if (!ignoreSeen && excludeSeen && seenBatchIds[bCid]) continue;
          list.push(bCid);
        }
      }
      return { list: list, dueCount: due.length };
    }
    var picked = collectCandidates(false);
    if (!picked.list.length && excludeSeen) {
      resetBatchHistory();
      cycled = true;
      picked = collectCandidates(true);
    }
    queue = picked.list.slice(0, Math.max(sessionLen(), picked.dueCount));
    if (!queue.length) queue = concepts.slice(0, sessionLen());
    idx = 0;
    updateProgress();
    updateSessionStatus();
    return cycled;
  }

  function stopAudioIfActive() {
    var st = window.AudioPlayer && window.AudioPlayer.getState ? window.AudioPlayer.getState() : null;
    if (st && st.status && st.status !== "idle" && window.AudioPlayer.stop) {
      return window.AudioPlayer.stop();
    }
    return Promise.resolve();
  }

  function restartCurrentSession(surface) {
    if (!queue.length) buildQueue();
    else queue = uniqueIds(queue);
    idx = 0;
    sessionDone = false;
    sessionStats = { learned: 0, remembered: 0, correct: 0, practice: 0 };
    requeued = {};
    sessionHardIds = [];
    undoStack = [];
    audioPreviewTracks = [];
    audioPreviewIndex = 0;
    return stopAudioIfActive().then(function () {
      updateProgress();
      updateSessionStatus();
      updateAudioHomeMeta();
      if (surface === "audio" && $("audio-screen")) {
        toast("🔄 Đã phát lại Bộ #" + batchNum + " (" + queue.length + " từ)");
        return handoffStudyToAudio();
      }
      if (surface === "study") {
        toast("🔄 Đã quay về thẻ 1 / " + queue.length + " (Bộ #" + batchNum + ")");
        showStudy();
        return render();
      }
      renderHome();
      toast("🔄 Bộ #" + batchNum + " (" + queue.length + " từ) đã về vị trí 1/" + queue.length);
      return Promise.resolve();
    });
  }

  function nextSessionBatch(surface) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i]) seenBatchIds[queue[i]] = 1;
    }
    batchNum += 1;
    audioPreviewTracks = [];
    audioPreviewIndex = 0;
    return stopAudioIfActive().then(function () {
      var cycled = buildQueue(null, { excludeSeen: true });
      if (cycled) toast("🎉 Đã hết vòng cấp độ này — quay lại Bộ #1");
      updateAudioHomeMeta();
      if (surface === "audio" && $("audio-screen")) {
        if (!cycled) toast("⏭ Bộ #" + batchNum + " · " + queue.length + " từ tiếp theo");
        return handoffStudyToAudio();
      }
      if (surface === "study") {
        if (!cycled) toast("⏭ Đã tải Bộ #" + batchNum + " (" + queue.length + " từ tiếp theo)");
        showStudy();
        return render();
      }
      renderHome();
      if (!cycled) toast("⏭ Đã nạp Bộ #" + batchNum + " (" + queue.length + " từ tiếp theo)");
      return Promise.resolve();
    });
  }

  function openConceptInStudy(id) {
    if (!id) return Promise.resolve();
    sessionDone = false;
    if (!queue.length || idx >= queue.length) {
      buildQueue();
    }
    var cur = queue.slice(idx);
    var existingAt = cur.indexOf(id);
    if (existingAt > 0) {
      cur.splice(existingAt, 1);
      cur.unshift(id);
      queue = queue.slice(0, idx).concat(cur);
    } else if (existingAt === -1) {
      queue.splice(idx, 0, id);
    }
    showStudy();
    return Promise.resolve();
  }

  function updateProgress() {
    var c = srsCounts();
    var totalQ = Math.max(1, queue.length);
    var shownIdx = Math.min(idx + 1, totalQ);
    $("progress").textContent =
      shownIdx + " / " + queue.length + " · Bộ #" + batchNum +
      (c.due ? " · " + c.due + " đến hạn" : "");
    var bar = $("study-bar");
    if (bar) {
      var pct = sessionDone ? 100 : Math.min(100, Math.round((idx / totalQ) * 100));
      bar.style.width = pct + "%";
    }
    var undoBtn = $("undobtn");
    if (undoBtn) {
      undoBtn.disabled = !undoStack.length;
      undoBtn.classList.toggle("hidden", !undoStack.length);
    }
    var h = $("swipehint");
    if (h) h.classList.toggle("hidden", !c.due && c.total !== 0);
    updateBatchButtons();
  }

  // ---------------- screens ----------------
  function syncBottomNav(activeTab) {
    var nav = $("bottom-nav");
    if (!nav || !nav.querySelectorAll) return;
    var btns = nav.querySelectorAll("button[data-nav]");
    for (var i = 0; i < btns.length; i++) {
      var tab = btns[i].getAttribute("data-nav");
      btns[i].classList.toggle("is-active", tab === activeTab);
    }
  }
  function setActiveScreen(name) {
    if ($("home")) $("home").classList.toggle("hidden", name !== "home");
    if ($("study")) $("study").classList.toggle("hidden", name !== "study");
    if ($("audio-screen")) $("audio-screen").classList.toggle("hidden", name !== "audio");
    syncBottomNav(name);
    updateMiniAudioBar();
  }
  function showStudy() {
    if (sessionDone && idx >= queue.length) buildQueue();
    if (sessionDone) sessionDone = false;
    setActiveScreen("study");
    if (!sessionDone) render();
  }
  function showHome() {
    hidePanels();
    setActiveScreen("home");
    renderHome();
  }
  function showAudio(autoStart) {
    if (!$("audio-screen")) return Promise.resolve();
    hidePanels();
    setActiveScreen("audio");
    var st = window.AudioPlayer ? window.AudioPlayer.getState() : null;
    if (st && st.status && st.status !== "idle") {
      renderAudioScreen(st);
      return Promise.resolve(st);
    }
    return prepareAudioTracks(false).then(function (list) {
      if (autoStart && list.length) return startPassiveAudio();
      return list;
    });
  }

  // ---------------- card render & adaptive UI ----------------
  function ensurePracticeConcept() {
    // practice buttons may be pressed from Home, where the current card
    // dataset can be empty — pin it to the first study-queue concept.
    if (!$("card").dataset.id) {
      for (var i = 0; i < concepts.length; i++) {
        if (drills[concepts[i]] && drills[concepts[i]].length) { $("card").dataset.id = concepts[i]; break; }
      }
      if (!$("card").dataset.id) $("card").dataset.id = concepts[0];
    }
    return $("card").dataset.id;
  }

  function updateGradeButtonHints(id) {
    var rec = readSrs()[id] || null;
    var hardNext = computeNextSrs(rec, "hard");
    var okNext = computeNextSrs(rec, "ok");
    var goodNext = computeNextSrs(rec, "good");
    if ($("b1-sub")) {
      $("b1-sub").textContent = (!requeued[id] && queue.length - idx > 1)
        ? ("ôn cuối buổi · " + hardNext.interval + " ngày")
        : ("lặp lại sau " + hardNext.interval + " ngày");
    }
    if ($("b2-sub")) $("b2-sub").textContent = "lặp lại sau " + okNext.interval + " ngày";
    if ($("b3-sub")) $("b3-sub").textContent = "gặp lại sau " + goodNext.interval + " ngày";
  }

  function flipCard() {
    if (sessionDone) return;
    var b = $("base-text"), e = $("ex"), tc = $("tap-cue");
    if (b) b.classList.toggle("hidden");
    if (e) e.classList.toggle("hidden");
    if (tc && b) tc.classList.toggle("hidden", !b.classList.contains("hidden"));
  }

  function render() {
    wantSettings = false;
    hidePanels();
    if (sessionDone || !queue.length || idx >= queue.length) {
      showSessionDone();
      return Promise.resolve();
    }
    if ($("study-controls")) $("study-controls").classList.remove("hidden");
    if ($("study-deck-bar")) $("study-deck-bar").classList.remove("hidden");
    var id = queue[idx];
    return Promise.all([loadLang(base()), loadLang(target())]).then(function (pair) {
      var known = pair[0];
      var learning = pair[1];
      var word = (learning.w && learning.w[id]) || id;
      var card = $("card");
      if (card.dataset && card.dataset.done) delete card.dataset.done;
      card.dataset.id = id;
      card.dataset.word = word;

      var ro = (learning.ro && learning.ro[id]) || "";
      var ipa = (learning.ipa && learning.ipa[id]) || "";
      var meaning = (known.w && known.w[id]) || "";
      var exT = (learning.e && learning.e[id]) || "";
      var exB = (known.e && known.e[id]) || "";
      cardExTarget = exT;
      cardExLang = target();

      var rec = readSrs()[id];
      var badge = srsStatusBadge(rec);
      var level = cefrOf(id);

      var exHtml = '<div class="ex hidden" id="ex">';
      if (exT || exB) {
        exHtml += '<div class="ex-row"><div class="ex-text">' +
          (exT ? '<div class="ex-target-line">' + esc(exT) + "</div>" : "") +
          (exB ? '<div class="ex-base-line">' + esc(exB) + "</div>" : "") +
          "</div>" +
          (exT ? '<button type="button" class="ex-speak-btn" data-ex-speak="1">🔊 Ví dụ</button>' : "") +
          "</div>";
      }
      exHtml += "</div>";

      card.innerHTML =
        '<div class="card-meta">' +
          '<span class="badge-mini">' + esc(level) + "</span>" +
          '<span class="badge-mini ' + badge.cls + '">' + esc(badge.text) + "</span>" +
        "</div>" +
        '<div class="target">' + esc(word) + "</div>" +
        (ro  ? '<div class="ro">'  + esc(ro)  + "</div>" : "") +
        (ipa ? '<div class="ipa">' + esc(ipa) + "</div>" : "") +
        '<div class="base hidden" id="base-text">' + esc(meaning) + "</div>" +
        exHtml +
        '<div class="tap-cue" id="tap-cue">Chạm thẻ để xem nghĩa</div>';

      updateGradeButtonHints(id);
      updateProgress();
      var studyEl = $("study");
      if (studyEl && !studyEl.classList.contains("hidden")) {
        speak(word, target());
      }
    });
  }

  function showSessionDone() {
    var card = $("card");
    if (!card) return;
    sessionDone = true;
    var c = srsCounts();
    card.dataset.done = "1";
    cardExTarget = "";
    var hardBtnHtml = sessionHardIds.length
      ? ('<button type="button" class="primary" data-done-act="hard">🔥 Ôn lại ' + sessionHardIds.length + " từ chưa nhớ</button>")
      : "";
    card.innerHTML =
      '<div style="text-align:center;padding:1.1rem 0">' +
        '<div style="font-size:2.6rem">🎉</div>' +
        '<div style="font-weight:800;font-size:1.25rem;margin-top:0.45rem">Buổi học xong!</div>' +
        '<p class="muted" style="margin-top:0.45rem">' +
          "Chấm <b>" + sessionStats.learned + "</b> từ · nhớ tốt <b>" + (sessionStats.remembered || 0) + "</b> · luyện đúng <b>" + sessionStats.correct + "</b><br>" +
          "Tổng tiến bộ: " + fmt(c.total) + " / " + fmt(concepts.length) + " từ (chuỗi " + streakDays() + " ngày)</p>" +
        '<div class="done-actions">' +
          hardBtnHtml +
          '<button type="button" class="' + (sessionHardIds.length ? "ghost" : "primary") + '" data-done-act="next">⏭ Học sang Bộ #' + (batchNum + 1) + " (" + sessionLen() + " từ kế) →</button>" +
          '<button type="button" class="ghost" data-done-act="replay">↺ Học lại Bộ #' + batchNum + " vừa rồi (" + Math.max(1, queue.length) + " từ)</button>" +
          '<button type="button" class="ghost" data-done-act="audio">🎧 Nghe lại buổi học này</button>' +
          '<button type="button" class="ghost" data-done-act="home">← Về trang chủ</button>' +
        "</div>" +
      "</div>";
    $("progress").textContent = "Hoàn tất buổi · " + fmt(c.total) + "/" + fmt(concepts.length) + " từ";
    if ($("study-bar")) $("study-bar").style.width = "100%";
    if ($("study-controls")) $("study-controls").classList.add("hidden");
    if ($("study-deck-bar")) $("study-deck-bar").classList.add("hidden");
    if ($("swipehint")) $("swipehint").classList.add("hidden");
    if ($("undobtn")) $("undobtn").classList.toggle("hidden", !undoStack.length);
  }

  function grade(kind) {
    var id = $("card").dataset.id;
    if (!id || sessionDone) return;
    var store = readSrs();
    undoStack.push({
      id: id,
      prevEntry: store[id] ? Object.assign({}, store[id]) : null,
      prevIdx: idx,
      prevQueueLen: queue.length,
      hadRequeued: !!requeued[id],
      prevHard: sessionHardIds.slice(),
      prevStats: Object.assign({}, sessionStats)
    });
    if (undoStack.length > 30) undoStack.shift();

    store[id] = computeNextSrs(store[id], kind);
    sessionStats.learned++;
    if (kind === "good" || kind === "ok") sessionStats.remembered = (sessionStats.remembered || 0) + 1;
    if (kind === "hard") {
      if (sessionHardIds.indexOf(id) === -1) sessionHardIds.push(id);
      if (!requeued[id] && queue.length - idx > 1) {
        requeued[id] = true;
        queue.push(id);
      }
    }
    persistSrs();
    idx += 1;
    render();
  }

  function undoGrade() {
    if (!undoStack.length) return;
    var snap = undoStack.pop();
    var store = readSrs();
    if (snap.prevEntry) store[snap.id] = snap.prevEntry;
    else delete store[snap.id];
    queue.length = snap.prevQueueLen;
    idx = snap.prevIdx;
    requeued[snap.id] = snap.hadRequeued;
    sessionHardIds = snap.prevHard;
    sessionStats = snap.prevStats;
    sessionDone = false;
    persistSrs();
    toast("↩ Đã hoàn tác thẻ trước");
    render();
  }

  // ---------------- panels ----------------
  function ensureStudyVisible() {
    // Practice buttons live on the Home screen but their panels render in the
    // Study section. If Home is currently showing, switch to Study first so
    // the panel the user just asked for is actually visible.
    if (sessionDone || idx >= queue.length) {
      if (idx >= queue.length) buildQueue();
      sessionDone = false;
      render();
    }
    var home = $("home"), study = $("study");
    if (home && study && !home.classList.contains("hidden")) {
      setActiveScreen("study");
    }
  }

  function hidePanels() {
    micOpSeq += 1;
    if (micListening) { try { window.MicAsr && MicAsr.stop(); } catch (e) {} }
    setMicUiState(false);
    hideMicPermBox();
    if ($("drill")) $("drill").classList.add("hidden");
    if ($("fillbox")) $("fillbox").classList.add("hidden");
    if ($("conjbox")) $("conjbox").classList.add("hidden");
    if ($("study") && $("study").classList) $("study").classList.remove("has-open-panel");
    drill = null; fill = null; conj = null;
    sessionStats.practice = 0;
  }
  // Practice variety: each panel cycles through the concept's variants
  // ("Câu khác") instead of always showing the same question.
  var practiceCursor = {};
  var conjCursor = 0;
  function pickCursor(key, advance) {
    if (advance) practiceCursor[key] = (practiceCursor[key] || 0) + 1;
    return practiceCursor[key] || 0;
  }
  function toggleNext(btnId, show) {
    var b = $(btnId);
    if (b && b.classList) b.classList[show ? "remove" : "add"]("hidden");
  }
  function openPanel(id) {
    hidePanels();
    $(id).classList.remove("hidden");
    if ($("study") && $("study").classList) $("study").classList.add("has-open-panel");
    var p = $(id);
    if (p) {
      if (p.scrollIntoView) p.scrollIntoView({ behavior: "smooth", block: "nearest" });
      var inp = p.querySelector('input[type="text"]');
      if (inp && inp.focus) {
        setTimeout(function () {
          if (inp.classList && inp.classList.contains("hidden")) return;
          try { inp.focus(); } catch (e) {}
        }, 60);
      }
    }
  }

  // ---------------- practice helpers (all 35 languages + drills.json) ----------------
  function practiceLang() { return target(); }

  function answerMismatchHint(typed, expected) {
    var a = normalizeAnswer(typed).split(" ").filter(Boolean);
    var b = normalizeAnswer(expected).split(" ").filter(Boolean);
    if (b.length <= 1) return "";
    for (var i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return ' · lệch từ "' + a[i] + '" → "' + b[i] + '"';
    }
    if (a.length < b.length) return " · còn thiếu " + (b.length - a.length) + " từ";
    return "";
  }

  function loadPracticePairData(id) {
    return Promise.all([loadLang(base()), loadLang(target())]).then(function (pair) {
      var known = pair[0] || {}, learning = pair[1] || {};
      var word = (learning.w && learning.w[id]) || "";
      var exT = (learning.e && learning.e[id]) || "";
      var exB = (known.e && known.e[id]) || "";
      var mean = (known.w && known.w[id]) || "";
      return {
        id: id,
        lang: target(),
        known: known,
        learning: learning,
        word: word,
        sentence: exT || word,
        hint: exB || mean
      };
    });
  }

  // ---------------- M2.2a listen & write (Word Bank + Adaptive SRS Mode) ----------------
  function clearNodeChildren(el) {
    if (!el) return;
    el.innerHTML = "";
    if (Array.isArray(el.children)) el.children.length = 0;
  }

  function removeNodeSafe(el) {
    if (!el || !el.parentNode) return;
    if (el.parentNode.removeChild) {
      el.parentNode.removeChild(el);
    } else if (Array.isArray(el.parentNode.children)) {
      var i = el.parentNode.children.indexOf(el);
      if (i >= 0) el.parentNode.children.splice(i, 1);
    }
  }

  function shuffleCopy(arr) {
    var copy = arr.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  function readPracticePref(key) {
    try { return localStorage.getItem(key) || "auto"; } catch (e) { return "auto"; }
  }

  function writePracticePref(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }

  function isMasteredForTyping(id) {
    var rec = readSrs()[id];
    return !!(rec && (rec.reps || 0) >= 2 && (rec.interval || 0) >= 7);
  }

  function stripTileEdgePunct(tok) {
    return String(tok || "").replace(/^[.,!?;:"'“”‘’()\[\]¡¿。、！？…—–]+|[.,!?;:"'“”‘’()\[\]¡¿。、！？…—–]+$/g, "");
  }

  function tokenizeForTiles(sentence) {
    var raw = String(sentence || "").trim().split(/\s+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var clean = stripTileEdgePunct(raw[i]);
      if (clean) out.push(clean);
    }
    return out;
  }

  function pickWordDistractors(id, sentenceTokens, learningData) {
    var count = sentenceTokens.length > 11 ? 0 : (sentenceTokens.length > 7 ? 1 : 2);
    if (count <= 0 || !concepts.length) return [];
    var seen = {};
    sentenceTokens.forEach(function (t) { seen[normalizeAnswer(t)] = 1; });
    var out = [];
    var rank = conceptRank[id] || 0;
    var wMap = (learningData && learningData.w) || {};
    var avgLen = sentenceTokens.reduce(function (a, b) { return a + b.length; }, 0) / sentenceTokens.length;

    function tryAdd(rawWord) {
      if (out.length >= count || !rawWord) return;
      var parts = String(rawWord).trim().split(/\s+/);
      for (var p = 0; p < parts.length && out.length < count; p++) {
        var clean = stripTileEdgePunct(parts[p]).toLowerCase();
        var norm = normalizeAnswer(clean);
        if (!norm || seen[norm] || clean.length < 2) continue;
        if (Math.abs(clean.length - avgLen) > 5) continue;
        seen[norm] = 1;
        out.push(clean);
      }
    }

    for (var step = 5; step < concepts.length && out.length < count; step += 7) {
      var cid = concepts[(rank + step) % concepts.length];
      if (cid === id) continue;
      if (wMap[cid]) tryAdd(wMap[cid]);
      if (out.length < count && drills && drills[cid] && drills[cid][0] && drills[cid][0].sf) {
        tryAdd(drills[cid][0].sf);
      }
    }
    return out;
  }

  function renderDrillTiles(sentence, distractors) {
    var bankBox = $("drill-bank");
    var ansBox = $("drill-answer");
    if (!bankBox || !ansBox) return;
    clearNodeChildren(bankBox);
    clearNodeChildren(ansBox);
    if (ansBox.classList) {
      ansBox.classList.add("is-empty");
      ansBox.classList.remove("solved");
    }

    var allTokens = shuffleCopy(sentence.concat(distractors || []));
    var chosen = [];

    function syncTyped() {
      if ($("typed")) $("typed").value = chosen.map(function (c) { return c.text; }).join(" ");
      if (ansBox.classList) ansBox.classList.toggle("is-empty", chosen.length === 0);
    }

    var items = [];
    allTokens.forEach(function (tok) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tile";
      btn.textContent = tok;
      var item = { text: tok, bankBtn: btn, used: false, ansBtn: null };

      btn.addEventListener("click", function () {
        if (item.used || (drill && drill.scored && drill.mode === "tiles")) return;
        item.used = true;
        btn.disabled = true;
        if (btn.classList) btn.classList.add("used");

        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "tile";
        chip.textContent = item.text;
        item.ansBtn = chip;
        chip.addEventListener("click", function () {
          if (drill && drill.scored && drill.mode === "tiles") return;
          item.used = false;
          btn.disabled = false;
          if (btn.classList) btn.classList.remove("used");
          var ix = chosen.indexOf(item);
          if (ix >= 0) chosen.splice(ix, 1);
          removeNodeSafe(chip);
          item.ansBtn = null;
          syncTyped();
        });
        chosen.push(item);
        ansBox.appendChild(chip);
        syncTyped();
      });

      items.push(item);
      bankBox.appendChild(btn);
    });

    if (drill) {
      drill.resetTiles = function () {
        chosen.forEach(function (item) {
          item.used = false;
          item.bankBtn.disabled = false;
          if (item.bankBtn.classList) item.bankBtn.classList.remove("used");
          removeNodeSafe(item.ansBtn);
          item.ansBtn = null;
        });
        chosen.length = 0;
        if (ansBox.classList) ansBox.classList.remove("solved");
        var note = $("drill-note");
        if (note && note.className.indexOf("bad") !== -1) {
          note.textContent = "Nghe câu rồi chạm từ để ghép theo đúng thứ tự.";
          note.className = "panel-note";
        }
        syncTyped();
      };
    }
  }

  function setDrillMode(mode, opts) {
    opts = opts || {};
    if (!drill) return;
    var actual = (mode === "tiles" && drill.canTiles) ? "tiles" : "type";
    drill.mode = actual;
    if (opts.persist && drill.canTiles) writePracticePref("dictlearn_drill_mode", actual);

    var tilesWrap = $("drill-tiles");
    var typedEl = $("typed");
    var modeBtn = $("drill-mode-btn");
    if (tilesWrap && tilesWrap.classList) tilesWrap.classList.toggle("hidden", actual !== "tiles");
    if (typedEl && typedEl.classList) typedEl.classList.toggle("hidden", actual === "tiles");
    if (modeBtn) {
      if (modeBtn.classList) modeBtn.classList.toggle("hidden", !drill.canTiles);
      modeBtn.textContent = actual === "tiles" ? "⌨️ Gõ phím" : "🧩 Chọn từ";
    }
    var note = $("drill-note");
    if (note && opts.updateNote) {
      note.textContent = actual === "tiles"
        ? "Nghe câu rồi chạm từ để ghép theo đúng thứ tự." + (drill.h ? " · Gợi ý: " + drill.h : "")
        : "Nghe câu rồi gõ lại chính xác (không cần hoa/thấp)." + (drill.h ? " · Gợi ý: " + drill.h : "");
      note.className = "panel-note";
    }
    if (actual === "type" && opts.focusInput && typedEl && typedEl.focus) {
      setTimeout(function () { try { typedEl.focus(); } catch (e) {} }, 30);
    }
  }

  function showListen(mode) {
    var silent = !!(mode && typeof mode === "object" && mode.silent);
    var nextMode = mode === "next";
    var lang = practiceLang();
    var ready = (lang === "en") ? Promise.all([withDrills("listen", function () {}), loadLang("en")]) : Promise.resolve();
    return ready.then(function () {
      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("drill");
      var rows = (lang === "en") ? (drills[id] || []) : [];
      var note = $("drill-note");
      toggleNext("drillnext", rows.length > 1);
      if (rows.length) {
        var lrow = rows[pickCursor("l" + id, nextMode) % rows.length];
        var tokens = tokenizeForTiles(lrow.s);
        var canTiles = tokens.length >= 2 && !!($("drill-bank") && $("drill-answer"));
        drill = { id: id, s: lrow.s, h: lrow.h, lang: "en", scored: false, canTiles: canTiles, mode: "type" };
        $("typed").value = "";
        if (canTiles) renderDrillTiles(tokens, pickWordDistractors(id, tokens, cache["en"]));
        var pref = readPracticePref("dictlearn_drill_mode");
        var wantMode = (pref === "tiles" || pref === "type") ? pref : (canTiles && !isMasteredForTyping(id) ? "tiles" : "type");
        setDrillMode(wantMode, { updateNote: false });
        note.textContent = drill.mode === "tiles"
          ? "Nghe câu rồi chạm từ để ghép theo đúng thứ tự."
          : "Nghe câu rồi gõ lại chính xác (không cần hoa/thấp).";
        note.className = "panel-note";
        if (!silent) speak(drill.s, "en");
        return;
      }
      return loadPracticePairData(id).then(function (d) {
        if (!d.sentence) {
          note.textContent = "Từ này chưa có câu ví dụ offline — thử một từ khác.";
          note.className = "panel-note";
          return;
        }
        var tokens2 = tokenizeForTiles(d.sentence);
        var canTiles2 = tokens2.length >= 2 && !!($("drill-bank") && $("drill-answer"));
        drill = { id: id, s: d.sentence, h: d.hint, lang: d.lang, scored: false, canTiles: canTiles2, mode: "type" };
        $("typed").value = "";
        if (canTiles2) renderDrillTiles(tokens2, pickWordDistractors(id, tokens2, d.learning));
        var pref2 = readPracticePref("dictlearn_drill_mode");
        var wantMode2 = (pref2 === "tiles" || pref2 === "type") ? pref2 : (canTiles2 && !isMasteredForTyping(id) ? "tiles" : "type");
        setDrillMode(wantMode2, { updateNote: false });
        note.textContent = (drill.mode === "tiles" ? "Nghe câu rồi chạm từ để ghép" : "Nghe câu rồi gõ lại chính xác") + (d.hint ? " · Gợi ý: " + d.hint : "");
        note.className = "panel-note";
        if (!silent) speak(drill.s, d.lang);
      });
    });
  }

  function checkTyped() {
    if (!drill) return;
    var raw = $("typed").value.trim();
    if (!raw) return;
    var ok = raw.toLowerCase() === String(drill.s).trim().toLowerCase() ||
      normalizeAnswer(raw) === normalizeAnswer(drill.s);
    var note = $("drill-note");
    var extra = ok ? "" : answerMismatchHint(raw, drill.s);
    note.textContent = ok
      ? ("✅ Chuẩn rồi! Ghi nhớ tốt." + (drill.h ? " (" + drill.h + ")" : ""))
      : ("💡 Đáp án: " + drill.s + extra + (drill.h ? " · " + drill.h : ""));
    note.className = "panel-note " + (ok ? "ok" : "bad");
    if (ok) {
      if ($("drill-answer") && $("drill-answer").classList) $("drill-answer").classList.add("solved");
      if (!drill.scored) { drill.scored = true; sessionStats.correct += 1; }
    }
  }

  // ---------------- M2.1 mic ASR & standard permission UX ----------------
  var micListening = false;
  var micOpSeq = 0;

  function setMicUiState(listening) {
    micListening = !!listening;
    var btn = $("mic");
    if (!btn) return;
    btn.textContent = micListening ? "⏹ Đang nghe… Dừng" : "🎤 Mic";
    if (btn.classList) btn.classList.toggle("is-listening", micListening);
    if (btn.setAttribute) btn.setAttribute("aria-pressed", micListening ? "true" : "false");
  }

  function hideMicPermBox() {
    var box = $("mic-perm-box");
    if (box && box.classList) box.classList.add("hidden");
  }

  function showMicPermBox(kind, customMsg) {
    var box = $("mic-perm-box");
    var msg = $("mic-perm-msg");
    var grantBtn = $("mic-grant-btn");
    var settingsBtn = $("mic-settings-btn");
    if (!box || !msg) return;
    var isNative = window.MicAsr && window.MicAsr.engine && window.MicAsr.engine() === "native";
    if (kind === "denied") {
      msg.textContent = customMsg || (isNative
        ? "Quyền Micro đang bị tắt. Hãy mở Cài đặt → Quyền → Micro rồi chọn Cho phép."
        : "Quyền Micro đang bị chặn trên trình duyệt. Hãy bấm biểu tượng khóa cạnh thanh địa chỉ để cho phép Micro rồi thử lại.");
      if (grantBtn && grantBtn.classList) grantBtn.classList.add("hidden");
      if (settingsBtn && settingsBtn.classList) settingsBtn.classList.toggle("hidden", !isNative);
    } else {
      msg.textContent = customMsg || "App cần quyền Micro để nghe bạn đọc và kiểm tra phát âm (xử lý miễn phí, không lưu âm thanh).";
      if (grantBtn && grantBtn.classList) grantBtn.classList.remove("hidden");
      if (settingsBtn && settingsBtn.classList) settingsBtn.classList.add("hidden");
    }
    if (box.classList) box.classList.remove("hidden");
  }

  function refreshMicPermissionOnResume() {
    var box = $("mic-perm-box");
    var drillEl = $("drill");
    if (!box || !drillEl || (drillEl.classList && drillEl.classList.contains("hidden"))) return;
    if (box.classList && box.classList.contains("hidden")) return;
    if (!window.MicAsr || !window.MicAsr.getPermissionState) return;
    window.MicAsr.getPermissionState().then(function (perm) {
      if (perm && perm.granted) {
        hideMicPermBox();
        var note = $("drill-note");
        if (note) {
          note.textContent = "✅ Đã bật quyền Micro — chạm 🎤 Mic để nói.";
          note.className = "panel-note ok";
        }
      }
    });
  }

  function pauseOtherAudioBeforeMic() {
    if (window.TTS && window.TTS.cancel) {
      try { window.TTS.cancel(); } catch (e) {}
    }
    if (window.AudioPlayer && window.AudioPlayer.getState && window.AudioPlayer.pause) {
      try {
        var st = window.AudioPlayer.getState();
        if (st && st.status === "playing") window.AudioPlayer.pause();
      } catch (e) {}
    }
  }

  function beginMicDictation(opSeq) {
    if (opSeq !== micOpSeq) return;
    var drillEl = $("drill");
    if (drillEl && drillEl.classList && drillEl.classList.contains("hidden")) return;
    pauseOtherAudioBeforeMic();
    hideMicPermBox();
    if (drill && drill.mode === "tiles") setDrillMode("type", { persist: false });
    setMicUiState(true);
    $("typed").value = "";
    var note = $("drill-note");
    note.textContent = "Đang nghe… hãy nói câu vừa nghe (chạm ⏹ để dừng).";
    note.className = "panel-note";
    var listenLang = (drill && drill.lang) || target();

    MicAsr.start($("typed"), listenLang, function (ev) {
      if (opSeq !== micOpSeq || !ev) return;
      if (ev.error) {
        setMicUiState(false);
        note.textContent = ev.error;
        note.className = "panel-note" + (ev.errorCode === "no-speech" ? "" : " bad");
        if (ev.errorCode === "not-allowed" || ev.errorCode === "service-not-allowed") {
          window.MicAsr.getPermissionState().then(function (p) {
            if (opSeq !== micOpSeq) return;
            showMicPermBox(p && p.state === "prompt-with-rationale" ? "rationale" : "denied", ev.error);
          });
        }
        return;
      }
      if (ev.interim) {
        note.textContent = "Đang nghe: \"" + ev.interim + "\"";
        note.className = "panel-note";
        return;
      }
      if (ev.done || ev.final !== undefined || ev.state === "stopped") {
        if (ev.state === "listening" && !ev.done && !ev.final) return;
        setMicUiState(false);
        var val = ($("typed").value || "").trim();
        if (val) {
          checkTyped();
        } else {
          note.textContent = "Chưa nghe rõ giọng nói — bấm 🎤 Mic nói lại hoặc gõ tay.";
          note.className = "panel-note";
        }
      }
    });
  }

  function runMicPermissionAndStart(opSeq, forceRequest) {
    var note = $("drill-note");
    var readiness = drill ? Promise.resolve() : showListen({ silent: true });
    return readiness.then(function () {
      if (opSeq !== micOpSeq) return;
      return window.MicAsr.checkSupport();
    }).then(function (sup) {
      if (opSeq !== micOpSeq || !sup) return;
      if (!sup.supported) {
        note.textContent = sup.reason || "Thiết bị này không hỗ trợ nhận giọng nói — gõ tay nhé.";
        note.className = "panel-note";
        return;
      }
      return window.MicAsr.getPermissionState().then(function (perm) {
        if (opSeq !== micOpSeq) return;
        var st = perm ? perm.state : "prompt";
        if (st === "granted") {
          beginMicDictation(opSeq);
          return;
        }
        if (st === "denied") {
          showMicPermBox("denied");
          note.textContent = "Cần bật quyền Micro trong Cài đặt để dùng tính năng nói.";
          note.className = "panel-note";
          return;
        }
        if (st === "prompt-with-rationale" && !forceRequest) {
          showMicPermBox("rationale");
          note.textContent = "Chạm \"Cho phép Micro\" để tiếp tục nói câu luyện tập.";
          note.className = "panel-note";
          return;
        }
        // First-time in-context prompt (or user confirmed rationale button)
        if (window.MicAsr.engine && window.MicAsr.engine() === "web") {
          // On Web Chrome, recognition.start() must stay in user-gesture turn
          beginMicDictation(opSeq);
          return;
        }
        return window.MicAsr.requestPermission().then(function (after) {
          if (opSeq !== micOpSeq) return;
          if (after && after.granted) {
            beginMicDictation(opSeq);
          } else {
            var nextSt = (after && after.state) || "denied";
            showMicPermBox(nextSt === "denied" ? "denied" : "rationale");
            note.textContent = "Bạn đã từ chối quyền Micro — vẫn có thể gõ tay bên dưới.";
            note.className = "panel-note";
          }
        });
      });
    });
  }

  function toggleMic() {
    var note = $("drill-note");
    if (!window.MicAsr || !MicAsr.supported) {
      note.textContent = "Thiết bị này không hỗ trợ nhận giọng nói — gõ tay nhé.";
      note.className = "panel-note";
      return;
    }
    if (micListening) {
      micOpSeq += 1;
      setMicUiState(false);
      try { MicAsr.stop(); } catch (e) {}
      if (($("typed").value || "").trim()) checkTyped();
      else {
        note.textContent = "Đã dừng thu âm.";
        note.className = "panel-note";
      }
      return;
    }
    micOpSeq += 1;
    var mySeq = micOpSeq;
    pauseOtherAudioBeforeMic();
    // On Chrome Web, call recognition.start() synchronously when drill is ready so browser preserves user-gesture activation
    if (drill && window.MicAsr.engine && window.MicAsr.engine() === "web") {
      beginMicDictation(mySeq);
      return;
    }
    runMicPermissionAndStart(mySeq, false);
  }

  // ---------------- M2.3a fill-blank ----------------
  function pickBlankTarget(sentence, word) {
    if (!sentence) return null;
    if (word && word.length >= 2) {
      var escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var boundaryRe = new RegExp("(^|[^\\p{L}\\p{N}])(" + escaped + ")(?=[^\\p{L}\\p{N}]|$)", "iu");
      var bm;
      try { bm = sentence.match(boundaryRe); } catch (e) { bm = null; }
      if (bm && bm[2]) return bm[2];
      var subRe = new RegExp(escaped, "i");
      if (subRe.test(sentence) && sentence.length > word.length + 2) return word;
    }
    var parts = sentence.split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    var best = "";
    for (var i = 0; i < parts.length; i++) {
      var clean = parts[i].replace(/^[.,!?;:"'“”‘’()\[\]]+|[.,!?;:"'“”‘’()\[\]]+$/g, "");
      if (clean.length > best.length) best = clean;
    }
    return best.length >= 3 ? best : null;
  }

  function pickFillDistractors(id, answer, learningData) {
    var normAns = normalizeAnswer(answer);
    var ansWords = answer.trim().split(/\s+/).length;
    var rank = conceptRank[id] || 0;
    var wMap = (learningData && learningData.w) || {};
    var seen = {};
    seen[normAns] = 1;
    var closeMatches = [];
    var fallback = [];

    function inspect(cand) {
      if (!cand) return;
      var trimmed = String(cand).trim();
      var norm = normalizeAnswer(trimmed);
      if (!norm || seen[norm]) return;
      seen[norm] = 1;
      var words = trimmed.split(/\s+/).length;
      if ((ansWords === 1 && words === 1 && Math.abs(trimmed.length - answer.length) <= 4)
          || (ansWords > 1 && words > 1)) {
        closeMatches.push(trimmed);
      } else {
        fallback.push(trimmed);
      }
    }

    for (var step = 3; step < concepts.length && closeMatches.length < 3; step += 7) {
      var cid = concepts[(rank + step) % concepts.length];
      if (cid === id) continue;
      if (drills && drills[cid] && drills[cid][0] && drills[cid][0].sf) inspect(drills[cid][0].sf);
      if (wMap[cid]) inspect(wMap[cid]);
    }
    return closeMatches.concat(fallback).slice(0, 3);
  }

  function renderFillChoices(choices, answer, lang, fullSentence, hint) {
    var box = $("fill-opts");
    if (!box) return;
    clearNodeChildren(box);
    var buttons = [];
    choices.forEach(function (opt) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "conj-opt";
      btn.textContent = opt;
      btn.addEventListener("click", function () {
        if (!fill || fill.choiceDone) return;
        var ok = normalizeAnswer(opt) === normalizeAnswer(answer);
        var note = $("fill-note");
        if (ok) {
          fill.choiceDone = true;
          btn.className = "conj-opt correct";
          buttons.forEach(function (b) { b.disabled = true; });
          if ($("fill-sent") && fill.blanked) {
            $("fill-sent").textContent = fill.blanked.replace("____", "[" + answer + "]");
          }
          if (note) {
            note.textContent = "✅ Đúng: " + answer + (hint ? " (" + hint + ")" : "");
            note.className = "panel-note ok";
          }
          if (!fill.scored) { fill.scored = true; sessionStats.correct += 1; }
          speak(fullSentence, lang);
        } else {
          btn.className = "conj-opt wrong";
          btn.disabled = true;
          if (note) {
            note.textContent = "💡 Chưa khớp — bạn thử chọn đáp án khác nhé!";
            note.className = "panel-note retry";
          }
        }
      });
      buttons.push(btn);
      box.appendChild(btn);
    });
  }

  function setFillMode(mode, opts) {
    opts = opts || {};
    if (!fill) return;
    var hasChoices = !!(fill.choices && fill.choices.length >= 2 && $("fill-opts"));
    var actual = (mode === "choice" && hasChoices) ? "choice" : "type";
    fill.mode = actual;
    if (opts.persist && hasChoices) writePracticePref("dictlearn_fill_mode", actual);

    var optsEl = $("fill-opts");
    var inpEl = $("fill-input");
    var checkEl = $("fillcheck");
    var modeBtn = $("fill-mode-btn");
    if (optsEl && optsEl.classList) optsEl.classList.toggle("hidden", actual !== "choice");
    if (inpEl && inpEl.classList) inpEl.classList.toggle("hidden", actual === "choice");
    if (checkEl && checkEl.classList) checkEl.classList.toggle("hidden", actual === "choice");
    if (modeBtn) {
      if (modeBtn.classList) modeBtn.classList.toggle("hidden", !hasChoices);
      modeBtn.textContent = actual === "choice" ? "⌨️ Gõ phím" : "🧩 Chọn 4 đáp án";
    }
    var note = $("fill-note");
    if (note && opts.updateNote) {
      var h = (fill.row && fill.row.h) ? (" · " + fill.row.h) : "";
      note.textContent = actual === "choice"
        ? ("Chạm từ đúng để điền vào chỗ trống" + h)
        : ("Nghe câu rồi gõ từ còn thiếu (vị trí gạch ngang)" + h);
      note.className = "panel-note";
    }
    if (actual === "type" && opts.focusInput && inpEl && inpEl.focus) {
      setTimeout(function () { try { inpEl.focus(); } catch (e) {} }, 30);
    }
  }

  function setupFillView(id, blanked, answer, lang, row, learningData) {
    var distractors = pickFillDistractors(id, answer, learningData);
    var choices = distractors.length ? shuffleCopy([answer].concat(distractors)) : [];
    fill = {
      id: id,
      row: row,
      blanked: blanked,
      answer: answer,
      lang: lang,
      choices: choices,
      scored: false,
      choiceDone: false,
      mode: "type"
    };
    $("fill-sent").textContent = blanked;
    $("fill-input").value = "";
    if (choices.length >= 2) renderFillChoices(choices, answer, lang, row.s, row.h);

    var pref = readPracticePref("dictlearn_fill_mode");
    var want = (pref === "choice" || pref === "type") ? pref : (choices.length >= 2 && !isMasteredForTyping(id) ? "choice" : "type");
    setFillMode(want, { updateNote: true });
    speak(row.s, lang);
  }

  function showFill(mode) {
    var lang = practiceLang();
    var ready = (lang === "en") ? Promise.all([withDrills("fill", function () {}), loadLang("en")]) : Promise.resolve();
    return ready.then(function () {
      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("fillbox");
      var rows = (lang === "en") ? (drills[id] || []).filter(function (r) { return r.s && r.sf; }) : [];
      toggleNext("fillnext", rows.length > 1);
      if (rows.length) {
        var row = rows[pickCursor("f" + id, mode === "next") % rows.length];
        var sf = row.sf;
        var re = new RegExp(sf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        if (!re.test(row.s)) { showListen(); return; }
        var blanked = row.s.replace(re, "____");
        setupFillView(id, blanked, sf, "en", row, cache["en"]);
        return;
      }
      return loadPracticePairData(id).then(function (d) {
        var token = pickBlankTarget(d.sentence, d.word);
        if (!token || d.sentence === d.word) { showListen(); return; }
        var re2 = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        if (!re2.test(d.sentence)) { showListen(); return; }
        var blanked2 = d.sentence.replace(re2, "____");
        setupFillView(id, blanked2, token, d.lang, { s: d.sentence, h: d.hint }, d.learning);
      });
    });
  }

  function checkFill() {
    if (!fill) return;
    var raw = $("fill-input").value.trim();
    if (!raw) return;
    var ok = raw.toLowerCase() === fill.answer.toLowerCase() ||
      normalizeAnswer(raw) === normalizeAnswer(fill.answer);
    var note = $("fill-note");
    note.textContent = ok
      ? ("✅ Đúng: " + fill.answer + (fill.row && fill.row.h ? " (" + fill.row.h + ")" : ""))
      : ("💡 Đáp án: " + fill.answer + (fill.row && fill.row.h ? " · " + fill.row.h : ""));
    note.className = "panel-note " + (ok ? "ok" : "bad");
    if (ok && !fill.scored) { fill.scored = true; sessionStats.correct += 1; }
  }

  // ---------------- M2.3b conjugate + multilingual context quiz ----------------
  function renderConjChoices(choices, winner, lang) {
    conj = { correct: winner, lang: lang, done: false };
    var box = $("conj-opts");
    box.innerHTML = "";
    var note = $("conj-note");
    note.textContent = "Chạm 1 đáp án đúng:";
    note.className = "panel-note";
    toggleNext("conjnext", false);
    var buttons = [];
    choices.forEach(function (r) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "conj-opt";
      btn.textContent = r.s;
      btn.addEventListener("click", function () {
        if (!conj || conj.done) return;
        conj.done = true;
        var ok = (r.s === conj.correct.s);
        var nn = $("conj-note");
        nn.textContent = ok ? ("✅ Đúng: " + conj.correct.s) : ("Đáp án: " + conj.correct.s + (conj.correct.h ? " · " + conj.correct.h : ""));
        nn.className = "panel-note " + (ok ? "ok" : "bad");
        buttons.forEach(function (b) {
          b.disabled = true;
          if (b.textContent === conj.correct.s) b.className = "conj-opt correct";
          else if (b === btn) b.className = "conj-opt wrong";
        });
        if (ok) sessionStats.correct += 1;
        speak(conj.correct.s, lang);
        toggleNext("conjnext", true);
      });
      buttons.push(btn);
      box.appendChild(btn);
    });
  }

  function showContextQuiz(id) {
    return loadPracticePairData(id).then(function (d) {
      var note = $("conj-note");
      if (!d.sentence || !d.hint) {
        $("conj-prompt").textContent = "";
        note.textContent = "Từ này chưa đủ dữ liệu trắc nghiệm — thử Nghe & ghi nhé.";
        note.className = "panel-note";
        $("conj-opts").innerHTML = "";
        return;
      }
      var rank = conceptRank[id] || 0;
      var distractors = [];
      var seenS = {};
      seenS[d.sentence] = 1;
      for (var step = 3 + conjCursor; step < concepts.length && distractors.length < 2; step += 7) {
        var candId = concepts[(rank + step) % concepts.length];
        var candS = (d.learning.e && d.learning.e[candId]) || (d.learning.w && d.learning.w[candId]) || "";
        if (candS && !seenS[candS]) {
          seenS[candS] = 1;
          distractors.push({ s: candS, h: (d.known.e && d.known.e[candId]) || "" });
        }
      }
      if (!distractors.length) { showListen(); return; }
      var winner = { s: d.sentence, h: d.hint };
      var choices = [winner].concat(distractors);
      choices.sort(function () { return Math.random() - 0.5; });
      $("conj-prompt").textContent = 'Chọn câu khớp với nghĩa: "' + d.hint + '"';
      renderConjChoices(choices, winner, d.lang);
      speak(winner.s, d.lang);
    });
  }

  function showConjugate(mode) {
    var lang = practiceLang();
    var ready = (lang === "en") ? withDrills("conj", function () {}) : Promise.resolve();
    return ready.then(function () {
      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("conjbox");
      conjCursor = pickCursor("c" + id, mode === "next");
      var rows = (lang === "en") ? (drills[id] || []) : [];
      var byPol = {};
      rows.forEach(function (r) { if (r.t && r.p) (byPol[r.p] = byPol[r.p] || []).push(r); });

      var targetPol = null;
      ['affirmative', 'negative', 'question'].forEach(function (p) {
        if (targetPol || !byPol[p]) return;
        var tenses = {};
        byPol[p].forEach(function (r) { tenses[r.t] = 1; });
        if (Object.keys(tenses).length > 1) targetPol = p;
      });
      if (targetPol) {
        $("conj-prompt").textContent = "Chọn câu ở dạng HIỆN TẠI (present simple):";
        buildConjOptions(rows, function (r) { return r.p === targetPol; }, "present_simple");
        return;
      }
      var qRows = rows.filter(function (r) { return r.p === "question"; });
      if (qRows.length) {
        $("conj-prompt").textContent = "Chọn câu là CÂU HỎI:";
        buildConjOptions(rows, function () { return true; }, "question");
        return;
      }
      return showContextQuiz(id);
    });
  }

  function buildConjOptions(allRows, filterFn, correctKey) {
    var pool = allRows.filter(filterFn);
    var seen = {};
    var opts = pool.filter(function (r) {
      var k = r.t + "|" + r.p;
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
    if (opts.length < 2) { showListen(); return; }
    var correct = opts.filter(function (r) {
      if (correctKey === "question") return r.p === "question";
      return r.t === correctKey && r.p !== "question";
    });
    if (!correct.length) { showListen(); return; }
    var winner = correct[0];
    var others = opts.filter(function (r) { return r !== winner; });
    var off = others.length ? conjCursor % others.length : 0;
    var distractors = others.slice(off).concat(others.slice(0, off)).slice(0, 2);
    var choices = [winner].concat(distractors);
    choices.sort(function () { return Math.random() - 0.5; });
    renderConjChoices(choices, winner, "en");
    speak(winner.s, "en");
  }

  // ---------------- offline dictionary quick search ----------------
  function ensureSearchIndex() {
    var key = base() + "_" + target();
    if (searchIndexKey === key && searchIndexList.length) {
      return Promise.resolve(searchIndexList);
    }
    return Promise.all([loadLang(base()), loadLang(target())]).then(function (pair) {
      var known = pair[0] || {}, learning = pair[1] || {};
      var kw = known.w || {}, lw = learning.w || {}, lro = learning.ro || {};
      var arr = [];
      for (var i = 0; i < concepts.length; i++) {
        var id = concepts[i];
        var w = lw[id] || "";
        var m = kw[id] || "";
        var ro = lro[id] || "";
        if (!w && !m) continue;
        arr.push({
          id: id,
          w: w,
          m: m,
          ro: ro,
          wf: foldText(w),
          mf: foldText(m),
          rf: ro ? foldText(ro) : ""
        });
      }
      searchIndexKey = key;
      searchIndexList = arr;
      return arr;
    });
  }

  function searchDict(query) {
    var box = $("dict-results"), clr = $("dict-clear");
    var q = foldText(query);
    if (clr) clr.classList.toggle("hidden", !query || !query.trim());
    if (!box) return Promise.resolve([]);
    if (!q) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return Promise.resolve([]);
    }
    return ensureSearchIndex().then(function (arr) {
      var srs = readSrs();
      var prefix = [], sub = [];
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (it.wf.indexOf(q) === 0 || it.mf.indexOf(q) === 0) {
          prefix.push(it);
          if (prefix.length >= 12) break;
        } else if (it.wf.indexOf(q) !== -1 || it.mf.indexOf(q) !== -1 || (it.rf && it.rf.indexOf(q) !== -1)) {
          if (sub.length < 12) sub.push(it);
        }
      }
      var hits = prefix.concat(sub).slice(0, 12);
      if (!hits.length) {
        box.innerHTML = '<div class="search-empty">Không tìm thấy từ phù hợp với "' + esc(query.trim()) + '"</div>';
        box.classList.remove("hidden");
        return hits;
      }
      box.innerHTML = hits.map(function (it) {
        var badge = srsStatusBadge(srs[it.id]);
        var lv = cefrOf(it.id);
        return '<div class="search-item">' +
          '<div class="search-main">' +
            '<div><span class="search-w">' + esc(it.w || it.id) + "</span>" +
              (it.ro ? '<span class="search-ph">' + esc(it.ro) + "</span>" : "") + "</div>" +
            '<div class="search-m">' + esc(it.m) + "</div>" +
            '<div class="search-badges"><span class="badge-mini">' + esc(lv) + '</span><span class="badge-mini ' + badge.cls + '">' + esc(badge.text) + "</span></div>" +
          "</div>" +
          '<div class="search-btns">' +
            '<button type="button" data-search-speak="' + esc(it.w || "") + '" aria-label="Nghe">🔊</button>' +
            '<button type="button" class="act" data-search-study="' + esc(it.id) + '">Học</button>' +
          "</div>" +
        "</div>";
      }).join("");
      box.classList.remove("hidden");
      return hits;
    });
  }

  // ---------------- boot ----------------
  function boot() {
    // Fast path: concepts + langs are small; the card shows immediately.
    // The heavy drills pack is loaded in the background so practice buttons
    // never block first paint.
    var db = dataBase();
    return Promise.all([
      fetch(db + "/concepts.json").then(function (r) { return r.json(); }),
      fetch(db + "/langs.json").then(function (r) { return r.json(); })
    ]).then(function (parts) {
      concepts = parts[0] || [];
      conceptRank = {};
      for (var i = 0; i < concepts.length; i++) conceptRank[concepts[i]] = i;
      langs = parts[1] || [];
      ["base", "target"].forEach(function (idn) {
        $(idn).innerHTML = langs.map(function (l) {
          return '<option value="' + l.code + '">' + l.native + "</option>";
        }).join("");
      });
      $("base").value = "vi";
      $("target").value = "en";
      applyTheme(localStorage.getItem("dictlearn_theme") || "auto");
      var sl = $("sessionlen");
      if (sl) sl.value = localStorage.getItem("dictlearn_session") || sl.value || "50";
      try { cefrLevel = localStorage.getItem("dictlearn_cefr_level") || "all"; } catch (e) { cefrLevel = "all"; }
      // background load of the drill pack (non-blocking)
      drillsReady = fetch(db + "/drills.json")
        .then(function (r) { return r.json(); })
        .then(function (d) { drills = d; })
        .catch(function () {});
      return loadSrs().then(function () {
        $("boot").classList.add("hidden");
        $("top").classList.remove("hidden");
        $("app").classList.remove("hidden");
        if ($("bottom-nav")) $("bottom-nav").classList.remove("hidden");
        return initAudioSubsystem().then(function (initAudioState) {
          renderHome();
          buildQueue();
          appBootReady = true;
          var openAudioNow = pendingOpenAudio
            || !!(initAudioState && (initAudioState.openRequested || initAudioState.status === "playing"));
          pendingOpenAudio = false;
          if (openAudioNow) {
            showAudio(false);
          } else {
            showHome();
          }
          return render();
        });
      });
    });
  }

  // Await the drill pack before a practice panel that needs it. If it hasn't
  // landed yet, show a friendly "loading" note instead of a blank panel.
  function withDrills(kind, fn) {
    if (!drillsReady) return Promise.resolve().then(fn);
    return drillsReady.then(fn, function () {
      var note = $(kind === "listen" ? "drill-note" : kind === "fill" ? "fill-note" : "conj-note");
      if (note) { note.textContent = "Đang tải bộ câu luyện…"; note.className = "panel-note"; }
      return null;
    });
  }

  function applyTheme(t) {
    if (document.documentElement) document.documentElement.setAttribute("data-theme", t);
    var btn = $("thmbtn");
    if (btn) btn.textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
  }

  // ---------------- Passive Audio Learning ----------------
  function audioRoleLabel(role) {
    switch (role) {
      case "word": return "Từ đích";
      case "meaning": return "Nghĩa tiếng gốc";
      case "ex_target": return "Ví dụ";
      case "ex_base": return "Dịch ví dụ";
      case "drill_target": return "Câu công sở";
      case "drill_base": return "Dịch câu công sở";
      case "repeat": return "Nhắc lại từ đích";
      default: return "";
    }
  }

  function audioPrefsFromUI() {
    var basePrefs = (audioStats && audioStats.prefs) || (window.AudioPlayer && window.AudioPlayer.DEFAULT_PREFS) || {};
    var out = Object.assign({ autoStageSrs: false }, basePrefs);
    if ($("audio-source")) out.source = $("audio-source").value || out.source || "session";
    if ($("audio-preset")) out.preset = $("audio-preset").value || out.preset || "deep";
    if ($("audio-order")) out.order = $("audio-order").value || out.order || "base_first";
    if ($("audio-target-repeat")) out.targetRepeat = parseInt($("audio-target-repeat").value || String(out.targetRepeat || 2), 10) || 2;
    if ($("audio-speed")) out.speed = Number($("audio-speed").value || out.speed || 1) || 1;
    if ($("audio-repeat")) out.repeatMode = $("audio-repeat").value || out.repeatMode || "none";
    if ($("audio-drills")) out.includeDrills = !!$("audio-drills").checked;
    if ($("audio-offline")) out.preferOffline = !!$("audio-offline").checked;
    if ($("audio-autostage")) out.autoStageSrs = !!$("audio-autostage").checked;
    if ($("audio-sleep")) out.sleepMinutes = parseInt($("audio-sleep").value || "0", 10) || 0;
    return out;
  }

  function syncAudioPrefsUI() {
    if (!audioStats || !audioStats.prefs) return;
    var p = audioStats.prefs;
    if ($("audio-source")) $("audio-source").value = p.source || "session";
    if ($("audio-preset")) $("audio-preset").value = p.preset || "deep";
    if ($("audio-order")) $("audio-order").value = p.order || "base_first";
    if ($("audio-target-repeat")) $("audio-target-repeat").value = String(p.targetRepeat || 2);
    if ($("audio-speed")) $("audio-speed").value = String(p.speed || 1);
    if ($("audio-repeat")) $("audio-repeat").value = p.repeatMode || "none";
    if ($("audio-drills")) $("audio-drills").checked = !!p.includeDrills;
    if ($("audio-offline")) $("audio-offline").checked = !!p.preferOffline;
    if ($("audio-autostage")) $("audio-autostage").checked = !!p.autoStageSrs;
    if ($("audio-sleep")) $("audio-sleep").value = String(p.sleepMinutes || 0);
    if ($("audio-order-row")) {
      $("audio-order-row").classList.toggle("hidden", (p.preset || "deep") === "target_only");
    }
    if ($("audio-drills-row")) {
      $("audio-drills-row").classList.toggle("hidden", !(base() === "vi" && target() === "en"));
    }
  }

  function loadAudioStats() {
    if (!window.AudioPlayer) { audioStats = null; return Promise.resolve(null); }
    return window.AudioPlayer.loadStats(base(), target()).then(function (st) {
      audioStats = st;
      syncAudioPrefsUI();
      updateAudioHomeMeta();
      return st;
    });
  }

  function saveAudioStats() {
    if (!window.AudioPlayer || !audioStats) return Promise.resolve();
    return window.AudioPlayer.saveStats(base(), target(), audioStats);
  }

  function prepareAudioTracks(ensureDrills, overrideTargetId) {
    if (!window.AudioPlayer) return Promise.resolve([]);
    var prefs = audioPrefsFromUI();
    var src = prefs.source || "session";
    if (src === "session" && !queue.length) buildQueue();
    var loads = [loadLang(base()), loadLang(target())];
    if ((ensureDrills || prefs.includeDrills) && base() === "vi" && target() === "en" && drillsReady) {
      loads.push(drillsReady.catch(function () {}));
    }
    return Promise.all(loads).then(function (parts) {
      var list = window.AudioPlayer.buildPlaylist({
        concepts: concepts,
        baseData: parts[0],
        targetData: parts[1],
        drills: drills,
        srs: readSrs(),
        mastered: (audioStats && audioStats.mastered) || {},
        source: src,
        sessionIds: src === "session" ? queue : null,
        levelFilter: cefrLevel || "all",
        baseLang: base(),
        targetLang: target(),
        limit: src === "session" ? Math.max(sessionLen(), queue.length) : sessionLen(),
        today: todayISO()
      });
      audioPreviewTracks = list;
      var targetLookup = overrideTargetId
        || (src === "session" && !sessionDone && queue[idx] ? queue[idx] : "")
        || (audioStats && audioStats.cursorId)
        || "";
      var idxFound = 0;
      if (targetLookup) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === targetLookup) { idxFound = i; break; }
        }
      }
      audioPreviewIndex = idxFound;
      var st = window.AudioPlayer.getState();
      if (!st || st.status === "idle") renderAudioScreen(st);
      return list;
    });
  }

  function updateAudioGradeHints(id) {
    var rec = id ? (readSrs()[id] || null) : null;
    var hardNext = computeNextSrs(rec, "hard");
    var okNext = computeNextSrs(rec, "ok");
    var goodNext = computeNextSrs(rec, "good");
    if ($("audio-b1-sub")) $("audio-b1-sub").textContent = "lặp lại " + hardNext.interval + " ngày";
    if ($("audio-b2-sub")) $("audio-b2-sub").textContent = "lặp lại " + okNext.interval + " ngày";
    if ($("audio-b3-sub")) $("audio-b3-sub").textContent = "gặp lại " + goodNext.interval + " ngày";
  }

  function syncStudyCursorFromAudio(st) {
    if (!st || !st.conceptId || !st.status || st.status === "idle") return;
    var studyVisible = $("study") && !$("study").classList.contains("hidden");
    if (studyVisible) return;
    var qPos = queue.indexOf(st.conceptId);
    if (qPos !== -1) {
      idx = qPos;
      sessionDone = false;
    }
    if (typeof st.index === "number" && st.index >= 0) {
      audioPreviewIndex = st.index;
    }
    updateSessionStatus();
  }

  function handoffStudyToAudio() {
    if (!window.AudioPlayer || !$("audio-screen")) return Promise.resolve({ ok: false });
    if (!queue.length) buildQueue();
    var targetCid = (!sessionDone && idx >= 0 && idx < queue.length) ? queue[idx] : (queue[0] || "");
    if ($("audio-source") && $("audio-source").value !== "session") {
      $("audio-source").value = "session";
      if (audioStats && audioStats.prefs) {
        audioStats.prefs.source = "session";
        saveAudioStats();
      }
    }
    hidePanels();
    audioPreviewTracks = [];
    setActiveScreen("audio");
    var prefs = audioPrefsFromUI();
    return prepareAudioTracks(prefs.includeDrills, targetCid).then(function (list) {
      if (!list || !list.length) {
        renderAudioScreen(window.AudioPlayer.getState());
        return { ok: false };
      }
      return startPassiveAudio();
    });
  }

  function syncQueueFromAudio(activeTracks, targetCid, targetTrackIdx) {
    var trackIds = [];
    for (var i = 0; i < (activeTracks || []).length; i++) {
      if (activeTracks[i] && activeTracks[i].id) trackIds.push(activeTracks[i].id);
    }
    var src = ($("audio-source") && $("audio-source").value) || "session";
    if (targetCid && queue.indexOf(targetCid) !== -1 && (src === "session" || !trackIds.length)) {
      idx = queue.indexOf(targetCid);
    } else if (trackIds.length) {
      queue = trackIds;
      requeued = {};
      sessionHardIds = [];
      undoStack = [];
      sessionStats = { learned: 0, remembered: 0, correct: 0, practice: 0 };
      var foundIdx = targetCid ? queue.indexOf(targetCid) : -1;
      idx = foundIdx !== -1 ? foundIdx : Math.max(0, Math.min(Number(targetTrackIdx) || 0, queue.length - 1));
    } else if (targetCid) {
      openConceptInStudy(targetCid);
      return;
    } else if (!queue.length) {
      buildQueue();
    }
    sessionDone = false;
    showStudy();
  }

  function handoffAudioToStudy() {
    if (!window.AudioPlayer) {
      showStudy();
      return Promise.resolve();
    }
    var st = window.AudioPlayer.getState();
    var isLive = !!(st && st.status && st.status !== "idle");
    var playerTracks = window.AudioPlayer.getTracks ? window.AudioPlayer.getTracks() : [];
    var activeTracks = (isLive && playerTracks && playerTracks.length) ? playerTracks : audioPreviewTracks;
    var targetCid = (isLive && st.conceptId)
      ? st.conceptId
      : (activeTracks[audioPreviewIndex] ? activeTracks[audioPreviewIndex].id : "");
    var targetTrackIdx = (isLive && typeof st.index === "number") ? st.index : audioPreviewIndex;
    var pauseP = (st && (st.status === "playing" || st.status === "loading"))
      ? window.AudioPlayer.pause()
      : Promise.resolve(st);
    return pauseP.then(function () {
      syncQueueFromAudio(activeTracks, targetCid, targetTrackIdx);
    });
  }

  function gradeFromAudio(kind) {
    if (!window.AudioPlayer) return Promise.resolve();
    var st = window.AudioPlayer.getState();
    var isActive = !!(st && st.status && st.status !== "idle" && st.conceptId);
    var cid = isActive ? st.conceptId : (audioPreviewTracks[audioPreviewIndex] && audioPreviewTracks[audioPreviewIndex].id);
    if (!cid) return Promise.resolve();

    var store = readSrs();
    var qPos = queue.indexOf(cid);
    undoStack.push({
      id: cid,
      prevEntry: store[cid] ? Object.assign({}, store[cid]) : null,
      prevIdx: qPos !== -1 ? qPos : idx,
      prevQueueLen: queue.length,
      hadRequeued: !!requeued[cid],
      prevHard: sessionHardIds.slice(),
      prevStats: Object.assign({}, sessionStats)
    });
    if (undoStack.length > 30) undoStack.shift();

    var nextRec = computeNextSrs(store[cid], kind);
    store[cid] = nextRec;
    sessionStats.learned++;
    if (kind === "good" || kind === "ok") sessionStats.remembered = (sessionStats.remembered || 0) + 1;
    if (kind === "hard" && sessionHardIds.indexOf(cid) === -1) sessionHardIds.push(cid);
    persistSrs();

    var label = kind === "good" ? "Đã nhớ" : kind === "ok" ? "Mờ hồ" : "Chưa nhớ";
    toast("✓ " + label + " · hẹn lại sau " + nextRec.interval + " ngày", kind === "hard" ? "" : "ok");

    if (isActive) {
      return window.AudioPlayer.next();
    }
    if (audioPreviewTracks.length && audioPreviewIndex + 1 < audioPreviewTracks.length) {
      audioPreviewIndex += 1;
    }
    renderAudioScreen(st);
    return Promise.resolve();
  }

  function startPassiveAudio() {
    if (!window.AudioPlayer) return Promise.resolve({ ok: false });
    soundOn = true;
    if ($("sndbtn")) $("sndbtn").textContent = "🔊";
    var prefs = audioPrefsFromUI();
    if (audioStats) {
      audioStats.prefs = Object.assign({}, audioStats.prefs, prefs);
      saveAudioStats();
    }
    var ready = audioPreviewTracks.length ? Promise.resolve(audioPreviewTracks) : prepareAudioTracks(prefs.includeDrills);
    return ready.then(function (list) {
      if (!list || !list.length) {
        toast("Không có từ phù hợp cho nguồn này", "bad");
        return { ok: false };
      }
      return window.AudioPlayer.start(list, audioPreviewIndex, prefs, prefs.sleepMinutes).then(function (res) {
        if (res && res.permissionGranted === false) {
          toast("💡 Cho phép thông báo để điều khiển phát từ màn hình khóa");
        } else if (res && res.ok === false) {
          toast("🔇 Không khởi động được trình phát nền", "bad");
        }
        return res;
      });
    });
  }

  function ensureAudioCardData(conceptId) {
    if (!conceptId) return;
    var key = base() + "_" + target() + "_" + conceptId;
    if (audioCardCache[key] || audioEnrichReq === key) return;
    audioEnrichReq = key;
    Promise.all([loadLang(base()), loadLang(target())]).then(function (parts) {
      if (audioEnrichReq === key) audioEnrichReq = "";
      var baseD = parts[0] || {}, targD = parts[1] || {};
      audioCardCache[key] = {
        _done: true,
        ro: (targD.ro && targD.ro[conceptId]) || "",
        ipa: (targD.ipa && targD.ipa[conceptId]) || "",
        exTarget: (targD.e && targD.e[conceptId]) || "",
        exBase: (baseD.e && baseD.e[conceptId]) || ""
      };
      var cur = window.AudioPlayer ? window.AudioPlayer.getState() : null;
      if (cur && cur.conceptId === conceptId) {
        renderAudioScreen(cur);
      }
    }).catch(function () {
      if (audioEnrichReq === key) audioEnrichReq = "";
    });
  }

  function renderAudioScreen(state) {
    if (!$("audio-screen")) return;
    var st = state || (window.AudioPlayer ? window.AudioPlayer.getState() : null);
    var isActive = !!(st && st.status && st.status !== "idle" && st.word);
    var item = (!isActive && audioPreviewTracks.length)
      ? (audioPreviewTracks[Math.max(0, Math.min(audioPreviewIndex, audioPreviewTracks.length - 1))] || null)
      : null;
    var view = isActive ? st : (item ? {
      status: (st && st.status) || "idle",
      index: audioPreviewIndex,
      total: audioPreviewTracks.length,
      conceptId: item.id,
      word: item.word,
      meaning: item.meaning,
      ro: item.ro,
      ipa: item.ipa,
      exTarget: item.exTarget,
      exBase: item.exBase,
      stepRole: "",
      stepText: "",
      heardCount: 0,
      sleepRemainingMs: 0,
      error: (st && st.error) || "",
      nativeBackend: !!(st && st.nativeBackend)
    } : null);

    var badge = $("audio-state-badge");
    var cefrBadge = $("audio-cefr-badge");
    var prog = $("audio-progress");
    var playBtn = $("audio-play");

    if (!view) {
      if (badge) { badge.textContent = "Trống"; badge.classList.remove("is-playing"); }
      if (cefrBadge) cefrBadge.classList.add("hidden");
      if (prog) prog.textContent = "Chưa có từ phù hợp";
      if ($("audio-word")) $("audio-word").textContent = "—";
      if ($("audio-phonetics")) $("audio-phonetics").textContent = "";
      if ($("audio-meaning")) $("audio-meaning").textContent = "Hãy thử đổi nguồn phát khác";
      if ($("audio-ex-target")) $("audio-ex-target").textContent = "";
      if ($("audio-ex-base")) $("audio-ex-base").textContent = "";
      if (playBtn) playBtn.textContent = "▶ Phát nghe";
      if ($("audio-grade-row")) $("audio-grade-row").classList.add("hidden");
      if ($("audio-controls")) $("audio-controls").classList.add("hidden");
      if ($("audio-deck-bar")) $("audio-deck-bar").classList.add("hidden");
      var advEl = $("audio-screen").querySelector ? $("audio-screen").querySelector(".audio-adv") : null;
      if (advEl) advEl.open = true;
      return;
    }

    if ($("audio-controls")) $("audio-controls").classList.remove("hidden");
    if ($("audio-deck-bar")) {
      var isSessionSrc = !$("audio-source") || $("audio-source").value === "session";
      $("audio-deck-bar").classList.toggle("hidden", !isSessionSrc);
    }
    if ($("audio-grade-row")) $("audio-grade-row").classList.remove("hidden");
    updateAudioGradeHints(view.conceptId);

    if (cefrBadge && view.conceptId) {
      cefrBadge.textContent = cefrOf(view.conceptId);
      cefrBadge.classList.remove("hidden");
    } else if (cefrBadge) {
      cefrBadge.classList.add("hidden");
    }

    var roleLbl = audioRoleLabel(view.stepRole);
    if (badge) {
      badge.classList.toggle("is-playing", view.status === "playing");
      if (view.status === "playing") badge.textContent = "🔊 Đang phát" + (roleLbl ? " · " + roleLbl : "");
      else if (view.status === "paused") badge.textContent = "⏸ Tạm dừng";
      else if (view.status === "loading") badge.textContent = "⏳ Đang tạo giọng…";
      else if (view.status === "error") badge.textContent = "🔇 Lỗi phát";
      else badge.textContent = "🎧 Sẵn sàng";
    }

    if (prog) {
      var sleepTxt = (view.sleepRemainingMs && view.sleepRemainingMs > 0)
        ? (" · ⏱ " + Math.ceil(view.sleepRemainingMs / 60000) + "p")
        : "";
      if (isActive) {
        prog.textContent = "Từ " + (view.index + 1) + " / " + (view.total || 1) +
          " · Bộ #" + batchNum +
          (view.heardCount ? " · Đã nghe " + view.heardCount : "") + sleepTxt;
      } else {
        prog.textContent = "Bộ #" + batchNum + " (" + view.total + " từ) · Vị trí " + (view.index + 1);
      }
    }

    var cacheKey = view.conceptId ? (base() + "_" + target() + "_" + view.conceptId) : "";
    var cached = cacheKey ? (audioCardCache[cacheKey] || null) : null;
    var effRo = view.ro || (cached && cached.ro) || "";
    var effIpa = view.ipa || (cached && cached.ipa) || "";
    var effExTarget = view.exTarget
      || (view.stepRole === "drill_target" && view.stepText ? ("💼 " + view.stepText) : "")
      || (cached && cached.exTarget) || "";
    var effExBase = view.exBase
      || (view.stepRole === "drill_base" && view.stepText ? view.stepText : "")
      || (cached && cached.exBase) || "";

    if ($("audio-word")) $("audio-word").textContent = view.word || "—";
    if ($("audio-phonetics")) {
      $("audio-phonetics").textContent = [effRo, effIpa].filter(Boolean).join(" · ");
    }
    if ($("audio-meaning")) $("audio-meaning").textContent = view.meaning || "";

    if ($("audio-ex-target")) $("audio-ex-target").textContent = effExTarget;
    if ($("audio-ex-base")) $("audio-ex-base").textContent = effExBase;

    if ($("audio-word")) $("audio-word").classList.toggle("audio-hl", view.stepRole === "word" || view.stepRole === "repeat");
    if ($("audio-meaning")) $("audio-meaning").classList.toggle("audio-hl", view.stepRole === "meaning");
    if ($("audio-ex-target")) $("audio-ex-target").classList.toggle("audio-hl", view.stepRole === "ex_target" || view.stepRole === "drill_target");
    if ($("audio-ex-base")) $("audio-ex-base").classList.toggle("audio-hl", view.stepRole === "ex_base" || view.stepRole === "drill_base");

    var stepsEl = $("audio-steps");
    if (stepsEl && stepsEl.querySelectorAll) {
      var curPrefs = audioPrefsFromUI();
      var activePreset = view.preset || curPrefs.preset || "deep";
      var activeOrder = activePreset === "target_only" ? "target_first" : (view.order || curPrefs.order || "base_first");
      var activeRep = view.targetRepeat || curPrefs.targetRepeat || 2;
      var roleOrder = activeOrder === "target_first"
        ? { word: 1, meaning: 2, repeat: 3, ex_target: 4, ex_base: 5 }
        : { meaning: 1, word: 2, repeat: 3, ex_base: 4, ex_target: 5 };
      var normRole = view.stepRole === "drill_target" ? "ex_target" : (view.stepRole === "drill_base" ? "ex_base" : view.stepRole);
      var pills = stepsEl.querySelectorAll(".audio-step-pill");
      for (var i = 0; i < pills.length; i++) {
        var r = pills[i].getAttribute("data-role");
        pills[i].classList.toggle("is-active", !!normRole && r === normRole);
        var hidePill = (activePreset === "target_only" && (r === "meaning" || r === "ex_base"))
          || (activePreset === "quick" && (r === "ex_base" || r === "ex_target"))
          || (r === "repeat" && activeRep < 2);
        pills[i].classList.toggle("hidden", hidePill);
        if (pills[i].style) pills[i].style.order = String(roleOrder[r] || 9);
      }
    }

    if (playBtn) {
      if (view.status === "playing" || view.status === "loading") playBtn.textContent = "⏸ Tạm dừng";
      else if (view.status === "paused") playBtn.textContent = "▶ Tiếp tục";
      else playBtn.textContent = "▶ Phát nghe";
    }

    var note = $("audio-note");
    if (note) {
      var heardToday = audioStats ? Object.keys(audioStats.todayHeardIds || {}).length : 0;
      if (view.error) {
        note.textContent = "🔇 Không phát được (" + view.error + ") — kiểm tra giọng nói trong Cài đặt hoặc bật Ưu tiên giọng Offline.";
        note.className = "panel-note bad";
      } else if (!view.nativeBackend && isActive) {
        note.textContent = "Trình duyệt web có thể tạm dừng khi tắt màn hình. Dùng app Android APK để nghe ngầm ổn định · Hôm nay: " + heardToday + " từ.";
        note.className = "panel-note";
      } else {
        note.textContent = heardToday > 0
          ? ("Hôm nay đã nghe " + heardToday + " từ · Tổng " + (audioStats.totalHeard || 0) + " lượt")
          : "Có thể khóa màn hình hoặc đổi app, từ vựng vẫn tiếp tục phát.";
        note.className = "panel-note";
      }
    }

    if (isActive && view.conceptId && !cached && (!effExTarget || !effExBase || (!effRo && !effIpa))) {
      ensureAudioCardData(view.conceptId);
    }
  }

  function updateMiniAudioBar(state) {
    var mini = $("audio-mini");
    if (!mini) return;
    var st = state || (window.AudioPlayer ? window.AudioPlayer.getState() : null);
    var audioOpen = $("audio-screen") && !$("audio-screen").classList.contains("hidden");
    var visible = !!(st && (st.status === "playing" || st.status === "paused" || st.status === "loading") && !audioOpen);
    mini.classList.toggle("hidden", !visible);
    if (document.body && document.body.classList) {
      document.body.classList.toggle("has-audio-mini", visible);
    }
    if (!visible) return;
    if ($("audio-mini-title")) {
      $("audio-mini-title").textContent = (st.status === "playing" ? "🎧 " : st.status === "loading" ? "⏳ " : "⏸ ") +
        (st.word || "Đang phát") + (st.meaning ? " — " + st.meaning : "") +
        (st.total ? " (" + (st.index + 1) + "/" + st.total + ")" : "");
    }
    if ($("audio-mini-sub")) {
      var subLine = st.exTarget
        ? (st.exTarget + (st.exBase ? " — " + st.exBase : ""))
        : (st.stepText || st.meaning || "");
      $("audio-mini-sub").textContent = subLine;
    }
    if ($("audio-mini-toggle")) {
      $("audio-mini-toggle").textContent = st.status === "playing" || st.status === "loading" ? "⏸" : "▶";
    }
  }

  function initAudioSubsystem() {
    if (!window.AudioPlayer) return Promise.resolve(null);
    window.AudioPlayer.setOnTrackHeard(function (conceptId, st) {
      if (!audioStats || !conceptId) return;
      var t = todayISO();
      if (audioStats.date !== t) {
        audioStats.date = t;
        audioStats.todayHeardIds = {};
        audioStats.todaySec = 0;
      }
      audioStats.todayHeardIds[conceptId] = 1;
      audioStats.totalHeard = (audioStats.totalHeard || 0) + 1;
      audioStats.cursorId = conceptId;
      if (audioStats.prefs && audioStats.prefs.autoStageSrs) {
        var srs = readSrs();
        if (!srs[conceptId]) {
          srs[conceptId] = { grade: "hard", due: iso(1), last: t };
          persistSrs();
          if ($("home") && !$("home").classList.contains("hidden")) renderHome();
        }
      }
      saveAudioStats();
      updateAudioHomeMeta();
    });
    window.AudioPlayer.subscribe(function (st) {
      syncStudyCursorFromAudio(st);
      renderAudioScreen(st);
      updateMiniAudioBar(st);
      updateAudioHomeMeta();
      if (st && st.openRequested) {
        if (appBootReady) showAudio(false);
        else pendingOpenAudio = true;
      }
    });
    window.AudioPlayer.subscribePrefetch(function (ev) {
      var btn = $("audio-prefetch");
      var note = $("audio-note");
      if (!ev) return;
      if (ev.done) {
        if (btn) { btn.disabled = false; btn.textContent = "⬇ Tải sẵn"; }
        if (note) {
          note.textContent = "✅ Đã tải sẵn " + (ev.ok || 0) + "/" + (ev.total || 0) + " từ vào bộ nhớ đệm (nghe offline mượt hơn).";
          note.className = "panel-note ok";
        }
      } else {
        if (btn) { btn.disabled = true; btn.textContent = "⏳ " + (ev.completed || 0) + "/" + (ev.total || 0); }
      }
    });
    return window.AudioPlayer.init().then(function () {
      return loadAudioStats();
    }).then(function () {
      var cur = window.AudioPlayer.getState();
      renderAudioScreen(cur);
      updateMiniAudioBar(cur);
      return cur;
    });
  }

  function wireAudio() {
    if (!window.AudioPlayer) return;
    if ($("audiostartbtn")) {
      $("audiostartbtn").onclick = function () { showAudio(true); };
    }
    if ($("audio-homebtn")) {
      $("audio-homebtn").onclick = showHome;
    }
    if ($("study-to-audio")) {
      $("study-to-audio").onclick = function () { return handoffStudyToAudio(); };
    }
    if ($("audio-to-study")) {
      $("audio-to-study").onclick = function () { return handoffAudioToStudy(); };
    }
    if ($("audio-replay")) {
      $("audio-replay").onclick = function () { return restartCurrentSession("audio"); };
    }
    if ($("audio-next-batch")) {
      $("audio-next-batch").onclick = function () { return nextSessionBatch("audio"); };
    }
    if ($("audio-grade-hard")) $("audio-grade-hard").onclick = function () { return gradeFromAudio("hard"); };
    if ($("audio-grade-ok")) $("audio-grade-ok").onclick = function () { return gradeFromAudio("ok"); };
    if ($("audio-grade-good")) $("audio-grade-good").onclick = function () { return gradeFromAudio("good"); };
    if ($("audio-play")) {
      $("audio-play").onclick = function () {
        var st = window.AudioPlayer.getState();
        if (st && (st.status === "playing" || st.status === "loading")) {
          window.AudioPlayer.pause();
        } else if (st && st.status === "paused") {
          soundOn = true;
          if ($("sndbtn")) $("sndbtn").textContent = "🔊";
          window.AudioPlayer.resume();
        } else {
          startPassiveAudio();
        }
      };
    }
    if ($("audio-prev")) {
      $("audio-prev").onclick = function () {
        var st = window.AudioPlayer.getState();
        if (!st || st.status === "idle") {
          if (audioPreviewTracks.length) {
            audioPreviewIndex = Math.max(0, audioPreviewIndex - 1);
            renderAudioScreen(st);
          }
          return;
        }
        window.AudioPlayer.prev();
      };
    }
    if ($("audio-next")) {
      $("audio-next").onclick = function () {
        var st = window.AudioPlayer.getState();
        if (!st || st.status === "idle") {
          if (audioPreviewTracks.length) {
            audioPreviewIndex = Math.min(audioPreviewTracks.length - 1, audioPreviewIndex + 1);
            renderAudioScreen(st);
          }
          return;
        }
        window.AudioPlayer.next();
      };
    }
    if ($("audio-stop")) {
      $("audio-stop").onclick = function () {
        return window.AudioPlayer.stop().then(function () {
          return prepareAudioTracks(false);
        });
      };
    }
    if ($("audio-master")) {
      $("audio-master").onclick = function () {
        var st = window.AudioPlayer.getState();
        var active = !!(st && st.status && st.status !== "idle" && st.conceptId);
        var cid = active ? st.conceptId : (audioPreviewTracks[audioPreviewIndex] && audioPreviewTracks[audioPreviewIndex].id);
        if (!cid || !audioStats) return Promise.resolve();
        audioStats.mastered[cid] = 1;
        saveAudioStats();
        toast("✓ Đã bỏ qua từ này khỏi danh sách nghe");
        if (active) {
          return window.AudioPlayer.next();
        }
        return prepareAudioTracks(false);
      };
    }
    if ($("audio-prefetch")) {
      $("audio-prefetch").onclick = function () {
        var prefs = audioPrefsFromUI();
        var btn = $("audio-prefetch");
        if (btn) btn.disabled = true;
        return prepareAudioTracks(prefs.includeDrills).then(function (list) {
          return window.AudioPlayer.prefetch(list, prefs).then(function (res) {
            if (res && res.ok === false) {
              if (btn) btn.disabled = false;
              toast("Tính năng tải sẵn cache hỗ trợ trên bản Android APK");
            }
          });
        }).catch(function () {
          if (btn) btn.disabled = false;
        });
      };
    }

    var onConfigChange = function (rebuildQueue) {
      var prefs = audioPrefsFromUI();
      if ($("audio-order-row")) {
        $("audio-order-row").classList.toggle("hidden", prefs.preset === "target_only");
      }
      if (audioStats) {
        audioStats.prefs = Object.assign({}, audioStats.prefs, prefs);
        saveAudioStats();
      }
      var st = window.AudioPlayer.getState();
      if (rebuildQueue) {
        return prepareAudioTracks(prefs.includeDrills).then(function () {
          if (st && (st.status === "playing" || st.status === "paused")) {
            return startPassiveAudio();
          }
        });
      }
      if (st && (st.status === "playing" || st.status === "paused")) {
        return window.AudioPlayer.updateConfig(prefs, prefs.sleepMinutes);
      }
      renderAudioScreen(st);
      return Promise.resolve();
    };

    if ($("audio-source")) $("audio-source").onchange = function () { return onConfigChange(true); };
    if ($("audio-drills")) $("audio-drills").onchange = function () { return onConfigChange(true); };
    if ($("audio-preset")) $("audio-preset").onchange = function () { return onConfigChange(false); };
    if ($("audio-order")) $("audio-order").onchange = function () { return onConfigChange(false); };
    if ($("audio-target-repeat")) $("audio-target-repeat").onchange = function () { return onConfigChange(false); };
    if ($("audio-speed")) $("audio-speed").onchange = function () { return onConfigChange(false); };
    if ($("audio-repeat")) $("audio-repeat").onchange = function () { return onConfigChange(false); };
    if ($("audio-offline")) $("audio-offline").onchange = function () { return onConfigChange(false); };
    if ($("audio-sleep")) $("audio-sleep").onchange = function () { return onConfigChange(false); };
    if ($("audio-autostage")) {
      $("audio-autostage").onchange = function () {
        var prefs = audioPrefsFromUI();
        if (audioStats) {
          audioStats.prefs = Object.assign({}, audioStats.prefs, prefs);
          saveAudioStats();
        }
      };
    }

    if ($("audio-mini-open")) $("audio-mini-open").onclick = function () { showAudio(false); };
    if ($("audio-mini-toggle")) {
      $("audio-mini-toggle").onclick = function () {
        var st = window.AudioPlayer.getState();
        if (st && (st.status === "playing" || st.status === "loading")) window.AudioPlayer.pause();
        else if (st && st.status === "paused") window.AudioPlayer.resume();
        else startPassiveAudio();
      };
    }
    if ($("audio-mini-stop")) $("audio-mini-stop").onclick = function () { window.AudioPlayer.stop(); };

    if ($("audio-word")) {
      $("audio-word").onclick = function () {
        var st = window.AudioPlayer.getState();
        if (st && st.status === "playing") return;
        var w = $("audio-word").textContent;
        if (w && w !== "—") speak(w, target(), true);
      };
    }
    if ($("audio-ex-target")) {
      $("audio-ex-target").onclick = function () {
        var st = window.AudioPlayer.getState();
        if (st && st.status === "playing") return;
        var ex = String($("audio-ex-target").textContent || "").replace(/^💼\s*/, "").trim();
        if (ex) speak(ex, target(), true);
      };
    }

    if (document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden && window.AudioPlayer) {
          window.AudioPlayer.syncState().then(function (st) {
            if (st && st.openRequested) showAudio(false);
          });
        }
      });
    }
  }

  // ---------------- wiring ----------------
  function findAttrTarget(node, root, attrName) {
    var cur = node;
    var depth = 0;
    while (cur && cur !== root && depth < 5) {
      if (typeof cur.getAttribute === "function") {
        var val = cur.getAttribute(attrName);
        if (val != null) return val;
      }
      cur = cur.parentNode || null;
      depth++;
    }
    return null;
  }

  function wire() {
    // home & unified navigation
    $("startbtn").onclick = function () {
      var ast = window.AudioPlayer ? window.AudioPlayer.getState() : null;
      if (ast && (ast.status === "playing" || ast.status === "paused") && $("audio-screen")) {
        return handoffAudioToStudy();
      }
      showStudy();
      if (idx >= queue.length || sessionDone) { buildQueue(); render(); }
    };
    if ($("session-replay")) $("session-replay").onclick = function () { return restartCurrentSession("home"); };
    if ($("session-next-batch")) $("session-next-batch").onclick = function () { return nextSessionBatch("home"); };
    if ($("study-replay")) $("study-replay").onclick = function () { return restartCurrentSession("study"); };
    if ($("study-next-batch")) $("study-next-batch").onclick = function () { return nextSessionBatch("study"); };
    if ($("nav-home")) $("nav-home").onclick = showHome;
    if ($("nav-study")) {
      $("nav-study").onclick = function () {
        var ast = window.AudioPlayer ? window.AudioPlayer.getState() : null;
        if (ast && (ast.status === "playing" || ast.status === "paused") && $("audio-screen")) {
          return handoffAudioToStudy();
        }
        showStudy();
        if (idx >= queue.length || sessionDone) { buildQueue(); render(); }
      };
    }
    if ($("nav-audio")) $("nav-audio").onclick = function () { return showAudio(false); };
    if ($("nav-search")) {
      $("nav-search").onclick = function () {
        showHome();
        syncBottomNav("search");
        var dsEl = $("dict-search");
        if (dsEl) {
          if (dsEl.scrollIntoView) dsEl.scrollIntoView({ behavior: "smooth", block: "center" });
          try { dsEl.focus(); } catch (e) {}
        }
      };
    }
    $("homebtn").onclick = showHome;
    if ($("undobtn")) $("undobtn").onclick = undoGrade;
    $("onboardok").onclick = function () {
      try { localStorage.setItem("dictlearn_onboard_" + pairKey(), "1"); } catch (e) {}
      $("onboard").classList.add("hidden");
    };
    if ($("setbtn")) {
      $("setbtn").onclick = function () {
        showHome();
        var sc = $("settings-card");
        if (sc) {
          if (sc.scrollIntoView) sc.scrollIntoView({ behavior: "smooth", block: "center" });
          if (sc.classList) {
            sc.classList.add("flash-highlight");
            setTimeout(function () { sc.classList.remove("flash-highlight"); }, 1200);
          }
        }
      };
    }

    // CEFR filter pills
    if ($("cefr-filter")) {
      $("cefr-filter").addEventListener("click", function (e) {
        var lv = findAttrTarget(e && e.target, $("cefr-filter"), "data-level");
        if (!lv) return;
        cefrLevel = lv;
        try { localStorage.setItem("dictlearn_cefr_level", lv); } catch (err) {}
        resetBatchHistory();
        audioPreviewTracks = [];
        audioPreviewIndex = 0;
        buildQueue();
        renderHome();
        if (!$("study").classList.contains("hidden")) render();
      });
    }

    // Offline dictionary search
    var ds = $("dict-search");
    if (ds) {
      ds.addEventListener("input", function () { searchDict(ds.value); });
    }
    if ($("dict-clear")) {
      $("dict-clear").onclick = function () {
        if ($("dict-search")) $("dict-search").value = "";
        searchDict("");
      };
    }
    if ($("dict-results")) {
      $("dict-results").addEventListener("click", function (e) {
        var sp = findAttrTarget(e && e.target, $("dict-results"), "data-search-speak");
        if (sp !== null) {
          speak(sp, target(), true);
          return;
        }
        var cid = findAttrTarget(e && e.target, $("dict-results"), "data-search-study");
        if (cid) openConceptInStudy(cid);
      });
    }

    wireAudio();
    // lang / session / prefs
    var onPairChange = function () {
      var stopAudio = (window.AudioPlayer && window.AudioPlayer.getState().status !== "idle")
        ? window.AudioPlayer.stop()
        : Promise.resolve();
      resetBatchHistory();
      audioPreviewTracks = [];
      audioPreviewIndex = 0;
      audioCardCache = {};
      audioEnrichReq = "";
      searchIndexKey = "";
      searchIndexList = [];
      if ($("dict-search") && $("dict-search").value) {
        $("dict-search").value = "";
        searchDict("");
      }
      stopAudio.then(function () { return loadSrs(); })
        .then(function () { return loadAudioStats(); })
        .then(function () {
          buildQueue();
          if ($("audio-screen") && !$("audio-screen").classList.contains("hidden")) {
            return prepareAudioTracks(false);
          }
          showHome();
          return render();
        });
    };
    $("base").onchange = onPairChange;
    $("target").onchange = onPairChange;
    $("sessionlen").onchange = function () {
      try { localStorage.setItem("dictlearn_session", $("sessionlen").value); } catch (e) {}
      resetBatchHistory();
      audioPreviewTracks = [];
      audioPreviewIndex = 0;
      buildQueue();
      renderHome();
      if (!$("study").classList.contains("hidden")) render();
    };
    $("sndbtn").onclick = function () {
      soundOn = !soundOn;
      $("sndbtn").textContent = soundOn ? "🔊" : "🔇";
      if (!soundOn && window.AudioPlayer) {
        var ast = window.AudioPlayer.getState();
        if (ast && (ast.status === "playing" || ast.status === "loading")) window.AudioPlayer.pause();
      }
      toast(soundOn ? "Đã bật âm thanh" : "Đã tắt âm thanh");
    };
    $("thmbtn").onclick = function () {
      var cur;
      try { cur = localStorage.getItem("dictlearn_theme") || "auto"; } catch (e) { cur = "auto"; }
      var next = cur === "dark" ? "light" : cur === "light" ? "auto" : "dark";
      try { localStorage.setItem("dictlearn_theme", next); } catch (e) {}
      applyTheme(next);
    };
    // grade buttons
    $("b1").onclick = function () { grade("hard"); };
    $("b2").onclick = function () { grade("ok"); };
    $("b3").onclick = function () { grade("good"); };
    // basic card actions
    $("flip").onclick = flipCard;
    // duosub's openSpeechSettings pattern: tapping "Nghe từ" speaks the word;
    // when the device has no voice for the language it toasts a hint and the
    // NEXT tap opens the system TTS settings to install the missing voices.
    $("speak").onclick = function () {
      var w = $("card").dataset.word;
      if (wantSettings && window.TTS && TTS.openSettings) {
        TTS.openSettings();
        wantSettings = false;
        return;
      }
      speak(w, target(), "no-voice-custom").then(function (ok) {
        if (!ok && window.TTS && TTS._last && TTS._last.result === "no-voice") {
          TTS.status().then(function (s) {
            if (s && s.nativeBound) {
              wantSettings = true;
              toast("🔇 Thiết bị chưa có giọng đọc " + target() + " · bấm lần nữa để tải", "bad");
            } else {
              toast("🔇 " + TTS.message(), "bad");
            }
          });
        }
      });
    };
    // practice (from Home + Study shortcuts)
    $("listen").onclick = showListen;
    if ($("study-listen")) $("study-listen").onclick = showListen;
    $("mic").onclick = toggleMic;
    if ($("mic-grant-btn")) {
      $("mic-grant-btn").onclick = function () {
        micOpSeq += 1;
        hideMicPermBox();
        runMicPermissionAndStart(micOpSeq, true);
      };
    }
    if ($("mic-settings-btn")) {
      $("mic-settings-btn").onclick = function () {
        if (window.MicAsr && window.MicAsr.openAppSettings) window.MicAsr.openAppSettings();
      };
    }
    if ($("mic-perm-dismiss")) $("mic-perm-dismiss").onclick = hideMicPermBox;
    if (document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) refreshMicPermissionOnResume();
      });
    }
    var capAppRef = (window.CapBridge && window.CapBridge.getApp) ? window.CapBridge.getApp() : null;
    if (capAppRef && typeof capAppRef.addListener === "function") {
      try {
        capAppRef.addListener("appStateChange", function (s) {
          if (s && s.isActive) refreshMicPermissionOnResume();
        });
      } catch (e) {}
    }
    $("playdrill").onclick = function () { if (drill) speak(drill.s, drill.lang || target(), true); };
    $("fillbtn").onclick = showFill;
    if ($("study-fill")) $("study-fill").onclick = showFill;
    if ($("playfill")) $("playfill").onclick = function () { if (fill && fill.row) speak(fill.row.s, fill.lang || target(), true); };
    $("conjbtn").onclick = showConjugate;
    if ($("study-conj")) $("study-conj").onclick = showConjugate;
    if ($("drillnext")) $("drillnext").onclick = function () { showListen("next"); };
    if ($("fillnext")) $("fillnext").onclick = function () { showFill("next"); };
    if ($("conjnext")) $("conjnext").onclick = function () { showConjugate("next"); };
    if ($("drill-mode-btn")) {
      $("drill-mode-btn").onclick = function () {
        if (!drill) return;
        setDrillMode(drill.mode === "tiles" ? "type" : "tiles", { persist: true, updateNote: true, focusInput: true });
      };
    }
    if ($("drill-reset")) {
      $("drill-reset").onclick = function () { if (drill && drill.resetTiles) drill.resetTiles(); };
    }
    if ($("fill-mode-btn")) {
      $("fill-mode-btn").onclick = function () {
        if (!fill) return;
        setFillMode(fill.mode === "choice" ? "type" : "choice", { persist: true, updateNote: true, focusInput: true });
      };
    }
    $("clearbtn").onclick = hidePanels;
    document.querySelectorAll(".close-panel").forEach(function (b) { b.onclick = hidePanels; });
    // inputs
    $("typed").addEventListener("keydown", function (e) { if (e.key === "Enter") checkTyped(); });
    $("drillcheck").onclick = checkTyped;
    $("fill-input").addEventListener("keydown", function (e) { if (e.key === "Enter") checkFill(); });
    $("fillcheck").onclick = checkFill;

    // --- TTS self-test (Settings → "Kiểm tra"): reveals which layer can
    //     produce audio on THIS device (native plugin reachable? how many
    //     engines installed? Google resting? last speak result?).
    var ttsbtn = $("ttstestbtn");
    var ttsy = $("ttstest");
    var runTtsTest = function () {
      if (!window.TTS || !TTS.status) { if (ttsy) ttsy.textContent = "TTS module chưa nạp."; return; }
      var lang = target();
      if (ttsbtn) ttsbtn.disabled = true;
      if (ttsy) ttsy.textContent = "Đang kiểm tra…";
      TTS.speak(sampleWordFor(lang), lang).then(function () {
        return TTS.status().then(function (s) {
          if (!ttsy) return;
          var L = [];
          L.push("Engine " + lang + ": " + (s.last && s.last.ok ? "✅ " + s.last.engine : "❌ " + (s.last ? s.last.result : "none")));
          if (s.nativeBound) {
            var engInfo = (s.engines || 0) + " engine(s)" + (s.engineNames ? " (" + s.engineNames + ")" : "");
            var netInfo = (s.networkOnline === false ? " · Offline" : " · Online");
            L.push("Native plugin: ✅ · " + engInfo + netInfo + (s.googleResting ? " · Google nghỉ" : "") + " · cache " + (s.cacheCount || 0));
          } else if (s.hasCapacitor) {
            L.push("Native plugin: ❌ Capacitor có, DictTTS không khả dụng");
          } else {
            L.push("Native plugin: ❌ không có Capacitor (chạy web)");
          }
          L.push("Lần cuối: " + ((s.last && s.last.detail) || "—"));
          ttsy.textContent = L.join("\n");
          ttsy.style.whiteSpace = "pre-line";
          if (!(s.last && s.last.ok) && !(s.last && s.last.cancelled)) {
            toast("TTS chưa phát được — xem chi tiết", "bad");
            if (s.nativeBound && s.last && s.last.result === "no-voice" && TTS.openSettings) TTS.openSettings();
          }
        });
      }).then(function () {
        if (ttsbtn) ttsbtn.disabled = false;
      }, function () {
        if (ttsbtn) ttsbtn.disabled = false;
      });
    };
    if (ttsbtn) ttsbtn.onclick = runTtsTest;

    // --- M3.2 swipe gestures + tap-to-flip + interactive example audio ---
    var card = $("card");
    var startX = 0, startY = 0, swiping = false, suppressCardClickUntil = 0;
    card.addEventListener("pointerdown", function (e) {
      if (sessionDone) return;
      if (e && e.target && (findAttrTarget(e.target, card, "data-ex-speak") || findAttrTarget(e.target, card, "data-done-act"))) return;
      startX = e.clientX; startY = e.clientY; swiping = true;
      card.classList.add("swiping");
      try { card.setPointerCapture(e.pointerId); } catch (err) {}
    });
    card.addEventListener("pointermove", function (e) {
      if (!swiping) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      card.style.transform = "translate(" + dx + "px," + dy + "px)";
      card.style.opacity = String(1 - Math.min(Math.abs(dx) / 300, 0.5));
    });
    card.addEventListener("pointerup", function (e) {
      if (!swiping) return;
      swiping = false;
      card.classList.remove("swiping");
      card.style.transform = "";
      card.style.opacity = "";
      var dx = e.clientX - startX, dy = e.clientY - startY;
      var TH = 80;
      if (Math.abs(dx) >= 12 || Math.abs(dy) >= 12) suppressCardClickUntil = Date.now() + 260;
      if (sessionDone) return;
      if (dx > TH && Math.abs(dx) > Math.abs(dy)) grade("good");
      else if (dx < -TH && Math.abs(dx) > Math.abs(dy)) grade("hard");
      else if (dy > TH && Math.abs(dy) > Math.abs(dx)) grade("ok");
    });
    card.addEventListener("pointercancel", function () {
      swiping = false;
      card.classList.remove("swiping");
      card.style.transform = "";
      card.style.opacity = "";
    });
    card.addEventListener("click", function (e) {
      var doneAct = findAttrTarget(e && e.target, card, "data-done-act");
      if (doneAct) {
        if (doneAct === "hard" && sessionHardIds.length) {
          buildQueue(sessionHardIds.slice());
          render();
        } else if (doneAct === "next") {
          nextSessionBatch("study");
        } else if (doneAct === "replay") {
          restartCurrentSession("study");
        } else if (doneAct === "audio") {
          handoffStudyToAudio();
        } else if (doneAct === "home") {
          showHome();
        }
        return;
      }
      if (findAttrTarget(e && e.target, card, "data-ex-speak")) {
        if (cardExTarget) speak(cardExTarget, cardExLang || target(), true);
        return;
      }
      if (!sessionDone && Date.now() > suppressCardClickUntil) {
        flipCard();
      }
    });

    // --- M3.3 Android back press ---
    var lastBack = 0;
    var handleBack = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      var openPanelEl = document.querySelector(".panel:not(.hidden)");
      if (openPanelEl) { hidePanels(); return; }
      if (!$("study").classList.contains("hidden")) { showHome(); return; }
      if ($("audio-screen") && !$("audio-screen").classList.contains("hidden")) { showHome(); return; }
      // on Home: 2-press confirm
      var now = Date.now();
      if (now - lastBack < 2500) {
        lastBack = 0;
        var hint = $("back-hint");
        if (hint) hint.classList.add("hidden");
        var capApp = (window.CapBridge && window.CapBridge.getApp) ? window.CapBridge.getApp() : null;
        if (capApp && capApp.exitApp) capApp.exitApp();
      } else {
        lastBack = now;
        var h2 = $("back-hint");
        if (h2) {
          h2.classList.remove("hidden");
          setTimeout(function () { h2.classList.add("hidden"); }, 2500);
        }
      }
    };
    if (window.CapBridge && window.CapBridge.onBackButton) {
      window.CapBridge.onBackButton(handleBack);
    } else if (document.addEventListener) {
      document.addEventListener("backbutton", handleBack);
    }
  }

  wire();
  boot().catch(function (err) {
    var b = $("boot");
    if (b) b.innerHTML = '<div style="color:var(--bad-fg)">Không mở được kho từ: ' + err + "</div>";
  });
})();
