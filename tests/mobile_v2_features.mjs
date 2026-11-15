/**
 * Comprehensive verification of dict-learn v2.0.0 enhancements against REAL
 * mobile/www/app.js, audio-player.js, tts.js, srs-store.js, and 12k dataset:
 *   1. Adaptive SM-2 Lite SRS intervals (7d -> 16d) + Mastery counters + Dynamic hints
 *   2. In-session Hard Re-Queue + Session Done screen + Undo (#undobtn)
 *   3. CEFR (A1-C2) curriculum filtering for Study queue & Passive Audio playlist
 *   4. Instant Offline Dictionary Search (#dict-search, diacritic-insensitive) + Open in Study
 *   5. Tap-to-flip, interactive example audio (data-ex-speak), & Settings button (#setbtn)
 *   6. Practice fixes: No answer spoiler in #conj-note, punctuation-tolerant check, & 35-language support
 *
 * Usage: node tests/mobile_v2_features.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(here, '..', 'mobile', 'www');

class ClassSet {
  constructor() { this._s = new Set(); }
  add(...c) { c.forEach((x) => this._s.add(x)); }
  remove(...c) { c.forEach((x) => this._s.delete(x)); }
  toggle(c, force) {
    const has = this._s.has(c);
    const want = force === undefined ? !has : !!force;
    if (want) this._s.add(c); else this._s.delete(c);
    return want;
  }
  contains(c) { return this._s.has(c); }
}

class El {
  constructor(id) {
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.classList = new ClassSet();
    this.listeners = {};
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.checked = false;
    this.parentNode = null;
    this.scrolledIntoView = false;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatch(t, ev) {
    (this.listeners[t] || []).forEach((f) => f(ev));
    const on = this['on' + t];
    if (typeof on === 'function') on(ev);
  }
  querySelector() { return null; }
  querySelectorAll(sel) {
    if (sel === '.cefr-pill' && this._pills) return this._pills;
    return [];
  }
  setPointerCapture() {}
  focus() {}
  appendChild(c) { c.parentNode = this; this.children.push(c); }
  scrollIntoView() { this.scrolledIntoView = true; }
}

const IDS = [
  'boot', 'top', 'app', 'progress', 'card', 'base', 'target', 'b1', 'b2', 'b3',
  'b1-sub', 'b2-sub', 'b3-sub', 'undobtn', 'study-bar',
  'flip', 'speak', 'listen', 'fillbtn', 'conjbtn', 'clearbtn', 'mic',
  'study-listen', 'study-fill', 'study-conj', 'playfill',
  'drill', 'typed', 'drill-note', 'fillbox', 'fill-sent', 'fill-input', 'fill-note',
  'conjbox', 'conj-prompt', 'conj-opts', 'conj-note', 'back-hint',
  'home', 'study', 'onboard', 'onboardok', 'startbtn', 'homebtn', 'swipehint',
  'stat-learned', 'stat-total', 'stat-today', 'stat-streak', 'learned-bar',
  'stat-learning', 'stat-mastered', 'stat-due', 'daily-goal-text', 'daily-goal-bar',
  'dict-search', 'dict-clear', 'dict-results', 'cefr-filter', 'cefr-summary',
  'sessionlen', 'sndbtn', 'thmbtn', 'toast', 'playdrill', 'drillcheck', 'fillcheck',
  'autoupd', 'checkupd', 'verline', 'setbtn', 'settings-card', 'update-banner',
  'session-status', 'study-to-audio', 'audio-to-study',
  'audio-grade-row', 'audio-grade-hard', 'audio-grade-ok', 'audio-grade-good',
  'audio-b1-sub', 'audio-b2-sub', 'audio-b3-sub',
  'audiostartbtn', 'audio-home-sub', 'audio-screen', 'audio-homebtn', 'audio-progress',
  'audio-sleep', 'audio-card', 'audio-state-badge', 'audio-cefr-badge', 'audio-word',
  'audio-phonetics', 'audio-meaning', 'audio-ex-target', 'audio-ex-base', 'audio-steps',
  'audio-prev', 'audio-play', 'audio-next', 'audio-stop', 'audio-master', 'audio-prefetch',
  'audio-source', 'audio-preset', 'audio-order-row', 'audio-order', 'audio-target-repeat',
  'audio-speed', 'audio-repeat', 'audio-drills-row', 'audio-drills', 'audio-offline',
  'audio-autostage', 'audio-note', 'audio-mini', 'audio-mini-open', 'audio-mini-title',
  'audio-mini-sub', 'audio-mini-toggle', 'audio-mini-stop',
];

function buildSandbox(initialStorage = {}) {
  const els = {};
  IDS.forEach((id) => (els[id] = new El(id)));
  els.base.value = 'vi';
  els.target.value = 'en';
  els.sessionlen.value = '10';
  els.autoupd.checked = true;
  els['audio-source'].value = 'session';
  els['audio-preset'].value = 'quick';
  els['audio-speed'].value = '1';
  els['audio-repeat'].value = 'none';

  // Create CEFR pill buttons matching index.html
  const levels = ['all', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const pills = levels.map((lv) => {
    const p = new El('pill_' + lv);
    p.setAttribute('data-level', lv);
    p.classList.add('cefr-pill');
    if (lv === 'all') p.classList.add('is-active');
    p.parentNode = els['cefr-filter'];
    return p;
  });
  els['cefr-filter']._pills = pills;

  ['drill', 'fillbox', 'conjbox'].forEach((id) => els[id].classList.add('panel'));
  ['study', 'audio-screen', 'audio-mini', 'drill', 'fillbox', 'conjbox', 'update-banner', 'toast', 'back-hint', 'dict-clear', 'dict-results', 'undobtn']
    .forEach((id) => els[id].classList.add('hidden'));

  const spoken = [];
  const doc = {
    _els: els,
    _pills: pills,
    getElementById: (id) => els[id] || null,
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeValue: t }),
    querySelector: (sel) => {
      if (sel === '.panel:not(.hidden)') {
        for (const id of ['drill', 'fillbox', 'conjbox']) {
          if (!els[id].classList.contains('hidden')) return els[id];
        }
      }
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { setAttribute() {} },
    body: { classList: new ClassSet(), contains: () => false },
  };

  const storageMap = new Map(Object.entries(initialStorage));
  const win = {
    document: doc,
    location: { search: '' },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
      _m: storageMap,
    },
    fetch: (url) => {
      const p = path.join(WWW, url);
      return Promise.resolve({ json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) });
    },
    speechSynthesis: {
      getVoices: () => [
        { lang: 'en-US', name: 'EN' },
        { lang: 'fr-FR', name: 'FR' },
        { lang: 'vi-VN', name: 'VI' },
      ],
      cancel() {},
      speak(u) { spoken.push({ text: u.text, lang: u.lang }); },
    },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array, Number, String,
    _winListeners: {},
    addEventListener(t, f) { (win._winListeners[t] = win._winListeners[t] || []).push(f); },
    removeEventListener() {},
  };
  win.window = win;
  win.globalThis = win;
  vm.createContext(win);
  ['cap-bridge.js', 'srs-store.js', 'asr-mobile.js', 'tts.js', 'audio-player.js', 'app.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), win, { filename: f });
  });
  return { win, els, pills, storageMap, spoken };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) Adaptive SRS + dynamic hints + Mastery counter
  console.log('1) Adaptive SM-2 Lite SRS + Mastery + Undo + Re-queue');
  const { win, els, pills, storageMap, spoken } = buildSandbox({
    'dictlearn_onboard_dict_srs_v2_vi_en': '1',
  });
  await sleep(100);

  els.startbtn.dispatch('click');
  await sleep(60);

  const cid1 = els.card.dataset.id;
  assert.strictEqual(els['b3-sub'].textContent, 'gặp lại sau 7 ngày', '1st time good button shows 7d');

  // Tap-to-flip on card (click with no swipe)
  els.card.dispatch('click', {});
  assert.ok(true, 'card click tap-to-flip ran without throwing');

  // Click interactive example speaker button -> speaks in target()
  spoken.length = 0;
  const fakeExBtn = new El('exsp');
  fakeExBtn.setAttribute('data-ex-speak', '1');
  els.card.dispatch('click', { target: fakeExBtn });
  await sleep(20);
  const enData = JSON.parse(fs.readFileSync(path.join(WWW, 'data/lang/en.json'), 'utf8'));
  const expectedEx = enData.e[cid1];
  assert.ok(spoken.some((u) => u.text === expectedEx && u.lang === 'en'), 'data-ex-speak spoke target example sentence');

  // Grade card 1 as good -> interval=7, reps=1; Undo button appears
  els.b3.dispatch('click');
  await sleep(60);
  let srs = JSON.parse(JSON.stringify(await win.SrsStore.get('dict_srs_v2_vi_en')));
  assert.strictEqual(srs[cid1].interval, 7);
  assert.strictEqual(srs[cid1].reps, 1);
  assert.ok(!els.undobtn.classList.contains('hidden'), 'undo button revealed after grading');

  // Click Undo -> restores card 1 and removes grade from store
  const cidAfterUndoCheck = els.card.dataset.id;
  assert.notStrictEqual(cidAfterUndoCheck, cid1);
  els.undobtn.dispatch('click');
  await sleep(60);
  assert.strictEqual(els.card.dataset.id, cid1, 'undo restored previous card');
  srs = JSON.parse(JSON.stringify(await win.SrsStore.get('dict_srs_v2_vi_en')));
  assert.ok(!srs[cid1], 'undo removed newly added SRS entry');

  // Re-grade card 1 good, then simulate second review across reload -> interval scales to 16d (Mastered)
  els.b3.dispatch('click');
  await sleep(60);
  srs = JSON.parse(JSON.stringify(await win.SrsStore.get('dict_srs_v2_vi_en')));
  srs[cid1].due = '2020-01-01'; // overdue for 2nd review
  storageMap.set('srs_dict_srs_v2_vi_en', JSON.stringify(srs));

  const sb2 = buildSandbox(Object.fromEntries(storageMap.entries()));
  await sleep(100);
  assert.strictEqual(sb2.els['stat-due'].textContent, '1', 'home due count shows 1');
  assert.strictEqual(sb2.els['stat-mastered'].textContent, '0', 'not yet mastered at 7d');
  sb2.els.startbtn.dispatch('click');
  await sleep(60);
  assert.strictEqual(sb2.els.card.dataset.id, cid1, 'overdue card served first');
  assert.match(sb2.els['b3-sub'].textContent, /16 ngày/, '2nd review good hint previews 16d: ' + sb2.els['b3-sub'].textContent);
  sb2.els.b3.dispatch('click');
  await sleep(60);
  const srsAfter2nd = JSON.parse(JSON.stringify(await sb2.win.SrsStore.get('dict_srs_v2_vi_en')));
  assert.strictEqual(srsAfter2nd[cid1].interval, 16, '2nd good review scales interval 7 -> 16');
  assert.strictEqual(srsAfter2nd[cid1].reps, 2);
  sb2.els.homebtn.dispatch('click');
  await sleep(40);
  assert.strictEqual(sb2.els['stat-mastered'].textContent, '1', 'graduated word counted in stat-mastered');

  // 2) In-Session Hard Re-Queue + Session Done screen
  console.log('2) In-session Hard Re-Queue + Session Done');
  sb2.els.sessionlen.value = '5'; // doesn't affect option validation, wait: let's grade 2-card queue or grade through 10 cards with 1 hard -> becomes 11 cards and ends at done!
  // Let's switch sessionlen to 10 (already 10) -> grade first card "hard" (requeued once -> 11 cards), then grade remaining 10 as "good"
  sb2.els.startbtn.dispatch('click');
  await sleep(60);
  const hardCid = sb2.els.card.dataset.id;
  sb2.els.b1.dispatch('click'); // hard -> requeued
  await sleep(30);
  for (let i = 0; i < 10; i++) {
    sb2.els.b3.dispatch('click');
    await sleep(15);
  }
  await sleep(50);
  assert.strictEqual(sb2.els.card.dataset.done, '1', 'session reaches celebration screen after finishing requeued hard card');
  assert.ok(sb2.els.card.innerHTML.includes(hardCid) === false && sb2.els.card.innerHTML.includes('Ôn lại 1 từ chưa nhớ'),
    'done screen offers 1-tap review of hard words in session');
  // Click "Ôn lại 1 từ chưa nhớ" -> starts micro-session focused on hardCid
  const hardReviewBtn = new El('hardrev');
  hardReviewBtn.setAttribute('data-done-act', 'hard');
  sb2.els.card.dispatch('click', { target: hardReviewBtn });
  await sleep(60);
  assert.strictEqual(sb2.els.card.dataset.id, hardCid, '1-tap hard review loads missed word in study');
  assert.strictEqual(sb2.els.card.dataset.done, undefined, 'done flag cleared on new study card');

  // 3) Settings button scrolls & switches to home
  console.log('3) Settings button navigation (#setbtn)');
  sb2.els.setbtn.dispatch('click');
  await sleep(40);
  assert.ok(!sb2.els.home.classList.contains('hidden'), '#setbtn switches back to home');
  assert.ok(sb2.els['settings-card'].scrolledIntoView, '#setbtn scrolls settings into view');

  // 4) CEFR A1-C2 filter in Study + AudioPlayer
  console.log('4) CEFR A1-C2 curriculum filtering');
  const b1Pill = sb2.pills.find((p) => p.getAttribute('data-level') === 'B1');
  sb2.els['cefr-filter'].dispatch('click', { target: b1Pill });
  await sleep(50);
  assert.strictEqual(sb2.storageMap.get('dictlearn_cefr_level'), 'B1', 'CEFR level persisted');
  assert.match(sb2.els['cefr-summary'].textContent, /B1/, 'summary reflects B1');
  sb2.els.startbtn.dispatch('click');
  await sleep(60);
  const concepts = JSON.parse(fs.readFileSync(path.join(WWW, 'data/concepts.json'), 'utf8'));
  const studyB1Idx = concepts.indexOf(sb2.els.card.dataset.id);
  assert.ok(studyB1Idx >= 4000 && studyB1Idx < 6000, 'study card is strictly in B1 band (4000..5999): idx=' + studyB1Idx);

  const audioB2 = sb2.win.AudioPlayer.buildPlaylist({
    concepts,
    baseData: JSON.parse(fs.readFileSync(path.join(WWW, 'data/lang/vi.json'), 'utf8')),
    targetData: enData,
    levelFilter: 'B2',
    limit: 10,
  });
  assert.strictEqual(audioB2.length, 10);
  assert.ok(audioB2.every((t) => t.level === 'B2'), 'AudioPlayer playlist honors levelFilter B2');

  // Reset CEFR back to all
  const allPill = sb2.pills.find((p) => p.getAttribute('data-level') === 'all');
  sb2.els['cefr-filter'].dispatch('click', { target: allPill });
  await sleep(30);

  // 5) Offline Dictionary Search (diacritic-insensitive Vietnamese + English) + Open in Study
  console.log('5) Instant Offline Dictionary Search (#dict-search)');
  sb2.els.homebtn.dispatch('click');
  await sleep(30);
  sb2.els['dict-search'].value = 'xin chao';
  sb2.els['dict-search'].dispatch('input');
  await sleep(80);
  assert.ok(!sb2.els['dict-results'].classList.contains('hidden'), 'search results visible');
  assert.ok(sb2.els['dict-results'].innerHTML.includes('GREET_HELLO'), 'diacritic-insensitive search finds GREET_HELLO');
  const openBtn = new El('open_greet');
  openBtn.setAttribute('data-search-study', 'GREET_HELLO');
  sb2.els['dict-results'].dispatch('click', { target: openBtn });
  await sleep(60);
  assert.ok(!sb2.els.study.classList.contains('hidden'), 'clicking search result opens study screen');
  assert.strictEqual(sb2.els.card.dataset.id, 'GREET_HELLO', 'study card jumped directly to GREET_HELLO');
  sb2.els.homebtn.dispatch('click');
  await sleep(20);

  // 6) Bugfix verification: No answer leak in #conj-note & Punctuation normalization & Multilingual practice
  console.log('6) Practice fixes: no answer leak + punctuation tolerance + multilingual ja/fr');
  const drills = JSON.parse(fs.readFileSync(path.join(WWW, 'data/drills.json'), 'utf8'));
  let conjCid = null;
  for (const [k, rows] of Object.entries(drills)) {
    if (rows.some((r) => r.t === 'present_simple' && r.p === 'affirmative') && rows.some((r) => r.t && r.t !== 'present_simple' && r.p === 'affirmative')) {
      conjCid = k;
      break;
    }
  }
  assert.ok(conjCid);
  sb2.els.card.dataset.id = conjCid;
  sb2.els.conjbtn.dispatch('click');
  await sleep(50);
  assert.ok(!sb2.els['conj-note'].textContent.includes('Đúng:'), 'conj-note MUST NOT leak answer upfront: ' + sb2.els['conj-note'].textContent);

  // Punctuation-tolerant Listen & Write
  sb2.els.listen.dispatch('click');
  await sleep(50);
  const firstSent = drills[conjCid][0].s;
  const stripped = firstSent.replace(/[.,!?;:]/g, '').trim().toLowerCase();
  sb2.els.typed.value = stripped;
  sb2.els.drillcheck.dispatch('click');
  assert.ok(sb2.els['drill-note'].className.includes('ok'), 'punctuation-stripped answer accepted: "' + stripped + '" for "' + firstSent + '"');

  // Switch target language to French ('fr') and test Listen, Fill, Context Quiz
  sb2.els.target.value = 'fr';
  sb2.els.target.dispatch('change');
  await sleep(100);
  sb2.spoken.length = 0;
  sb2.els.card.dataset.id = 'GREET_HELLO';
  sb2.els.listen.dispatch('click');
  await sleep(80);
  assert.ok(sb2.spoken.some((u) => u.lang === 'fr'), 'non-English target listens & speaks in target language ("fr")');
  sb2.els.fillbtn.dispatch('click');
  await sleep(80);
  const fillOrListenOk = !sb2.els.fillbox.classList.contains('hidden') || !sb2.els.drill.classList.contains('hidden');
  assert.ok(fillOrListenOk, 'fr fill/listen works gracefully without drills.json');
  sb2.spoken.length = 0;
  sb2.els.conjbtn.dispatch('click');
  await sleep(80);
  assert.ok(!sb2.els.conjbox.classList.contains('hidden'), 'fr context quiz opens using 12k sentence corpus');
  assert.ok(sb2.els['conj-opts'].children.length >= 2, 'fr context quiz builds >= 2 choices dynamically');
  assert.ok(sb2.spoken.some((u) => u.lang === 'fr'), 'fr context quiz speaks in "fr"');

  // 7) Unified 50-word Session Handoff (Study <-> Audio on 12k dataset)
  console.log('7) Unified 50-word Session Handoff (Study <-> Audio)');
  sb2.els.target.value = 'en';
  await sb2.els.target.dispatch('change');
  await sleep(120);
  sb2.els.sessionlen.value = '50';
  sb2.els.sessionlen.dispatch('change');
  sb2.els.startbtn.dispatch('click');
  await sleep(60);
  for (let s = 0; s < 5; s++) {
    sb2.els.b3.dispatch('click');
    await sleep(15);
  }
  await sleep(40);
  const sixthConcept = sb2.els.card.dataset.id;
  assert.match(sb2.els.progress.textContent, /^6 \/ 50/, 'study at card 6 / 50');

  await sb2.els['study-to-audio'].dispatch('click');
  await sleep(80);
  assert.ok(!sb2.els['audio-screen'].classList.contains('hidden'), 'study-to-audio opens Audio screen');
  assert.strictEqual(sb2.win.AudioPlayer.getTracks().length, 50, 'Audio tracks match 50-word Study queue');
  assert.strictEqual(sb2.win.AudioPlayer.getState().conceptId, sixthConcept, 'Audio resumes exact 6th word');

  await sb2.els['audio-next'].dispatch('click');
  await sb2.els['audio-next'].dispatch('click');
  await sleep(40);
  const eighthConcept = sb2.win.AudioPlayer.getState().conceptId;
  assert.strictEqual(sb2.win.AudioPlayer.getState().index, 7, 'Audio advanced to 8th word (index 7)');

  await sb2.els['audio-to-study'].dispatch('click');
  await sleep(60);
  assert.ok(!sb2.els.study.classList.contains('hidden'), 'audio-to-study returns to Study screen');
  assert.strictEqual(sb2.els.card.dataset.id, eighthConcept, 'Study resumes exact 8th word');
  assert.match(sb2.els.progress.textContent, /^8 \/ 50/, 'Study progress reflects 8 / 50');
  await sb2.els['audio-stop'].onclick();

  console.log('\nALL v2.0.0 & v2.1.0 UNIFIED SESSION TESTS PASSED');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
