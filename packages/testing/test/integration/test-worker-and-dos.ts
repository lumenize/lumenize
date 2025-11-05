/**
 * Test worker and DOs for integration tests
 * Exports instrumented worker with RPC support
 */
import * as sourceModule from './test-do';
import { instrumentDOProject } from '../../src/instrument-do-project';

const { worker, dos } = instrumentDOProject({
  sourceModule,
  doClassNames: ['TestDO']
});

// Re-export the TestDO for type imports
export const { TestDO } = dos;

// Export the instrumented worker as default
export default worker;
