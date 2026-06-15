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
 * For the vue-FREE client surface (headless NebulaClient + resource/dag types),
 * use `@lumenize/nebula/client`. This entry re-exports all of it, so `/frontend`
 * is a superset.
 */

// vue-free client surface: NebulaClient, the canonical Snapshot/SnapshotMeta +
// resource wire types, dag-ops, ontology config.
export * from './client-index';

// Vue-reactive factory + helpers (this entry pulls in `vue`).
export { createNebulaClient } from './frontend/create-nebula-client';
export type { CreateNebulaClientConfig, FactoryResult } from './frontend/create-nebula-client';
export type { Middleware, WriteContext } from './frontend/types';
export { textMerge, makeLongformResolver } from './frontend/text-merge';
export type { ConflictResolverVerdict } from './frontend/text-merge';
// `Snapshot` is the canonical `resources.Snapshot` (re-exported above via
// ./client-index). conflict-outcome.ts still carries its own minimal `Snapshot`
// internally; reconcile it to `resources.Snapshot` during the factory
// integration (Phase 6/7) — see tasks/nebula-frontend.md.
export type { TransactionOutcome, TransactionResourceResolution, ResourceHandler } from './frontend/conflict-outcome';
