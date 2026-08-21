#!/usr/bin/env node
/**
 * One-off: add an optimistic window.OLH_DATA patch to scheduler.html's
 * _commitPlan, matching the pattern already used by toggleCelLetterSent()
 * and resetWalks() in the same component. Without this, a successful Save
 * writes to Airtable via _patchOne() but never updates the in-memory
 * OLH_DATA.jobs array, so the scheduler's own next read (and any other logic
 * in this tab reading OLH_DATA) sees stale data until a full reload.
 *
 * Same decode/replace/re-encode/round-trip-validate pattern as
 * dev/add-completion-multiselect.js.
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

const FROM =
  '    try {\n' +
  '      for (const w of writes) await this._patchOne(h.recordId, w.fields);\n' +
  '    } catch (err) {\n' +
  '      this.setState({ saving: false, mWarn: "Save failed: " + ((err && err.message) || err) + ". Nothing was cleared \\u2014 fix the issue and Save again." });\n' +
  '      return;\n' +
  '    }\n' +
  '    this.logPlan(h.job, draft, this.state.assignments[h.job] ? "reassign" : "schedule");';

const TO =
  '    try {\n' +
  '      for (const w of writes) await this._patchOne(h.recordId, w.fields);\n' +
  '    } catch (err) {\n' +
  '      this.setState({ saving: false, mWarn: "Save failed: " + ((err && err.message) || err) + ". Nothing was cleared \\u2014 fix the issue and Save again." });\n' +
  '      return;\n' +
  '    }\n' +
  '    /* Optimistic local patch (2026-08) -- same pattern as toggleCelLetterSent()\n' +
  '       and resetWalks() above. Without this, window.OLH_DATA stays stale until\n' +
  '       reload: this tab\'s own next conflict-relevant read, or any other page\n' +
  '       sharing OLH_DATA in this tab, would not see the write we just made. */\n' +
  '    const jobsNow = (window.OLH_DATA && window.OLH_DATA.jobs) || [];\n' +
  '    const patchedJob = jobsNow.find(x => x.id === h.recordId);\n' +
  '    if (patchedJob) writes.forEach(w => Object.assign(patchedJob.fields, w.fields));\n' +
  '    this._sites = null;\n' +
  '    this.logPlan(h.job, draft, this.state.assignments[h.job] ? "reassign" : "schedule");';

tpl = replaceOnce(tpl, FROM, TO, '_commitPlan optimistic update');

if (tpl === template) {
  console.log('No change made (already applied). Exiting.');
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
