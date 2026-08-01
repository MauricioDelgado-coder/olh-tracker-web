#!/usr/bin/env node
/**
 * Prove the sync did not touch anything a person typed.
 *
 *   AIRTABLE_PAT=... node dev/verify-qa-preserved.js /tmp/qa-snapshot-before.json
 *
 * Compares every hand-entered field captured before the run against the table
 * after it. The sync is supposed to write only Salesforce-owned columns and to
 * archive rather than delete, so the correct result is zero differences and zero
 * missing job numbers -- including for the rows that left the pull, which are the
 * ones actually at risk.
 *
 * Also checks for duplicate Job # values, since a create-instead-of-update bug
 * shows up as a second row with the same primary key rather than as an error.
 */
'use strict';

const fs = require('fs');

const API = 'https://api.airtable.com/v0';
const BASE = 'appYX9df4lGO6G2uz';
const T = 'tblqpmwtZ6i4gtogl';
const PAT = process.env.AIRTABLE_PAT;
const snapPath = process.argv[2] || '/tmp/qa-snapshot-before.json';
if (!PAT) { console.error('AIRTABLE_PAT not set'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => (Array.isArray(v) ? v.slice().sort().join('|') : String(v ?? ''));

(async () => {
  const before = JSON.parse(fs.readFileSync(snapPath, 'utf8'));

  const recs = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const r = await fetch(`${API}/${BASE}/${T}?${qs}`, { headers: { Authorization: 'Bearer ' + PAT } });
    if (!r.ok) { console.error('Airtable ' + r.status); process.exit(1); }
    const j = await r.json();
    recs.push(...(j.records || []));
    offset = j.offset || null;
    if (offset) await sleep(220);
  } while (offset);

  const byJob = new Map();
  const dupes = [];
  for (const r of recs) {
    const job = String((r.fields || {})['Job #'] || '').trim();
    if (!job) continue;
    if (byJob.has(job)) dupes.push(job);
    else byJob.set(job, r.fields || {});
  }

  let checked = 0;
  let missing = [];
  const changed = [];
  for (const [job, fields] of Object.entries(before)) {
    const now = byJob.get(job);
    if (!now) { missing.push(job); continue; }
    for (const [k, v] of Object.entries(fields)) {
      checked += 1;
      if (norm(now[k]) !== norm(v)) changed.push([job, k, v, now[k]]);
    }
  }

  const active = recs.filter((r) => (r.fields || {})['Record Status'] === 'Active').length;
  const closed = recs.filter((r) => (r.fields || {})['Record Status'] === 'Closed').length;

  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log(pad('rows in Airtable', 42) + recs.length);
  console.log(pad('  Active', 42) + active);
  console.log(pad('  Closed (archived, kept)', 42) + closed);
  console.log(pad('duplicate Job # values', 42) + dupes.length + (dupes.length ? '  ' + dupes.slice(0, 5).join(', ') : ''));
  console.log('');
  console.log(pad('rows snapshotted with QA data', 42) + Object.keys(before).length);
  console.log(pad('hand-entered values checked', 42) + checked);
  console.log(pad('rows that disappeared', 42) + missing.length);
  console.log(pad('hand-entered values CHANGED', 42) + changed.length);

  if (missing.length) {
    console.log('\nMISSING job numbers (data loss):');
    missing.slice(0, 20).forEach((j) => console.log('   ' + j));
  }
  if (changed.length) {
    console.log('\nCHANGED hand-entered values:');
    changed.slice(0, 20).forEach(([j, k, was, now]) =>
      console.log('   ' + pad(j, 16) + pad(k, 26) + JSON.stringify(was) + '  ->  ' + JSON.stringify(now)));
  }

  const ok = !missing.length && !changed.length && !dupes.length;
  console.log('\n' + (ok
    ? 'PASS - every hand-entered value survived, no duplicates.'
    : 'FAIL - see above.'));
  process.exit(ok ? 0 : 1);
})();
