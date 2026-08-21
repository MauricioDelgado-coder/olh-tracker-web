#!/usr/bin/env node
/**
 * Assert that every error message a page can produce is actually reachable
 * on screen.
 *
 *   node dev/check-error-visibility.js [public-dir]
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-21 scheduler.html refused every CEL/ACC save (a server-side cap
 * bug) and said nothing at all. The handler did set a message -- mWarn, with
 * the real reason in it -- but mWarn was rendered in exactly one place, inside
 * <sc-if value="{{ step }}">, the manual-assign sub-panel. "Save Schedule"
 * lives in the header, where step is null, so the branch never rendered. A
 * failed save was visually identical to a successful one.
 *
 * That is not a typo you can catch by reading a diff: the assignment is right,
 * the binding exists, and the page loads clean. What is wrong is the RELATION
 * between where the message is written and where it is drawn, which is exactly
 * the kind of thing a machine should check.
 *
 * WHAT IT CHECKS
 *
 * For each page:
 *   1. Collect state keys assigned inside a catch block, i.e. the keys a
 *      failure path can set.  ->  "error keys"
 *   2. For each error key, find its {{ key }} binding in the markup.
 *        - no binding at all              -> ERROR (message can never be seen)
 *        - binding wrapped in an <sc-if>  -> ERROR unless the condition is the
 *          key itself (or a value derived from it, e.g. panelWarn/xWarn), since
 *          any other condition can be false at the moment the error fires.
 *
 * A message gated on its own presence is the correct pattern: it shows exactly
 * when it is non-empty. A message gated on anything else is a latent silent
 * failure.
 *
 * KNOWN_SAFE lists bindings that are genuinely scoped -- a per-row error inside
 * the row that produced it, for instance -- with the reason. Adding to it is a
 * decision, not a workaround, so each entry needs a note.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = process.argv[2] || 'public';
const TPL_RE = /<script[^>]*type="__bundler\/template"[^>]*>([\s\S]*?)<\/script>/;

/* binding -> why it is allowed to be conditional. */
const KNOWN_SAFE = {
  /* mWarn's own two bindings sit inside the manual-assign panel (<sc-if step>),
   * which is the bug this checker was written for. It is now ALSO surfaced by
   * panelWarn, which renders inside <sc-if sel> -- the selected-homesite panel
   * that owns Save, Reset and the CEL Letter checkbox. Every path that writes
   * mWarn is reachable only from inside that panel, so scoping the banner to it
   * is correct rather than a gap: there is no way to trigger these errors with
   * no homesite selected. */
  'scheduler.html::mWarn': 'also rendered as panelWarn inside <sc-if sel>, which is where every writer of mWarn lives'
};

/** The page's JS + markup as one string (bundled pages store it JSON-encoded). */
function sourceOf(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = TPL_RE.exec(raw);
  if (!m) return raw;
  try {
    const decoded = JSON.parse(m[1].trim());
    return typeof decoded === 'string' ? decoded : raw;
  } catch (_) {
    return raw;
  }
}

/** The component's declared state keys, so locals in a catch are not mistaken
 *  for rendered state. */
function stateKeys(src) {
  const m = /state\s*=\s*\{/.exec(src);
  if (!m) return null;
  let depth = 0, i = m.index + m[0].length - 1, end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const body = src.slice(m.index, end + 1);
  const keys = new Set();
  let k;
  const kr = /(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g;
  while ((k = kr.exec(body))) keys.add(k[1]);
  return keys;
}

/* Only names that carry a message to a person. A boolean like `celSaving` is
 * also set in a catch, but it drives a spinner, not an explanation. */
const MESSAGE_LIKE = /(warn|msg|message|err|note|reason|fail|lock)/i;

/** Values derived from `key` in renderVals, e.g. `panelWarn: s.step ? "" : s.mWarn`.
 *  Rendering the alias counts as rendering the key. */
function aliasesOf(src, key) {
  const out = new Set([key]);
  const re = new RegExp('([A-Za-z_$][\\w$]*)\\s*:[^,;\\n]*\\bs\\.' + key + '\\b', 'g');
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

/** State keys assigned inside a catch block. */
function errorKeys(src) {
  const declared = stateKeys(src);
  const keys = new Set();
  const re = /catch\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    // brace-match the catch body
    let depth = 0, i = m.index + m[0].length - 1, end = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const body = src.slice(m.index, end + 1);
    const kr = /(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g;
    let k;
    while ((k = kr.exec(body))) {
      const name = k[1];
      if (!MESSAGE_LIKE.test(name)) continue;
      if (declared && !declared.has(name)) continue; // a local, not rendered state
      keys.add(name);
    }
  }
  return keys;
}

/** The chain of <sc-if> conditions enclosing `pos` in the markup. */
function enclosingIfs(markup, pos) {
  const stack = [];
  const re = /<sc-if\s+value="\{\{\s*([\w.]+)\s*\}\}"|<\/sc-if>/g;
  let m;
  while ((m = re.exec(markup)) && m.index < pos) {
    if (m[0] === '</sc-if>') stack.pop();
    else stack.push(m[1]);
  }
  return stack;
}

/** A condition that IS the key, or clearly derived from it. */
function guardsItself(cond, key) {
  if (cond === key) return true;
  const c = cond.toLowerCase(), k = key.toLowerCase();
  return c.includes(k) || k.includes(c);
}

let errors = 0, checked = 0, pages = 0;

for (const file of fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html')).sort()) {
  const src = sourceOf(path.join(PUBLIC_DIR, file));
  const keys = errorKeys(src);
  if (!keys.size) continue;
  pages++;

  const found = [];
  for (const key of [...keys].sort()) {
    checked++;
    /* The key is visible if IT or any value derived from it is rendered
       somewhere unconditional (or guarded only by its own presence). */
    const names = aliasesOf(src, key);
    let visible = false, firstGuard = null, anyBinding = false;

    for (const name of names) {
      const binding = '{{ ' + name + ' }}';
      let idx = src.indexOf(binding);
      while (idx >= 0) {
        anyBinding = true;
        const chain = enclosingIfs(src, idx).filter((c) => !guardsItself(c, name));
        if (!chain.length) { visible = true; break; }
        if (!firstGuard) firstGuard = chain.join(' > ');
        idx = src.indexOf(binding, idx + 1);
      }
      if (visible) break;
    }

    if (visible) continue;
    if (KNOWN_SAFE[file + '::' + key]) continue;
    found.push(['ERROR', key, anyBinding
      ? 'only rendered inside <sc-if ' + firstGuard + '> — invisible when that is false'
      : 'set on a failure path but never rendered']);
  }

  if (found.length) {
    process.stdout.write(file + '\n');
    for (const [lvl, key, why] of found) {
      errors++;
      process.stdout.write('  ' + lvl + '  ' + key + ': ' + why + '\n');
    }
  }
}

process.stdout.write(
  '\n' + checked + ' error binding(s) checked across ' + pages + ' page(s); ' + errors + ' problem(s).\n');
if (errors) {
  process.stdout.write(
    'An error the user cannot see is the same as no error. Render it where the\n' +
    'action is, or add it to KNOWN_SAFE with a reason.\n');
  process.exit(1);
}
