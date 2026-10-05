/**
 * The append-only change log.
 *
 *   POST /api/audit {recordId, job, field, label, from, to, action, page}
 *        -> {entry, conflict?:{by,at,value}}
 *   GET  /api/audit?recordId=rec…[&field=…][&since=ISO] -> {entries:[…]}
 *
 * Three things are deliberate:
 *
 * 1. "Changed By" and "Changed At" are taken from the session and the server
 *    clock, never from the body. A client that could name someone else as the
 *    author would make the log worth less than no log.
 * 2. Entry Id is an idempotency key. The tracker retries on a flaky connection,
 *    and a retry must not append a second row saying the same change happened
 *    twice.
 * 3. conflict is computed on the way in: if somebody else already changed this
 *    field after the timestamp the caller is working from, the response says so
 *    and the tracker can warn instead of silently overwriting.
 */

'use strict';

const A = require('../lib/olh-auth');
const { makeAuditHandler } = require('../lib/audit-core');

exports.handler = makeAuditHandler(A, A.TABLES.audit);
