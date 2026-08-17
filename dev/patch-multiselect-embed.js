#!/usr/bin/env node
/**
 * dev/multiselect.js is injected VERBATIM as an outer-sibling <script>
 * block (same mechanism as SYNC_STAMP/LOADER) into every bundler page whose
 * PAGES[] entry sets `multiselect: true` -- currently tracker.html and
 * qa-management.html. Fixing the source alone doesn't touch those already
 * committed into public/*.html. This does a whole-block find/replace: the
 * OLD block is the exact last-committed dev/multiselect.js (via git show
 * HEAD), the NEW block is the current, edited working-tree copy. Refuses to
 * touch a file where the OLD block isn't found byte-for-byte intact.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const OLD = execSync('git show HEAD:dev/multiselect.js', { cwd: root, maxBuffer: 1024 * 1024 }).toString('utf8');
const NEW = fs.readFileSync(path.join(__dirname, 'multiselect.js'), 'utf8');

if (OLD === NEW) { console.log('no change between HEAD and working tree, nothing to do'); process.exit(0); }

const targets = ['public/tracker.html', 'public/qa-management.html', 'public/completion.html'];
for (const rel of targets) {
  const full = path.join(root, rel);
  const html = fs.readFileSync(full, 'utf8');
  const idx = html.indexOf(OLD);
  if (idx === -1) { console.log(rel + ': SKIP, exact old block not found'); continue; }
  const before = html.slice(0, idx);
  const after = html.slice(idx + OLD.length);
  const newHtml = before + NEW + after;
  if (newHtml.indexOf(OLD) !== -1) { console.log(rel + ': FAILED, old block still present'); continue; }
  if (newHtml.indexOf(NEW) === -1) { console.log(rel + ': FAILED, new block not present after write'); continue; }

  fs.copyFileSync(full, path.join(__dirname, 'fix-backup', 'multiselect-embed-' + path.basename(rel)));
  fs.writeFileSync(full, newHtml);
  console.log(rel + ': PATCHED (' + OLD.length + ' -> ' + NEW.length + ' bytes)');
}
