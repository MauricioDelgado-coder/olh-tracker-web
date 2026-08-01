#!/usr/bin/env node
/**
 * Dump each bundle's template payload to a file and report its mount surface,
 * so graft points can be chosen per page.
 *
 *   node dev/dump-templates.js <folder> <outdir>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const [DIR, OUT] = process.argv.slice(2);
if (!DIR || !OUT) { console.error('usage: node dev/dump-templates.js <folder> <outdir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.html')).sort()) {
  const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
  const i = lines.findIndex((l) => l.includes('<script type="__bundler/template">'));
  if (i === -1) { console.log(f + ': no template'); continue; }
  const tpl = JSON.parse(lines[i + 1]);
  const out = path.join(OUT, f.replace(/\.html$/, '.template.html'));
  fs.writeFileSync(out, tpl);

  console.log('\n=== ' + f + '  template ' + (tpl.length / 1024).toFixed(0) + ' KB -> ' + path.basename(out));

  const show = (label, re) => {
    const m = [...tpl.matchAll(re)].map((x) => x[0].replace(/\s+/g, ' ').slice(0, 90));
    console.log('  ' + label.padEnd(22) + (m.length ? m.length + '  ' + [...new Set(m)].slice(0, 4).join(' | ') : '0'));
  };
  show('class X extends', /class\s+\w+\s+extends\s+[\w.]+/g);
  show('componentDidMount', /componentDidMount\s*\(\s*\)\s*\{/g);
  show('useEffect', /useEffect\s*\(/g);
  show('function App', /function\s+App\w*\s*\(/g);
  show('createRoot/render', /ReactDOM\.(createRoot|render)|\.render\s*\(/g);
  show('state =', /state\s*=\s*\{/g);
  show('useState', /useState\s*\(/g);
  show('window.OLH_DATA read', /window\.OLH_DATA/g);
  show('WALK_ globals', /window\.WALK_[A-Z_]+/g);
  show('COMPLETION_DATA', /window\.COMPLETION_DATA/g);
  show('data-props', /data-props="\{[^"]{0,60}/g);
}
