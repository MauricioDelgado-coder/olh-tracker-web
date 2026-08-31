/**
 * Monthly QA Manager bonus self-reporting, per the Quality Assurance Manager
 * (QAM) Bonus Agreement (1/30/2025). Mirrors submit-bonus.js's shape and
 * conventions exactly (idempotency key, session-derived identity, SF
 * snapshot + discrepancy flag at submit time), against the QA Bonus tables
 * instead of the CCR ones.
 *
 *   POST /api/qa-bonus
 *         {bonusMonth, qaiWalks, qaaWalks, nhoWalks, nhaWalks,
 *          homesClosed, issuesWithin30, submissionId?, discrepancyNotes?}
 *         -> {submission}
 *
 *   GET  /api/qa-bonus
 *         -> {submissions}   the caller's own rows, newest bonusMonth first.
 *            Admins additionally get everyone's via ?all=1.
 *
 * Gated on page.qabonus (see olh-auth.js ALL_PAGES/DEFAULT_ROLES) -- QA
 * Manager and Admin only.
 *
 * ---- Bonus math, per the Bonus Agreement's two tables ---------------------
 *
 * Frequency Bonus (walk completion), assessed monthly:
 *   $60 per home for each QAI or NHO completed
 *   $40 per home for each QAA or NHA completed
 * NHO/NHA are the Bonus Agreement's names for what Salesforce's Homesite__c
 * calls Celebration and Acceptance -- see qa-bonus-source.js's header.
 *
 * Quality Bonus, assessed monthly, based on the average number of issues in
 * the first 30 days for homes the QAM completed the QAI on:
 *   < 1.0 defects/home  -> $1000
 *   1.0-1.3 defects/home -> $500
 *   > 1.3 defects/home  -> $0
 * "Homes Closed (QAI)" and "Issues Within 30 Days" are exactly the homes-
 * closed-in-month / 0-29-day-work-order counts computed the same way
 * dev/sync_qa_bonus_source.py computes them -- see that script's header for
 * the full Salesforce query and filter criteria this rests on.
 *
 * Dollar amounts are computed HERE, server-side, from the two tables above --
 * never trusted from the client, the same reasoning submit-bonus.js applies
 * to CCR bonus math. Associate Name/Email/Division and Submitted By/At all
 * come from the session, never the body.
 *
 * Salesforce comparison: identical snapshot-at-submit-time + discrepancy-flag
 * design as submit-bonus.js -- see that file's header for the full reasoning
 * on why a snapshot, and why "not found" is tracked separately from zero.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const QAI_NHO_RATE = 60;
const QAA_NHA_RATE = 40;

function walkCompletionBonus(qaiWalks, nhoWalks, qaaWalks, nhaWalks) {
  return (qaiWalks + nhoWalks) * QAI_NHO_RATE + (qaaWalks + nhaWalks) * QAA_NHA_RATE;
}

/** avgIssuesPerHome is derived here, not trusted from the client, from
 * whatever homesClosed/issuesWithin30 the QAM enters (or leaves pre-filled) --
 * same reasoning as every other server-computed figure in this file. A QAM
 * with 0 homes closed this month has no rate to score, so that tier is
 * "0 homes closed" rather than a division-by-zero producing a false <1.0. */
function qualityBonus(homesClosed, issuesWithin30) {
  if (homesClosed <= 0) return { avg: 0, tier: '0 homes closed', bonus: 0 };
  const avg = Math.round((issuesWithin30 / homesClosed) * 100) / 100;
  if (avg < 1.0) return { avg, tier: '<1.0 defects/home', bonus: 1000 };
  if (avg <= 1.3) return { avg, tier: '1.0-1.3 defects/home', bonus: 500 };
  return { avg, tier: '>1.3 defects/home', bonus: 0 };
}

function submissionOf(rec) {
  const f = rec.fields || {};
  return {
    id: f['Submission Id'] || rec.id,
    recordId: rec.id,
    associateName: f['Associate Name'] || '',
    associateEmail: f['Associate Email'] || '',
    division: f.Division || '',
    bonusMonth: f['Bonus Month'] || '',
    qaiWalks: f['QAI Walks Completed'] || 0,
    qaaWalks: f['QAA Walks Completed'] || 0,
    nhoWalks: f['NHO Walks Completed'] || 0,
    nhaWalks: f['NHA Walks Completed'] || 0,
    walkBonus: f['Walk Completion Bonus'] || 0,
    homesClosed: f['Homes Closed (QAI)'] || 0,
    issuesWithin30: f['Issues Within 30 Days'] || 0,
    avgIssuesPerHome: f['Avg Issues Per Home'] || 0,
    qualityTier: f['Quality Bonus Tier'] || '',
    qualityBonus: f['Quality Bonus'] || 0,
    total: f['Total Bonus'] || 0,
    status: f.Status || 'Submitted',
    notes: f['Leadership Notes'] || '',
    submittedBy: f['Submitted By'] || '',
    submittedAt: f['Submitted At'] || '',
    reviewedBy: f['Reviewed By'] || '',
    reviewedAt: f['Reviewed At'] || '',
    sfFound: !!f['SF Source Found'],
    sfQaiWalks: f['QAI Walks (SF)'] || 0,
    sfQaaWalks: f['QAA Walks (SF)'] || 0,
    sfNhoWalks: f['NHO Walks (SF)'] || 0,
    sfNhaWalks: f['NHA Walks (SF)'] || 0,
    sfHomesClosed: f['Homes Closed (SF)'] || 0,
    sfIssuesWithin30: f['Issues Within 30 Days (SF)'] || 0,
    sfAvgIssuesPerHome: f['Avg Issues Per Home (SF)'] || 0,
    hasDiscrepancy: !!f['Has Discrepancy'],
    discrepancyNotes: f['Discrepancy Notes'] || ''
  };
}

