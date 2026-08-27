/**
 * Leadership review of CCR monthly bonus submissions.
 *
 *   GET  /api/bonus-approvals?status=Submitted&month=2026-08&all=1
 *         -> {submissions, reports, isAdmin, viewingAll}
 *
 *         Scoped to the caller's direct reports by default: a leader sees
 *         only submissions from CCRs whose Users row has {Manager} pointing
 *         back at the caller's own Users row. Admins additionally get
 *         everyone's via ?all=1 -- same "is this session an admin" gate as
 *         submit-bonus.js's own ?all=1.
 *
 *         `reports` is the caller's direct-report roster (name/email/division),
 *         included even when a given report has no submission yet, so the
 *         page can show "no submission from X this month" rather than just
 *         silently omitting them.
 *
 *   POST /api/bonus-approvals
 *         {submissionId or recordId, status, notes?}
 *         -> {submission}
 *
 *         Sets Status (+ Leadership Notes if provided) on one submission.
 *         Scope-checked the same way as the GET: a non-admin leader can only
 *         act on a submission belonging to one of their own direct reports.
 *         Reviewed By / Reviewed At are stamped from the session, never the
 *         body -- same reasoning update-job.js applies to every write.
 *
 * Gated on page.bonusapproval (see olh-auth.js ALL_PAGES/DEFAULT_ROLES) --
 * Leadership and Admin only.
 *
 * Direct-report resolution: the Users table's Manager field (self-link,
 * added alongside this feature) is the only source of truth for "who reports
 * to whom." A CCR with no Manager set is invisible to every non-admin
 * leader's queue until an admin links them -- by design, not a bug: it is
 * safer for a submission to be temporarily unreviewable than to guess a
 * reporting line and hand the wrong leader approval power over it.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));

const VALID_STATUS = ['Submitted', 'Under Review', 'Approved', 'Rejected', 'Paid'];

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
    pctWithin7: Math.round((f['% Closed Within 7 Days'] || 0) * 1000) / 10,
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
    reviewedBy: f['Reviewed By'] || '',
    reviewedAt: f['Reviewed At'] || ''
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
  let reportEmails = null; // null = no scoping (admin viewing all)

  if (!wantAll) {
    const reportRecs = await directReports(session.record.id);
    reports = reportRecs.map(reportOf);
    reportEmails = new Set(reports.map((r) => r.email).filter(Boolean));
  }

  const recs = await A.listRecords(A.TABLES.bonusSubmissions, {
    'sort[0][field]': 'Bonus Month',
    'sort[0][direction]': 'desc',
    maxRecords: '500'
  });

  let rows = recs.map(submissionOf);

  if (reportEmails) {
    rows = rows.filter((s) => reportEmails.has(String(s.associateEmail || '').toLowerCase()));
  }

  const statusFilter = str(q.status).trim();
  if (statusFilter) rows = rows.filter((s) => s.status === statusFilter);

  const monthFilter = str(q.month).trim();
  if (monthFilter) rows = rows.filter((s) => s.bonusMonth === monthFilter);

  return A.reply(200, { submissions: rows, reports, isAdmin, viewingAll: wantAll });
}

async function review(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.bonusapproval');

  const body = A.readJson(event);
  const status = str(body.status).trim();
  if (VALID_STATUS.indexOf(status) < 0) {
    return A.reply(400, { error: 'status must be one of: ' + VALID_STATUS.join(', ') + '.' });
  }

  const recordId = str(body.recordId).trim();
  const submissionId = str(body.submissionId).trim();
  if (!recordId && !submissionId) {
    return A.reply(400, { error: 'Send recordId or submissionId.' });
  }

  const target = recordId
    ? await A.airtable('GET', '/' + A.TABLES.bonusSubmissions + '/' + recordId).catch(() => null)
    : await A.findOne(A.TABLES.bonusSubmissions, '{Submission Id} = "' + A.esc(submissionId) + '"');

  if (!target) return A.reply(404, { error: 'No matching bonus submission.' });

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  if (!isAdmin) {
    const reportRecs = await directReports(session.record.id);
    const allowedEmails = new Set(reportRecs.map((r) => String((r.fields && r.fields.Email) || '').toLowerCase()));
    const targetEmail = String((target.fields && target.fields['Associate Email']) || '').toLowerCase();
    if (!allowedEmails.has(targetEmail)) {
      return A.reply(403, { error: 'This submission does not belong to one of your direct reports.' });
    }
  }

  const fields = {
    Status: status,
    'Reviewed By': session.user.name,
    'Reviewed At': new Date().toISOString()
  };
  if (body.notes != null) fields['Leadership Notes'] = str(body.notes);

  const updated = await A.updateRecord(A.TABLES.bonusSubmissions, target.id, fields);
  return A.reply(200, { submission: submissionOf(updated) });
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
