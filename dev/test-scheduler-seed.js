/* Behavioural test for the scheduler seed()/bookings() fix.
 *
 * Lifts the four patched methods out of the built page and runs them against
 * a fake OLH_DATA, exercising the exact failure the fix targets: book a slot,
 * mutate OLH_DATA the way _commitPlan does, and assert the slot is no longer
 * offered.
 */
const fs = require('fs');
const path = '/Users/mauricio.delgado/olh-tracker-web/public/scheduler.html';
const raw = fs.readFileSync(path, 'utf8');
const OPEN = '<script type="__bundler/template">';
const start = raw.indexOf(OPEN) + OPEN.length;
const tpl = JSON.parse(raw.slice(start, raw.indexOf('</script>', start)));

function lift(name, sig) {
  const i = tpl.indexOf(sig);
  if (i < 0) throw new Error('could not find ' + name);
  // brace-match from the first { after the signature
  let j = tpl.indexOf('{', i), depth = 0, k = j;
  for (; k < tpl.length; k++) {
    if (tpl[k] === '{') depth++;
    else if (tpl[k] === '}') { depth--; if (!depth) break; }
  }
  return tpl.slice(i, k + 1);
}

const src = [
  lift('seed', '  seed() {'),
  lift('bookings', '  bookings() {'),
  lift('rosterIdForLink', '  rosterIdForLink(links) {'),
  lift('homeQams', '  homeQams(community) {')
].join('\n');

const HOURS = { QAI: 2, QAA: 1, CEL: 2, ACC: 1 };
const key = d => d;
const Harness = new Function('HOURS', 'key', `
  return class {
    constructor(sites, roster, draft) {
      this._sites = sites; this.state = { draft: draft || {}, assignments: {} };
      this._roster = roster;
    }
    homesites() { return this._sites; }
    roster() { return this._roster; }
    qams() { return this._roster.filter(p => p.role === 'QAM'); }
    slotOf(t) { return t ? t.slot : null; }
    ${src}
    dayHours(id, k, bk) { return bk.reduce((s,b) => s + (b.personId===id && b.date===k ? b.hours : 0), 0); }
    slotTaken(id, k, slot, bk) { return bk.some(b => b.personId===id && b.date===k && b.slot===slot); }
  };
`)(HOURS, key);

const roster = [
  { id: 'p1', name: 'Jeff Boyd', role: 'QAM', home: 'Wellness Ridge' },
  { id: 'p2', name: 'Kenny Calhoun', role: 'QAM', home: 'Wellness Ridge' },
  { id: 'p3', name: 'Tabatha Worden', role: 'QAM', home: 'Ranches' }
];
global.window = { OLH_DATA: { managers: [
  { id: 'recMgrJeff', name: 'Jeff Boyd' },
  { id: 'recMgrKenny', name: 'Kenny Calhoun' },
  { id: 'recMgrTab', name: 'Tabatha Worden' }
] } };

const site = (job, community, extra) => Object.assign({
  job, community, qai: null, qaa: null, cel: null, acc: null,
  celTime: null, accTime: null,
  qaiMgr: [], qaaMgr: [], celMgr: [], accMgr: []
}, extra);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : `\n          got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

// ---- 1. THE BUG: a saved walk must occupy its slot ------------------------
{
  const sites = [site('J1', 'Wellness Ridge')];
  const c = new Harness(sites, roster);
  check('slot free before booking',
    c.slotTaken('p1', '2026-08-25', '9:00 AM', c.bookings()), false);

  // _commitPlan mutates the job in OLH_DATA, then invalidates _sites, so
  // homesites() returns a NEW array. Reproduce exactly that.
  const booked = [site('J1', 'Wellness Ridge',
    { cel: '2026-08-25', celTime: { slot: '9:00 AM' }, celMgr: ['recMgrJeff'] })];
  c._sites = booked;
  check('slot TAKEN after booking (was the bug)',
    c.slotTaken('p1', '2026-08-25', '9:00 AM', c.bookings()), true);
}

// ---- 2. Attribution: the assigned manager, not the home-QAM guess ---------
{
  const sites = [site('J1', 'Wellness Ridge',
    { cel: '2026-08-25', celTime: { slot: '9:00 AM' }, celMgr: ['recMgrTab'] })];
  const c = new Harness(sites, roster);
  const bk = c.bookings();
  check('charged to the real assignee (Tabatha)', c.dayHours('p3', '2026-08-25', bk), 2);
  check('NOT charged to the home QAM (Jeff)', c.dayHours('p1', '2026-08-25', bk), 0);
}

// ---- 3. No double counting after a save -----------------------------------
{
  const sites = [site('J1', 'Wellness Ridge',
    { cel: '2026-08-25', celTime: { slot: '9:00 AM' }, celMgr: ['recMgrJeff'] })];
  const c = new Harness(sites, roster);
  c.state.assignments = { J1: { CEL: { personId: 'p1', date: '2026-08-25', slot: '9:00 AM', community: 'Wellness Ridge' } } };
  check('committed walk counted ONCE, not twice', c.dayHours('p1', '2026-08-25', c.bookings()), 2);
}

// ---- 4. Unsaved drafts still hold capacity --------------------------------
{
  const c = new Harness([site('J1', 'Wellness Ridge')], roster,
    { J1: { CEL: { personId: 'p2', date: '2026-08-26', slot: '12:00 PM', community: 'Wellness Ridge' } } });
  check('draft holds its slot', c.slotTaken('p2', '2026-08-26', '12:00 PM', c.bookings()), true);
}

// ---- 5. Unassigned walk keeps the home-QAM estimate (unchanged behaviour) --
{
  const sites = [site('J1', 'Wellness Ridge', { qai: '2026-08-25' })];
  const c = new Harness(sites, roster);
  check('unassigned still charged to a home QAM', c.dayHours('p1', '2026-08-25', c.bookings()), 2);
}

// ---- 6. Assigned walk in an unmapped community now counts -----------------
{
  const sites = [site('J1', null, { qai: '2026-08-25', qaiMgr: ['recMgrTab'] })];
  const c = new Harness(sites, roster);
  check('unanchored + assigned now counts (was dropped)',
    c.dayHours('p3', '2026-08-25', c.bookings()), 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
