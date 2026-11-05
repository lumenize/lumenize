#!/usr/bin/env node
/**
 * Every class token the Studio + auth sources use MUST exist in the built CSS.
 *
 * Tailwind emits only what the sources use and daisyUI defines only what its version ships, so a
 * token missing from the bundle is one of two defects: a component class this daisyUI no longer has
 * (v5 dropped `form-control`, `label-text`, `label-text-alt`, `input-bordered`, `tabs-boxed` — every
 * form in the app was silently unstyled until 2026-09-03), or a typo. Either is a screen rendering
 * without the spacing its author assumed. Run after `vite build` (`npm run audit:classes`); exits 1
 * with the offenders.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cssDir = join(root, 'dist', 'assets');
const css = readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(cssDir, f), 'utf8')).join('\n');
const defined = new Set([...css.matchAll(/\.((?:[a-zA-Z0-9_-]|\\[^a-zA-Z0-9])+)(?=[\s{:,.>~+\[)])/g)].map((m) => m[1].replace(/\\(.)/g, '$1')));

function* vueFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* vueFiles(p); else if (p.endsWith('.vue')) yield p;
  }
}
// `:class` bindings carry expressions; only quoted string literals inside them are class lists.
const tokensOf = (attr) => attr.match(/[A-Za-z0-9_:/.\-\[\]%!#()]+/g) ?? [];
const NOISE = /^(-|\]|\[|[a-z]|true|false|\w+\.\w+|[a-z]+\([^)]*\))$/;
const used = new Map();
for (const f of vueFiles(join(root, 'src'))) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/(?:^|\s)class="([^"]*)"/g)) for (const t of tokensOf(m[1])) used.set(t, f);
  // A comparison operand (`kind === 'agent'`) is a value, not a class list — drop it before reading literals.
  for (const m of s.matchAll(/(?:^|\s):class="([^"]*)"/g)) for (const lit of m[1].replace(/[=!]==?\s*'[^']*'/g, '').matchAll(/'([^']*)'/g)) for (const t of tokensOf(lit[1])) used.set(t, f);
}
const missing = [...used].filter(([t]) => !defined.has(t) && !NOISE.test(t) && !t.startsWith('['));
if (missing.length) {
  console.error(`✘ ${missing.length} class token(s) used but not defined in the built CSS:`);
  for (const [t, f] of missing.sort()) console.error(`  ${t.padEnd(28)} ${f.replace(root + '/', '')}`);
  process.exit(1);
}
console.log(`✓ every class token in ${[...used].length} used is defined in the built CSS`);
