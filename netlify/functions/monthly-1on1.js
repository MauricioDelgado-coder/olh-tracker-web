/**
 * Monthly One-on-One check-ins between an associate and their manager.
 *
 * One row per associate per check-in month, upserted on Associate Email +
 * Check-in Month (see Key field). Part 1 (Metrics) and Part 2 (Challenges
 * and Barriers) are completed by the associate before the meeting; Part 3
 * (Support Needed) is completed by the manager during the meeting.
 *
 *   POST /api/monthly-1on1
 *         {checkinMonth, managerName, metrics:{...}, challenges, wins, submissionId?}
 *         -> {checkin}
 *
 *         Associate-side write. Upserts by Associate Email + Check-in Month
 *         so re-saving a draft before the meeting never creates a duplicate
 *         row -- same reasoning as CCR Bonus SF Source's Key-based upsert.
 *         Refuses to overwrite Part 3 fields (Discussion Notes, Support
 *         Actions Agreed) once a manager has completed them, so an associate
 *         re-saving Part 1/2 after the meeting can't blow away the record of
 *         what was discussed.
 *
 *   GET  /api/monthly-1on1?month=YYYY-MM
 *         -> {checkin}          the caller's own row for that month, or null
 *
 *        /api/monthly-1on1?month=YYYY-MM&all=1
 *         -> {checkins, reports}   the caller's direct reports' rows for
 *            that month (Users.Manager linkage, identical resolution to
 *            case-aging-approvals.js's directReports()), plus the report
 *            roster itself so the page can list associates with no row yet.
 *            Admins get every row for the month via &all=1&admin=1.
 *
 *   PATCH /api/monthly-1on1
 *         {recordId, discussionNotes, supportActions, complete}
 *         -> {checkin}
 *
 *         Manager-side write. Only the associate's own manager (or an
 *         admin) may complete Part 3 -- checked the same way
 *         case-aging-approvals.js scopes a review to the caller's reports.
 *
 * Gated on page.monthly1on1 (see olh-auth.js ALL_PAGES/DEFAULT_ROLES).
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const MONTH_RE = /^\d{4}-\d{2}$/;

function keyOf(email, month) {
  return String(email || '').trim().toLowerCase() + '|' + month;
}

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

/** All active Users rows whose Manager link points back at `managerId`. Mirrors case-aging-approvals.js. */
async function directReports(managerId) {
  const all = await A.listRecords(A.TABLES.users);
  return all.filter((r) => {
    const mgr = r.fields && r.fields.Manager;
    return Array.isArray(mgr) && mgr.indexOf(managerId) >= 0;
  });
}
function reportOf(rec) {
  const f = rec.fields || {};
  return { userId: rec.id, name: f.Name || '', email: String(f.Email || '').toLowerCase(), division: f.Division || '', active: !!f.Active };
}

