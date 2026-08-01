/**
 * Password lifecycle for the OLH Suite.
 *
 *   POST /api/invite          {userId}          -> {ok, inviteUrl, expiresAt}   [admin]
 *   GET  /api/invite/:token                     -> {email, name, expiresAt}
 *   POST /api/set-password    {token, password}  -> {user, token}
 *   POST /api/forgot-password {email}            -> {ok:true}
 *
 * There is no email provider wired up, by decision: an admin issues a link and
 * sends it themselves from Outlook. POST /api/invite therefore RETURNS the
 * one-time URL instead of mailing it, which is why it requires roster.manage --
 * anyone who can call it can set another person's password.
 *
 * Because of that, /api/forgot-password cannot deliver anything. It still always
 * answers 200 so it cannot be used to discover who has an account, and it files
 * an Audit Log row an admin can act on. The person is told to contact an admin.
 *
 * Token rules: 32 random bytes, stored only as SHA-256, single-use, 24h for an
 * invite and 1h for a reset. Consuming one bumps Session Epoch, so any session
 * opened with the old password stops working.
 */

'use strict';

const A = require('../lib/olh-auth');

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/** Where the set-password screen lives. Any page reads ?invite= / ?reset=. */
function siteUrl(event) {
  const fromEnv = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const h = event.headers || {};
  const host = h.host || h.Host || '';
  const proto = h['x-forwarded-proto'] || 'https';
  return host ? proto + '://' + host : '';
}

/** Mint a fresh single-use token on a user row. Returns the raw token. */
async function issueToken(userId, ttlMs) {
  const token = A.randomToken();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  await A.updateRecord(A.TABLES.users, userId, {
    'Invite Token Hash': A.sha256(token),
    'Invite Expires': expires
  });
  return { token, expiresAt: expires };
}

async function createInvite(event) {
  const session = await A.requireSession(event);
  A.requirePerm(session, 'roster.manage');

  const { userId } = A.readJson(event);
  const rec = await A.userById(userId);
  if (!rec) return A.reply(404, { error: 'That user no longer exists.' });

  const kind = (rec.fields && rec.fields.Pending) ? 'invite' : 'reset';
  const ttl = kind === 'invite' ? INVITE_TTL_MS : RESET_TTL_MS;
  const { token, expiresAt } = await issueToken(rec.id, ttl);
  const base = siteUrl(event);

  return A.reply(200, {
    ok: true,
    kind,
    email: String((rec.fields && rec.fields.Email) || '').toLowerCase(),
    expiresAt,
    // Shown once, to be pasted into an email by the admin. Not stored anywhere.
    inviteUrl: base + '/?' + (kind === 'invite' ? 'invite=' : 'reset=') + encodeURIComponent(token),
    emailed: false
  });
}

/** Public: validates a link before the set-password form is shown. */
async function verifyInvite(event) {
  const token = A.route(event, 'password')[1];
  if (!token) return A.reply(400, { error: 'That link is missing its token.' });

  const rec = await A.userByTokenHash(A.sha256(token));
  const expires = rec && rec.fields && rec.fields['Invite Expires'];
  if (!rec || !expires || Date.now() > Date.parse(expires)) {
    // One message for missing, consumed and expired alike.
    return A.reply(404, { error: 'This link has expired or has already been used.' });
  }
  if (!rec.fields.Active) {
    return A.reply(403, { error: 'That account has been suspended. Ask an admin to reactivate it.' });
  }
  return A.reply(200, {
    email: String(rec.fields.Email || '').toLowerCase(),
    name: rec.fields.Name || '',
    expiresAt: expires
  });
}

