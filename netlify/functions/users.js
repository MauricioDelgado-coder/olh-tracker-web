/**
 * User administration for the OLH Suite. Every route requires roster.manage.
 *
 *   GET    /api/users          -> {users:[{id,name,email,role,division,active,pending,grants,revokes}]}
 *   POST   /api/users   {user} -> {user, inviteUrl, expiresAt}
 *   PATCH  /api/users/:id {name?,email?,division?,role?,active?,grants?,revokes?} -> {user}
 *   DELETE /api/users/:id      -> {ok:true}
 *
 * grants/revokes are per-user permission overrides applied on top of the
 * role matrix (see applyOverrides in olh-auth.js). Each is a full replacement
 * array, same as every other PATCH field here -- send the complete list you
 * want stored, not a delta. Filtered through PERMS both here at write time and
 * again in applyOverrides at read time, so a stale or invented permission key
 * never survives either point. An admin's suite.view/roster.manage/page.admin
 * cannot be revoked this way regardless of what's sent -- applyOverrides
 * re-enforces that invariant unconditionally.
 *
 * Guard rails, all enforced here rather than only in the admin UI:
 *   - You cannot change your own role, suspend yourself, or delete yourself.
 *     Locking yourself out of the only console that can unlock you is not a
 *     recoverable mistake.
 *   - The last active admin cannot be demoted, suspended or deleted.
 *   - Email is unique, case-insensitively.
 *   - Suspending or changing a role bumps Session Epoch, so the change takes
 *     effect on the person's next request rather than whenever they sign out.
 *   - A new user is created Pending with no password. POST returns a one-time
 *     invite URL for the admin to send; see password.js for why it is not mailed.
 */

'use strict';

const A = require('../lib/olh-auth');

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

function siteUrl(event) {
  const fromEnv = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const h = event.headers || {};
  const host = h.host || h.Host || '';
  return host ? (h['x-forwarded-proto'] || 'https') + '://' + host : '';
}

async function activeAdmins() {
  const recs = await A.listRecords(A.TABLES.users);
  return recs.filter((r) => A.roleSlug(r.fields && r.fields.Role) === 'admin' &&
                            !!(r.fields && r.fields.Active));
}

/** Would this change leave the base with no admin who can still sign in? */
async function guardLastAdmin(targetId, nextRole, nextActive) {
  const admins = await activeAdmins();
  const stillAdmin = admins.filter((r) => {
    if (r.id !== targetId) return true;
    return nextRole === 'admin' && nextActive !== false;
  });
  if (!stillAdmin.length) {
    const e = new Error(
      'That would leave the OLH Suite with no active admin. Promote someone else first.'
    );
    e.statusCode = 409;
    throw e;
  }
}

async function list(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'roster.manage');
  const recs = await A.listRecords(A.TABLES.users);
  const users = recs.map(A.publicUser)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return A.reply(200, { users });
}

async function create(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'roster.manage');

  const body = A.readJson(event);
  const name = String(body.name || '').trim();
  const email = A.normEmail(body.email);
  const role = A.roleSlug(body.role);
  const division = String(body.division || '').trim() || 'Central Florida';

  if (!name) return A.reply(400, { error: 'Enter a name.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return A.reply(400, { error: 'Enter a valid email address.' });
  }
  if (await A.userByEmail(email)) {
    return A.reply(409, { error: 'That email is already on the roster.' });
  }

  const created = await A.createRecord(A.TABLES.users, {
    Name: name,
    Email: email,
    Role: A.roleLabel(role),
    Division: division,
    Active: body.active === false ? false : true,
    Pending: true,
    'Password Hash': '',
    'Session Epoch': 0
  });

  // Issue the first invite immediately -- an account with no way in is useless.
  const token = A.randomToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  await A.updateRecord(A.TABLES.users, created.id, {
    'Invite Token Hash': A.sha256(token),
    'Invite Expires': expiresAt
  });

  const fresh = await A.userById(created.id);
  return A.reply(201, {
    user: A.publicUser(fresh),
    inviteUrl: siteUrl(event) + '/?invite=' + encodeURIComponent(token),
    expiresAt,
    emailed: false
  });
}

