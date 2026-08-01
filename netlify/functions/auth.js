/**
 * Session lifecycle for the OLH Suite.
 *
 *   POST /api/sign-in   {email, password} -> {user, token}
 *                       409 {error, mustSetPassword:true, inviteToken} when the
 *                       account has never set a password.
 *   GET  /api/session   Authorization: Bearer <token> -> {user, can, roles}
 *   POST /api/sign-out  -> {ok:true}   (revokes every session for the account)
 *
 * Notes on the deliberate choices here:
 *
 * - Sign-in failures are one message. "No such account" and "wrong password"
 *   are indistinguishable to the caller, so the endpoint cannot be walked to
 *   enumerate who has an account.
 * - A wrong password still pays the scrypt cost, and an unknown email pays a
 *   dummy one, so response time does not separate the two cases either.
 * - Sign-out bumps Session Epoch rather than deleting anything, which
 *   invalidates the token on every device at once. The client discards its copy
 *   regardless of what this returns.
 */

'use strict';

const A = require('../lib/olh-auth');

// Burned on an unknown email so the timing matches a real verify.
const DUMMY_HASH =
  'scrypt$0000000000000000000000000000000000000000000000000000000000000000$' +
  '0000000000000000000000000000000000000000000000000000000000000000';

const SAME_FOR_BOTH = 'That email and password combination is not recognised.';

async function signIn(event) {
  const body = A.readJson(event);
  const email = A.normEmail(body.email);
  const password = String(body.password == null ? '' : body.password);

  if (!email || !password) {
    return A.reply(400, { error: 'Enter both an email address and a password.' });
  }

  const rec = await A.userByEmail(email);
  if (!rec) {
    await A.verifyPassword(password, DUMMY_HASH); // equalise timing
    return A.reply(401, { error: SAME_FOR_BOTH });
  }

  const user = A.publicUser(rec);
  const f = rec.fields || {};

  // A pending account is reported as itself, because the frontend keys its
  // set-password screen off mustSetPassword and a generic 401 would strand every
  // new user on "email and password not recognised" with nothing to do about it.
  //
  // Accepted cost: this makes sign-in an oracle for "that address has an OLH
  // account that has never been activated". It is a real leak and it is the one
  // place this endpoint is not enumeration-resistant. It is judged worth it --
  // lennar.com addresses follow firstname.lastname and are guessable without
  // help, so the marginal disclosure is account existence, not identity. If that
  // trade stops being acceptable, return SAME_FOR_BOTH here and the frontend
  // degrades to "this link has expired -- ask an admin", which is survivable.
  //
  // No token is minted and no existing invite is revealed either way: an admin
  // has to issue a fresh one, which is what POST /api/invite is for. Returning
  // inviteToken here -- which the frontend would happily use -- would let anyone
  // who knows an email address set that account's password.
  if (user.pending || !f['Password Hash']) {
    return A.reply(409, {
      error: 'This account still needs a password. Ask an admin for a new set-password link.',
      mustSetPassword: true
    });
  }

  if (!user.active) {
    // Checked after the password so a suspended account is not distinguishable
    // from an active one without the correct credentials.
    const ok = await A.verifyPassword(password, f['Password Hash']);
    return A.reply(ok ? 403 : 401, {
      error: ok ? 'Your account has been suspended. Ask an admin to reactivate it.' : SAME_FOR_BOTH
    });
  }

  const ok = await A.verifyPassword(password, f['Password Hash']);
  if (!ok) return A.reply(401, { error: SAME_FOR_BOTH });

  const matrix = await A.loadMatrix();
  const can = matrix[user.role] || [];
  if (can.indexOf('suite.view') < 0) {
    return A.reply(403, { error: A.DENY['suite.view'] });
  }

  const epoch = Number(f['Session Epoch'] || 0);
  const token = A.mintSession(rec.id, epoch);

  // Best effort: a failed timestamp write must not fail the sign-in.
  try { await A.updateRecord(A.TABLES.users, rec.id, { 'Last Sign In': new Date().toISOString() }); }
  catch (_) { /* ignore */ }

  return A.reply(200, { user, token, can, roles: matrix });
}

async function session(event) {
  const s = await A.requireSession(event);
  return A.reply(200, { user: s.user, can: s.can, roles: s.matrix });
}

async function signOut(event) {
  const token = A.bearer(event);
  const claim = token ? A.readSession(token) : null;
  if (claim) {
    try {
      const rec = await A.userById(claim.userId);
      if (rec) {
        const epoch = Number((rec.fields && rec.fields['Session Epoch']) || 0);
        await A.updateRecord(A.TABLES.users, rec.id, { 'Session Epoch': epoch + 1 });
      }
    } catch (_) {
      // The client clears its session either way; a failure here must not leave
      // the user looking signed in.
    }
  }
  return A.reply(200, { ok: true });
}

exports.handler = async (event) => {
  const action = (A.route(event, 'auth')[0] || '').toLowerCase();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, POST' }), body: '' };
  }

  try {
    if (action === 'sign-in') {
      if (event.httpMethod !== 'POST') return A.reply(405, { error: 'POST only.' });
      return await signIn(event);
    }
    if (action === 'session') {
      if (event.httpMethod !== 'GET') return A.reply(405, { error: 'GET only.' });
      return await session(event);
    }
    if (action === 'sign-out') {
      if (event.httpMethod !== 'POST') return A.reply(405, { error: 'POST only.' });
      return await signOut(event);
    }
    return A.reply(404, { error: 'Unknown auth action: ' + (action || '(none)') });
  } catch (err) {
    return A.fail(err);
  }
};
