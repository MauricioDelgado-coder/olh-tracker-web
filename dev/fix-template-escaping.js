#!/usr/bin/env node
/**
 * One-off repair: several public/*.html bundles were written with the
 * __bundler/template blob missing the "</":"<\u002F" escaping that emit()
 * in build-live-pages.js normally applies (and self-verifies). A literal
 * "</script>" inside the JSON string closes the host <script> tag early in
 * the browser's HTML parser, truncating the template and breaking the page.
 *
 * This re-applies the exact same escaping emit() uses, in place, on-disk,
 * without needing to re-run the full build. Backs up originals first.
 */
'use strict';
const fs = require('path') && require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public');
const BACKUP = path.join(__dirname, 'fix-backup');
const TAG_OPEN = '<script type="__bundler/template">';
const SUFFIX = '</script>';

let fixedCount = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.html'))) {
  const full = path.join(DIR, f);
  const html = fs.readFileSync(full, 'utf8');
  const idx = html.indexOf(TAG_OPEN);
  if (idx === -1) { console.log(f + ': no template tag, skip'); continue; }

  const lineEndRel = html.indexOf('\n', idx);
  const lineEnd = lineEndRel === -1 ? html.length : lineEndRel;
  const prefixEnd = idx + TAG_OPEN.length;
  const jsonStr = html.slice(prefixEnd, lineEnd - SUFFIX.length);

  let decoded;
  try { decoded = JSON.parse(jsonStr); }
  catch (e) { console.log(f + ': SKIP, on-disk JSON invalid: ' + e.message); continue; }

  const alreadyEscaped = !jsonStr.includes('</');
  if (alreadyEscaped) { console.log(f + ': already escaped, skip'); continue; }

  const fixedJsonStr = jsonStr.split('</').join('<\\u002F');
  if (fixedJsonStr.includes('</')) { console.log(f + ': FAILED to neutralise, skip'); continue; }

  const newHtml = html.slice(0, prefixEnd) + fixedJsonStr + html.slice(lineEnd - SUFFIX.length);

  // Round-trip validate exactly as the browser will see it: find the tag,
  // then find the FIRST literal "</script>" after it (browser HTML parser
  // behavior), and confirm that yields the FULL decoded template back.
  const idx2 = newHtml.indexOf(TAG_OPEN);
  const browserSeesEnd = newHtml.indexOf(SUFFIX, idx2 + TAG_OPEN.length);
  const browserJsonStr = newHtml.slice(idx2 + TAG_OPEN.length, browserSeesEnd);
  let browserDecoded;
  try { browserDecoded = JSON.parse(browserJsonStr); }
  catch (e) { console.log(f + ': FAILED round-trip parse: ' + e.message); continue; }
  if (browserDecoded !== decoded) {
    console.log(f + ': FAILED round-trip, content mismatch (len ' + browserDecoded.length + ' vs ' + decoded.length + ')');
    continue;
  }

  fs.copyFileSync(full, path.join(BACKUP, f));
  fs.writeFileSync(full, newHtml);
  console.log(f + ': FIXED (template len ' + decoded.length + ', escaped ' +
    ((jsonStr.match(/<\//g) || []).length) + ' occurrences)');
  fixedCount += 1;
}
console.log('\nTotal fixed: ' + fixedCount);
