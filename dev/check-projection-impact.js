#!/usr/bin/env node
/**
 * Two questions this answers against the live Jobs table:
 *
 *   1. How many Completion Report rows actually GAIN a date from the
 *      calculated QAI/QAA fallback -- i.e. how much of the report was showing
 *      an em dash where the tracker showed a blue date.
 *
 *   2. How many phantom projections workload.html / scheduler.html currently
 *      draw because neither applies rule 3: a walk marked complete with a
 *      blank date still resolves to PCD-7 / PCD and lands on the calendar.
 *      This is the number that moves if rule 3 is applied there.
 *
 * Read-only. Prints counts and a short sample of Job #s, never the token.
 *
 *   AIRTABLE_PAT=... node dev/check-projection-impact.js
 */
'use strict';

const BASE_ID = 'appYX9df4lGO6G2uz';
const JOBS_TABLE = 'tblqpmwtZ6i4gtogl';

const pat = process.env.AIRTABLE_PAT;
if (!pat) { console.error('AIRTABLE_PAT is not set'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (v) => (v ? String(v).slice(0, 10) : '');
const LOTS = { B: 1, S: 1, W: 1, M: 1 };

// The Completion Report's own scope, kept in step with public/completion.html.
const inScope = (f) => (f['Record Status'] || '') === 'Active'
  && !!iso(f['Actual Start Date'])
  && !iso(f['Actual Completion Date'])
  && !iso(f['Actual COE Date'])
  && iso(f['Projected Completion Date']) >= '2026-07-01'
  && LOTS[(f['Lot Status'] || '').trim().toUpperCase()] === 1;

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

const WALK = {
  QAI: { date: 'QAI Date', done: 'QAI Complete' },
  QAA: { date: 'QAA Date', done: 'QAA Accepted' }
};

const sample = (rows) => rows.slice(0, 5).map((f) => f['Job #']).join(', ') || '(none)';
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '-');

(async () => {
  const rows = await allRows();
  const scope = rows.filter(inScope);

  console.log('\n' + '='.repeat(68));
  console.log('1. Completion Report: rows that GAIN a calculated date');
  console.log('='.repeat(68));
  console.log('   live job rows      ' + String(rows.length).padStart(6));
  console.log('   in report scope    ' + String(scope.length).padStart(6));

  for (const code of ['QAI', 'QAA']) {
    const w = WALK[code];
    const hadReal = scope.filter((f) => !!iso(f[w.date]));
    const gains = scope.filter((f) => !iso(f[w.date]) && !f[w.done] && !!iso(f['Projected Completion Date']));
    const doneBlank = scope.filter((f) => !iso(f[w.date]) && !!f[w.done]);
    const noPcd = scope.filter((f) => !iso(f[w.date]) && !f[w.done] && !iso(f['Projected Completion Date']));
    console.log('\n   ' + code);
    console.log('     real date on the record   ' + String(hadReal.length).padStart(6) + '   ' + pct(hadReal.length, scope.length));
    console.log('     WAS blank, NOW calculated ' + String(gains.length).padStart(6) + '   ' + pct(gains.length, scope.length) + '   ' + sample(gains));
    console.log('     blank + complete -> Done  ' + String(doneBlank.length).padStart(6) + '   ' + pct(doneBlank.length, scope.length));
    console.log('     blank, no PCD -> still -- ' + String(noPcd.length).padStart(6) + '   ' + pct(noPcd.length, scope.length));
  }

  console.log('\n' + '='.repeat(68));
  console.log('2. workload.html / scheduler.html rule-3 gap (phantom projections)');
  console.log('='.repeat(68));
  console.log('   A walk marked COMPLETE with a BLANK date still resolves to');
  console.log('   PCD-7 / PCD on those pages and is drawn on the calendar.\n');

  const active = rows.filter((f) => (f['Record Status'] || '') === 'Active');
  let total = 0;
  for (const code of ['QAI', 'QAA']) {
    const w = WALK[code];
    const phantom = active.filter((f) => !iso(f[w.date]) && !!f[w.done] && !!iso(f['Projected Completion Date']));
    total += phantom.length;
    console.log('   ' + code + ' complete + blank date   ' + String(phantom.length).padStart(6) + '   ' + sample(phantom));
  }

  const homes = active.filter((f) =>
    (!iso(f['QAI Date']) && !!f['QAI Complete']) || (!iso(f['QAA Date']) && !!f['QAA Accepted']));
  console.log('\n   phantom walks total     ' + String(total).padStart(6));
  console.log('   homes affected          ' + String(homes.length).padStart(6) +
    '   of ' + active.length + ' active (' + pct(homes.length, active.length) + ')');
  console.log('');
})();
