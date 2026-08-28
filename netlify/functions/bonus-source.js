/**
 * Read-only lookup of Salesforce-sourced CCR bonus metrics for one bonus
 * month, so bonus.html can pre-fill a CCR's form with what Salesforce shows
 * before they submit.
 *
 *   GET /api/bonus-source?month=2026-08
 *       -> {found:true, source:{...}, exceptionsApproved:N} or {found:false, source:null, exceptionsApproved:N}
 *
 * Scoped to the caller's own email -- a CCR sees only their own row, matching
 * the same "your own data only" shape as GET /submit-bonus without ?all=1.
 * There is no admin ?all=1 here: this endpoint is a pre-fill convenience, not
 * a reporting surface, and CCR Bonus SF Source is Airtable-visible to anyone
 * who needs the full table.
 *
 * Gated on page.bonus (same permission as the page that calls it) -- CCR and
 * Admin only.
 *
 * "found: false" is a real, distinct state from "found: true" with zero
 * values -- it means the sync hasn't produced a row for this email/month
 * yet (e.g. a brand-new hire, or a month before this pipeline existed), not
 * that Salesforce showed zero of everything. bonus.html must not silently
 * treat the two the same.
 *
 * exceptionsApproved is NOT Salesforce data -- there is no such concept in
 * Salesforce. It's the count of this CCR's Approved Case Aging Exception
 * requests for this bonus month, computed here the same authoritative way
 * submit-bonus.js computes it at submission time (see
 * A.caseAgingExceptionsApprovedCount), so the number the CCR sees before
 * submitting always matches what actually gets written. Always present
 * (defaults to 0) regardless of whether an SF source row was found -- the
 * two are independent facts.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function sourceOf(rec) {
  const f = rec.fields || {};
  return {
    associateName: f['Associate Name'] || '',
    associateEmail: f['Associate Email'] || '',
    bonusMonth: f['Bonus Month'] || '',
    casesClosed: f['Cases Closed (SF)'] || 0,
    avgCycle: f['Average Cycle Time Days (SF)'] || 0,
    agedCases: f['Aged Cases 21+ (SF)'] || 0,
    pctWithin7: Math.round((f['Pct Closed Within 7 Days (SF)'] || 0) * 1000) / 10,
    celWalks: f['CEL Walks (SF)'] || 0,
    accWalks: f['ACC Walks (SF)'] || 0,
    lastSynced: f['Last Synced'] || ''
  };
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.bonus');

  const q = event.queryStringParameters || {};
  const month = str(q.month).trim();
  if (!MONTH_RE.test(month)) {
    return A.reply(400, { error: 'month must be in YYYY-MM form, e.g. 2026-08.' });
  }

  const email = A.normEmail(session.user.email);
  const formula = '{Bonus Month} = "' + A.esc(month) + '" AND LOWER({Associate Email}) = "' + A.esc(email) + '"';
  const [rec, exceptionsApproved] = await Promise.all([
    A.findOne(A.TABLES.bonusSource, formula),
    A.caseAgingExceptionsApprovedCount(email, month)
  ]);

  if (!rec) return A.reply(200, { found: false, source: null, exceptionsApproved });
  return A.reply(200, { found: true, source: sourceOf(rec), exceptionsApproved });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'GET') return await list(event);
    return A.reply(405, { error: 'GET only.' });
  } catch (err) {
    return A.fail(err);
  }
};
