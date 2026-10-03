/**
 * nebula.ts — the scaffolded bootstrap. The ONE framework file the Studio engine may
 * extend (per-type conflict resolvers, first-run resource bootstrap). Components
 * import `{ client, store }` from here; NebulaClient never appears in component code.
 *
 * The page names no scope: the client takes it from its first token, which the platform host's
 * refresh mints for this page's host. The Galaxy's serve injects `<meta name="nebula-scope">` into
 * the shell (the ontology version this app was built against, whether it is the dev Star, and the
 * Studio origin a framed page reports to) and `<meta name="lumenize-origin">`; the factory reads
 * the second itself.
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

const { ontologyVersion } = readInjectedScope();

// With no session, the factory sends a top-level page to log in and brings it back here, and a
// page framed in Studio tells Studio instead; `ready` rejects either way.
export const { client, store, ready } = createNebulaClient({ ontologyVersion });

await ready.catch(() => { /* the factory has already acted on it */ });