async function patch(event, id) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'roster.manage');

  const rec = await A.userById(id);
  if (!rec) return A.reply(404, { error: 'That user no longer exists.' });

  const body = A.readJson(event);
  const isSelf = session.user.id === rec.id;
  const fields = {};
  let bumpEpoch = false;

  if (body.name !== undefined) fields.Name = String(body.name).trim();
  if (body.division !== undefined) fields.Division = String(body.division).trim();

  if (body.email !== undefined) {
    const email = A.normEmail(body.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return A.reply(400, { error: 'Enter a valid email address.' });
    }
    const clash = await A.userByEmail(email);
    if (clash && clash.id !== rec.id) {
      return A.reply(409, { error: 'That email is already on the roster.' });
    }
    fields.Email = email;
  }

  if (body.role !== undefined) {
    const role = A.roleSlug(body.role);
    if (isSelf && role !== session.user.role) {
      return A.reply(403, { error: 'You cannot change your own role.' });
    }
    if (role !== A.roleSlug(rec.fields.Role)) {
      await guardLastAdmin(rec.id, role, body.active === undefined ? !!rec.fields.Active : !!body.active);
      fields.Role = A.roleLabel(role);
      bumpEpoch = true;
    }
  }

  if (body.active !== undefined) {
    const active = !!body.active;
    if (isSelf && !active) {
      return A.reply(403, { error: 'You cannot suspend your own account.' });
    }
    if (active !== !!rec.fields.Active) {
      await guardLastAdmin(rec.id, body.role === undefined ? A.roleSlug(rec.fields.Role) : A.roleSlug(body.role), active);
      fields.Active = active;
      if (!active) bumpEpoch = true; // cut existing sessions immediately
    }
  }

  // Per-user permission overrides. Filtered through PERMS here too (not just
  // in applyOverrides at read time) so what gets stored on the Users record
  // already matches what will actually take effect -- an admin looking at
  // Airtable directly should not see a value that the server silently ignores.
  if (body.grants !== undefined) {
    fields['Permission Grants'] = Array.isArray(body.grants)
      ? body.grants.filter((p) => A.PERMS.indexOf(p) >= 0)
      : [];
  }
  if (body.revokes !== undefined) {
    fields['Permission Revokes'] = Array.isArray(body.revokes)
      ? body.revokes.filter((p) => A.PERMS.indexOf(p) >= 0)
      : [];
  }

  if (!Object.keys(fields).length) {
    return A.reply(200, { user: A.publicUser(rec) });
  }
  if (bumpEpoch) {
    fields['Session Epoch'] = Number(rec.fields['Session Epoch'] || 0) + 1;
  }

  await A.updateRecord(A.TABLES.users, rec.id, fields);
  const fresh = await A.userById(rec.id);
  await trail(session, rec, fields);
  return A.reply(200, { user: A.publicUser(fresh) });
}

async function remove(event, id) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'roster.manage');

  const rec = await A.userById(id);
  if (!rec) return A.reply(404, { error: 'That user no longer exists.' });
  if (session.user.id === rec.id) {
    return A.reply(403, { error: 'You cannot delete your own account.' });
  }
  await guardLastAdmin(rec.id, null, false);

  await A.deleteRecord(A.TABLES.users, rec.id);
  await trail(session, rec, { Active: false, Note: 'deleted' });
  return A.reply(200, { ok: true });
}

/** One audit row per changed field, so the log reads the same as tracker edits. */
async function trail(session, rec, fields) {
  const stamp = new Date().toISOString();
  for (const key of Object.keys(fields)) {
    if (key === 'Session Epoch') continue;
    try {
      await A.createRecord(A.TABLES.audit, {
        'Entry Id': 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        'Record Id': rec.id,
        Field: key,
        Label: key,
        From: String((rec.fields && rec.fields[key]) == null ? '' : rec.fields[key]),
        To: String(fields[key] == null ? '' : fields[key]),
        Action: 'roster',
        Page: 'admin',
        'Changed By': session.user.name,
        'Changed By Id': session.user.id,
        'Changed By Role': session.user.role,
        'Changed At': stamp
      });
    } catch (_) { /* the change already happened; the log is best effort */ }
  }
}

exports.handler = async (event) => {
  const id = A.route(event, 'users')[0] || '';

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST, PATCH, DELETE' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'GET' && !id) return await list(event);
    if (event.httpMethod === 'POST' && !id) return await create(event);
    if (event.httpMethod === 'PATCH' && id) return await patch(event, id);
    if (event.httpMethod === 'DELETE' && id) return await remove(event, id);
    return A.reply(405, {
      error: 'Use GET/POST /api/users or PATCH/DELETE /api/users/:id.'
    });
  } catch (err) {
    return A.fail(err);
  }
};
