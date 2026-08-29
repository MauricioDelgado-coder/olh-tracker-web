#!/usr/bin/env node
/**
 * Add a "Permissions Preview" quick-nav link to admin.html's header (inside
 * __bundler/template, not the manifest), matching the existing "Sync
 * History" link's exact style, placed right after it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

const OLD_STR = '<a href="sync-history.html" style="display:inline-flex;align-items:center;gap:8px;flex:0 0 auto;height:30px;padding:0 13px;border:1px solid rgba(255,255,255,.28);border-radius:4px;background:transparent;color:#C7BFB2;font-size:13px;font-weight:500;text-decoration:none;white-space:nowrap">Sync History</a>';
const NEW_STR = OLD_STR +
  '\n    <a href="permissions-preview.html" style="display:inline-flex;align-items:center;gap:8px;flex:0 0 auto;height:30px;padding:0 13px;border:1px solid rgba(255,255,255,.28);border-radius:4px;background:transparent;color:#C7BFB2;font-size:13px;font-weight:500;text-decoration:none;white-space:nowrap">Permissions Preview</a>';

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
  if (!verifyTemplate.includes('href="permissions-preview.html"')) throw new Error(page + ': verification FAILED -- missing permissions-preview.html link after write.');
  console.log(page + ': patched and verified.');
}
