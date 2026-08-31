/**
 * Leadership review of QA Manager bonus submissions. Mirrors bonus-approvals.js
 * exactly, against the QA Bonus tables instead of the CCR ones, so the
 * consolidated Approvals page can reuse the same review UI as a third tab.
 *
 *   GET  /api/qa-bonus-approvals?status=Submitted&all=1
 *         -> {submissions, reports, isAdmin, viewingAll}
 *
 *         Scoped to the caller's direct reports by default: a leader sees
 *         only submissions from QAMs whose Users row has {Manager} pointing
 *         back at the caller's own Users row. Admins additionally get
 *         everyone's via ?all=1.
 *
 *   POST /api/qa-bonus-approvals
 *         {recordId or submissionId, status, notes?}
 *         -> {submission}
 *
 *         Sets Status (+ Leadership Notes if provided). Reviewed By/At are
 *         stamped from the session, never the body.
 *
 * Gated on page.bonusapproval -- the same permission that gates
 * bonus-approvals.js and case-aging-approvals.js, so all three request types
 * share one leadership approval surface. See public/bonus-approval.html.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));

const REVIEW_STATUS = ['Submitted', 'Under Review', 'Approved', 'Rejected', 'Paid'];

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

  const recs = await A.listRecords(A.TABLES.qaBonusSubmissions, {
    'sort[0][field]': 'Bonus Month',
    'sort[0][direction]': 'desc',
    maxRecords: '500'
  });

  let rows = recs.map(submissionOf);

  if (reportEmails) {
    rows = rows.filter((r) => reportEmails.has(String(r.associateEmail || '').toLowerCase()));
  }

  const statusFilter = str(q.status).trim();
  if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);

  return A.reply(200, { submissions: rows, reports, isAdmin, viewingAll: wantAll });
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
    ? await A.airtable('GET', '/' + A.TABLES.qaBonusSubmissions + '/' + recordId).catch(() => null)
    : await A.findOne(A.TABLES.qaBonusSubmissions, '{Submission Id} = "' + A.esc(submissionId) + '"');

  if (!target) return A.reply(404, { error: 'No matching QA bonus submission.' });

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

  const updated = await A.updateRecord(A.TABLES.qaBonusSubmissions, target.id, fields);
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
