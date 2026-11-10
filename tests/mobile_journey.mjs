/**
 * dict-learn END-USER JOURNEY test (functional E2E in-sandbox).
 *
 * Runs the REAL app.js + srs-store.js + asr-mobile.js + update.js against the
 * REAL 12,000-word dataset, emulating a first-time end user:
 *   boot → onboarding → home stats → study → flip → grade → swipe →
 *   home stats updated → listen/fill/conjugate practice → theme toggle →
 *   auto-update banner (mocked newer GitHub release) → reload → SRS survives.
 *
 * Usage: node tests/mobile_journey.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
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

function sharedStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}

function buildSandbox(storage, { ghRelease } = {}) {
  const doc = {
    _els: {},
    getElementById: (id) => { if (!doc._els[id]) doc._els[id] = new El(id); return doc._els[id]; },
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeValue: t }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  ['base', 'target', 'sessionlen'].forEach((id) => {});
  const els = {};
  IDS.forEach((id) => (els[id] = new El(id)));
  doc._els = els;
  els.base.value = 'vi'; els.target.value = 'en'; els.sessionlen.value = '10';
  els.autoupd.checked = true;
  // mirror index.html: the three practice panels carry class "panel" (+ hidden
  // until opened). Lets the back-press handler's querySelector find them.
  ['drill', 'fillbox', 'conjbox'].forEach((id) => els[id].classList.add('panel'));
  ['drill', 'fillbox', 'conjbox', 'update-banner'].forEach((id) => els[id].classList.add('hidden'));
  // functional querySelector for the one selector the app relies on
  doc.querySelector = (sel) => {
    if (sel === '.panel:not(.hidden)') {
      return ['drill', 'fillbox', 'conjbox']
        .map((id) => els[id])
        .find((el) => el.classList.contains('panel') && !el.classList.contains('hidden')) || null;
    }
    return null;
  };

  const win = {
    document: doc,
    localStorage: storage,
    fetch: (url) => {
      if (typeof url === 'string' && url.startsWith('data/')) {
        const p = path.join(WWW, url);
        return Promise.resolve({ json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8'))) });
      }
      if (url === 'version.json') {
        return Promise.resolve({ json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(WWW, 'version.json'), 'utf8'))) });
      }
      if (url.startsWith('https://api.github.com/')) {
        if (ghRelease) return Promise.resolve({ ok: true, json: () => Promise.resolve(ghRelease) });
        return Promise.reject(new Error('offline (mock)'));
      }
      return Promise.reject(new Error('unexpected fetch ' + url));
    },
    speechSynthesis: { cancel() {}, speak() {} },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    setTimeout, clearTimeout,
    Date, Math, JSON, Promise,
    _winListeners: {},
    addEventListener(t, f) { (win._winListeners[t] = win._winListeners[t] || []).push(f); },
    removeEventListener() {},
    dispatchEvent(t, ev) { (win._winListeners[t] || []).forEach((f) => f(ev)); },
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  ['srs-store.js', 'asr-mobile.js', 'tts.js', 'update.js', 'app.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), win, { filename: f });
  });
  return { win, els };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const storage = sharedStorage();

  // ---------- JOURNEY: first launch ----------
  console.log('STEP 1: first launch');
  let { win, els } = buildSandbox(storage, {});
  await sleep(80);
  assert.ok(els.boot.classList.contains('hidden'), 'boot dismissed');
  assert.ok(!els.top.classList.contains('hidden'), 'header visible');
  assert.ok(!els.home.classList.contains('hidden'), 'home visible');
  assert.ok(!els.onboard.classList.contains('hidden'), 'onboarding card shown for new user');
  assert.strictEqual(String(els['stat-learned'].textContent), '0', 'fresh: 0 learned');
  assert.match(els.startbtn.textContent, /Bắt đầu học/, 'CTA invites first session: ' + els.startbtn.textContent);
  console.log('  home: onboarding + CTA "' + els.startbtn.textContent + '"');

  console.log('STEP 2: dismiss onboarding, start session');
  els.onboardok.dispatch('click');
  assert.ok(els.onboard.classList.contains('hidden'), 'onboarding dismissed (persisted for next launch)');
  els.startbtn.dispatch('click');
  await sleep(80);
  assert.ok(!els.study.classList.contains('hidden'), 'study screen shown');
  const w1 = els.card.dataset.word;
  assert.ok(w1, 'card 1 word: ' + w1);
  assert.ok(els.progress.textContent.includes('1 /'), 'progress "1 / N": ' + els.progress.textContent);

  console.log('STEP 3: flip (no crash) + grade good');
  // NOTE: #base-text/#ex render inside card.innerHTML (a string in the DOM stub),
  // so their toggle can't be tracked — flip is asserted to be non-crashing only.
  els.flip.dispatch('click');
  assert.ok(true, 'flip handler ran without crashing');
  els.b3.dispatch('click');
  await sleep(120);
  assert.ok(els.card.dataset.id, 'next card rendered: ' + els.card.dataset.id);
  const srs1 = JSON.parse(JSON.stringify(await win.SrsStore.get('dict_srs_v2_vi_en')));
  assert.ok(srs1[Object.keys(srs1)[0]], 'SRS persisted via IndexedDB/localStorage backend (' + win.SrsStore.backend + ')');
  const entry = srs1[Object.keys(srs1)[0]];
  assert.strictEqual(entry.grade, 'good', 'grade recorded');

  console.log('STEP 4: swipe right = good');
  const idBefore = els.card.dataset.id;
  els.card.dispatch('pointerdown', { clientX: 10, clientY: 300, pointerId: 1 });
  els.card.dispatch('pointermove', { clientX: 200, clientY: 300, pointerId: 1 });
  els.card.dispatch('pointerup', { clientX: 200, clientY: 300, pointerId: 1 });
  await sleep(100);
  assert.notStrictEqual(els.card.dataset.id, idBefore, 'swipe advanced card');

  console.log('STEP 5: back home — stats reflect session');
  els.homebtn.dispatch('click');
  await sleep(60);
  assert.ok(parseInt(els['stat-learned'].textContent, 10) >= 2, 'home stats: ' + els['stat-learned'].textContent + ' learned');
  assert.ok(parseInt(els['stat-today'].textContent, 10) >= 2, 'today: ' + els['stat-today'].textContent);
  assert.ok(parseInt(els['stat-streak'].textContent, 10) >= 1, 'streak: ' + els['stat-streak'].textContent);
  const barPct = els['learned-bar'].style.width;
  assert.ok(barPct.endsWith('%'), 'progress bar set: ' + barPct);

  console.log('STEP 6: practice from home — listen / fill / conjugate');
  els.listen.dispatch('click');
  await sleep(60);
  assert.ok(!els.drill.classList.contains('hidden'), 'listen panel open');
  assert.ok(/Nghe câu|gõ lại/i.test(els['drill-note'].textContent), 'listen instruction: ' + els['drill-note'].textContent);
  // wrong answer state
  els.typed.value = 'x';
  els.drillcheck.dispatch('click');
  await sleep(20);
  assert.ok(els['drill-note'].className.includes('bad'), 'wrong answer shows red + answer: ' + els['drill-note'].textContent);
  // right answer state: the panel's drill is always the FIRST row of the
  // current card's concept (showListen picks rows[0])
  const rows = JSON.parse(fs.readFileSync(path.join(WWW, 'data/drills.json'), 'utf8'));
  const curId = els.card.dataset.id;
  const curRows = rows[curId] || [];
  assert.ok(curRows.length, 'current card has drill rows: ' + curId);
  els.typed.value = String(curRows[0].s).trim().toLowerCase();
  els.drillcheck.dispatch('click');
  await sleep(20);
  assert.ok(els['drill-note'].className.includes('ok'), 'correct answer shows green: ' + els['drill-note'].textContent);

  els.fillbtn.dispatch('click');
  await sleep(60);
  const fillOpen = !els.fillbox.classList.contains('hidden');
  assert.ok(fillOpen, 'fill panel open');
  if (fillOpen) {
    assert.ok(els['fill-sent'].textContent.includes('____'), 'sentence blanked: ' + els['fill-sent'].textContent);
  }
  els.conjbtn.dispatch('click');
  await sleep(60);
  const conjOpen = !els.conjbox.classList.contains('hidden');
  assert.ok(conjOpen, 'conj panel open');
  if (conjOpen) {
    const nOpts = els['conj-opts'].children.length;
    assert.ok(nOpts >= 2 || els['conj-note'].textContent, 'conj has options or guidance: ' + nOpts);
    if (nOpts >= 2) {
      // pick first option → feedback must show
      const first = els['conj-opts'].children[0];
      const inp = first.querySelector ? null : null;
      // radio: find the input via children? stub: re-dispatch change on last added input is unsupported;
      // instead assert note exists and prompt text is meaningful
      assert.match(els['conj-prompt'].textContent, /HIỆN TẠI|CÂU HỎI/, 'conj prompt: ' + els['conj-prompt'].textContent);
    }
  }

  console.log('STEP 7: theme cycle auto → dark → light');
  assert.strictEqual(localStorage_theme(win), 'auto', 'initial theme default auto');
  els.thmbtn.dispatch('click');
  await sleep(20);
  assert.strictEqual(localStorage_theme(win), 'dark', 'click 1: auto→dark');
  els.thmbtn.dispatch('click');
  await sleep(20);
  assert.strictEqual(localStorage_theme(win), 'light', 'click 2: dark→light');
  els.thmbtn.dispatch('click');
  await sleep(20);
  assert.strictEqual(localStorage_theme(win), 'auto', 'click 3: light→auto');

  console.log('STEP 8: auto-update check (mocked v9.9.9) → banner');
  // fresh sandbox sharing storage, but now with a newer mocked release
  ({ win, els } = buildSandbox(storage, {
    ghRelease: {
      tag_name: 'v9.9.9', name: 'Huge new release',
      html_url: 'https://github.com/x/releases/tag/v9.9.9',
      assets: [{ name: 'dict-learn-v9.9.0-android.apk', browser_download_url: 'https://gh/dl/9' }],
    },
  }));
  await sleep(80);
  const rel = await win.AppUpdate.check(true);
  assert.ok(rel && rel.version === '9.9.9', 'newer release detected');
  assert.ok(rel.apk && rel.apk.includes('/9'), 'apk asset url resolved');
  assert.ok(!els['update-banner'].classList.contains('hidden'), 'update banner visible on home');
  assert.match(els['update-banner'].innerHTML, /v9\.9\.9/, 'banner shows version: ' + els['update-banner'].innerHTML.slice(0, 60));

  console.log('STEP 9: user disables auto-update → persists, banner hides');
  els.autoupd.checked = false;
  els.autoupd.dispatch('change');
  assert.strictEqual(win.AppUpdate.pref(), 'off', 'pref off persisted');
  assert.ok(els['update-banner'].classList.contains('hidden'), 'banner hidden when off');
  els.autoupd.checked = true;
  els.autoupd.dispatch('change');
  assert.strictEqual(win.AppUpdate.pref(), 'on', 'pref back on');

  console.log('STEP 10: reload (fresh context, shared storage) — SRS survives');
  ({ win, els } = buildSandbox(storage, {}));
  await sleep(80);
  const srs2 = JSON.parse(JSON.stringify(await win.SrsStore.get('dict_srs_v2_vi_en')));
  const n2 = Object.keys(srs2).length;
  // Two concepts were graded during the session (step 3 "good" + step 4
  // swipe-right "good"); both must survive the reload through the durable store.
  assert.ok(n2 >= 2, 'SRS survived reload: ' + n2 + ' entries (IndexedDB/localStorage backend: ' + win.SrsStore.backend + ')');
  assert.ok(parseInt(els['stat-learned'].textContent, 10) >= n2, 'home learned reflects stored SRS: ' + els['stat-learned'].textContent + ' >= ' + n2);
  // onboarding should NOT reappear (dismissed persisted)
  assert.ok(els.onboard.classList.contains('hidden'), 'onboarding stays dismissed');

  console.log('STEP 11: back-button behavior (web no-op path, no crash)');
  els.drill.classList.remove('hidden');
  win.dispatchEvent('backbutton', { preventDefault() {} });
  await sleep(20);
  assert.ok(els.drill.classList.contains('hidden'), 'back press closes open panel');

  console.log('\nALL END-USER JOURNEY TESTS PASSED (11 steps, backend=' + win.SrsStore.backend + ')');
}

function localStorage_theme(win) {
  try { return win.localStorage.getItem('dictlearn_theme') || 'auto'; } catch (e) { return 'auto'; }
}

main().catch((e) => { console.error('JOURNEY FAIL:', e); process.exit(1); });
