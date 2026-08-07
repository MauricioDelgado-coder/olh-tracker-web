#!/usr/bin/env node
/* Regenerates dev/route-optimizer-client.js from dev/route_constrained_optimizer_logic.js.
 * The two files must never diverge -- the Node module is the single source of
 * truth (used by the background job / tests), and the browser build is a
 * mechanical wrapper around the exact same function bodies, exposed as
 * window.OLHRouteOptimizer for workload.html and walk-calendar.html.
 *
 * Run this any time route_constrained_optimizer_logic.js changes:
 *   node dev/build-route-optimizer-client.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'route_constrained_optimizer_logic.js');
const OUT = path.join(__dirname, 'route-optimizer-client.js');

const src = fs.readFileSync(SRC, 'utf8');
const body = src.replace(/module\.exports = \{[\s\S]*?\};\s*$/, '').trimEnd();

const wrapped =
  '/* Browser build of dev/route_constrained_optimizer_logic.js -- generated, do\n' +
  ' * not hand-edit. Run `node dev/build-route-optimizer-client.js` after\n' +
  ' * changing the logic module to regenerate this file. Exposes the exact same\n' +
  ' * functions as window.OLHRouteOptimizer for pages that need route-\n' +
  ' * constrained candidate selection (workload.html, walk-calendar.html). */\n' +
  '(function () {\n' +
  "  'use strict';\n" +
  body.split('\n').map(l => '  ' + l).join('\n') + '\n\n' +
  '  window.OLHRouteOptimizer = {\n' +
  '    MAX_LEG_MINUTES, MAX_BETWEEN_MINUTES, WORKLOAD_MAX_LEG_MINUTES, BACKGROUND_LOOKAHEAD_DAYS,\n' +
  '    buildRoute, worstLeg, betweenOk, routeFeasible, canAddStop, homeAffinity, rankCandidates,\n' +
  '    rebalanceWorkload, findSingleCommunityConsolidations, nextBusinessDay, isInBackgroundScope,\n' +
  '    isLocked, LOCK_FIELD_BY_CODE\n' +
  '  };\n' +
  '})();\n';

fs.writeFileSync(OUT, wrapped);
console.log('wrote', OUT, '(' + wrapped.length + ' bytes)');
