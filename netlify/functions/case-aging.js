/**
 * Case Aging Exception requests, submitted by CCRs and reviewed by leadership.
 *
 *   POST /api/case-aging
 *         {caseNumber, submissionDate, currentAgeDays, expectedCompletionDate,
 *          agingReasonNotes, submissionId?}
 *         -> {request}
 *
 *   GET  /api/case-aging
 *         -> {requests}   the caller's own rows, newest Submission Date first.
 *            Admins additionally get everyone's via ?all=1 -- same "is this
 *            session an admin" gate as submit-bonus.js's own ?all=1.
 *
 *   PATCH /api/case-aging
 *         {recordId, caseClosedDate}
 *         -> {request}
 *
 *         Records the date this CCR's own case actually closed. Only the
 *         request's own submitter can set this (not a manager -- they don't
 *         necessarily know when a rep's Salesforce case closed), and only on
 *         an Approved request; a Pending or Denied request has nothing to
 *         close against a bonus month for. This is the field
 *         A.caseAgingExceptionsApprovedCount reads: an exception offsets
 *         Aged Case math for whichever bonus month the case actually closes
 *         in, not the month it was submitted or approved, since the whole
 *         point of an exception is the case may run past its original
 *         expected date. Can be called again to correct a wrong date as
 *         long as the request is still Approved.
 *
 * Gated on page.caseaging (see olh-auth.js ALL_PAGES/DEFAULT_ROLES) -- CCR
 * and Admin only, same shape as submit-bonus.js's page.bonus gate.
 *
 * Submitted By/Email/Division and Submitted At all come from the session,
 * never the body -- same reasoning submit-bonus.js and update-job.js apply
 * to every write. Approval (Status/Reviewed By/Reviewed At/Reviewer Notes)
 * happens on the leadership side in case-aging-approvals.js, not here.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    caseClosedDate: f['Case Closed Date'] || '',
    submittedAt: f['Submitted At'] || ''
  };
}

async function submit(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.caseaging');

  const body = A.readJson(event);
  const caseNumber = str(body.caseNumber).trim();
  const submissionDate = str(body.submissionDate).trim();
  const currentAgeDays = num(body.currentAgeDays);
  const expectedCompletionDate = str(body.expectedCompletionDate).trim();
  const agingReasonNotes = str(body.agingReasonNotes).trim();

  if (!caseNumber) return A.reply(400, { error: 'caseNumber is required.' });
  if (!DATE_RE.test(submissionDate)) return A.reply(400, { error: 'submissionDate must be in YYYY-MM-DD form.' });
  if (!Number.isFinite(currentAgeDays) || currentAgeDays < 0) {
    return A.reply(400, { error: 'currentAgeDays must be a non-negative number.' });
  }
  if (!DATE_RE.test(expectedCompletionDate)) {
    return A.reply(400, { error: 'expectedCompletionDate must be in YYYY-MM-DD form.' });
  }
  if (!agingReasonNotes) return A.reply(400, { error: 'agingReasonNotes is required.' });

  const submissionId = str(body.submissionId).trim() ||
    ('cae' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));

  // Idempotency: a retry of the same submission returns the row already written.
  const existing = await A.findOne(A.TABLES.caseAgingExceptions, '{Submission Id} = "' + A.esc(submissionId) + '"');
  if (existing) return A.reply(200, { request: requestOf(existing), duplicate: true });

  const fields = {
    'Submission Id': submissionId,
    'Case Number': caseNumber,
    'Submitted By': session.user.name,
    'Submitted By Email': session.user.email,
    Division: session.user.division || '',
    'Submission Date': submissionDate,
    'Current Age (Days)': currentAgeDays,
    'Expected Completion Date': expectedCompletionDate,
    'Aging Reason Notes': agingReasonNotes,
    Status: 'Pending',
    'Submitted At': new Date().toISOString()
  };

  const created = await A.createRecord(A.TABLES.caseAgingExceptions, fields);
  return A.reply(201, { request: requestOf(created) });
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.caseaging');

  const q = event.queryStringParameters || {};
  const wantAll = str(q.all) === '1' && session.can.indexOf('roster.manage') >= 0;

  const recs = await A.listRecords(A.TABLES.caseAgingExceptions, {
    'sort[0][field]': 'Submission Date',
    'sort[0][direction]': 'desc',
    maxRecords: '500'
  });

  const mine = String(session.user.email || '').toLowerCase();
  const rows = recs
    .filter((r) => wantAll || String((r.fields && r.fields['Submitted By Email']) || '').toLowerCase() === mine)
    .map(requestOf);

  return A.reply(200, { requests: rows });
}

async function markClosed(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.caseaging');

  const body = A.readJson(event);
  const recordId = str(body.recordId).trim();
  const caseClosedDate = str(body.caseClosedDate).trim();
  if (!recordId) return A.reply(400, { error: 'recordId is required.' });
  if (!DATE_RE.test(caseClosedDate)) return A.reply(400, { error: 'caseClosedDate must be in YYYY-MM-DD form.' });

  const target = await A.airtable('GET', '/' + A.TABLES.caseAgingExceptions + '/' + recordId).catch(() => null);
  if (!target) return A.reply(404, { error: 'No matching case aging exception request.' });

  const mine = String(session.user.email || '').toLowerCase();
  const owner = String((target.fields && target.fields['Submitted By Email']) || '').toLowerCase();
  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  if (!isAdmin && owner !== mine) {
    return A.reply(403, { error: 'You can only set the closed date on your own requests.' });
  }

  const status = (target.fields && target.fields.Status) || 'Pending';
  if (status !== 'Approved') {
    return A.reply(400, { error: 'Only an Approved request can be marked closed. This request is ' + status + '.' });
  }

  const updated = await A.updateRecord(A.TABLES.caseAgingExceptions, recordId, { 'Case Closed Date': caseClosedDate });
  return A.reply(200, { request: requestOf(updated) });
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
    if (event.httpMethod === 'PATCH') return await markClosed(event);
    return A.reply(405, { error: 'GET, POST, or PATCH only.' });
  } catch (err) {
    return A.fail(err);
  }
};
