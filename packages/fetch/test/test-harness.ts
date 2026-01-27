/**
 * Test harness for proxy-fetch integration tests
 * Instruments DOs for coverage tracking
 */
import * as sourceModule from './test-worker-and-dos';
import { FetchExampleDO as _FetchExampleDO } from './for-docs/fetch-example-do';
import { RetryExampleDO as _RetryExampleDO } from './for-docs/retry-example-do';
import { instrumentDOProject } from '@lumenize/testing';

// Instrument DOs for coverage tracking
const { dos, worker } = instrumentDOProject({
  doClassNames: ['TestSimpleDO'],
  sourceModule
});

// Re-export the instrumented DOs for type imports
export const { TestSimpleDO } = dos;

// Instrument for-docs DOs separately (they're in different files)
const forDocsInstrumented = instrumentDOProject({
  doClassNames: ['FetchExampleDO', 'RetryExampleDO'],
  sourceModule: { FetchExampleDO: _FetchExampleDO, RetryExampleDO: _RetryExampleDO }
});
export const { FetchExampleDO, RetryExampleDO } = forDocsInstrumented.dos;

// Re-export FetchExecutorEntrypoint (not a DO, so not instrumented)
export { FetchExecutorEntrypoint } from './test-worker-and-dos';

// Import and re-export TestEndpointsDO for in-process testing
export { TestEndpointsDO } from '@lumenize/test-endpoints';

// Export the worker (with instrumented DOs) as default
export default worker;
