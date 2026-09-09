/**
 * A manager's direct-report roster -- the entry point for the Team suite
 * (team.html -> team-associate.html). Deliberately its own tiny endpoint
 * rather than piggybacking on team-daily-summary.js or team-1on1.js: the
 * landing page needs the roster before it knows which associate (and
 * therefore which of those two data sets) anyone is about to look at.
 *
 *   GET /api/team-roster?all=1
 *   GET /api/team-roster?managerId=<Users record id>
 *       -> {roster, isAdmin, viewingAll, viewingManager, managers}
 *
 * Scoped to the caller's direct reports by default -- identical Users.Manager
 * resolution to bonus-approvals.js / case-aging-approvals.js / the other two
 * team-*.js endpoints. Admins additionally get:
 *   - ?all=1            every associate, flat (no manager grouping)
 *   - ?managerId=<id>   exactly the roster that manager would see themselves,
 *                       i.e. "view as manager" -- an admin picking a specific
 *                       leader from `managers` rather than either their own
 *                       (possibly empty) team or everyone at once.
 * managerId wins if both are present. Both params are ignored for a non-admin
 * caller, who always gets their own team.
 *
 * `managers` (A.managersFrom) is returned whenever the caller is an admin,
 * regardless of which of the three views they are currently on, so the
 * picker itself does not need a separate request. Non-admins get [].
 *
 * Gated on EITHER page.teamdaily or page.team1on1 (not a new permission of
 * its own): both already mean "I read my team's submissions," and requiring
 * just one to reach a roster that is otherwise just a jumping-off point would
 * only fragment a grant an admin already has to make twice. team-performance.js
 * uses the same either/or check.
 */

'use strict';

const A = require('../lib/olh-auth');

const str = (v) => (v == null ? '' : String(v));

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

function rosterOf(rec) {
  const f = rec.fields || {};
  return {
    userId: rec.id,
    name: f.Name || '',
    email: String(f.Email || '').toLowerCase(),
    division: f.Division || '',
    role: A.roleSlug(f.Role),
    active: !!f.Active
  };
}

async function list(event) {
  const session = await A.requireSession(event);
  if (!isTeamManager(session)) {
    return A.reply(403, {
      error: 'Your role does not have access to the Team page. Ask an admin to grant Team Daily ' +
        'Summaries or Team One-on-Ones on the Roles & Permissions grid.'
    });
  }

  const q = event.queryStringParameters || {};
  const isAdmin = session.can.indexOf('roster.manage') >= 0;
  const wantAll = str(q.all) === '1' && isAdmin;
  const managerId = isAdmin ? str(q.managerId).trim() : '';

  // Admins get one full Users read that serves the manager picker, a
  // manager-scoped view and the flat view all -- whichever of the three
  // this request turns out to be -- rather than a second query per case.
  const allUsers = isAdmin ? await A.listRecords(A.TABLES.users) : null;
  const managers = allUsers ? A.managersFrom(allUsers) : [];

  let recs, viewingManager = null;
  if (managerId) {
    const mgrRec = allUsers.find((r) => r.id === managerId);
    if (!mgrRec) return A.reply(404, { error: 'No such manager.' });
    recs = allUsers.filter((r) => Array.isArray(r.fields && r.fields.Manager) && r.fields.Manager.indexOf(managerId) >= 0);
    viewingManager = { userId: mgrRec.id, name: (mgrRec.fields && mgrRec.fields.Name) || '' };
  } else if (wantAll) {
    recs = allUsers;
  } else if (allUsers) {
    // Admin, no explicit selection -- their own team, reusing the read above.
    recs = allUsers.filter((r) => Array.isArray(r.fields && r.fields.Manager) && r.fields.Manager.indexOf(session.record.id) >= 0);
  } else {
    recs = await directReports(session.record.id);
  }

  const roster = recs.map(rosterOf).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return A.reply(200, { roster, isAdmin, viewingAll: wantAll && !managerId, viewingManager, managers });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET' }), body: '' };
  }
  try {
    if (event.httpMethod === 'GET') return await list(event);
    return A.reply(405, { error: 'GET only.' });
  } catch (err) {
    return A.fail(err);
  }
};
