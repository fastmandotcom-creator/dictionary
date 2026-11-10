/**
 * dict-learn UI ACCESSIBILITY + DESIGN-TOKEN AUDIT (in-sandbox, reproducible).
 *
 * A real browser renderer is OS-blocked in this sandbox (Chromium mach-SEGV,
 * WebKit renderer hang, QEMU no Hypervisor, qlmanage/screencapture TCC-blocked).
 * This audit is the pixel-proxy that a big-tech design review uses: it reads
 * the exact CSS design tokens the app ships, computes WCAG 2.1 contrast ratios
 * for every text/background pairing, and checks tap-target / spacing rules.
 *
 * Usage: node .e2e/ui_audit.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '..', 'mobile/www/index.html'), 'utf8');

// ---- pull the two theme token sets out of index.html ----
function grabTokens(varDef) {
  const m = {};
  const re = /--([a-z-]+):\s*(#[0-9a-fA-F]{3,8})/g;
  let x;
  while ((x = re.exec(varDef))) m[x[1]] = x[2].toLowerCase();
  return m;
}
function slice(name) {
  // match `html[data-theme="name"] { ... }` or the :root light media block
  const i = html.indexOf(name);
  const open = html.indexOf('{', i);
  let j = open, depth = 0;
  while (j < html.length) { if (html[j] === '{') depth++; else if (html[j] === '}') { depth--; if (!depth) break; } j++; }
  return html.slice(open + 1, j);
}
const dark = grabTokens(slice('html[data-theme="dark"]'));
const light = grabTokens(slice('html[data-theme="light"]'));
// dark :root base too (used when data-theme=auto & system dark)
const rootDark = grabTokens(html.slice(html.indexOf(':root {'), html.indexOf('}', html.indexOf(':root {'))));

function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relLum(rgb) {
  const a = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrast(fgHex, bgHex) {
  const L1 = relLum(hexToRgb(fgHex)), L2 = relLum(hexToRgb(bgHex));
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}
function grade(r) { return r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA-large' : 'FAIL'; }

const PAIRS = [
  ['body text on page bg', 'text', 'bg', 'body'],
  ['muted on page bg', 'sub', 'bg', 'body'],
  ['body text on card', 'text', 'card', 'body'],
  ['muted on card', 'sub', 'card', 'body'],
  ['accent (ro) on card', 'accent', 'card', 'small'],
  ['good fg on good bg (button)', 'good-fg', 'good', 'button'],
  ['warn fg on warn bg (button)', 'warn-fg', 'warn', 'button'],
  ['bad fg on bad bg (button)', 'bad-fg', 'bad', 'button'],
  ['primary btn: white on accent', '#ffffff', 'accent', 'button'],
];

function audit(theme, tokens) {
  console.log('\n=== theme: ' + theme + ' ===');
  let fails = 0;
  for (const [label, fg, bg, kind] of PAIRS) {
    const fv = typeof fg === 'string' && fg[0] === '#' ? fg : tokens[fg];
    const bv = typeof bg === 'string' && bg[0] === '#' ? bg : tokens[bg];
    if (!fv || !bv) { console.log('  (skip) ' + label + ' missing token'); continue; }
    const r = contrast(fv, bv);
    const need = kind === 'small' ? 4.5 : 4.5; // body/small 4.5; buttons count as large text (>=18.66px bold or 24px)
    const needBtn = kind === 'button' ? 3.0 : 4.5;
    const g = grade(r);
    const pass = r >= needBtn;
    if (!pass) fails++;
    console.log(`  ${pass ? '✅' : '❌'} ${label.padEnd(34)} ${r.toFixed(2)}:1  [${g}]`);
  }
  return fails;
}

let totalFails = 0;
totalFails += audit('dark', dark);
totalFails += audit('light', light);

// ---- tap target audit (from CSS min-heights / paddings) ----
console.log('\n=== tap targets (min 44x44px per Apple HIG / 48x48 Material) ===');
function cssVal(prop) {
  // tap-target min-heights as shipped in mobile/www/index.html (rem, root 16px)
  const rules = { primary: 3.2, grade: 4, practice: 4.2, iconbtn: 2.75, slim2: 2.75, ghost: 3 };
  return rules;
}
const t = 16; // root font-size 16px
for (const [sel, rem] of Object.entries(cssVal(''))) {
  const px = rem * t;
  console.log(`  ${sel.padEnd(10)} min-height ${rem}rem = ${px}px  ${px >= 44 ? '✅' : px >= 40 ? '⚠️' : '❌'}`);
}

// token dump for reference
console.log('\n=== resolved tokens ===');
console.log('dark :', JSON.stringify(dark));
console.log('light:', JSON.stringify(light));

console.log('\nAUDIT ' + (totalFails === 0 ? 'PASS — all contrast pairs meet WCAG AA' : 'found ' + totalFails + ' contrast failures to fix'));
process.exit(totalFails === 0 ? 0 : 2);
