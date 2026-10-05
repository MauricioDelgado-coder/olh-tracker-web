/**
 * Adds a "SAN Admin" tile (page.sanadmin) to index.html, right after the
 * SAN MPR (Sandbox) tile. Same mechanics as patch-index-caseaging-tile.js:
 * edit the decoded __bundler/template, verify every anchor is unique, verify
 * the JSON round-trips byte-for-byte before touching the file.
 *
 *   node dev/patch-index-sanadmin-tile.js            # dry run
 *   node dev/patch-index-sanadmin-tile.js --apply    # write
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'index.html');
const APPLY = process.argv.includes('--apply');

const OLD_PERM_LINE = '      canSanMpr: this.can("page.sanmpr"),\n';
const NEW_PERM_LINE = OLD_PERM_LINE + '      canSanAdmin: this.can("page.sanadmin"),\n';

const SAN_TILE_END =
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#005DAA">Open SAN MPR\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n';

const NEW_TILE =
'\n      <sc-if value="{{ canSanAdmin }}" hint-placeholder-val="{{ true }}">\n' +
'      <a href="san-admin.html" style="display:flex;flex-direction:column;padding:20px 20px 22px;border:1px solid #E4DED2;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(27,42,88,.06);transition:box-shadow 200ms cubic-bezier(.2,.6,.2,1),transform 200ms cubic-bezier(.2,.6,.2,1),border-color 200ms cubic-bezier(.2,.6,.2,1)" style-hover="box-shadow:0 12px 28px rgba(27,42,88,.14);transform:translateY(-4px);border-color:#CFE2F1">\n' +
'        <span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:#EAF2F9;color:#005DAA">\n' +
'          <svg width="22" height="22" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"></path><path d="M19 8v6M16 11h6"></path></svg>\n' +
'        </span>\n' +
'        <h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">SAN Admin</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Add SAN users, send invite and password reset links, and deactivate accounts. SAN user accounts only.</p>\n' +
'        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0">\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#F1EBE1;font-size:11px;font-weight:600;line-height:22px;color:#6F6963">San Antonio</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#F1EBE1;font-size:11px;font-weight:600;line-height:22px;color:#6F6963">User accounts</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#005DAA">Manage SAN Users\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n';

function ensureAsciiAndEscapeSlash(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '/') out += '\\u002F';
    else if (code > 126) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out;
}

const content = fs.readFileSync(FILE, 'utf8');
const marker = '<script type="__bundler/template">';
const i = content.indexOf(marker);
if (i === -1) throw new Error('index.html: no __bundler/template block');
const jsonStart = i + marker.length;
const rawJson = content.slice(jsonStart, content.indexOf('</script>', jsonStart));
const template = JSON.parse(rawJson);
if (ensureAsciiAndEscapeSlash(JSON.stringify(template)) !== rawJson) throw new Error('round-trip check failed');

if (template.includes('canSanAdmin')) { console.log('index.html already has the SAN Admin tile.'); process.exit(0); }
for (const [label, s] of [['OLD_PERM_LINE', OLD_PERM_LINE], ['SAN_TILE_END', SAN_TILE_END]]) {
  const n = template.split(s).length - 1;
  if (n !== 1) throw new Error(label + ' found ' + n + ' times, expected 1');
}
const next = template.split(OLD_PERM_LINE).join(NEW_PERM_LINE).split(SAN_TILE_END).join(SAN_TILE_END + NEW_TILE);
const newRaw = ensureAsciiAndEscapeSlash(JSON.stringify(next));
console.log('index.html template ' + template.length + ' -> ' + next.length + ' chars. ' + (APPLY ? 'Applying.' : 'Dry run.'));
if (APPLY) {
  if (content.indexOf(rawJson) !== content.lastIndexOf(rawJson)) throw new Error('raw JSON not unique');
  fs.writeFileSync(FILE, content.split(rawJson).join(newRaw));
  console.log('wrote public/index.html');
}
