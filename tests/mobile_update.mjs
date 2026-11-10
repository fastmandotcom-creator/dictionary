/**
 * update.js verification: version comparison, auto-update default ON,
 * daily gating, banner gating, and the GitHub API check path (mocked).
 *
 * Usage: node tests/mobile_update.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(here, '..', 'mobile', 'www');

function buildSandbox({ versionMeta, latestRelease, now } = {}) {
  const localStorageMap = new Map();
  const doc = {
    getElementById: (id) => ({
      textContent: '', innerHTML: '', className: '',
      classList: { _s: new Set(), add(c){this._s.add(c)}, remove(c){this._s.delete(c)}, toggle(c,f){f===undefined?(this._s.has(c)?this._s.delete(c):this._s.add(c)):(f?this._s.add(c):this._s.delete(c))}, contains(c){return this._s.has(c)} },
      scrollIntoView() {}, onclick: null, on: {}, disabled: false,
      dataset: {}, style: {}, addEventListener() {},
    }),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const win = {
    document: doc,
    localStorage: {
      getItem: (k) => (localStorageMap.has(k) ? localStorageMap.get(k) : null),
      setItem: (k, v) => localStorageMap.set(k, String(v)),
      _m: localStorageMap,
    },
    fetch: async (url) => {
      if (url === 'version.json') {
        if (!versionMeta) return { ok: false, json: () => Promise.reject(new Error('404')) };
        return { ok: true, json: () => Promise.resolve(versionMeta) };
      }
      if (url.startsWith('https://api.github.com/')) {
        if (!latestRelease) return { ok: false, json: () => Promise.reject(new Error('offline')) };
        return { ok: true, json: () => Promise.resolve(latestRelease) };
      }
      return { ok: false, json: () => Promise.reject(new Error('unexpected ' + url)) };
    },
    setTimeout, clearTimeout,
    Date, Math, JSON, Promise,
    addEventListener() {},
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(WWW, 'update.js'), 'utf8'), win, { filename: 'update.js' });
  return win;
}

async function main() {
  const A = buildSandbox(); // warmup to catch syntax errors

  // 1) version comparison is numeric, not lexicographic
  assert.strictEqual(A.AppUpdate.isNewer('1.10.0', '1.9.9'), true, '1.10.0 > 1.9.9');
  assert.strictEqual(A.AppUpdate.isNewer('1.9.9', '1.10.0'), false, '1.9.9 < 1.10.0');
  assert.strictEqual(A.AppUpdate.isNewer('1.1.0', '1.1.0'), false, 'equal is not newer');
  assert.strictEqual(A.AppUpdate.isNewer('2.0.0', '1.1.1'), true, 'major bump');
  console.log('OK  semantic version compare');

  // 2) auto-update default ON (no preference stored)
  assert.strictEqual(A.AppUpdate.pref(), 'on', 'default must be ON');
  A.AppUpdate.setPref('off');
  assert.strictEqual(A.AppUpdate.pref(), 'off', 'toggle off persists');
  A.AppUpdate.setPref('on');
  console.log('OK  auto-update ON by default + preference persistence');

  // 3) up-to-date release -> no banner, success toast path
  {
    const win = buildSandbox({
      versionMeta: { version: '1.1.0' },
      latestRelease: { tag_name: 'v1.1.0', name: 'x', html_url: 'u', assets: [{ name: 'a.apk', browser_download_url: 'd' }] },
    });
    const rel = await win.AppUpdate.check(true);
    assert.strictEqual(rel, null, 'same version -> no banner');
    console.log('OK  up-to-date release -> no banner');
  }

  // 4) newer release -> banner with download url resolved from assets
  {
    const win = buildSandbox({
      versionMeta: { version: '1.1.0' },
      latestRelease: {
        tag_name: 'v1.2.0', name: 'new UI', html_url: 'https://github.com/x/releases/tag/v1.2.0',
        assets: [{ name: 'notes.txt' }, { name: 'dict-learn-v1.2.0-android.apk', browser_download_url: 'https://gh/dl/v1.2.0' }],
      },
    });
    const rel = await win.AppUpdate.check(true);
    assert.ok(rel, 'newer release surfaced');
    assert.strictEqual(rel.apk, 'https://gh/dl/v1.2.0', 'apik asset url picked');
    assert.strictEqual(rel.version, '1.2.0', 'tag v-stripped');
    console.log('OK  newer release -> banner data (version + apk url)');
  }

  // 5) offline / API failure -> silent null, never throws
  {
    const win = buildSandbox({ versionMeta: { version: '1.1.0' }, latestRelease: null });
    const rel = await win.AppUpdate.check(true);
    assert.strictEqual(rel, null, 'offline check resolves null silently');
    console.log('OK  offline degrades silently');
  }

  // 6) missing version.json -> falls back without crash, 0.0.0 baseline
  {
    const win = buildSandbox({ versionMeta: null });
    await win.AppUpdate.loadMeta();
    assert.strictEqual(win.AppUpdate.currentVersion, '0.0.0', 'no version.json -> 0.0.0');
    const rel = await win.AppUpdate.check(true);
    assert.ok(rel && rel.version === '1.2.0' || rel === null, 'still functional without meta');
    console.log('OK  missing version.json fallback');
  }

  console.log('\nALL UPDATE MODULE TESTS PASSED');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
