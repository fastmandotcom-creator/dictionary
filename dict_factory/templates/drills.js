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

  // Loads a pack: server cache first (GET /api/drills), demo offline fallback.
  // The fallback kicks in fast (8s) so a slow/unavailable LLM never blocks
  // the learner; the server call may still complete later and fill the cache.
  function loadPack(concept, target, topic) {
    var specs = specsFor(concept);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    return fetch('/api/drills?concept_id=' + encodeURIComponent(concept.id) +
      '&target=' + target + '&topic=' + topic, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && Array.isArray(data.sentences) && data.sentences.length) {
          return data.sentences.map(function (s) {
            return {
              drill_key: s.drill_key, tense: s.tense, polarity: s.polarity,
              sentence: s.sentence, surface: s.surface,
              base_hint: s.base_hint || '', demo: false
            };
          });
        }
        return demoPack(concept, topic);
      })
      .catch(function () { return demoPack(concept, topic); })
      .then(function (pack) {
        if (timer) clearTimeout(timer);
        return pack;
      });
  }

  // Player: renders one concept's drill sequence into `container`.
  // options: {base, target, topic, concept, onDrillGraded(done, total), onAllDone()}
  function player(container, opts) {
    var state = { drills: [], idx: 0, done: 0, total: 0 };
    container.innerHTML = '<div class="text-slate-500 text-sm p-6">Đang tải drill…</div>';
    loadPack(opts.concept, opts.target, opts.topic).then(function (pack) {
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

    function render() {
      var d = current();
      if (!d) {
        container.innerHTML = '<div class="text-center p-6 text-emerald-400 font-semibold">Xong ' +
          state.total + ' drill.</div>';
        if (opts.onAllDone) opts.onAllDone(state.done, state.total);
        return;
      }
      var due = Srs.isDue(srsId(opts.concept.id, d.drill_key), opts.base, opts.target);
      var polLabel = { affirmative: 'khẳng định', negative: 'phủ định', question: 'câu hỏi' }[d.polarity] || d.polarity;
      container.innerHTML =
        '<div class="flex items-center justify-between text-xs text-slate-500 mb-2">' +
        '<span>' + (state.idx + 1) + '/' + state.total + ' · ' + d.tense.replace('_simple', ' ') + ' · ' + polLabel + '</span>' +
        '<span>' + (due ? '<span class="text-amber-400">đến hạn ôn</span>' : 'lần đầu') +
        (d.demo ? ' · <span class="text-slate-600">demo offline</span>' : '') + '</span></div>' +
        '<div class="flex items-center gap-3">' +
        '<button id="dl-listen" class="text-emerald-400 border border-emerald-500/30 rounded-lg px-4 py-2 text-sm hover:bg-emerald-500/10">&#128266; Nghe</button>' +
        '<span class="text-xs text-slate-500">nghe rồi gõ lại câu</span></div>' +
        '<p id="dl-note" class="hidden text-xs text-amber-400/90 mt-2"></p>' +
        '<input id="dl-input" type="text" autocomplete="off" placeholder="Viết lại câu vừa nghe…" ' +
        'class="mt-4 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-emerald-500" />' +
        '<div id="dl-result" class="hidden mt-3"></div>' +
        '<div class="flex gap-2 mt-3">' +
        '<button id="dl-check" class="text-xs font-semibold px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200">Chấm câu</button>' +
        '<button id="dl-reveal" class="text-xs px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-400 hover:text-slate-200">Hiện đáp án</button></div>';
      var input = container.querySelector('#dl-input');
      container.querySelector('#dl-listen').onclick = function () {
        Srs.speak(d.sentence, opts.target, function (msg) {
          var n = container.querySelector('#dl-note');
          if (n) { n.textContent = msg; n.classList.remove('hidden'); }
        });
      };
      container.querySelector('#dl-check').onclick = function () { check(false); };
      container.querySelector('#dl-reveal').onclick = function () { check(true); };
      input.onkeydown = function (e) { if (e.key === 'Enter') check(false); };
      input.focus();
    }

    function check(revealed) {
      var d = current();
      var attempt = normalize(container.querySelector('#dl-input').value);
      var target = normalize(d.sentence);
      var correct = attempt.length > 0 && attempt === target;
      var res = container.querySelector('#dl-result');
      res.classList.remove('hidden');
      res.innerHTML =
        '<div class="' + (correct ? 'text-emerald-400' : 'text-rose-400') + ' font-semibold text-sm">' +
        (correct ? 'Đúng!' : (revealed ? 'Chưa đúng — đáp án:' : 'Chưa đúng — nghe lại rồi thử nữa.')) + '</div>' +
        ((!correct && revealed) ? '<div class="text-slate-300 text-sm mt-1 font-mono">' + d.sentence + '</div>' : '') +
        (d.base_hint ? '<div class="text-slate-500 text-xs mt-1">' + d.base_hint + '</div>' : '') +
        '<div class="text-xs text-slate-500 mt-2">Tự chấm thẻ này:</div>' +
        '<div class="flex gap-2 mt-2">' +
        '<button data-g="hard" class="dl-g px-3 py-1.5 rounded-lg text-xs bg-rose-500/10 text-rose-400 border border-rose-500/20">Chưa (1 ngày)</button>' +
        '<button data-g="ok" class="dl-g px-3 py-1.5 rounded-lg text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20">Tạm (3 ngày)</button>' +
        '<button data-g="good" class="dl-g px-3 py-1.5 rounded-lg text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Nhớ (7 ngày)</button></div>';
      res.querySelectorAll('.dl-g').forEach(function (b) {
        b.onclick = function () {
          Srs.grade(srsId(opts.concept.id, d.drill_key), b.dataset.g, opts.base, opts.target);
          Srs.sync(opts.base, opts.target);
          state.done += 1;
          state.idx += 1;
          if (opts.onDrillGraded) opts.onDrillGraded(state.done, state.total);
          render();
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
    pickDrillKey: pickDrillKey,
    player: player
  };
})(typeof window !== 'undefined' ? window : globalThis);
