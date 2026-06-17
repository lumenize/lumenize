/**
 * Self-hosted platform assets, served same-origin from code by `Star.onRequest`.
 *
 * Vue runtime, DaisyUI CSS, and every Lucide icon are **platform-fixed** —
 * identical for every generated app, never per-app, never per-version — so they
 * live in a committed code bundle (`../vendor/platform-assets.generated.mjs`,
 * built by `scripts/vendor-assets.mjs`) and are served straight from it, NOT
 * from the per-Star `AppBundle` table. That avoids one SQLite write per Lucide
 * icon (durable-objects.md § write costs) and lets a prod Star serve them with
 * no stage step. Serving same-origin is what lets `script-src` tighten to
 * `'self'` (tasks/nebula-self-hosted-assets.md) — the compiled SFC's bare `vue`
 * / `lucide-vue-next/icons/*` specifiers are rewritten to these paths at the
 * DevStar write boundary (`specifier-rewrite.ts`); no import map.
 *
 * Granular icons: each icon is its OWN `vendor/lucide/<name>.js`, so the browser
 * fetches only the icons an app imports (multi-MB resident server-side, but the
 * whole set never crosses the wire).
 */

// @ts-expect-error — generated data module, no types; see scripts/vendor-assets.mjs
import { VUE_RUNTIME, DAISYUI_CSS, LUCIDE_CORE, LUCIDE_ICONS } from '../vendor/platform-assets.generated.mjs';

const VUE_RUNTIME_SRC = VUE_RUNTIME as string;
const DAISYUI_CSS_SRC = DAISYUI_CSS as string;
const LUCIDE_CORE_SRC = LUCIDE_CORE as string;
const LUCIDE = LUCIDE_ICONS as Record<string, string>;

const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';

const LUCIDE_PREFIX = 'vendor/lucide/';

/**
 * Dev-preview stub for `@lumenize/nebula/frontend`, served at the same-origin
 * `vendor/nebula-frontend.js` the scaffold's `nebula.js` imports. The real
 * factory bundle (running against the live store) is the deferred T3 work; this
 * placeholder keeps the served bootstrap resolvable under `script-src 'self'`
 * (no CDN, no 404) and lets a fixture app mount. `ready` resolves so the
 * scaffold's `await ready` doesn't redirect to `/login`.
 */
const NEBULA_FRONTEND_PLACEHOLDER =
  `export function createNebulaClient() {\n` +
  `  return { client: {}, store: {}, ready: Promise.resolve() };\n` +
  `}\n`;

/**
 * Resolve a same-origin platform asset by its app-relative path (the request
 * path with the two `/{binding}/{instance}/` routing segments already stripped).
 * Returns `undefined` for non-platform paths so the caller falls through to the
 * per-Star `AppBundle` lookup. Lucide names are matched by exact single-segment
 * kebab against the vendored map — no path traversal, no filesystem.
 */
export function getPlatformAsset(path: string): { content: string; contentType: string } | undefined {
  switch (path) {
    case 'vendor/vue.js':
      return { content: VUE_RUNTIME_SRC, contentType: JS };
    case 'daisyui.css':
      return { content: DAISYUI_CSS_SRC, contentType: CSS };
    case 'vendor/nebula-frontend.js':
      return { content: NEBULA_FRONTEND_PLACEHOLDER, contentType: JS };
    case 'vendor/lucide/_core.js':
      // The shared createLucideIcon+Icon runtime every per-icon module imports.
      return { content: LUCIDE_CORE_SRC, contentType: JS };
  }
  if (path.startsWith(LUCIDE_PREFIX) && path.endsWith('.js')) {
    const name = path.slice(LUCIDE_PREFIX.length, -'.js'.length);
    if (/^[a-z0-9-]+$/.test(name)) {
      const code = LUCIDE[name];
      if (code !== undefined) return { content: code, contentType: JS };
    }
  }
  return undefined;
}
