#!/usr/bin/env node
/**
 * Show current-vs-incoming values for one field, on rows the sync says will change.
 *
 *   AIRTABLE_PAT=... node dev/spot-check-values.js <tsv> <report-col> <airtable-field>
 *
 * A field that changes on nearly every row is either genuinely stale everywhere
 * or, far more often, a formatting mismatch that would overwrite good data with
 * differently-shaped data. Reading a dozen pairs settles which.
 */
'use strict';

const fs = require('fs');

const BASE = 'appYX9df4lGO6G2uz';
const JOBS = 'tblqpmwtZ6i4gtogl';
const API = 'https://api.airtable.com/v0';
const PAT = process.env.AIRTABLE_PAT;
const [tsv, reportCol, airField] = process.argv.slice(2);
if (!PAT || !tsv || !reportCol || !airField) {
  console.error('usage: AIRTABLE_PAT=... node dev/spot-check-values.js <tsv> <report-col> <airtable-field>');
  process.exit(2);
}

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

(async () => {
  const lines = fs.readFileSync(tsv, 'utf8').split('\n').filter((l) => l.trim());
  const hdr = lines[0].split('\t');
  const ci = hdr.indexOf(reportCol);
  const ji = hdr.indexOf('Job #');
  if (ci < 0) { console.error('no column "' + reportCol + '" in ' + tsv + '\n  have: ' + hdr.join(', ')); process.exit(1); }

  const report = new Map();
  for (const l of lines.slice(1)) {
    const c = l.split('\t');
    report.set(c[ji].trim(), (c[ci] || '').trim());
  }

  const air = new Map();
  for (const r of await allJobs()) {
    const f = r.fields || {};
    const job = String(f['Job #'] || '').trim();
    if (job) air.set(job, f);
  }

  const both = [...report.keys()].filter((j) => air.has(j));
  let same = 0;
  const diffs = [];
  let bothBlank = 0;
  let onlyReport = 0;
  let onlyAir = 0;

  for (const j of both) {
    const rv = report.get(j);
    const av = String(air.get(j)[airField] ?? '').trim();
    if (!rv && !av) { bothBlank += 1; continue; }
    if (!rv) { onlyAir += 1; continue; }
    if (!av) { onlyReport += 1; continue; }
    if (rv === av) same += 1;
    else diffs.push([j, av, rv]);
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + reportCol + '  ->  ' + airField);
  console.log('  overlapping rows      ' + both.length);
  console.log('  identical             ' + same);
  console.log('  differ                ' + diffs.length);
  console.log('  both blank            ' + bothBlank);
  console.log('  only in report        ' + onlyReport + '   (Airtable blank, would be filled)');
  console.log('  only in Airtable      ' + onlyAir + '   (report blank, would be CLEARED)');

  if (diffs.length) {
    console.log('\n  ' + pad('job #', 16) + pad('airtable now', 34) + 'incoming');
    for (const [j, av, rv] of diffs.slice(0, 15)) {
      console.log('  ' + pad(j, 16) + pad(JSON.stringify(av), 34) + JSON.stringify(rv));
    }
  }
})();
