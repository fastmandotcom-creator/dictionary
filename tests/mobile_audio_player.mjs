/* Passive Audio Learning integration & unit tests (v1.9):
 * Exercises the REAL tts.js + audio-player.js + app.js + srs-store.js in a Node VM sandbox:
 *  1. Playlist builder (due/fresh/learned/mix, mastered exclusion, EN-VI drill hygiene)
 *  2. Cognitive step builder (deep/quick/target_only presets, deduplication)
 *  3. Web fallback playback + full app UI (#audiostartbtn -> #audio-screen -> #audio-mini)
 *  4. Dedicated audio stats store isolation (does NOT mutate Flashcard SRS unless autoStageSrs is enabled,
 *     and never overwrites already-graded SRS cards)
 *  5. Native Capacitor Plugins.DictTTS.startAudioQueue + audioState event listener delegation
 *
 * Usage: node tests/mobile_audio_player.mjs
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
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
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.innerHTML = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] || null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatch(t, ev) {
    (this.listeners[t] || []).forEach((f) => f(ev));
    const on = this['on' + t];
    if (typeof on === 'function') on(ev);
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setPointerCapture() {}
  focus() {}
  appendChild(c) { this.children.push(c); }
  scrollIntoView() {}
}

const IDS = [
  'boot', 'top', 'app', 'progress', 'card', 'base', 'target', 'b1', 'b2', 'b3',
  'flip', 'speak', 'listen', 'fillbtn', 'conjbtn', 'clearbtn', 'mic',
  'drill', 'typed', 'drill-note', 'fillbox', 'fill-sent', 'fill-input', 'fill-note',
  'conjbox', 'conj-prompt', 'conj-opts', 'conj-note', 'back-hint',
  'home', 'study', 'onboard', 'onboardok', 'startbtn', 'homebtn', 'swipehint',
  'stat-learned', 'stat-total', 'stat-today', 'stat-streak', 'learned-bar',
  'sessionlen', 'sndbtn', 'thmbtn', 'toast', 'playdrill', 'drillcheck', 'fillcheck',
  'autoupd', 'checkupd', 'verline', 'setbtn', 'update-banner', 'ttstestbtn', 'ttstest',
  // passive audio IDs
  'audiostartbtn', 'audio-home-sub', 'audio-screen', 'audio-homebtn', 'audio-progress',
  'audio-sleep', 'audio-card', 'audio-state-badge', 'audio-word', 'audio-phonetics',
  'audio-meaning', 'audio-ex-target', 'audio-ex-base', 'audio-steps',
  'audio-prev', 'audio-play', 'audio-next', 'audio-stop', 'audio-master', 'audio-prefetch',
  'audio-source', 'audio-preset', 'audio-order-row', 'audio-order', 'audio-target-repeat',
  'audio-speed', 'audio-repeat',
  'audio-drills-row', 'audio-drills', 'audio-offline', 'audio-autostage', 'audio-note',
  'audio-mini', 'audio-mini-open', 'audio-mini-title', 'audio-mini-sub',
  'audio-mini-toggle', 'audio-mini-stop',
];

function buildSandbox({ capacitorPlugin = null, initialStorage = null } = {}) {
  const els = {};
  IDS.forEach((id) => (els[id] = new El(id)));

  // Populate step pills with data-role inside #audio-steps so highlighting can be asserted.
  const stepPills = ['word', 'meaning', 'ex_target', 'ex_base', 'repeat'].map((role) => {
    const p = new El('pill_' + role);
    p.classList.add('audio-step-pill');
    p.setAttribute('data-role', role);
    return p;
  });
  els['audio-steps'].children = stepPills;
  els['audio-steps'].querySelectorAll = (sel) => (sel === '.audio-step-pill' ? stepPills : []);

  els.base.value = 'vi';
  els.target.value = 'en';
  els.sessionlen.value = '10';
  els.autoupd.checked = true;
  els['audio-source'].value = 'due';
  els['audio-preset'].value = 'deep';
  els['audio-order'].value = 'base_first';
  els['audio-target-repeat'].value = '2';
  els['audio-speed'].value = '1';
  els['audio-repeat'].value = 'none';
  els['audio-sleep'].value = '0';

  ['drill', 'fillbox', 'conjbox'].forEach((id) => els[id].classList.add('panel'));
  ['study', 'audio-screen', 'audio-mini', 'drill', 'fillbox', 'conjbox', 'update-banner', 'toast', 'back-hint']
    .forEach((id) => els[id].classList.add('hidden'));

  const docListeners = {};
  const doc = {
    _els: els,
    hidden: false,
    body: { classList: new ClassSet() },
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
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener() {},
    documentElement: { dataset: {}, style: {}, setAttribute() {} },
  };

  const storageMap = new Map(Object.entries(initialStorage || {}));
  const sampleConcepts = ['C_DUE', 'C_HARD', 'C_FRESH_1', 'C_FRESH_2', 'C_MASTERED'];
  const sampleData = {
    'concepts.json': sampleConcepts,
    'langs.json': [
      { code: 'vi', native: 'Tiếng Việt' },
      { code: 'en', native: 'English' },
      { code: 'fr', native: 'Français' },
    ],
    'lang/vi.json': {
      w: {
        C_DUE: 'cảm ơn',
        C_HARD: 'xin lỗi',
        C_FRESH_1: 'xin chào',
        C_FRESH_2: 'tạm biệt',
        C_MASTERED: 'đã thuộc',
      },
      e: {
        C_DUE: 'Cảm ơn bạn rất nhiều.',
        C_HARD: 'Xin lỗi đã làm phiền.',
        C_FRESH_1: 'Xin chào buổi sáng.',
        C_FRESH_2: 'Tạm biệt nhé.',
        C_MASTERED: 'Tôi đã biết từ này.',
      },
    },
    'lang/en.json': {
      w: {
        C_DUE: 'thank you',
        C_HARD: 'excuse me',
        C_FRESH_1: 'hello',
        C_FRESH_2: 'goodbye',
        C_MASTERED: 'mastered',
      },
      ro: { C_HARD: '' },
      ipa: { C_DUE: '/ˈθæŋk juː/', C_HARD: '/ɪkˈskjuːz miː/', C_FRESH_1: '/həˈloʊ/' },
      e: {
        C_DUE: 'Thank you very much.',
        C_HARD: 'Excuse me, sir.',
        C_FRESH_1: 'Hello this morning.',
        C_FRESH_2: 'Goodbye for now.',
        C_MASTERED: 'Mastered already.',
      },
    },
    'drills.json': {
      C_HARD: [
        { s: 'Excuse me tonight.', h: 'Stray tonight leak', p: 'affirmative' },
        { s: 'Excuse me, may I ask?', h: 'Xin lỗi, tôi hỏi một chút được không?', p: 'question' },
      ],
    },
  };

  const spokenUtterances = [];
  const win = {
    document: doc,
    location: { search: '' },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    },
    fetch: (url) => {
      const rel = url.replace(/^data\//, '');
      if (sampleData[rel]) return Promise.resolve({ json: () => Promise.resolve(sampleData[rel]) });
      return Promise.resolve({ json: () => Promise.resolve({}) });
    },
    speechSynthesis: {
      getVoices: () => [{ lang: 'en-US', name: 'English' }, { lang: 'vi-VN', name: 'Vietnamese' }],
      cancel() {},
      speak(u) {
        spokenUtterances.push({ text: u.text, lang: u.lang, rate: u.rate });
        setTimeout(() => { if (typeof u.onend === 'function') u.onend(); }, 2);
      },
    },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    navigator: {
      mediaSession: {
        handlers: {},
        setActionHandler(name, fn) { this.handlers[name] = fn; },
      },
    },
    MediaMetadata: function (m) { Object.assign(this, m); },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Object,
    Array,
    Number,
    String,
    _winListeners: {},
    addEventListener(t, f) { (win._winListeners[t] = win._winListeners[t] || []).push(f); },
    removeEventListener() {},
  };
  if (capacitorPlugin) {
    win.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { DictTTS: capacitorPlugin },
    };
  }
  win.window = win;
  win.globalThis = win;
  vm.createContext(win);
  ['cap-bridge.js', 'srs-store.js', 'asr-mobile.js', 'tts.js', 'audio-player.js', 'app.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), win, { filename: f });
  });
  return { win, doc, els, stepPills, storageMap, spokenUtterances };
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function waitFor(pred, timeoutMs = 4500, diagFn = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  const extra = diagFn ? (' :: ' + JSON.stringify(diagFn())) : '';
  throw new Error('Timed out waiting for condition' + extra);
}

async function testPurePlaylistAndSteps() {
  const { win } = buildSandbox();
  const AP = win.AudioPlayer;
  assert(AP, 'window.AudioPlayer should exist');

  const concepts = ['A_MASTERED', 'B_FRESH', 'C_OK', 'D_DUE', 'E_HARD'];
  const baseData = {
    w: { A_MASTERED: 'm', B_FRESH: 'mới', C_OK: 'ổn', D_DUE: 'đến hạn', E_HARD: 'khó' },
    e: { B_FRESH: 'Ví dụ mới', D_DUE: 'Ví dụ hạn' },
  };
  const targetData = {
    w: { A_MASTERED: 'skipme', B_FRESH: 'fresh', C_OK: 'okay', D_DUE: 'due', E_HARD: 'hard' },
    ro: { B_FRESH: '' },
    ipa: { D_DUE: '/djuː/' },
    e: { B_FRESH: 'Fresh example.', D_DUE: 'Due example.' },
  };
  const drills = {
    D_DUE: [
      { s: 'Due tonight.', h: 'Bad tomorrow string', p: 'affirmative' },
      { s: 'Is this due today?', h: 'Cái này đến hạn hôm nay phải không?', p: 'question' },
      { s: 'This bill is due.', h: 'Hóa đơn này đến hạn.', p: 'affirmative' },
    ],
  };
  const today = todayStr();
  const srs = {
    C_OK: { grade: 'ok', due: '2099-01-01', last: today },
    D_DUE: { grade: 'good', due: '2020-01-01', last: '2020-01-01' },
    E_HARD: { grade: 'hard', due: '2099-01-01', last: today },
  };

  const list = AP.buildPlaylist({
    concepts, baseData, targetData, drills, srs,
    mastered: { A_MASTERED: 1 },
    source: 'due',
    baseLang: 'vi',
    targetLang: 'en',
    limit: 20,
    today,
  });
  assert.deepStrictEqual(
    Array.from(list.map((t) => t.id)),
    ['D_DUE', 'E_HARD', 'C_OK', 'B_FRESH'],
    'due priority order + mastered exclusion'
  );
  assert.strictEqual(list[0].drills.length, 2, 'noisy drill filtered out, 2 clean drills kept');
  assert(!list[0].drills.some((d) => /tomorrow/i.test(d.h)), 'noisy English time-word row removed');

  const frList = AP.buildPlaylist({
    concepts, baseData, targetData, drills, srs,
    mastered: { A_MASTERED: 1 },
    source: 'fresh',
    baseLang: 'vi',
    targetLang: 'fr',
    limit: 20,
    today,
  });
  assert.strictEqual(frList[0].id, 'B_FRESH', 'fresh source starts with unseen words');
  const dueFr = AP.buildPlaylist({
    concepts, baseData, targetData, drills, srs,
    mastered: {},
    source: 'due',
    baseLang: 'vi',
    targetLang: 'fr',
    today,
  });
  assert.strictEqual(dueFr.find((t) => t.id === 'D_DUE').drills.length, 0, 'EN-VI drills suppressed for vi->fr');

  // Cognitive step cadence verification (default: base_first + targetRepeat = 2)
  const deepDefault = AP.buildSteps(list[0], { preset: 'deep', speed: 1.0, includeDrills: true });
  assert.deepStrictEqual(
    Array.from(deepDefault.map((s) => s.role)),
    [
      'meaning', 'word', 'repeat',
      'ex_base', 'ex_target', 'ex_target',
      'drill_base', 'drill_target', 'drill_target',
      'drill_base', 'drill_target', 'drill_target',
    ],
    'default deep preset: primary first -> target spoken 2x for word, example, and drills'
  );
  const quickDefault = AP.buildSteps(list[0], { preset: 'quick', speed: 1.15 });
  assert.deepStrictEqual(
    Array.from(quickDefault.map((s) => s.role)),
    ['meaning', 'word', 'repeat'],
    'default quick preset: primary meaning -> target word 2x'
  );
  const quickSingle = AP.buildSteps(list[0], { preset: 'quick', order: 'base_first', targetRepeat: 1, speed: 1.0 });
  assert.deepStrictEqual(
    Array.from(quickSingle.map((s) => s.role)),
    ['meaning', 'word'],
    'setting override: targetRepeat=1'
  );
  const quickTargetFirst = AP.buildSteps(list[0], { preset: 'quick', order: 'target_first', targetRepeat: 2, speed: 1.0 });
  assert.deepStrictEqual(
    Array.from(quickTargetFirst.map((s) => s.role)),
    ['word', 'meaning', 'repeat'],
    'setting override: target_first + targetRepeat=2'
  );
  const targetOnly = AP.buildSteps(list[0], { preset: 'target_only', speed: 1.0 });
  assert(targetOnly.every((s) => s.lang === 'en'), 'target_only never emits base-language audio');
  assert.deepStrictEqual(
    Array.from(targetOnly.map((s) => s.role)),
    ['word', 'repeat', 'ex_target', 'ex_target'],
    'target_only uses 2x repeats on word + example'
  );
  console.log('OK  AudioPlayer.buildPlaylist + buildSteps');
}

async function testWebPlaybackUiAndSrsIsolation() {
  const { win, doc, els, stepPills, storageMap, spokenUtterances } = buildSandbox({
    initialStorage: {
      srs_dict_srs_v2_vi_en: JSON.stringify({
        C_DUE: { grade: 'hard', due: '2020-01-01', last: '2020-01-01' },
        C_FRESH_2: { grade: 'good', due: '2099-01-01', last: todayStr() },
      }),
      srs_dict_audio_stats_v1_vi_en: JSON.stringify({
        date: todayStr(),
        todayHeardIds: {},
        totalHeard: 2,
        mastered: { C_MASTERED: 1 },
        prefs: { preset: 'quick', speed: 1.15, source: 'due', repeatMode: 'none' },
      }),
    },
  });

  // Wait for boot() promise inside app.js to settle
  await waitFor(
    () => els.boot.classList.contains('hidden') && !els.home.classList.contains('hidden') && els['audio-preset'].value === 'quick',
    3000,
    () => ({ bootHidden: els.boot.classList.contains('hidden'), bootHtml: els.boot.innerHTML, preset: els['audio-preset'].value, stored: storageMap.get('srs_dict_audio_stats_v1_vi_en') })
  );

  // Click home Passive Audio CTA -> switches to #audio-screen and starts speaking track 0 (C_DUE = "thank you")
  els.audiostartbtn.dispatch('click');
  await waitFor(() => win.AudioPlayer.getState().status === 'playing' && spokenUtterances.length >= 1);

  assert(!els['audio-screen'].classList.contains('hidden'), '#audio-screen becomes visible');
  assert(els['audio-mini'].classList.contains('hidden'), 'mini player stays hidden while #audio-screen is visible');
  assert.strictEqual(els['audio-word'].textContent, 'thank you', 'starts with due word first');
  assert(stepPills[1].classList.contains('is-active') || els['audio-meaning'].classList.contains('audio-hl'), 'primary meaning highlighted first');

  // Go Home while playing -> mini player bar appears + body.has-audio-mini added
  els['audio-homebtn'].dispatch('click');
  assert(!els.home.classList.contains('hidden'), 'returned to Home');
  assert(!els['audio-mini'].classList.contains('hidden'), '#audio-mini visible when playing outside #audio-screen');
  assert(doc.body.classList.contains('has-audio-mini'), 'body has-audio-mini toggled on');

  // Wait for first track (quick preset @ 1.15x -> ~2.6s total) to finish at least 1 word & record passive stats
  await waitFor(() => {
    const raw = storageMap.get('srs_dict_audio_stats_v1_vi_en');
    return raw && JSON.parse(raw).totalHeard >= 3;
  }, 6000);

  const statsAfter = JSON.parse(storageMap.get('srs_dict_audio_stats_v1_vi_en'));
  assert(statsAfter.todayHeardIds.C_DUE === 1, 'C_DUE recorded in dedicated audio stats');
  assert.deepStrictEqual(
    spokenUtterances.slice(0, 3).map((u) => u.text),
    ['cảm ơn', 'thank you', 'thank you'],
    'default spoken cadence: primary once then target twice'
  );
  const srsAfter = JSON.parse(storageMap.get('srs_dict_srs_v2_vi_en'));
  assert.strictEqual(srsAfter.C_DUE.due, '2020-01-01', 'passive listening MUST NOT mutate active SRS when autoStageSrs is off');

  // Pause & Stop via mini player
  els['audio-mini-toggle'].dispatch('click');
  assert.strictEqual(win.AudioPlayer.getState().status, 'paused', 'mini toggle paused playback');
  els['audio-mini-stop'].dispatch('click');
  assert.strictEqual(win.AudioPlayer.getState().status, 'idle', 'mini stop returned to idle');
  assert(els['audio-mini'].classList.contains('hidden'), 'mini bar hidden after stop');
  assert(!doc.body.classList.contains('has-audio-mini'), 'body class removed after stop');

  // Now verify autoStageSrs: reopen audio, enable autoStageSrs + switch source to fresh, then press Play to listen C_FRESH_1
  els.audiostartbtn.dispatch('click');
  await waitFor(() => win.AudioPlayer.getState().status === 'playing');
  await els['audio-stop'].onclick();
  els['audio-autostage'].checked = true;
  els['audio-autostage'].dispatch('change');
  els['audio-source'].value = 'fresh';
  await els['audio-source'].dispatch('change');
  await els['audio-play'].onclick();

  await waitFor(
    () => {
      const curSrs = JSON.parse(storageMap.get('srs_dict_srs_v2_vi_en'));
      return !!curSrs.C_FRESH_1;
    },
    6000,
    () => ({ state: win.AudioPlayer.getState(), srs: storageMap.get('srs_dict_srs_v2_vi_en') })
  );
  const srsStaged = JSON.parse(storageMap.get('srs_dict_srs_v2_vi_en'));
  assert.strictEqual(srsStaged.C_FRESH_1.grade, 'hard', 'unseen word staged into SRS when autoStageSrs is enabled');
  assert.strictEqual(srsStaged.C_FRESH_2.grade, 'good', 'existing SRS card NOT overwritten');
  await els['audio-stop'].onclick();
  console.log('OK  Web playback UI, mini player, stats store & SRS isolation + opt-in autoStageSrs');
}

async function testNativePluginDelegation() {
  const calls = [];
  const listeners = {};
  let emittedSeq = 0;

  const mockPlugin = {
    speak: () => Promise.resolve({ ok: true, result: 'spoken', engine: 'google' }),
    cancel: () => Promise.resolve(),
    diagnose: () => Promise.resolve({ engineCount: 1, engineNames: 'Google Speech', networkOnline: true, googleResting: false, cacheCount: 0 }),
    requestNotificationPermission: () => { calls.push('requestNotificationPermission'); return Promise.resolve({ granted: true }); },
    addListener: (eventName, cb) => {
      (listeners[eventName] = listeners[eventName] || []).push(cb);
      return Promise.resolve({ remove: () => {} });
    },
    getAudioState: () => { calls.push('getAudioState'); return Promise.resolve({ status: 'idle', index: 0, total: 0 }); },
    startAudioQueue: (payload) => {
      calls.push({ method: 'startAudioQueue', payload });
      const t0 = payload.tracks[payload.startIndex];
      const snap = {
        status: 'playing',
        index: payload.startIndex,
        total: payload.tracks.length,
        conceptId: t0.id,
        word: t0.word,
        meaning: t0.meaning,
        stepRole: 'word',
        stepText: t0.word,
        stepLang: t0.targetLang,
        heardCount: 0,
        completedSeq: 0,
        lastCompletedConceptId: '',
        sleepRemainingMs: 0,
      };
      (listeners.audioState || []).forEach((fn) => fn(snap));
      return Promise.resolve({ ok: true, state: snap });
    },
    pauseAudio: () => { calls.push('pauseAudio'); return Promise.resolve({ status: 'paused' }); },
    resumeAudio: () => { calls.push('resumeAudio'); return Promise.resolve({ status: 'playing' }); },
    nextAudio: () => { calls.push('nextAudio'); return Promise.resolve({ status: 'playing', index: 1 }); },
    prevAudio: () => { calls.push('prevAudio'); return Promise.resolve({ status: 'playing', index: 0 }); },
    stopAudio: () => { calls.push('stopAudio'); return Promise.resolve({ status: 'idle', stepRole: '', stepText: '' }); },
    updateAudioConfig: (cfg) => { calls.push({ method: 'updateAudioConfig', cfg }); return Promise.resolve(cfg); },
    prefetchAudio: (payload) => { calls.push({ method: 'prefetchAudio', count: payload.tracks.length }); return Promise.resolve({ ok: true, count: payload.tracks.length }); },
  };

  const { win, els, storageMap } = buildSandbox({ capacitorPlugin: mockPlugin });
  await waitFor(() => els.boot.classList.contains('hidden') && !els.home.classList.contains('hidden'));
  assert(win.TTS.audio.available(), 'TTS.audio.available() true with native DictTTS plugin');

  await els.audiostartbtn.dispatch('click');
  await waitFor(() => calls.some((c) => c && c.method === 'startAudioQueue'));

  const startCall = calls.find((c) => c && c.method === 'startAudioQueue');
  assert.strictEqual(calls[1], 'requestNotificationPermission', 'requests POST_NOTIFICATIONS before starting FGS');
  assert(startCall.payload.tracks.length > 0, 'sent built playlist to native Android service');
  assert.strictEqual(els['audio-word'].textContent, startCall.payload.tracks[0].word, 'UI synced from native audioState event');

  // Simulate background completion emitted by AudioLearningService
  emittedSeq++;
  const firstId = startCall.payload.tracks[0].id;
  (listeners.audioState || []).forEach((fn) => fn({
    status: 'playing',
    index: 1,
    total: startCall.payload.tracks.length,
    conceptId: startCall.payload.tracks[1].id,
    word: startCall.payload.tracks[1].word,
    meaning: startCall.payload.tracks[1].meaning,
    stepRole: 'ex_target',
    stepText: startCall.payload.tracks[1].exTarget,
    stepLang: 'en',
    heardCount: 1,
    completedSeq: emittedSeq,
    lastCompletedConceptId: firstId,
  }));

  await waitFor(() => {
    const raw = storageMap.get('srs_dict_audio_stats_v1_vi_en');
    return raw && JSON.parse(raw).totalHeard === 1;
  });
  const nativeStats = JSON.parse(storageMap.get('srs_dict_audio_stats_v1_vi_en'));
  assert.strictEqual(nativeStats.cursorId, firstId, 'saved last completed cursorId from native event');

  // Live config update routes to updateAudioConfig without restarting queue
  assert.strictEqual(startCall.payload.config.order, 'base_first', 'default order sent to native is base_first');
  assert.strictEqual(startCall.payload.config.targetRepeat, 2, 'default targetRepeat sent to native is 2');
  els['audio-speed'].value = '1.15';
  els['audio-speed'].dispatch('change');
  assert(calls.some((c) => c && c.method === 'updateAudioConfig' && c.cfg.speed === 1.15), 'speed change updates native service live');
  els['audio-order'].value = 'target_first';
  els['audio-order'].dispatch('change');
  els['audio-target-repeat'].value = '1';
  els['audio-target-repeat'].dispatch('change');
  assert(calls.some((c) => c && c.method === 'updateAudioConfig' && c.cfg.order === 'target_first' && c.cfg.targetRepeat === 1), 'order and targetRepeat update native service live');
  els['audio-preset'].value = 'target_only';
  els['audio-preset'].dispatch('change');
  assert(els['audio-order-row'].classList.contains('hidden'), 'order setting hidden under target_only preset');

  // Transport controls delegate to native
  await els['audio-play'].onclick();
  assert(calls.includes('pauseAudio'), '#audio-play pauses active native queue');
  await els['audio-next'].onclick();
  assert(calls.includes('nextAudio'), '#audio-next skips on native service');
  await els['audio-prefetch'].onclick();
  assert(calls.some((c) => c && c.method === 'prefetchAudio'), '#audio-prefetch dispatches offline cache warm-up');
  await els['audio-stop'].onclick();
  assert(calls.includes('stopAudio'), '#audio-stop terminates native queue cleanly');
  console.log('OK  Native Android DictTTS.startAudioQueue & audioState listener delegation');
}

async function main() {
  await testPurePlaylistAndSteps();
  await testWebPlaybackUiAndSrsIsolation();
  await testNativePluginDelegation();
  console.log('\nALL PASSIVE AUDIO PLAYER TESTS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
