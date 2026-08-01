#!/usr/bin/env node
/**
 * Create the first Admin account and print one set-password link.
 *
 *   AIRTABLE_PAT=pat… SITE_URL=https://dynamics2olh.netlify.app \
 *     node dev/seed-admin.js "Mauricio Delgado" mauricio.delgado@lennar.com
 *
 * This is a local, one-off script and deliberately NOT an endpoint. The
 * alternative -- an ADMIN_EMAIL env var that auto-creates an admin on first
 * sign-in -- would be a permanent code path in production that mints a
 * privileged account without one already existing. Something that only ever
 * needs to happen once should not ship.
 *
 * Re-running it on an existing email issues a FRESH invite rather than creating
 * a duplicate or resetting anything else, so a lost first link is recoverable.
 *
 * It writes only to the Users table, and it prints the raw token exactly once:
 * only its SHA-256 is stored, so a lost link cannot be recovered, only reissued.
 */
'use strict';

const crypto = require('crypto');

const BASE_ID = 'appYX9df4lGO6G2uz';
const USERS_TABLE = 'tblTesJj3P7BSiErH';
const AIRTABLE_API = 'https://api.airtable.com/v0';
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

const [name, email] = process.argv.slice(2);
const PAT = process.env.AIRTABLE_PAT;
const SITE = String(process.env.SITE_URL || 'https://dynamics2olh.netlify.app').replace(/\/+$/, '');

const die = (m) => { console.error('\n  ' + m + '\n'); process.exit(1); };

if (!name || !email) die('usage: node dev/seed-admin.js "<Full Name>" <email>');
if (!PAT) die('AIRTABLE_PAT is not set. Run: AIRTABLE_PAT=$(netlify env:get AIRTABLE_PAT) node dev/seed-admin.js …');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die('That does not look like an email address: ' + email);

const b64url = (b) => Buffer.from(b).toString('base64')
  .split('+').join('-').split('/').join('_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

async function airtable(method, suffix, body) {
  const res = await fetch(AIRTABLE_API + '/' + BASE_ID + suffix, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + PAT },
      body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) die('Airtable ' + res.status + ' on ' + method + ' ' + suffix + '\n  ' + text.slice(0, 400));
  return text ? JSON.parse(text) : null;
}

(async () => {
  const lower = email.trim().toLowerCase();
  const q = new URLSearchParams({
    filterByFormula: 'LOWER({Email}) = "' + lower.split('"').join('\\"') + '"',
    maxRecords: '1'
  });
  const found = await airtable('GET', '/' + USERS_TABLE + '?' + q.toString());
  const existing = (found.records || [])[0];

  const token = b64url(crypto.randomBytes(32));
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const invite = {
    'Invite Token Hash': sha256(token),
    'Invite Expires': expiresAt
  };

  let rec;
  if (existing) {
    console.log('\n  ' + lower + ' already exists — issuing a fresh invite, changing nothing else.');
    rec = await airtable('PATCH', '/' + USERS_TABLE + '/' + existing.id, { fields: invite, typecast: true });
  } else {
    rec = await airtable('POST', '/' + USERS_TABLE, {
      fields: Object.assign({
        Name: name,
        Email: lower,
        Role: 'Admin',
        Division: 'Central Florida',
        Active: true,
        Pending: true,
        'Password Hash': '',
        'Session Epoch': 0
      }, invite),
      typecast: true
    });
    console.log('\n  Created ' + lower + ' as Admin.');
  }

  console.log('\n  Set your password with this link (valid 24h, single use):\n');
  console.log('  ' + SITE + '/?invite=' + encodeURIComponent(token));
  console.log('\n  Password must be 12+ characters with upper and lowercase, a number and a symbol.');
  console.log('  The link is not stored anywhere — only its hash. If you lose it, re-run this script.');
  console.log('\n  Airtable record: ' + rec.id + '\n');
})().catch((e) => die(e && e.message ? e.message : String(e)));
