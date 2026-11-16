/**
 * Comprehensive tests for unified MicAsr adapter (Android DictASR + Web Speech)
 * and international-standard RECORD_AUDIO runtime permission UX.
 *
 * Usage: node tests/mobile_mic_asr.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(here, '..', 'mobile', 'www');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  querySelectorAll() { return []; }
  setPointerCapture() {}
  focus() {}
  appendChild(c) { this.children.push(c); }
  scrollIntoView() {}
}

const IDS = [
  'boot', 'top', 'app', 'progress', 'card', 'base', 'target', 'b1', 'b2', 'b3',
  'b1-sub', 'b2-sub', 'b3-sub', 'undobtn', 'study-bar',
  'flip', 'speak', 'listen', 'fillbtn', 'conjbtn', 'clearbtn', 'mic',
  'mic-perm-box', 'mic-perm-msg', 'mic-grant-btn', 'mic-settings-btn', 'mic-perm-dismiss',
  'drill', 'typed', 'drill-note', 'drillnext', 'fillbox', 'fill-sent', 'fill-input', 'fill-note', 'fillnext',
  'conjbox', 'conj-prompt', 'conj-opts', 'conj-note', 'conjnext', 'back-hint',
  'home', 'study', 'audio-screen', 'onboard', 'onboardok', 'startbtn', 'homebtn', 'swipehint',
  'stat-learned', 'stat-total', 'stat-today', 'stat-streak', 'learned-bar',
  'sessionlen', 'sndbtn', 'thmbtn', 'toast', 'playdrill', 'playfill', 'drillcheck', 'fillcheck',
  'study-listen', 'study-fill', 'study-conj', 'autoupd', 'checkupd', 'verline', 'setbtn', 'update-banner'
];

function createSandbox(opts = {}) {
  const els = {};
  IDS.forEach((id) => (els[id] = new El(id)));
  els.base.value = 'vi';
  els.target.value = 'en';
  els.sessionlen.value = '50';
  ['drill', 'fillbox', 'conjbox', 'mic-perm-box', 'drillnext', 'fillnext', 'conjnext', 'update-banner']
    .forEach((id) => els[id].classList.add('hidden'));

  const docListeners = {};
  const doc = {
    hidden: false,
    _els: els,
    getElementById: (id) => els[id] || null,
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeValue: t }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener() {},
    dispatchDoc(t, ev) { (docListeners[t] || []).forEach((f) => f(ev)); },
    documentElement: { dataset: {}, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } },
  };

  const storage = new Map();
  const win = {
    document: doc,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    fetch: (url) => {
      const p = path.join(WWW, url.replace(/^data\//, 'data/'));
      if (fs.existsSync(p)) {
        return Promise.resolve({ json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) });
      }
      return Promise.resolve({ json: () => Promise.resolve({}) });
    },
    speechSynthesis: { _cancels: 0, cancel() { this._cancels++; }, speak() {} },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    setTimeout, clearTimeout,
    Date, Math, JSON, Promise,
    _winListeners: {},
    addEventListener(t, f) { (win._winListeners[t] = win._winListeners[t] || []).push(f); },
    removeEventListener() {},
    dispatchEvent(t, ev) { (win._winListeners[t] || []).forEach((f) => f(ev)); },
  };
  if (opts.navigator) win.navigator = opts.navigator;
  if (opts.Capacitor) win.Capacitor = opts.Capacitor;
  if (opts.SpeechRecognition) win.SpeechRecognition = opts.SpeechRecognition;
  win.window = win;
  win.globalThis = win;

  vm.createContext(win);
  ['cap-bridge.js', 'srs-store.js', 'asr-mobile.js', 'tts.js', 'app.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), win, { filename: f });
  });
  return { win, doc, els };
}

async function testNativeDictAsrAndPermissions() {
  let permState = 'prompt';
  let asrListeners = [];
  let settingsOpened = 0;
  let startedCalls = [];
  let stopCalls = 0;
  let ttsCancels = 0;
  let pendingPermResolve = null;

  const cap = {
    Plugins: {
      DictTTS: {
        speak: async () => ({ result: 'spoken', engine: 'native', detail: '' }),
        cancel: async () => { ttsCancels++; },
        diagnose: async () => ({ engineCount: 1 }),
      },
      DictASR: {
        isAvailable: async () => ({
          available: true,
          standardAvailable: true,
          onDeviceAvailable: true,
          permission: permState,
        }),
        checkMicPermission: async () => ({ state: permState, granted: permState === 'granted' }),
        requestMicPermission: () => new Promise((res) => {
          if (pendingPermResolve === 'defer') {
            pendingPermResolve = res;
            return;
          }
          permState = 'granted';
          res({ state: 'granted', granted: true });
        }),
        openAppSettings: async () => { settingsOpened++; return { opened: true }; },
        startListening: async (args) => { startedCalls.push(args); return { started: true, onDevice: true }; },
        stopListening: async () => { stopCalls++; },
        addListener: async (name, fn) => {
          if (name === 'asrEvent') asrListeners.push(fn);
          return { remove: () => { asrListeners = asrListeners.filter((x) => x !== fn); } };
        },
      },
      App: { exitApp: async () => {} },
    },
    isPluginAvailable: (n) => Object.prototype.hasOwnProperty.call(cap.Plugins, n),
  };

  const { win, doc, els } = createSandbox({ Capacitor: cap });
  await sleep(80);

  assert.strictEqual(win.MicAsr.supported, true, 'MicAsr.supported true with DictASR');
  assert.strictEqual(win.MicAsr.engine(), 'native', 'MicAsr selects native DictASR engine');

  // Verify full 35-language BCP-47 table parity
  const codes35 = ['en','vi','zh','ja','ko','hi','es','fr','de','pt','ru','ar','bn','id','ms','th','tr','it','nl','pl','uk','el','cs','sv','da','fi','no','hu','ro','he','fa','ur','ta','te','sw'];
  for (const c of codes35) {
    assert.ok(win.MicAsr.bcp47(c).includes('-'), 'bcp47 mapped for ' + c + ' -> ' + win.MicAsr.bcp47(c));
  }
  assert.strictEqual(win.MicAsr.bcp47('no'), 'nb-NO');
  assert.strictEqual(win.MicAsr.bcp47('he'), 'he-IL');
  assert.strictEqual(win.MicAsr.bcp47('zh'), 'zh-CN');

  // Case 1: prompt-with-rationale shows contextual banner before invoking OS dialog
  permState = 'prompt-with-rationale';
  els.listen.dispatch('click');
  await sleep(40);
  els.mic.dispatch('click');
  await sleep(40);
  assert.ok(!els['mic-perm-box'].classList.contains('hidden'), 'rationale banner shown on prompt-with-rationale');
  assert.ok(!els['mic-grant-btn'].classList.contains('hidden'), 'grant button visible in rationale mode');
  assert.ok(els['mic-settings-btn'].classList.contains('hidden'), 'settings button hidden in rationale mode');
  assert.strictEqual(startedCalls.length, 0, 'recognizer NOT started before permission granted');

  // User confirms rationale -> grants -> TTS cancelled -> native SpeechRecognizer starts
  const prevCancels = ttsCancels;
  els['mic-grant-btn'].dispatch('click');
  await sleep(50);
  assert.ok(els['mic-perm-box'].classList.contains('hidden'), 'rationale hidden once granted');
  assert.ok(ttsCancels > prevCancels, 'active TTS cancelled before opening Mic');
  assert.strictEqual(startedCalls.length, 1, 'native startListening called');
  assert.strictEqual(startedCalls[0].lang, 'en-US');
  assert.strictEqual(startedCalls[0].preferOffline, true);
  assert.ok(els.mic.classList.contains('is-listening'), 'mic button shows listening state');

  // Stream partial + deliver final result -> auto-checks and resets mic UI cleanly
  const drills = JSON.parse(fs.readFileSync(path.join(WWW, 'data/drills.json'), 'utf8'));
  const curId = els.card.dataset.id;
  const expectedSent = drills[curId][0].s;

  asrListeners.forEach((fn) => fn({ type: 'partial', text: 'hello' }));
  assert.strictEqual(els.typed.value, 'hello', 'partial transcript reflected in #typed');
  asrListeners.forEach((fn) => fn({ type: 'result', text: expectedSent, matches: [expectedSent] }));
  assert.strictEqual(els.typed.value, expectedSent, 'final transcript written to #typed');
  assert.ok(!els.mic.classList.contains('is-listening'), 'mic listening UI cleared after result');
  assert.ok(els['drill-note'].className.includes('ok'), 'auto-checked correct spoken answer');

  // Case 2: permanently denied -> opens App Settings button -> returning via visibilitychange hides banner
  permState = 'denied';
  els.mic.dispatch('click');
  await sleep(40);
  assert.ok(!els['mic-perm-box'].classList.contains('hidden'), 'perm box shown on permanent denial');
  assert.ok(!els['mic-settings-btn'].classList.contains('hidden'), 'Open Settings button shown on denied');
  assert.ok(els['mic-grant-btn'].classList.contains('hidden'), 'Grant button hidden when denied');
  els['mic-settings-btn'].dispatch('click');
  assert.strictEqual(settingsOpened, 1, 'openAppSettings called on native plugin');

  // User enables mic in Android Settings and comes back to app
  permState = 'granted';
  doc.dispatchDoc('visibilitychange');
  await sleep(40);
  assert.ok(els['mic-perm-box'].classList.contains('hidden'), 'perm banner auto-clears after returning from Settings with grant');
  assert.ok(els['drill-note'].className.includes('ok'), 'status tells user mic is ready');

  // Case 3: closing panel while permission prompt pending must NOT start mic afterwards
  permState = 'prompt';
  pendingPermResolve = 'defer';
  const beforeStartCount = startedCalls.length;
  els.mic.dispatch('click');
  await sleep(30);
  els.clearbtn.dispatch('click'); // user closes #drill while permission dialog open
  const resolver = pendingPermResolve;
  pendingPermResolve = null;
  permState = 'granted';
  resolver({ state: 'granted', granted: true });
  await sleep(40);
  assert.strictEqual(startedCalls.length, beforeStartCount, 'stale permission resolution ignored after panel closed');
  assert.strictEqual(stopCalls, stopCalls, 'no leaked session');

  console.log('OK  Native DictASR + runtime permission lifecycle + race guard');
}

async function testWebSpeechFixes() {
  const instances = [];
  class FakeWebSpeech {
    constructor() {
      this.lang = '';
      this.continuous = true;
      this.interimResults = false;
      this.maxAlternatives = 1;
      instances.push(this);
    }
    start() {
      if (FakeWebSpeech.throwOnStart) throw new Error('busy');
      this.started = true;
      this.onstart && this.onstart({});
    }
    stop() {
      this.stopped = true;
      this.onend && this.onend({});
    }
    abort() { this.aborted = true; }
  }
  FakeWebSpeech.throwOnStart = false;

  const { win, els } = createSandbox({
    SpeechRecognition: FakeWebSpeech,
    navigator: { permissions: { query: async () => ({ state: 'granted' }) } },
  });
  await sleep(80);

  assert.strictEqual(win.MicAsr.engine(), 'web', 'MicAsr selects web SpeechRecognition when Capacitor absent');

  els.listen.dispatch('click');
  await sleep(40);
  els.mic.dispatch('click');
  await sleep(30);

  assert.strictEqual(instances.length, 1, 'Web SpeechRecognition constructed');
  assert.strictEqual(instances[0].continuous, false, 'Web dictation uses continuous=false (no ghost background mic)');
  assert.ok(els.mic.classList.contains('is-listening'), 'UI listening active');

  // Browser auto-stops on silence (onend without final text) -> UI must NOT get stuck
  instances[0].onend({});
  await sleep(20);
  assert.ok(!els.mic.classList.contains('is-listening'), 'onend resets listening UI cleanly (no stuck Dừng button)');
  assert.match(els['drill-note'].textContent, /Chưa nghe rõ|nói lại/, 'clear guidance when ended with no speech');

  // Synchronous recognition.start() throw -> cleanly resets UI & reports error
  FakeWebSpeech.throwOnStart = true;
  els.mic.dispatch('click');
  await sleep(20);
  assert.ok(!els.mic.classList.contains('is-listening'), 'sync start() error resets listening UI');
  assert.ok(els['drill-note'].className.includes('bad'), 'sync start() error surfaced visibly');

  // Web 'not-allowed' surfaces browser guidance banner
  FakeWebSpeech.throwOnStart = false;
  els.mic.dispatch('click');
  await sleep(20);
  const inst = instances[instances.length - 1];
  inst.onerror({ error: 'not-allowed' });
  await sleep(30);
  assert.ok(!els.mic.classList.contains('is-listening'), 'not-allowed stops listening UI');
  assert.match(els['drill-note'].textContent, /Quyền Micro/, 'clear Vietnamese not-allowed message');

  console.log('OK  Web SpeechRecognition continuous=false, onend reset, sync throw & error handling');
}

async function main() {
  await testNativeDictAsrAndPermissions();
  await testWebSpeechFixes();
  console.log('\nALL MIC ASR & PERMISSION TESTS PASSED');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
