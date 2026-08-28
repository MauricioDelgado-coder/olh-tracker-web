/**
 * Leadership review of Case Aging Exception requests.
 *
 *   GET  /api/case-aging-approvals?status=Pending&all=1
 *         -> {requests, reports, isAdmin, viewingAll}
 *
 *         Scoped to the caller's direct reports by default, identically to
 *         bonus-approvals.js: a leader sees only requests from CCRs whose
 *         Users row has {Manager} pointing back at the caller's own Users
 *         row. Admins additionally get everyone's via ?all=1.
 *
 *         `reports` is the caller's direct-report roster (name/email/division),
 *         same shape as bonus-approvals.js, so the consolidated approvals
 *         page can reuse one reports strip across both request types.
 *
 *   POST /api/case-aging-approvals
 *         {recordId or submissionId, status, notes?}
 *         -> {request}
 *
 *         Sets Status (+ Reviewer Notes if provided) on one request. status
 *         must be 'Approved' or 'Denied' -- Pending is a starting state, not
 *         something a reviewer sets back to. Scope-checked the same way as
 *         the GET. Reviewed By / Reviewed At are stamped from the session,
 *         never the body.
 *
 * Gated on page.bonusapproval (see olh-auth.js ALL_PAGES/DEFAULT_ROLES) --
 * the same permission that gates bonus-approvals.js, so the two request
 * types share one leadership approval surface. See public/bonus-approval.html.
 *
 * Direct-report resolution: identical to bonus-approvals.js -- the Users
 * table's Manager field is the only source of truth for "who reports to
 * whom." A CCR with no Manager set is invisible to every non-admin leader's
 * queue until an admin links them.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));

const REVIEW_STATUS = ['Approved', 'Denied'];

function requestOf(rec) {
  const f = rec.fields || {};
  return {
    id: f['Submission Id'] || rec.id,
    recordId: rec.id,
    caseNumber: f['Case Number'] || '',
    submittedBy: f['Submitted By'] || '',
    submittedByEmail: f['Submitted By Email'] || '',
    division: f.Division || '',
    submissionDate: f['Submission Date'] || '',
    currentAgeDays: f['Current Age (Days)'] || 0,
    expectedCompletionDate: f['Expected Completion Date'] || '',
    agingReasonNotes: f['Aging Reason Notes'] || '',
    status: f.Status || 'Pending',
    reviewedBy: f['Reviewed By'] || '',
    reviewedAt: f['Reviewed At'] || '',
    reviewerNotes: f['Reviewer Notes'] || '',
    submittedAt: f['Submitted At'] || ''
  };
}

/** All active Users rows whose Manager link points back at `managerId`. */
async function directReports(managerId) {
  const all = await A.listRecords(A.TABLES.users);
  return all.filter((r) => {
    const mgr = r.fields && r.fields.Manager;
    return Array.isArray(mgr) && mgr.indexOf(managerId) >= 0;
  });
}

function reportOf(rec) {
  const f = rec.fields || {};
  return {
    userId: rec.id,
    name: f.Name || '',
    email: String(f.Email || '').toLowerCase(),
    division: f.Division || '',
    active: !!f.Active
  };
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.bonusapproval');

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  const q = event.queryStringParameters || {};
  const wantAll = str(q.all) === '1' && isAdmin;

  let reports = [];
  let reportEmails = null;

  if (!wantAll) {
    const reportRecs = await directReports(session.record.id);
    reports = reportRecs.map(reportOf);
    reportEmails = new Set(reports.map((r) => r.email).filter(Boolean));
  }

  const recs = await A.listRecords(A.TABLES.caseAgingExceptions, {
    'sort[0][field]': 'Submission Date',
    'sort[0][direction]': 'desc',
    maxRecords: '500'
  });

  let rows = recs.map(requestOf);

  if (reportEmails) {
    rows = rows.filter((r) => reportEmails.has(String(r.submittedByEmail || '').toLowerCase()));
  }

  const statusFilter = str(q.status).trim();
  if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);

  return A.reply(200, { requests: rows, reports, isAdmin, viewingAll: wantAll });
}

async function review(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.bonusapproval');

  const body = A.readJson(event);
  const status = str(body.status).trim();
  if (REVIEW_STATUS.indexOf(status) < 0) {
    return A.reply(400, { error: 'status must be one of: ' + REVIEW_STATUS.join(', ') + '.' });
  }

  const recordId = str(body.recordId).trim();
  const submissionId = str(body.submissionId).trim();
  if (!recordId && !submissionId) {
    return A.reply(400, { error: 'Send recordId or submissionId.' });
  }

  const target = recordId
    ? await A.airtable('GET', '/' + A.TABLES.caseAgingExceptions + '/' + recordId).catch(() => null)
    : await A.findOne(A.TABLES.caseAgingExceptions, '{Submission Id} = "' + A.esc(submissionId) + '"');

  if (!target) return A.reply(404, { error: 'No matching case aging exception request.' });

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  if (!isAdmin) {
    const reportRecs = await directReports(session.record.id);
    const allowedEmails = new Set(reportRecs.map((r) => String((r.fields && r.fields.Email) || '').toLowerCase()));
    const targetEmail = String((target.fields && target.fields['Submitted By Email']) || '').toLowerCase();
    if (!allowedEmails.has(targetEmail)) {
      return A.reply(403, { error: 'This request does not belong to one of your direct reports.' });
    }
  }

  const fields = {
    Status: status,
    'Reviewed By': session.user.name,
    'Reviewed At': new Date().toISOString()
  };
  if (body.notes != null) fields['Reviewer Notes'] = str(body.notes);

  const updated = await A.updateRecord(A.TABLES.caseAgingExceptions, target.id, fields);
  return A.reply(200, { request: requestOf(updated) });
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
    if (event.httpMethod === 'GET') return await list(event);
    if (event.httpMethod === 'POST') return await review(event);
    return A.reply(405, { error: 'GET or POST only.' });
  } catch (err) {
    return A.fail(err);
  }
};
