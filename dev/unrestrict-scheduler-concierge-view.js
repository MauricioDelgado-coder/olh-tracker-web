#!/usr/bin/env node
/**
 * Reverse the concierge-only-sees-their-own-homesites scoping added in
 * dev/restrict-scheduler-list-eligibility.js. Removes:
 *   - the conciergeLocked/myConciergeName computation and its filter line
 *   - the showConciergeFilter render flag
 *   - the <sc-if> wrapper hiding the Assigned Concierge dropdown
 *
 * Leaves the QAI-complete/active/not-yet-closed/not-completed eligibility
 * filters untouched -- those are business rules for everyone, not a
 * per-user view restriction.
 *
 * Same decode/replace/re-encode/round-trip-validate pattern as the sibling
 * scheduler.html patch scripts in this directory.
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
// 1. renderVals(): drop the conciergeLocked computation and its filter line.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '    /* A Concierge only ever sees their own assigned homesites, no matter\n' +
  '       what the Assigned Concierge dropdown is set to (it is hidden for\n' +
  '       this role -- see showConciergeFilter below). Matched by name since\n' +
  '       that is what "Assigned Concierge" stores on the Jobs record. */\n' +
  '    const me = window.OLHAuth && window.OLHAuth.user && window.OLHAuth.user();\n' +
  '    const conciergeLocked = !!(me && me.role === "concierge");\n' +
  '    const myConciergeName = conciergeLocked ? String(me.name || "").trim().toLowerCase() : "";\n' +
  '    const list = sites.filter(h => {\n' +
  '      // Ready for scheduling only once QAI has actually been COMPLETED --\n' +
  '      // having a QAI date just means one is planned, not that it happened.\n' +
  '      if (!h.qaiComplete) return false;\n' +
  '      // Never show a record Airtable does not consider Active.\n' +
  '      if (!h.active) return false;\n' +
  '      // Once the closing date itself has passed there is nothing left to\n' +
  '      // schedule for this home.\n' +
  '      if (h.close && h.close.getTime() < TODAY.getTime()) return false;\n' +
  '      // Either milestone already walked and marked complete -- nothing\n' +
  '      // left for the scheduler to do here.\n' +
  '      if (h.celCompleted || h.accCompleted) return false;\n' +
  '      if (conciergeLocked && String(h.concierge || "").trim().toLowerCase() !== myConciergeName) return false;\n' +
  '      const st = statusOf(h);\n',

  '    const list = sites.filter(h => {\n' +
  '      // Ready for scheduling only once QAI has actually been COMPLETED --\n' +
  '      // having a QAI date just means one is planned, not that it happened.\n' +
  '      if (!h.qaiComplete) return false;\n' +
  '      // Never show a record Airtable does not consider Active.\n' +
  '      if (!h.active) return false;\n' +
  '      // Once the closing date itself has passed there is nothing left to\n' +
  '      // schedule for this home.\n' +
  '      if (h.close && h.close.getTime() < TODAY.getTime()) return false;\n' +
  '      // Either milestone already walked and marked complete -- nothing\n' +
  '      // left for the scheduler to do here.\n' +
  '      if (h.celCompleted || h.accCompleted) return false;\n' +
  '      const st = statusOf(h);\n',
  'remove conciergeLocked filter');

// ---------------------------------------------------------------------------
// 2. Drop showConciergeFilter from the render object.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '      showConciergeFilter: !conciergeLocked,\n' +
  '      conciergeOpts, concierge: s.concierge,\n' +
  '      onConcierge: e => this.setState({ concierge: e.target.value }),',

  '      conciergeOpts, concierge: s.concierge,\n' +
  '      onConcierge: e => this.setState({ concierge: e.target.value }),',
  'remove showConciergeFilter render value');

// ---------------------------------------------------------------------------
// 3. HTML: unwrap the <sc-if> around the Assigned Concierge dropdown so it
//    always shows.
// ---------------------------------------------------------------------------
tpl = replaceOnce(tpl,
  '        <sc-if value="{{ showConciergeFilter }}" hint-placeholder-val="{{ true }}">\n' +
  '          <label style="display:flex;flex-direction:column;gap:3px">\n' +
  '            <span style="font-size:11px;font-weight:600;color:#6F6963">Assigned Concierge</span>\n' +
  '            <sc-raw-select value="{{ concierge }}" sc-camel-on-change="{{ onConcierge }}" style="height:32px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:13px;cursor:pointer">\n' +
  '              <sc-for list="{{ conciergeOpts }}" as="c" hint-placeholder-count="6"><option value="{{ c.v }}">{{ c.l }}</option></sc-for>\n' +
  '            </sc-raw-select>\n' +
  '          </label>\n' +
  '        </sc-if>',

  '        <label style="display:flex;flex-direction:column;gap:3px">\n' +
  '          <span style="font-size:11px;font-weight:600;color:#6F6963">Assigned Concierge</span>\n' +
  '          <sc-raw-select value="{{ concierge }}" sc-camel-on-change="{{ onConcierge }}" style="height:32px;padding:0 8px;border:1px solid #BFB8AB;border-radius:4px;background:#fff;font-size:13px;cursor:pointer">\n' +
  '            <sc-for list="{{ conciergeOpts }}" as="c" hint-placeholder-count="6"><option value="{{ c.v }}">{{ c.l }}</option></sc-for>\n' +
  '          </sc-raw-select>\n' +
  '        </label>',
  'restore concierge dropdown HTML');

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