const differs = (a, b, tolerance) => Math.abs(num(a) - num(b)) > (tolerance || 0);

async function submit(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.qabonus');

  const body = A.readJson(event);
  const bonusMonth = str(body.bonusMonth).trim();
  if (!MONTH_RE.test(bonusMonth)) {
    return A.reply(400, { error: 'bonusMonth must be in YYYY-MM form, e.g. 2026-08.' });
  }

  const qaiWalks = num(body.qaiWalks);
  const qaaWalks = num(body.qaaWalks);
  const nhoWalks = num(body.nhoWalks);
  const nhaWalks = num(body.nhaWalks);
  const homesClosed = num(body.homesClosed);
  const issuesWithin30 = num(body.issuesWithin30);

  for (const [label, v] of [
    ['qaiWalks', qaiWalks], ['qaaWalks', qaaWalks], ['nhoWalks', nhoWalks], ['nhaWalks', nhaWalks],
    ['homesClosed', homesClosed], ['issuesWithin30', issuesWithin30]
  ]) {
    if (v < 0) return A.reply(400, { error: '"' + label + '" cannot be negative.' });
  }

  const submissionId = str(body.submissionId).trim() ||
    ('qb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));

  // Idempotency: a retry of the same submission returns the row already written.
  const existing = await A.findOne(A.TABLES.qaBonusSubmissions, '{Submission Id} = "' + A.esc(submissionId) + '"');
  if (existing) return A.reply(200, { submission: submissionOf(existing), duplicate: true });

  const walkBonus = walkCompletionBonus(qaiWalks, nhoWalks, qaaWalks, nhaWalks);
  const quality = qualityBonus(homesClosed, issuesWithin30);
  const total = walkBonus + quality.bonus;

  // Snapshot the Salesforce source (if any) for this email + month.
  const sourceFormula = 'AND({Bonus Month} = "' + A.esc(bonusMonth) + '", LOWER({QAM Email}) = "' +
    A.esc(A.normEmail(session.user.email)) + '")';
  const sourceRec = await A.findOne(A.TABLES.qaBonusSource, sourceFormula);
  const sf = sourceRec ? {
    qaiWalks: sourceRec.fields['QAI Walks (SF)'] || 0,
    qaaWalks: sourceRec.fields['QAA Walks (SF)'] || 0,
    nhoWalks: sourceRec.fields['NHO Walks (SF)'] || 0,
    nhaWalks: sourceRec.fields['NHA Walks (SF)'] || 0,
    homesClosed: sourceRec.fields['Homes Closed (SF)'] || 0,
    issuesWithin30: sourceRec.fields['Issues Within 30 Days (SF)'] || 0,
    avgIssuesPerHome: sourceRec.fields['Avg Issues Per Home (SF)'] || 0
  } : null;

  const discrepancyNotes = str(body.discrepancyNotes).trim();
  const hasDiscrepancy = !!sf && (
    differs(qaiWalks, sf.qaiWalks) || differs(qaaWalks, sf.qaaWalks) ||
    differs(nhoWalks, sf.nhoWalks) || differs(nhaWalks, sf.nhaWalks) ||
    differs(homesClosed, sf.homesClosed) || differs(issuesWithin30, sf.issuesWithin30)
  );

  const fields = {
    'Submission Id': submissionId,
    'Associate Name': session.user.name,
    'Associate Email': session.user.email,
    Division: session.user.division || '',
    'Bonus Month': bonusMonth,
    'QAI Walks Completed': qaiWalks,
    'QAA Walks Completed': qaaWalks,
    'NHO Walks Completed': nhoWalks,
    'NHA Walks Completed': nhaWalks,
    'Walk Completion Bonus': walkBonus,
    'Homes Closed (QAI)': homesClosed,
    'Issues Within 30 Days': issuesWithin30,
    'Avg Issues Per Home': quality.avg,
    'Quality Bonus Tier': quality.tier,
    'Quality Bonus': quality.bonus,
    'Total Bonus': total,
    Status: 'Submitted',
    'Submitted By': session.user.name,
    'Submitted At': new Date().toISOString(),
    'SF Source Found': !!sf,
    'QAI Walks (SF)': sf ? sf.qaiWalks : 0,
    'QAA Walks (SF)': sf ? sf.qaaWalks : 0,
    'NHO Walks (SF)': sf ? sf.nhoWalks : 0,
    'NHA Walks (SF)': sf ? sf.nhaWalks : 0,
    'Homes Closed (SF)': sf ? sf.homesClosed : 0,
    'Issues Within 30 Days (SF)': sf ? sf.issuesWithin30 : 0,
    'Avg Issues Per Home (SF)': sf ? sf.avgIssuesPerHome : 0,
    'Has Discrepancy': hasDiscrepancy,
    'Discrepancy Notes': discrepancyNotes
  };

  const created = await A.createRecord(A.TABLES.qaBonusSubmissions, fields);
  return A.reply(201, { submission: submissionOf(created) });
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.qabonus');

  const q = event.queryStringParameters || {};
  const wantAll = str(q.all) === '1' && session.can.indexOf('roster.manage') >= 0;

  const recs = await A.listRecords(A.TABLES.qaBonusSubmissions, {
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
