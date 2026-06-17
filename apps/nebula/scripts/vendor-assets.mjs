/**
 * Regenerate the committed self-hosted platform-asset bundle that
 * `Star.onRequest` serves same-origin — the Vue runtime, DaisyUI's precompiled
 * CSS, and every Lucide icon as its own ESM. Mirrors `scripts/bundle-tsc.mjs`:
 * documented, scripted, reproducible; the OUTPUT is committed so a fresh clone
 * (dev, vitest-pool-workers, OR a deployed Worker) has it with no prior build.
 *
 * ## Why these are platform-fixed and served from code (not per-Star storage)
 *
 * Vue / DaisyUI / Lucide are identical for every generated app, never per-app
 * and never per-version. Serving them from a code constant (this bundle, loaded
 * once per isolate) instead of the per-Star `AppBundle` table avoids thousands
 * of SQLite row writes (one per Lucide icon — durable-objects.md § write costs)
 * and gives prod Stars the same assets without a stage step.
 *
 * ## Why self-hosted at all (the secure-by-default win)
 *
 * Build-seq #1a served Vue from `cdn.jsdelivr.net` under a loose
 * `script-src 'self' https://cdn.jsdelivr.net`. Self-hosting lets `script-src`
 * tighten to `'self'` (tasks/nebula-self-hosted-assets.md). Resolution of the
 * compiled SFC's bare specifiers (`vue`, `lucide-vue-next/icons/*`) to these
 * same-origin paths happens at the DevStar compile/write boundary
 * (`src/specifier-rewrite.ts`); no import map (a strict `script-src` would block
 * an inline one without a nonce).
 *
 * ## Granular icons — shared core, tiny per-icon data
 *
 * We vendor ALL ~1700 Lucide icons but each is its OWN served
 * `vendor/lucide/<name>.js`, so the browser fetches only the icons an app
 * imports (the Phase-1 chromium test asserts only `house.js` + the shared
 * `_core.js` cross the wire — no whole-set download). The shared
 * `createLucideIcon`+`Icon` runtime is bundled ONCE as `vendor/lucide/_core.js`
 * (vue external → rewritten to `../../vue.js`); each per-icon module is the
 * upstream source with its `'../createLucideIcon.js'` import repointed to
 * `'./_core.js'` and its license/sourcemap comments stripped. Bundling each icon
 * self-contained instead would duplicate the ~1.5 KB runtime ×1700 (~2.5 MB) and
 * pushed the generated module past what the workerd isolate will load — sharing
 * the core keeps the whole bundle ~1.6 MB.
 *
 * Re-run `npm run vendor:assets` + commit the regenerated bundle only on a
 * `vue` / `daisyui` / `lucide-vue-next` version bump.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = resolve(__dirname, '../../..');
const nm = resolve(repoRoot, 'node_modules');
const outfile = resolve(__dirname, '../vendor/platform-assets.generated.mjs');

const pkgVersion = (name) => require(resolve(nm, name, 'package.json')).version;

// ── Vue 3.5 runtime-only browser build (no template compiler → no `new
//    Function`, CSP-safe). Fully self-contained ESM — served verbatim. ────────
const vueRuntimePath = resolve(nm, 'vue/dist/vue.runtime.esm-browser.prod.js');
const VUE_RUNTIME = readFileSync(vueRuntimePath, 'utf8');

// ── DaisyUI precompiled CSS — browser-valid plain CSS (only native `@layer`,
//    no `@plugin`/`@tailwind`/`@apply`), so no Tailwind compile is needed. ────
const daisyuiCssPath = resolve(nm, 'daisyui/daisyui.css');
const DAISYUI_CSS = readFileSync(daisyuiCssPath, 'utf8');

// ── Lucide — shared `_core.js` (createLucideIcon + Icon, vue external) + one
//    tiny data module per icon importing it. ────────────────────────────────────
//
// `vue.js` (root scaffold asset) re-exports `./vendor/vue.js`; the served Vue
// thus lives at `{base}/vendor/vue.js`. From `{base}/vendor/lucide/_core.js` the
// root `vue.js` shim is `../../vue.js` — the SAME resolved URL the compiled SFC
// imports, so the browser keeps a single Vue module instance.
const VUE_RELATIVE_FROM_ICON = '../../vue.js';
const iconsDir = resolve(nm, 'lucide-vue-next/dist/esm/icons');

const coreBundle = await build({
  entryPoints: [resolve(nm, 'lucide-vue-next/dist/esm/createLucideIcon.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  external: ['vue'],
  write: false,
});
const LUCIDE_CORE = coreBundle.outputFiles[0].text
  .replace(/from\s*["']vue["']/g, `from"${VUE_RELATIVE_FROM_ICON}"`);

// Each icon module is the upstream source with the createLucideIcon import
// repointed to the shared `./_core.js` and comments stripped (license header +
// trailing sourcemap). `index.js` is the barrel re-export — not an icon.
const stripComments = (s) =>
  s.replace(/^\/\*[\s\S]*?\*\/\s*/, '').replace(/\n\/\/#\s*sourceMappingURL=.*\s*$/, '\n');
const iconFiles = readdirSync(iconsDir)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.js.map') && f !== 'index.js');

const LUCIDE_ICONS = {};
for (const f of iconFiles) {
  const name = basename(f, '.js');
  const src = readFileSync(resolve(iconsDir, f), 'utf8');
  LUCIDE_ICONS[name] = stripComments(src)
    .replace(/from\s*['"]\.\.\/createLucideIcon\.js['"]/g, `from './_core.js'`);
}

const VENDOR_VERSIONS = {
  vue: pkgVersion('vue'),
  daisyui: pkgVersion('daisyui'),
  'lucide-vue-next': pkgVersion('lucide-vue-next'),
};

const header = `// AUTO-GENERATED by apps/nebula/scripts/vendor-assets.mjs — DO NOT EDIT.\n` +
  `// Regenerate with \`npm run vendor:assets\` (only on a vue/daisyui/lucide-vue-next bump).\n` +
  `// Vendored: vue@${VENDOR_VERSIONS.vue} (MIT), daisyui@${VENDOR_VERSIONS.daisyui} (MIT), ` +
  `lucide-vue-next@${VENDOR_VERSIONS['lucide-vue-next']} (ISC). See ATTRIBUTIONS.md.\n`;

const body =
  `export const VENDOR_VERSIONS = ${JSON.stringify(VENDOR_VERSIONS)};\n` +
  `export const VUE_RUNTIME = ${JSON.stringify(VUE_RUNTIME)};\n` +
  `export const DAISYUI_CSS = ${JSON.stringify(DAISYUI_CSS)};\n` +
  `export const LUCIDE_CORE = ${JSON.stringify(LUCIDE_CORE)};\n` +
  `export const LUCIDE_ICONS = ${JSON.stringify(LUCIDE_ICONS)};\n`;

writeFileSync(outfile, header + body);

const sizeMB = (Buffer.byteLength(header + body) / (1024 * 1024)).toFixed(2);
console.log(
  `Vendored platform assets → ${outfile} (${sizeMB} MB): ` +
  `vue@${VENDOR_VERSIONS.vue}, daisyui@${VENDOR_VERSIONS.daisyui}, ` +
  `${iconFiles.length} lucide@${VENDOR_VERSIONS['lucide-vue-next']} icons`,
);
