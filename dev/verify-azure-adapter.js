#!/usr/bin/env node
'use strict';

/**
 * Assert the Azure adapter presents each handler with the same event Netlify
 * would have, and that the route table covers every endpoint netlify.toml does.
 *
 *     node dev/verify-azure-adapter.js
 *
 * ---- What this does and does not cover -----------------------------------
 *
 * It runs the real adapter over real fetch-API Request objects and checks the
 * translated event, and it runs the real route() from netlify/lib/olh-auth.js
 * over the paths those routes produce. No network, no Airtable, no @azure
 * runtime -- the handlers themselves are not invoked, because doing that
 * meaningfully needs a PAT and would write to the live base.
 *
 * The gap, stated rather than papered over: this proves the plumbing, not that
 * a signed-in read renders. That is the same manual pass verify-pages.sh
 * already documents. What it does catch is the class of failure that a green
 * deploy hides -- a path that resolves to the wrong segments, a header the
 * handlers index case-sensitively arriving capitalised, a body that reaches
 * readJson() base64-wrapped, a query string that arrives as an array.
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const adapter = require(path.join(ROOT, 'api', 'src', 'netlify-adapter.js'));
const A = require(path.join(ROOT, 'netlify', 'lib', 'olh-auth.js'));

const BASE = 'https://olh-tracker.example.net';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
  }
}

// Async checks are collected rather than fired and forgotten -- a harness that
// races its own report can pass by finishing early, which is worse than no
// harness. Every promise is awaited before anything is printed.
const pending = [];

function checkAsync(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => { passed += 1; },
        (err) => { failures.push({ name, message: err && err.message ? err.message : String(err) }); }
      )
  );
}

/** A real fetch Request, which is what Azure Functions v4 hands the handler. */
function request(method, urlPath, { headers, body } = {}) {
  const init = { method, headers: headers || {} };
  if (body != null) init.body = body;
  return new Request(BASE + urlPath, init);
}

/* -------------------------------------------------------------------------
 * 1. The route table matches netlify.toml
 * ---------------------------------------------------------------------- */

// Transcribed from the [[redirects]] blocks in netlify.toml. Kept as literal
// text rather than parsed out of the toml: the point is to notice when the two
// disagree, and a parser that reads one of them cannot do that.
const NETLIFY_ENDPOINTS = [
  ['/api/jobs', 'jobs'],
  ['/api/update-job', 'update-job'],
  ['/api/walk-config', 'walk-config'],
  ['/api/sign-in', 'auth'],
  ['/api/session', 'auth'],
  ['/api/sign-out', 'auth'],
  ['/api/invite', 'password'],
  ['/api/invite/:splat', 'password'],
  ['/api/set-password', 'password'],
  ['/api/forgot-password', 'password'],
  ['/api/users', 'users'],
  ['/api/users/:splat', 'users'],
  ['/api/roles', 'roles'],
  ['/api/audit', 'audit']
];

check('every netlify.toml endpoint has an Azure route', () => {
  // Read the table without loading @azure/functions, which is not installed
  // until the api/ deploy runs npm install.
  const source = require('fs').readFileSync(
    path.join(ROOT, 'api', 'src', 'index.js'), 'utf8'
  );
  const table = source.slice(source.indexOf('const ROUTES = ['), source.indexOf('];', source.indexOf('const ROUTES = [')));
  const declared = [];
  const re = /\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g;
  let m;
  while ((m = re.exec(table))) declared.push({ name: m[1], route: m[2], fn: m[3] });

  assert.strictEqual(
    declared.length, NETLIFY_ENDPOINTS.length,
    'netlify.toml declares ' + NETLIFY_ENDPOINTS.length + ' endpoints, api/src/index.js declares ' +
    declared.length + '. Add it to both or neither.'
  );

  const names = new Set(declared.map((d) => d.name));
  assert.strictEqual(names.size, declared.length, 'duplicate Azure function name in ROUTES');

  for (const [netlifyPath, fn] of NETLIFY_ENDPOINTS) {
    const wanted = netlifyPath.replace('/api/', '').replace(':splat', '');
    const hit = declared.find(
      (d) => d.fn === fn && d.route.replace(/\{[^}]+\}/g, '') === wanted
    );
    assert.ok(hit, 'no Azure route for ' + netlifyPath + ' -> ' + fn);
  }
});

/* -------------------------------------------------------------------------
 * 2. event.path resolves to the same segments Netlify produced
 *
 * This is the load-bearing one. olh-auth.route() is what turns a path into an
 * action, and it accepts both /api/x and /.netlify/functions/fn/x because a
 * Netlify rewrite leaves event.path as the original. Azure preserves /api, so
 * the same branch runs -- but "should" is not "does".
 * ---------------------------------------------------------------------- */

