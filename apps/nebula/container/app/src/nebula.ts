/**
 * nebula.ts — the scaffolded bootstrap. The ONE framework file the Studio engine may
 * extend (per-type conflict resolvers, first-run resource bootstrap). Components
 * import `{ client, store }` from here; NebulaClient never appears in component code.
 *
 * Scope is SERVER-DERIVED: the Galaxy's `/app/*` serve path injects `<meta name="nebula-scope">`
 * into the shell at serve time (activeScope/authScope/ontologyVersion from the routed
 * instance identity — never request-supplied; the wrong-Star footgun guard). The
 * prod static-serve injects the same meta. We read it here, never a URL/query value.
 *
 * ⚠️ Assembled-image wiring: `@lumenize/nebula/frontend` is a private workspace package
 * (not on npm), so it is VENDORED into the container image at image build — the seed
 * App.vue boots standalone (doesn't import this file) so the image self-validates
 * vite+HMR without the factory; the Galaxy seeds an App.vue into its own source tree
 * at git-init that imports `{ client, store }` from here, and the container's
 * `/workspace` IS that tree (a FUSE mount of the DO's VFS — there is no push step).
 * The assembled preview (factory + live Star) rides the e2e run with `wrangler dev` + Docker Desktop.
 */
// @ts-expect-error — vendored at deploy build (see header); unresolved in the baked tree.
import { createNebulaClient } from '@lumenize/nebula/frontend';

interface NebulaScope {
  activeScope: string; // {u}.{g}.dev in dev; the deployed star in prod
  authScope: string;   // parent galaxy {u}.{g}
  // ABSENT until an ontology is applied. An app with no resources never needs one and boots
  // without it; the resource plane refuses per op with NoOntologyInstalledError.
  ontologyVersion?: string;
}

function readInjectedScope(): NebulaScope {
  const content = document
    .querySelector('meta[name="nebula-scope"]')
    ?.getAttribute('content');
  if (!content) throw new Error('nebula-scope meta missing — serving layer did not inject scope');
  return JSON.parse(content) as NebulaScope;
}

const { activeScope, authScope, ontologyVersion } = readInjectedScope();

export const { client, store, ready } = createNebulaClient({
  ontologyVersion,
  authScope,
  activeScope,
});

try {
  await ready;
} catch {
  window.location.assign('/login');
}