async function setPassword(event) {
  const { token, password } = A.readJson(event);
  if (!token) return A.reply(400, { error: 'That link is missing its token.' });

  const fails = A.checkPolicy(password);
  if (fails.length) {
    return A.reply(400, { error: 'That password needs ' + fails.join(', ') + '.' });
  }

  const rec = await A.userByTokenHash(A.sha256(token));
  const expires = rec && rec.fields && rec.fields['Invite Expires'];
  if (!rec || !expires || Date.now() > Date.parse(expires)) {
    return A.reply(404, { error: 'This link has expired or has already been used.' });
  }
  if (!rec.fields.Active) {
    return A.reply(403, { error: 'That account has been suspended. Ask an admin to reactivate it.' });
  }

  const hash = await A.hashPassword(password);
  // Bumping the epoch invalidates anything minted before this password existed.
  const epoch = Number(rec.fields['Session Epoch'] || 0) + 1;

  await A.updateRecord(A.TABLES.users, rec.id, {
    'Password Hash': hash,
    Pending: false,
    'Invite Token Hash': '',   // single use: consumed here
    'Invite Expires': null,
    'Session Epoch': epoch,
    'Last Sign In': new Date().toISOString()
  });

  const fresh = await A.userById(rec.id);
  const user = A.publicUser(fresh);
  const matrix = await A.loadMatrix();
  const can = matrix[user.role] || [];
  if (can.indexOf('suite.view') < 0) {
    return A.reply(403, { error: A.DENY['suite.view'] });
  }

  await audit(rec.id, user, 'set-password');
  return A.reply(200, { user, token: A.mintSession(rec.id, epoch), can, roles: matrix });
}

/**
 * Always 200, whatever happens. A different answer for a known and an unknown
 * address would turn this into an account-existence oracle.
 */
async function forgotPassword(event) {
  const { email } = A.readJson(event);
  try {
    const rec = await A.userByEmail(email);
    // Pending accounts are skipped deliberately. issueToken overwrites Invite
    // Token Hash, so without this check an unauthenticated caller could void
    // anyone's outstanding invite just by naming their address -- and there is
    // no password to reset on an account that never had one. A pending user
    // needs a fresh invite from an admin, which is what they are told.
    const resettable = rec && rec.fields && rec.fields.Active && !rec.fields.Pending;
    if (resettable) {
      await issueToken(rec.id, RESET_TTL_MS);
      await audit(rec.id, A.publicUser(rec), 'password-reset-requested');
    }
  } catch (_) {
    // Swallowed on purpose: a 500 here would also leak which addresses exist.
  }
  return A.reply(200, {
    ok: true,
    emailed: false,
    message: 'If that address has an account, an admin can now send a reset link. ' +
             'Password resets are not emailed automatically -- contact an OLH admin.'
  });
}

/** Best-effort audit row. Never fails the operation it is recording. */
async function audit(userId, user, action) {
  try {
    await A.createRecord(A.TABLES.audit, {
      'Entry Id': 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      'Record Id': userId,
      Field: 'Password Hash',
      Label: 'Password',
      From: '',
      To: '(set)',
      Action: action,
      Page: 'auth',
      'Changed By': (user && user.name) || '',
      'Changed By Id': userId,
      'Changed By Role': (user && user.role) || '',
      'Changed At': new Date().toISOString()
    });
  } catch (_) { /* ignore */ }
}

exports.handler = async (event) => {
  const seg = A.route(event, 'password');
  const action = (seg[0] || '').toLowerCase();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST' }), body: '' };
  }

  try {
    if (action === 'invite') {
      if (event.httpMethod === 'GET' && seg[1]) return await verifyInvite(event);
      if (event.httpMethod === 'POST') return await createInvite(event);
      return A.reply(405, { error: 'POST /api/invite or GET /api/invite/:token.' });
    }
    if (action === 'set-password') {
      if (event.httpMethod !== 'POST') return A.reply(405, { error: 'POST only.' });
      return await setPassword(event);
    }
    if (action === 'forgot-password') {
      if (event.httpMethod !== 'POST') return A.reply(405, { error: 'POST only.' });
      return await forgotPassword(event);
    }
    return A.reply(404, { error: 'Unknown password action: ' + (action || '(none)') });
  } catch (err) {
    return A.fail(err);
  }
};
