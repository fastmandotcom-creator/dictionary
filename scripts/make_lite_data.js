// scripts/make_lite_data.js — build the demo/lite data subset for ?lite=1
// (fast first-launch + E2E screenshot pipeline). Node, no dependencies.
//   node scripts/make_lite_data.js
const fs = require('fs');
const path = require('path');
const D = path.resolve(__dirname, '..', 'mobile', 'www', 'data');
const LITE = path.join(D, 'lite');
const N = 60;

const concepts = JSON.parse(fs.readFileSync(path.join(D, 'concepts.json'), 'utf8'));
const drills = JSON.parse(fs.readFileSync(path.join(D, 'drills.json'), 'utf8'));
const langs = JSON.parse(fs.readFileSync(path.join(D, 'langs.json'), 'utf8'));

// pick concepts that have drill rows; prefer the ones with full 9-row packs
// (verbs/phrases with tense spread) so all three practice modes light up.
let keep = [];
for (const id of concepts) {
  if (drills[id] && drills[id].length) { keep.push(id); if (keep.length >= N * 2) break; }
}
keep = keep
  .map((id) => [id, drills[id].length])
  .sort((a, b) => b[1] - a[1])
  .slice(0, N)
  .map((x) => x[0]);

fs.mkdirSync(path.join(LITE, 'lang'), { recursive: true });
fs.writeFileSync(path.join(LITE, 'concepts.json'), JSON.stringify(keep));
fs.writeFileSync(path.join(LITE, 'langs.json'), JSON.stringify(langs));
fs.writeFileSync(
  path.join(LITE, 'drills.json'),
  JSON.stringify(Object.fromEntries(keep.map((id) => [id, drills[id]])))
);
for (const code of ['vi', 'en']) {
  const full = JSON.parse(fs.readFileSync(path.join(D, 'lang', code + '.json'), 'utf8'));
  const out = {};
  for (const k of ['w', 'e', 'ro', 'ipa']) {
    if (full[k]) {
      out[k] = {};
      for (const id of keep) if (full[k][id] !== undefined) out[k][id] = full[k][id];
    }
  }
  fs.writeFileSync(path.join(LITE, 'lang', code + '.json'), JSON.stringify(out));
}
console.log('lite data: ' + keep.length + ' concepts -> ' + LITE);
