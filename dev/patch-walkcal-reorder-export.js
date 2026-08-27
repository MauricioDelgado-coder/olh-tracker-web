#!/usr/bin/env node
/**
 * Reorder the walk-calendar Excel export columns: Walk Manager, Walk Type,
 * Walk Date/Time first, then everything else keeps its original relative
 * order (Job #, Community, Address, Insp. Approved, Construction Manager,
 * Concierge).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

const OLD_STR = '      columns: [\n' +
  '        { header: "Job #", width: 16 },\n' +
  '        { header: "Community", width: 26 },\n' +
  '        { header: "Address", width: 30 },\n' +
  '        { header: "Walk Type", width: 30 },\n' +
  '        { header: "Walk Date/Time", width: 20 },\n' +
  '        { header: "Walk Manager", width: 24 },\n' +
  '        { header: "Insp. Approved", width: 14 },\n' +
  '        { header: "Construction Manager", width: 22 },\n' +
  '        { header: "Concierge", width: 22 }\n' +
  '      ],\n' +
  '      rows: run.rows.map(r => [r.job, r.community, r.address,\n' +
  '        r.code + " \\u2014 " + r.walk, r.when,\n' +
  '        plan[r.key] !== undefined ? plan[r.key]\n' +
  '          : this.state.edits[r.key] !== undefined ? this.state.edits[r.key] : r.manager,\n' +
  '        r.inspApproved ? "Yes" : "No", r.cm, r.concierge])';

const NEW_STR = '      columns: [\n' +
  '        { header: "Walk Manager", width: 24 },\n' +
  '        { header: "Walk Type", width: 30 },\n' +
  '        { header: "Walk Date/Time", width: 20 },\n' +
  '        { header: "Job #", width: 16 },\n' +
  '        { header: "Community", width: 26 },\n' +
  '        { header: "Address", width: 30 },\n' +
  '        { header: "Insp. Approved", width: 14 },\n' +
  '        { header: "Construction Manager", width: 22 },\n' +
  '        { header: "Concierge", width: 22 }\n' +
  '      ],\n' +
  '      rows: run.rows.map(r => [\n' +
  '        plan[r.key] !== undefined ? plan[r.key]\n' +
  '          : this.state.edits[r.key] !== undefined ? this.state.edits[r.key] : r.manager,\n' +
  '        r.code + " \\u2014 " + r.walk, r.when,\n' +
  '        r.job, r.community, r.address,\n' +
  '        r.inspApproved ? "Yes" : "No", r.cm, r.concierge])';

const filePath = path.join(PUB, page);
const content = fs.readFileSync(filePath, 'utf8');

const marker = '<script type="__bundler/template">';
const i = content.indexOf(marker);
if (i === -1) throw new Error(page + ': no __bundler/template block found');
const jsonStart = i + marker.length;
const jsonEnd = content.indexOf('</script>', jsonStart);
const rawJson = content.slice(jsonStart, jsonEnd);
const template = JSON.parse(rawJson);

const roundTrip = JSON.stringify(template).replace(/<\//g, '<\\u002F');
if (roundTrip !== rawJson) throw new Error(page + ': round-trip encoding check FAILED. Aborting before any edit.');

const occ = template.split(OLD_STR).length - 1;
if (occ !== 1) throw new Error(page + ': OLD_STR found ' + occ + ' times, expected exactly 1');

const newTemplate = template.split(OLD_STR).join(NEW_STR);
const newRawJson = JSON.stringify(newTemplate).replace(/<\//g, '<\\u002F');

console.log(page + ': old template ' + template.length + ' chars -> new ' + newTemplate.length + ' chars');
console.log('Insertion point verified unique. ' + (APPLY ? 'Applying...' : 'Dry run only (pass --apply to write).'));

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
  const headerOrderIdx = [
    verifyTemplate.indexOf('header: "Walk Manager"'),
    verifyTemplate.indexOf('header: "Walk Type"'),
    verifyTemplate.indexOf('header: "Walk Date/Time"'),
    verifyTemplate.indexOf('header: "Job #"'),
    verifyTemplate.indexOf('header: "Community"'),
    verifyTemplate.indexOf('header: "Address"'),
    verifyTemplate.indexOf('header: "Insp. Approved"'),
    verifyTemplate.indexOf('header: "Construction Manager"'),
    verifyTemplate.indexOf('header: "Concierge"')
  ];
  for (let k = 0; k < headerOrderIdx.length; k++) {
    if (headerOrderIdx[k] === -1) throw new Error(page + ': verification FAILED -- a header went missing.');
    if (k > 0 && headerOrderIdx[k] < headerOrderIdx[k - 1]) throw new Error(page + ': verification FAILED -- headers are not in the expected new order.');
  }
  if (!verifyTemplate.includes('rows: run.rows.map(r => [\n        plan[r.key]')) {
    throw new Error(page + ': verification FAILED -- row mapper does not start with the manager expression.');
  }
  console.log(page + ': patched and verified -- header order confirmed.');
}
