/* dict-learn v1.1 — two-screen flow (Home dashboard + Study)
 *
 * DOM contract (tests/mobile_app_harness.mjs) is preserved: every legacy id
 * (boot/top/app/progress/card/base/target/b1..b3/flip/speak/listen/mic/typed/
 * drill/drill-note/fillbox/fill-sent/fill-input/fill-note/conjbox/conj-prompt/
 * conj-opts/conj-note/back-hint) still exists and behaves the same, plus the
 * v1.1 additions (home/study/onboard/sessionlen/startbtn/homebtn/stat-ids,
 * toast/sndbtn/thmbtn/playdrill/close-panel).
 */
(function () {
  var INTERVALS = { hard: 1, ok: 3, good: 7 };
  var INTERVAL_LABEL = { hard: "1", ok: "3", good: "7" };
  var concepts = [], langs = [], drills = {}, cache = {}, queue = [], idx = 0;

  // active-production state
  var drill = null;        // current listen&write row
  var fill = null;         // { row, blank, answer }
  var conj = null;         // { targetKey, correct, options }
  var soundOn = true;
  var wantSettings = false;
  var sessionDone = false;
  var sessionStats = { learned: 0, correct: 0, practice: 0 };
  var audioStats = null;
  var audioPreviewTracks = [];
  var audioPreviewIndex = 0;
  var audioEnrichReq = "";

  // Demo mode (?lite=1) + lazy drill-pack loading. The full drills.json is
  // the heaviest payload (~23 MB); the app boots on concepts+langs so the
  // first card shows fast, and practice panels show a friendly notice until
  // the pack lands. E2E + quick demos use the bundled lite subset.
  var LITE = !!(window.location && /[?&]lite=1/.test(window.location.search || ""));
  var drillsReady = null;
  function dataBase() { return LITE ? "data/lite" : "data"; }
  function fmt(n) { try { return Number(n).toLocaleString("vi-VN"); } catch (e) { return String(n); } }

  // ---------------- utilities ----------------
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
    return el ? parseInt(el.value || "10", 10) : 10;
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

  // ---------------- queue & home stats ----------------
  function srsCounts() {
    var srs = readSrs();
    var today = todayISO(), due = 0, total = 0;
    Object.keys(srs).forEach(function (id) {
      total++;
      var rec = srs[id];
      if (rec && rec.due && rec.due <= today) due++;
      if (rec && rec.last && String(rec.last).slice(0, 10) === today) {}
    });
    return { total: total, due: due };
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

  function renderHome() {
    var c = srsCounts();
    var total = concepts.length;
    $("stat-learned").textContent = fmt(c.total);
    $("stat-total").textContent = fmt(total);
    var pct = total ? Math.min(100, Math.round((c.total / total) * 100)) : 0;
    $("learned-bar").style.width = pct + "%";
    $("stat-today").textContent = String(todayGrades());
    $("stat-streak").textContent = String(streakDays());

    var sb = $("startbtn");
    if (c.due > 0) {
      sb.textContent = "Học " + c.due + " từ đến hạn →";
    } else if (c.total === 0) {
      sb.textContent = "Bắt đầu học " + sessionLen() + " từ mới →";
    } else {
      sb.textContent = "Học " + sessionLen() + " từ tiếp theo →";
    }

    // onboarding only for brand-new users
    var seen = false;
    try { seen = !!localStorage.getItem("dictlearn_onboard_" + pairKey()); } catch (e) {}
    $("onboard").classList.toggle("hidden", seen || c.total > 0);
    updateAudioHomeMeta();
  }

  function updateAudioHomeMeta() {
    var sub = $("audio-home-sub");
    if (!sub) return;
    if (!audioStats) {
      sub.textContent = "Nghe nghĩa → từ học ×2 → ví dụ song ngữ cả khi tắt màn hình";
      return;
    }
    var heardToday = Object.keys(audioStats.todayHeardIds || {}).length;
    var active = window.AudioPlayer ? window.AudioPlayer.getState() : null;
    if (active && (active.status === "playing" || active.status === "paused") && active.word) {
      sub.textContent = (active.status === "playing" ? "Đang phát: " : "Đang tạm dừng: ") + active.word + " · " + (active.meaning || "");
    } else if (heardToday > 0) {
      sub.textContent = "Hôm nay đã nghe " + heardToday + " từ · chạm để nghe tiếp";
    } else {
      sub.textContent = "Nghe nghĩa → từ học ×2 → ví dụ song ngữ cả khi tắt màn hình";
    }
  }

  function buildQueue() {
    sessionDone = false;
    sessionStats = { learned: 0, correct: 0, practice: 0 };
    var srs = readSrs();
    var t = todayISO();
    var due = [], fresh = [];
    for (var i = 0; i < concepts.length; i++) {
      var rec = srs[concepts[i]];
      if (rec && rec.due && rec.due <= t) due.push(concepts[i]);
      else if (!rec) fresh.push(concepts[i]);
    }
    queue = due.concat(fresh);
    queue = queue.slice(0, Math.max(sessionLen(), due.length));
    if (!queue.length) queue = concepts.slice(0, sessionLen());
    idx = 0;
    updateProgress();
  }

  function updateProgress() {
    var c = srsCounts();
    $("progress").textContent =
      (idx + 1) + " / " + queue.length +
      (c.due ? " · " + c.due + " từ đến hạn" : "");
    var h = $("swipehint");
    if (h) h.classList.toggle("hidden", !c.due && c.total !== 0);
  }

  // ---------------- screens ----------------
  function showStudy() {
    if (sessionDone && idx >= queue.length) buildQueue();
    if (sessionDone) sessionDone = false;
    $("home").classList.add("hidden");
    if ($("audio-screen")) $("audio-screen").classList.add("hidden");
    $("study").classList.remove("hidden");
    updateMiniAudioBar();
    if (!sessionDone) render();
  }
  function showHome() {
    hidePanels();
    $("study").classList.add("hidden");
    if ($("audio-screen")) $("audio-screen").classList.add("hidden");
    $("home").classList.remove("hidden");
    renderHome();
    updateMiniAudioBar();
  }
  function showAudio(autoStart) {
    if (!$("audio-screen")) return Promise.resolve();
    hidePanels();
    $("home").classList.add("hidden");
    $("study").classList.add("hidden");
    $("audio-screen").classList.remove("hidden");
    updateMiniAudioBar();
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

  // ---------------- card render ----------------
  function ensurePracticeConcept() {
    // practice buttons may be pressed from Home, where the current card
    // dataset can be empty — pin it to the first study-queue concept.
    if (!$("card").dataset.id) {
      var srs = readSrs();
      for (var i = 0; i < concepts.length; i++) {
        if (drills[concepts[i]] && drills[concepts[i]].length) { $("card").dataset.id = concepts[i]; break; }
      }
      if (!$("card").dataset.id) $("card").dataset.id = concepts[0];
    }
    return $("card").dataset.id;
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
      card.dataset.id = id;
      card.dataset.word = word;

      var ro = (learning.ro && learning.ro[id]) || "";
      var ipa = (learning.ipa && learning.ipa[id]) || "";

      card.innerHTML =
        '<div class="target">' + word + "</div>" +
        (ro  ? '<div class="ro">'  + ro  + "</div>" : "") +
        (ipa ? '<div class="ipa">' + ipa + "</div>" : "") +
        '<div class="base hidden" id="base-text">' + ((known.w && known.w[id]) || "") + "</div>" +
        '<div class="ex hidden" id="ex">' + ((learning.e && learning.e[id]) || "") +
        ((known.e && known.e[id]) ? "<br>" + known.e[id] : "") + "</div>";

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
    card.innerHTML =
      '<div style="text-align:center;padding:1.4rem 0">' +
        '<div style="font-size:2.6rem">🎉</div>' +
        '<div style="font-weight:800;font-size:1.25rem;margin-top:0.5rem">Buổi học xong!</div>' +
        '<p class="muted" style="margin-top:0.5rem">' +
          "Chấm " + sessionStats.learned + " từ · đúng " + sessionStats.correct + " trong phần luyện<br>" +
          "Tổng tiến bộ: " + fmt(c.total) + " / " + fmt(concepts.length) + " từ (chuỗi " + streakDays() + " ngày)</p>" +
        '</div>';
    $("progress").textContent = "Hoàn tất buổi · " + fmt(c.total) + "/" + fmt(concepts.length) + " từ";
  }

  function grade(kind) {
    var id = $("card").dataset.id;
    if (!id || sessionDone) return;
    var store = readSrs();
    store[id] = { grade: kind, due: iso(INTERVALS[kind]), last: todayISO() };
    sessionStats.learned++;
    persistSrs();
    idx += 1;
    if (idx >= queue.length) buildQueue();
    render();
  }

  // ---------------- panels ----------------
  function ensureStudyVisible() {
    // Practice buttons live on the Home screen but their panels render in the
    // Study section. If Home is currently showing, switch to Study first so
    // the panel the user just asked for is actually visible.
    var home = $("home"), study = $("study");
    if (home && study && !home.classList.contains("hidden")) {
      home.classList.add("hidden");
      study.classList.remove("hidden");
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

  // ---------------- M2.2a listen & write ----------------
  function showListen() {
    withDrills("listen", function () {
      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("drill");
      var rows = drills[id] || [];
      var note = $("drill-note");
      if (!rows.length) {
        note.textContent = "Từ này chưa có câu công sở offline — thử một từ khác.";
        note.className = "panel-note";
        return;
      }
      drill = rows[0];
      $("typed").value = "";
      note.textContent = "Nghe câu rồi gõ lại chính xác (không cần hoa/thấp).";
      note.className = "panel-note";
      speak(drill.s, "en");
    });
  }
  function checkTyped() {
    if (!drill) return;
    var typed = $("typed").value.trim().toLowerCase();
    if (!typed) return;
    var ok = typed === String(drill.s).trim().toLowerCase();
    var note = $("drill-note");
    note.textContent = ok ? "✅ Đúng. Ghi nhớ tốt!" : ("Đáp án: " + drill.s + (drill.h ? " · " + drill.h : ""));
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
  function showFill() {
    withDrills("fill", function () {
      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("fillbox");
      var rows = (drills[id] || []).filter(function (r) { return r.s && r.sf; });
      var note = $("fill-note");
      if (!rows.length) {
        note.textContent = "Từ này chưa có câu để điền — thử một từ khác.";
        note.className = "panel-note";
        return;
      }
      var row = rows[Math.floor(Math.random() * rows.length)];
      var sf = row.sf;
      var re = new RegExp(sf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      if (!re.test(row.s)) { showListen(); return; }
      var blanked = row.s.replace(re, "____");
      fill = { row: row, answer: sf };
      $("fill-sent").textContent = blanked;
      $("fill-input").value = "";
      note.textContent = "Nghe câu rồi gõ từ còn thiếu (vị trí gạch ngang).";
      note.className = "panel-note";
      speak(row.s, "en");
    });
  }
  function checkFill() {
    if (!fill) return;
    var typed = $("fill-input").value.trim().toLowerCase();
    if (!typed) return;
    var ok = typed === fill.answer.toLowerCase();
    var note = $("fill-note");
    note.textContent = ok ? "✅ Đúng: " + fill.answer : ("Đáp án: " + fill.answer);
    note.className = "panel-note " + (ok ? "ok" : "bad");
    sessionStats.correct += ok ? 1 : 0;
  }

  // ---------------- M2.3b conjugate ----------------
  function showConjugate() {
    withDrills("conj", function () {

      var id = ensurePracticeConcept();
      ensureStudyVisible();
      openPanel("conjbox");
      var rows = drills[id] || [];
      var note = $("conj-note");
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
      $("conj-prompt").textContent = "";
      note.textContent = "Từ này chưa có các dạng chia để luyện — thử từ khác.";
      note.className = "panel-note";
      $("conj-opts").innerHTML = "";
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
    conj = { correct: winner };
    var box = $("conj-opts");
    box.innerHTML = "";
    var note = $("conj-note");
    note.textContent = "Đúng: " + winner.s + " · Sai: sẽ hiện đáp án.";
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
        nn.textContent = ok ? "✅ Đúng." : ("Đáp án: " + conj.correct.s + (conj.correct.h ? " · " + conj.correct.h : ""));
        nn.className = "panel-note " + (ok ? "ok" : "bad");
        sessionStats.correct += ok ? 1 : 0;
      });
      label.appendChild(inp);
      label.appendChild(document.createTextNode(" " + r.s));
      box.appendChild(label);
    });
    speak(winner.s, "en");
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
      concepts = parts[0];
      langs = parts[1];
      ["base", "target"].forEach(function (idn) {
        $(idn).innerHTML = langs.map(function (l) {
          return '<option value="' + l.code + '">' + l.native + "</option>";
        }).join("");
      });
      $("base").value = "vi";
      $("target").value = "en";
      applyTheme(localStorage.getItem("dictlearn_theme") || "auto");
      var sl = $("sessionlen");
      if (sl) sl.value = localStorage.getItem("dictlearn_session") || "10";
      // background load of the drill pack (non-blocking)
      drillsReady = fetch(db + "/drills.json")
        .then(function (r) { return r.json(); })
        .then(function (d) { drills = d; })
        .catch(function () {});
      return loadSrs().then(function () {
        $("boot").classList.add("hidden");
        $("top").classList.remove("hidden");
        $("app").classList.remove("hidden");
        return initAudioSubsystem().then(function () {
          renderHome();
          showHome();
          buildQueue();
          return render();
        });
      });
    });
  }

  // Await the drill pack before a practice panel that needs it. If it hasn't
  // landed yet, show a friendly "loading" note instead of a blank panel.
  function withDrills(kind, fn) {
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
    if ($("audio-source")) out.source = $("audio-source").value || out.source || "due";
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
    if ($("audio-source")) $("audio-source").value = p.source || "due";
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

  function prepareAudioTracks(ensureDrills) {
    if (!window.AudioPlayer) return Promise.resolve([]);
    var prefs = audioPrefsFromUI();
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
        source: prefs.source || "due",
        baseLang: base(),
        targetLang: target(),
        limit: prefs.limit || 30,
        today: todayISO()
      });
      audioPreviewTracks = list;
      var idxFound = 0;
      if (audioStats && audioStats.cursorId) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === audioStats.cursorId) { idxFound = i; break; }
        }
      }
      audioPreviewIndex = idxFound;
      var st = window.AudioPlayer.getState();
      if (!st || st.status === "idle") renderAudioScreen(st);
      return list;
    });
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

  function enrichAudioCard(conceptId) {
    if (!conceptId || audioEnrichReq === conceptId) return;
    audioEnrichReq = conceptId;
    Promise.all([loadLang(base()), loadLang(target())]).then(function (parts) {
      if (audioEnrichReq !== conceptId) return;
      var cur = window.AudioPlayer ? window.AudioPlayer.getState() : null;
      if (!cur || cur.conceptId !== conceptId) return;
      var baseD = parts[0] || {}, targD = parts[1] || {};
      var ph = [
        (targD.ro && targD.ro[conceptId]) || "",
        (targD.ipa && targD.ipa[conceptId]) || ""
      ].filter(Boolean).join(" · ");
      if ($("audio-phonetics") && !$("audio-phonetics").textContent) $("audio-phonetics").textContent = ph;
      if ($("audio-ex-target") && cur.stepRole !== "drill_target" && !$("audio-ex-target").textContent) {
        $("audio-ex-target").textContent = (targD.e && targD.e[conceptId]) || "";
      }
      if ($("audio-ex-base") && cur.stepRole !== "drill_base" && !$("audio-ex-base").textContent) {
        $("audio-ex-base").textContent = (baseD.e && baseD.e[conceptId]) || "";
      }
    }).catch(function () {});
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
    var prog = $("audio-progress");
    var playBtn = $("audio-play");

    if (!view) {
      if (badge) { badge.textContent = "Trống"; badge.classList.remove("is-playing"); }
      if (prog) prog.textContent = "Chưa có từ phù hợp";
      if ($("audio-word")) $("audio-word").textContent = "—";
      if ($("audio-phonetics")) $("audio-phonetics").textContent = "";
      if ($("audio-meaning")) $("audio-meaning").textContent = "Hãy thử đổi nguồn phát khác";
      if ($("audio-ex-target")) $("audio-ex-target").textContent = "";
      if ($("audio-ex-base")) $("audio-ex-base").textContent = "";
      if (playBtn) playBtn.textContent = "▶ Nghe";
      return;
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

    if ($("audio-word")) $("audio-word").textContent = view.word || "—";
    if ($("audio-phonetics")) {
      $("audio-phonetics").textContent = [view.ro, view.ipa].filter(Boolean).join(" · ");
    }
    if ($("audio-meaning")) $("audio-meaning").textContent = view.meaning || "";

    var showExTarget = view.stepRole === "drill_target" ? ("💼 " + (view.stepText || "")) : (view.exTarget || "");
    var showExBase = view.stepRole === "drill_base" ? (view.stepText || "") : (view.exBase || "");
    if ($("audio-ex-target")) $("audio-ex-target").textContent = showExTarget;
    if ($("audio-ex-base")) $("audio-ex-base").textContent = showExBase;

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

    if (isActive && view.conceptId && !view.ro && !view.exTarget) {
      enrichAudioCard(view.conceptId);
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
        (st.word || "Đang phát") + (st.total ? " (" + (st.index + 1) + "/" + st.total + ")" : "");
    }
    if ($("audio-mini-sub")) {
      $("audio-mini-sub").textContent = st.stepText || st.meaning || "";
    }
    if ($("audio-mini-toggle")) {
      $("audio-mini-toggle").textContent = st.status === "playing" || st.status === "loading" ? "⏸" : "▶";
    }
  }

  function initAudioSubsystem() {
    if (!window.AudioPlayer) return Promise.resolve();
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
      renderAudioScreen(st);
      updateMiniAudioBar(st);
      updateAudioHomeMeta();
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
      renderAudioScreen(window.AudioPlayer.getState());
      updateMiniAudioBar(window.AudioPlayer.getState());
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

    if (document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden && window.AudioPlayer) window.AudioPlayer.syncState();
      });
    }
  }

  // ---------------- wiring ----------------
  function wire() {
    // home
    $("startbtn").onclick = function () { showStudy(); if (idx >= queue.length || sessionDone) { buildQueue(); render(); } };
    $("homebtn").onclick = showHome;
    $("onboardok").onclick = function () {
      try { localStorage.setItem("dictlearn_onboard_" + pairKey(), "1"); } catch (e) {}
      $("onboard").classList.add("hidden");
    };
    wireAudio();
    // lang / session / prefs
    var onPairChange = function () {
      var stopAudio = (window.AudioPlayer && window.AudioPlayer.getState().status !== "idle")
        ? window.AudioPlayer.stop()
        : Promise.resolve();
      audioPreviewTracks = [];
      audioPreviewIndex = 0;
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
      buildQueue();
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
    $("flip").onclick = function () {
      var b = $("base-text"), e = $("ex");
      if (b) b.classList.toggle("hidden");
      if (e) e.classList.toggle("hidden");
    };
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
    // practice
    $("listen").onclick = showListen;
    $("mic").onclick = toggleMic;
    $("playdrill").onclick = function () { if (drill) speak(drill.s, "en", true); };
    $("fillbtn").onclick = showFill;
    $("conjbtn").onclick = showConjugate;
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

    // --- M3.2 swipe gestures (Anki-style) ---
    var card = $("card");
    var startX = 0, startY = 0, swiping = false;
    card.addEventListener("pointerdown", function (e) {
      if (sessionDone) return;
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
