#!/usr/bin/env node
/**
 * Fail when prose or a comment calls a `@mesh()`-decorated method or getter "marked".
 *
 * `@mesh()` is one decorator among several a class can carry, so "marked" does not say which, and
 * the TC39 decorators proposal never uses the word: it says "decorated". Say "`@mesh()`-decorated
 * method" or "getter", or "has no `@mesh()`". `.claude/rules/prose-voice.md` and
 * `.claude/rules/mesh.md` state the convention; this script is what keeps it, because the shorthand
 * spread through the rules, the docs and the source comments, and every session re-learned it
 * from whatever it read (2026-09-29).
 *
 * ## What it flags
 *
 * A line is flagged when it says `unmarked`, `marked` followed by a method, getter, member, entry
 * or gate, `no mark`, `missing mark`, or `@mesh() mark` — or when it uses any form of "mark"
 * beside `@mesh` on the same line. Lines about a high-water mark are never flagged, and neither
 * is any other sense of the word that does not sit next to `@mesh`.
 *
 * ## Usage
 *
 *   node scripts/check-mesh-vocab.mjs [paths...]          # exits 1 on any hit
 *   node scripts/check-mesh-vocab.mjs --regression <path>   # exits 2 on hits the file did not have at HEAD
 *
 * With no paths it checks the surfaces agents read: the rules and skills, `docs/`, `website/docs/`,
 * active task files, and the source and tests of `packages/` and `apps/`. The regression mode is
 * what `scripts/mesh-vocab-hook.sh` runs after every edit, so a file with old hits costs nothing
 * until an edit adds one.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const EXTENSIONS = new Set(['.md', '.mdx', '.ts', '.vue']);
const SKIP = /(^|\/)(node_modules|dist|archive|icebox|nightly|_archived|archive-and-outdated)(\/|$)|worker-configuration\.d\.ts$|platform-embed\.ts$/;
const DEFAULT_ROOTS = ['.claude/rules', '.claude/skills', 'docs', 'website/docs', 'tasks', 'packages', 'apps', 'CLAUDE.md'];

const ALWAYS = /\bunmarked\b|\bmarked\s+(`?@mesh\(\)`?\s+)?(members?|methods?|getters?|entr(y|ies)|gates?)\b|\b(no|missing)\s+mark\b|@mesh\(\)`?\s+marks?\b/i;
const ANY_MARK = /\bmark(s|ed|ing)?\b/i;
const BESIDE_MESH = /@mesh\b/;
const NOT_THIS_SENSE = /high-water mark/i;

/**
 * A word in double quotes is being mentioned, not used — the rule stating this convention quotes
 * "marked" and "unmarked" — so quoted spans are dropped before matching.
 * @param {string} line
 */
function offends(line) {
  const used = line.replace(/"[^"]*"|“[^”]*”/g, '');
  if (NOT_THIS_SENSE.test(used)) return false;
  return ALWAYS.test(used) || (ANY_MARK.test(used) && BESIDE_MESH.test(used));
}

/** @param {string} root @returns {string[]} */
function walk(root) {
  if (!existsSync(root) || SKIP.test(root)) return [];
  if (statSync(root).isFile()) return EXTENSIONS.has(extname(root)) ? [root] : [];
  return readdirSync(root).flatMap((name) => walk(join(root, name)));
}

/** @param {string} text @returns {string[]} */
function offendingLines(text) {
  return text.split('\n').filter(offends);
}

const args = process.argv.slice(2);
if (args[0] === '--regression') {
  const file = args[1];
  if (!file || SKIP.test(file) || !EXTENSIONS.has(extname(file)) || !existsSync(file)) process.exit(0);
  const rel = relative(process.cwd(), file);
  let before = '';
  try {
    before = execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    before = '';
  }
  const had = new Set(offendingLines(before));
  const added = offendingLines(readFileSync(file, 'utf8')).filter((l) => !had.has(l));
  if (!added.length) process.exit(0);
  console.error(`\n"marked" for \`@mesh()\` — ${rel}\n`);
  for (const l of added) console.error(`  · ${l.trim().slice(0, 200)}`);
  console.error('\nSay "`@mesh()`-decorated method" or "getter", or "has no `@mesh()`" (.claude/rules/prose-voice.md).');
  process.exit(2);
}

const files = (args.length ? args : DEFAULT_ROOTS).flatMap(walk);
let hits = 0;
for (const f of files) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (offends(line)) {
      hits++;
      console.log(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  });
}
if (hits) console.log(`\n${hits} line(s) call a \`@mesh()\`-decorated method or getter "marked".`);
process.exit(hits ? 1 : 0);
