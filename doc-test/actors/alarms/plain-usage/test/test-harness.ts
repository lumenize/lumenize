import * as sourceModule from '../src';
import { instrumentDOProject } from '@lumenize/testing';

// Instrument with 1x timescale for Actor Alarms (they call setAlarm internally many times)
const instrumented = instrumentDOProject({
  sourceModule,
  doClassNames: ['AlarmDO'],
  simulateAlarms: { timeScale: 1 }  // 1x speed - real-time alarms
});

export const { AlarmDO } = instrumented.dos;
export default instrumented;

