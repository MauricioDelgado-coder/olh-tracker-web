/**
 * One associate's closed-case performance, windowed to the last 7 and last
 * 30 days -- the metrics tile on team-associate.html (reached from
 * team.html's roster).
 *
 *   GET /api/team-performance?email=<associate email>
 *       -> {associate, hasOwnerName, ownerNameUsed, windows:{last7,last30}, asOf}
 *
 * Source: CCR Bonus Case Log (dev/sync_ccr_bonus_case_log.py), NOT CCR Bonus
 * SF Source. The Source table is a monthly aggregate keyed to a bonus month;
 * this page needs a rolling 7/30-day window ending today, which only the
 * case-level log can answer -- it accumulates one row per closed case and
 * never deletes one just because it aged out of the sync's own rolling pull.
 *
 * Case Owner on that table is a plain Salesforce name string, not a link back
 * to Users -- there is no such link in Salesforce. Matching goes through
 * Users."Salesforce Owner Name" (backfilled from the ccr-monthly-bonus
 * skill's roster.json for the 24 known CCRs; blank for everyone else, which
 * is a fact worth surfacing rather than silently falling back to a guess).
 * Users.Name is tried as a fallback ONLY when Salesforce Owner Name is blank,
 * since for some people they are already identical.
 *
 * Scoped like the other team-*.js endpoints: the caller must be the target's
 * manager (Users.Manager link) or an admin. Gated on EITHER page.teamdaily or
 * page.team1on1, same as team-roster.js.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));
const DAY_MS = 24 * 60 * 60 * 1000;

function isTeamManager(session) {
  return session.can.indexOf('page.teamdaily') >= 0 || session.can.indexOf('page.team1on1') >= 0;
}

async function directReports(managerId) {
  const all = await A.listRecords(A.TABLES.users);
  return all.filter((r) => {
    const mgr = r.fields && r.fields.Manager;
    return Array.isArray(mgr) && mgr.indexOf(managerId) >= 0;
  });
}

/** {casesClosed, agedCases, avgCycleTime, pctWithin7} over one set of case rows. */
function aggregate(rows) {
  const n = rows.length;
  if (!n) return { casesClosed: 0, agedCases: 0, avgCycleTime: 0, pctWithin7: 0 };
  const ages = rows.map((r) => Number((r.fields && r.fields['Age (Days)']) || 0));
  const aged = ages.filter((a) => a > 21).length;
  const within7 = ages.filter((a) => a <= 7).length;
  const avgCycle = ages.reduce((a, b) => a + b, 0) / n;
  return {
    casesClosed: n,
    agedCases: aged,
    avgCycleTime: Math.round(avgCycle * 10) / 10,
    pctWithin7: Math.round((within7 / n) * 1000) / 10
  };
}

async function get(event) {
  const session = await A.requireSession(event);
  if (!isTeamManager(session)) {
    return A.reply(403, {
      error: 'Your role does not have access to the Team page. Ask an admin to grant Team Daily ' +
        'Summaries or Team One-on-Ones on the Roles & Permissions grid.'
    });
  }

  const q = event.queryStringParameters || {};
  const email = A.normEmail(q.email);
  if (!email) return A.reply(400, { error: 'email is required.' });

  const target = await A.userByEmail(email);
  if (!target) return A.reply(404, { error: 'No account for that email.' });

  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  if (!isAdmin) {
    const reports = await directReports(session.record.id);
    if (!reports.some((r) => r.id === target.id)) {
      return A.reply(403, { error: 'That associate is not one of your direct reports.' });
    }
  }

  const tf = target.fields || {};
  const ownerName = str(tf['Salesforce Owner Name']).trim() || str(tf.Name).trim();
  const hasOwnerName = !!str(tf['Salesforce Owner Name']).trim();

  const associate = {
    userId: target.id,
    name: tf.Name || '',
    email: String(tf.Email || '').toLowerCase(),
    division: tf.Division || ''
  };

  if (!ownerName) {
    return A.reply(200, {
      associate, hasOwnerName: false, ownerNameUsed: '',
      windows: { last7: aggregate([]), last30: aggregate([]) },
      asOf: new Date().toISOString()
    });
  }

  const formula = 'LOWER({Case Owner}) = "' + A.esc(ownerName.toLowerCase()) + '"';
  const rows = await A.listRecords(A.TABLES.ccrBonusCaseLog, { filterByFormula: formula, maxRecords: '1000' });

  const now = Date.now();
  const cutoff7 = now - 7 * DAY_MS;
  const cutoff30 = now - 30 * DAY_MS;
  const withDate = rows.filter((r) => {
    const t = Date.parse((r.fields && r.fields['Date Closed']) || '');
    return Number.isFinite(t);
  });
  const last7Rows = withDate.filter((r) => Date.parse(r.fields['Date Closed']) >= cutoff7);
  const last30Rows = withDate.filter((r) => Date.parse(r.fields['Date Closed']) >= cutoff30);

  return A.reply(200, {
    associate,
    hasOwnerName,
    ownerNameUsed: ownerName,
    windows: { last7: aggregate(last7Rows), last30: aggregate(last30Rows) },
    asOf: new Date().toISOString()
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET' }), body: '' };
  }
  try {
    if (event.httpMethod === 'GET') return await get(event);
    return A.reply(405, { error: 'GET only.' });
  } catch (err) {
    return A.fail(err);
  }
};
