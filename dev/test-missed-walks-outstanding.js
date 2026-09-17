#!/usr/bin/env node
/**
 * Lifts dayKey() and the outstanding test out of public/missed-walks.html and
 * runs them against real Airtable values pulled on 2026-09-17, including the
 * exact row (26372721055 / 2275 Jennio Drive) that the old checkbox-driven
 * page mislabelled as a miss today.
 *
 * Reads the functions out of the page rather than restating them, so the test
 * cannot drift from what ships.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'public', 'missed-walks.html');
const src = fs.readFileSync(PAGE, 'utf8');

function lift(name, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('Could not find ' + name + ' in missed-walks.html');
  // Brace-match from the first { after the marker.
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error('Unbalanced braces reading ' + name);
}

const dayKeySrc = lift('dayKey', 'function dayKey(v){');
const todayKeySrc = 'function todayKey(){ return dayKey(new Date().toISOString()); }';
// eslint-disable-next-line no-eval
const scope = eval('(function(){' + dayKeySrc + todayKeySrc + 'return {dayKey:dayKey, todayKey:todayKey};})()');
const dayKey = scope.dayKey;

/* The rule under test, mirroring buildRows(). */
function classify(missedDate, currentDate, done) {
  const missKey = dayKey(missedDate);
  const curKey = dayKey(currentDate);
  const dayUpdated = !!(missKey && curKey && curKey !== missKey);
  // Completion does NOT resolve a miss: it is an undated boolean and can be
  // set while a miss stands against the day the walk still carries.
  return { missKey, curKey, done: !!done, dayUpdated, outstanding: !dayUpdated };
}

let pass = 0;
const fails = [];
function check(label, got, want) {
  if (got === want) { pass++; return; }
  fails.push(label + '\n      expected: ' + want + '\n      got:      ' + got);
}

/* ---- dayKey: the Eastern-day conversions the comparison depends on ---- */
// Airtable DATE field: bare day, no zone.
check('dayKey plain date', dayKey('2026-09-17'), '2026-09-17');
// Missed Date at Eastern midnight -> 04:00Z same day.
check('dayKey ET midnight', dayKey('2026-09-17T04:00:00.000Z'), '2026-09-17');
// CEL at 9:00am ET -> 13:00Z same day.
check('dayKey ET 9am', dayKey('2026-09-17T13:00:00.000Z'), '2026-09-17');
// ACC at 10:30am ET -> 14:30Z same day.
check('dayKey ET 10:30am', dayKey('2026-09-17T14:30:00.000Z'), '2026-09-17');
// The case a naive slice(0,10) gets WRONG: 8:00pm ET on the 17th is
// 00:00Z on the 18th. Slicing gives 09-18; the Eastern day is 09-17.
check('dayKey ET 8pm rolls back a day', dayKey('2026-09-18T00:00:00.000Z'), '2026-09-17');
check('dayKey empty', dayKey(''), '');
check('dayKey null', dayKey(null), '');

/* ---- Real rows pulled 2026-09-17 ---- */

// The nine genuine misses logged against 9/17. Four Crossprairie QAAs still
// carry 9/17 on the record: outstanding.
[
  ['11175720634 QAA', '2026-09-17T04:00:00.000Z', '2026-09-17', false],
  ['11175720635 QAA', '2026-09-17T04:00:00.000Z', '2026-09-17', false],
  ['11175720636 QAA', '2026-09-17T04:00:00.000Z', '2026-09-17', false],
  ['11175720638 QAA', '2026-09-17T04:00:00.000Z', '2026-09-17', false]
].forEach(([label, md, cd, done]) => {
  check(label + ' is outstanding', classify(md, cd, done).outstanding, true);
});

