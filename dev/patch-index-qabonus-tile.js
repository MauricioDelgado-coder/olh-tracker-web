/**
 * Two changes to index.html, applied atomically, following the exact pattern
 * of patch-index-caseaging-tile.js:
 *
 *  1. FIX a pre-existing bug: patch-index-dailysummary-monthly1on1-tiles.js's
 *     ANCHOR_OLD consumed the Case Aging Exception tile's own closing markup
 *     (its "Request Exception" link row, </a>, </sc-if>) as part of a wider
 *     anchor, and its replacement (TILE_DAILY_SUMMARY + TILE_MONTHLY_1ON1)
 *     never restored it before opening the next tile. Net effect, live in
 *     production today: the Case Aging tile's <a href="case-aging.html">
 *     is never closed before <a href="daily-summary.html"> opens -- a
 *     nested anchor, which the browser's HTML parser implicitly closes at
 *     the outer tag, dropping the tile's own call-to-action row. Restored
 *     here rather than filed separately, since this patch already has to
 *     touch the exact same anchor to insert the QA Bonus tile after it.
 *
 *  2. Add a new "QA Bonus" tile (page.qabonus), right after the (now fixed)
 *     Case Aging Exception tile -- QAM self-reporting sits with Bonus and
 *     Case Aging as the third member of the same self-report/approve
 *     cluster. Blue-adjacent (QA Management's palette) so it reads as a QA
 *     surface rather than a finance one.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

const OLD_PERM_LINE = '      canCaseAging: this.can("page.caseaging"),\n';
const NEW_PERM_LINE = OLD_PERM_LINE + '      canQaBonus: this.can("page.qabonus"),\n';

/* The broken anchor: Case Aging's tags-div close, straight into Daily
   Summary's sc-if with nothing in between -- this exact adjacency is the bug. */
const ANCHOR_OLD =
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FDECEA;font-size:11px;font-weight:600;line-height:22px;color:#7F1D1D">Manager approval</span>\n' +
'        </div>\n' +
'<sc-if value="{{ canDailySummary }}" hint-placeholder-val="{{ true }}">';

const ANCHOR_NEW =
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FDECEA;font-size:11px;font-weight:600;line-height:22px;color:#7F1D1D">Manager approval</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#7F1D1D">Request Exception\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n' +
'\n' +
'      <sc-if value="{{ canQaBonus }}" hint-placeholder-val="{{ true }}">\n' +
'      <a href="qa-bonus.html" style="display:flex;flex-direction:column;padding:20px 20px 22px;border:1px solid #E4DED2;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(27,42,88,.06);transition:box-shadow 200ms cubic-bezier(.2,.6,.2,1),transform 200ms cubic-bezier(.2,.6,.2,1),border-color 200ms cubic-bezier(.2,.6,.2,1)" style-hover="box-shadow:0 12px 28px rgba(27,42,88,.14);transform:translateY(-4px);border-color:#CFE2F1">\n' +
'        <span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:#EAF2F9;color:#005DAA">\n' +
'          <svg width="22" height="22" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3 8-8"></path><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"></path></svg>\n' +
'        </span>\n' +
'        <h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">QA Manager Bonus</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Report your monthly walk completions and 30-day quality rate, and see your calculated bonus before submitting it to leadership.</p>\n' +
'        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0">\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#EAF2F9;font-size:11px;font-weight:600;line-height:22px;color:#005DAA">QAI / QAA walks</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#EAF2F9;font-size:11px;font-weight:600;line-height:22px;color:#005DAA">NHO / NHA walks</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#EAF2F9;font-size:11px;font-weight:600;line-height:22px;color:#005DAA">30-day quality rate</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#005DAA">Report This Month\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n' +
'\n' +
'<sc-if value="{{ canDailySummary }}" hint-placeholder-val="{{ true }}">';

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
newTemplate = newTemplate.split(ANCHOR_OLD).join(ANCHOR_NEW);
const newRawJson = ensureAsciiAndEscapeSlash(JSON.stringify(newTemplate));

console.log(page + ': old template ' + template.length + ' chars -> new ' + newTemplate.length + ' chars');
console.log('Both insertion points verified unique. ' + (APPLY ? 'Applying...' : 'Dry run only (pass --apply to write).'));

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
    'canQaBonus: this.can("page.qabonus")',
    'sc-if value="{{ canQaBonus }}"',
    'href="qa-bonus.html"',
    '>QA Manager Bonus<',
    'Request Exception'
  ]) {
    if (!verifyTemplate.includes(must)) throw new Error(page + ': verification FAILED -- missing "' + must + '" after write.');
  }
  // The bug-fix half: Case Aging's own closing anchor tag must now exist,
  // immediately followed by the QA Bonus tile, immediately followed by
  // Daily Summary's sc-if -- i.e. three well-formed, sequential tiles.
  const caIdx = verifyTemplate.indexOf('Request Exception');
  const qbIdx = verifyTemplate.indexOf('canQaBonus');
  const dsIdx = verifyTemplate.indexOf('canDailySummary');
  if (!(caIdx < qbIdx && qbIdx < dsIdx)) {
    throw new Error(page + ': verification FAILED -- tile ordering is not Case Aging -> QA Bonus -> Daily Summary.');
  }
  console.log(page + ': patched and verified (Case Aging tile bug fixed, QA Bonus tile added).');
}
