#!/usr/bin/env node
/**
 * Restrict the "Assign Manually" panel on scheduler.html to Division
 * Leadership (and Admin) -- it bypasses the ranked CONTINUITY/OVERFLOW
 * options entirely (any QAM or CCR, any date), so it needs tighter gating
 * than the general walk.schedule permission that already covers Save and
 * the ranked "Select" buttons.
 *
 * Same decode/replace/re-encode/round-trip-validate pattern as
 * dev/update-scheduler-cel-acc-logic.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'scheduler.html');

function decodeTemplateLine(html) {
  const tagOpen = '<script type="__bundler/template">';
  const idx = html.indexOf(tagOpen);
  if (idx === -1) throw new Error('no __bundler/template tag found');
  let prefixEnd = idx + tagOpen.length;
  if (html[prefixEnd] === '\n') prefixEnd += 1;
  const lineEnd = html.indexOf('\n', prefixEnd);
  const lineTail = lineEnd === -1 ? html.length : lineEnd;
  const suffix = '</script>';
  const jsonStr = html.slice(prefixEnd, lineTail - suffix.length);
  return { idx, prefixEnd, lineTail, suffix, jsonStr, template: JSON.parse(jsonStr) };
}

function replaceOnce(str, from, to, label) {
  const fromCount = str.split(from).length - 1;
  if (fromCount === 1) return str.split(from).join(to);
  const toCount = str.split(to).length - 1;
  if (fromCount === 0 && toCount === 1) {
    console.log('  [' + label + '] already applied, skipping');
    return str;
  }
  throw new Error('expected exactly 1 occurrence of [' + label + '], found ' + fromCount +
    ' (and ' + toCount + ' of the replacement already present)');
}

const html = fs.readFileSync(FILE, 'utf8');
const { prefixEnd, lineTail, suffix, template } = decodeTemplateLine(html);
let tpl = template;

// ---------------------------------------------------------------------------
// 1. Add the role check next to the existing permission helper.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '  can(p) { return !window.OLHAuth || window.OLHAuth.can(p); }',

  '  can(p) { return !window.OLHAuth || window.OLHAuth.can(p); }\n' +
  '\n' +
  '  /* Manual assignment bypasses the ranked options entirely -- any QAM or\n' +
  '     CCR, any date -- so it is gated tighter than the general\n' +
  '     walk.schedule permission that already covers Save and the ranked\n' +
  '     Select buttons. Only Division Leadership or Admin may use it. Fails\n' +
  '     open when the auth module has not loaded at all, same as can() above. */\n' +
  '  isLeadership() {\n' +
  '    if (!window.OLHAuth) return true;\n' +
  '    const u = window.OLHAuth.user && window.OLHAuth.user();\n' +
  '    return !!(u && (u.role === "leadership" || u.role === "admin"));\n' +
  '  }',
  'isLeadership helper');

// ---------------------------------------------------------------------------
// 2. Hard guard inside manual() itself -- the actual chokepoint, so a
//    disabled/hidden button is belt-and-suspenders, not the only lock.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '  manual(h) {\n' +
  '    const code = this.state.step;\n' +
  '    if (!code) return;\n' +
  '    const p = this.person(this.state.mPerson);',

  '  manual(h) {\n' +
  '    const code = this.state.step;\n' +
  '    if (!code) return;\n' +
  '    if (!this.isLeadership()) {\n' +
  '      this.setState({ mWarn: "Manual assignment is limited to Division Leadership." }); return;\n' +
  '    }\n' +
  '    const p = this.person(this.state.mPerson);',
  'manual() role guard');

// ---------------------------------------------------------------------------
// 3. Render: expose manualOff/manualCursor next to the onManual handler.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '      onManual: () => { if (sel) this.manual(sel); },',

  '      onManual: () => { if (sel) this.manual(sel); },\n' +
  '      manualOff: !this.isLeadership(),\n' +
  '      manualCursor: this.isLeadership() ? "pointer" : "not-allowed",\n' +
  '      manualOpacity: this.isLeadership() ? "1" : ".5",',
  'manualOff render value');

// ---------------------------------------------------------------------------
// 4. HTML: disable the Assign button for non-leadership roles, and say so
//    in the panel header.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '            <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.16em;color:#908A82">Assign Manually \u00b7 CCRs Available Here Only</span>',
  '            <span style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.16em;color:#908A82">Assign Manually \u00b7 CCRs Available Here Only \u00b7 Division Leadership Only</span>',
  'panel header note');

tpl = replaceOnce(tpl,
  '              <button sc-camel-on-click="{{ onManual }}" style="height:32px;padding:0 15px;border:1px solid #005DAA;border-radius:4px;background:#fff;color:#005DAA;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap" style-hover="background:#EAF2F9">Assign</button>',
  '              <button sc-camel-on-click="{{ onManual }}" disabled="{{ manualOff }}" style="height:32px;padding:0 15px;border:1px solid #005DAA;border-radius:4px;background:#fff;color:#005DAA;font-size:12.5px;font-weight:600;cursor:{{ manualCursor }};white-space:nowrap;opacity:{{ manualOpacity }}" style-hover="background:#EAF2F9">Assign</button>',
  'Assign button disabled');

if (tpl === template) {
  console.log('No changes made (already applied). Exiting.');
  process.exit(0);
}

let newJsonStr = JSON.stringify(tpl).split('</').join('<\\u002F');
if (newJsonStr.includes('</')) throw new Error('failed to neutralise a close tag');

const newHtml = html.slice(0, prefixEnd) + newJsonStr + html.slice(lineTail - suffix.length);

const idx2 = newHtml.indexOf('<script type="__bundler/template">');
const tagOpen2 = '<script type="__bundler/template">';
const browserSeesEnd = newHtml.indexOf('</script>', idx2 + tagOpen2.length);
const browserJsonStr = newHtml.slice(idx2 + tagOpen2.length, browserSeesEnd);
const browserDecoded = JSON.parse(browserJsonStr);
if (browserDecoded !== tpl) throw new Error('round-trip mismatch after escaping');

fs.writeFileSync(FILE, newHtml);
console.log('Patched ' + FILE + ' (' + (newHtml.length / 1024).toFixed(0) + ' KB)');
