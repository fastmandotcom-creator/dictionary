(function () {
  var INTERVALS = { hard: 1, ok: 3, good: 7 };
  var concepts = [], langs = [], drills = {}, cache = {}, queue = [], idx = 0;

  // active-production state
  var drill = null;        // current listen&write row
  var fill = null;         // { row, blank, answer }
  var conj = null;         // { targetKey, correct, options:[{key,row}] }

  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function pairKey() { return "dict_srs_v2_" + base() + "_" + target(); }

  // --- M3.1: durable SRS state (IndexedDB in prod, localStorage fallback) ---
  // Hot path (read/grade) is synchronous against an in-memory cache; the cache
  // is loaded from the durable store per pair and written back on every grade.
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
      // One-time migration: older app versions kept SRS in a raw localStorage key.
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
  function base() { return document.getElementById("base").value; }
  function target() { return document.getElementById("target").value; }
  function $(id) { return document.getElementById(id); }
  function hidePanels() {
    if (micListening) { try { window.MicAsr && MicAsr.stop(); } catch (e) {} micListening = false; }
    var micBtn = $("mic");
    if (micBtn) micBtn.textContent = "🎤 Mic";
    ["drill", "fillbox", "conjbox"].forEach(function (id) { $(id).classList.add("hidden"); });
    drill = null; fill = null; conj = null;
  }

  function speak(text, lang) {
    if (!text || !window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "zh" ? "zh-CN" : lang === "pt" ? "pt-BR" : lang;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function loadLang(code) {
    if (cache[code]) return Promise.resolve(cache[code]);
    return fetch("data/lang/" + code + ".json").then(function (r) { return r.json(); }).then(function (data) {
      cache[code] = data;
      return data;
    });
  }

  function buildQueue() {
    var srs = readSrs();
    queue = [];
    for (var i = 0; i < concepts.length && queue.length < 10; i++) {
      if (!srs[concepts[i]]) queue.push(concepts[i]);
    }
    if (!queue.length) queue = concepts.slice(0, 10);
    idx = 0;
    $("progress").textContent =
      Object.keys(srs).length + " / " + concepts.length + " từ đã học · buổi này " + queue.length + " từ";
  }

  function render() {
    hidePanels();
    var id = queue[idx];
    return Promise.all([loadLang(base()), loadLang(target())]).then(function (pair) {
      var known = pair[0];
      var learning = pair[1];
      var word = (learning.w && learning.w[id]) || id;
      var card = $("card");
      card.dataset.id = id;
      card.dataset.word = word;

      // M2.2b: romanization + IPA for the target word (empty until offline_fill
      // phonetics lands data for this concept/language).
      var ro = (learning.ro && learning.ro[id]) || "";
      var ipa = (learning.ipa && learning.ipa[id]) || "";

      card.innerHTML =
        '<div class="muted">' + (idx + 1) + "/" + queue.length + "</div>" +
        '<div class="target">' + word + "</div>" +
        (ro  ? '<div class="ro">'  + ro  + "</div>" : "") +
        (ipa ? '<div class="ipa">' + ipa + "</div>" : "") +
        '<div class="base hidden" id="base-text">' + ((known.w && known.w[id]) || "") + "</div>" +
        '<div class="ex hidden" id="ex">' + ((learning.e && learning.e[id]) || "") +
        ((known.e && known.e[id]) ? "<br>" + known.e[id] : "") + "</div>";

      speak(word, target());
    });
  }

  function grade(kind) {
    var id = $("card").dataset.id;
    var store = readSrs();
    store[id] = { grade: kind, due: iso(INTERVALS[kind]) };
    // M3.1: write-through to the durable store (IndexedDB in prod); hot path
    // already updated the in-memory cache, so the next render reads instantly.
    persistSrs();
    idx += 1;
    if (idx >= queue.length) buildQueue();
    render();
  }

  // --- M2.2a: listen & write ------------------------------------------------
  function showListen() {
    hidePanels();
    var id = $("card").dataset.id;
    var rows = drills[id] || [];
    $("drill").classList.remove("hidden");
    var note = $("drill-note");
    if (!rows.length) { note.textContent = "Từ này chưa có câu công sở offline."; note.className = "panel-note"; return; }
    drill = rows[0];
    $("typed").value = "";
    note.textContent = "Nghe câu rồi gõ lại.";
    note.className = "panel-note";
    speak(drill.s, "en");
  }
  function checkTyped() {
    if (!drill) return;
    var typed = $("typed").value.trim().toLowerCase();
    var ok = typed === String(drill.s).trim().toLowerCase();
    var note = $("drill-note");
    note.textContent = ok ? "Đúng." : ("Câu đúng: " + drill.s + (drill.h ? " · " + drill.h : ""));
    note.className = "panel-note " + (ok ? "ok" : "bad");
  }

  // --- M2.1: Microphone ASR -------------------------------------------------
  // Dictate the drill sentence with the mic instead of the keyboard.
  // The Mic button is a toggle: press to start dictating, press again to stop.
  // On the Android system WebView (non-Chromium) MicAsr is unsupported, so the
  // button degrades to a clear message and the learner still types by hand.
  var micListening = false;
  function toggleMic() {
    if (!drill) { showListen(); }
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
      // auto-grade the dictated transcript
      checkTyped();
      return;
    }
    micListening = true;
    $("mic").textContent = "⏹ Dừng";
    $("typed").value = "";
    note.textContent = "Đang nghe… nói câu vừa nghe được.";
    note.className = "panel-note";
    MicAsr.start($("typed"), target(), function (ev) {
      if (ev.error) {
        micListening = false;
        $("mic").textContent = "🎤 Mic";
        note.textContent = ev.error;
        note.className = "panel-note";
      } else if (ev.final) {
        // a final result landed: stop the engine and grade it
        micListening = false;
        $("mic").textContent = "🎤 Mic";
        checkTyped();
      }
    });
  }

  // --- M2.3a: fill-blank ----------------------------------------------------
  // Blank out the concept's surface phrase in a drill sentence; user types it.
  function showFill() {
    hidePanels();
    var id = $("card").dataset.id;
    var rows = (drills[id] || []).filter(function (r) { return r.s && r.sf; });
    $("fillbox").classList.remove("hidden");
    var note = $("fill-note");
    if (!rows.length) {
      note.textContent = "Từ này chưa có câu để điền.";
      note.className = "panel-note";
      return;
    }
    var row = rows[Math.floor(Math.random() * rows.length)];
    var sf = row.sf;
    var re = new RegExp(sf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (!re.test(row.s)) {
      // surface not literally present (e.g. conjugated form); fall back to listen.
      showListen();
      return;
    }
    var blanked = row.s.replace(re, "____");
    fill = { row: row, answer: sf };
    $("fill-sent").textContent = blanked;
    $("fill-input").value = "";
    note.textContent = "Gõ từ còn thiếu.";
    note.className = "panel-note";
    speak(row.s, "en");
  }
  function checkFill() {
    if (!fill) return;
    var typed = $("fill-input").value.trim().toLowerCase();
    var ok = typed === fill.answer.toLowerCase();
    var note = $("fill-note");
    note.textContent = ok ? "Đúng: " + fill.answer : ("Đáp án: " + fill.answer);
    note.className = "panel-note " + (ok ? "ok" : "bad");
  }

  // --- M2.3b: conjugate (pick the correct grammar form) ---------------------
  // If a concept spans multiple tenses, ask to pick the present-simple sentence
  // among tense distractors. Otherwise fall back to picking the question form.
  function showConjugate() {
    hidePanels();
    var id = $("card").dataset.id;
    var rows = drills[id] || [];
    $("conjbox").classList.remove("hidden");
    var note = $("conj-note");
    var byPol = {};
    rows.forEach(function (r) { if (r.t && r.p) (byPol[r.p] = byPol[r.p] || []).push(r); });

    // Prefer a polarity that has >1 distinct tense (real conjugation).
    // Prefer non-question polarities so a clear "pick the tense" question
    // (answer is a statement, distractors are the other tenses).
    var targetPol = null;
    ['affirmative', 'negative', 'question'].forEach(function (p) {
      if (targetPol || !byPol[p]) return;
      var tenses = {};
      byPol[p].forEach(function (r) { tenses[r.t] = 1; });
      if (Object.keys(tenses).length > 1) targetPol = p;
    });
    if (targetPol) {
      // Real conjugation: several tenses share this polarity. Pick the
      // present-simple form among the distractors.
      note.textContent = "Chọn câu ở dạng HIỆN TẠI (present simple).";
      note.className = "panel-note";
      buildConjOptions(rows, function (r) { return r.p === targetPol; }, "present_simple");
      return;
    }
    // No tense spread: ask to identify the question form among polarities.
    var qRows = rows.filter(function (r) { return r.p === "question"; });
    if (qRows.length) {
      note.textContent = "Chọn câu là CÂU HỎI.";
      note.className = "panel-note";
      buildConjOptions(rows, function () { return true; }, "question");
      return;
    }
    note.textContent = "Từ này chưa có các dạng chia để luyện.";
    note.className = "panel-note";
    $("conj-opts").innerHTML = "";
  }

  function buildConjOptions(allRows, filterFn, correctKey) {
    var pool = allRows.filter(filterFn);
    // Deduplicate by the dimension we are contrasting.
    var seen = {};
    var opts = pool.filter(function (r) {
      var k = r.t + "|" + r.p;
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
    if (opts.length < 2) {
      // not enough distinct forms; degrade to listen mode
      showListen();
      return;
    }
    // Mark which option is correct based on correctKey (tense or polarity).
    var correct = opts.filter(function (r) {
      if (correctKey === "question") return r.p === "question";
      return r.t === correctKey && r.p !== "question";
    });
    if (!correct.length) { showListen(); return; }
    var winner = correct[0];
    // Build up to 3 radio options (winner + up to 2 distractors), shuffled.
    var distractors = opts.filter(function (r) { return r !== winner; }).slice(0, 2);
    var choices = [winner].concat(distractors);
    choices.sort(function () { return Math.random() - 0.5; });
    conj = { correct: winner };
    var box = $("conj-opts");
    box.innerHTML = "";
    choices.forEach(function (r) {
      var label = document.createElement("label");
      label.className = "conj-opt";
      var inp = document.createElement("input");
      inp.type = "radio";
      inp.name = "conj";
      inp.value = r.s;
      inp.addEventListener("change", function () {
        var ok = (inp.value === conj.correct.s);
        var note = $("conj-note");
        note.textContent = ok ? "Đúng." : ("Đáp án: " + conj.correct.s + (conj.correct.h ? " · " + conj.correct.h : ""));
        note.className = "panel-note " + (ok ? "ok" : "bad");
      });
      label.appendChild(inp);
      label.appendChild(document.createTextNode(" " + r.s));
      box.appendChild(label);
    });
    speak(winner.s, "en");
  }

  function boot() {
    return Promise.all([
      fetch("data/concepts.json").then(function (r) { return r.json(); }),
      fetch("data/langs.json").then(function (r) { return r.json(); }),
      fetch("data/drills.json").then(function (r) { return r.json(); })
    ]).then(function (parts) {
      concepts = parts[0];
      langs = parts[1];
      drills = parts[2];
      ["base", "target"].forEach(function (id) {
        $(id).innerHTML = langs.map(function (l) {
          return '<option value="' + l.code + '">' + l.native + "</option>";
        }).join("");
      });
      $("base").value = "vi";
      $("target").value = "en";
      // M3.1: hydrate the durable SRS cache before first build/render so the
      // "X/12000 learned" count and queue skip already-known words.
      return loadSrs().then(function () {
        $("boot").classList.add("hidden");
        $("top").classList.remove("hidden");
        $("app").classList.remove("hidden");
        buildQueue();
        return render();
      });
    });
  }

  // --- M3.3: Hardware Back button (Android) ---------------------------------
  // Capacitor App plugin intercepts the native back press and fires a JS
  // `backbutton` event. e.preventDefault() stops the app from closing so we
  // can decide the behavior ourselves:
  //   1st press while a panel is open  → just close the panel
  //   1st press on the main card       → show a toast, remember the time
  //   2nd press within 2.5s           → actually exit the app
  // On the pure-web path (Capacitor not available) the listener is a no-op.
  (function initBackPress() {
    if (typeof window === 'undefined') return;
    window.addEventListener('backbutton', function (e) {
      e.preventDefault();
      // If a drill/fill/conj panel is open, just close it.
      var openPanel = document.querySelector('.panel:not(.hidden)');
      if (openPanel) { hidePanels(); return; }
      // On the main card: 2-press confirm.
      if (window.__backHintUntil && Date.now() < window.__backHintUntil) {
        window.__backHintUntil = null;
        var hint2 = document.getElementById('back-hint');
        if (hint2) hint2.classList.add('hidden');
        if (typeof Capacitor !== 'undefined' && Capacitor.App) {
          Capacitor.App.exitApp();
        }
        return;
      }
      var hint = document.getElementById('back-hint');
      if (hint) {
        hint.textContent = 'Chạm lần nữa để thoát.';
        hint.classList.remove('hidden');
        window.__backHintEl = hint;
        window.__backHintUntil = Date.now() + 2500;
        setTimeout(function () { if (hint) hint.classList.add('hidden'); }, 2500);
      }
    });
  })();
  $("b1").onclick = function () { grade("hard"); };
  $("b2").onclick = function () { grade("ok"); };
  $("b3").onclick = function () { grade("good"); };

  // --- M3.2: Swipe gestures on the card (Anki-style) -----------------------
  // Right swipe → "Nhớ" (good)   ·   Left swipe → "Chưa" (hard)
  // Down swipe  → "Tạm"  (ok)
  // Uses Pointer Events (no library). `touch-action: pan-y` on .card allows
  // vertical page scroll; horizontal drag is captured by the handler below.
  (function initSwipe() {
    var card = document.getElementById("card");
    var startX = 0, startY = 0, swiping = false;

    card.addEventListener("pointerdown", function (e) {
      startX = e.clientX; startY = e.clientY; swiping = true;
      card.classList.add("swiping");
      card.setPointerCapture(e.pointerId);
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
      var TH = 80; // trigger threshold, px
      if (dx > TH && Math.abs(dx) > Math.abs(dy)) {
        grade("good");  // right swipe
      } else if (dx < -TH && Math.abs(dx) > Math.abs(dy)) {
        grade("hard"); // left swipe
      } else if (dy > TH && Math.abs(dy) > Math.abs(dx)) {
        grade("ok");   // down swipe
      }
    });
    card.addEventListener("pointercancel", function () {
      swiping = false;
      card.classList.remove("swiping");
      card.style.transform = "";
      card.style.opacity = "";
    });
  })();
  $("flip").onclick = function () {
    var b = $("base-text"), e = $("ex");
    if (b) b.classList.toggle("hidden");
    if (e) e.classList.toggle("hidden");
  };
  $("speak").onclick = function () { speak($("card").dataset.word, target()); };
  $("listen").onclick = showListen;
  $("mic").onclick = toggleMic;
  $("fillbtn").onclick = showFill;
  $("conjbtn").onclick = showConjugate;
  $("clearbtn").onclick = function () { hidePanels(); };
  $("typed").addEventListener("keydown", function (e) { if (e.key === "Enter") checkTyped(); });
  $("fill-input").addEventListener("keydown", function (e) { if (e.key === "Enter") checkFill(); });
  $("base").onchange = function () { loadSrs().then(function () { buildQueue(); render(); }); };
  $("target").onchange = function () { loadSrs().then(function () { buildQueue(); render(); }); };
  boot().catch(function (err) {
    $("boot").textContent = "Không mở được kho từ: " + err;
  });
})();
