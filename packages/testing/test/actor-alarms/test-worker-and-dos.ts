/**
 * Test worker and DOs for actor-alarms integration tests
 * Exports instrumented worker with RPC support
 */
import * as sourceModule from './actor-alarms-do';
import { instrumentDOProject } from '../../src/instrument-do-project';

const { worker, dos } = instrumentDOProject({
  sourceModule,
  doClassNames: ['ActorAlarmsDO'],
  simulateAlarms: { timeScale: 1 }  // 1x speed for Actor's internal behavior
});

// Re-export the ActorAlarmsDO for type imports
export const { ActorAlarmsDO } = dos;

// Export the instrumented worker as default
export default worker;

