/**
 * Two changes to index.html, applied atomically, following the exact pattern
 * of patch-index-bonus-approval-tile.js:
 *
 *  1. Relabel the existing "CCR Bonus Approval" tile as "Approvals" (it now
 *     shows both bonus AND case aging exception requests -- see
 *     public/bonus-approval.html and case-aging-approvals.js).
 *  2. Add a new "Case Aging Exception" tile (page.caseaging), right after
 *     the CCR Monthly Bonus tile, amber-adjacent but visually distinct
 *     (a warm rose scheme) so it doesn't read as a bonus sub-item.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

/* ---- Change 1: relabel the bonus-approval tile ---------------------- */

const OLD_1 =
'<h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">CCR Bonus Approval</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Review your direct reports\' monthly bonus submissions and approve, reject, or mark them paid.</p>';

const NEW_1 =
'<h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">Approvals</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Review bonus submissions and case aging exception requests from your direct reports.</p>';

/* ---- Change 2: add a Case Aging Exception tile ----------------------- */
// </sc-if>, mirroring patch-index-bonus-approval-tile.js's OLD_2/NEW_2 shape
// exactly but keyed off canBonus (page.bonus) since Case Aging sits beside
// Bonus in the tile grid, not beside Approvals.
const ANCHOR_OLD =
'      <a href="bonus.html" style="display:flex;flex-direction:column;padding:20px 20px 22px;border:1px solid #E4DED2;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(27,42,88,.06);transition:box-shadow 200ms cubic-bezier(.2,.6,.2,1),transform 200ms cubic-bezier(.2,.6,.2,1),border-color 200ms cubic-bezier(.2,.6,.2,1)" style-hover="box-shadow:0 12px 28px rgba(27,42,88,.14);transform:translateY(-4px);border-color:#F0DFAE">\n' +
'        <span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:#FFF8E1;color:#7C4A03">\n' +
'          <svg width="22" height="22" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v10M9.5 9.5c0-1 1-2 2.5-2s2.5 1 2.5 2c0 3-5 2-5 5c0 1 1 2 2.5 2s2.5-1 2.5-2"></path></svg>\n' +
'        </span>\n' +
'        <h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">CCR Monthly Bonus</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Report your monthly case and walk numbers and see your calculated bonus before submitting it to leadership.</p>\n' +
'        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0">\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FFF8E1;font-size:11px;font-weight:600;line-height:22px;color:#7C4A03">Case closure</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FFF8E1;font-size:11px;font-weight:600;line-height:22px;color:#7C4A03">Aged cases</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FFF8E1;font-size:11px;font-weight:600;line-height:22px;color:#7C4A03">CEL / ACC walks</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#7C4A03">Report This Month\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n' +
'\n' +
'      ';

const OLD_PERM_LINE = '      canBonusApproval: this.can("page.bonusapproval"),\n';
const NEW_PERM_LINE = OLD_PERM_LINE + '      canCaseAging: this.can("page.caseaging"),\n';

const ANCHOR_NEW = ANCHOR_OLD +
'<sc-if value="{{ canCaseAging }}" hint-placeholder-val="{{ true }}">\n' +
'      <a href="case-aging.html" style="display:flex;flex-direction:column;padding:20px 20px 22px;border:1px solid #E4DED2;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(27,42,88,.06);transition:box-shadow 200ms cubic-bezier(.2,.6,.2,1),transform 200ms cubic-bezier(.2,.6,.2,1),border-color 200ms cubic-bezier(.2,.6,.2,1)" style-hover="box-shadow:0 12px 28px rgba(27,42,88,.14);transform:translateY(-4px);border-color:#F3C6C2">\n' +
'        <span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:#FDECEA;color:#7F1D1D">\n' +
'          <svg width="22" height="22" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5l3 2"></path></svg>\n' +
'        </span>\n' +
'        <h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">Case Aging Exception</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Request an exception for a case that will exceed its expected age, routed to your manager for approval.</p>\n' +
'        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0">\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FDECEA;font-size:11px;font-weight:600;line-height:22px;color:#7F1D1D">Aging exception</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FDECEA;font-size:11px;font-weight:600;line-height:22px;color:#7F1D1D">Manager approval</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#7F1D1D">Request Exception\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n' +
'\n' +
'      ';

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

for (const [label, old_] of [['OLD_PERM_LINE', OLD_PERM_LINE], ['OLD_1', OLD_1], ['ANCHOR_OLD', ANCHOR_OLD]]) {
  const occ = template.split(old_).length - 1;
  if (occ !== 1) throw new Error(page + ': ' + label + ' found ' + occ + ' times, expected exactly 1');
}

let newTemplate = template.split(OLD_PERM_LINE).join(NEW_PERM_LINE);
newTemplate = newTemplate.split(OLD_1).join(NEW_1);
newTemplate = newTemplate.split(ANCHOR_OLD).join(ANCHOR_NEW);
const newRawJson = ensureAsciiAndEscapeSlash(JSON.stringify(newTemplate));

console.log(page + ': old template ' + template.length + ' chars -> new ' + newTemplate.length + ' chars');
console.log('All three insertion points verified unique. ' + (APPLY ? 'Applying...' : 'Dry run only (pass --apply to write).'));

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
    'canCaseAging: this.can("page.caseaging")',
    'sc-if value="{{ canCaseAging }}"',
    'href="case-aging.html"',
    '>Case Aging Exception<',
    '>Approvals<'
  ]) {
    if (!verifyTemplate.includes(must)) throw new Error(page + ': verification FAILED -- missing "' + must + '" after write.');
  }
  console.log(page + ': patched and verified.');
}
