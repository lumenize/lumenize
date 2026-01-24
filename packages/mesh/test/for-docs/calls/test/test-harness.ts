/**
 * Test harness for mesh e2e tests using @lumenize/testing
 *
 * This instruments the DOs to enable createTestingClient to access
 * storage and other internals for test assertions.
 */

import * as sourceModule from '../index.js';
import { instrumentDOProject } from '@lumenize/testing';

// Instrument the DOs - explicitly list the DO class names since
// the source module also exports non-DO classes (SpellCheckWorker is a WorkerEntrypoint)
const instrumented = instrumentDOProject({
  sourceModule,
  doClassNames: ['LumenizeClientGateway', 'DocumentDO', 'CalculatorDO', 'LumenizeAuth'],
});

// Re-export instrumented DOs for wrangler bindings
export const { LumenizeClientGateway, DocumentDO, CalculatorDO, LumenizeAuth } = instrumented.dos;

// Re-export SpellCheckWorker directly (it's a WorkerEntrypoint, not a DO)
export { SpellCheckWorker } from '../spell-check-worker.js';

// Re-export the instrumented default export (worker handler)
export default instrumented;
