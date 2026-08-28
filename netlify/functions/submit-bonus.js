/**
 * Monthly CCR bonus self-reporting, per the CCR Bonus Agreement.
 *
 *   POST /api/submit-bonus
 *         {bonusMonth, region, casesClosed, avgCycle, agedCases,
 *          pctWithin7, celWalks, accWalks, submissionId?, discrepancyNotes?}
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
 * Submitted By/At all come from the session, never the body. As of the Case
 * Aging Exceptions integration, Aged Case Exceptions Approved is ALSO never
 * trusted from the client for the same reason: it directly reduces Net Aged
 * Cases and therefore increases the Aged Case Bonus, so it gets the same
 * server-computed treatment as every other dollar-affecting figure. It is
 * computed via A.caseAgingExceptionsApprovedCount -- a count of this CCR's
 * own Approved rows in the Case Aging Exceptions table whose underlying
 * case CLOSED in this bonus month (not the month the exception was
 * submitted or approved -- the whole point of an exception is the case may
 * run past its original expected date). Not Salesforce data; that table
 * has no such concept (see the note on "Salesforce comparison" below).
 * Whatever the client sends for agedExceptions is ignored.
 *
 * ---- Salesforce comparison ------------------------------------------------
 *
 * NOTE 2026-08-27: the puller that kept CCR Bonus SF Source current
 * (dev/sync_ccr_bonus_source.py, run by launchd) was removed -- it was
 * pulling incorrect numbers. The table, this snapshot-on-submit logic, and
 * bonus-source.js's read path are all left in place for when the puller is
 * rebuilt; until then, CCR Bonus SF Source will not receive new rows and
 * existing rows will go stale. bonus.html's pre-fill/comparison will keep
 * showing whatever was last synced.
 *
 * At submit time, this looks up the matching CCR Bonus SF Source row for
 * this email + bonusMonth and copies its numbers onto the submission as a
 * SNAPSHOT (the "(SF)" fields) -- never as a live lookup from the
 * submission's own read path. A later resync of the source table must not
 * retroactively change what a past submission's Salesforce comparison
 * looked like; the snapshot is what makes
 * that true. "SF Source Found" is false (a real, distinct state, not just
 * blank SF fields) when no source row exists yet for that email/month --
 * e.g. the sync hasn't run for a brand-new hire -- so a leader reviewing
 * later can tell "no Salesforce data was available" apart from "Salesforce
 * said zero." "Has Discrepancy" is set when any CCR-entered number differs
 * from the SF snapshot outside a small tolerance for the two fields stored
 * as non-integers (avgCycle, pctWithin7); it does not block submission --
 * the CCR can always submit their own number, with an optional note leaders
 * see on the approval page.
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
    submittedAt: f['Submitted At'] || '',
    sfFound: !!f['SF Source Found'],
    sfCasesClosed: f['Cases Closed (SF)'] || 0,
    sfAvgCycle: f['Average Cycle Time Days (SF)'] || 0,
    sfAgedCases: f['Aged Cases 21+ (SF)'] || 0,
    sfPctWithin7: Math.round((f['Pct Closed Within 7 Days (SF)'] || 0) * 1000) / 10,
    sfCelWalks: f['CEL Walks (SF)'] || 0,
    sfAccWalks: f['ACC Walks (SF)'] || 0,
    hasDiscrepancy: !!f['Has Discrepancy'],
    discrepancyNotes: f['Discrepancy Notes'] || ''
  };
}

/** True if a and b differ by more than a small tolerance -- integers must
 * match exactly, the two fields Salesforce/the form store as non-integers
 * (avgCycle in days, pctWithin7 as a 0-100 percent) get a little slack so a
 * rounding difference alone never reads as a discrepancy. */
function differs(a, b, tolerance) {
  return Math.abs(num(a) - num(b)) > tolerance;
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
  const pctWithin7 = Math.max(0, Math.min(100, num(body.pctWithin7)));
  const celWalks = num(body.celWalks);
  const accWalks = num(body.accWalks);
  const region = str(body.region).trim();

  for (const [label, v] of [
    ['casesClosed', casesClosed], ['avgCycle', avgCycle], ['agedCases', agedCases],
    ['celWalks', celWalks], ['accWalks', accWalks]
  ]) {
    if (v < 0) return A.reply(400, { error: '"' + label + '" cannot be negative.' });
  }

  // Server-computed, not trusted from the client -- see the file header.
  const agedExceptions = await A.caseAgingExceptionsApprovedCount(session.user.email, bonusMonth);

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

  // Snapshot the Salesforce source (if any) for this email + month, and flag
  // a discrepancy -- see the file header for why this is a snapshot rather
  // than a live join, and why "not found" is tracked separately from zero.
  const sourceFormula = '{Bonus Month} = "' + A.esc(bonusMonth) + '" AND LOWER({Associate Email}) = "' +
    A.esc(A.normEmail(session.user.email)) + '"';
  const sourceRec = await A.findOne(A.TABLES.bonusSource, sourceFormula);
  const sf = sourceRec ? {
    casesClosed: sourceRec.fields['Cases Closed (SF)'] || 0,
    avgCycle: sourceRec.fields['Average Cycle Time Days (SF)'] || 0,
    agedCases: sourceRec.fields['Aged Cases 21+ (SF)'] || 0,
    pctWithin7: Math.round((sourceRec.fields['Pct Closed Within 7 Days (SF)'] || 0) * 1000) / 10,
    celWalks: sourceRec.fields['CEL Walks (SF)'] || 0,
    accWalks: sourceRec.fields['ACC Walks (SF)'] || 0
  } : null;

  const discrepancyNotes = str(body.discrepancyNotes).trim();
  const hasDiscrepancy = !!sf && (
    differs(casesClosed, sf.casesClosed, 0) ||
    differs(avgCycle, sf.avgCycle, 0.05) ||
    differs(agedCases, sf.agedCases, 0) ||
    differs(pctWithin7, sf.pctWithin7, 0.1) ||
    differs(celWalks, sf.celWalks, 0) ||
    differs(accWalks, sf.accWalks, 0)
  );

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
    'Submitted At': new Date().toISOString(),
    'SF Source Found': !!sf,
    'Cases Closed (SF)': sf ? sf.casesClosed : 0,
    'Average Cycle Time Days (SF)': sf ? sf.avgCycle : 0,
    'Aged Cases 21+ (SF)': sf ? sf.agedCases : 0,
    'Pct Closed Within 7 Days (SF)': sf ? sf.pctWithin7 / 100 : 0,
    'CEL Walks (SF)': sf ? sf.celWalks : 0,
    'ACC Walks (SF)': sf ? sf.accWalks : 0,
    'Has Discrepancy': hasDiscrepancy,
    'Discrepancy Notes': discrepancyNotes
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
