#!/usr/bin/env node
/**
 * Compare the no-Actual-COE Salesforce pull against what the Airtable Jobs table
 * currently holds, before changing where the tracker gets its data.
 *
 *   AIRTABLE_PAT=... node dev/compare-coe-scope.js <coe-jobs.tsv>
 *
 * The TSV is Job # / Homesite Status / Bucket / Construction State / Community,
 * one row per homesite, exported from the workbook.
 *
 * The point is to see what switching source would ADD, what it would DROP, and --
 * most importantly -- how much manually-maintained QA data sits on the rows that
 * would be dropped. Those fields exist nowhere else.
 */
'use strict';

const fs = require('fs');

const BASE = 'appYX9df4lGO6G2uz';
const JOBS = 'tblqpmwtZ6i4gtogl';
const API = 'https://api.airtable.com/v0';
const PAT = process.env.AIRTABLE_PAT;
const tsv = process.argv[2];

if (!PAT) { console.error('AIRTABLE_PAT not set'); process.exit(1); }
if (!tsv) { console.error('usage: node dev/compare-coe-scope.js <coe-jobs.tsv>'); process.exit(2); }

// Fields a person typed in. None of them come from Salesforce, so a row dropped
// from the tracker takes them with it.
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

async function allJobs() {
  const recs = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const res = await fetch(`${API}/${BASE}/${JOBS}?${qs}`, { headers: { Authorization: 'Bearer ' + PAT } });
    if (!res.ok) { console.error('Airtable ' + res.status); process.exit(1); }
    const j = await res.json();
    recs.push(...(j.records || []));
    offset = j.offset || null;
    if (offset) await sleep(220);
  } while (offset);
  return recs;
}

const hasManual = (f) => MANUAL.some((k) => {
  const v = f[k];
  if (v === undefined || v === null || v === '') return false;
  if (v === false) return false;
  if (Array.isArray(v) && !v.length) return false;
  return true;
});

(async () => {
  const coe = new Map();
  for (const line of fs.readFileSync(tsv, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [job, status, bucket, cstate, community] = line.split('\t');
    coe.set(job.trim(), { status, bucket, cstate, community });
  }

  const recs = await allJobs();
  const air = new Map();
  for (const r of recs) {
    const f = r.fields || {};
    const job = String(f['Job #'] || '').trim();
    if (job) air.set(job, f);
  }

  const both = [...coe.keys()].filter((j) => air.has(j));
  const onlyCoe = [...coe.keys()].filter((j) => !air.has(j));
  const onlyAir = [...air.keys()].filter((j) => !coe.has(j));

  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + pad('Airtable Jobs (current tracker)', 40) + recs.length);
  console.log(pad('no-COE workbook', 40) + coe.size);
  console.log(pad('in both', 40) + both.length);
  console.log(pad('only in no-COE (would be ADDED)', 40) + onlyCoe.length);
  console.log(pad('only in Airtable (would be DROPPED)', 40) + onlyAir.length);

  // What the additions are.
  const byBucket = {};
  for (const j of onlyCoe) {
    const k = coe.get(j).bucket || '(none)';
    byBucket[k] = (byBucket[k] || 0) + 1;
  }
  console.log('\nADDED rows by bucket:');
  for (const [k, v] of Object.entries(byBucket).sort((a, b) => b[1] - a[1])) {
    console.log('   ' + pad(k, 44) + v);
  }

  // The part that actually decides the approach.
  const dropWithManual = onlyAir.filter((j) => hasManual(air.get(j)));
  const closed = onlyAir.filter((j) => air.get(j)['Actual COE Date'] || air.get(j)['Record Status'] === 'Closed');
  console.log('\nDROPPED rows:');
  console.log('   ' + pad('already closed / archived', 44) + closed.length);
  console.log('   ' + pad('carrying manual QA data', 44) + dropWithManual.length);

  if (dropWithManual.length) {
    console.log('\n   sample of dropped rows holding hand-entered data:');
    for (const j of dropWithManual.slice(0, 12)) {
      const f = air.get(j);
      const set = MANUAL.filter((k) => {
        const v = f[k];
        return !(v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length));
      });
      console.log('     ' + pad(j, 16) + pad(f['Record Status'] || '', 9) + set.slice(0, 6).join(', ') +
                  (set.length > 6 ? ' +' + (set.length - 6) : ''));
    }
  }

  const bothWithManual = both.filter((j) => hasManual(air.get(j)));
  console.log('\n' + pad('overlapping rows with manual data', 44) + bothWithManual.length);
  console.log(pad('total rows with manual data in Airtable', 44) +
              [...air.keys()].filter((j) => hasManual(air.get(j))).length);
})();
