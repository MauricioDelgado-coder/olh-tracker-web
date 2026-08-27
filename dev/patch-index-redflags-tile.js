/**
 * Add the Red Flags tile to index.html: a new canRedFlags permission prop,
 * plus a new tile card after Completion Report, matching the existing tile
 * markup pattern exactly but in a red/warning color scheme instead of blue.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

const OLD_1 = '      canCompletion: this.can("page.completion"),\n';
const NEW_1 = '      canCompletion: this.can("page.completion"),\n' +
  '      canRedFlags: this.can("page.redflags"),\n';

const OLD_2 =
'      <sc-if value="{{ canCompletion }}" hint-placeholder-val="{{ true }}">\n' +
'      <a href="completion.html" style="display:flex;flex-direction:column;padding:20px 20px 22px;border:1px solid #E4DED2;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(27,42,88,.06);transition:box-shadow 200ms cubic-bezier(.2,.6,.2,1),transform 200ms cubic-bezier(.2,.6,.2,1),border-color 200ms cubic-bezier(.2,.6,.2,1)" style-hover="box-shadow:0 12px 28px rgba(27,42,88,.14);transform:translateY(-4px);border-color:#CFE2F1">\n' +
'        <span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:#EAF2F9;color:#005DAA">\n' +
'          <svg width="22" height="22" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"></path><path d="M7 15v-4"></path><path d="M12 15V7"></path><path d="M17 15v-6"></path></svg>\n' +
'        </span>\n' +
'        <h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">Completion Report</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Division dashboard: estimated delivery dates by month, homesite counts and stage mix, with cross-filtering down to a single day.</p>\n' +
'        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0">\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#F1EBE1;font-size:11px;font-weight:600;line-height:22px;color:#6F6963">EDD calendar</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#F1EBE1;font-size:11px;font-weight:600;line-height:22px;color:#6F6963">Homesite count</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#F1EBE1;font-size:11px;font-weight:600;line-height:22px;color:#6F6963">Stage mix</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#005DAA">Open the Dashboard\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n';

const NEW_2 = OLD_2 +
'\n' +
'      <sc-if value="{{ canRedFlags }}" hint-placeholder-val="{{ true }}">\n' +
'      <a href="red-flags.html" style="display:flex;flex-direction:column;padding:20px 20px 22px;border:1px solid #E4DED2;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(27,42,88,.06);transition:box-shadow 200ms cubic-bezier(.2,.6,.2,1),transform 200ms cubic-bezier(.2,.6,.2,1),border-color 200ms cubic-bezier(.2,.6,.2,1)" style-hover="box-shadow:0 12px 28px rgba(27,42,88,.14);transform:translateY(-4px);border-color:#F3C6C2">\n' +
'        <span style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:#FDECEA;color:#AA1F23">\n' +
'          <svg width="22" height="22" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>\n' +
'        </span>\n' +
'        <h2 style="margin:14px 0 0;font-family:\'Reckless\',\'Times New Roman\',serif;font-weight:300;font-size:25px;line-height:1.12;letter-spacing:-.03em;color:#303030">Red Flags</h2>\n' +
'        <p style="margin:7px 0 0;font-size:13.5px;color:#6F6963;text-wrap:pretty">Homesites needing attention: CEL letter sent with no CEL/ACC dates, and completed construction with no Certificate of Occupancy date.</p>\n' +
'        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0">\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FDECEA;font-size:11px;font-weight:600;line-height:22px;color:#7F1D1D">CEL sent, no dates</span>\n' +
'          <span style="height:22px;padding:0 9px;border-radius:999px;background:#FDECEA;font-size:11px;font-weight:600;line-height:22px;color:#7F1D1D">Completed, no CO</span>\n' +
'        </div>\n' +
'        <span style="display:inline-flex;align-items:center;gap:7px;margin-top:auto;padding-top:18px;font-size:13px;font-weight:600;color:#AA1F23">View Reports\n' +
'          <svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>\n' +
'        </span>\n' +
'      </a>\n' +
'      </sc-if>\n';

// index.html's own convention (verified byte-identical via
// dev/tmp-roundtrip-check4.js): every "/" becomes uppercase "\u002F", and
// every non-ASCII char becomes a lowercase \uXXXX escape. This DIFFERS from
// tracker.html/walk-calendar.html, which only escape "<\/" -- each exported
// page must be verified individually, never assumed.
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

for (const [label, old_] of [['OLD_1', OLD_1], ['OLD_2', OLD_2]]) {
  const occ = template.split(old_).length - 1;
  if (occ !== 1) throw new Error(page + ': ' + label + ' found ' + occ + ' times, expected exactly 1');
}

let newTemplate = template.split(OLD_1).join(NEW_1);
newTemplate = newTemplate.split(OLD_2).join(NEW_2);
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
  for (const must of ['canRedFlags: this.can("page.redflags")', 'sc-if value="{{ canRedFlags }}"', 'href="red-flags.html"', '>Red Flags<']) {
    if (!verifyTemplate.includes(must)) throw new Error(page + ': verification FAILED -- missing "' + must + '" after write.');
  }
  console.log(page + ': patched and verified.');
}
