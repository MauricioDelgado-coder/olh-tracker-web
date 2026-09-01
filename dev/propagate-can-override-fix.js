/**
 * One-off: propagate the just-fixed OLHAuth module (Auth.can()/allowedPages()
 * now honor state.can, i.e. per-user Permission Grants/Revokes overrides)
 * from missed-walks.html -- the source of truth -- into the other PLAIN pages
 * that carry an identical inline copy of the same module. These are not
 * bundler-manifest pages, so dev/patch-stale-auth-module.js's TARGET_PAGES
 * loop does not touch them; they need the same literal <script> block swap
 * missed-walks.html itself just got, applied by hand-equivalent find/replace.
 *
 *   node dev/propagate-can-override-fix.js [--apply|--check]
 *
 * No flag: dry run, reports what would change, exits 0.
 * --check: same dry run, exits 1 if anything is stale (CI-friendly).
 * --apply: writes the files.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const APPLY = process.argv.includes('--apply');
const CHECK = process.argv.includes('--check');

const GOOD_SOURCE_PAGE = 'missed-walks.html';
const START_MARKER = '/* OLH shared authentication + change tracking.';

// Every PLAIN page (literal inline script, not a __bundler/manifest blob)
// known to carry this module, besides the source page itself.
const TARGET_PAGES = [
  'sync-history.html', 'keys.html', 'walks-to-schedule.html',
  'sync-conflicts.html', 'time-off.html'
];

function extractGoodModule() {
  const content = fs.readFileSync(path.join(PUB, GOOD_SOURCE_PAGE), 'utf8');
  const start = content.indexOf(START_MARKER);
  if (start === -1) throw new Error(GOOD_SOURCE_PAGE + ': start marker not found.');
  const scriptOpenIdx = content.lastIndexOf('<script>', start);
  const bodyStart = content.indexOf('>', scriptOpenIdx) + 1;
  const scriptCloseIdx = content.indexOf('</script>', start);
  if (scriptOpenIdx === -1 || scriptCloseIdx === -1) throw new Error(GOOD_SOURCE_PAGE + ': could not bound the script block');
  const body = content.slice(bodyStart, scriptCloseIdx);
  for (const must of ['state.can', 'if (state.can) return state.can.indexOf(perm)']) {
    if (!body.includes(must)) throw new Error(GOOD_SOURCE_PAGE + ' is missing "' + must + '" -- the fix did not land there. Aborting.');
  }
  return body;
}

const goodModule = extractGoodModule();
console.log('Source of truth: ' + GOOD_SOURCE_PAGE + ' (' + goodModule.length + ' chars)\n');

let changed = 0, skipped = 0, alreadyOk = 0;

for (const page of TARGET_PAGES) {
  const filePath = path.join(PUB, page);
  if (!fs.existsSync(filePath)) { console.log('SKIP  ' + page + ' (not found)'); skipped++; continue; }
  const content = fs.readFileSync(filePath, 'utf8');
  const start = content.indexOf(START_MARKER);
  if (start === -1) { console.log('SKIP  ' + page + ' (no shared-auth marker -- not this module)'); skipped++; continue; }
  const scriptOpenIdx = content.lastIndexOf('<script>', start);
  const bodyStart = content.indexOf('>', scriptOpenIdx) + 1;
  const scriptCloseIdx = content.indexOf('</script>', start);
  if (scriptOpenIdx === -1 || scriptCloseIdx === -1) { console.log('SKIP  ' + page + ' (could not bound script block)'); skipped++; continue; }
  const currentBody = content.slice(bodyStart, scriptCloseIdx);
  if (currentBody === goodModule) { console.log('OK    ' + page + ' (already current)'); alreadyOk++; continue; }
  if (currentBody.includes('if (state.can) return state.can.indexOf(perm)')) {
    console.log('OK    ' + page + ' (already has the fix, body differs elsewhere -- not touching)');
    alreadyOk++; continue;
  }
  console.log((APPLY ? 'PATCH ' : 'WOULD PATCH ') + page);
  changed++;
  if (APPLY) {
    const next = content.slice(0, bodyStart) + goodModule + content.slice(scriptCloseIdx);
    fs.writeFileSync(filePath, next, 'utf8');
  }
}

console.log('\n' + changed + ' changed, ' + alreadyOk + ' already OK, ' + skipped + ' skipped.');
if (CHECK && changed > 0) process.exit(1);
