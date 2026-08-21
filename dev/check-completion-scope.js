#!/usr/bin/env node
/**
 * Run the Completion Report's OWN scope predicate against the live Jobs table.
 *
 *   AIRTABLE_PAT=… node dev/check-completion-scope.js [expected-count]
 *
 * The scope lives in the page, not in a loader, so the only honest way to know
 * what the report will show is to lift `inScope` out of the built page and
 * evaluate it over the same rows /api/jobs serves. Re-deriving the predicate
 * here would just be testing a copy against itself -- the copy is exactly what
 * drifts.
 *
 * Also breaks the count down one condition at a time, so a number that looks
 * wrong can be attributed to a clause instead of guessed at.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_ID = 'appYX9df4lGO6G2uz';
const JOBS_TABLE = 'tblqpmwtZ6i4gtogl';
const PAGE = path.join(__dirname, '..', 'public', 'completion.html');
const EXPECTED = process.argv[2] ? Number(process.argv[2]) : null;

const pat = process.env.AIRTABLE_PAT;
if (!pat) { console.error('AIRTABLE_PAT is not set'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (v) => (v ? String(v).slice(0, 10) : '');

/** Lift `const LOTS = …` through the end of `inScope` out of the built page. */
function shippedScope() {
  const raw = fs.readFileSync(PAGE, 'utf8');
  const openTag = '<script type="__bundler/template">';
  const start = raw.indexOf(openTag);
  if (start === -1) { console.error('no template block in ' + PAGE); process.exit(1); }
  // The JSON-encoded template string sits on the SAME line as the opening
  // tag (immediately after it), not on the following line -- it runs from
  // the first `"` after the tag to the matching closing `"` right before
  // the literal `</script>` that ends this block.
  const jsonStart = start + openTag.length;
  const closeTag = '</script>';
  const end = raw.indexOf(closeTag, jsonStart);
  if (end === -1) { console.error('no closing </script> after template block in ' + PAGE); process.exit(1); }
  const tpl = JSON.parse(raw.slice(jsonStart, end));

  const a = tpl.indexOf('const LOTS = {');
  const b = tpl.indexOf(';', tpl.indexOf('LOTS[(f[', a)) + 1;
  if (a === -1 || b <= 0) { console.error('could not find inScope in the built page'); process.exit(1); }
  const src = tpl.slice(a, b);

  // eslint-disable-next-line no-new-func
  const fn = new Function('iso', src + '\nreturn inScope;')(iso);
  return { fn, src };
}

async function allRows() {
  const out = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${JOBS_TABLE}?${qs}`,
      { headers: { Authorization: 'Bearer ' + pat } }
    );
    if (!res.ok) { console.error('Airtable ' + res.status); process.exit(1); }
    const j = await res.json();
    out.push(...(j.records || []).map((r) => r.fields || {}));
    offset = j.offset || null;
    if (offset) await sleep(220);
  } while (offset);
  return out;
}

(async () => {
  const { fn, src } = shippedScope();
  console.log('\n=== the predicate the page will actually run ===');
  console.log(src.split('\n').map((l) => '  ' + l).join('\n'));

  const rows = await allRows();
  const inScope = rows.filter((f) => fn(f));

  console.log('\n=== against ' + rows.length + ' live job rows ===');
  console.log('  in scope: ' + inScope.length);

  const C = {
    Active:        (f) => (f['Record Status'] || '') === 'Active',
    started:       (f) => !!iso(f['Actual Start Date']),
    notComplete:   (f) => !iso(f['Actual Completion']),
    noActualCoe:   (f) => !iso(f['Actual COE Date']),
    projFrom0701:  (f) => iso(f['Projected Completion']) >= '2026-07-01',
    lotBSWM:       (f) => ['B', 'S', 'W', 'M'].includes((f['Lot Status'] || '').trim().toUpperCase())
  };
  console.log('\n=== cumulative ===');
  const keys = Object.keys(C);
  for (let i = 1; i <= keys.length; i++) {
    const n = rows.filter((f) => keys.slice(0, i).every((k) => C[k](f))).length;
    console.log('  + ' + keys[i - 1].padEnd(14) + String(n).padStart(6));
  }

  console.log('\n=== nothing out of scope slipped through ===');
  const bad = [
    ['archived rows',          inScope.filter((f) => (f['Record Status'] || '') !== 'Active')],
    ['not started',            inScope.filter((f) => !iso(f['Actual Start Date']))],
    ['already complete',       inScope.filter((f) => !!iso(f['Actual Completion']))],
    ['has an Actual COE',      inScope.filter((f) => !!iso(f['Actual COE Date']))],
    ['lot status outside BSWM', inScope.filter((f) => !C.lotBSWM(f))]
  ];
  let failed = 0;
  for (const [label, rowsBad] of bad) {
    if (rowsBad.length === 0) console.log('   ok    no ' + label);
    else {
      failed += 1;
      console.log('   FAIL  ' + rowsBad.length + ' ' + label + ': ' +
        rowsBad.slice(0, 3).map((f) => f['Job #']).join(', '));
    }
  }

  if (EXPECTED !== null) {
    if (inScope.length === EXPECTED) console.log('   ok    count is ' + EXPECTED);
    else { failed += 1; console.log('   FAIL  count is ' + inScope.length + ', expected ' + EXPECTED); }
  }

  console.log('');
  if (failed) { console.log(failed + ' CHECK(S) FAILED'); process.exit(1); }
  console.log('ALL CHECKS PASSED');
})();
