/**
 * Daily Summary submissions from Customer Care associates.
 *
 *   POST /api/daily-summary
 *         {reportDate, sections:{aged_case,open_wo_aged,overdue_wo,
 *          expired_trade,unscheduled_wo,buildpro}, notes, submissionId?}
 *         -> {report}
 *
 *   GET  /api/daily-summary?date=YYYY-MM-DD
 *         -> {reports}   the caller's own rows (or everyone's for that date
 *            with ?all=1, leadership/admin only), newest first.
 *
 *   PATCH /api/daily-summary
 *         {recordId, status}
 *         -> {report}
 *
 *         Leadership/admin review action -- sets Status (Reviewed / Needs
 *         Follow-up) and stamps Reviewed By/At from the session. Mirrors
 *         case-aging-approvals.js's review() shape, folded into this one
 *         file since there is no separate leadership queue page yet.
 *
 * Gated on page.dailysummary (see olh-auth.js ALL_PAGES/DEFAULT_ROLES).
 * Submitted By/Email/Division and Submitted At all come from the session,
 * never the body -- same convention as case-aging.js and submit-bonus.js.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REVIEW_STATUS = ['Reviewed', 'Needs Follow-up'];

function reportOf(rec) {
  const f = rec.fields || {};
  return {
    id: f['Submission Id'] || rec.id,
    recordId: rec.id,
    associateName: f['Associate Name'] || '',
    associateEmail: f['Associate Email'] || '',
    division: f.Division || '',
    reportDate: f['Report Date'] || '',
    sections: {
      aged_case: f['Aged Case Updates'] || 'None',
      open_wo_aged: f['Open WO on Aged Cases'] || 'None',
      overdue_wo: f['Overdue Work Orders'] || 'None',
      expired_trade: f['Expired Trade Assignments'] || 'None',
      unscheduled_wo: f['Unscheduled WO Over 9 Days'] || 'None',
      buildpro: f['BuildPro Access Needed'] || 'None'
    },
    notes: f['Notes and Escalations'] || '',
    status: f.Status || 'Submitted',
    reviewedBy: f['Reviewed By'] || '',
    reviewedAt: f['Reviewed At'] || '',
    submittedAt: f['Submitted At'] || ''
  };
}

async function submit(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.dailysummary');

  const body = A.readJson(event);
  const reportDate = str(body.reportDate).trim();
  const sections = body.sections || {};
  const notes = str(body.notes).trim();

  if (!DATE_RE.test(reportDate)) return A.reply(400, { error: 'reportDate must be in YYYY-MM-DD form.' });

  const submissionId = str(body.submissionId).trim() ||
    ('ds' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));

  // Idempotency: a retry of the same submission returns the row already written.
  const existing = await A.findOne(A.TABLES.dailySummary, '{Submission Id} = "' + A.esc(submissionId) + '"');
  if (existing) return A.reply(200, { report: reportOf(existing), duplicate: true });

  const fields = {
    'Submission Id': submissionId,
    'Associate Name': session.user.name,
    'Associate Email': session.user.email,
    Division: session.user.division || '',
    'Report Date': reportDate,
    'Aged Case Updates': str(sections.aged_case) || 'None',
    'Open WO on Aged Cases': str(sections.open_wo_aged) || 'None',
    'Overdue Work Orders': str(sections.overdue_wo) || 'None',
    'Expired Trade Assignments': str(sections.expired_trade) || 'None',
    'Unscheduled WO Over 9 Days': str(sections.unscheduled_wo) || 'None',
    'BuildPro Access Needed': str(sections.buildpro) || 'None',
    'Notes and Escalations': notes,
    Status: 'Submitted',
    'Submitted At': new Date().toISOString()
  };

  const created = await A.createRecord(A.TABLES.dailySummary, fields);
  return A.reply(201, { report: reportOf(created) });
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.dailysummary');

  const q = event.queryStringParameters || {};
  const isReviewer = session.can.indexOf('roster.manage') >= 0 || session.can.indexOf('page.bonusapproval') >= 0;
  const wantAll = str(q.all) === '1' && isReviewer;
  const dateFilter = str(q.date).trim();

  const recs = await A.listRecords(A.TABLES.dailySummary, {
    'sort[0][field]': 'Report Date',
    'sort[0][direction]': 'desc',
    maxRecords: '500'
  });

  const mine = String(session.user.email || '').toLowerCase();
  let rows = recs
    .filter((r) => wantAll || String((r.fields && r.fields['Associate Email']) || '').toLowerCase() === mine)
    .map(reportOf);

  if (dateFilter) rows = rows.filter((r) => r.reportDate === dateFilter);

  return A.reply(200, { reports: rows });
}

async function review(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.dailysummary');

  const isReviewer = session.can.indexOf('roster.manage') >= 0 || session.can.indexOf('page.bonusapproval') >= 0;
  if (!isReviewer) return A.reply(403, { error: 'Only leadership or admin can review a daily summary.' });

  const body = A.readJson(event);
  const status = str(body.status).trim();
  if (REVIEW_STATUS.indexOf(status) < 0) {
    return A.reply(400, { error: 'status must be one of: ' + REVIEW_STATUS.join(', ') + '.' });
  }
  const recordId = str(body.recordId).trim();
  if (!recordId) return A.reply(400, { error: 'recordId is required.' });

  const updated = await A.updateRecord(A.TABLES.dailySummary, recordId, {
    Status: status,
    'Reviewed By': session.user.name,
    'Reviewed At': new Date().toISOString()
  });
  return A.reply(200, { report: reportOf(updated) });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST, PATCH' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'POST') return await submit(event);
    if (event.httpMethod === 'GET') return await list(event);
    if (event.httpMethod === 'PATCH') return await review(event);
    return A.reply(405, { error: 'GET, POST, or PATCH only.' });
  } catch (err) {
    return A.fail(err);
  }
};
