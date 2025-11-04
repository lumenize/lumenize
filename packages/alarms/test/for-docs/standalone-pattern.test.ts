/**
 * Pedagogical test showing standalone alarms pattern
 * Referenced in website/docs/alarms/index.mdx
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { env } from 'cloudflare:test';
import { Alarms, type Schedule } from '@lumenize/alarms';
import { sql } from '@lumenize/core';
import { DurableObject } from 'cloudflare:workers';

class MyDO extends DurableObject {
  #alarms: Alarms;
  
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.#alarms = new Alarms(ctx, this, { sql: sql(this) });
  }
  
  // Required boilerplate. Delegates standard `alarm()` handler to Alarms
  async alarm() {
    await this.#alarms.alarm();
  }
  
  scheduleTask() {
    this.#alarms.schedule(60, 'handleTask', { data: 'example' });
  }
  
  handleTask(payload: any, schedule: Schedule) {
    console.log('Task executed:', payload);
  }
}

export { MyDO };

describe('Alarms Standalone Pattern', () => {
  it('demonstrates standalone usage', async () => {
    const stub = env.MY_DO.getByName('standalone-test');
    await stub.scheduleTask();
    // Alarm scheduled successfully
  });
});

