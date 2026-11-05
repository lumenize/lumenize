/**
 * @lumenize/resources/frontend — the Vue-reactive client entry point.
 *
 * The vue-dependent half of the client: `createNebulaClient` (the reactive factory wrapping
 * NebulaClient), `textMerge`, and the conflict-outcome types. Pulls in `vue` — bundle this into the
 * browser app (Studio's build, a generated app's), NOT the Worker, which imports only the server
 * entry and so never reaches `vue`.
 *
 * For the vue-FREE client surface (headless NebulaClient + resource and org-tree types), use
 * `@lumenize/resources/client`. This entry re-exports all of it, so `/frontend` is a superset. A
 * page's deployment and host grammar are Mesh's, at `@lumenize/mesh/client`.
 */

// vue-free client surface: NebulaClient, the canonical Snapshot/SnapshotMeta + resource wire
// types, org-ops, ontology config.
export * from './client-index';

// Vue-reactive factory + helpers (this entry pulls in `vue`).
export { createNebulaClient } from './frontend/create-nebula-client';
export type { CreateNebulaClientConfig, FactoryResult, NebulaClientClass } from './frontend/create-nebula-client';
export type { Middleware, WriteContext } from './frontend/types';
export { textMerge, makeLongformResolver } from './frontend/text-merge';
export type { ConflictResolverVerdict } from './frontend/text-merge';
export type { TransactionOutcome, TransactionResourceResolution, ResourceHandler } from './frontend/conflict-outcome';
