/**
 * Monthly CCR bonus self-reporting, per the CCR Bonus Agreement.
 *
 *   POST /api/submit-bonus
 *         {bonusMonth, region, casesClosed, avgCycle, agedCases,
 *          agedExceptions, pctWithin7, celWalks, accWalks, submissionId?}
 *         -> {submission}
 *
 *   GET  /api/submit-bonus
 *         -> {submissions}   the caller's own rows, newest bonusMonth first.
 *            Admins additionally get everyone's via ?all=1 -- leadership
 *            review otherwise happens directly in the CCR Bonus Submissions
 *            Airtable table, same as every other cross-associate view in
 *            this suite.
 *
 * Gated on page.bonus (see olh-auth.js ALL_PAGES/DEFAULT_ROLES) -- CCR and
 * Admin only, same shape as every other page.* gate in this file.
 *
 * Dollar amounts are computed HERE, server-side, from the CCR Bonus
 * Agreement's tiers -- never trusted from the client, the same reasoning
 * update-job.js applies to every write. Associate Name/Email/Division and
 * Submitted By/At all come from the session, never the body.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/* ---- Bonus math, per the CCR Bonus Agreement (Form last revised 12.1.2025) */

function caseClosureBonus(casesClosed, avgCycle) {
  const eligible = avgCycle < 10 && casesClosed >= 80;
  if (!eligible) return { bonus: 0, eligible: false };
  let rate = 0;
  if (avgCycle <= 6) rate = 20;
  else if (avgCycle <= 8) rate = 15;
  else rate = 5; // <=10, already gated by the eligible check above
  return { bonus: rate * casesClosed, eligible: true };
}

function agedCaseBonus(agedCases, exceptions) {
  const net = Math.max(0, agedCases - exceptions);
  let bonus = 0;
  if (net === 0) bonus = 750;
  else if (net <= 2) bonus = 300;
  else bonus = 0;
  return { bonus, net };
}

function serviceConsistencyBonus(pct) {
  if (pct >= 80) return 1000;
  if (pct >= 75) return 750;
  if (pct >= 70) return 300;
  return 0;
}

const CEL_RATE = 60;
const ACC_RATE = 40;

function submissionOf(rec) {
  const f = rec.fields || {};
  return {
    id: f['Submission Id'] || rec.id,
    recordId: rec.id,
    associateName: f['Associate Name'] || '',
    associateEmail: f['Associate Email'] || '',
    division: f.Division || '',
    region: f.Region || '',
    bonusMonth: f['Bonus Month'] || '',
    casesClosed: f['Cases Closed'] || 0,
    avgCycle: f['Average Cycle Time (Days)'] || 0,
    agedCases: f['Aged Cases (21+ Days)'] || 0,
    agedExceptions: f['Aged Case Exceptions Approved'] || 0,
    netAgedCases: f['Net Aged Cases'] || 0,
    pctWithin7: Math.round((f['% Closed Within 7 Days'] || 0) * 1000) / 10, // stored 0-1 -> back to a percent
    celWalks: f['CEL Walks Completed'] || 0,
    accWalks: f['ACC Walks Completed'] || 0,
    closureEligible: !!f['Case Closure Bonus Eligible'],
    closureBonus: f['Case Closure Bonus'] || 0,
    agedBonus: f['Aged Case Bonus'] || 0,
    consistencyBonus: f['Service Consistency Bonus'] || 0,
    celBonus: f['CEL Walk Bonus'] || 0,
    accBonus: f['ACC Walk Bonus'] || 0,
    total: f['Total Bonus'] || 0,
    status: f.Status || 'Submitted',
    notes: f['Leadership Notes'] || '',
    submittedBy: f['Submitted By'] || '',
    submittedAt: f['Submitted At'] || ''
  };
}

async function submit(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.bonus');

  const body = A.readJson(event);
  const bonusMonth = str(body.bonusMonth).trim();
  if (!MONTH_RE.test(bonusMonth)) {
    return A.reply(400, { error: 'bonusMonth must be in YYYY-MM form, e.g. 2026-08.' });
  }

  const casesClosed = num(body.casesClosed);
  const avgCycle = num(body.avgCycle);
  const agedCases = num(body.agedCases);
  const agedExceptions = num(body.agedExceptions);
  const pctWithin7 = Math.max(0, Math.min(100, num(body.pctWithin7)));
  const celWalks = num(body.celWalks);
  const accWalks = num(body.accWalks);
  const region = str(body.region).trim();

  for (const [label, v] of [
    ['casesClosed', casesClosed], ['avgCycle', avgCycle], ['agedCases', agedCases],
    ['agedExceptions', agedExceptions], ['celWalks', celWalks], ['accWalks', accWalks]
  ]) {
    if (v < 0) return A.reply(400, { error: '"' + label + '" cannot be negative.' });
  }

  const submissionId = str(body.submissionId).trim() ||
    ('b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));

  // Idempotency: a retry of the same submission returns the row already written.
  const existing = await A.findOne(A.TABLES.bonusSubmissions, '{Submission Id} = "' + A.esc(submissionId) + '"');
  if (existing) return A.reply(200, { submission: submissionOf(existing), duplicate: true });

  const closure = caseClosureBonus(casesClosed, avgCycle);
  const aged = agedCaseBonus(agedCases, agedExceptions);
  const consistency = serviceConsistencyBonus(pctWithin7);
  const celBonus = celWalks * CEL_RATE;
  const accBonus = accWalks * ACC_RATE;
  const total = closure.bonus + aged.bonus + consistency + celBonus + accBonus;

  const fields = {
    'Submission Id': submissionId,
    'Associate Name': session.user.name,
    'Associate Email': session.user.email,
    Division: session.user.division || '',
    Region: region,
    'Bonus Month': bonusMonth,
    'Cases Closed': casesClosed,
    'Average Cycle Time (Days)': avgCycle,
    'Aged Cases (21+ Days)': agedCases,
    'Aged Case Exceptions Approved': agedExceptions,
    'Net Aged Cases': aged.net,
    '% Closed Within 7 Days': pctWithin7 / 100,
    'CEL Walks Completed': celWalks,
    'ACC Walks Completed': accWalks,
    'Case Closure Bonus Eligible': closure.eligible,
    'Case Closure Bonus': closure.bonus,
    'Aged Case Bonus': aged.bonus,
    'Service Consistency Bonus': consistency,
    'CEL Walk Bonus': celBonus,
    'ACC Walk Bonus': accBonus,
    'Total Bonus': total,
    Status: 'Submitted',
    'Submitted By': session.user.name,
    'Submitted At': new Date().toISOString()
  };

  const created = await A.createRecord(A.TABLES.bonusSubmissions, fields);
  return A.reply(201, { submission: submissionOf(created) });
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.bonus');

  const q = event.queryStringParameters || {};
  const wantAll = str(q.all) === '1' && session.can.indexOf('roster.manage') >= 0; // admin-only, same "is this session an admin" gate as my-walks.html

  const recs = await A.listRecords(A.TABLES.bonusSubmissions, {
    'sort[0][field]': 'Bonus Month',
    'sort[0][direction]': 'desc',
    maxRecords: '500'
  });

  const mine = String(session.user.email || '').toLowerCase();
  const rows = recs
    .filter((r) => wantAll || String((r.fields && r.fields['Associate Email']) || '').toLowerCase() === mine)
    .map(submissionOf);

  return A.reply(200, { submissions: rows });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'POST') return await submit(event);
    if (event.httpMethod === 'GET') return await list(event);
    return A.reply(405, { error: 'GET or POST only.' });
  } catch (err) {
    return A.fail(err);
  }
};
