/**
 * The role -> permission matrix.
 *
 *   GET /api/roles        -> {roles:{admin:["suite.view",…],…}}   [any session]
 *   PUT /api/roles {roles} -> {roles}                              [roster.manage]
 *
 * GET is readable by any signed-in user because every page needs the matrix to
 * decide what to render; it names capabilities, not people, and hiding it would
 * only mean the UI guesses. PUT is admin-only.
 *
 * The stored matrix is always run through normalizeMatrix first, which re-adds
 * Admin's suite.view + roster.manage and makes any editing permission imply
 * suite.view. That is what stops a saved grid from locking every admin out of
 * the console that edits the grid.
 */

'use strict';

const A = require('../lib/olh-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, A.JSON_HEADERS, { Allow: 'GET, PUT' }),
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'GET') {
      const session = await A.requireSession(event);
      return A.reply(200, { roles: session.matrix, perms: A.PERMS });
    }

    if (event.httpMethod === 'PUT') {
      const session = await A.requireSession(event);
      A.requirePerm(session, 'roster.manage');

      const body = A.readJson(event);
      const next = body && body.roles;
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        return A.reply(400, { error: 'Send {roles:{<role>:[<permission>,…]}}.' });
      }

      const unknown = Object.keys(next).filter((k) => !A.DEFAULT_ROLES[k]);
      if (unknown.length) {
        return A.reply(400, { error: 'Unknown role: ' + unknown.join(', ') + '.' });
      }

      const roles = await A.saveMatrix(next, session.user.name);
      return A.reply(200, { roles, perms: A.PERMS });
    }

    return A.reply(405, { error: 'GET or PUT only.' });
  } catch (err) {
    return A.fail(err);
  }
};
