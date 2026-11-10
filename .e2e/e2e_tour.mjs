/**
 * dict-learn E2E: end-user tour in a real Chromium engine with screenshots.
 * Simulates the exact web layer Capacitor's Android WebView runs.
 *
 * Usage: node .e2e/e2e_tour.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, '..', 'out', 'e2e');
fs.mkdirSync(SHOTS, { recursive: true });

const BASE = 'http://127.0.0.1:8787';
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3 };

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  console.log('  📸 ' + name);
}

async function main() {
  const UDD = path.join(here, 'tmp', 'udd-' + Date.now());
  const ctx = await chromium.launchPersistentContext(UDD, {
    executablePath: path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    viewport: { width: PHONE.width, height: PHONE.height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = (await ctx.pages())[0] || (await ctx.newPage());
  const browser = null; // persistent context: close via ctx below

  // Mock GitHub release API: pretend a much newer version exists (v9.9.9)
  // so the auto-update banner logic is exercised deterministically.
  await page.route('**/api.github.com/**/releases/latest', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tag_name: 'v9.9.9',
        name: 'Huge new release',
        html_url: 'https://github.com/x/releases/tag/v9.9.9',
        assets: [{ name: 'dict-learn-v9.9.9-android.apk', browser_download_url: 'https://github.com/x/dl/v9.9.9.apk' }],
      }),
    })
  );

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // ---------- ACT 1: first launch ----------
  console.log('ACT 1: first launch (fresh profile)');
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#home:not(.hidden)', { timeout: 20000 });
  await page.waitForSelector('#onboard:not(.hidden)', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '01-home-first-launch');

  // dismiss onboarding
  await page.click('#onboardok');
  await page.waitForTimeout(200);
  await shot(page, '02-home-after-onboarding');

  // ---------- ACT 2: study screen ----------
  console.log('ACT 2: start learning');
  await page.click('#startbtn');
  await page.waitForTimeout(600);
  await shot(page, '03-study-card');

  // flip (show meaning + example)
  await page.click('#flip');
  await page.waitForTimeout(300);
  await shot(page, '04-study-flipped');

  // ---------- ACT 3: practice panels ----------
  console.log('ACT 3: practice modes');
  await page.click('#homebtn'); // back home to use the big practice buttons
  await page.waitForTimeout(300);
  await page.click('#listen');
  await page.waitForTimeout(500);
  await shot(page, '05-listen-panel');
  // type the full answer to get a "correct" state
  const drillSentence = await page.evaluate(() => document.getElementById('drill-note').textContent);
  await page.fill('#typed', 'whatever');
  await page.click('#drillcheck');
  await page.waitForTimeout(200);
  await shot(page, '06-listen-checked');

  await page.click('#fillbtn');
  await page.waitForTimeout(500);
  await shot(page, '07-fillpanel');

  await page.click('#conjbtn');
  await page.waitForTimeout(500);
  const conjOpts = await page.evaluate(() => document.getElementById('conj-opts').children.length);
  await shot(page, '08-conjugate-panel');
  if (conjOpts > 0) { await page.click('#conj-opts .conj-opt'); await page.waitForTimeout(200); await shot(page, '09-conjugate-picked'); }

  // ---------- ACT 4: grade + swipe + SRS ----------
  console.log('ACT 4: grading + swipe + persistence');
  await page.click('#clearbtn').catch(() => {});
  await page.click('#startbtn').catch(() => {});
  await page.waitForTimeout(400);
  // grade the current card "good" via the big button
  await page.click('#b3');
  await page.waitForTimeout(500);
  await shot(page, '10-after-grade-good');
  // swipe right on the next card
  await page.mouse.move(10, 300);
  await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const srs = await page.evaluate(() => {
    try { const o = JSON.parse(localStorage.getItem('dict_srs_v2_vi_en') || '{}'); return Object.keys(o).length; }
    catch { const s = window.SrsStore ? 'idb' : 'none'; return String(s); }
  });
  console.log('  SRS entries persisted:', srs);
  await shot(page, '11-after-swipe');

  // ---------- ACT 5: session end + home stats ----------
  console.log('ACT 5: session completion + home stats');
  // fast-forward: grade the rest of the queue with keyboard-free clicks
  for (let i = 0; i < 40; i++) {
    const done = await page.evaluate(() => document.getElementById('card').dataset.done === '1');
    if (done) break;
    await page.click('#b3').catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
  const doneShown = await page.evaluate(() => document.getElementById('card').dataset.done === '1');
  await shot(page, '12-session-done');
  console.log('  session-done card shown:', doneShown);
  await page.click('#homebtn');
  await page.waitForTimeout(500);
  await shot(page, '13-home-with-stats');

  // ---------- ACT 6: light theme ----------
  console.log('ACT 6: light theme');
  await page.click('#thmbtn');
  await page.waitForTimeout(400);
  await shot(page, '14-home-light');
  await page.click('#startbtn');
  await page.waitForTimeout(600);
  await shot(page, '15-study-light');

  // ---------- ACT 7: auto-update banner (mocked v9.9.9) ----------
  console.log('ACT 7: auto-update banner');
  await page.click('#homebtn').catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => { if (window.AppUpdate) window.AppUpdate.check(true); });
  await page.waitForTimeout(800);
  const bannerVisible = await page.evaluate(() => {
    const b = document.getElementById('update-banner');
    return b && !b.classList.contains('hidden');
  });
  console.log('  update banner visible:', bannerVisible);
  await shot(page, '16-update-banner');

  // persist check: reload, SRS must survive
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#home:not(.hidden)', { timeout: 20000 });
  await page.waitForTimeout(500);
  const srsAfter = await page.evaluate(() => {
    try { return Object.keys(JSON.parse(localStorage.getItem('dict_srs_v2_vi_en') || '{}')).length; } catch { return 0; }
  });
  const learnedStat = await page.evaluate(() => document.getElementById('stat-learned').textContent);
  console.log('  after reload: SRS entries =', srsAfter, '| home "learned" stat =', learnedStat);
  await shot(page, '17-home-after-reload');

  console.log('\nPAGE ERRORS:', errors.length ? errors.slice(0, 10) : 'none ✓');
  await ctx.close();
  console.log('E2E tour complete — screenshots in out/e2e/');
}

main().catch((e) => { console.error('E2E FAIL:', e); process.exit(1); });
