/**
 * Pedagogical test showing LumenizeBase alarms pattern
 * Referenced in website/docs/alarms/index.mdx
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import '@lumenize/core';    // Registers sql in this.svc
import '@lumenize/alarms';  // Registers alarms in this.svc (depends on sql)
import { LumenizeBase } from '@lumenize/lumenize-base';
import type { Schedule } from '@lumenize/alarms';

class MyDO extends LumenizeBase<any> {
  // Required boilerplate. Delegates standard `alarm()` handler to Alarms
  async alarm() {
    await this.svc.alarms.alarm();
  }
  
  scheduleTask() {
    this.svc.alarms.schedule(60, 'handleTask', { data: 'example' });
  }
  
  handleTask(payload: any, schedule: Schedule) {
    console.log('Task executed:', payload);
  }
}

export { MyDO };

describe('Alarms LumenizeBase Pattern', () => {
  it('demonstrates auto-injection usage', async () => {
    const stub = env.MY_DO.getByName('lumenize-base-test');
    await stub.scheduleTask();
    // Alarm scheduled successfully
  });
});

