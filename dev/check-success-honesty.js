#!/usr/bin/env node
/**
 * Assert that no page claims a save succeeded without having waited for the
 * server to say so.
 *
 *   node dev/check-success-honesty.js [public-dir]
 *
 * WHY THIS EXISTS
 *
 * The companion to dev/check-error-visibility.js. That one asks "if this
 * fails, can the person see it?"; this one asks the harder-hitting question,
 * "if this fails, will the page claim it worked anyway?"
 *
 * homesite.html on 2026-08-21 is the case. commit() ended:
 *
 *     if (this.state.live) { this.persist(rec, field, value, prev); return; }
 *     this.flash('Saved');
 *
 * state.live is set by loadLive(), which was fetching /api without an
 * Authorization header and so always 401'd. live stayed false, the persist
 * branch was never taken, and every edit fell through to an unconditional
 * flash('Saved'). Nothing was written to Airtable and the page said Saved.
 *
 * The audit log recorded those edits too, so the homesite history asserted
 * changes that never happened. A save that lies is worse than a save that
 * fails loudly, because it destroys trust in every other row on the page.
 *
 * WHAT IT CHECKS
 *
 * Per page, per method: find anything that reports success to the person --
 * flash('Saved'), toast('ok', …), saved:true, a msg/mWarn containing "saved"
 * -- and require that the same method awaited a network call BEFORE it. A
 * success report with no preceding await in its own method is reporting an
 * outcome it never observed.
 *
 * This is deliberately a shallow, syntactic rule. It cannot follow a promise
 * into a callback, so a method that legitimately reports success from a .then()
 * belongs in KNOWN_SAFE with the reason. False positives are cheap to
 * annotate; the failure it prevents cost a day.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = process.argv[2] || 'public';
const TPL_RE = /<script[^>]*type="__bundler\/template"[^>]*>([\s\S]*?)<\/script>/;

/* 'page.html::method' -> why reporting success without a local await is right. */
const KNOWN_SAFE = {
  /* Reports from inside .then() on a promise it returned; the await is in the
     caller, which this shallow scan cannot follow. */
  'admin.html::saveMatrix': 'success is reported from .then() on the PUT promise',

  /* Design-preview paths. These run only when the API is absent entirely
     (state.demo / no OLHAuth), where "saved" means "held in this browser" and
     is already labelled as preview in the UI. */
  'admin.html::resetMatrix': 'preview-only path; the live path goes through saveMatrix',

  /* The live path returns through persist(), which reports only after the
   * PATCH is accepted. What remains in commit() is the design-preview branch
   * (no OLHAuth on the page, so no API exists), and it now says "Saved
   * locally" rather than "Saved". The deployed-but-unreachable case no longer
   * falls here at all -- it reverts the field and raises a Not Saved toast. */
  'homesite.html::commit': 'remaining flash is the preview-only "Saved locally"; the live path reports from persist()'
};

/** Anything that tells the person a WRITE worked.
 *
 *  Deliberately not "any success toast". tracker.html's exportView() raises
 *  toast('ok','Export Ready',…) for a CSV built entirely in the browser -- a
 *  real success with no server in it. Only wording that claims persistence
 *  counts. */
const SUCCESS = [
  /flash\(\s*['"]Saved/i,
  /toast\(\s*['"]ok['"]\s*,\s*['"][^'"]*\b(saved|updated|applied|published|scheduled|assigned)\b/i,
  /\bsaved\s*:\s*true\b/,
  /(?:msg|mWarn|lockMsg|saveError)\s*:\s*['"][^'"]*\bsaved\b/i
];

/** Awaiting something that could actually have reached the server. */
const AWAITED_WRITE = /await\s+(?:this\.)?(?:fetch|_patchOne|persist|api|airtable|save|post|put)\w*\s*\(|await\s+fetch\s*\(|await\s+window\.OLH\w*\./;

/** Reporting from inside .then() is equally sound -- the promise resolved, the
 *  await is simply written in continuation style. admin.html's onSave does this
 *  on saveMatrix().
 *
 *  The .then() has to be ON A WRITE. A bare /\.then\(/ let homesite.html's
 *  commit() through, because the audit logger closure it now builds contains
 *  window.OLHAudit.record({…}).then(…) -- a promise, but not the save, and the
 *  flash('Saved') beneath it was still unconditional. Logging is not saving. */
const PROMISE_RESOLVED =
  /\b(?:fetch|saveMatrix|persist|_patchOne|api|save|update|publish|put|post)\w*\s*\([\s\S]{0,300}?\.then\s*\(/i;

function sourceOf(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = TPL_RE.exec(raw);
  if (!m) return raw;
  try {
    const d = JSON.parse(m[1].trim());
    return typeof d === 'string' ? d : raw;
  } catch (_) { return raw; }
}

/** Class methods as { name, body, start }. */
function methods(src) {
  const out = [];
  const re = /\n\s{2,6}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (/^(if|for|while|switch|catch|return|function)$/.test(name)) continue;
    let depth = 0, i = m.index + m[0].length - 1, end = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    out.push({ name, body: src.slice(m.index, end + 1) });
  }
  return out;
}

let problems = 0, checked = 0, pages = 0;

for (const file of fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html')).sort()) {
  const src = sourceOf(path.join(PUBLIC_DIR, file));
  const found = [];

  for (const fn of methods(src)) {
    for (const re of SUCCESS) {
      const hit = re.exec(fn.body);
      if (!hit) continue;
      checked++;
      const before = fn.body.slice(0, hit.index);
      if (AWAITED_WRITE.test(before)) break;          // waited for the server
      if (PROMISE_RESOLVED.test(before)) break;       // reported from .then()
      if (KNOWN_SAFE[file + '::' + fn.name]) break;
      found.push([fn.name, hit[0].trim().slice(0, 48)]);
      break;
    }
  }

  if (found.length) {
    pages++;
    process.stdout.write(file + '\n');
    for (const [fn, snip] of found) {
      problems++;
      process.stdout.write(
        '  ERROR  ' + fn + '(): reports success (' + snip + ') with no awaited write before it\n');
    }
  }
}

process.stdout.write(
  '\n' + checked + ' success report(s) checked; ' + problems + ' problem(s) on ' + pages + ' page(s).\n');
if (problems) {
  process.stdout.write(
    'Only say it saved after the server said so. If the report legitimately comes\n' +
    'from a .then() or a preview-only path, add it to KNOWN_SAFE with the reason.\n');
  process.exit(1);
}
