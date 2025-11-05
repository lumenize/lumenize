/**
 * Test worker and DOs for alarm-simulation pedagogical tests
 * Exports instrumented worker with RPC support and alarm simulation
 */
import * as myDOModule from './my-do';
import * as schedulerDOModule from './scheduler-do';
import { instrumentDOProject } from '../../src/instrument-do-project';

// Instrument MyDO with default 100x alarm speedup
const myDOInstrumented = instrumentDOProject({
  sourceModule: myDOModule,
  doClassNames: ['MyDO']
});

// Instrument SchedulerDO with 1x speed for Actor Alarms
const schedulerDOInstrumented = instrumentDOProject({
  sourceModule: schedulerDOModule,
  doClassNames: ['SchedulerDO'],
  simulateAlarms: { timeScale: 1 }  // 1x speed for Actor Alarms
});

// Re-export the DOs for type imports
export const { MyDO } = myDOInstrumented.dos;
export const { SchedulerDO } = schedulerDOInstrumented.dos;

// Export a combined worker that handles both
export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    
    // Route to appropriate DO worker
    if (url.pathname.includes('/MY_DO/')) {
      return myDOInstrumented.worker.fetch(request, env, ctx);
    }
    if (url.pathname.includes('/SCHEDULER_DO/')) {
      return schedulerDOInstrumented.worker.fetch(request, env, ctx);
    }
    
    return new Response('Not found', { status: 404 });
  }
};

