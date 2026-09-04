#!/usr/bin/env node
/**
 * The URL is read in one place and written by one function (`.claude/rules/ui-routing.md`, ADR-017):
 * `src/view-state.ts` is the ONLY file that may touch `location` or `history` or listen for
 * `popstate`. Everything else reads `viewState` and calls `navigate` / `leaveTo`. Exits 1 with the
 * offenders; `npm run audit:urls`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ONLY = join(root, 'src', 'view-state.ts');
const PATTERN = /\b(?:window\.)?(?:location|history)\.(?:pathname|search|hash|href|assign|replace|reload|pushState|replaceState|back|forward|go)\b|['"](?:popstate|hashchange)['"]/;

function* files(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p); else if (/\.(ts|vue)$/.test(p)) yield p;
  }
}
const hits = [];
for (const f of files(join(root, 'src'))) {
  if (f === ONLY) continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (PATTERN.test(line)) hits.push(`${relative(root, f)}:${i + 1}: ${line.trim()}`); });
}
if (hits.length) {
  console.error(`✘ ${hits.length} URL read/write(s) outside src/view-state.ts:`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('✓ the URL is read and written only in src/view-state.ts');
