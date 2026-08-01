#!/usr/bin/env node
/**
 * Remove duplicate Job # rows from the Airtable Jobs table.
 *
 *   AIRTABLE_PAT=... node dev/dedupe-jobs.js            # report only
 *   AIRTABLE_PAT=... node dev/dedupe-jobs.js --apply    # delete
 *
 * Job # is the primary field but Airtable does not enforce uniqueness on it, so
 * two concurrent sync runs each created the same 471 homesites and the table
 * ended up holding every one of them twice. Nothing errored; the tracker just
 * showed 1963 rows where 1492 exist.
 *
 * Which copy to keep: the OLDEST, because the manually maintained QA fields --
 * walk dates, managers, key handover, notes -- can only be on a row that has
 * existed long enough for someone to have typed them. A newer duplicate is by
 * definition a fresh empty shell.
 *
 * Safety: any duplicate group where MORE THAN ONE row carries hand-entered data
 * is left completely alone and reported. That would mean real work exists on both
 * copies and merging is a judgement call, not a script's decision.
 */
'use strict';

const API = 'https://api.airtable.com/v0';
const BASE = 'appYX9df4lGO6G2uz';
const T = 'tblqpmwtZ6i4gtogl';
const PAT = process.env.AIRTABLE_PAT;
const APPLY = process.argv.includes('--apply');

if (!PAT) { console.error('AIRTABLE_PAT not set'); process.exit(1); }

const MANUAL = [
  'QA Ready', 'QAI Date', 'QAI Manager', 'QAI Complete',
  'QAA Date', 'QAA Manager', 'QAA Accepted',
  'CEL Date', 'CEL Manager', 'CEL Completed', 'Buyer Attended CEL',
  'ACC Date', 'ACC Manager', 'ACC Completed', 'Buyer Attended ACC',
  'NOC Lock Date', 'Power Meter', 'Water Meter',
  'Construction Risk', 'Construction Risk Notes',
  'Land Risk', 'Land Risk Notes',
  'Key Status', 'Delivered To', 'Delivery Date', 'Notes', 'CEL Letter Sent'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const manualCount = (f) => MANUAL.filter((k) => {
  const v = f[k];
  if (v === undefined || v === null || v === '' || v === false) return false;
  if (Array.isArray(v) && !v.length) return false;
  return true;
}).length;

async function fetchAll() {
  const recs = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const r = await fetch(`${API}/${BASE}/${T}?${qs}`, { headers: { Authorization: 'Bearer ' + PAT } });
    if (!r.ok) { console.error('Airtable ' + r.status + ': ' + (await r.text()).slice(0, 200)); process.exit(1); }
    const j = await r.json();
    recs.push(...(j.records || []));
    offset = j.offset || null;
    if (offset) await sleep(220);
  } while (offset);
  return recs;
}

(async () => {
  const recs = await fetchAll();
  const groups = new Map();
  for (const r of recs) {
    const job = String((r.fields || {})['Job #'] || '').trim();
    if (!job) continue;
    if (!groups.has(job)) groups.set(job, []);
    groups.get(job).push(r);
  }

  const dupeGroups = [...groups.entries()].filter(([, rs]) => rs.length > 1);
  const pad = (s, n) => String(s).padEnd(n);

  console.log('\n' + pad('rows in table', 40) + recs.length);
  console.log(pad('distinct Job # values', 40) + groups.size);
  console.log(pad('Job # values with duplicates', 40) + dupeGroups.length);

  if (!dupeGroups.length) {
    console.log('\nNothing to do.');
    return;
  }

  const toDelete = [];
  const conflicts = [];

  for (const [job, rows] of dupeGroups) {
    const withData = rows.filter((r) => manualCount(r.fields || {}) > 0);
    if (withData.length > 1) { conflicts.push([job, withData.length]); continue; }

    // Keep the row with hand-entered data if exactly one has it; otherwise the oldest.
    const keep = withData.length === 1
      ? withData[0]
      : rows.slice().sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)))[0];

    for (const r of rows) if (r.id !== keep.id) toDelete.push({ job, id: r.id });
  }

  console.log(pad('rows to delete', 40) + toDelete.length);
  console.log(pad('groups left alone (data on both)', 40) + conflicts.length);

  if (conflicts.length) {
    console.log('\nNOT touching these -- hand-entered data on more than one copy,');
    console.log('so which to keep is a judgement call:');
    conflicts.slice(0, 20).forEach(([j, n]) => console.log('   ' + pad(j, 18) + n + ' rows with data'));
  }

  // A deletion must never remove the only copy.
  for (const d of toDelete) {
    const remaining = groups.get(d.job).filter((r) => !toDelete.some((x) => x.id === r.id));
    if (!remaining.length) {
      console.error('\nREFUSING: deleting ' + d.job + ' would remove every copy.');
      process.exit(1);
    }
  }

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply to delete.');
    return;
  }

  console.log('\nDeleting...');
  let done = 0;
  for (let i = 0; i < toDelete.length; i += 10) {
    const chunk = toDelete.slice(i, i + 10);
    const qs = chunk.map((d) => 'records[]=' + encodeURIComponent(d.id)).join('&');
    const r = await fetch(`${API}/${BASE}/${T}?${qs}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + PAT }
    });
    if (!r.ok) { console.error('Airtable ' + r.status + ': ' + (await r.text()).slice(0, 300)); process.exit(1); }
    done += chunk.length;
    if (done % 100 === 0 || done === toDelete.length) console.log('   deleted ' + done + '/' + toDelete.length);
    await sleep(250);
  }

  const after = await fetchAll();
  const stillDupe = new Set();
  const seen = new Set();
  for (const r of after) {
    const job = String((r.fields || {})['Job #'] || '').trim();
    if (!job) continue;
    if (seen.has(job)) stillDupe.add(job);
    seen.add(job);
  }
  console.log('\n' + pad('rows now', 40) + after.length);
  console.log(pad('duplicates remaining', 40) + stillDupe.size +
              (stillDupe.size ? '  (expected: the ' + conflicts.length + ' left alone)' : ''));
})();
