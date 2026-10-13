/* Shared listen-and-write drill UI (Phase D3).
 * One source of truth for: offline demo pack generation, answer
 * normalization, drill selection (due first), and the listen -> type ->
 * check -> grade flow. Used by /listen and the /session "nâng cao" segment.
 */
(function (global) {
  'use strict';

  var IRREGULAR = {
    go: ['went'], eat: ['ate'], write: ['wrote'], speak: ['spoke'],
    take: ['took'], make: ['made'], have: ['had'], do: ['did'],
    see: ['saw'], come: ['came'], run: ['ran'], buy: ['bought']
  };

  function inflect(surface, tense) {
    var s = String(surface || '').toLowerCase();
    if (tense !== 'past_simple') return s;
    if (IRREGULAR[s]) return IRREGULAR[s][0];
    if (s.endsWith('e')) return s + 'd';
    if (s.endsWith('y') && s.length > 3 && !/[aeiou]y$/.test(s)) return s.slice(0, -1) + 'ied';
    return s + 'ed';
  }

  function specsFor(concept) {
    // verbs and verb-phrases span tenses; every other POS stays in the
    // present (3 polarities). Mirrors dict_factory/drills.py.
    var verbish = concept.pos === 'verb' || concept.pos === 'phrase';
    var keys = verbish
      ? ['present_simple/affirmative', 'present_simple/negative', 'present_simple/question',
         'past_simple/affirmative', 'past_simple/negative', 'past_simple/question',
         'future_simple/affirmative', 'future_simple/negative', 'future_simple/question']
      : ['present_simple/affirmative', 'present_simple/negative', 'present_simple/question'];
    return keys.map(function (k) {
      var p = k.split('/');
      return { tense: p[0], polarity: p[1], drill_key: k };
    });
  }

  function topicWord(topic) {
    return topic === 'business' ? ' at work'
         : topic === 'travel' ? ' on the trip'
         : topic === 'daily' ? ' at home' : ' today';
  }

  // Offline demo pack: deterministic sentences when the LLM API is
  // unreachable. Clearly labelled "(demo offline)" in the UI.
  function demoPack(concept, topic) {
    var surface = String(concept.en || concept.gloss || concept.id).toLowerCase();
    var verbish = concept.pos === 'verb' || concept.pos === 'phrase';
    if (verbish && surface.startsWith('to ')) surface = surface.slice(3).trim();
    var specs = specsFor(concept);
    var rows = [];
    specs.forEach(function (sp) {
      var tense = sp.tense, pol = sp.polarity, w;
      if (verbish) {
        if (pol === 'affirmative') {
          w = tense === 'present_simple' ? 'I ' + surface + topicWord(topic)
              : (tense === 'past_simple' ? 'I ' + inflect(surface, 'past_simple') + topicWord(topic)
              : 'I will ' + surface + topicWord(topic));
        } else if (pol === 'negative') {
          w = tense === 'present_simple' ? 'I do not ' + surface + topicWord(topic)
              : (tense === 'past_simple' ? 'I did not ' + surface + topicWord(topic)
              : 'I will not ' + surface + topicWord(topic));
        } else {
          w = tense === 'present_simple' ? 'Do you ' + surface + topicWord(topic) + '?'
              : (tense === 'past_simple' ? 'Did you ' + surface + topicWord(topic) + '?'
              : 'Will you ' + surface + topicWord(topic) + '?');
        }
      } else {
        w = pol === 'affirmative' ? 'This is ' + surface + '.'
            : (pol === 'negative' ? 'This is not ' + surface + '.'
            : 'Is this ' + surface + '?');
      }
      rows.push({
        drill_key: sp.drill_key, tense: sp.tense, polarity: pol,
        sentence: w, surface: surface,
        base_hint: concept.gloss || '', demo: true
      });
    });
    return rows;
  }

  function normalize(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function srsId(conceptId, drillKey) { return conceptId + '::' + drillKey; }

  function isGraded(id, base, target) {
    var srs = Srs.readSrs(base, target);
    var legacy = Srs.readLegacy(base, target);
    return !!(srs[id] && srs[id].grade) || !!legacy[id];
  }

  function pickDrillKey(conceptId, drills, base, target) {
    // due first (most overdue via isDue order of appearance), else first ungraded
    for (var i = 0; i < drills.length; i++) {
      if (Srs.isDue(srsId(conceptId, drills[i].drill_key), base, target)) return drills[i].drill_key;
    }
    for (var j = 0; j < drills.length; j++) {
      if (!isGraded(srsId(conceptId, drills[j].drill_key), base, target)) return drills[j].drill_key;
    }
    return drills.length ? drills[0].drill_key : null;
  }

  // Real packs only. Demo fallback must not poison this — a timed-out
  // player still lets the in-flight request fill the cache for the next card.
  var packCache = {};
  var packInflight = {};

  function packKey(concept, target, topic) {
    return (concept && concept.id) + '|' + target + '|' + topic;
  }

  function mapServerPack(data) {
    if (!data || !Array.isArray(data.sentences) || !data.sentences.length) return null;
    return data.sentences.map(function (s) {
      return {
        drill_key: s.drill_key, tense: s.tense, polarity: s.polarity,
        sentence: s.sentence, surface: s.surface,
        base_hint: s.base_hint || '', demo: false
      };
    });
  }

  function fetchServerPack(concept, target, topic) {
    var key = packKey(concept, target, topic);
    if (packCache[key]) return Promise.resolve(packCache[key]);
    if (packInflight[key]) return packInflight[key];
    packInflight[key] = fetch('/api/drills?concept_id=' + encodeURIComponent(concept.id) +
      '&target=' + target + '&topic=' + topic)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var pack = mapServerPack(data);
        if (pack) packCache[key] = pack;
        return pack;
      })
      .catch(function () { return null; })
      .then(function (pack) {
        delete packInflight[key];
        return pack;
      });
    return packInflight[key];
  }

  // Loads a pack: memory/server cache first, demo offline fallback after 8s
  // so a slow LLM never blocks the learner.
  function loadPack(concept, target, topic) {
    var key = packKey(concept, target, topic);
    if (packCache[key]) return Promise.resolve(packCache[key]);
    var server = fetchServerPack(concept, target, topic);
    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 8000); });
    return Promise.race([server, timeout]).then(function (pack) {
      return pack || demoPack(concept, topic);
    });
  }

  function prefetch(concept, target, topic) {
    if (!concept || !concept.id) return;
    fetchServerPack(concept, target, topic);
  }

  // Player: renders one concept's drill sequence into `container`.
  // options: {base, target, topic, concept, autoplay, onDrillGraded(done, total), onAllDone(done, total)}
  var playerSeq = 0; // the newest player() invalidates every stale one (listeners linger on reused containers)
  function player(container, opts) {
    var state = { drills: [], idx: 0, done: 0, total: 0 };
    var seq = ++playerSeq;
    var isLive = function () { return seq === playerSeq; };
    container.innerHTML = '<div class="text-slate-500 text-sm p-6">Đang tải drill…</div>';
    loadPack(opts.concept, opts.target, opts.topic).then(function (pack) {
      if (!isLive()) return;
      state.drills = pack;
      state.total = pack.length;
      var first = pickDrillKey(opts.concept.id, pack, opts.base, opts.target);
      state.idx = pack.findIndex(function (d) { return d.drill_key === first; });
      if (state.idx < 0) state.idx = 0;
      if (opts.onePerConcept) {
        // the /session "nâng cao" segment: just the picked drill, one per concept
        state.drills = [pack[state.idx]];
        state.total = 1;
        state.idx = 0;
      }
      if (opts.onPackLoaded) opts.onPackLoaded(state.total);
      render();
    });

    function current() { return state.drills[state.idx]; }
    var asrHandle = null; // active dictation session (one at a time)
    var resultShown = false;
    var lastCheckedCorrect = false;

    function stopAsr() {
      if (asrHandle) { asrHandle.stop(); asrHandle = null; }
    }

    function render() {
      stopAsr();
      resultShown = false;
      lastCheckedCorrect = false;
      var d = current();
      if (!d) {
        container.innerHTML = '<div class="text-center p-6 text-emerald-400 font-semibold w-full">Xong ' +
          state.total + ' drill.</div>';
        if (opts.onAllDone) opts.onAllDone(state.done, state.total);
        return;
      }
      var due = Srs.isDue(srsId(opts.concept.id, d.drill_key), opts.base, opts.target);
      var polLabel = { affirmative: 'khẳng định', negative: 'phủ định', question: 'câu hỏi' }[d.polarity] || d.polarity;
      // one block wrapper: the host container may be a flex row, and the
      // card must keep its natural top-to-bottom layout at any width
      container.innerHTML = '<div class="w-full" id="drill-wrapper">' +
        '<div class="flex items-center justify-between text-xs text-slate-500 mb-3">' +
        '<div class="flex items-center gap-2">' +
        '<span class="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">' + (state.idx + 1) + '/' + state.total + '</span>' +
        '<span class="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 text-[11px] text-slate-300 font-medium">' + d.tense.replace('_simple', ' ') + ' · ' + polLabel + '</span>' +
        '</div>' +
        '<div>' + (due ? '<span class="text-amber-400 font-medium">⚡ đến hạn ôn</span>' : '<span class="text-slate-500">lần đầu</span>') +
        (d.demo ? ' · <span class="text-slate-600">demo offline</span>' : '') + '</div></div>' +
        '<div class="flex items-center gap-3 flex-wrap mb-1">' +
        '<button id="dl-listen" class="flex items-center gap-1.5 text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3.5 py-2 text-sm font-semibold hover:bg-emerald-500/20 transition whitespace-nowrap">&#128266; Nghe <span class="text-[10px] text-emerald-500/80 font-normal">(Ctrl+Space)</span></button>' +
        '<span class="text-xs text-slate-400 whitespace-nowrap">nghe rồi viết lại câu</span>' +
        '<span id="dl-voice-label" class="ml-auto text-[10px] text-slate-500 font-mono whitespace-nowrap">giọng: ?</span></div>' +
        '<p id="dl-note" class="hidden text-xs text-amber-400/90 mt-2"></p>' +
        '<input id="dl-input" type="text" autocomplete="off" placeholder="Viết lại câu vừa nghe…" ' +
        'class="mt-3 w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition shadow-inner" />' +
        '<div id="dl-asr-note" class="hidden text-xs text-amber-400/90 mt-2"></div>' +
        '<div class="flex gap-2 mt-3 flex-wrap items-center" id="dl-actions">' +
        '<button id="dl-check" class="text-xs font-semibold px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition whitespace-nowrap">Chấm câu <span class="text-[10px] text-emerald-200 font-normal">(Enter)</span></button>' +
        '<button id="dl-reveal" class="text-xs px-3.5 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700/80 text-slate-300 hover:text-white transition whitespace-nowrap">Hiện đáp án</button>' +
        (typeof Asr !== 'undefined' && Asr.isSupported() && Srs.readTtsSettings().micEnabled !== false
          ? '<button id="dl-mic" class="text-xs px-3.5 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 hover:bg-rose-500/20 transition whitespace-nowrap">&#127908; Nói</button>'
          : '') +
        '<span class="text-[11px] text-slate-500 ml-auto hidden sm:inline">Enter (chấm/tiếp) · 1/2/3 (tự chấm)</span>' +
        '</div>' +
        '<div id="dl-result" class="hidden mt-4"></div>' +
        '</div>';
      var input = container.querySelector('#dl-input');
      container.querySelector('#dl-listen').onclick = function () {
        Srs.speak(d.sentence, opts.target, function (msg) {
          var n = container.querySelector('#dl-note');
          if (n) { n.textContent = msg; n.classList.remove('hidden'); }
        }, function (source) {
          var b = container.querySelector('#dl-voice-label');
          if (b) b.textContent = { standard: 'giọng chuẩn (mạng)', browser: 'giọng trình duyệt', none: 'chưa có giọng' }[source] || source;
        });
      };
      container.querySelector('#dl-check').onclick = function () { check(false); };
      container.querySelector('#dl-reveal').onclick = function () { check(true); };
      var micBtn = container.querySelector('#dl-mic');
      if (micBtn) {
        micBtn.onclick = function () {
          if (asrHandle && asrHandle.listening) { stopAsr(); return; }
          asrHandle = Asr.start(input, opts.target, {
            onState: function (on) {
              micBtn.innerHTML = on ? '&#9632; Đang nghe&hellip;' : '&#127908; Nói';
              micBtn.classList.toggle('bg-rose-500/30', on);
            },
            onError: function (msg) {
              var n = container.querySelector('#dl-asr-note');
              if (n && msg) { n.textContent = msg; n.classList.remove('hidden'); }
            }
          });
        };
      }

      // Smooth keyboard flow:
      // First Enter -> check answer
      // Second Enter (if correct) -> auto-grade 'good' and instant advance to next sentence!
      // Keys 1, 2, 3 -> self-grade
      input.onkeydown = function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (resultShown && lastCheckedCorrect) {
            submitGrade('good');
            return;
          }
          check(false);
          return;
        }
        if (resultShown) {
          if (e.key === '1') { e.preventDefault(); submitGrade('hard'); return; }
          if (e.key === '2') { e.preventDefault(); submitGrade('ok'); return; }
          if (e.key === '3') { e.preventDefault(); submitGrade('good'); return; }
        }
      };

      input.focus();

      // Big Tech Flow: Autoplay speech on card appearance
      if (opts.autoplay !== false) {
        setTimeout(function () {
          var listenBtn = container.querySelector('#dl-listen');
          if (listenBtn) listenBtn.click();
        }, 120);
      }
    }

    // Document-level keyboard listener for shortcuts like Ctrl+Space (Replay audio)
    function onDocKeyDown(e) {
      if (!document.body.contains(container) || !isLive()) {
        document.removeEventListener('keydown', onDocKeyDown);
        return;
      }
      // Replay audio: Ctrl+Space or Alt+S
      if ((e.ctrlKey || e.metaKey || e.altKey) && (e.code === 'Space' || e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        var listenBtn = container.querySelector('#dl-listen');
        if (listenBtn) listenBtn.click();
        return;
      }
      // If result is shown and focus is outside input, 1/2/3 and Enter still grade
      if (resultShown && document.activeElement !== container.querySelector('#dl-input')) {
        if (e.key === 'Enter' && lastCheckedCorrect) { e.preventDefault(); submitGrade('good'); return; }
        if (e.key === '1') { e.preventDefault(); submitGrade('hard'); return; }
        if (e.key === '2') { e.preventDefault(); submitGrade('ok'); return; }
        if (e.key === '3') { e.preventDefault(); submitGrade('good'); return; }
      }
    }
    document.addEventListener('keydown', onDocKeyDown);

    function submitGrade(g) {
      if (!isLive()) return;
      var d = current();
      if (!d) return;
      Srs.grade(srsId(opts.concept.id, d.drill_key), g, opts.base, opts.target);
      Srs.sync(opts.base, opts.target);
      state.done += 1;
      state.idx += 1;
      if (opts.onDrillGraded) opts.onDrillGraded(state.done, state.total);
      render();
    }

    function check(revealed) {
      if (!isLive()) return;
      var d = current();
      if (!d) return;
      var attempt = normalize(container.querySelector('#dl-input').value);
      var target = normalize(d.sentence);
      var correct = attempt.length > 0 && attempt === target;
      resultShown = true;
      lastCheckedCorrect = correct;

      var res = container.querySelector('#dl-result');
      res.classList.remove('hidden');
      if (correct) {
        res.innerHTML =
          '<div class="p-4 rounded-xl bg-emerald-950/40 border border-emerald-500/30">' +
          '<div class="flex items-center justify-between text-emerald-400 font-bold text-sm mb-1">' +
          '<span>Đúng! 🎉</span>' +
          '<span class="text-xs font-normal text-emerald-300">(Nhấn Enter lần nữa để sang câu tiếp)</span></div>' +
          '<div class="text-white text-base font-medium font-mono my-1 select-all">' + d.sentence + '</div>' +
          (d.base_hint ? '<div class="text-emerald-300/80 text-xs mt-1">💡 ' + d.base_hint + '</div>' : '') +
          '<div class="text-xs text-slate-400 mt-3 mb-1.5">Tự chấm thẻ này:</div>' +
          '<div class="grid grid-cols-3 gap-2">' +
          '<button data-g="hard" class="dl-g py-2 px-2.5 rounded-lg text-xs font-medium bg-rose-500/10 text-rose-300 border border-rose-500/25 hover:bg-rose-500/20 transition whitespace-nowrap text-center">Chưa (1 ngày)</button>' +
          '<button data-g="ok" class="dl-g py-2 px-2.5 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-300 border border-amber-500/25 hover:bg-amber-500/20 transition whitespace-nowrap text-center">Tạm (3 ngày)</button>' +
          '<button data-g="good" class="dl-g py-2 px-2.5 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 transition whitespace-nowrap text-center shadow-sm">Nhớ (7 ngày) <span class="text-[10px] opacity-75 font-normal">(Enter)</span></button></div>' +
          '</div>';
      } else {
        res.innerHTML =
          '<div class="p-4 rounded-xl bg-rose-950/30 border border-rose-500/30">' +
          '<div class="text-rose-400 font-bold text-sm mb-1">' + (revealed ? 'Đáp án chuẩn:' : 'Chưa đúng — nghe lại rồi thử nữa.') + '</div>' +
          '<div class="text-white text-base font-medium font-mono my-1 select-all">' + d.sentence + '</div>' +
          (d.base_hint ? '<div class="text-slate-400 text-xs mt-1">💡 ' + d.base_hint + '</div>' : '') +
          '<div class="text-xs text-slate-400 mt-3 mb-1.5">Tự chấm thẻ này <span class="text-[10px] text-slate-500">(Phím 1: Chưa · 2: Tạm · 3: Nhớ)</span>:</div>' +
          '<div class="grid grid-cols-3 gap-2">' +
          '<button data-g="hard" class="dl-g py-2 px-2.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30 transition whitespace-nowrap text-center">Chưa (1 ngày) <span class="text-[10px] opacity-75 font-normal">(1)</span></button>' +
          '<button data-g="ok" class="dl-g py-2 px-2.5 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-300 border border-amber-500/25 hover:bg-amber-500/20 transition whitespace-nowrap text-center">Tạm (3 ngày) <span class="text-[10px] opacity-75 font-normal">(2)</span></button>' +
          '<button data-g="good" class="dl-g py-2 px-2.5 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/20 transition whitespace-nowrap text-center">Nhớ (7 ngày) <span class="text-[10px] opacity-75 font-normal">(3)</span></button></div>' +
          '</div>';
      }
      res.querySelectorAll('.dl-g').forEach(function (b) {
        b.onclick = function () {
          submitGrade(b.dataset.g);
        };
      });
    }
  }

  global.DrillUI = {
    normalize: normalize,
    srsId: srsId,
    specsFor: specsFor,
    demoPack: demoPack,
    loadPack: loadPack,
    prefetch: prefetch,
    pickDrillKey: pickDrillKey,
    player: player
  };
})(typeof window !== 'undefined' ? window : globalThis);
