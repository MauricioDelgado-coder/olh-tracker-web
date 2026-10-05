/**
 * SAN user administration, for the SAN Admin role.
 *
 *   GET   /api/san-users                                  -> {users:[...]}
 *   POST  /api/san-users {action:'create', name, email}   -> {user, inviteUrl, expiresAt}
 *   POST  /api/san-users {action:'reset', userId}         -> {user, kind, inviteUrl, expiresAt}
 *   PATCH /api/san-users {userId, active}                 -> {user}
 *
 * Every route requires sanroster.manage (SAN Admin; Admin holds it too).
 *
 * The scope is enforced HERE, not in the page, because the page is a UI and
 * this is the boundary. A SAN Admin can only ever see or touch accounts that
 *   - have the role sandbox (a regular SAN user), and
 *   - carry no per-user Permission Grants.
 * The second rule matters: an OLH admin can grant extra permissions to any
 * user from the main console. If a SAN Admin could reset the password of a
 * sandbox user who had been granted, say, roster.manage, a reset link would be
 * a way into that wider access. Such accounts are managed from the main Admin
 * page only.
 *
 * A SAN Admin cannot create, reset or deactivate another SAN Admin, cannot
 * change anyone's role, and cannot delete accounts. New users are always
 * created with the sandbox role -- the body cannot name a role.
 *
 * Links follow password.js exactly: single-use token stored only as SHA-256,
 * 24h for an invite (account never had a password), 1h for a reset. Nothing is
 * emailed; the link is returned once for the SAN Admin to send.
 *
 * A reset also bumps Session Epoch, signing that user out everywhere at once,
 * so a reset can be used to cut off a session on a lost or shared device.
 *
 * Every action is written to the SAN Audit Log (SAN base).
 */

'use strict';

const A = require('../lib/olh-auth');

const SAN = A.forBase(A.SAN_BASE_ID);
const SAN_ROLE = 'sandbox';
const SAN_DIVISION = 'San Antonio';
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const OUT_OF_SCOPE =
  'That account is not a SAN user account, so it cannot be managed from the SAN Admin page. ' +
  'Ask an OLH admin.';

function siteUrl(event) {
  const fromEnv = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const h = event.headers || {};
  const host = h.host || h.Host || '';
  return host ? (h['x-forwarded-proto'] || 'https') + '://' + host : '';
}

function grantsOf(rec) {
  const g = rec && rec.fields && rec.fields['Permission Grants'];
  return Array.isArray(g) ? g : (g ? [g] : []);
}

function inScope(rec) {
  return !!rec && A.roleSlug(rec.fields && rec.fields.Role) === SAN_ROLE && grantsOf(rec).length === 0;
}

async function scopedUser(userId) {
  const id = String(userId || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) {
    const e = new Error('That user id is not valid.');
    e.statusCode = 400;
    throw e;
  }
  const rec = await A.userById(id);
  if (!rec) {
    const e = new Error('That user no longer exists.');
    e.statusCode = 404;
    throw e;
  }
  if (!inScope(rec)) {
    const e = new Error(OUT_OF_SCOPE);
    e.statusCode = 403;
    throw e;
  }
  return rec;
}

async function issueToken(userId, ttlMs, extraFields) {
  const token = A.randomToken();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await A.updateRecord(A.TABLES.users, userId, Object.assign({
    'Invite Token Hash': A.sha256(token),
    'Invite Expires': expiresAt
  }, extraFields || {}));
  return { token, expiresAt };
}

/** Best effort: the change already happened, so a log failure never fails it. */
async function trail(session, rec, field, from, to, action) {
  try {
    await SAN.createRecord(A.SAN_TABLES.audit, {
      'Entry Id': 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      'Record Id': rec.id,
      'Job #': '',
      Field: field,
      Label: 'User: ' + String((rec.fields && rec.fields.Email) || '').toLowerCase(),
      From: String(from == null ? '' : from),
      To: String(to == null ? '' : to),
      Action: action,
      Page: 'SAN Admin',
      'Changed By': session.user.name,
      'Changed By Id': session.user.id,
      'Changed By Role': session.user.role,
      'Changed At': new Date().toISOString()
    });
  } catch (_) { /* ignore */ }
}

