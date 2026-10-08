/**
 * Worker entry point for security.mdx examples
 *
 * Re-exports the classes its wrangler bindings name, and routes Mesh's auth and each Client's
 * upgrade: a page on `acme.lumenize.localhost` connects to the `WorkspaceDO` named `acme`. The
 * upgrade refuses a missing token (401), one that does not verify (403), one for another host's
 * scope, and an id that does not begin with the token's `sub`, before any node wakes.
 */

import { ScopedMeshDO } from '../../../src/index.js';
import { authFacadeFor, meshTestFetch } from '../../support/test-auth.js';

export { AuthRegistry, Profile } from '../../support/test-auth.js';
export { UserProfileDO } from './user-profile-do.js';
export { TeamDocDO } from './team-doc-do.js';
export { GatePairDO } from './gate-pair-do.js';

/** A workspace's node, named by its scope: it hosts the Clients on the workspace's pages. */
export class WorkspaceDO extends ScopedMeshDO<Env> {}

/** Every tier of scope is a workspace here. */
const TIERS = { universe: 'WORKSPACE_DO', galaxy: 'WORKSPACE_DO', star: 'WORKSPACE_DO' } as const;

export const AuthFacade = authFacadeFor(TIERS);

export default {
  fetch: meshTestFetch(TIERS),
};
