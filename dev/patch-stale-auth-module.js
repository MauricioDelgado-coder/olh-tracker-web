#!/usr/bin/env node
/**
 * One-off patch: replace the stale embedded OLHAuth module (missing the
 * sandbox role, page.sanmpr, sandbox.edit, page.keys, page.synchistory,
 * page.timeoff, page.missedwalks -- three different stale generations found
 * across pages) with the current, correct module already shipping on
 * missed-walks.html / time-off.html / sync-conflicts.html / keys.html.
 *
 * Root cause: these pages are exported from a design tool as
 * __bundler/manifest assets (gzip+base64 JS blobs addressed by uuid), and
 * were not re-exported since the sandbox role was added on 2026-08-19. The
 * "plain" pages carry the auth module as literal inline script text instead,
 * which is why they were never affected.
 *
 * Effect of the bug before this patch: on every affected page, a user whose
 * server-assigned role does not exist in that page's stale ROLE_ALIAS/
 * DEFAULT_ROLES (currently: sandbox; concierge is ALSO missing from
 * ROLE_ALIAS -- see the printed warning) gets silently re-normalized to
 * "leadership" client-side after sign-in, and every server-granted
 * permission that page doesn't recognize (sandbox.edit, page.sanmpr, ...)
 * evaluates false. That includes tracker-san-mpr.html itself, so a sandbox
 * user landing there directly still could not edit and would be labeled
 * "Division Leadership".
 *
 *   node dev/patch-stale-auth-module.js [--apply]
 *
 * With no --apply, only reports what it would change (dry run).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PUB = path.join(__dirname, '..', 'public');
const APPLY = process.argv.includes('--apply');

const GOOD_SOURCE_PAGE = 'missed-walks.html';
const START_MARKER = '/* OLH shared authentication + change tracking.';

const TARGET_PAGES = [
  'admin.html', 'completion.html', 'homesite.html', 'index.html',
  'qa-management.html', 'scheduler.html', 'tracker-san-mpr.html', 'tracker.html',
  'walk-calendar.html', 'workload-visualizer.html', 'workload.html'
];

function extractGoodModule() {
  const content = fs.readFileSync(path.join(PUB, GOOD_SOURCE_PAGE), 'utf8');
  const start = content.indexOf(START_MARKER);
  if (start === -1) throw new Error(GOOD_SOURCE_PAGE + ': start marker not found -- is it still the source of truth?');
  const scriptOpenIdx = content.lastIndexOf('<script>', start);
  const bodyStart = content.indexOf('>', scriptOpenIdx) + 1;
  const scriptCloseIdx = content.indexOf('</script>', start);
  if (scriptOpenIdx === -1 || scriptCloseIdx === -1) throw new Error(GOOD_SOURCE_PAGE + ': could not bound the script block');
  const body = content.slice(bodyStart, scriptCloseIdx);
  // Sanity: this must be the CURRENT module, not another stale one.
  for (const must of ['"sandbox": "sandbox"', 'page.sanmpr', 'sandbox.edit', 'page.keys', 'page.synchistory']) {
    if (!body.includes(must)) throw new Error(GOOD_SOURCE_PAGE + ' is missing "' + must + '" -- it is not the source of truth either. Aborting.');
  }
  if (!body.includes('"concierge": "concierge"')) {
    throw new Error(GOOD_SOURCE_PAGE + ' is missing the concierge alias -- fix the source page first.');
  }
  return body;
}

function findAuthAsset(content) {
  const marker = '<script type="__bundler/manifest">';
  const i = content.indexOf(marker);
  if (i === -1) return null;
  const jsonStart = i + marker.length;
  const jsonEnd = content.indexOf('</script>', jsonStart);
  const manifest = JSON.parse(content.slice(jsonStart, jsonEnd));
  for (const uuid of Object.keys(manifest)) {
    const entry = manifest[uuid];
    if (!entry.mime || !/javascript/i.test(entry.mime)) continue;
    let text;
    try {
      const buf = Buffer.from(entry.data, 'base64');
      text = entry.compressed ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    } catch (e) { continue; }
    if (text.includes('ROLE_ALIAS') && text.includes('OLHSignIn')) {
      return { uuid, entry, oldText: text, oldDataB64: entry.data };
    }
  }
  return null;
}

const goodModule = extractGoodModule();
console.log('Source of truth: ' + GOOD_SOURCE_PAGE + ' (' + goodModule.length + ' chars)\n');

let changed = 0, skipped = 0, alreadyOk = 0;

for (const page of TARGET_PAGES) {
  const filePath = path.join(PUB, page);
  const content = fs.readFileSync(filePath, 'utf8');
  const asset = findAuthAsset(content);
  if (!asset) { console.log(page.padEnd(28) + 'SKIP -- no embedded OLHAuth asset found (plain page?)'); skipped++; continue; }

  if (asset.oldText.includes('"sandbox": "sandbox"') && asset.oldText.includes('page.sanmpr') && asset.oldText.includes('sandbox.edit')
      && asset.oldText.includes('"concierge": "concierge"')) {
    console.log(page.padEnd(28) + 'OK -- already current (uuid ' + asset.uuid + ')');
    alreadyOk++;
    continue;
  }

  const newBuf = zlib.gzipSync(Buffer.from(goodModule, 'utf8'));
  const newDataB64 = newBuf.toString('base64');

  console.log(page.padEnd(28) + 'STALE -- uuid ' + asset.uuid +
    '  old ' + asset.oldText.length + ' chars -> new ' + goodModule.length + ' chars' +
    '  (b64 ' + asset.oldDataB64.length + ' -> ' + newDataB64.length + ')');

  if (APPLY) {
    if (content.indexOf(asset.oldDataB64) === -1) throw new Error(page + ': old base64 data not found verbatim in file -- refusing to patch blindly.');
    if (content.indexOf(asset.oldDataB64) !== content.lastIndexOf(asset.oldDataB64)) throw new Error(page + ': old base64 data is not unique in file -- refusing to patch blindly.');
    const patched = content.replace(asset.oldDataB64, newDataB64);
    fs.writeFileSync(filePath, patched);

    // Verify: re-read, re-parse, re-decompress, confirm it now matches.
    const verifyContent = fs.readFileSync(filePath, 'utf8');
    const verifyAsset = findAuthAsset(verifyContent);
    if (!verifyAsset || !verifyAsset.oldText.includes('"sandbox": "sandbox"')) {
      throw new Error(page + ': verification FAILED after write -- manual review needed.');
    }
    console.log(''.padEnd(28) + '-> patched and verified.');
  }
  changed++;
}

console.log('\n' + changed + ' stale, ' + alreadyOk + ' already current, ' + skipped + ' skipped (plain pages).');
if (!APPLY && changed) console.log('Dry run only. Re-run with --apply to write changes.');
