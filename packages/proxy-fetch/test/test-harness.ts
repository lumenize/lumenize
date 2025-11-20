/**
 * Test harness for proxy-fetch integration tests
 * Instruments DOs for coverage tracking
 */
import * as sourceModule from './test-worker-and-dos';
import { instrumentDOProject } from '@lumenize/testing';

// Instrument DOs for coverage tracking
const { dos, worker } = instrumentDOProject({
  doClassNames: ['TestSimpleDO'],
  sourceModule
});

// Re-export the instrumented DOs for type imports
export const { TestSimpleDO } = dos;

// Re-export FetchExecutorEntrypoint (not a DO, so not instrumented)
export { FetchExecutorEntrypoint } from './test-worker-and-dos';

// Import and re-export TestEndpointsDO for in-process testing
export { TestEndpointsDO } from '@lumenize/test-endpoints';

// Export the worker (with instrumented DOs) as default
export default worker;
