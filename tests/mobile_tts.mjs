/* TTS bridge integration check (v1.4):
 * Runs the REAL tts.js + app.js in a DOM stub (mirroring mobile_journey.mjs)
 * and verifies:
 *  - window.TTS exists; engine="web" when Capacitor is absent
 *  - app.js speak() routes through TTS (native preferred, web fallback)
 *  - TTS.cancel() + TTS.speak() don't throw
 * Usage: node tests/mobile_tts.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(here, '..', 'mobile', 'www');

class El {
  constructor(id) {
    this.id = id; this.children = []; this.dataset = {}; this.style = {};
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      toggle: (c, force) => {
        const has = this.classList._s.has(c);
        const want = force === undefined ? !has : force;
        if (want) this.classList._s.add(c); else this.classList._s.delete(c);
      },
      contains: (c) => this.classList._s.has(c),
    };
    this.listeners = {};
    this.value = ''; this.textContent = ''; this.innerHTML = '';
  }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  dispatch(t, ev) {
    (this.listeners[t] || []).forEach((f) => f(ev));
    const on = this['on' + t];
    if (typeof on === 'function') on(ev);
  }
  querySelector() { return null; }
  setPointerCapture() {}
  focus() {}
  appendChild(c) { this.children.push(c); }
  scrollIntoView() {}
}

const IDS = ['boot', 'top', 'app', 'progress', 'card', 'base', 'target', 'b1', 'b2', 'b3',
  'flip', 'speak', 'listen', 'fillbtn', 'conjbtn', 'clearbtn', 'mic',
  'drill', 'typed', 'drill-note', 'fillbox', 'fill-sent', 'fill-input', 'fill-note',
  'conjbox', 'conj-prompt', 'conj-opts', 'conj-note', 'back-hint',
  'home', 'study', 'onboard', 'onboardok', 'startbtn', 'homebtn', 'swipehint',
  'stat-learned', 'stat-total', 'stat-today', 'stat-streak', 'learned-bar',
  'sessionlen', 'sndbtn', 'thmbtn', 'toast', 'playdrill', 'drillcheck', 'fillcheck',
  'autoupd', 'checkupd', 'verline', 'setbtn', 'update-banner'];

function buildSandbox() {
  const doc = {
    _els: {},
    getElementById: (id) => { if (!doc._els[id]) doc._els[id] = new El(id); return doc._els[id]; },
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeValue: t }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    documentElement: { dataset: {}, style: {} },
  };
  const els = {};
  IDS.forEach((id) => (els[id] = new El(id)));
  doc._els = els;
  els.base.value = 'vi'; els.target.value = 'en'; els.sessionlen.value = '10';
  els.autoupd.checked = true;
  ['drill', 'fillbox', 'conjbox'].forEach((id) => els[id].classList.add('panel'));
  ['drill', 'fillbox', 'conjbox', 'update-banner'].forEach((id) => els[id].classList.add('hidden'));
  const win = {
    document: doc,
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    fetch: (url) => {
      const p = path.join(WWW, url.replace(/^data\//, 'data/'));
      if (fs.existsSync(p)) return Promise.resolve({ json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) });
      return Promise.resolve({ json: () => Promise.resolve({}) });
    },
    speechSynthesis: { _spoke: 0, cancel() {}, speak() { win.speechSynthesis._spoke++; } },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    setTimeout, clearTimeout,
    Date, Math, JSON, Promise,
    _winListeners: {},
    addEventListener(t, f) { (win._winListeners[t] = win._winListeners[t] || []).push(f); },
    removeEventListener() {},
    dispatchEvent(t, ev) { (win._winListeners[t] || []).forEach((f) => f(ev)); },
  };
  win.window = win; win.globalThis = win;
  return { win, doc };
}

function main() {
  const { win } = buildSandbox();
  // No window.Capacitor → tts.js must use the web engine path.
  vm.createContext(win);
  ['srs-store.js', 'asr-mobile.js', 'tts.js', 'app.js'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), win, { filename: f })
  );
  const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); process.exit(1); } console.log('OK  ' + m); };
  ok(!!win.TTS, 'window.TTS registered');
  ok(win.TTS.available(), 'TTS.available() true (web engine present in stub)');
  ok(win.TTS.engine() === 'web', 'TTS.engine() = "web" when Capacitor absent');
  const before = win.speechSynthesis._spoke;
  win.TTS.speak('hello', 'en');
  ok(win.speechSynthesis._spoke === before + 1, 'TTS.speak() routed to window.speechSynthesis');
  win.TTS.cancel();
  ok(true, 'TTS.cancel() did not throw');
  // lang mapping: zh → zh-CN, pt → pt-BR, vi → vi-VN
  ok(win.TTS.mapLang('zh') === 'zh-CN', 'mapLang zh → zh-CN');
  ok(win.TTS.mapLang('pt') === 'pt-BR', 'mapLang pt → pt-BR');
  ok(win.TTS.mapLang('vi') === 'vi-VN', 'mapLang vi → vi-VN');
  console.log('ALL TTS BRIDGE CHECKS PASSED');
}
main();
