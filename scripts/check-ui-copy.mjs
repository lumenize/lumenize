#!/usr/bin/env node
/**
 * Fail if a reserved INTERNAL word reaches a user-facing string.
 *
 * "Scope" is the system's word for a Universe, Galaxy or Star. Users never learn it: the UI says
 * Account, App, Tenant, and Home. That is a pinned vocabulary decision, and the failure mode it
 * guards against is quiet — nobody files a bug saying "this label taught me your internal noun",
 * they just find the product confusing in a way that never gets attributed.
 *
 * ## What counts as user-facing
 *
 * Two things, and deliberately not everything:
 *
 *  1. **Template text nodes** — the words between tags in a `<template>` block, interpolations
 *     stripped, since `{{ scope }}` renders a value rather than the word.
 *  2. **Quoted strings that reach the screen** — the argument of a UI-surfacing call
 *     (`log(...)`, `alert`, `confirm`), and `placeholder` / `title` / `aria-label` / `alt` attributes.
 *
 * Code identifiers, imports, comments, CSS classes, URLs and API paths are all NOT user-facing and
 * are excluded — `activeScope`, `/auth/scope-summary` and `scopeAdmin` are correct names for what
 * they are, and flagging them would make this instrument something people learn to ignore.
 *
 * ## Usage
 *
 *   node scripts/check-ui-copy.mjs [paths...]
 *
 * Exits 1 and prints every offending line when a reserved word reaches user-facing copy.
 * Defaults to the surfaces this rule governs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * The internal vocabulary, and what to say instead.
 *
 * ⚠️ Word-boundary matched and case-insensitive, so "Scopes" and "scope" both trip. `scoped` is
 * excluded by the boundary — it is a different word, and it appears in prose about permissions
 * where it is the right one.
 */
const RESERVED = {
  scope: 'Account, App, Tenant, or Home — never the internal noun',
  scopes: 'Account, App, Tenant, or Home — never the internal noun',
  universe: 'Account',
  galaxy: 'App',
  star: 'Tenant',
};

const DEFAULT_PATHS = [
  'apps/nebula-studio-ui/src',
  'apps/nebula/container/app/src',
];

/** UI-surfacing call sites whose first string argument reaches the screen. */
const UI_CALL = /\b(?:log|alert|confirm)\s*\(\s*(?:"[^"]*"|'[^']*')?\s*,?\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
/** Attributes whose value is read by a person. */
const UI_ATTR = /\b(?:placeholder|title|aria-label|alt)\s*=\s*"([^"]*)"/g;

function walk(path, out = []) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return out;
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      walk(join(path, entry), out);
    }
  } else if (['.vue', '.ts', '.js'].includes(extname(path))) {
    out.push(path);
  }
  return out;
}

/**
 * The text nodes of a `<template>` block, with everything that is not prose removed.
 *
 * Interpolations go first (`{{ scope }}` renders a value), then tags — but an attribute VALUE that
 * a person reads is kept, which is why the attribute scan runs separately over the raw source.
 */
function templateText(source) {
  const start = source.indexOf('<template>');
  if (start === -1) return [];
  // ⚠️ **Blanked, never removed, so every offset stays true to the original file.** An earlier cut
  // sliced the noise out and then guessed each finding's line by searching for its text, which
  // reported all three "Manage my scopes" hits on a code comment 100 lines above the template. A
  // wrong line number is worse than none: it is the thing that teaches people to ignore a check.
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const body = source
    .slice(0, start).replace(/[^\n]/g, ' ')                    // everything before <template>
    + source.slice(start)
      .replace(/\{\{[\s\S]*?\}\}/g, blank)                  // interpolations render values
      .replace(/<!--[\s\S]*?-->/g, blank)                     // comments are not user-facing
      .replace(/<[^>]*>/g, blank);                            // tags, attributes included

  return body.split('\n')
    .map((line, i) => ({ text: line.trim(), line: i + 1 }))
    .filter((e) => e.text);
}

/** Every match of `re` in `source`, with the 1-based line each starts on. */
function matchesWithLines(source, re, group) {
  const out = [];
  for (const m of source.matchAll(re)) {
    out.push({ text: m[group], line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

const reservedRe = new RegExp(`\\b(${Object.keys(RESERVED).join('|')})\\b`, 'i');

function findingsFor(file) {
  const source = readFileSync(file, 'utf8');
  const found = [];

  const record = ({ text, line }, kind) => {
    // `${scopeId}` renders a VALUE, exactly as `{{ scopeId }}` does in a template — so a
    // template-literal interpolation is stripped for the same reason and by the same rule. Without
    // this, `Could not open ${galaxy}` reads as the word "galaxy" reaching the screen when what
    // reaches it is an id. Text OUTSIDE the interpolation still counts, which is the whole point.
    const prose = text.replace(/\$\{[^}]*\}/g, ' ');
    const m = reservedRe.exec(prose);
    if (!m) return;
    const word = m[1].toLowerCase();
    found.push({
      file, line, kind, word,
      text: text.length > 90 ? `${text.slice(0, 90)}…` : text,
      say: RESERVED[word],
    });
  };

  for (const entry of templateText(source)) record(entry, 'template text');
  for (const e of matchesWithLines(source, UI_CALL, 1)) record({ ...e, text: e.text.slice(1, -1) }, 'UI string');
  for (const e of matchesWithLines(source, UI_ATTR, 1)) record(e, 'attribute');
  return found;
}

const paths = process.argv.slice(2);
const targets = (paths.length ? paths : DEFAULT_PATHS).flatMap((p) => walk(p));
const findings = targets.flatMap(findingsFor);

if (findings.length === 0) {
  console.log(`✅ no reserved internal words in user-facing copy (${targets.length} files)`);
  process.exit(0);
}

console.error(`❌ ${findings.length} reserved word(s) in user-facing copy:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.kind}]  "${f.word}"`);
  console.error(`    ${f.text}`);
  console.error(`    → say: ${f.say}\n`);
}
process.exit(1);
