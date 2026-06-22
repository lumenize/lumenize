/**
 * nebula.ts — the scaffolded bootstrap. The ONE framework file the Studio engine may
 * extend (per-type conflict resolvers, first-run resource bootstrap). Components
 * import `{ client, store }` from here; NebulaClient never appears in component code.
 *
 * Scope is SERVER-DERIVED: DevContainer.fetch() injects `<meta name="nebula-scope">`
 * into the shell at serve time (activeScope/authScope/appVersion from the routed
 * instance identity — never request-supplied; the wrong-Star footgun guard). The
 * prod static-serve injects the same meta. We read it here, never a URL/query value.
 *
 * ⚠️ Deploy-gated wiring: `@lumenize/nebula/frontend` is a private workspace package
 * (not on npm), so it is VENDORED into the container image at deploy build — the seed
 * App.vue boots standalone (doesn't import this file) so the image self-validates
 * vite+HMR without the factory; DevStudio's first `applyChanges` pushes an App.vue
 * that imports `{ client, store }` from here once the frontend is vendored. The
 * assembled preview (factory + live Star) rides the deploy-gated e2e (task Phase 3.5).
 */
// @ts-expect-error — vendored at deploy build (see header); unresolved in the baked tree.
import { createNebulaClient } from '@lumenize/nebula/frontend';

interface NebulaScope {
  activeScope: string; // {u}.{g}.dev in dev; the deployed star in prod
  authScope: string;   // parent galaxy {u}.{g}
  appVersion: string;
}

function readInjectedScope(): NebulaScope {
  const content = document
    .querySelector('meta[name="nebula-scope"]')
    ?.getAttribute('content');
  if (!content) throw new Error('nebula-scope meta missing — serving layer did not inject scope');
  return JSON.parse(content) as NebulaScope;
}

const { activeScope, authScope, appVersion } = readInjectedScope();

// Dev preview only: enable the live reload channel so an ontology change re-syncs this
// preview onto the new version (Decision 12 / Flow 1d). Segment-precise `.dev` check
// (env detection — NOT a hot-path branch); prod previews leave `onReload` unset and
// rely on the once-per-session `onShouldRefreshUI` backstop. Setting `onReload` is what
// makes NebulaClient subscribe to the Star's reload channel on connect.
const segs = activeScope.split('.');
const isDevPreview = segs.length === 3 && segs[2] === 'dev';

export const { client, store, ready } = createNebulaClient({
  appVersion,
  authScope,
  activeScope,
  ...(isDevPreview ? { onReload: () => window.location.reload() } : {}),
});

try {
  await ready;
} catch {
  window.location.assign('/login');
}
