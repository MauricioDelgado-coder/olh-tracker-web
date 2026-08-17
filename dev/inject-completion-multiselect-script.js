#!/usr/bin/env node
/**
 * completion.html never had `multiselect: true` in build-live-pages.js's
 * PAGES[], so it never received the outer-sibling <script> that defines
 * <olh-multiselect> -- the template patch (add-completion-multiselect.js)
 * added markup/JS that REFERENCES the element, but not its definition.
 * Inserts the exact same block tracker.html/qa-management.html carry, in
 * the same position: right after the sync-stamp script's closing tag and
 * right before the __bundler/manifest script.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public', 'tracker.html'), 'utf8');
const startTag = '<script>\n/* Shared multi-select filter dropdown';
const startIdx = src.lastIndexOf('<script>', src.indexOf(startTag) + 1);
const endIdx = src.indexOf('</script>', startIdx) + '</script>'.length;
const block = src.slice(startIdx, endIdx);
if (!block.startsWith('<script>\n/* Shared multi-select') || !block.endsWith('})();\n</script>')) {
  throw new Error('unexpected block boundaries when extracting from tracker.html');
}

const target = path.join(root, 'public', 'completion.html');
const html = fs.readFileSync(target, 'utf8');
const marker = "customElements.define('olh-sync-stamp', OlhSyncStampEl);\n})();\n</script>\n\n";
const idx = html.indexOf(marker);
if (idx === -1) throw new Error('sync-stamp closing marker not found in completion.html');
if (html.includes('OlhMultiselect extends HTMLElement')) throw new Error('completion.html already has multiselect.js embedded');

const insertAt = idx + marker.length;
const newHtml = html.slice(0, insertAt) + block + '\n\n' + html.slice(insertAt);

fs.copyFileSync(target, path.join(__dirname, 'fix-backup', 'completion-pre-multiselect-script.html'));
fs.writeFileSync(target, newHtml);
console.log('completion.html: injected multiselect.js block (' + block.length + ' bytes) after sync-stamp script');
