/* Live end-to-end test against the real Airtable base.
   Writes to ONE real record, verifies, then restores the original values.
   Run: node live_test.js   (not part of the deployed site) */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AIRTABLE_PAT = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.config/olh-qa-tracker/config.json'), 'utf8')
).airtable_pat;

const jobsFn = require('../netlify/functions/jobs.js');
const updateFn = require('../netlify/functions/update-job.js');

const post = (body) => updateFn.handler({
  httpMethod: 'POST', body: JSON.stringify(body), headers: {}
});

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  -> ' + extra : ''}`); }
}

(async () => {
  console.log('\n=== 1. jobs.js against live Airtable ===');
  const t0 = Date.now();
  const res = await jobsFn.handler({ httpMethod: 'GET', queryStringParameters: {}, headers: {} });
  console.log('  status', res.statusCode, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const data = JSON.parse(res.body);
  check('status 200', res.statusCode === 200);
  check('904 jobs returned', data.jobs.length === 904, 'got ' + data.jobs.length);
  check('37 managers returned', data.managers.length === 37, 'got ' + data.managers.length);
  check('managers have id + name', data.managers.every(m => /^rec/.test(m.id) && m.name));
  check('no token leaked in response', !res.body.includes(process.env.AIRTABLE_PAT));
  check('jobs carry Job #', data.jobs.every(j => j.fields['Job #']));

  const target = data.jobs.find(j => j.fields['Job #']);
  const mgr = data.managers[0];
  console.log(`\n  test record: ${target.fields['Job #']} (${target.id})`);
  console.log(`  test manager: ${mgr.name} (${mgr.id})`);
  const original = {
    'QA Ready': target.fields['QA Ready'] || false,
    'QAI Date': target.fields['QAI Date'] || null,
    'QAI Manager': target.fields['QAI Manager'] || [],
    'Construction Risk Notes': target.fields['Construction Risk Notes'] || ''
  };

  console.log('\n=== 2. rejection path (live handler, no write should occur) ===');
  for (const [label, body] of [
    ['Record Status blocked', { 'Record Status': 'Closed' }],
    ['Estimated COE Date blocked', { 'Estimated COE Date': '2027-01-01' }],
    ['Last Synced blocked', { 'Last Synced': '2020-01-01T00:00:00Z' }],
    ['mixed valid+invalid rejected wholesale', { 'QA Ready': true, 'Record Status': 'Closed' }],
    ['__proto__ blocked', { '__proto__': 'x' }]
  ]) {
    const r = await post({ recordId: target.id, fields: body });
    check(label + ' -> 400', r.statusCode === 400, 'got ' + r.statusCode);
  }

  console.log('\n=== 3. real write of all four editable types ===');
  const stamp = 'e2e test ' + new Date().toISOString();
  const w = await post({ recordId: target.id, fields: {
    'QA Ready': true,
    'QAI Date': '2026-07-29',
    'QAI Manager': [mgr.id],
    'Construction Risk Notes': stamp
  }});
  console.log('  status', w.statusCode);
  check('write returned 200', w.statusCode === 200, w.body.slice(0, 200));

  const after = await jobsFn.handler({ httpMethod: 'GET', queryStringParameters: { refresh: '1' }, headers: {} });
  const row = JSON.parse(after.body).jobs.find(j => j.id === target.id).fields;
  check('QA Ready persisted', row['QA Ready'] === true);
  check('QAI Date persisted', row['QAI Date'] === '2026-07-29', row['QAI Date']);
  check('QAI Manager linked', (row['QAI Manager'] || [])[0] === mgr.id);
  check('notes persisted', row['Construction Risk Notes'] === stamp);
  check('SF field untouched', row['Estimated COE Date'] === target.fields['Estimated COE Date']);
  check('Record Status still Active', row['Record Status'] === 'Active');

  console.log('\n=== 4. restore original values ===');
  const r = await post({ recordId: target.id, fields: original });
  check('restore returned 200', r.statusCode === 200, r.body.slice(0, 200));
  const fin = await jobsFn.handler({ httpMethod: 'GET', queryStringParameters: { refresh: '1' }, headers: {} });
  const back = JSON.parse(fin.body).jobs.find(j => j.id === target.id).fields;
  check('QA Ready restored', !back['QA Ready']);
  check('QAI Date cleared', !back['QAI Date']);
  check('QAI Manager cleared', !(back['QAI Manager'] || []).length);
  check('notes cleared', !back['Construction Risk Notes']);

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL LIVE CHECKS PASSED'}  (${pass} passed, ${fail} failed)`);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
