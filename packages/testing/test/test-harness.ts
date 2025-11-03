import * as sourceModule from './test-do';
import * as actorAlarmsModule from './actor-alarms-do';
import * as myDOModule from './for-docs/alarm-simulation/MyDO';
import * as schedulerDOModule from './for-docs/alarm-simulation/SchedulerDO';
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

// Instrument pedagogical DOs for documentation examples
const myDOInstrumented = instrumentDOProject({
  sourceModule: myDOModule,
  doClassNames: ['MyDO']
});

const schedulerDOInstrumented = instrumentDOProject({
  sourceModule: schedulerDOModule,
  doClassNames: ['SchedulerDO'],
  simulateAlarms: { timeScale: 1 }  // 1x speed for Actor Alarms
});

export const { TestDO: TestDOWithRpc } = dos;
export const { ActorAlarmsDO } = actorInstrumented.dos;
export const { MyDO } = myDOInstrumented.dos;
export const { SchedulerDO } = schedulerDOInstrumented.dos;
export default worker;
