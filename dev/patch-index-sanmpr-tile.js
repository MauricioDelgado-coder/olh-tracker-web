/**
 * Drops "Sandbox" from the SAN MPR tile on index.html: title "SAN MPR",
 * new description, and the "Sandbox" badge removed. Same template-edit
 * mechanics as patch-index-sanadmin-tile.js.
 *
 *   node dev/patch-index-sanmpr-tile.js [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'index.html');
const APPLY = process.argv.includes('--apply');
const EDITS = [
  ['color:#303030">SAN MPR (Sandbox)</h2>', 'color:#303030">SAN MPR</h2>'],
  ['text-wrap:pretty">San Antonio tracker sandbox -- same layout, isolated Airtable data. Nothing here reads from or writes to the live OLH tracker.</p>',
   'text-wrap:pretty">San Antonio QA & Closing tracker, running on its own Airtable base. Nothing here reads from or writes to the OLH tracker.</p>'],
  ['          <span style="height:22px;padding:0 9px;border-radius:999px;background:#F1EBE1;font-size:11px;font-weight:600;line-height:22px;color:#6F6963">Sandbox</span>\n', '']
];

function enc(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '/') out += '\\u002F';
    else if (c > 126) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out;
}

const content = fs.readFileSync(FILE, 'utf8');
const marker = '<script type="__bundler/template">';
const start = content.indexOf(marker) + marker.length;
const raw = content.slice(start, content.indexOf('</script>', start));
let t = JSON.parse(raw);
if (enc(JSON.stringify(t)) !== raw) throw new Error('round-trip check failed');
for (const [a, b] of EDITS) {
  const n = t.split(a).length - 1;
  if (n !== 1) throw new Error('expected 1 of ' + JSON.stringify(a.slice(0, 60)) + ', found ' + n);
  t = t.split(a).join(b);
}
console.log((APPLY ? 'Applying' : 'Dry run') + ': ' + EDITS.length + ' edits verified unique.');
if (APPLY) {
  if (content.indexOf(raw) !== content.lastIndexOf(raw)) throw new Error('raw JSON not unique');
  fs.writeFileSync(FILE, content.split(raw).join(enc(JSON.stringify(t))));
  console.log('wrote public/index.html');
}
