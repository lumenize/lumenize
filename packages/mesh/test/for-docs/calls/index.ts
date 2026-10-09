/**
 * Worker entry point for calls.mdx examples
 *
 * Re-exports the classes its wrangler bindings name, and routes Mesh's auth and each Client's
 * upgrade: a page on `acme.lumenize.localhost` connects to the `WorkspaceDO` named `acme`.
 */

import { ScopedMeshDO } from '../../../src/index.js';
import { authFacadeFor, meshTestFetch } from '../../support/test-auth.js';
import { defineRoutes } from '../../../src/routes.js';

export { AuthRegistry, Profile } from '../../support/test-auth.js';
export { DocumentDO } from './document-do.js';
export { CalculatorDO } from './calculator-do.js';
export { SpellCheckWorker, type SpellFinding } from './spell-check-worker.js';
export { AnalyticsWorker, type AnalyticsResult } from './analytics-worker.js';

/** A workspace's node, named by its scope: it hosts the Clients on the workspace's pages. */
export class WorkspaceDO extends ScopedMeshDO<Env> {}

/** Every tier of scope is a workspace here. */
const TIERS = { universe: 'WORKSPACE_DO', galaxy: 'WORKSPACE_DO', star: 'WORKSPACE_DO' } as const;

/**
 * Every binding this app's Clients may name; any other is refused at its host's Gateway. Typed
 * against this Worker's own bindings, which Mesh's shared generated `Env` does not carry.
 */
defineRoutes<Env & { CALCULATOR_DO: DurableObjectNamespace; ANALYTICS_WORKER: Fetcher }>({
  WORKSPACE_DO: { tier: ['universe', 'galaxy', 'star'], hosts: true },
  DOCUMENT_DO: 'unscoped',
  CALCULATOR_DO: 'unscoped',
  SPELLCHECK_WORKER: 'worker',
  ANALYTICS_WORKER: 'worker',
  PROFILE: 'unscoped',
  AUTH_FACADE: 'worker',
});

export const AuthFacade = authFacadeFor(TIERS);

export default {
  fetch: meshTestFetch(TIERS),
};
