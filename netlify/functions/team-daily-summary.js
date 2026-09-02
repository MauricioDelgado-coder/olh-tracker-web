/**
 * Area Manager rollup of their associates' Daily Summary submissions.
 *
 *   GET  /api/team-daily-summary?from=YYYY-MM-DD&to=YYYY-MM-DD&all=1
 *         -> {reports, roster, isAdmin, viewingAll, from, to}
 *
 *         Scoped to the caller's direct reports by default, identically to
 *         bonus-approvals.js and case-aging-approvals.js: a manager sees only
 *         submissions from associates whose Users row has {Manager} pointing
 *         back at the caller's own Users row. Admins additionally get
 *         everyone's via ?all=1.
 *
 *         `roster` is the caller's direct-report roster (name/email/division)
 *         so the page can show who has NOT submitted for a given day -- the
 *         gap is the point of this page, and a list of rows that exist can
 *         never show you the rows that don't.
 *
 *   PATCH /api/team-daily-summary
 *         {recordId, status}
 *         -> {report}
 *
 *         Sets Status to Reviewed / Needs Follow-up and stamps Reviewed By/At
 *         from the session, never the body. Scope-checked the same way as the
 *         GET, so a manager can only review their own reports' submissions.
 *
 * Gated on page.teamdaily -- deliberately its own permission rather than
 * reusing page.dailysummary. page.dailysummary means "I file a daily
 * summary"; page.teamdaily means "I read my team's." An associate holding
 * the first must not acquire the second, which is exactly what would happen
 * if this rode on the submit page's permission.
 *
 * Reads and writes the same Daily Summary table as daily-summary.js and
 * borrows its reportOf() field mapping verbatim -- if that table's field
 * names change, both files change together.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REVIEW_STATUS = ['Reviewed', 'Needs Follow-up'];

/* Same shape daily-summary.js returns, so the two pages read one vocabulary. */
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

/** All Users rows whose Manager link points back at `managerId`. Mirrors case-aging-approvals.js. */
async function directReports(managerId) {
  const all = await A.listRecords(A.TABLES.users);
  return all.filter((r) => {
    const mgr = r.fields && r.fields.Manager;
    return Array.isArray(mgr) && mgr.indexOf(managerId) >= 0;
  });
}
function rosterOf(rec) {
  const f = rec.fields || {};
  return {
    userId: rec.id,
    name: f.Name || '',
    email: String(f.Email || '').toLowerCase(),
    division: f.Division || '',
    active: !!f.Active
  };
}

/** YYYY-MM-DD `days` before today, in UTC -- the same basis Report Date is stored on. */
function isoShift(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.teamdaily');

  const q = event.queryStringParameters || {};
  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  const wantAll = str(q.all) === '1' && isAdmin;

  // A single ?date= is the common case (today's board); from/to widens it.
  const single = str(q.date).trim();
  let from = single || str(q.from).trim();
  let to = single || str(q.to).trim();
  if (!DATE_RE.test(from)) from = isoShift(-6);
  if (!DATE_RE.test(to)) to = isoShift(0);
  if (from > to) { const t = from; from = to; to = t; }

  let roster = [];
  let allowedEmails = null;
  if (!wantAll) {
    roster = (await directReports(session.record.id)).map(rosterOf);
    allowedEmails = new Set(roster.map((r) => r.email).filter(Boolean));
  }

  // Filtered in JS rather than by formula: Report Date's field type has
  // changed shape once already, and a bad filterByFormula fails by silently
  // returning nothing rather than erroring. Sorted desc so the window we
  // care about is always inside the page we pull.
  const recs = await A.listRecords(A.TABLES.dailySummary, {
    'sort[0][field]': 'Report Date',
    'sort[0][direction]': 'desc',
    maxRecords: '1000'
  });

  let rows = recs.map(reportOf).filter((r) => r.reportDate >= from && r.reportDate <= to);
  if (allowedEmails) rows = rows.filter((r) => allowedEmails.has(String(r.associateEmail || '').toLowerCase()));

  if (wantAll) {
    roster = (await A.listRecords(A.TABLES.users)).map(rosterOf);
  }

  return A.reply(200, { reports: rows, roster, isAdmin, viewingAll: wantAll, from, to });
}

async function review(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.teamdaily');

  const body = A.readJson(event);
  const recordId = str(body.recordId).trim();
  if (!recordId) return A.reply(400, { error: 'recordId is required.' });

  const status = str(body.status).trim();
  if (REVIEW_STATUS.indexOf(status) < 0) {
    return A.reply(400, { error: 'status must be one of: ' + REVIEW_STATUS.join(', ') + '.' });
  }

  const target = await A.airtable('GET', '/' + A.TABLES.dailySummary + '/' + recordId).catch(() => null);
  if (!target) return A.reply(404, { error: 'No matching daily summary.' });

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  if (!isAdmin) {
    const reportRecs = await directReports(session.record.id);
    const allowed = new Set(reportRecs.map((r) => String((r.fields && r.fields.Email) || '').toLowerCase()));
    const targetEmail = String((target.fields && target.fields['Associate Email']) || '').toLowerCase();
    if (!allowed.has(targetEmail)) {
      return A.reply(403, { error: 'That daily summary does not belong to one of your direct reports.' });
    }
  }

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
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, PATCH' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'GET') return await list(event);
    if (event.httpMethod === 'PATCH') return await review(event);
    return A.reply(405, { error: 'GET or PATCH only.' });
  } catch (err) {
    return A.fail(err);
  }
};
