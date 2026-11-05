/**
 * Test worker and DOs for integration tests
 * Exports instrumented worker with RPC support
 */
import * as sourceModule from './test-do';
import { instrumentDOProject } from '../../src/instrument-do-project';

const { worker, dos } = instrumentDOProject({
  sourceModule,
  doClassNames: ['TestDO', 'InstanceHandlerDO']
});

// Re-export the DO classes for wrangler bindings and type imports
export const { TestDO, InstanceHandlerDO } = dos;

// Export the instrumented worker as default
export default worker;
