/* walkOptions() must emit Airtable record ids, and must resolve the real
 * roster against the real Managers table.
 *
 * Lifts walkOptions() out of the built page and runs it against fixtures taken
 * from the live tables (names verbatim), asserting every option value is a
 * rec… id and that the roster names actually join.
 */
const fs = require('fs');
const PAGE = '/Users/mauricio.delgado/olh-tracker-web/public/homesite.html';
const raw = fs.readFileSync(PAGE, 'utf8');
const OPEN = '<script type="__bundler/template">';
const start = raw.indexOf(OPEN) + OPEN.length;
const tpl = JSON.parse(raw.slice(start, raw.indexOf('</script>', start)));

const i = tpl.indexOf('  walkOptions(){');
let j = tpl.indexOf('{', i), d = 0, k = j;
for (; k < tpl.length; k++) {
  if (tpl[k] === '{') d++;
  else if (tpl[k] === '}') { d--; if (!d) break; }
}
const src = tpl.slice(i, k + 1);

/* Names verbatim from the live Walk Roster (tblhDm8OD4jSR0tey) and Managers
 * (tble8SiAKDLl7eS5D) tables. */
const QAMS = [
  ['Anthony Bullard', 'anthonybullard', 'Serenity @ Peace Creek', 'recCGvFrCe1kkFtHd'],
  ['Jeff Boyd', 'jeffboyd', 'Wellness Ridge', 'recfc390uG4GbkUdr'],
  ['Kenny Calhoun', 'kennycalhoun', 'Ranches', 'reccdERviVwJFQcXJ'],
  ["Kris O'Dell", 'krisodell', 'Westview', 'recLfDQF2RaKj2pru'],
  ['Justin Essigmann', 'justinessigmann', 'Sugarloaf', 'recC3UL4hpFWMTTMO'],
  ['Tabatha Worden', 'tabathaworden', 'Grove at Grenelefe', 'rec0oBA0guvNbXK3d']
];
/* On the roster, absent from Managers -- flagged as such in the roster's own
 * validation note. Must not be offered. */
const ORPHAN = ['Josh Allen', 'joshallen', ''];

global.window = {
  WALK_ROSTER: QAMS.map(([name, id, home]) => ({ id, name, role: 'QAM', home }))
    .concat([{ id: ORPHAN[1], name: ORPHAN[0], role: 'CCR', home: ORPHAN[2] }]),
  OLH_DATA: { managers: QAMS.map(([name, , , rec]) => ({ id: rec, name })) }
};

const C = new Function('return class { ' + src + ' };')();
const opts = new C().walkOptions();

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || !detail ? '' : '  ' + detail));
  ok ? pass++ : fail++;
};

const real = opts.filter((o) => o.v !== '');
check('unassigned option is first and empty', opts[0] && opts[0].v === '');
check('every value is an Airtable record id',
  real.every((o) => /^rec[A-Za-z0-9]{14}$/.test(o.v)),
  JSON.stringify(real.map((o) => o.v).filter((v) => !/^rec/.test(v))));
check('no roster Person Id leaked through',
  !real.some((o) => QAMS.some(([, pid]) => o.v === pid)));
check('all six QAMs resolved', real.length === 6, 'got ' + real.length);
check('Anthony Bullard maps to his Managers record',
  real.some((o) => o.v === 'recCGvFrCe1kkFtHd' && /Anthony Bullard/.test(o.l)));
check('roster person missing from Managers is omitted',
  !real.some((o) => /Josh Allen/.test(o.l)));
check('labels still carry role and home',
  real.every((o) => /QA Manager, /.test(o.l)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
