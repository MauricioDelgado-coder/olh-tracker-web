#!/usr/bin/env node
/**
 * Add three Salesforce-sourced Home Inspection fields to a bundled page's
 * __bundler/template JSON block, via an exact string replacement inside the
 * decoded template text (not the raw file bytes, since the template is
 * JSON-escaped).
 *
 *   node dev/patch-template-string.js <page.html> [--apply]
 *
 * Edit OLD_STR / NEW_STR below per page before running.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

const OLD_STR = "  {k:'Assigned Concierge',h:'Concierge',t:'name',g:'sf',ro:1,w:132},\n";
const NEW_STR = OLD_STR +
  "  {k:'PHI Inspection Date',h:'Insp. Date',t:'d',g:'sf',ro:1,w:92},\n" +
  "  {k:'Home Inspection Report Received',h:'Insp. Rcvd',t:'cb',g:'sf',ro:1,ctr:1,good:1,w:80},\n" +
  "  {k:'Home Inspection Approved',h:'Insp. Appvd',t:'cb',g:'sf',ro:1,ctr:1,good:1,w:80},\n";

const filePath = path.join(PUB, page);
const content = fs.readFileSync(filePath, 'utf8');

const marker = '<script type="__bundler/template">';
const i = content.indexOf(marker);
if (i === -1) throw new Error(page + ': no __bundler/template block found');
const jsonStart = i + marker.length;
const jsonEnd = content.indexOf('</script>', jsonStart);
const rawJson = content.slice(jsonStart, jsonEnd);
const template = JSON.parse(rawJson);

// Self-check: re-encoding the UNMODIFIED template with our escaper must
// reproduce rawJson byte-for-byte, or this page's export doesn't follow the
// same "</"->"<\u002F" convention and this script must not touch it blindly.
const roundTrip = JSON.stringify(template).replace(/<\//g, '<\\u002F');
if (roundTrip !== rawJson) throw new Error(page + ': round-trip encoding check FAILED -- this page\'s JSON escaping differs from the assumed convention. Aborting before any edit.');

const occurrences = template.split(OLD_STR).length - 1;
if (occurrences !== 1) throw new Error(page + ': OLD_STR found ' + occurrences + ' times, expected exactly 1');

const newTemplate = template.split(OLD_STR).join(NEW_STR);
// The exporter escapes "</" as "<\u002F" everywhere inside this JSON blob so a
// literal </script> can never appear mid-string and prematurely close the
// enclosing <script> tag in the raw HTML. Plain JSON.stringify does not do
// this, so it must be applied by hand -- verified byte-identical on the
// unmodified template via dev/tmp-roundtrip-check.js before this was trusted.
const newRawJson = JSON.stringify(newTemplate).replace(/<\//g, '<\\u002F');

console.log(page + ': old template ' + template.length + ' chars -> new ' + newTemplate.length + ' chars');
console.log('Insertion point verified unique. ' + (APPLY ? 'Applying...' : 'Dry run only (pass --apply to write).'));

if (APPLY) {
  if (content.indexOf(rawJson) === -1) throw new Error(page + ': raw JSON slice not found verbatim -- refusing to patch.');
  if (content.indexOf(rawJson) !== content.lastIndexOf(rawJson)) throw new Error(page + ': raw JSON slice not unique -- refusing to patch.');
  const patched = content.split(rawJson).join(newRawJson);
  fs.writeFileSync(filePath, patched);

  // Verify: re-read, re-parse, confirm new columns present.
  const verifyContent = fs.readFileSync(filePath, 'utf8');
  const vi = verifyContent.indexOf(marker);
  const vJsonStart = vi + marker.length;
  const vJsonEnd = verifyContent.indexOf('</script>', vJsonStart);
  const verifyTemplate = JSON.parse(verifyContent.slice(vJsonStart, vJsonEnd));
  for (const must of ["k:'PHI Inspection Date'", "k:'Home Inspection Report Received'", "k:'Home Inspection Approved'"]) {
    if (!verifyTemplate.includes(must)) throw new Error(page + ': verification FAILED -- missing "' + must + '" after write.');
  }
  console.log(page + ': patched and verified.');
}
