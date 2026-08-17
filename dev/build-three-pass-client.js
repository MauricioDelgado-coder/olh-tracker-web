#!/usr/bin/env node
/* Regenerates dev/three-pass-scheduler-client.js from
 * dev/three_pass_scheduler_logic.js.
 * The two files must never diverge -- the Node module is the single source
 * of truth (used by any script/tests), and the browser build is a
 * mechanical wrapper around the exact same class body, exposed as
 * window.OLHThreePassScheduler for workload.html and walk-calendar.html.
 *
 * Run this any time three_pass_scheduler_logic.js changes:
 *   node dev/build-three-pass-client.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'three_pass_scheduler_logic.js');
const OUT = path.join(__dirname, 'three-pass-scheduler-client.js');

const src = fs.readFileSync(SRC, 'utf8');
const body = src.replace(/module\.exports = \{[\s\S]*?\};\s*$/, '').trimEnd();

const wrapped =
  '/* Browser build of dev/three_pass_scheduler_logic.js -- generated, do\n' +
  ' * not hand-edit. Run `node dev/build-three-pass-client.js` after\n' +
  ' * changing the logic module to regenerate this file. Exposes the exact\n' +
  ' * same class as window.OLHThreePassScheduler for pages that need\n' +
  ' * three-pass walk scheduling (workload.html, walk-calendar.html). */\n' +
  '(function () {\n' +
  "  'use strict';\n" +
  body.split('\n').map(l => '  ' + l).join('\n') + '\n\n' +
  '  window.OLHThreePassScheduler = {\n' +
  '    HOURS_BY_TYPE, DEFAULT_CAP, INITIAL_LEG_CAP, REBALANCE_LEG_CAP, TIME_ORDER,\n' +
  '    ThreePassScheduler\n' +
  '  };\n' +
  '})();\n';

fs.writeFileSync(OUT, wrapped);
console.log('wrote', OUT, '(' + wrapped.length + ' bytes)');
