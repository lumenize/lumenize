/**
 * Simple test Durable Object for validating createTestingClient
 */
import { DurableObject } from 'cloudflare:workers';

export class TestDO extends DurableObject {
  alarmFiredCount: number = 0;
  lastAlarmPayload: any = null;

  /**
   * Increment a counter in storage
   */
  async increment(): Promise<number> {
    const count = (await this.ctx.storage.get<number>('count')) ?? 0;
    const newCount = count + 1;
    await this.ctx.storage.put('count', newCount);
    return newCount;
  }

  /**
   * Get current count
   */
  async getCount(): Promise<number> {
    return (await this.ctx.storage.get<number>('count')) ?? 0;
  }

  /**
   * Reset count to zero
   */
  async reset(): Promise<void> {
    await this.ctx.storage.put('count', 0);
  }

  /**
   * Echo back the input
   */
  echo(input: string): string {
    return `Echo: ${input}`;
  }

  /**
   * Return a complex object
   */
  getComplexObject() {
    return {
      nested: {
        value: 42,
        array: [1, 2, 3]
      },
      timestamp: Date.now()
    };
  }

  /**
   * Test accessing ctx.id
   */
  getId(): string {
    return this.ctx.id.toString();
  }

  /**
   * Test accessing ctx.storage
   */
  async setCustomKey(key: string, value: any): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  /**
   * Test accessing ctx.storage
   */
  async getCustomKey(key: string): Promise<any> {
    return await this.ctx.storage.get(key);
  }

  /**
   * Required alarm handler
   */
  async alarm(): Promise<void> {
    this.alarmFiredCount++;
    this.lastAlarmPayload = { fired: true, count: this.alarmFiredCount };
  }

  /**
   * Get alarm fire count
   */
  getAlarmFiredCount(): number {
    return this.alarmFiredCount;
  }

  /**
   * Get last alarm payload
   */
  getLastAlarmPayload(): any {
    return this.lastAlarmPayload;
  }

  /**
   * Schedule an alarm
   */
  scheduleAlarm(delayMs: number): void {
    this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /**
   * Basic fetch handler (for non-RPC requests)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/test') {
      return new Response('Test endpoint');
    }
    
    return new Response('Not found', { status: 404 });
  }
}

