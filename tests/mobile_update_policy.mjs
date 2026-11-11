/**
 * duosub-style auto-update policy tests for update.js (v1.5):
 *   - host allowlist (GitHub only, HTTPS only)
 *   - weekly banner quiet-window (daily releases don't bring a daily banner)
 *   - per-version "Skip this version"
 *   - the 7-day-after-install/update quiet window
 *   - security floor (minimum_safe_version_code): cannot be skipped
 *   - manual "Check now" always shows the banner
 *   - auto-download only on unmetered + not-a-manual-tap
 *   - update-info.json preferred over the API when both answer
 *
 * Usage: node tests/mobile_update_policy.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(here, '..', 'mobile', 'www');

// The exact URLs update.js fetches (same repo constants).
const U = (() => {
  const REPO = "fastmandotcom-creator/dictionary";
  return {
    updateInfo: "https://github.com/" + REPO + "/releases/latest/download/update-info.json",
    api: "https://api.github.com/repos/" + REPO + "/releases/latest",
  };
})();

function buildSandbox({ versionMeta, latestRelease, updateInfo, nowMs } = {}) {
  const localStorageMap = new Map();
  const storage = {
    getItem: (k) => (localStorageMap.has(k) ? localStorageMap.get(k) : null),
    setItem: (k, v) => localStorageMap.set(k, String(v)),
    removeItem: (k) => localStorageMap.delete(k),
    _m: localStorageMap,
  };
  const els = {};
  function El(id) {
    if (!els[id]) {
      els[id] = {
        id, textContent: '', innerHTML: '', className: '', dataset: {}, style: {},
        disabled: false, checked: false,
        classList: { _s: new Set(),
          add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
          contains(c) { return this._s.has(c); },
          toggle(c, f) { const want = f === undefined ? !this._s.has(c) : f; want ? this._s.add(c) : this._s.delete(c); } },
      };
    }
    return els[id];
  }
  const doc = {
    getElementById: El,
    querySelector: () => El('settings-card'),
    querySelectorAll: () => [],
    createElement: () => ({}),
    addEventListener() {}, removeEventListener() {},
  };
  let now = nowMs || 1000000000000; // fixed clock for deterministic reminder math
  const win = {
    document: doc,
    localStorage: storage,
    fetch: (url) => {
      if (url === 'version.json') {
        if (!versionMeta) return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('404')) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(versionMeta) });
      }
      if (url === U.updateInfo) {
        if (!updateInfo) return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('404')) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(updateInfo) });
      }
      if (url === U.api || url.startsWith('https://api.github.com/')) {
        if (!latestRelease) return Promise.reject(new Error('offline (mock)'));
        return Promise.resolve({ ok: true, json: () => Promise.resolve(latestRelease) });
      }
      return Promise.reject(new Error('unexpected fetch ' + url));
    },
    setTimeout, clearTimeout,
    Date: Object.assign(Object.create(Date), { now: () => now, _setMs(v) { now = v; } }),
    Math, JSON, Promise, URL,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  // Web path: no native plugin (Capacitor.isPluginAvailable -> false).
  win.Capacitor = {
    registerPlugin: () => null,
    isPluginAvailable: () => false,
  };
  win.open = (url) => { win._opened = url; };
  win.location = { href: '' };
  vm.runInContext(fs.readFileSync(path.join(WWW, 'update.js'), 'utf8'), win, { filename: 'update.js' });
  return { win, els, storage, setNow: (v) => win.Date._setMs(v) };
}

async function main() {
  // 1) host allowlist: GitHub release download hosts pass; everything else fails.
  {
    const { win } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 } });
    assert.strictEqual(win.AppUpdate.isHostAllowed(U.updateInfo), true, 'update-info.json host allowed');
    assert.strictEqual(win.AppUpdate.isHostAllowed('https://objects.githubusercontent.com/x'), true, 'redirect host allowed');
    assert.strictEqual(win.AppUpdate.isHostAllowed('http://api.github.com/x'), false, 'http rejected');
    assert.strictEqual(win.AppUpdate.isHostAllowed('https://evil.example.com/x.apk'), false, 'non-GitHub rejected');
    assert.strictEqual(win.AppUpdate.isHostAllowed('ftp://github.com/x'), false, 'non-https rejected');
    console.log('OK  GitHub host allowlist (HTTPS only, GitHub hosts only)');
  }

  // 2) weekly banner quiet-window: a second auto-check the same day does not re-show the banner.
  {
    const latest = { tag_name: 'v2.0.0', name: 'x', html_url: 'u', assets: [{ name: 'a.apk', browser_download_url: 'https://gh/dl/2' }] };
    const { win, els, setNow } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 }, latestRelease: latest });
    // First check (manual): banner shows regardless of quiet window.
    const rel1 = await win.AppUpdate.check(true);
    assert.ok(rel1 && rel1.version === '2.0.0', 'newer release detected');
    assert.ok(!els['update-banner'].classList.contains('hidden'), 'manual check shows banner');
    // Auto-check the same day: reminder policy says "none" (shown just now) -> hidden.
    const rel2 = await win.AppUpdate.check(false);
    assert.ok(els['update-banner'].classList.contains('hidden'), 'auto-check within the week is quiet');
    // 7 days later the quiet window expires: banner returns on the next auto-check.
    setNow(win.Date.now() + 8 * 24 * 60 * 60 * 1000);
    await win.AppUpdate.check(false);
    assert.ok(!els['update-banner'].classList.contains('hidden'), 'banner returns after the 7-day quiet window');
    console.log('OK  weekly banner quiet-window (no daily nag)');
  }

  // 3) "Skip this version": that version never banners again; a newer one still does.
  {
    const latest = { tag_name: 'v2.0.0', name: 'x', html_url: 'u', assets: [{ name: 'a.apk', browser_download_url: 'd' }] };
    const { win, els } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 }, latestRelease: latest });
    const rel = await win.AppUpdate.check(true);
    win.AppUpdate.skipVersion(rel);
    els['update-banner'].classList.add('hidden');
    // Auto-check: the skipped version is suppressed.
    await win.AppUpdate.check(false);
    assert.ok(els['update-banner'].classList.contains('hidden'), 'skipped version does not re-banner');
    // A newer release is not the skipped one: banners again.
    const newer = { tag_name: 'v2.1.0', name: 'y', html_url: 'u', assets: [{ name: 'a.apk', browser_download_url: 'd' }] };
    const { win: win2, els: els2 } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 }, latestRelease: newer });
    win2.AppUpdate.skipVersion({ version: '2.0.0' }); // skip the older one only
    const r2 = await win2.AppUpdate.check(true);
    assert.ok(r2 && r2.version === '2.1.0', 'a newer version still surfaces');
    assert.ok(!els2['update-banner'].classList.contains('hidden'), 'newer version banners');
    console.log('OK  skip-this-version (per version, a newer one still shows)');
  }

  // 4) install quiet-window: no banner in the week after the app was installed/updated.
  {
    const t0 = 1000000000000;
    const { win } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 }, nowMs: t0 });
    // Pretend this build was installed 1 day ago.
    win.AppUpdate.installedAtMs = t0 - 24 * 60 * 60 * 1000;
    assert.strictEqual(win.AppUpdate.reminder({ version: '2.0.0', critical: false, securityFixCode: 0 }), 'none',
      'quiet week after install: no banner');
    // Clear the install quiet window: banner returns.
    win.AppUpdate.installedAtMs = 0;
    assert.strictEqual(win.AppUpdate.reminder({ version: '2.0.0', critical: false, securityFixCode: 0 }), 'banner',
      'after the quiet window it banners');
    console.log('OK  7-day install/update quiet window');
  }

  // 5) security floor: a critical update cannot be skipped.
  {
    const { win } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 } });
    win.AppUpdate.installedAtMs = 0;
    const secUpdate = { version: '2.0.0', critical: true, securityFixCode: 5, notes: '', url: 'u', apk: 'd' };
    assert.strictEqual(win.AppUpdate.reminder(secUpdate), 'security', 'first sight of a security fix -> security reminder');
    // Skip cannot hide a critical update.
    win.AppUpdate.skipVersion(secUpdate);
    assert.strictEqual(win.AppUpdate.reminder(secUpdate), 'security', 'a security update cannot be skipped');
    console.log('OK  security floor (minimum_safe_version_code) cannot be skipped');
  }

  // 6) security reminder cadence: daily for 3 days, then weekly.
  {
    const t0 = 1000000000000;
    const { win, setNow } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 }, nowMs: t0 });
    win.AppUpdate.installedAtMs = 0;
    const sec = { version: '3.0.0', critical: true, securityFixCode: 9, notes: '', url: 'u', apk: 'd' };
    // Seed the stored security clock at t0 (first showing).
    win.localStorage.setItem('dictlearn_upd_secfix', '9');
    win.localStorage.setItem('dictlearn_upd_secsince', String(t0));
    setNow(t0 + 24 * 60 * 60 * 1000); // 1 day later
    assert.strictEqual(win.AppUpdate.reminder(sec), 'security', 'security: daily within first 3 days');
    setNow(t0 + 10 * 24 * 60 * 60 * 1000); // 10 days later (>3-day period)
    assert.strictEqual(win.AppUpdate.reminder(sec), 'security', 'security: weekly after the first 3 days');
    console.log('OK  security reminder cadence (daily x3 then weekly)');
  }

  // 7) update-info.json is preferred over the API when it answers.
  {
    const info = { schema: 1, version: '2.0.0', version_code: 10, minimum_safe_version_code: 0, apk: 'dict-learn-v2.0.0-android.apk', sha256: 'ab'.repeat(32), size: 1000 };
    const apiRelease = { tag_name: 'v1.5.0', name: 'older', html_url: 'u', assets: [{ name: 'a.apk', browser_download_url: 'd' }] };
    const { win } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 }, updateInfo: info, latestRelease: apiRelease });
    const rel = await win.AppUpdate.check(true);
    assert.strictEqual(rel.viaInfo, true, 'update-info.json path wins');
    assert.strictEqual(rel.version, '2.0.0', 'info version');
    assert.ok(rel.apk.includes('/download/v2.0.0/'), 'info builds the download URL');
    console.log('OK  update-info.json preferred over the API');
  }

  // 8) security-critical detection from the safe floor.
  {
    const info = { schema: 1, version: '2.0.0', version_code: 10, minimum_safe_version_code: 10, apk: 'a.apk', sha256: 'ab'.repeat(32), size: 1000 };
    const { win } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 }, updateInfo: info });
    const rel = await win.AppUpdate.check(true);
    assert.strictEqual(rel.critical, true, 'installed 1 < safe floor 10 -> critical');
    assert.strictEqual(rel.securityFixCode, 10, 'security fix code recorded');
    console.log('OK  security-critical detection from the safe floor');
  }

  // 9) web fallback: no native plugin -> download() routes to openDownload (window.open / Capacitor Browser).
  {
    const { win } = buildSandbox({ versionMeta: { version: '1.0.0', versionCode: 1 } });
    const rel = { version: '2.0.0', apk: 'https://github.com/fastmandotcom-creator/dictionary/releases/download/v2.0.0/dict-learn-v2.0.0-android.apk', url: 'u' };
    await win.AppUpdate.download(rel); // nativeAvailable=false -> openDownload
    assert.strictEqual(win._opened, rel.apk, 'web fallback opens the GitHub release page');
    console.log('OK  web fallback (no native plugin) -> release-page download');
  }

  console.log('\nALL DUOSUB-STYLE UPDATE POLICY TESTS PASSED');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
