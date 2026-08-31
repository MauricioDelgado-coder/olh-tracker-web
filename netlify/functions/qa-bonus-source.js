/**
 * Read-only lookup of Salesforce-sourced QA Manager bonus metrics for one
 * bonus month, so qa-bonus.html can pre-fill a QAM's form before they submit.
 * Mirrors bonus-source.js exactly, against the QA Bonus Source table instead
 * of CCR Bonus SF Source.
 *
 *   GET /api/qa-bonus-source?month=2026-08
 *       -> {found:true, source:{...}} or {found:false, source:null}
 *
 * Scoped to the caller's own email -- a QAM sees only their own row.
 *
 * Gated on page.qabonus (same permission as the page that calls it) -- QA
 * Manager and Admin only.
 *
 * "found: false" is a real, distinct state from "found: true" with zero
 * values -- it means the weekly sync hasn't produced a row for this
 * email/month yet, not that Salesforce showed zero of everything.
 *
 * Field naming: the QAM Bonus Agreement (1/30/2025) uses "NHO" (New Home
 * Orientation) and "NHA" (New Home Acceptance) for the two walks Salesforce
 * itself calls "Celebration" and "Acceptance" on Homesite__c -- see
 * dev/sync_qa_bonus_source.py's header for the full mapping. This endpoint
 * and qa-bonus.html use the Bonus Agreement's own terms (NHO/NHA) throughout,
 * since that is the document the QAM actually signs.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function sourceOf(rec) {
  const f = rec.fields || {};
  return {
    qamName: f['QAM Name'] || '',
    qamEmail: f['QAM Email'] || '',
    bonusMonth: f['Bonus Month'] || '',
    qaiWalks: f['QAI Walks (SF)'] || 0,
    qaaWalks: f['QAA Walks (SF)'] || 0,
    nhoWalks: f['NHO Walks (SF)'] || 0,
    nhaWalks: f['NHA Walks (SF)'] || 0,
    homesClosed: f['Homes Closed (SF)'] || 0,
    issuesWithin30: f['Issues Within 30 Days (SF)'] || 0,
    avgIssuesPerHome: f['Avg Issues Per Home (SF)'] || 0,
    lastSynced: f['Last Synced'] || ''
  };
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.qabonus');

  const q = event.queryStringParameters || {};
  const month = str(q.month).trim();
  if (!MONTH_RE.test(month)) {
    return A.reply(400, { error: 'month must be in YYYY-MM form, e.g. 2026-08.' });
  }

  const email = A.normEmail(session.user.email);
  const formula = 'AND({Bonus Month} = "' + A.esc(month) + '", LOWER({QAM Email}) = "' + A.esc(email) + '")';
  const rec = await A.findOne(A.TABLES.qaBonusSource, formula);

  if (!rec) return A.reply(200, { found: false, source: null });
  return A.reply(200, { found: true, source: sourceOf(rec) });
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