const ROUTE_CASES = [
  ['/api/jobs', 'jobs', []],
  ['/api/update-job', 'update-job', []],
  ['/api/walk-config', 'walk-config', []],
  ['/api/sign-in', 'auth', ['sign-in']],
  ['/api/session', 'auth', ['session']],
  ['/api/sign-out', 'auth', ['sign-out']],
  ['/api/invite', 'password', ['invite']],
  ['/api/invite/abc123def456', 'password', ['invite', 'abc123def456']],
  ['/api/set-password', 'password', ['set-password']],
  ['/api/forgot-password', 'password', ['forgot-password']],
  ['/api/users', 'users', []],
  ['/api/users/recABCDEFGHIJKLMN', 'users', ['recABCDEFGHIJKLMN']],
  ['/api/roles', 'roles', []],
  ['/api/audit', 'audit', []]
];

for (const [urlPath, fnName, expected] of ROUTE_CASES) {
  checkAsync('route(' + urlPath + ', "' + fnName + '") -> [' + expected.join(', ') + ']', async () => {
    const event = await adapter.toNetlifyEvent(request('GET', urlPath));
    assert.deepStrictEqual(A.route(event, fnName), expected);
  });
}

checkAsync('a percent-encoded segment is decoded, as route() intends', async () => {
  const event = await adapter.toNetlifyEvent(request('GET', '/api/invite/a%2Fb'));
  assert.deepStrictEqual(A.route(event, 'password'), ['invite', 'a/b']);
});

/*
 * The same cases with the /api prefix stripped.
 *
 * Static Web Apps mounts managed functions behind /api and the function host's
 * own routePrefix is also 'api', so request.url should arrive as /api/jobs.
 * "Should" was the only unverified assumption in this port, and it is the kind
 * that fails as a 404 on every endpoint after a deploy that looked fine.
 *
 * It turns out not to matter: route() skips a leading 'api' segment if there is
 * one and skips the function's own name if that is what it finds instead, so
 * both /api/users/rec123 and /users/rec123 resolve to ["rec123"]. Asserting it
 * here means the port does not depend on which one the platform sends, and a
 * future change to routePrefix cannot quietly break path resolution.
 */
for (const [urlPath, fnName, expected] of ROUTE_CASES) {
  const stripped = urlPath.replace(/^\/api/, '');
  checkAsync('prefix-stripped: route(' + stripped + ', "' + fnName + '") -> [' + expected.join(', ') + ']', async () => {
    const event = await adapter.toNetlifyEvent(request('GET', stripped));
    assert.deepStrictEqual(A.route(event, fnName), expected);
  });
}

/* -------------------------------------------------------------------------
 * 3. Headers arrive lowercase and plain
 *
 * password.siteUrl() reads h.host and h['x-forwarded-proto']; olh-auth.bearer()
 * reads h.authorization. A Headers instance passed through untranslated would
 * make all three undefined -- silently, producing invite links with no host and
 * a 401 on every authenticated call.
 * ---------------------------------------------------------------------- */

checkAsync('Authorization survives as event.headers.authorization', async () => {
  const event = await adapter.toNetlifyEvent(
    request('GET', '/api/session', { headers: { Authorization: 'Bearer tok.en.sig' } })
  );
  assert.strictEqual(event.headers.authorization, 'Bearer tok.en.sig');
  assert.strictEqual(A.bearer(event), 'tok.en.sig');
});

checkAsync('bearer() ignores a malformed Authorization rather than guessing', async () => {
  const event = await adapter.toNetlifyEvent(
    request('GET', '/api/session', { headers: { Authorization: 'tok.en.sig' } })
  );
  assert.strictEqual(A.bearer(event), '');
});

checkAsync('host and x-forwarded-proto are readable for invite links', async () => {
  const event = await adapter.toNetlifyEvent(
    request('POST', '/api/invite', {
      headers: { Host: 'olh.example.net', 'X-Forwarded-Proto': 'https' },
      body: '{}'
    })
  );
  assert.strictEqual(event.headers.host, 'olh.example.net');
  assert.strictEqual(event.headers['x-forwarded-proto'], 'https');
});

/* -------------------------------------------------------------------------
 * 4. Bodies reach readJson() intact
 * ---------------------------------------------------------------------- */

