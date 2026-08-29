#!/usr/bin/env node
/**
 * Replace admin.html's three literal, hand-duplicated <option> lists for the
 * Role picker (per-user row, its narrow-viewport duplicate, and the Add User
 * form) with a single sc-for loop over {{ roleOptions }}.
 *
 * roleOptions is already computed in this page's own renderVals() from
 * window.OLHUsers.roleOptions(), which reads Object.keys(ROLES) -- and ROLES
 * is now populated dynamically for any role the live matrix contains (see
 * dev/patch-plain-auth-role-registry.js + dev/patch-stale-auth-module.js).
 * This is the last piece: without it, a newly created role is fully
 * functional server-side and via permissions-preview.html, but still
 * invisible in admin.html's own Role dropdowns.
 *
 * Matched by regex rather than exact string: the design-tool export's three
 * copies of this block do not share identical indentation (confirmed by
 * inspection -- the narrow-viewport duplicate mixes 16-space and 12-space
 * indents mid-block), so a literal string match finds only one of the three.
 *
 *   node dev/patch-admin-dynamic-role-options.js [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = 'admin.html';
const APPLY = process.argv.includes('--apply');

const OLD_RE = /[ \t]*<option value="admin">Admin<\/option>\s*\n[ \t]*<option value="qam">QA Manager<\/option>\s*\n[ \t]*<option value="cm">Construction Manager<\/option>\s*\n[ \t]*<option value="ccr">Customer Care<\/option>\s*\n[ \t]*<option value="leadership">Division Leadership<\/option>\s*\n[ \t]*<option value="concierge">Concierge<\/option>\s*\n[ \t]*<option value="sandbox">Sandbox<\/option>/g;

const NEW_STR =
  '\n            <sc-for list="{{ roleOptions }}" as="ro" hint-placeholder-count="7">\n' +
  '              <option value="{{ ro.value }}">{{ ro.label }}</option>\n' +
  '            </sc-for>';

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

const matches = template.match(OLD_RE);
const occ = matches ? matches.length : 0;
if (occ !== 3) throw new Error(page + ': OLD_RE matched ' + occ + ' times, expected exactly 3');

const newTemplate = template.replace(OLD_RE, NEW_STR);
const newRawJson = JSON.stringify(newTemplate).replace(/<\//g, '<\\u002F');

console.log(page + ': ' + occ + ' occurrences matched. old template ' + template.length + ' chars -> new ' + newTemplate.length + ' chars');
console.log(APPLY ? 'Applying...' : 'Dry run only (pass --apply to write).');

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
  const newOcc = verifyTemplate.split('sc-for list="{{ roleOptions }}"').length - 1;
  if (newOcc !== 3) throw new Error(page + ': verification FAILED -- expected 3 sc-for loops, found ' + newOcc);
  if (verifyTemplate.includes('<option value="sandbox">Sandbox</option>')) {
    throw new Error(page + ': verification FAILED -- old hardcoded option still present.');
  }
  console.log(page + ': patched and verified (' + newOcc + ' sc-for loops in place).');
}
