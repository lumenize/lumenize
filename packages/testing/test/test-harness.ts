import * as sourceModule from './test-do';
import * as actorAlarmsModule from './actor-alarms-do';
import { instrumentDOProject } from '../src/instrument-do-project';

const { worker, dos } = instrumentDOProject({
  sourceModule,
  doClassNames: ['TestDO']
});

// Also instrument the Actor Alarms DO for integration testing
// Use 1x timescale for Actor Alarms (it calls setAlarm hundreds of times internally)
const actorInstrumented = instrumentDOProject({
  sourceModule: actorAlarmsModule,
  doClassNames: ['ActorAlarmsDO'],
  simulateAlarms: { timeScale: 1 }  // 1x speed for Actor's internal behavior
});

export const { TestDO: TestDOWithRpc } = dos;
export const { ActorAlarmsDO } = actorInstrumented.dos;
export default worker;
