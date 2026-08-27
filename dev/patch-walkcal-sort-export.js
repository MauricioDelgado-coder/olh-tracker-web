/**
 * Sort the walk-calendar Excel export by (effective) manager name before
 * mapping to rows. Effective manager mirrors what the export cell already
 * shows: the optimizer's proposed name if exporting the optimized plan,
 * else a manual edit if one was made, else the manager currently on the
 * walk.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const page = process.argv[2];
const APPLY = process.argv.includes('--apply');

const OLD_1 = '    const plan = useProposed ? this.proposedMap() : {};\n    const blob = window.buildXlsx({';
const NEW_1 = '    const plan = useProposed ? this.proposedMap() : {};\n' +
  '    const mgrOf = (r) => (plan[r.key] !== undefined ? plan[r.key]\n' +
  '      : this.state.edits[r.key] !== undefined ? this.state.edits[r.key] : r.manager) || "";\n' +
  '    const sortedRows = run.rows.slice().sort((a, b) => mgrOf(a).localeCompare(mgrOf(b)));\n' +
  '    const blob = window.buildXlsx({';

const OLD_2 = '      rows: run.rows.map(r => [\n';
const NEW_2 = '      rows: sortedRows.map(r => [\n';

const filePath = path.join(PUB, page);
const content = fs.readFileSync(filePath, 'utf8');

const marker = '<script type="__bundler/template">';
const i = content.indexOf(marker);
if (i === -1) throw new Error(page + ': no __bundler/template block found');
const jsonStart = i + marker.length;
const jsonEnd = content.indexOf('</script>', jsonStart);
const rawJson = content.slice(jsonStart, jsonEnd);
const template = JSON.parse(rawJson);

const roundTrip = JSON.stringify(template).replace(/<\//g, '<\\u002F');
if (roundTrip !== rawJson) throw new Error(page + ': round-trip encoding check FAILED. Aborting before any edit.');

for (const [label, old_] of [['OLD_1', OLD_1], ['OLD_2', OLD_2]]) {
  const occ = template.split(old_).length - 1;
  if (occ !== 1) throw new Error(page + ': ' + label + ' found ' + occ + ' times, expected exactly 1');
}

let newTemplate = template.split(OLD_1).join(NEW_1);
newTemplate = newTemplate.split(OLD_2).join(NEW_2);
const newRawJson = JSON.stringify(newTemplate).replace(/<\//g, '<\\u002F');

console.log(page + ': old template ' + template.length + ' chars -> new ' + newTemplate.length + ' chars');
console.log('Both insertion points verified unique. ' + (APPLY ? 'Applying...' : 'Dry run only (pass --apply to write).'));

if (APPLY) {
  if (content.indexOf(rawJson) === -1) throw new Error(page + ': raw JSON slice not found verbatim -- refusing to patch.');
  if (content.indexOf(rawJson) !== content.lastIndexOf(rawJson)) throw new Error(page + ': raw JSON slice not unique -- refusing to patch.');
  const patched = content.split(rawJson).join(newRawJson);
  fs.writeFileSync(filePath, patched);

  const verifyContent = fs.readFileSync(filePath, 'utf8');
  const vi = verifyContent.indexOf(marker);
  const vJsonStart = vi + marker.length;
  const vJsonEnd = verifyContent.indexOf('</script>', vJsonStart);
  const verifyTemplate = JSON.parse(verifyContent.slice(vJsonStart, vJsonEnd));
  for (const must of ['const sortedRows = run.rows.slice().sort((a, b) => mgrOf(a).localeCompare(mgrOf(b)));', 'rows: sortedRows.map(r => [']) {
    if (!verifyTemplate.includes(must)) throw new Error(page + ': verification FAILED -- missing "' + must + '" after write.');
  }
  console.log(page + ': patched and verified.');
}
