#!/usr/bin/env node
/**
 * Add a "Red Flags" entry to the admin Page Access grid's PAGES array,
 * which lives inside a gzip+base64 manifest asset in admin.html (not the
 * __bundler/template block). Follows the same find-asset-by-uuid,
 * decompress, edit, recompress, base64, unique-replace technique as
 * dev/patch-stale-auth-module.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const ASSET_UUID = process.argv[3];
const APPLY = process.argv.includes('--apply');

const OLD_STR = '    { key: "page.completion", label: "Completion Report", href: "completion.html", note: "Homesites under construction with their projected completion and closing dates." },\n' +
  '    { key: "page.walks",';
const NEW_STR = '    { key: "page.completion", label: "Completion Report", href: "completion.html", note: "Homesites under construction with their projected completion and closing dates." },\n' +
  '    { key: "page.redflags", label: "Red Flags", href: "red-flags.html", note: "Homesites needing attention \\u2014 CEL letter sent with no CEL/ACC dates, and completed construction with no Certificate of Occupancy date." },\n' +
  '    { key: "page.walks",';

const filePath = path.join(PUB, page);
const content = fs.readFileSync(filePath, 'utf8');

const marker = '<script type="__bundler/manifest">';
const mi = content.indexOf(marker);
if (mi === -1) throw new Error(page + ': no __bundler/manifest block found');
const mJsonStart = mi + marker.length;
const mJsonEnd = content.indexOf('</script>', mJsonStart);
const manifest = JSON.parse(content.slice(mJsonStart, mJsonEnd));

const entry = manifest[ASSET_UUID];
if (!entry) throw new Error(page + ': asset ' + ASSET_UUID + ' not found in manifest');
const oldDataB64 = entry.data;
const buf = Buffer.from(oldDataB64, 'base64');
const oldText = entry.compressed ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');

const occ = oldText.split(OLD_STR).length - 1;
if (occ !== 1) throw new Error(page + ': OLD_STR found ' + occ + ' times in asset ' + ASSET_UUID + ', expected exactly 1');

const newText = oldText.split(OLD_STR).join(NEW_STR);
const newBuf = entry.compressed ? zlib.gzipSync(Buffer.from(newText, 'utf8')) : Buffer.from(newText, 'utf8');
const newDataB64 = newBuf.toString('base64');

console.log(page + ' asset ' + ASSET_UUID + ': old text ' + oldText.length + ' chars -> new ' + newText.length + ' chars');
console.log('(b64 ' + oldDataB64.length + ' -> ' + newDataB64.length + ')');
console.log('Insertion point verified unique. ' + (APPLY ? 'Applying...' : 'Dry run only (pass --apply to write).'));

if (APPLY) {
  if (content.indexOf(oldDataB64) === -1) throw new Error(page + ': old base64 data not found verbatim in file -- refusing to patch blindly.');
  if (content.indexOf(oldDataB64) !== content.lastIndexOf(oldDataB64)) throw new Error(page + ': old base64 data is not unique in file -- refusing to patch blindly.');
  const patched = content.split(oldDataB64).join(newDataB64);
  fs.writeFileSync(filePath, patched);

  const verifyContent = fs.readFileSync(filePath, 'utf8');
  const vmi = verifyContent.indexOf(marker);
  const vManifest = JSON.parse(verifyContent.slice(vmi + marker.length, verifyContent.indexOf('</script>', vmi + marker.length)));
  const vEntry = vManifest[ASSET_UUID];
  const vBuf = Buffer.from(vEntry.data, 'base64');
  const vText = vEntry.compressed ? zlib.gunzipSync(vBuf).toString('utf8') : vBuf.toString('utf8');
  if (!vText.includes('key: "page.redflags"')) throw new Error(page + ': verification FAILED -- missing page.redflags entry after write.');
  console.log(page + ': patched and verified.');
}
