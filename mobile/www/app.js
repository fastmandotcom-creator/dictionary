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
    if (c.due > 0) {
      sb.textContent = "Học " + c.due + " từ đến hạn" + lvTag + " →";
    } else if (c.total === 0) {
      sb.textContent = "Bắt đầu học " + sessionLen() + " từ mới" + lvTag + " →";
    } else {
      sb.textContent = "Học " + sessionLen() + " từ tiếp theo" + lvTag + " →";
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
    if ($("session-replay")) $("session-replay").textContent = "🔄 Học lại " + n + " từ này";
    if ($("session-next-batch")) $("session-next-batch").textContent = "⏭ " + nextN + " từ tiếp theo";
    if ($("study-replay")) $("study-replay").textContent = "🔄 Học lại " + n + " từ";
    if ($("study-next-batch")) $("study-next-batch").textContent = "⏭ " + nextN + " từ tiếp";
    if ($("audio-replay")) $("audio-replay").textContent = "🔄 Nghe lại " + n + " từ";
    if ($("audio-next-batch")) $("audio-next-batch").textContent = "⏭ " + nextN + " từ tiếp";
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
    if (!audioStats) {
      sub.textContent = queue.length
        ? ("Cùng " + queue.length + " từ của buổi học · phát cả khi tắt màn hình")
        : "Nghe nghĩa → từ học ×2 → ví dụ song ngữ cả khi tắt màn hình";
      return;
    }
    var heardToday = Object.keys(audioStats.todayHeardIds || {}).length;
    if (queue.length && idx > 0 && idx < queue.length && !sessionDone) {
      sub.textContent = "Tiếp tục từ vị trí " + (idx + 1) + " / " + queue.length + " · phát ngầm song ngữ";
    } else if (heardToday > 0) {
      sub.textContent = "Hôm nay đã nghe " + heardToday + " từ · chạm để nghe tiếp";
    } else {
      sub.textContent = queue.length
        ? ("Cùng " + queue.length + " từ của buổi học · phát cả khi tắt màn hình")
        : "Nghe nghĩa → từ học ×2 → ví dụ song ngữ cả khi tắt màn hình";
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
      shownIdx + " / " + queue.length +
      (c.due ? " · " + c.due + " từ đến hạn" : "");
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
          '<button type="button" class="' + (sessionHardIds.length ? "ghost" : "primary") + '" data-done-act="next">⏭ Học ' + sessionLen() + " từ tiếp theo →</button>" +
          '<button type="button" class="ghost" data-done-act="replay">🔄 Học lại ' + Math.max(1, queue.length) + " từ vừa rồi</button>" +
          '<button type="button" class="ghost" data-done-act="audio">🎧 Nghe lại buổi học này</button>' +
          '<button type="button" class="ghost" data-done-act="home">← Về trang chủ</button>' +
        "</div>" +
      "</div>";
    $("progress").textContent = "Hoàn tất buổi · " + fmt(c.total) + "/" + fmt(concepts.length) + " từ";
    if ($("study-bar")) $("study-bar").style.width = "100%";
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
    var home = $("home"), study = $("study");
    if (home && study && !home.classList.contains("hidden")) {
      setActiveScreen("study");
    }
  }

  function hidePanels() {
    if (micListening) { try { window.MicAsr && MicAsr.stop(); } catch (e) {} micListening = false; }
    var micBtn = $("mic");
    if (micBtn) micBtn.textContent = "🎤 Mic";
    if ($("drill")) $("drill").classList.add("hidden");
    if ($("fillbox")) $("fillbox").classList.add("hidden");
    if ($("conjbox")) $("conjbox").classList.add("hidden");
    drill = null; fill = null; conj = null;
    sessionStats.practice = 0;
  }
  function openPanel(id) {
    hidePanels();
    $(id).classList.remove("hidden");
    var p = $(id);
    if (p) { var inp = p.querySelector('input[type="text"]'); if (inp && inp.focus) setTimeout(function(){ try { inp.focus(); } catch (e) {} }, 60); }
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

  // ---------------- M2.2a listen & write ----------------
  function showListen() {
    var lang = practiceLang();
    var ready = (lang === "en") ? withDrills("listen", function () {}) : Promise.resolve();
    return ready.then(function () {
      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("drill");
      var rows = (lang === "en") ? (drills[id] || []) : [];
      var note = $("drill-note");
      if (rows.length) {
        drill = { s: rows[0].s, h: rows[0].h, lang: "en" };
        $("typed").value = "";
        note.textContent = "Nghe câu rồi gõ lại chính xác (không cần hoa/thấp).";
        note.className = "panel-note";
        speak(drill.s, "en");
        return;
      }
      return loadPracticePairData(id).then(function (d) {
        if (!d.sentence) {
          note.textContent = "Từ này chưa có câu ví dụ offline — thử một từ khác.";
          note.className = "panel-note";
          return;
        }
        drill = { s: d.sentence, h: d.hint, lang: d.lang };
        $("typed").value = "";
        note.textContent = "Nghe câu rồi gõ lại chính xác" + (d.hint ? " · Gợi ý: " + d.hint : "");
        note.className = "panel-note";
        speak(drill.s, d.lang);
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
      ? ("✅ Đúng. Ghi nhớ tốt!" + (drill.h ? " (" + drill.h + ")" : ""))
      : ("Đáp án: " + drill.s + extra + (drill.h ? " · " + drill.h : ""));
    note.className = "panel-note " + (ok ? "ok" : "bad");
    sessionStats.correct += ok ? 1 : 0;
  }

  // ---------------- M2.1 mic ASR ----------------
  var micListening = false;
  function toggleMic() {
    if (!drill) showListen();
    var note = $("drill-note");
    if (!window.MicAsr || !MicAsr.supported) {
      note.textContent = "Thiết bị này không hỗ trợ nhận giọng nói — gõ tay nhé.";
      note.className = "panel-note";
      return;
    }
    if (micListening) {
      MicAsr.stop();
      micListening = false;
      $("mic").textContent = "🎤 Mic";
      checkTyped();
      return;
    }
    micListening = true;
    $("mic").textContent = "⏹ Dừng";
    $("typed").value = "";
    note.textContent = "Đang nghe… hãy nói câu vừa nghe được.";
    note.className = "panel-note";
    MicAsr.start($("typed"), target(), function (ev) {
      if (ev.error) {
        micListening = false;
        $("mic").textContent = "🎤 Mic";
        note.textContent = ev.error;
        note.className = "panel-note";
      } else if (ev.final) {
        micListening = false;
        $("mic").textContent = "🎤 Mic";
        checkTyped();
      }
    });
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

  function showFill() {
    var lang = practiceLang();
    var ready = (lang === "en") ? withDrills("fill", function () {}) : Promise.resolve();
    return ready.then(function () {
      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("fillbox");
      var rows = (lang === "en") ? (drills[id] || []).filter(function (r) { return r.s && r.sf; }) : [];
      var note = $("fill-note");
      if (rows.length) {
        var row = rows[Math.floor(Math.random() * rows.length)];
        var sf = row.sf;
        var re = new RegExp(sf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        if (!re.test(row.s)) { showListen(); return; }
        var blanked = row.s.replace(re, "____");
        fill = { row: row, answer: sf, lang: "en" };
        $("fill-sent").textContent = blanked;
        $("fill-input").value = "";
        note.textContent = "Nghe câu rồi gõ từ còn thiếu (vị trí gạch ngang)." + (row.h ? " · " + row.h : "");
        note.className = "panel-note";
        speak(row.s, "en");
        return;
      }
      return loadPracticePairData(id).then(function (d) {
        var token = pickBlankTarget(d.sentence, d.word);
        if (!token || d.sentence === d.word) { showListen(); return; }
        var re2 = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        if (!re2.test(d.sentence)) { showListen(); return; }
        var blanked2 = d.sentence.replace(re2, "____");
        fill = { row: { s: d.sentence, h: d.hint }, answer: token, lang: d.lang };
        $("fill-sent").textContent = blanked2;
        $("fill-input").value = "";
        note.textContent = "Nghe câu rồi điền từ còn thiếu" + (d.hint ? " · Nghĩa: " + d.hint : "");
        note.className = "panel-note";
        speak(d.sentence, d.lang);
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
      : ("Đáp án: " + fill.answer + (fill.row && fill.row.h ? " · " + fill.row.h : ""));
    note.className = "panel-note " + (ok ? "ok" : "bad");
    sessionStats.correct += ok ? 1 : 0;
  }

  // ---------------- M2.3b conjugate + multilingual context quiz ----------------
  function renderConjChoices(choices, winner, lang) {
    conj = { correct: winner, lang: lang };
    var box = $("conj-opts");
    box.innerHTML = "";
    var note = $("conj-note");
    note.textContent = "Chọn 1 đáp án đúng bên dưới:";
    note.className = "panel-note";
    choices.forEach(function (r) {
      var label = document.createElement("label");
      label.className = "conj-opt";
      var inp = document.createElement("input");
      inp.type = "radio";
      inp.name = "conj";
      inp.value = r.s;
      inp.addEventListener("change", function () {
        var ok = (inp.value === conj.correct.s);
        var nn = $("conj-note");
        nn.textContent = ok ? ("✅ Đúng: " + conj.correct.s) : ("Đáp án: " + conj.correct.s + (conj.correct.h ? " · " + conj.correct.h : ""));
        nn.className = "panel-note " + (ok ? "ok" : "bad");
        sessionStats.correct += ok ? 1 : 0;
        if (ok) speak(conj.correct.s, lang);
      });
      label.appendChild(inp);
      label.appendChild(document.createTextNode(" " + r.s));
      box.appendChild(label);
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
      for (var step = 3; step < concepts.length && distractors.length < 2; step += 7) {
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

  function showConjugate() {
    var lang = practiceLang();
    var ready = (lang === "en") ? withDrills("conj", function () {}) : Promise.resolve();
    return ready.then(function () {
      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("conjbox");
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
    var distractors = opts.filter(function (r) { return r !== winner; }).slice(0, 2);
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
      if (playBtn) playBtn.textContent = "▶ Nghe";
      if ($("audio-grade-row")) $("audio-grade-row").classList.add("hidden");
      return;
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
          (view.heardCount ? " · Đã nghe " + view.heardCount : "") + sleepTxt;
      } else {
        prog.textContent = "Danh sách " + view.total + " từ · Vị trí " + (view.index + 1);
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
      else playBtn.textContent = "▶ Nghe";
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
    $("playdrill").onclick = function () { if (drill) speak(drill.s, drill.lang || target(), true); };
    $("fillbtn").onclick = showFill;
    if ($("study-fill")) $("study-fill").onclick = showFill;
    if ($("playfill")) $("playfill").onclick = function () { if (fill && fill.row) speak(fill.row.s, fill.lang || target(), true); };
    $("conjbtn").onclick = showConjugate;
    if ($("study-conj")) $("study-conj").onclick = showConjugate;
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
