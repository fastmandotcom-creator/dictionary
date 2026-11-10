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
  var sessionDone = false;
  var sessionStats = { learned: 0, correct: 0, practice: 0 };

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

  function speak(text, lang) {
    if (!text || !window.speechSynthesis || !soundOn) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "zh" ? "zh-CN" : lang === "pt" ? "pt-BR" : lang;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
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
    $("stat-learned").textContent = c.total;
    $("stat-total").textContent = total;
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
    $("study").classList.remove("hidden");
    if (!sessionDone) render();
  }
  function showHome() {
    hidePanels();
    $("study").classList.add("hidden");
    $("home").classList.remove("hidden");
    renderHome();
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
        '<div class="card-pos">' + (idx + 1) + " / " + queue.length + "</div>" +
        '<div class="target">' + word + "</div>" +
        (ro  ? '<div class="ro">'  + ro  + "</div>" : "") +
        (ipa ? '<div class="ipa">' + ipa + "</div>" : "") +
        '<div class="base hidden" id="base-text">' + ((known.w && known.w[id]) || "") + "</div>" +
        '<div class="ex hidden" id="ex">' + ((learning.e && learning.e[id]) || "") +
        ((known.e && known.e[id]) ? "<br>" + known.e[id] : "") + "</div>";

      updateProgress();
      speak(word, target());
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
          "Tổng tiến bộ: " + c.total + " / " + concepts.length + " từ (chuỗi " + streakDays() + " ngày)</p>" +
        '</div>';
    $("progress").textContent = "Hoàn tất buổi · " + c.total + "/" + concepts.length + " từ";
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
    var id = ensurePracticeConcept();
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
    var id = ensurePracticeConcept();
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
    var id = ensurePracticeConcept();
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
    return Promise.all([
      fetch("data/concepts.json").then(function (r) { return r.json(); }),
      fetch("data/langs.json").then(function (r) { return r.json(); }),
      fetch("data/drills.json").then(function (r) { return r.json(); })
    ]).then(function (parts) {
      concepts = parts[0];
      langs = parts[1];
      drills = parts[2];
      ["base", "target"].forEach(function (idn) {
        $(idn).innerHTML = langs.map(function (l) {
          return '<option value="' + l.code + '">' + l.native + "</option>";
        }).join("");
      });
      $("base").value = "vi";
      $("target").value = "en";
      // theme
      applyTheme(localStorage.getItem("dictlearn_theme") || "auto");
      // session length
      var sl = $("sessionlen");
      if (sl) sl.value = localStorage.getItem("dictlearn_session") || "10";
      // auto-typing prevention: start on Home
      return loadSrs().then(function () {
        $("boot").classList.add("hidden");
        $("top").classList.remove("hidden");
        $("app").classList.remove("hidden");
        renderHome();
        showHome();
        buildQueue();
        // pre-render the first card so study + practice-from-home work instantly
        return render();
      });
    });
  }

  function applyTheme(t) {
    if (document.documentElement) document.documentElement.setAttribute("data-theme", t);
    var btn = $("thmbtn");
    if (btn) btn.textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
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
    // lang / session / prefs
    $("base").onchange = function () { loadSrs().then(function () { buildQueue(); showHome(); render(); }); };
    $("target").onchange = function () { loadSrs().then(function () { buildQueue(); showHome(); render(); }); };
    $("sessionlen").onchange = function () {
      try { localStorage.setItem("dictlearn_session", $("sessionlen").value); } catch (e) {}
      buildQueue();
      if (!$("study").classList.contains("hidden")) render();
    };
    $("sndbtn").onclick = function () {
      soundOn = !soundOn;
      $("sndbtn").textContent = soundOn ? "🔊" : "🔇";
      toast(soundOn ? "Đã bật âm thanh" : "Đã tắt âm thanh");
    };
    $("thmbtn").onclick = function () {
      var cur = document.documentElement.getAttribute("data-theme");
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
    $("speak").onclick = function () { speak($("card").dataset.word, target()); };
    // practice
    $("listen").onclick = showListen;
    $("mic").onclick = toggleMic;
    $("playdrill").onclick = function () { if (drill) speak(drill.s, "en"); };
    $("fillbtn").onclick = showFill;
    $("conjbtn").onclick = showConjugate;
    $("clearbtn").onclick = hidePanels;
    document.querySelectorAll(".close-panel").forEach(function (b) { b.onclick = hidePanels; });
    // inputs
    $("typed").addEventListener("keydown", function (e) { if (e.key === "Enter") checkTyped(); });
    $("drillcheck").onclick = checkTyped;
    $("fill-input").addEventListener("keydown", function (e) { if (e.key === "Enter") checkFill(); });
    $("fillcheck").onclick = checkFill;

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
    window.addEventListener("backbutton", function (e) {
      e.preventDefault();
      var openPanelEl = document.querySelector(".panel:not(.hidden)");
      if (openPanelEl) { hidePanels(); return; }
      if (!$("study").classList.contains("hidden")) { showHome(); return; }
      // on Home: 2-press confirm
      var now = Date.now();
      if (now - lastBack < 2500) {
        lastBack = 0;
        var hint = $("back-hint");
        if (hint) hint.classList.add("hidden");
        if (typeof Capacitor !== "undefined" && Capacitor.App) Capacitor.App.exitApp();
      } else {
        lastBack = now;
        var h2 = $("back-hint");
        if (h2) {
          h2.classList.remove("hidden");
          setTimeout(function () { h2.classList.add("hidden"); }, 2500);
        }
      }
    });
  }

  wire();
  boot().catch(function (err) {
    var b = $("boot");
    if (b) b.innerHTML = '<div style="color:var(--bad-fg)">Không mở được kho từ: ' + err + "</div>";
  });
})();
