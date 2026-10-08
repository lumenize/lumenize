#!/usr/bin/env node
/**
 * Fail if a `waitForEmail` waiter cannot tell WHOSE email it got.
 *
 * The deployed `email-test` Worker is one shared mailbox for the whole repo, and its socket pushes
 * every arriving message to every listener. A waiter that does not filter therefore resolves with
 * whatever lands first — which is usually somebody else's mail, and on a magic-link flow that means
 * clicking a single-use link the other test already consumed. The symptom is a 401 at a completely
 * different step, so it reads as flake and gets retried rather than fixed.
 *
 * That is not hypothetical. Two `packages/mesh` browser tests shared one pinned address, and the
 * loser of the race died on `refresh-token 401 No refresh token provided` (fixed 2026-09-25, by
 * making it one login instead of two). `.claude/rules/testing.md` § *Email tests must say whose
 * mail they are waiting for* carries the rule; this is its proof.
 *
 * ## What counts as discriminated
 *
 * **A recipient — `to` — and nothing else.** It is filtered client-side against the message's own
 * `to` header, so it needs no cooperation from the sender and cannot be defeated by a later branch
 * changing what gets sent. Pair it with `uniqueTestEmail()` and a test is independent by
 * construction.
 *
 * ⚠️ **`instance` is NOT sufficient, and that is the whole reason this check exists.** It filters
 * server-side on a header the sender stamps, so it fails in two ways `to` does not: two waiters on
 * the SAME instance still race each other, and a flow that decides its tag AFTER the waiter is armed
 * — a scope claim that falls back to a scope-less login on a 409 — sends mail the waiter can never
 * match, which sits out the full timeout and reports as a delivery problem. `instance` is a fine
 * narrowing ON TOP of `to`; it is not a substitute.
 *
 * ## Opting out
 *
 * Some waiters genuinely cannot use a recipient — a pinned bootstrap address, or an assertion that
 * NO mail arrives. Say so on the line or just above it:
 *
 *     // email-isolation: <why a recipient filter is wrong or impossible here>
 *
 * The marker is deliberately a sentence, not a bare disable: the reason is the thing a future
 * reader needs, and writing one is where you notice you do not have one.
 *
 * ## Usage
 *
 *   node scripts/check-email-isolation.mjs [paths...]
 *
 * Exits 1 and prints every undiscriminated waiter. Defaults to every lane that sends test mail.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const DEFAULT_PATHS = [
  'packages',
  'apps/nebula/test',
  'apps/nebula/harness',
  'tooling',
];

/** The marker that turns a finding into a stated decision. */
const OPT_OUT = /email-isolation:\s*\S/;
/** How far above a call site to look for it. */
const MARKER_LOOKBACK = 12;

function walk(path, out = []) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return out;
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.wrangler' || entry.startsWith('.')) continue;
      walk(join(path, entry), out);
    }
  } else if (['.ts', '.mts', '.js', '.mjs'].includes(extname(path))) {
    out.push(path);
  }
  return out;
}

/**
 * Blank every comment, preserving offsets so line numbers stay true to the original file.
 *
 * Blanking rather than removing matters for the same reason it does in `check-ui-copy.mjs`: a
 * finding reported on the wrong line is worse than no finding, because it is what teaches people to
 * ignore the check. Comments are blanked because `waitForEmail(` appears in plenty of JSDoc — the
 * helper's own docstring included — and a doc mention is not a call site.
 */
function blankComments(source) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | single | double | template
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      out += c; i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; } else out += ' ';
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? c : ' ';
      i += 1; continue;
    }
    // inside a string: copy through, honouring escapes so a quote in `'it\'s'` does not end it
    if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code';
    }
    out += c; i += 1;
  }
  return out;
}

/** The text between the `(` at `open` and its matching `)`, or '' when unbalanced. */
function argumentText(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
}

/** A `to` property, longhand (`to: x`) or ES6 shorthand (`{ testToken, to }`). */
const HAS_RECIPIENT = /(^|[{,\s])to\s*(:|,|\}|$)/;
const HAS_INSTANCE = /(^|[{,\s])instance\s*(:|,|\}|$)/;

function findingsFor(file) {
  const raw = readFileSync(file, 'utf8');
  if (!raw.includes('waitForEmail')) return [];
  const code = blankComments(raw);
  const rawLines = raw.split('\n');
  const findings = [];

  const callRe = /\bwaitForEmail\s*\(/g;
  let m;
  while ((m = callRe.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    // The DEFINITION is not a call site.
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    if (/\bfunction\s*$/.test(before)) continue;

    const line = code.slice(0, m.index).split('\n').length;
    const args = argumentText(code, open);
    if (HAS_RECIPIENT.test(args)) continue;

    // A stated reason on the line or just above it.
    const window = rawLines.slice(Math.max(0, line - 1 - MARKER_LOOKBACK), line).join('\n');
    if (OPT_OUT.test(window)) continue;

    findings.push({
      file: relative(process.cwd(), file),
      line,
      instanceOnly: HAS_INSTANCE.test(args),
      text: (rawLines[line - 1] ?? '').trim().slice(0, 100),
    });
  }
  return findings;
}

const paths = process.argv.slice(2);
const targets = (paths.length ? paths : DEFAULT_PATHS).flatMap((p) => walk(p));
const findings = targets.flatMap(findingsFor);

if (findings.length === 0) {
  console.log(`✅ every waitForEmail waiter names its recipient or says why not (${targets.length} files scanned)`);
  process.exit(0);
}

console.error(`❌ ${findings.length} waitForEmail waiter(s) cannot tell whose email they got:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.text}`);
  console.error(f.instanceOnly
    ? '    → `instance` narrows but does not discriminate: two waiters on one instance still race,\n'
      + '      and a tag decided after the waiter is armed can never match. Add `to`.'
    : '    → add `to` (pair with `uniqueTestEmail()`), or state why not:\n'
      + '      // email-isolation: <why a recipient filter is wrong or impossible here>');
  console.error('');
}
process.exit(1);
