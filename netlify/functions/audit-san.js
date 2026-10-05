/**
 * The SAN change log. Same contract as audit.js (see that file), bound to the
 * Audit Log table in the SAN base. Sign-in is the shared OLH session.
 *
 *   POST /api/audit-san   GET /api/audit-san?recordId=rec...
 *
 * The SAN pages reach this through their fetch shim, which rewrites /api/audit
 * to /api/audit-san -- the bundled audit module itself is unchanged.
 */

'use strict';

const A = require('../lib/olh-auth');
const { makeAuditHandler } = require('../lib/audit-core');

exports.handler = makeAuditHandler(A.forBase(A.SAN_BASE_ID), A.SAN_TABLES.audit);