checkAsync('a JSON body parses', async () => {
  const payload = { id: 'recABCDEFGHIJKLMN', fields: { 'QA Ready': true } };
  const event = await adapter.toNetlifyEvent(
    request('POST', '/api/update-job', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  );
  assert.strictEqual(event.isBase64Encoded, false, 'request.text() already decoded the transport');
  assert.deepStrictEqual(A.readJson(event), payload);
});

checkAsync('no body reads as {} rather than throwing', async () => {
  const event = await adapter.toNetlifyEvent(request('POST', '/api/sign-out'));
  assert.strictEqual(event.body, null, 'Netlify sends null, and the handlers test falsiness');
  assert.deepStrictEqual(A.readJson(event), {});
});

checkAsync('malformed JSON still raises the tagged 400', async () => {
  const event = await adapter.toNetlifyEvent(
    request('POST', '/api/sign-in', { body: '{not json' })
  );
  assert.throws(() => A.readJson(event), (err) => err.statusCode === 400);
});

checkAsync('a body with unicode is not truncated or re-encoded', async () => {
  const payload = { fields: { Notes: 'Buyer said “no” — 12′ ceiling · café' } };
  const event = await adapter.toNetlifyEvent(
    request('POST', '/api/update-job', { body: JSON.stringify(payload) })
  );
  assert.deepStrictEqual(A.readJson(event), payload);
});

/* -------------------------------------------------------------------------
 * 5. Query strings match Netlify's flat-map shape
 * ---------------------------------------------------------------------- */

checkAsync('?refresh=1 busts the cache the way jobs.js checks for', async () => {
  const event = await adapter.toNetlifyEvent(request('GET', '/api/jobs?refresh=1'));
  assert.ok(event.queryStringParameters && event.queryStringParameters.refresh === '1');
});

checkAsync('no query string yields null, not {}', async () => {
  const event = await adapter.toNetlifyEvent(request('GET', '/api/jobs'));
  assert.strictEqual(event.queryStringParameters, null);
});

checkAsync('a repeated key collapses to the last value, as on Netlify', async () => {
  const event = await adapter.toNetlifyEvent(request('GET', '/api/audit?limit=10&limit=50'));
  assert.strictEqual(event.queryStringParameters.limit, '50');
});

/* -------------------------------------------------------------------------
 * 6. Method and response translation
 * ---------------------------------------------------------------------- */

checkAsync('httpMethod is upper-case, which every handler compares against', async () => {
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS']) {
    const event = await adapter.toNetlifyEvent(request(method, '/api/users'));
    assert.strictEqual(event.httpMethod, method);
  }
});

check('statusCode -> status, headers and body preserved', () => {
  const out = adapter.toAzureResponse({
    statusCode: 409,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ error: 'Set a password first.', mustSetPassword: true })
  });
  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.headers['Cache-Control'], 'no-store');
  assert.deepStrictEqual(JSON.parse(out.body), { error: 'Set a password first.', mustSetPassword: true });
});

check('a 204 keeps its headers and carries NO body property', () => {
  const out = adapter.toAzureResponse({ statusCode: 204, headers: { Allow: 'GET' }, body: '' });
  assert.strictEqual(out.status, 204);
  assert.strictEqual(out.headers.Allow, 'GET');
  // Regression test for a live-site 500. The handlers return `body: ''` with a
  // 204; passing that through made the Azure host answer OPTIONS /api/jobs with
  // an empty 500. '' is still a body to the host, so the property must be absent.
  assert.ok(!('body' in out), 'a 204 must not carry a body property at all');
});

check('a 304 is treated the same as a 204', () => {
  const out = adapter.toAzureResponse({ statusCode: 304, headers: {}, body: '' });
  assert.ok(!('body' in out));
});

check('a 200 with an empty body still sends one', () => {
  const out = adapter.toAzureResponse({ statusCode: 200, headers: {}, body: '' });
  assert.strictEqual(out.body, '');
});

check('A.fail() output translates to the status it tagged', () => {
  const err = new Error('Not signed in.');
  err.statusCode = 401;
  const out = adapter.toAzureResponse(A.fail(err));
  assert.strictEqual(out.status, 401, 'the auth boundary must not soften to a 200');
});

check('a handler returning nothing is a 500, never a silent 200', () => {
  assert.strictEqual(adapter.toAzureResponse(undefined).status, 500);
  assert.strictEqual(adapter.toAzureResponse(null).status, 500);
});

/* -------------------------------------------------------------------------
 * 7. staticwebapp.config.json covers every page and parses
 * ---------------------------------------------------------------------- */

check('staticwebapp.config.json is valid JSON under the 20 KB limit', () => {
  const file = path.join(ROOT, 'public', 'staticwebapp.config.json');
  const raw = require('fs').readFileSync(file);
  assert.ok(raw.length < 20 * 1024, 'config is ' + raw.length + ' bytes; SWA caps it at 20 KB');
  const config = JSON.parse(raw.toString('utf8'));
  assert.ok(Array.isArray(config.routes));
  assert.strictEqual(config.platform.apiRuntime, 'node:22');
  // A navigationFallback would answer 200 + index.html for every unknown path,
  // including /api typos, turning a 404 into a JSON parse error in the page.
  assert.ok(!config.navigationFallback, 'navigationFallback must stay unset');
});

