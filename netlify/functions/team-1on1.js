/**
 * Area Manager rollup of their associates' Monthly One-on-One check-ins.
 *
 *   GET  /api/team-1on1?month=YYYY-MM&all=1
 *         -> {checkins, roster, isAdmin, viewingAll, month}
 *
 *         Scoped to the caller's direct reports by default (Users.Manager
 *         linkage, same resolution as case-aging-approvals.js). Admins get
 *         every row for the month via ?all=1.
 *
 *         `roster` is the direct-report roster so the page can show the
 *         associates with no check-in row yet -- on a one-on-one page the
 *         missing rows are the whole point.
 *
 *   PATCH /api/team-1on1
 *         {recordId, discussionNotes, supportActions, managerName?, complete}
 *         -> {checkin}
 *
 *         Manager-side write of Part 3 (Support Needed). Only the associate's
 *         own manager -- or an admin -- may write it. Never touches Part 1/2,
 *         which belong to the associate.
 *
 * Gated on page.team1on1, deliberately separate from page.monthly1on1 for the
 * same reason team-daily-summary.js splits from page.dailysummary: holding
 * your own check-in page must not hand you your peers' check-ins. Every
 * associate role carries page.monthly1on1.
 *
 * Reads and writes the same Monthly 1-on-1 table as monthly-1on1.js and
 * borrows its checkinOf() field mapping verbatim -- change one, change both.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const MONTH_RE = /^\d{4}-\d{2}$/;

/* Same shape monthly-1on1.js returns, so the two pages read one vocabulary. */
function checkinOf(rec) {
  const f = rec.fields || {};
  return {
    id: f['Submission Id'] || rec.id,
    recordId: rec.id,
    associateName: f['Associate Name'] || '',
    associateEmail: f['Associate Email'] || '',
    managerName: f['Manager Name'] || '',
    division: f.Division || '',
    checkinMonth: f['Check-in Month'] || '',
    metrics: {
      casesClosed: { thisMonth: f['Cases Closed MTD (This Month)'] ?? null, lastMonth: f['Cases Closed MTD (Last Month)'] ?? null, notes: f['Cases Closed MTD Notes'] || '' },
      cycleTime: { thisMonth: f['MTD Cycle Time (This Month)'] ?? null, lastMonth: f['MTD Cycle Time (Last Month)'] ?? null, notes: f['MTD Cycle Time Notes'] || '' },
      under7Day: { thisMonth: f['MTD Under 7-Day Pct (This Month)'] ?? null, lastMonth: f['MTD Under 7-Day Pct (Last Month)'] ?? null, notes: f['MTD Under 7-Day Pct Notes'] || '' },
      agedCases: { thisMonth: f['Aged Cases (This Month)'] ?? null, lastMonth: f['Aged Cases (Last Month)'] ?? null, notes: f['Aged Cases Notes'] || '' },
      totalOpen: { thisMonth: f['Total Open Cases (This Month)'] ?? null, lastMonth: f['Total Open Cases (Last Month)'] ?? null, notes: f['Total Open Cases Notes'] || '' }
    },
    challenges: f['Challenges and Barriers'] || '',
    wins: f['Wins Worth Noting'] || '',
    discussionNotes: f['Discussion Notes'] || '',
    supportActions: f['Support Actions Agreed'] || '',
    status: f.Status || 'Draft',
    submittedBy: f['Submitted By'] || '',
    submittedAt: f['Submitted At'] || '',
    completedBy: f['Completed By'] || '',
    completedAt: f['Completed At'] || ''
  };
}

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

/** Current YYYY-MM in UTC -- the basis Check-in Month is stored on. */
function thisMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.team1on1');

  const q = event.queryStringParameters || {};
  let month = str(q.month).trim();
  if (!MONTH_RE.test(month)) month = thisMonth();

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  const wantAll = str(q.all) === '1' && isAdmin;

  let roster = [];
  let allowedEmails = null;
  if (!wantAll) {
    roster = (await directReports(session.record.id)).map(rosterOf);
    allowedEmails = new Set(roster.map((r) => r.email).filter(Boolean));
  }

  const recs = await A.listRecords(A.TABLES.monthly1on1, {
    filterByFormula: '{Check-in Month} = "' + A.esc(month) + '"',
    maxRecords: '500'
  });
  let rows = recs.map(checkinOf);
  if (allowedEmails) rows = rows.filter((r) => allowedEmails.has(String(r.associateEmail || '').toLowerCase()));

  if (wantAll) {
    roster = (await A.listRecords(A.TABLES.users)).map(rosterOf);
  }

  return A.reply(200, { checkins: rows, roster, isAdmin, viewingAll: wantAll, month });
}

async function complete(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.team1on1');

  const body = A.readJson(event);
  const recordId = str(body.recordId).trim();
  if (!recordId) return A.reply(400, { error: 'recordId is required.' });

  const target = await A.airtable('GET', '/' + A.TABLES.monthly1on1 + '/' + recordId).catch(() => null);
  if (!target) return A.reply(404, { error: 'No matching check-in.' });

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  if (!isAdmin) {
    const reportRecs = await directReports(session.record.id);
    const allowed = new Set(reportRecs.map((r) => String((r.fields && r.fields.Email) || '').toLowerCase()));
    const targetEmail = String((target.fields && target.fields['Associate Email']) || '').toLowerCase();
    if (!allowed.has(targetEmail)) {
      return A.reply(403, { error: 'This check-in does not belong to one of your direct reports.' });
    }
  }

  // Part 1/2 are the associate's and are never written here.
  const fields = {};
  if (body.discussionNotes != null) fields['Discussion Notes'] = str(body.discussionNotes);
  if (body.supportActions != null) fields['Support Actions Agreed'] = str(body.supportActions);
  if (body.managerName != null && str(body.managerName).trim()) fields['Manager Name'] = str(body.managerName).trim();
  if (body.complete) {
    fields.Status = 'Completed';
    fields['Completed By'] = session.user.name;
    fields['Completed At'] = new Date().toISOString();
  }

  const updated = await A.updateRecord(A.TABLES.monthly1on1, recordId, fields);
  return A.reply(200, { checkin: checkinOf(updated) });
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
    if (event.httpMethod === 'PATCH') return await complete(event);
    return A.reply(405, { error: 'GET or PATCH only.' });
  } catch (err) {
    return A.fail(err);
  }
};
