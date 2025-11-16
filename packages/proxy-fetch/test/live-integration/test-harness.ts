/**
 * Test harness for live integration testing
 * Instruments DOs from test-worker-and-dos.ts
 */
import * as sourceModule from './test-worker-and-dos';
import { instrumentDOProject } from '@lumenize/testing';

const { worker, dos } = instrumentDOProject({
  sourceModule,
  doClassNames: ['TestDO', 'FetchOrchestrator'],
  simulateAlarms: true  // 100x speedup - tests run in ~600ms instead of ~3s
});

// Re-export the instrumented DOs for type imports
export const { TestDO, FetchOrchestrator } = dos;

// Re-export FetchExecutorEntrypoint (not a DO, so not instrumented)
export { FetchExecutorEntrypoint } from './test-worker-and-dos';

// Export the instrumented worker as default
export default worker;

