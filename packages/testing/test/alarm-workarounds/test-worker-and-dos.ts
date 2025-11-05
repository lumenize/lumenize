/**
 * Test worker and DOs for alarm-workarounds pedagogical tests
 * Exports instrumented worker with RPC support
 */
import * as sourceModule from './alarm-test-do';
import { instrumentDOProject } from '../../src/instrument-do-project';

const { worker, dos } = instrumentDOProject({
  sourceModule,
  doClassNames: ['AlarmTestDO'],
  simulateAlarms: false  // Don't simulate - we'll use triggerAlarms() manually
});

// Re-export the AlarmTestDO for type imports
export const { AlarmTestDO } = dos;

// Export the instrumented worker as default
export default worker;

