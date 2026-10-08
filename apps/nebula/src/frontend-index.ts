/**
 * @lumenize/nebula/frontend — Vue-reactive client entry point.
 *
 * The vue-dependent half of the Nebula client: `createNebulaClient` (the
 * reactive factory wrapping NebulaClient), `textMerge`, and the conflict-outcome
 * types. Pulls in `vue` — bundle this into the browser app (Studio's compile /
 * a consumer bundler), NOT the Worker. `wrangler deploy` bundles the server
 * entry (`@lumenize/nebula`), which never imports this file, so vue tree-shakes
 * out of the Worker.
 *
 * For the vue-FREE client surface (headless NebulaClient + resource and org-tree types),
 * use `@lumenize/nebula/client`. This entry re-exports all of it, so `/frontend`
 * is a superset.
 */

// vue-free client surface: NebulaClient, the canonical Snapshot/SnapshotMeta +
// resource wire types, org-ops, ontology config.
export * from './client-index';

// What a served page knows about its deployment, and the host grammar that turns its host into a
// scope — for a page that navigates between hosts (Studio, the auth app).
export { deploymentOriginOfPage, platformOriginOf } from './page-origin';
export { parseHost, hostOrigin, checkedReturnTo, isAtOrAbove } from '@lumenize/mesh/client';
export type { HostTarget } from '@lumenize/mesh/client';

// Vue-reactive factory + helpers (this entry pulls in `vue`).
export { createNebulaClient } from './frontend/create-nebula-client';
export type { CreateNebulaClientConfig, FactoryResult, NebulaClientClass } from './frontend/create-nebula-client';
export type { Middleware, WriteContext } from './frontend/types';
export { textMerge, makeLongformResolver } from './frontend/text-merge';
export type { ConflictResolverVerdict } from './frontend/text-merge';
// `Snapshot` is the canonical `resources.Snapshot` (re-exported above via
// ./client-index). conflict-outcome.ts still carries its own minimal `Snapshot`
// internally; reconcile it to `resources.Snapshot` during the factory
// integration (Phase 6/7) — see tasks/nebula-frontend.md.
export type { TransactionOutcome, TransactionResourceResolution, ResourceHandler } from './frontend/conflict-outcome';
