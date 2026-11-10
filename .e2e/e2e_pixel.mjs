/**
 * dict-learn PIXEL E2E (WebKit headless) — screenshots of every screen.
 * Uses ?lite=1 (60-concept demo subset) so boot is instant.
 * Screens: home-first-launch, home-stats, study-card, study-flipped,
 * listen-panel, fill-panel, conj-panel, session-done, light-theme, update-banner.
 */
import { webkit } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'out', 'e2e');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8787/?lite=1';
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3 };

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('  📸 ' + name);
}

async function main() {
  const browser = await webkit.launch({ headless: true });
  const ctx = await browser.newContext({
    ...PHONE,
    viewport: { width: PHONE.width, height: PHONE.height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // mock GitHub API -> newer release banner
  await page.route('**/api.github.com/**/releases/latest', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tag_name: 'v9.9.9',
        name: 'Huge new release',
        html_url: 'https://github.com/x/releases/tag/v9.9.9',
        assets: [{ name: 'dict-learn-v9.9.9-android.apk', browser_download_url: 'https://gh/dl/9.apk' }],
      }),
    })
  );

  console.log('ACT 1: first launch');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#home:not(.hidden)', { timeout: 60000 });
  await page.waitForTimeout(600);
  await shot(page, '01-home-first-launch');

  console.log('ACT 2: dismiss onboarding');
  await page.click('#onboardok');
  await page.waitForTimeout(300);
  await shot(page, '02-home-no-onboarding');

  console.log('ACT 3: study + flip + grade');
  await page.click('#startbtn');
  await page.waitForTimeout(700);
  await shot(page, '03-study-card');
  await page.click('#flip');
  await page.waitForTimeout(400);
  await shot(page, '04-study-flipped');
  await page.click('#b3');
  await page.waitForTimeout(500);

  console.log('ACT 4: swipe right (good)');
  const box = await page.locator('#card').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  for (let x = box.x + 20; x <= box.x + box.width - 20; x += 25) await page.mouse.move(x, y);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await shot(page, '05-after-swipe');

  console.log('ACT 5: practice panels');
  await page.click('#homebtn');
  await page.waitForTimeout(300);
  await page.click('#listen');
  await page.waitForTimeout(500);
  await shot(page, '06-listen-panel');
  const drillRow = await page.evaluate(() => {
    const m = document.getElementById('drill-note').textContent;
    return m;
  });
  // type the correct answer (grab from the app's own drills store)
  await page.evaluate(() => {
    // drills live in the module closure; read the visible panel state via the row speak hint:
    // simplest: fill the expected answer from the note text "Đáp án: ..." if shown after a wrong try
  });
  await page.fill('#typed', 'x');
  await page.click('#drillcheck');
  await page.waitForTimeout(250);
  const wrongNote = await page.locator('#drill-note').textContent();
  await page.evaluate((ans) => {
    const m = String(ans).match(/Đáp án: (.*)/);
    if (m) document.getElementById('typed').value = m[1].trim();
  }, wrongNote);
  await page.click('#drillcheck');
  await page.waitForTimeout(250);
  await shot(page, '07-listen-checked');

  await page.click('#fillbtn');
  await page.waitForTimeout(500);
  await shot(page, '08-fill-panel');
  await page.click('#conjbtn');
  await page.waitForTimeout(500);
  await shot(page, '09-conj-panel');

  console.log('ACT 6: finish session (grade all)');
  for (let i = 0; i < 30; i++) {
    const done = await page.evaluate(() => document.getElementById('card').dataset.done === '1');
    if (done) break;
    await page.click('#b3');
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  await shot(page, '10-session-done');

  console.log('ACT 7: home with stats');
  await page.click('#homebtn');
  await page.waitForTimeout(400);
  await shot(page, '11-home-stats');

  console.log('ACT 8: light theme');
  await page.click('#thmbtn');
  await page.waitForTimeout(300);
  // may be dark now (first click auto->dark). Cycle to light.
  const theme = await page.evaluate(() => localStorage.getItem('dictlearn_theme'));
  if (theme !== 'light') { await page.click('#thmbtn'); await page.waitForTimeout(300); }
  await shot(page, '12-home-light');
  await page.click('#startbtn');
  await page.waitForTimeout(600);
  await shot(page, '13-study-light');

  console.log('ACT 9: auto-update banner');
  await page.click('#homebtn');
  await page.waitForTimeout(300);
  await page.evaluate(() => { if (window.AppUpdate) window.AppUpdate.check(true); });
  await page.waitForTimeout(900);
  const banner = await page.evaluate(() => {
    const b = document.getElementById('update-banner');
    return b && !b.classList.contains('hidden');
  });
  console.log('  banner visible:', banner);
  await shot(page, '14-update-banner');

  console.log('\nPAGE ERRORS:', errors.length ? errors.slice(0, 5) : 'none ✓');
  await browser.close();
  console.log('PIXEL E2E complete — screenshots in out/e2e/');
}

main().catch((e) => { console.error('PIXEL E2E FAIL:', e); process.exit(1); });