check('every page in public/ has an extensionless rewrite', () => {
  const fs = require('fs');
  const config = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public', 'staticwebapp.config.json'), 'utf8')
  );
  const rewrites = new Map(
    config.routes.filter((r) => r.rewrite).map((r) => [r.route, r.rewrite])
  );

  const pages = fs.readdirSync(path.join(ROOT, 'public'))
    .filter((f) => f.endsWith('.html'))
    // index.html is served at / by the platform; 404.html only by
    // responseOverrides. Neither is linked to extensionless.
    .filter((f) => f !== 'index.html' && f !== '404.html');

  assert.ok(pages.length >= 9, 'expected the nine non-index pages, found ' + pages.length);

  for (const page of pages) {
    const route = '/' + page.replace(/\.html$/, '');
    assert.ok(
      rewrites.get(route) === '/' + page,
      'no rewrite for ' + route + ' -> /' + page +
      '. Azure does not serve extensionless .html implicitly, so every internal ' +
      'link to ' + route + ' would 404.'
    );
  }
});

/* The /tracker-new 301s were removed in the 2026-08-03 (evening) release, and
 * the assertion that used to guard their ordering went with them. What replaces
 * it is the inverse: nothing may reintroduce a prefix rule ahead of /tracker.
 *
 * Azure stops at the FIRST matching route, so any rule sitting above /tracker
 * that also matches "/tracker…" silently shadows it -- which is precisely why
 * the old 301s had to be ordered, and precisely the trap a future glob like
 * "/tracker*" would fall into. Cheaper to assert than to rediscover. */
check('no route shadows /tracker', () => {
  const config = JSON.parse(
    require('fs').readFileSync(path.join(ROOT, 'public', 'staticwebapp.config.json'), 'utf8')
  );
  const routes = config.routes.map((r) => r.route);
  const iTracker = routes.indexOf('/tracker');
  assert.ok(iTracker !== -1, 'no /tracker route at all');

  const shadow = routes.slice(0, iTracker).filter((r) =>
    r.endsWith('*') && '/tracker'.startsWith(r.slice(0, -1))
  );
  assert.deepStrictEqual(shadow, [],
    'these route(s) precede /tracker and also match it, so /tracker is dead: ' +
    shadow.join(', '));

  assert.ok(!routes.includes('/tracker-new'),
    '/tracker-new was retired in the 08-03 release; nothing links there any more. ' +
    'If it is back, dev/build-live-pages.js DESIGN_LINKS should be handling it at ' +
    'build time instead.');
});

/* homesite.html is not on the tile menu -- it is reached only from a job number,
 * via JOB_LINK() on seven pages. So no human clicks it during a smoke test of
 * the landing page, and a missing rewrite would 404 for every user who clicks a
 * job number while every page someone actually checks looks fine. */
check('/homesite is rewritten and never cached', () => {
  const config = JSON.parse(
    require('fs').readFileSync(path.join(ROOT, 'public', 'staticwebapp.config.json'), 'utf8')
  );
  const rule = config.routes.find((r) => r.route === '/homesite');
  assert.ok(rule, 'no /homesite route; every job-number link in the suite 404s');
  assert.strictEqual(rule.rewrite, '/homesite.html');
  assert.match(rule.headers['Cache-Control'], /no-store/,
    'homesite writes through /api/update-job; a cached bundle posts stale fields');
});

check('the private paths are blocked before anything can match them', () => {
  const config = JSON.parse(
    require('fs').readFileSync(path.join(ROOT, 'public', 'staticwebapp.config.json'), 'utf8')
  );
  for (const route of ['/netlify/*', '/dev/*', '/README.md', '/*.zip', '/staticwebapp.config.json']) {
    const rule = config.routes.find((r) => r.route === route);
    assert.ok(rule, 'no rule for ' + route);
    assert.strictEqual(rule.statusCode, 404, route + ' must 404, not merely be absent');
  }
});

/* ---------------------------------------------------------------------- */

(async () => {
  await Promise.all(pending);

  if (failures.length) {
    process.stderr.write('\n' + failures.length + ' FAILED\n');
    for (const f of failures) process.stderr.write('  ✗ ' + f.name + '\n      ' + f.message + '\n');
    process.stderr.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
    process.exit(1);
  }
  process.stdout.write(passed + ' checks passed.\n');
})();
