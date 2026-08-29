/**
 * Add two new home tiles to index.html: Daily Summary and Monthly One-on-One.
 * Follows the exact pattern of patch-index-caseaging-tile.js -- gzip-free,
 * inside the __bundler/template JSON string.
 *
 * Inserted right after the Case Aging Exception tile's closing </sc-if>.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

const OLD_PERM_LINE = 'canCaseAging: this.can("page.caseaging"),\n';
const NEW_PERM_LINE = OLD_PERM_LINE +
  '      canDailySummary: this.can("page.dailysummary"),\n' +
  '      canMonthly1on1: this.can("page.monthly1on1"),\n';

const ANCHOR_OLD =
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#7F1D1D">Request Exception\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n' +
'\n' +
'      <sc-if value="{{ canBonusApproval }}" hint-placeholder-val="{{ true }}">';

const TILE_DAILY_SUMMARY =
'<sc-if value="{{ canDailySummary }}" hint-placeholder-val="{{ true }}">\n' +
'      <a href="daily-summary.html" style="display:flex;flex-direction:column;padding:20px 20px 22px;border:1px solid #E4DED2;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(27,42,88,.06);transition:box-shadow 200ms cubic-bezier(.2,.6,.2,1),transform 200ms cubic-bezier(.2,.6,.2,1),border-color 200ms cubic-bezier(.2,.6,.2,1)" style-hover="box-shadow:0 12px 28px rgba(27,42,88,.14);transform:translateY(-4px);border-color:#C6D8F3">\n' +
'        <span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:#EAF1FB;color:#1B3E7C">\n' +
'          <svg width="22" height="22" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12h6M9 16h6M9 8h2"></path><path d="M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"></path></svg>\n' +
'        </span>\n' +
'        <h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">Daily Summary</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Submit your end-of-shift report -- aged cases, open work orders, and anything a supervisor should know.</p>\n' +
'        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0">\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#EAF1FB;font-size:11px;font-weight:600;line-height:22px;color:#1B3E7C">Aged cases</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#EAF1FB;font-size:11px;font-weight:600;line-height:22px;color:#1B3E7C">Work orders</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#1B3E7C">Submit Report\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n' +
'\n' +
'      <sc-if value="{{ canMonthly1on1 }}" hint-placeholder-val="{{ true }}">\n' +
'      <a href="monthly-1on1.html" style="display:flex;flex-direction:column;padding:20px 20px 22px;border:1px solid #E4DED2;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(27,42,88,.06);transition:box-shadow 200ms cubic-bezier(.2,.6,.2,1),transform 200ms cubic-bezier(.2,.6,.2,1),border-color 200ms cubic-bezier(.2,.6,.2,1)" style-hover="box-shadow:0 12px 28px rgba(27,42,88,.14);transform:translateY(-4px);border-color:#C6E6D2">\n' +
'        <span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:#EAF6EE;color:#1E5B34">\n' +
'          <svg width="22" height="22" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"></circle><path d="M4 20c0-3.3 2.7-5 5-5s5 1.7 5 5"></path><path d="M16 13c1.8.3 3 1.6 3 4"></path><circle cx="16" cy="7" r="2.4"></circle></svg>\n' +
'        </span>\n' +
'        <h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">Monthly One-on-One</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Log your metrics and challenges before the meeting, then work through support needed with your manager.</p>\n' +
'        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0">\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#EAF6EE;font-size:11px;font-weight:600;line-height:22px;color:#1E5B34">Metrics</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#EAF6EE;font-size:11px;font-weight:600;line-height:22px;color:#1E5B34">Check-in</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#1E5B34">Open Check-In\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n' +
'\n' +
'      <sc-if value="{{ canBonusApproval }}" hint-placeholder-val="{{ true }}">';

function ensureAsciiAndEscapeSlash(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '/') { out += '\\u002F'; }
    else if (code > 126) { out += '\\u' + code.toString(16).padStart(4, '0'); }
    else { out += ch; }
  }
  return out;
}

const filePath = path.join(PUB, page);
const content = fs.readFileSync(filePath, 'utf8');

const marker = '<script type="__bundler/template">';
const i = content.indexOf(marker);
if (i === -1) throw new Error(page + ': no __bundler/template block found');
const jsonStart = i + marker.length;
const jsonEnd = content.indexOf('</script>', jsonStart);
const rawJson = content.slice(jsonStart, jsonEnd);
const template = JSON.parse(rawJson);

const roundTrip = ensureAsciiAndEscapeSlash(JSON.stringify(template));
if (roundTrip !== rawJson) throw new Error(page + ': round-trip encoding check FAILED. Aborting before any edit.');

for (const [label, old_] of [['OLD_PERM_LINE', OLD_PERM_LINE], ['ANCHOR_OLD', ANCHOR_OLD]]) {
  const occ = template.split(old_).length - 1;
  if (occ !== 1) throw new Error(page + ': ' + label + ' found ' + occ + ' times, expected exactly 1');
}

let newTemplate = template.split(OLD_PERM_LINE).join(NEW_PERM_LINE);
newTemplate = newTemplate.split(ANCHOR_OLD).join(TILE_DAILY_SUMMARY);
const newRawJson = ensureAsciiAndEscapeSlash(JSON.stringify(newTemplate));

console.log(page + ': old template ' + template.length + ' chars -> new ' + newTemplate.length + ' chars');
console.log('Insertion points verified unique. ' + (APPLY ? 'Applying...' : 'Dry run only (pass --apply to write).'));

if (APPLY) {
  if (content.indexOf(rawJson) === -1) throw new Error(page + ': raw JSON slice not found verbatim -- refusing to patch.');
  if (content.indexOf(rawJson) !== content.lastIndexOf(rawJson)) throw new Error(page + ': raw JSON slice not unique -- refusing to patch.');
  const patched = content.split(rawJson).join(newRawJson);
  fs.writeFileSync(filePath, patched);

  const verifyContent = fs.readFileSync(filePath, 'utf8');
  const vi = verifyContent.indexOf(marker);
  const vJsonStart = vi + marker.length;
  const vJsonEnd = verifyContent.indexOf('</script>', vJsonStart);
  const verifyTemplate = JSON.parse(verifyContent.slice(vJsonStart, vJsonEnd));
  for (const must of [
    'canDailySummary: this.can("page.dailysummary")',
    'canMonthly1on1: this.can("page.monthly1on1")',
    'href="daily-summary.html"',
    'href="monthly-1on1.html"',
    '>Daily Summary<',
    '>Monthly One-on-One<'
  ]) {
    if (!verifyTemplate.includes(must)) throw new Error(page + ': verification FAILED -- missing "' + must + '" after write.');
  }
  console.log(page + ': patched and verified.');
}
