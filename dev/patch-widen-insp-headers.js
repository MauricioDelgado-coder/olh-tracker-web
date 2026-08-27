#!/usr/bin/env node
/**
 * Widen the two new read-only checkbox columns (Home Inspection Report
 * Received / Home Inspection Approved) whose headers were truncating --
 * they're the first ro:1 + 'cb' combo in this table, so they render a lock
 * icon the other narrow checkbox columns (QAI Done, CEL Letter, etc, all
 * hand-entered, none read-only) never had to make room for.
 *
 *   node dev/patch-widen-insp-headers.js tracker.html [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

const OLD_STR = "  {k:'Home Inspection Report Received',h:'Insp. Rcvd',t:'cb',g:'sf',ro:1,ctr:1,good:1,w:80},\n" +
  "  {k:'Home Inspection Approved',h:'Insp. Appvd',t:'cb',g:'sf',ro:1,ctr:1,good:1,w:80},\n";
const NEW_STR = "  {k:'Home Inspection Report Received',h:'Insp. Rcvd',t:'cb',g:'sf',ro:1,ctr:1,good:1,w:104},\n" +
  "  {k:'Home Inspection Approved',h:'Insp. Appvd',t:'cb',g:'sf',ro:1,ctr:1,good:1,w:112},\n";

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

const occurrences = template.split(OLD_STR).length - 1;
if (occurrences !== 1) throw new Error(page + ': OLD_STR found ' + occurrences + ' times, expected exactly 1');

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
  for (const must of ["'Insp. Rcvd',t:'cb',g:'sf',ro:1,ctr:1,good:1,w:104", "'Insp. Appvd',t:'cb',g:'sf',ro:1,ctr:1,good:1,w:112"]) {
    if (!verifyTemplate.includes(must)) throw new Error(page + ': verification FAILED -- missing "' + must + '" after write.');
  }
  console.log(page + ': patched and verified.');
}