async function upsert(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.monthly1on1');

  const body = A.readJson(event);
  const checkinMonth = str(body.checkinMonth).trim();
  if (!MONTH_RE.test(checkinMonth)) return A.reply(400, { error: 'checkinMonth must be in YYYY-MM form.' });

  const metrics = body.metrics || {};
  const m = (k) => metrics[k] || {};

  const key = keyOf(session.user.email, checkinMonth);
  const existing = await A.findOne(A.TABLES.monthly1on1, '{Key} = "' + A.esc(key) + '"');

  // Once a manager has completed Part 3, an associate resaving Part 1/2
  // must not be able to clear it -- so this write never touches those fields.
  const fields = {
    'Submission Id': (existing && existing.fields['Submission Id']) ||
      str(body.submissionId).trim() || ('m1on1' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
    Key: key,
    'Associate Name': session.user.name,
    'Associate Email': session.user.email,
    'Manager Name': str(body.managerName).trim(),
    Division: session.user.division || '',
    'Check-in Month': checkinMonth,
    'Cases Closed MTD (This Month)': num(m('casesClosed').thisMonth),
    'Cases Closed MTD (Last Month)': num(m('casesClosed').lastMonth),
    'Cases Closed MTD Notes': str(m('casesClosed').notes),
    'MTD Cycle Time (This Month)': num(m('cycleTime').thisMonth),
    'MTD Cycle Time (Last Month)': num(m('cycleTime').lastMonth),
    'MTD Cycle Time Notes': str(m('cycleTime').notes),
    'MTD Under 7-Day Pct (This Month)': num(m('under7Day').thisMonth),
    'MTD Under 7-Day Pct (Last Month)': num(m('under7Day').lastMonth),
    'MTD Under 7-Day Pct Notes': str(m('under7Day').notes),
    'Aged Cases (This Month)': num(m('agedCases').thisMonth),
    'Aged Cases (Last Month)': num(m('agedCases').lastMonth),
    'Aged Cases Notes': str(m('agedCases').notes),
    'Total Open Cases (This Month)': num(m('totalOpen').thisMonth),
    'Total Open Cases (Last Month)': num(m('totalOpen').lastMonth),
    'Total Open Cases Notes': str(m('totalOpen').notes),
    'Challenges and Barriers': str(body.challenges),
    'Wins Worth Noting': str(body.wins),
    'Submitted By': session.user.name,
    'Submitted At': new Date().toISOString()
  };
  // Status: leave Completed alone if the manager already finished this
  // month's meeting; otherwise (re)mark Submitted.
  if (!existing || existing.fields.Status !== 'Completed') fields.Status = 'Submitted';

  const saved = existing
    ? await A.updateRecord(A.TABLES.monthly1on1, existing.id, fields)
    : await A.createRecord(A.TABLES.monthly1on1, fields);

  return A.reply(existing ? 200 : 201, { checkin: checkinOf(saved) });
}

async function get(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.monthly1on1');

  const q = event.queryStringParameters || {};
  const month = str(q.month).trim();
  if (!MONTH_RE.test(month)) return A.reply(400, { error: 'month must be in YYYY-MM form.' });

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  const wantAll = str(q.all) === '1';

  if (wantAll) {
    const wantEveryone = str(q.admin) === '1' && isAdmin;
    let reports = [];
    let allowedEmails = null;

    if (!wantEveryone) {
      const reportRecs = await directReports(session.record.id);
      reports = reportRecs.map(reportOf);
      allowedEmails = new Set(reports.map((r) => r.email).filter(Boolean));
    }

    const recs = await A.listRecords(A.TABLES.monthly1on1, {
      filterByFormula: '{Check-in Month} = "' + A.esc(month) + '"',
      maxRecords: '500'
    });
    let rows = recs.map(checkinOf);
    if (allowedEmails) rows = rows.filter((r) => allowedEmails.has(String(r.associateEmail || '').toLowerCase()));

    if (wantEveryone) {
      const all = await A.listRecords(A.TABLES.users);
      reports = all.map(reportOf);
    }

    return A.reply(200, { checkins: rows, reports });
  }

  const key = keyOf(session.user.email, month);
  const existing = await A.findOne(A.TABLES.monthly1on1, '{Key} = "' + A.esc(key) + '"');
  return A.reply(200, { checkin: existing ? checkinOf(existing) : null });
}

async function complete(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'page.monthly1on1');

  const body = A.readJson(event);
  const recordId = str(body.recordId).trim();
  if (!recordId) return A.reply(400, { error: 'recordId is required.' });

  const target = await A.airtable('GET', '/' + A.TABLES.monthly1on1 + '/' + recordId).catch(() => null);
  if (!target) return A.reply(404, { error: 'No matching check-in.' });

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  if (!isAdmin) {
    const reportRecs = await directReports(session.record.id);
    const allowedEmails = new Set(reportRecs.map((r) => String((r.fields && r.fields.Email) || '').toLowerCase()));
    const targetEmail = String((target.fields && target.fields['Associate Email']) || '').toLowerCase();
    if (!allowedEmails.has(targetEmail)) {
      return A.reply(403, { error: 'This check-in does not belong to one of your direct reports.' });
    }
  }

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
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST, PATCH' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'POST') return await upsert(event);
    if (event.httpMethod === 'GET') return await get(event);
    if (event.httpMethod === 'PATCH') return await complete(event);
    return A.reply(405, { error: 'GET, POST, or PATCH only.' });
  } catch (err) {
    return A.fail(err);
  }
};
