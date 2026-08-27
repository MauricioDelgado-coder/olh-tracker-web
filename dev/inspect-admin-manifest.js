#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const filePath = path.join(__dirname, '..', 'public', 'admin.html');
const content = fs.readFileSync(filePath, 'utf8');

const marker = '<script type="__bundler/manifest">';
const mi = content.indexOf(marker);
if (mi === -1) throw new Error('no __bundler/manifest block found');
const mJsonEnd = content.indexOf('</script>', mi + marker.length);
const manifest = JSON.parse(content.slice(mi + marker.length, mJsonEnd));

console.log('admin.html manifest has ' + Object.keys(manifest).length + ' assets total.\n');

for (const uuid of Object.keys(manifest)) {
  const entry = manifest[uuid];
  if (!entry.mime || !/javascript/i.test(entry.mime)) continue;
  let text;
  try {
    const buf = Buffer.from(entry.data, 'base64');
    text = entry.compressed ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  } catch (e) { continue; }

  const hasPagesArray = text.includes('key: "page.completion"') && text.includes('key: "page.walks"');
  const hasAuthModule = text.includes('ROLE_ALIAS') && text.includes('OLHSignIn');
  if (!hasPagesArray && !hasAuthModule) continue;

  console.log('UUID ' + uuid + '  (' + text.length + ' chars)');
  console.log('  is OLHAuth session module: ' + hasAuthModule);
  console.log('  has a PAGES array (page.completion/page.walks): ' + hasPagesArray);
  if (hasPagesArray) {
    console.log('  includes page.redflags: ' + text.includes('page.redflags'));
    console.log('  includes page.bonus: ' + text.includes('page.bonus'));
  }
  console.log('');
}