async function list(session) {
  void session;
  const recs = await A.listRecords(A.TABLES.users);
  const users = recs.filter(inScope).map(A.publicUser)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return A.reply(200, { users });
}

async function create(event, session, body) {
  const name = String(body.name || '').trim();
  const email = A.normEmail(body.email);
  if (!name) return A.reply(400, { error: 'Enter a name.' });
  if (name.length > 120) return A.reply(400, { error: 'That name is too long.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return A.reply(400, { error: 'Enter a valid email address.' });
  }
  if (await A.userByEmail(email)) {
    return A.reply(409, { error: 'That email already has an account. Ask an OLH admin if it needs SAN access.' });
  }

  const created = await A.createRecord(A.TABLES.users, {
    Name: name,
    Email: email,
    Role: A.roleLabel(SAN_ROLE),
    Division: SAN_DIVISION,
    Active: true,
    Pending: true,
    'Password Hash': '',
    'Session Epoch': 0
  });
  const { token, expiresAt } = await issueToken(created.id, INVITE_TTL_MS);
  const fresh = await A.userById(created.id);
  await trail(session, fresh, 'Account', '', 'created (' + A.roleLabel(SAN_ROLE) + ')', 'san-user-create');

  return A.reply(201, {
    user: A.publicUser(fresh),
    kind: 'invite',
    inviteUrl: siteUrl(event) + '/?invite=' + encodeURIComponent(token),
    expiresAt,
    emailed: false
  });
}

async function reset(event, session, body) {
  const rec = await scopedUser(body.userId);
  if (!rec.fields.Active) {
    return A.reply(409, { error: 'That account is deactivated. Reactivate it before sending a link.' });
  }
  const pending = !!rec.fields.Pending;
  const kind = pending ? 'invite' : 'reset';
  const extra = pending ? {} : { 'Session Epoch': Number(rec.fields['Session Epoch'] || 0) + 1 };
  const { token, expiresAt } = await issueToken(rec.id, pending ? INVITE_TTL_MS : RESET_TTL_MS, extra);
  await trail(session, rec, 'Password', '', kind === 'invite' ? 'new invite link issued' : 'reset link issued; signed out',
    'san-user-' + kind);

  return A.reply(200, {
    user: A.publicUser(await A.userById(rec.id)),
    kind,
    inviteUrl: siteUrl(event) + '/?' + (kind === 'invite' ? 'invite=' : 'reset=') + encodeURIComponent(token),
    expiresAt,
    emailed: false
  });
}

async function setActive(session, body) {
  if (typeof body.active !== 'boolean') return A.reply(400, { error: 'Send active: true or false.' });
  const rec = await scopedUser(body.userId);
  if (rec.id === session.user.id) return A.reply(403, { error: 'You cannot change your own account here.' });
  if (!!rec.fields.Active === body.active) return A.reply(200, { user: A.publicUser(rec) });

  const fields = { Active: body.active };
  if (!body.active) fields['Session Epoch'] = Number(rec.fields['Session Epoch'] || 0) + 1;
  await A.updateRecord(A.TABLES.users, rec.id, fields);
  await trail(session, rec, 'Active', rec.fields.Active ? 'Yes' : 'No', body.active ? 'Yes' : 'No',
    body.active ? 'san-user-reactivate' : 'san-user-deactivate');
  return A.reply(200, { user: A.publicUser(await A.userById(rec.id)) });
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
    const session = await A.requireSession(event);
    A.requirePerm(session, 'sanroster.manage');

    if (event.httpMethod === 'GET') return await list(session);
    if (event.httpMethod === 'PATCH') return await setActive(session, A.readJson(event));
    if (event.httpMethod === 'POST') {
      const body = A.readJson(event);
      if (body.action === 'create') return await create(event, session, body);
      if (body.action === 'reset') return await reset(event, session, body);
      return A.reply(400, { error: "POST needs action 'create' or 'reset'." });
    }
    return A.reply(405, { error: 'GET, POST or PATCH only.' });
  } catch (err) {
    return A.fail(err);
  }
};
