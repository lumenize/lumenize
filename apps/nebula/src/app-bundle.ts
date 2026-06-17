/**
 * App-bundle storage contract — the shared shape the compile writer
 * (`DevStar.compileSFC`) and the serving reader (`Star.onRequest`) agree on.
 *
 * The compiled app lives in Star storage as a flat **asset map**: one row per
 * served path in the `AppBundle` SQLite table (`path` PK, `content`,
 * `contentType`). A per-save compile rewrites only the changed component's row
 * (1 `INSERT OR REPLACE` write) — chosen over a single whole-bundle KV blob
 * precisely to avoid rewriting the entire bundle on every keystroke-save
 * (durable-objects.md § SQLite write-cost). `WITHOUT ROWID` + a single TEXT PK
 * keeps each write at 1 row (no separate PK index).
 *
 * ⚠️ **Provisional dev-local artifact (build-seq #1a).** This shape is
 * superseded by `nebula-app-versioning.md`'s (#1b) app-version record + its
 * `#installState` writer; don't over-invest in durability here. The fixed
 * scaffold + a runtime-only Vue **placeholder** are staged so a complete
 * servable bundle is resident for the dev preview; the real self-hosted asset
 * pipeline (bundling, import-maps, Tailwind/DaisyUI) is #1b / post-demo.
 *
 * Serve-time injection: `index.html` carries `__BASE_HREF__`; `nebula.js`
 * carries `__APP_VERSION__` / `__AUTH_SCOPE__` / `__ACTIVE_SCOPE__`. The serving
 * layer (`Star.onRequest`) substitutes all four per-request from the instance it
 * is serving — the single choke point that prevents the wrong-Star footgun
 * (a browser-trusted scope would let `#starBinding()` silently pick `STAR`).
 */

/** Fixed scaffold asset paths (served at the app base path). */
export const SCAFFOLD = {
  indexHtml: 'index.html',
  mainJs: 'main.js',
  nebulaJs: 'nebula.js',
  vueJs: 'vue.js',
} as const;

/** Serve-time placeholders substituted by the serving layer. */
export const PLACEHOLDER = {
  baseHref: '__BASE_HREF__',
  appVersion: '__APP_VERSION__',
  authScope: '__AUTH_SCOPE__',
  activeScope: '__ACTIVE_SCOPE__',
} as const;

const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const JSON_CT = 'application/json; charset=utf-8';

const SCAFFOLD_LATCH = '__nebula_scaffoldStaged';

/**
 * Minimal SPA shell. `<base href>` (injected per-request) anchors relative asset
 * URLs to the app base path so deep-link navigations (`…/items/42`) still
 * resolve `./main.js` against the base, not the current path.
 */
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${PLACEHOLDER.baseHref}">
<link rel="stylesheet" href="./daisyui.css">
<title>Nebula App</title>
</head>
<body>
<div id="app"></div>
<script type="module" src="./main.js"></script>
</body>
</html>
`;

/** Vue entrypoint — never edited after scaffolding (nebula-studio.md §Bootstrap). */
const MAIN_JS = `import { createApp } from './vue.js';
import App from './App.js';
import './nebula.js';
createApp(App).mount('#app');
`;

/**
 * Compiled `nebula.ts` bootstrap. `appVersion` / `authScope` / `activeScope` are
 * server-injected placeholders (nebula-studio.md §Bootstrap). The
 * `@lumenize/nebula/frontend` specifier resolution (import-map / self-hosted
 * vendor bundle) is the #1b asset story; the dev-preview placeholder path keeps
 * the bootstrap servable + injection-testable without the full pipeline.
 */
const NEBULA_JS = `import { createNebulaClient } from './vendor/nebula-frontend.js';
export const { client, store, ready } = createNebulaClient({
  appVersion: "${PLACEHOLDER.appVersion}",
  authScope: "${PLACEHOLDER.authScope}",
  activeScope: "${PLACEHOLDER.activeScope}",
});
try { await ready; } catch { window.location.assign('/login'); }
`;

/**
 * Vue 3.5 **runtime-only** browser build (no template compiler → no
 * `new Function`, so the served app runs under a strict CSP with no
 * `'unsafe-eval'` — website/docs/nebula/using-vue.md §Security). Render
 * functions are precompiled server-side by `compileSFCToModule`, so the browser
 * needs only the runtime.
 *
 * This staged `vue.js` is a thin **re-export of the self-hosted, same-origin**
 * runtime (`./vendor/vue.js`, served from code by `platform-assets.ts`) — no CDN,
 * so the served app resolves Vue under `script-src 'self'`
 * (tasks/nebula-self-hosted-assets.md). The compiled SFC's bare `vue` specifier
 * is rewritten to `./vue.js` (this asset) at the DevStar write boundary; the
 * Lucide icons resolve the SAME backing module via `../../vue.js`, so the browser
 * keeps a single Vue instance. (Why a shim and not the runtime inlined here: it
 * keeps `vue.js` a 1-row scaffold write while the ~100 KB runtime stays a
 * platform asset, never re-staged per Star.)
 */
const VUE_RUNTIME_JS = `// Vue 3.5 runtime-only build, re-exported from the self-hosted same-origin copy.
export * from './vendor/vue.js';
`;

function ensureTable(ctx: DurableObjectState): void {
  ctx.storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS AppBundle (path TEXT PRIMARY KEY, content TEXT NOT NULL, contentType TEXT NOT NULL) WITHOUT ROWID;`,
  );
}

/** Write (or replace) one asset. `path` is server-derived; bound as a parameter. */
export function putAsset(ctx: DurableObjectState, path: string, content: string, contentType: string): void {
  ensureTable(ctx);
  ctx.storage.sql.exec(
    `INSERT OR REPLACE INTO AppBundle (path, content, contentType) VALUES (?, ?, ?)`,
    path,
    content,
    contentType,
  );
}

/** Read one asset by exact path (PK lookup — no prefix/traversal). */
export function getAsset(
  ctx: DurableObjectState,
  path: string,
): { content: string; contentType: string } | undefined {
  ensureTable(ctx);
  const rows = ctx.storage.sql
    .exec(`SELECT content, contentType FROM AppBundle WHERE path = ?`, path)
    .toArray() as Array<{ content: string; contentType: string }>;
  return rows.length > 0 ? rows[0] : undefined;
}

/**
 * Stage the fixed scaffold + runtime-only Vue placeholder (idempotent, latched).
 * Runs once per Star lifetime; a `resetDevData()` `deleteAll()` wipes the latch,
 * so the next compile re-stages (the documented "serves nothing until next
 * compile after reset" window). Cheap: one KV read on the warm path, four row
 * writes only on the cold/first call.
 */
export function stageScaffold(ctx: DurableObjectState): void {
  if (ctx.storage.kv.get(SCAFFOLD_LATCH)) return;
  putAsset(ctx, SCAFFOLD.indexHtml, INDEX_HTML, HTML);
  putAsset(ctx, SCAFFOLD.mainJs, MAIN_JS, JS);
  putAsset(ctx, SCAFFOLD.nebulaJs, NEBULA_JS, JS);
  putAsset(ctx, SCAFFOLD.vueJs, VUE_RUNTIME_JS, JS);
  ctx.storage.kv.put(SCAFFOLD_LATCH, true);
}

/** Map a served path's extension to a Content-Type for compiled component assets. */
export function contentTypeForPath(path: string): string {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return JS;
  if (path.endsWith('.css')) return CSS;
  if (path.endsWith('.json')) return JSON_CT;
  if (path.endsWith('.html')) return HTML;
  return 'application/octet-stream';
}
