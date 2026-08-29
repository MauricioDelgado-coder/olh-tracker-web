/**
 * The role -> permission matrix, and role creation.
 *
 *   GET  /api/roles                -> {roles:{admin:["suite.view",…],…}, perms}  [any session]
 *   PUT  /api/roles {roles}        -> {roles, perms}                            [roster.manage]
 *   POST /api/roles {label, slug?} -> {roles, perms, slug, label}               [roster.manage]
 *
 * GET is readable by any signed-in user because every page needs the matrix to
 * decide what to render; it names capabilities, not people, and hiding it would
 * only mean the UI guesses. PUT and POST are admin-only.
 *
 * The stored matrix is always run through normalizeMatrix first, which re-adds
 * Admin's suite.view + roster.manage and makes any editing permission imply
 * suite.view. That is what stops a saved grid from locking every admin out of
 * the console that edits the grid.
 *
 * Roles are no longer a fixed set of seven -- POST creates a new one (see
 * createRole in olh-auth.js), starting with only suite.view. PUT's unknown-role
 * check is against whatever createRole has produced plus the shipped seven
 * (A.knownRoleSlugs()), not just the original static DEFAULT_ROLES object, so a
 * newly created role's permissions can actually be saved through this same
 * endpoint once it exists.
 */

'use strict';

const A = require('../lib/olh-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, PUT, POST' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'GET') {
      const session = await A.requireSession(event);
      const labels = {};
      for (const slug of A.knownRoleSlugs()) labels[slug] = A.roleLabel(slug);
      return A.reply(200, { roles: session.matrix, perms: A.PERMS, labels });
    }

    if (event.httpMethod === 'PUT') {
      const session = await A.requireSession(event);
      A.requirePerm(session, 'roster.manage');

      const body = A.readJson(event);
      const next = body && body.roles;
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        return A.reply(400, { error: 'Send {roles:{<role>:[<permission>,…]}}.' });
      }

      const known = A.knownRoleSlugs();
      const unknown = Object.keys(next).filter((k) => known.indexOf(k) < 0);
      if (unknown.length) {
        return A.reply(400, { error: 'Unknown role: ' + unknown.join(', ') + '.' });
      }

      const roles = await A.saveMatrix(next, session.user.name);
      return A.reply(200, { roles, perms: A.PERMS });
    }

    if (event.httpMethod === 'POST') {
      const session = await A.requireSession(event);
      A.requirePerm(session, 'roster.manage');

      const body = A.readJson(event);
      const result = await A.createRole(body && body.label, body && body.slug, session.user.name);
      return A.reply(201, {
        roles: result.roles,
        perms: A.PERMS,
        slug: result.slug,
        label: result.label
      });
    }

    return A.reply(405, { error: 'GET, PUT, or POST only.' });
  } catch (err) {
    return A.fail(err);
  }
};
