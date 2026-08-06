'use strict';

/**
 * Azure Functions entry point (Node.js v4 programming model).
 *
 * This file is the Azure translation of the `[[redirects]]` table in
 * netlify.toml -- the eleven account endpoints plus jobs, update-job and
 * walk-config. It is the ONLY copy of that mapping on this platform, so the
 * routes below and the ones in netlify.toml must stay in step. If you add an
 * endpoint, it goes in both.
 *
 * Static Web Apps mounts managed functions under /api, so a route of 'jobs'
 * answers at /api/jobs. That is the same public path the Netlify rewrite
 * produced, which matters more than it sounds: the front-end pages are bundled
 * documents whose fetch calls live inside gzip+base64 manifest assets. The API
 * paths are baked in. Serving them anywhere other than /api/* would mean
 * rebuilding all eight pages through dev/build-live-pages.js.
 *
 * ---- Why every route accepts every method -------------------------------
 *
 * The obvious version of this file pins each route to the methods it supports
 * -- jobs to GET, update-job to POST. Don't. Azure answers a disallowed method
 * with a platform 404, so `POST /api/jobs` would come back as an empty
 * not-found instead of jobs.js's own 405 "Method not allowed. This endpoint is
 * GET only." The handlers already dispatch on event.httpMethod and each has a
 * written 405; letting the platform pre-empt them replaces a legible error
 * with a misleading one and splits method policy across two files.
 *
 * OPTIONS is in the list for the same reason: the handlers answer it
 * themselves with a 204 and an Allow header.
 */

const { app } = require('@azure/functions');
const { azureHandler } = require('./netlify-adapter');

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * The handler modules are copied into _netlify/ by dev/build-azure-api.js
 * rather than committed here.
 *
 * Static Web Apps packages only the api_location folder, so a require reaching
 * up to ../netlify/functions would resolve on this laptop and be absent in the
 * deployed bundle -- the failure would appear as every endpoint 500ing after a
 * green deploy. The alternative, a second committed copy of the handlers, is
 * the drift this whole adapter exists to avoid. A generated, gitignored copy
 * with a freshness assertion in the build is the version that cannot silently
 * disagree with netlify/.
 */
function loader(name) {
  return () => require('../_netlify/functions/' + name + '.js').handler;
}

/**
 * [ azure function name, route template, netlify function file ]
 *
 * Route parameters ({token}, {id}) only steer the request to the right
 * function. The handlers re-derive their own segments from event.path via
 * olh-auth.route(), so the parameter names here are never read -- which is
 * what keeps this table from becoming a second, subtly different router.
 */
const ROUTES = [
  // ---- Data endpoints. All three require a session before any Airtable read.
  ['jobs', 'jobs', 'jobs'],
  ['updateJob', 'update-job', 'update-job'],
  ['walkConfig', 'walk-config', 'walk-config'],
  ['timeOff', 'time-off', 'time-off'],

  // ---- Session lifecycle -> auth.js
  ['signIn', 'sign-in', 'auth'],
  ['session', 'session', 'auth'],
  ['signOut', 'sign-out', 'auth'],

  // ---- Password lifecycle -> password.js
  //
  // Two routes, one function. On Netlify the ordering of the splat and the bare
  // rule mattered; here the templates are distinct, so it does not. password.js
  // resolves which action it is from event.path either way: GET with a token
  // segment verifies an invite, POST without one creates it.
  ['inviteCreate', 'invite', 'password'],
  ['inviteVerify', 'invite/{token}', 'password'],
  ['setPassword', 'set-password', 'password'],
  ['forgotPassword', 'forgot-password', 'password'],

  // ---- User administration -> users.js (all of it behind roster.manage)
  ['users', 'users', 'users'],
  ['userById', 'users/{id}', 'users'],

  // ---- Permission matrix -> roles.js
  ['roles', 'roles', 'roles'],

  // ---- Append-only change log -> audit.js
  ['audit', 'audit', 'audit']
];

for (const [name, route, netlifyFunction] of ROUTES) {
  app.http(name, {
    methods: ALL_METHODS,
    // The app's own session check is the boundary -- see the note in
    // netlify-adapter.js. 'anonymous' means Azure does not add a second,
    // different gate in front of it; it does not mean the endpoint is open.
    // Every data endpoint calls A.requireSession() before touching Airtable.
    authLevel: 'anonymous',
    route,
    handler: azureHandler(loader(netlifyFunction), netlifyFunction)
  });
}

module.exports = { ROUTES, ALL_METHODS };
