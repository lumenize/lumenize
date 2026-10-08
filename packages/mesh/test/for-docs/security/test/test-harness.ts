/**
 * Test harness for security e2e tests using @lumenize/testing
 *
 * This instruments the DOs to enable createTestingClient to access
 * storage and other internals for test assertions.
 */

import * as sourceModule from '../index.js';
import { instrumentDOProject } from '@lumenize/testing';

// Instrument the DOs
const instrumented = instrumentDOProject({
  sourceModule,
  doClassNames: ['WorkspaceDO', 'UserProfileDO', 'TeamDocDO', 'GatePairDO'],
});

// Re-export instrumented DOs for wrangler bindings
export const { WorkspaceDO, UserProfileDO, TeamDocDO, GatePairDO } = instrumented.dos;

// Mesh's auth, which every Client here logs in through, re-exported as it is
export { AuthRegistry, Profile, AuthFacade } from '../index.js';

// Re-export the instrumented default export (worker handler)
export default instrumented;