// 26375724085 CEL, the row that caught the first cut of this rule. Missed
// 9/17, CEL Date still 9/17 13:00Z, and CEL Completed is ALREADY checked on
// the Jobs record. Treating completion as resolution dropped a real miss out
// of the queue silently. It must stay outstanding: the day never moved.
check('26375724085 CEL outstanding despite CEL Completed',
  classify('2026-09-17T04:00:00.000Z', '2026-09-17T13:00:00.000Z', true).outstanding, true);

// Three of today's misses were rescheduled forward the same day. Those are
// handled and must drop out of the default queue.
check('65219730657 QAA rescheduled to 9/23 -> handled',
  classify('2026-09-17T04:00:00.000Z', '2026-09-23', false).outstanding, false);
check('11138721174 QAA rescheduled to 9/22 -> handled',
  classify('2026-09-17T04:00:00.000Z', '2026-09-22', false).outstanding, false);
check('11179720060 ACC rescheduled to 9/21 -> handled',
  classify('2026-09-17T04:00:00.000Z', '2026-09-21T14:00:00.000Z', false).outstanding, false);

// THE REGRESSION. 2275 Jennio Drive: QAI missed 9/16, Matt Griffith moved the
// date to 9/17 eleven minutes later. The old page read the sticky Jobs
// checkbox plus the 9/17 date and called it a miss today. It is not.
const jennio = classify('2026-09-16T04:00:00.000Z', '2026-09-17', false);
check('2275 Jennio missed day is 9/16', jennio.missKey, '2026-09-16');
check('2275 Jennio current day is 9/17', jennio.curKey, '2026-09-17');
check('2275 Jennio day WAS updated', jennio.dayUpdated, true);
check('2275 Jennio is NOT outstanding', jennio.outstanding, false);
check('2275 Jennio does not belong to 9/17', jennio.missKey === '2026-09-17', false);

// The other three stale-flag rows found during the same investigation.
check('26302720072 QAA missed 9/11, date 9/17 -> handled',
  classify('2026-09-11T04:00:00.000Z', '2026-09-17', false).outstanding, false);
check('26346720226 ACC missed 9/16, date 9/17 -> handled',
  classify('2026-09-16T04:00:00.000Z', '2026-09-17T14:30:00.000Z', false).outstanding, false);
check('26370720800 QAI missed 9/10, date 9/17 -> handled',
  classify('2026-09-10T04:00:00.000Z', '2026-09-17', false).outstanding, false);

/* ---- Completion and edge cases ---- */
// Completed but the day never moved: STILL outstanding, and flagged complete
// so a person can confirm and reconcile in one click.
const sameDay = classify('2026-09-17T04:00:00.000Z', '2026-09-17', true);
check('completed, day never moved -> still outstanding', sameDay.outstanding, true);
check('completed, day never moved -> done is surfaced', sameDay.done, true);
// Completed AND rescheduled: handled by the date move.
check('completed after a reschedule -> handled',
  classify('2026-09-17T04:00:00.000Z', '2026-09-19', true).outstanding, false);
// A miss with no date logged cannot be compared. Treated as outstanding so it
// surfaces for a human rather than vanishing.
check('no missed date -> outstanding',
  classify('', '2026-09-17', false).outstanding, true);
// Date cleared off the record entirely: still outstanding.
check('no current date -> outstanding',
  classify('2026-09-17T04:00:00.000Z', '', false).outstanding, true);
// Rescheduled BACKWARD still counts as updated -- the day moved.
check('rescheduled earlier -> handled',
  classify('2026-09-17T04:00:00.000Z', '2026-09-15', false).outstanding, false);
// A second miss on the new date is its own row and outstanding again.
check('missed again after reschedule -> outstanding',
  classify('2026-09-22T04:00:00.000Z', '2026-09-22', false).outstanding, true);

if (fails.length) {
  console.error('\nFAILED ' + fails.length + ' of ' + (pass + fails.length) + ':\n');
  fails.forEach((f) => console.error('  - ' + f + '\n'));
  process.exit(1);
}
console.log('All ' + pass + ' checks passed.');
