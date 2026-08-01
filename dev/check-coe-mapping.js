#!/usr/bin/env node
/**
 * Decide which Airtable column each ambiguous report column maps to, by
 * measuring agreement on the ~929 job numbers present in both.
 *
 *   AIRTABLE_PAT=... node dev/check-coe-mapping.js <coe-map.tsv>
 *
 * Two pairs are genuinely ambiguous by name and dangerous to guess:
 *   report "Estimated COE Date"     (Scheduled_Close_Date__c)
 *   report "JDE Sched Close (ECOE)" (JDE_Scheduled_Close_Date_ECOE__c)
 * against Airtable's "Estimated COE Date" and "Scheduled Closing Date".
 *
 * The skill's own notes warn that Scheduled_Close_Date__c is labelled
 * misleadingly in Salesforce -- it is the estimated COE, not the actual -- and
 * that getting it backwards inverts the report. The same mistake here would
 * quietly rewrite every close date in the tracker, so it is measured, not
 * assumed: whichever pairing agrees on nearly every overlapping row is the
 * right one, and a near-tie means stop and look.
 */
'use strict';

const fs = require('fs');

const BASE = 'appYX9df4lGO6G2uz';
const JOBS = 'tblqpmwtZ6i4gtogl';
const API = 'https://api.airtable.com/v0';
const PAT = process.env.AIRTABLE_PAT;
const tsvPath = process.argv[2];

if (!PAT || !tsvPath) { console.error('usage: AIRTABLE_PAT=... node dev/check-coe-mapping.js <tsv>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (v) => (v ? String(v).slice(0, 10) : '');

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
  const lines = fs.readFileSync(tsvPath, 'utf8').split('\n').filter((l) => l.trim());
  const hdr = lines[0].split('\t');
  const col = (n) => hdr.indexOf(n);
  const report = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    report.set(c[col('Job #')].trim(), c);
  }

  const air = new Map();
  for (const r of await allJobs()) {
    const f = r.fields || {};
    const job = String(f['Job #'] || '').trim();
    if (job) air.set(job, f);
  }

  const both = [...report.keys()].filter((j) => air.has(j));
  console.log('overlapping job numbers: ' + both.length + '\n');

  // candidate pairings: [report column, airtable field]
  const pairs = [
    ['Estimated COE Date', 'Estimated COE Date'],
    ['Estimated COE Date', 'Scheduled Closing Date'],
    ['JDE Sched Close (ECOE)', 'Estimated COE Date'],
    ['JDE Sched Close (ECOE)', 'Scheduled Closing Date'],
    ['Projected Completion', 'Projected Completion Date'],
    ['Constr Stage (JDE)', 'Construction Stage (JDE)'],
    ['Construction Stage', 'Construction Stage (JDE)'],
    ['Lot Status', 'Lot Status']
  ];

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('report column', 26) + pad('airtable field', 28) +
              pad('both set', 10) + pad('agree', 9) + '%');
  console.log('-'.repeat(80));

  for (const [rc, af] of pairs) {
    let bothSet = 0;
    let agree = 0;
    for (const j of both) {
      const rv = day(report.get(j)[col(rc)]);
      const av = day(air.get(j)[af]);
      if (!rv || !av) continue;
      bothSet += 1;
      if (rv === av) agree += 1;
    }
    const pct = bothSet ? ((agree / bothSet) * 100).toFixed(1) : '--';
    console.log(pad(rc, 26) + pad(af, 28) + pad(bothSet, 10) + pad(agree, 9) + pct);
  }

  // Also: does Airtable hold anything the report would blank out?
  console.log('\nAirtable values that are set where the report is empty (would be cleared):');
  for (const [rc, af] of pairs) {
    let n = 0;
    for (const j of both) {
      if (!day(report.get(j)[col(rc)]) && day(air.get(j)[af])) n += 1;
    }
    if (n) console.log('   ' + pad(rc + ' -> ' + af, 54) + n);
  }
})();
