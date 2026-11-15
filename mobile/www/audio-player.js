/* dict-learn Passive Audio Learning Controller & Playlist Builder.
 *
 * Orchestrates continuous bilingual background listening:
 *   word (target) -> recall pause -> meaning (base) -> bilingual examples -> target anchor
 *
 * Single Source of Truth runtime strategy:
 *   - On Android APK: delegates playback + loop + MediaSession + WakeLock + AudioFocus
 *     to native AudioLearningService via window.TTS.audio (survives screen off / Doze).
 *   - On Web / PWA fallback: runs matching cadence via TTS.speak(..., { awaitEnd: true })
 *     and wires navigator.mediaSession for browser/lock-screen controls.
 *
 * Persistence uses a dedicated key `dict_audio_stats_v1_<base>_<target>` in SrsStore
 * so passive exposure never corrupts active Flashcard SRS intervals.
 */
(function () {
  if (typeof window === "undefined") return;

  var DEFAULT_PREFS = {
    source: "due",         // "due" | "fresh" | "learned" | "mix"
    limit: 30,             // tracks per queue
    preset: "deep",        // "deep" | "quick" | "target_only"
    order: "base_first",   // "base_first" (default: primary first) | "target_first"
    targetRepeat: 2,       // default: speak target language twice (1..3)
    speed: 1.0,            // 0.85 | 1.0 | 1.15
    repeatMode: "none",    // "none" | "one" | "all"
    includeDrills: false,
    preferOffline: false,
    sleepMinutes: 0
  };

  function todayISO() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function normalizeOrder(raw) {
    return String(raw || "").toLowerCase() === "target_first" ? "target_first" : "base_first";
  }

  function clampTargetRepeat(raw) {
    var n = parseInt(raw, 10);
    if (!isFinite(n)) return DEFAULT_PREFS.targetRepeat;
    return Math.max(1, Math.min(3, n));
  }

  function clampSpeed(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 1.0;
    return Math.max(0.65, Math.min(1.5, Math.round(n * 100) / 100));
  }

  function scalePause(baseMs, speed) {
    var div = Math.max(0.85, Math.min(1.25, clampSpeed(speed)));
    return Math.max(300, Math.min(2500, Math.round(baseMs / div)));
  }

  function isCleanDrillRow(row) {
    if (!row || !row.s || !row.h) return false;
    var s = String(row.s).trim();
    var h = String(row.h).trim();
    if (!s || !h || s.length > 180 || h.length > 180) return false;
    if (/\b(?:tonight|tomorrow|yesterday)\b/i.test(h)) return false;
    return true;
  }

  function pickDrills(rows) {
    if (!rows || !rows.length) return [];
    var clean = rows.filter(isCleanDrillRow);
    if (!clean.length) return [];
    var out = [];
    var seenPol = {};
    for (var i = 0; i < clean.length && out.length < 2; i++) {
      var r = clean[i];
      if (!seenPol[r.p || ""]) {
        seenPol[r.p || ""] = true;
        out.push({ s: String(r.s).trim(), h: String(r.h).trim() });
      }
    }
    for (var j = 0; j < clean.length && out.length < 2; j++) {
      var r2 = clean[j];
      var s2 = String(r2.s).trim();
      if (!out.some(function (x) { return x.s === s2; })) {
        out.push({ s: s2, h: String(r2.h).trim() });
      }
    }
    return out;
  }

  function cefrForIndex(idx) {
    var r = Number(idx);
    if (!isFinite(r) || r < 2000) return "A1";
    if (r < 4000) return "A2";
    if (r < 6000) return "B1";
    if (r < 8000) return "B2";
    if (r < 10000) return "C1";
    return "C2";
  }

  /** Pure playlist builder across any language pair + optional EN-VI drills. */
  function buildPlaylist(opts) {
    opts = opts || {};
    var concepts = opts.concepts || [];
    var baseData = opts.baseData || { w: {}, e: {} };
    var targetData = opts.targetData || { w: {}, e: {}, ro: {}, ipa: {} };
    var drillsMap = opts.drills || {};
    var srs = opts.srs || {};
    var mastered = opts.mastered || {};
    var source = opts.source || "due";
    var levelFilter = opts.levelFilter || "all";
    var baseLang = opts.baseLang || "vi";
    var targetLang = opts.targetLang || "en";
    var limit = Math.max(5, Math.min(200, Number(opts.limit) || 30));
    var today = opts.today || todayISO();
    var attachDrills = (baseLang === "vi" && targetLang === "en");

    var rankById = {};
    var due = [], hard = [], okList = [], goodList = [], fresh = [];
    function collect(applyLevel) {
      due = []; hard = []; okList = []; goodList = []; fresh = [];
      for (var i = 0; i < concepts.length; i++) {
        var cid = concepts[i];
        rankById[cid] = i;
        if (mastered[cid]) continue;
        if (!targetData.w || !targetData.w[cid]) continue;
        if (applyLevel && levelFilter && levelFilter !== "all" && cefrForIndex(i) !== levelFilter) continue;
        var rec = srs[cid];
        if (!rec) {
          fresh.push(cid);
        } else {
          if (rec.due && rec.due <= today) due.push(cid);
          if (rec.grade === "hard") hard.push(cid);
          else if (rec.grade === "ok") okList.push(cid);
          else goodList.push(cid);
        }
      }
    }
    collect(true);
    if (levelFilter && levelFilter !== "all" && !due.length && !hard.length && !okList.length && !goodList.length && !fresh.length) {
      collect(false);
    }

    var seen = {};
    var ordered = [];
    function pushList(arr) {
      for (var k = 0; k < arr.length && ordered.length < limit; k++) {
        var id = arr[k];
        if (!seen[id]) {
          seen[id] = true;
          ordered.push(id);
        }
      }
    }

    if (source === "fresh") {
      pushList(fresh);
      if (!ordered.length) pushList(due.concat(hard, okList, goodList));
    } else if (source === "learned") {
      pushList(due);
      pushList(hard);
      pushList(okList);
      pushList(goodList);
      if (!ordered.length) pushList(fresh);
    } else if (source === "mix") {
      var pool = due.concat(hard, okList, fresh.slice(0, limit * 3), goodList);
      // deduplicate before shuffling
      var uniq = [];
      for (var p = 0; p < pool.length; p++) {
        if (!seen[pool[p]]) {
          seen[pool[p]] = true;
          uniq.push(pool[p]);
        }
      }
      for (var sIdx = uniq.length - 1; sIdx > 0; sIdx--) {
        var rIdx = Math.floor((opts.rng ? opts.rng() : Math.random()) * (sIdx + 1));
        var tmp = uniq[sIdx];
        uniq[sIdx] = uniq[rIdx];
        uniq[rIdx] = tmp;
      }
      ordered = uniq.slice(0, limit);
    } else {
      // "due" (default): overdue SRS -> hard -> ok -> fresh words to fill session
      pushList(due);
      pushList(hard);
      pushList(okList);
      pushList(fresh);
    }

    return ordered.map(function (id) {
      return {
        id: id,
        level: cefrForIndex(rankById[id] || 0),
        word: String((targetData.w && targetData.w[id]) || id),
        meaning: String((baseData.w && baseData.w[id]) || ""),
        ro: String((targetData.ro && targetData.ro[id]) || ""),
        ipa: String((targetData.ipa && targetData.ipa[id]) || ""),
        exTarget: String((targetData.e && targetData.e[id]) || ""),
        exBase: String((baseData.e && baseData.e[id]) || ""),
        targetLang: targetLang,
        baseLang: baseLang,
        drills: attachDrills ? pickDrills(drillsMap[id]) : []
      };
    });
  }

  function appendPairSteps(out, p) {
    if (!p.targetText) return;
    var hasPrimary = !!(p.primaryText && p.primaryText.toLowerCase() !== p.targetText.toLowerCase());
    var repeatGap = scalePause(p.isWordBlock ? 750 : 700, p.speed);
    var blockEnd = scalePause(p.isWordBlock ? 1250 : 1100, p.speed);
    var afterPrimaryCue = scalePause(p.isWordBlock ? 650 : 550, p.speed);
    var recallBeforePrimary = scalePause(p.isWordBlock ? 1050 : 600, p.speed);

    if (!hasPrimary) {
      for (var i = 0; i < p.repeatCount; i++) {
        out.push({
          role: i === 0 ? p.targetFirstRole : p.targetRepeatRole,
          text: p.targetText,
          lang: p.targetLang,
          pauseAfterMs: i < p.repeatCount - 1 ? repeatGap : blockEnd
        });
      }
      return;
    }

    if (p.order === "base_first") {
      out.push({ role: p.primaryRole, text: p.primaryText, lang: p.primaryLang, pauseAfterMs: afterPrimaryCue });
      for (var j = 0; j < p.repeatCount; j++) {
        out.push({
          role: j === 0 ? p.targetFirstRole : p.targetRepeatRole,
          text: p.targetText,
          lang: p.targetLang,
          pauseAfterMs: j < p.repeatCount - 1 ? repeatGap : blockEnd
        });
      }
      return;
    }

    // target_first: expose target first, hold recall gap before primary, then anchor on final repeat
    if (p.repeatCount <= 1) {
      out.push({ role: p.targetFirstRole, text: p.targetText, lang: p.targetLang, pauseAfterMs: recallBeforePrimary });
      out.push({ role: p.primaryRole, text: p.primaryText, lang: p.primaryLang, pauseAfterMs: blockEnd });
      return;
    }

    var preCount = p.repeatCount - 1;
    for (var k = 0; k < preCount; k++) {
      out.push({
        role: k === 0 ? p.targetFirstRole : p.targetRepeatRole,
        text: p.targetText,
        lang: p.targetLang,
        pauseAfterMs: k < preCount - 1 ? repeatGap : recallBeforePrimary
      });
    }
    out.push({ role: p.primaryRole, text: p.primaryText, lang: p.primaryLang, pauseAfterMs: scalePause(550, p.speed) });
    out.push({ role: p.targetRepeatRole, text: p.targetText, lang: p.targetLang, pauseAfterMs: blockEnd });
  }

  /** Pure web step builder matching AudioQueueModels.buildSteps in Java. */
  function buildSteps(item, cfg) {
    var out = [];
    if (!item || !item.word) return out;
    cfg = cfg || DEFAULT_PREFS;
    var preset = cfg.preset || "deep";
    var speed = clampSpeed(cfg.speed);
    var order = preset === "target_only" ? "target_first" : normalizeOrder(cfg.order);
    var repeatCount = clampTargetRepeat(cfg.targetRepeat);
    var includePrimary = preset !== "target_only";
    var tLang = item.targetLang || "en";
    var bLang = item.baseLang || "vi";

    appendPairSteps(out, {
      primaryText: includePrimary ? item.meaning : "",
      primaryRole: "meaning",
      primaryLang: bLang,
      targetText: item.word,
      targetFirstRole: "word",
      targetRepeatRole: "repeat",
      targetLang: tLang,
      order: order,
      repeatCount: repeatCount,
      speed: speed,
      isWordBlock: true
    });

    if (preset === "quick") return out;

    if (item.exTarget) {
      appendPairSteps(out, {
        primaryText: includePrimary ? item.exBase : "",
        primaryRole: "ex_base",
        primaryLang: bLang,
        targetText: item.exTarget,
        targetFirstRole: "ex_target",
        targetRepeatRole: "ex_target",
        targetLang: tLang,
        order: order,
        repeatCount: repeatCount,
        speed: speed,
        isWordBlock: false
      });
    }

    if (cfg.includeDrills && item.drills) {
      for (var d = 0; d < Math.min(2, item.drills.length); d++) {
        var row = item.drills[d];
        if (row.s && row.s !== item.exTarget) {
          appendPairSteps(out, {
            primaryText: includePrimary ? row.h : "",
            primaryRole: "drill_base",
            primaryLang: bLang,
            targetText: row.s,
            targetFirstRole: "drill_target",
            targetRepeatRole: "drill_target",
            targetLang: tLang,
            order: order,
            repeatCount: repeatCount,
            speed: speed,
            isWordBlock: false
          });
        }
      }
    }
    return out;
  }

  function statsKey(baseLang, targetLang) {
    return "dict_audio_stats_v1_" + (baseLang || "vi") + "_" + (targetLang || "en");
  }

  function emptyStats() {
    return {
      date: todayISO(),
      todayHeardIds: {},
      totalHeard: 0,
      todaySec: 0,
      cursorId: "",
      mastered: {},
      prefs: Object.assign({}, DEFAULT_PREFS)
    };
  }

  function loadStats(baseLang, targetLang) {
    var key = statsKey(baseLang, targetLang);
    var p = (window.SrsStore && window.SrsStore.get)
      ? window.SrsStore.get(key)
      : Promise.resolve((function () {
          try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { return {}; }
        })());
    return p.then(function (raw) {
      var st = Object.assign(emptyStats(), raw || {});
      st.prefs = Object.assign({}, DEFAULT_PREFS, st.prefs || {});
      st.todayHeardIds = st.todayHeardIds || {};
      st.mastered = st.mastered || {};
      var t = todayISO();
      if (st.date !== t) {
        st.date = t;
        st.todayHeardIds = {};
        st.todaySec = 0;
      }
      return st;
    }, function () { return emptyStats(); });
  }

  function saveStats(baseLang, targetLang, stats) {
    var key = statsKey(baseLang, targetLang);
    if (window.SrsStore && window.SrsStore.set) {
      return window.SrsStore.set(key, stats).catch(function () {});
    }
    try { localStorage.setItem(key, JSON.stringify(stats)); } catch (e) {}
    return Promise.resolve();
  }

  // ---------------- Controller Singleton ----------------
  var tracks = [];
  var trackById = {};
  var cfg = Object.assign({}, DEFAULT_PREFS);
  var listeners = [];
  var prefetchListeners = [];
  var nativeBound = false;
  var unsubNativeState = null;
  var unsubNativePrefetch = null;
  var lastCompletedSeq = 0;
  var onTrackHeardCb = null;

  // Web fallback sequencer state
  var webRunEpoch = 0;
  var webSleepDeadline = 0;
  var webPauseTimer = null;
  var webState = {
    status: "idle",
    index: 0,
    total: 0,
    conceptId: "",
    word: "",
    meaning: "",
    ro: "",
    ipa: "",
    exTarget: "",
    exBase: "",
    stepRole: "",
    stepText: "",
    stepLang: "",
    preset: DEFAULT_PREFS.preset,
    order: DEFAULT_PREFS.order,
    targetRepeat: DEFAULT_PREFS.targetRepeat,
    speed: DEFAULT_PREFS.speed,
    repeatMode: DEFAULT_PREFS.repeatMode,
    includeDrills: DEFAULT_PREFS.includeDrills,
    preferOffline: DEFAULT_PREFS.preferOffline,
    sleepRemainingMs: 0,
    heardCount: 0,
    completedSeq: 0,
    lastCompletedConceptId: "",
    error: "",
    nativeBackend: false
  };

  function hasNativeAudio() {
    return !!(window.TTS && window.TTS.audio && window.TTS.audio.available && window.TTS.audio.available());
  }

  function setTracksCache(list) {
    tracks = list || [];
    trackById = {};
    for (var i = 0; i < tracks.length; i++) {
      trackById[tracks[i].id] = tracks[i];
    }
  }

  function enrichState(raw) {
    var s = Object.assign({}, webState, raw || {});
    var cur = (s.conceptId && trackById[s.conceptId]) || tracks[s.index] || null;
    if (cur) {
      s.ro = cur.ro || "";
      s.ipa = cur.ipa || "";
      s.exTarget = cur.exTarget || "";
      s.exBase = cur.exBase || "";
      if (!s.word) s.word = cur.word;
      if (!s.meaning) s.meaning = cur.meaning;
    }
    s.nativeBackend = hasNativeAudio();
    return s;
  }

  function emitState(snap) {
    webState = enrichState(snap);
    if (webState.completedSeq && webState.completedSeq > lastCompletedSeq) {
      lastCompletedSeq = webState.completedSeq;
      if (webState.lastCompletedConceptId && typeof onTrackHeardCb === "function") {
        onTrackHeardCb(webState.lastCompletedConceptId, webState);
      }
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](webState); } catch (e) {}
    }
  }

  function wireNativeEvents() {
    if (!hasNativeAudio() || nativeBound) return;
    nativeBound = true;
    unsubNativeState = window.TTS.audio.onState(function (snap) {
      emitState(snap);
    });
    unsubNativePrefetch = window.TTS.audio.onPrefetch(function (ev) {
      for (var i = 0; i < prefetchListeners.length; i++) {
        try { prefetchListeners[i](ev); } catch (e) {}
      }
    });
  }

  function updateWebMediaSession(snap) {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    try {
      var ms = navigator.mediaSession;
      if (typeof window.MediaMetadata === "function") {
        ms.metadata = new window.MediaMetadata({
          title: snap.word || "dict-learn",
          artist: snap.meaning || "Nghe thụ động",
          album: snap.total ? ("Từ " + (snap.index + 1) + "/" + snap.total) : "Nghe thụ động"
        });
      }
      ms.playbackState = snap.status === "playing" ? "playing" : (snap.status === "paused" ? "paused" : "none");
      ms.setActionHandler("play", function () { AudioPlayer.resume(); });
      ms.setActionHandler("pause", function () { AudioPlayer.pause(); });
      ms.setActionHandler("nexttrack", function () { AudioPlayer.next(); });
      ms.setActionHandler("previoustrack", function () { AudioPlayer.prev(); });
      ms.setActionHandler("stop", function () { AudioPlayer.stop(); });
    } catch (e) {}
  }

  function clearWebTimers() {
    if (webPauseTimer) {
      clearTimeout(webPauseTimer);
      webPauseTimer = null;
    }
  }

  function sleepWait(ms, epochAtStart) {
    return new Promise(function (resolve) {
      if (!ms || ms <= 0) { resolve(true); return; }
      clearWebTimers();
      webPauseTimer = setTimeout(function () {
        webPauseTimer = null;
        resolve(webRunEpoch === epochAtStart && webState.status === "playing");
      }, ms);
    });
  }

  function runWebLoop(startIdx, epochAtStart) {
    var curIdx = Math.max(0, Math.min(startIdx, tracks.length - 1));
    var stepIdx = 0;

    function nextTick() {
      if (webRunEpoch !== epochAtStart || webState.status !== "playing") return;
      if (!tracks.length) {
        emitState({ status: "idle", index: 0, total: 0 });
        updateWebMediaSession(webState);
        return;
      }
      var item = tracks[curIdx];
      var steps = buildSteps(item, cfg);
      if (!steps.length || stepIdx >= steps.length) {
        // Track completed
        var cSeq = (webState.completedSeq || 0) + 1;
        var hCount = (webState.heardCount || 0) + 1;
        emitState({
          heardCount: hCount,
          completedSeq: cSeq,
          lastCompletedConceptId: item.id
        });
        if (webSleepDeadline > 0 && Date.now() >= webSleepDeadline) {
          webSleepDeadline = 0;
          webRunEpoch++;
          emitState({ status: "paused", stepRole: "", stepText: "", stepLang: "", sleepRemainingMs: 0 });
          updateWebMediaSession(webState);
          return;
        }
        stepIdx = 0;
        if (cfg.repeatMode === "one") {
          // stay on curIdx
        } else if (curIdx + 1 < tracks.length) {
          curIdx++;
        } else if (cfg.repeatMode === "all") {
          curIdx = 0;
        } else {
          curIdx = 0;
          webRunEpoch++;
          emitState({ status: "paused", index: 0, conceptId: tracks[0].id, word: tracks[0].word, meaning: tracks[0].meaning, stepRole: "", stepText: "", stepLang: "" });
          updateWebMediaSession(webState);
          return;
        }
        nextTick();
        return;
      }

      var step = steps[stepIdx];
      emitState({
        status: "playing",
        index: curIdx,
        total: tracks.length,
        conceptId: item.id,
        word: item.word,
        meaning: item.meaning,
        stepRole: step.role,
        stepText: step.text,
        stepLang: step.lang,
        preset: cfg.preset,
        order: cfg.order,
        targetRepeat: cfg.targetRepeat,
        speed: cfg.speed,
        repeatMode: cfg.repeatMode,
        includeDrills: cfg.includeDrills,
        preferOffline: cfg.preferOffline,
        sleepRemainingMs: webSleepDeadline > 0 ? Math.max(0, webSleepDeadline - Date.now()) : 0,
        error: ""
      });
      updateWebMediaSession(webState);

      var p = (window.TTS && window.TTS.speak)
        ? window.TTS.speak(step.text, step.lang, { awaitEnd: true, speed: cfg.speed })
        : Promise.resolve({ ok: false, result: "unavailable" });

      p.then(function (out) {
        if (webRunEpoch !== epochAtStart || webState.status !== "playing") return;
        if (out && !out.ok && !out.cancelled) {
          emitState({ error: out.result || "unavailable" });
        }
        return sleepWait(step.pauseAfterMs, epochAtStart).then(function (stillGoing) {
          if (!stillGoing) return;
          stepIdx++;
          nextTick();
        });
      });
    }

    nextTick();
  }

  var AudioPlayer = {
    DEFAULT_PREFS: DEFAULT_PREFS,
    cefrForIndex: cefrForIndex,
    buildPlaylist: buildPlaylist,
    buildSteps: buildSteps,
    isCleanDrillRow: isCleanDrillRow,
    loadStats: loadStats,
    saveStats: saveStats,

    setOnTrackHeard: function (fn) {
      onTrackHeardCb = fn;
    },

    init: function () {
      wireNativeEvents();
      if (hasNativeAudio()) {
        return window.TTS.audio.getState().then(function (snap) {
          emitState(snap);
          return webState;
        });
      }
      return Promise.resolve(webState);
    },

    syncState: function () {
      if (hasNativeAudio()) {
        return window.TTS.audio.getState().then(function (snap) {
          emitState(snap);
          return webState;
        });
      }
      return Promise.resolve(webState);
    },

    start: function (playlist, startIndex, nextCfg, sleepMinutes) {
      setTracksCache(playlist || []);
      cfg = Object.assign({}, DEFAULT_PREFS, nextCfg || {});
      cfg.order = normalizeOrder(cfg.order);
      cfg.targetRepeat = clampTargetRepeat(cfg.targetRepeat);
      cfg.speed = clampSpeed(cfg.speed);
      var idx = Math.max(0, Math.min(Number(startIndex) || 0, Math.max(0, tracks.length - 1)));
      if (!tracks.length) return Promise.resolve({ ok: false, reason: "empty" });

      if (hasNativeAudio()) {
        wireNativeEvents();
        lastCompletedSeq = 0;
        webState.completedSeq = 0;
        return window.TTS.audio.ensureNotificationPermission().then(function (perm) {
          return window.TTS.audio.startQueue({
            tracks: tracks,
            startIndex: idx,
            config: cfg,
            sleepMinutes: Math.max(0, Number(sleepMinutes) || 0)
          }).then(function (res) {
            return { ok: !!(res && res.ok !== false), permissionGranted: !perm || perm.granted !== false };
          });
        });
      }

      clearWebTimers();
      if (window.TTS && window.TTS.cancel) window.TTS.cancel();
      webRunEpoch++;
      var ep = webRunEpoch;
      var sm = Math.max(0, Number(sleepMinutes) || 0);
      webSleepDeadline = sm > 0 ? (Date.now() + sm * 60000) : 0;
      webState.status = "playing";
      webState.heardCount = 0;
      webState.completedSeq = 0;
      lastCompletedSeq = 0;
      runWebLoop(idx, ep);
      return Promise.resolve({ ok: true, permissionGranted: true });
    },

    pause: function () {
      if (hasNativeAudio()) return window.TTS.audio.pause().then(function (s) { emitState(s); return webState; });
      clearWebTimers();
      webRunEpoch++;
      if (window.TTS && window.TTS.cancel) window.TTS.cancel();
      emitState({ status: "paused", stepRole: "", stepText: "", stepLang: "" });
      updateWebMediaSession(webState);
      return Promise.resolve(webState);
    },

    resume: function () {
      if (hasNativeAudio()) return window.TTS.audio.resume().then(function (s) { emitState(s); return webState; });
      if (!tracks.length) return Promise.resolve(webState);
      webRunEpoch++;
      var ep = webRunEpoch;
      webState.status = "playing";
      runWebLoop(webState.index || 0, ep);
      return Promise.resolve(webState);
    },

    next: function () {
      if (hasNativeAudio()) return window.TTS.audio.next().then(function (s) { emitState(s); return webState; });
      if (!tracks.length) return Promise.resolve(webState);
      clearWebTimers();
      if (window.TTS && window.TTS.cancel) window.TTS.cancel();
      var nextIdx = (webState.index || 0) + 1;
      if (nextIdx >= tracks.length) nextIdx = cfg.repeatMode === "all" ? 0 : tracks.length - 1;
      var cur = tracks[nextIdx];
      webRunEpoch++;
      var ep = webRunEpoch;
      if (webState.status === "playing") {
        runWebLoop(nextIdx, ep);
      } else {
        emitState({ index: nextIdx, conceptId: cur.id, word: cur.word, meaning: cur.meaning, stepRole: "", stepText: "" });
      }
      return Promise.resolve(webState);
    },

    prev: function () {
      if (hasNativeAudio()) return window.TTS.audio.prev().then(function (s) { emitState(s); return webState; });
      if (!tracks.length) return Promise.resolve(webState);
      clearWebTimers();
      if (window.TTS && window.TTS.cancel) window.TTS.cancel();
      var prevIdx = Math.max(0, (webState.index || 0) - 1);
      var cur = tracks[prevIdx];
      webRunEpoch++;
      var ep = webRunEpoch;
      if (webState.status === "playing") {
        runWebLoop(prevIdx, ep);
      } else {
        emitState({ index: prevIdx, conceptId: cur.id, word: cur.word, meaning: cur.meaning, stepRole: "", stepText: "" });
      }
      return Promise.resolve(webState);
    },

    stop: function () {
      if (hasNativeAudio()) return window.TTS.audio.stop().then(function (s) { emitState(s); return webState; });
      clearWebTimers();
      webRunEpoch++;
      webSleepDeadline = 0;
      if (window.TTS && window.TTS.cancel) window.TTS.cancel();
      emitState({ status: "idle", stepRole: "", stepText: "", stepLang: "", sleepRemainingMs: 0 });
      updateWebMediaSession(webState);
      return Promise.resolve(webState);
    },

    updateConfig: function (partialCfg, sleepMinutes) {
      cfg = Object.assign({}, cfg, partialCfg || {});
      cfg.order = normalizeOrder(cfg.order);
      cfg.targetRepeat = clampTargetRepeat(cfg.targetRepeat);
      cfg.speed = clampSpeed(cfg.speed);
      if (hasNativeAudio()) {
        var req = Object.assign({}, cfg);
        if (typeof sleepMinutes === "number") req.sleepMinutes = Math.max(0, sleepMinutes);
        return window.TTS.audio.updateConfig(req).then(function (s) { emitState(s); return webState; });
      }
      if (typeof sleepMinutes === "number") {
        webSleepDeadline = sleepMinutes > 0 ? (Date.now() + sleepMinutes * 60000) : 0;
      }
      emitState({
        preset: cfg.preset,
        order: cfg.order,
        targetRepeat: cfg.targetRepeat,
        speed: cfg.speed,
        repeatMode: cfg.repeatMode,
        includeDrills: cfg.includeDrills,
        preferOffline: cfg.preferOffline,
        sleepRemainingMs: webSleepDeadline > 0 ? Math.max(0, webSleepDeadline - Date.now()) : 0
      });
      return Promise.resolve(webState);
    },

    prefetch: function (list, customCfg) {
      var sub = (list || tracks || []).slice(0, 25);
      var useCfg = Object.assign({}, cfg, customCfg || {});
      if (hasNativeAudio()) {
        wireNativeEvents();
        return window.TTS.audio.prefetch({ tracks: sub, config: useCfg });
      }
      return Promise.resolve({ ok: false, reason: "web-no-offline-cache" });
    },

    cancelPrefetch: function () {
      if (hasNativeAudio()) return window.TTS.audio.cancelPrefetch();
      return Promise.resolve();
    },

    getState: function () { return webState; },
    getTracks: function () { return tracks; },
    getConfig: function () { return Object.assign({}, cfg); },

    subscribe: function (fn) {
      if (typeof fn !== "function") return function () {};
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (x) { return x !== fn; });
      };
    },

    subscribePrefetch: function (fn) {
      if (typeof fn !== "function") return function () {};
      prefetchListeners.push(fn);
      return function () {
        prefetchListeners = prefetchListeners.filter(function (x) { return x !== fn; });
      };
    }
  };

  window.AudioPlayer = AudioPlayer;
})();
