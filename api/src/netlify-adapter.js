'use strict';

/**
 * Netlify Function -> Azure Function adapter.
 *
 * The eight handlers in netlify/functions are the only place the API's rules
 * live: the 26-key editable whitelist, the per-field capability checks, the
 * scrypt password policy, the stateless-HMAC session. Rewriting them against
 * the Azure HttpRequest shape would fork all of that, and a fork of an auth
 * boundary is the kind of duplicate that drifts silently -- the copy keeps
 * working while it slowly stops meaning the same thing.
 *
 * So nothing in netlify/ changes. This module translates in both directions:
 *
 *   Azure HttpRequest  ->  the Netlify `event` object the handlers expect
 *   { statusCode, headers, body }  ->  Azure HttpResponseInit
 *
 * The site stays deployable to Netlify and Azure from one source tree, which
 * also means the Azure cutover is reversible.
 *
 * ---- What the handlers actually read off `event` -------------------------
 *
 * Deliberately enumerated, because this is the whole contract and it is small:
 *
 *   event.httpMethod            every handler, for method dispatch
 *   event.path                  olh-auth.route(), to resolve /api/users/rec123
 *   event.headers               olh-auth.bearer() and password.siteUrl()
 *   event.body                  olh-auth.readJson()
 *   event.isBase64Encoded       olh-auth.readJson(), update-job
 *   event.queryStringParameters jobs (?refresh=1), walk-config, audit
 *
 * Nothing reads the second `context` argument -- verified by grep before this
 * was written -- but one is passed anyway so a handler that starts using
 * Netlify's shape fails on a missing property rather than on a missing object.
 *
 * ---- The adapter translates; it does not police --------------------------
 *
 * No body size cap, no method filtering, no header rewriting here. Every one
 * of those is already a decision made inside a handler with a specific error
 * message attached -- update-job caps bodies at 64 KB and says so, jobs.js
 * answers 405 with "This endpoint is GET only." An adapter that enforced its
 * own version of those rules would answer differently on Azure than on
 * Netlify for exactly the malformed requests you most want to be legible.
 */

/**
 * Azure hands over a fetch-API `Headers`; the handlers index a plain object
 * and do it case-sensitively in places (`h.host`, `h['x-forwarded-proto']`,
 * `h.authorization`). Netlify lowercases every incoming key, so match that.
 * `Headers` iteration already yields lowercase keys -- the explicit
 * toLowerCase is for the plain-object branch, which is what the local test
 * harness passes in.
 */
function toPlainHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) out[String(key).toLowerCase()] = value;
    return out;
  }
  for (const key of Object.keys(headers)) out[String(key).toLowerCase()] = headers[key];
  return out;
}

/**
 * Netlify's `queryStringParameters` is a flat string map where a repeated key
 * keeps the LAST value. URLSearchParams keeps them all, so collapse the same
 * way rather than handing a handler an array it will compare against '1'.
 *
 * Netlify sends `null` when there is no query string at all, and jobs.js leans
 * on that (`event.queryStringParameters && ...`). An empty object would also
 * be falsy-safe there, but null is what the handlers were written against.
 */
function toQueryStringParameters(searchParams) {
  const keys = Array.from(searchParams.keys());
  if (keys.length === 0) return null;
  const out = {};
  for (const key of keys) {
    // NOT searchParams.get(), which returns the FIRST value. Netlify Functions
    // run on Lambda, whose queryStringParameters keeps the LAST occurrence of a
    // repeated key. Caught by dev/verify-azure-adapter.js, which is the only
    // reason this comment exists rather than a one-character difference in
    // behaviour nobody would have found.
    const all = searchParams.getAll(key);
    out[key] = all[all.length - 1];
  }
  return out;
}

/**
 * Build the Netlify event.
 *
 * `path` comes from the request URL, which is what makes olh-auth.route()
 * work untouched. On Netlify a rewrite leaves event.path as the ORIGINAL
 * request path -- /api/sign-in, not /.netlify/functions/auth/sign-in -- and
 * route() is written to accept both. Azure preserves the /api prefix in
 * request.url, so it lands on the same branch of route() and resolves
 * identically: /api/users/rec123 -> ["rec123"], /api/invite/tok -> ["invite",
 * "tok"]. Route templates with parameters are therefore never consulted here;
 * they exist only to get the request to the right function.
 */
async function toNetlifyEvent(request) {
  const url = new URL(request.url);

  // '' means "the client sent no body". readJson() checks `if (!event.body)`
  // so either value works, but Netlify sends null and the handlers were
  // written and tested against null.
  let body = null;
  try {
    const raw = await request.text();
    if (raw !== '' && raw != null) body = raw;
  } catch (_) {
    body = null;
  }

  return {
    httpMethod: String(request.method || 'GET').toUpperCase(),
    path: url.pathname,
    rawUrl: request.url,
    rawQuery: url.search.replace(/^\?/, ''),
    headers: toPlainHeaders(request.headers),
    queryStringParameters: toQueryStringParameters(url.searchParams),
    body,
    // request.text() already decoded the transport, so the string handed to
    // readJson() is never base64. Saying so explicitly keeps the base64 branch
    // in readJson() and update-job from firing on a body that isn't encoded.
    isBase64Encoded: false
  };
}

/** Netlify's { statusCode, headers, body } -> Azure's { status, headers, body }. */
function toAzureResponse(result) {
  if (!result || typeof result !== 'object') {
    // A handler that returns nothing is a bug in the handler, not a 200.
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      jsonBody: { error: 'The handler returned no response.' }
    };
  }
  return {
    status: result.statusCode || 200,
    headers: result.headers || {},
    body: result.body == null ? '' : String(result.body)
  };
}

/**
 * Wrap one Netlify handler as an Azure handler.
 *
 * The catch is a backstop, not the error path: every handler already ends in
 * `catch (err) { return A.fail(err); }`, which maps a tagged error to its real
 * status. Reaching this catch means the failure happened outside that -- while
 * reading the body, or in a handler's own top-level code -- and the reply is
 * deliberately opaque, because an unplanned throw is the case most likely to
 * carry a token or an Airtable id in its message.
 */
function azureHandler(loadHandler, label) {
  return async function handler(request, context) {
    let event;
    try {
      event = await toNetlifyEvent(request);
    } catch (err) {
      context.error(label + ': could not read the request', err);
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        jsonBody: { error: 'The request could not be read.' }
      };
    }

    try {
      const netlifyHandler = loadHandler();
      const result = await netlifyHandler(event, {
        // Netlify's shape. Nothing reads it today; present so that if a
        // handler ever does, it finds the field rather than crashing on the
        // object. Azure's own identity story is not wired up: this app
        // authenticates with its own session tokens, checked inside the
        // handlers, so there is no Static Web Apps principal to surface here.
        clientContext: null,
        functionName: label
      });
      return toAzureResponse(result);
    } catch (err) {
      context.error(label + ': unhandled error', err);
      return {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow'
        },
        jsonBody: { error: 'Server error.' }
      };
    }
  };
}

module.exports = {
  azureHandler,
  toNetlifyEvent,
  toAzureResponse,
  toPlainHeaders,
  toQueryStringParameters
};
