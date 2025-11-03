/**
 * Simple test Durable Object for validating createTestingClient
 */
export class TestDO {
  ctx: DurableObjectState;
  env: Env;
  alarmFiredCount: number = 0;
  lastAlarmPayload: any = null;
  
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

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
   * Alarm handler - required for alarm testing
   */
  async alarm(): Promise<void> {
    this.alarmFiredCount++;
    this.lastAlarmPayload = await this.ctx.storage.get('alarmPayload');
  }

  /**
   * Schedule an alarm (for testing alarm functionality)
   */
  scheduleAlarm(delayMs: number, payload?: any): void {
    const scheduledTime = Date.now() + delayMs;
    this.ctx.storage.setAlarm(scheduledTime);
    if (payload !== undefined) {
      this.ctx.storage.kv.put('alarmPayload', payload);
    }
  }

  /**
   * Get alarm state for testing
   */
  getAlarmState(): { firedCount: number; lastPayload: any; scheduledTime: number | null } {
    // Our mock getAlarm() is synchronous, but TypeScript sees the base type as async
    // Cast to synchronous version since we know our simulation is synchronous
    const scheduledTime = (this.ctx.storage.getAlarm as any)() as number | null;
    return {
      firedCount: this.alarmFiredCount,
      lastPayload: this.lastAlarmPayload,
      scheduledTime: scheduledTime
    };
  }

  /**
   * Test method to verify clock and setTimeout behavior
   */
  testClockAndSetTimeout(events: string[]): void {
    const t1 = Date.now();
    events.push(`start:${t1}`);
    
    // Synchronous work - clock stays frozen in DO
    const t2 = Date.now();
    events.push(`after-sync:${t2}`);
    
    // setTimeout - should still work
    setTimeout(() => {
      const t3 = Date.now();
      events.push(`in-setTimeout:${t3}`);
    }, 100);
  }

  /**
   * Test if ctx.storage methods are mutable (can be overridden)
   * This tests from INSIDE the DO, not via RPC
   */
  testStorageMutability(): { 
    setAlarmMutable: boolean; 
    getAlarmMutable: boolean; 
    deleteAlarmMutable: boolean;
    error?: string;
  } {
    try {
      let setAlarmCalled = false;
      let getAlarmCalled = false;
      let deleteAlarmCalled = false;
      
      // Save original methods
      const originalSetAlarm = this.ctx.storage.setAlarm.bind(this.ctx.storage);
      const originalGetAlarm = this.ctx.storage.getAlarm.bind(this.ctx.storage);
      const originalDeleteAlarm = this.ctx.storage.deleteAlarm.bind(this.ctx.storage);
      
      // Try to override setAlarm
      try {
        (this.ctx.storage as any).setAlarm = (time: number) => {
          setAlarmCalled = true;
          return originalSetAlarm(time);
        };
        
        // Test if it worked
        this.ctx.storage.setAlarm(Date.now() + 1000);
        
      } catch (e) {
        // If assignment threw, it's not mutable
      }
      
      // Try to override getAlarm
      try {
        (this.ctx.storage as any).getAlarm = () => {
          getAlarmCalled = true;
          return originalGetAlarm();
        };
        
        // Test if it worked
        this.ctx.storage.getAlarm();
        
      } catch (e) {
        // If assignment threw, it's not mutable
      }
      
      // Try to override deleteAlarm
      try {
        (this.ctx.storage as any).deleteAlarm = () => {
          deleteAlarmCalled = true;
          return originalDeleteAlarm();
        };
        
        // Test if it worked
        this.ctx.storage.deleteAlarm();
        
      } catch (e) {
        // If assignment threw, it's not mutable
      }
      
      // Restore originals (if they were overridable)
      if (setAlarmCalled) {
        (this.ctx.storage as any).setAlarm = originalSetAlarm;
      }
      if (getAlarmCalled) {
        (this.ctx.storage as any).getAlarm = originalGetAlarm;
      }
      if (deleteAlarmCalled) {
        (this.ctx.storage as any).deleteAlarm = originalDeleteAlarm;
      }
      
      return {
        setAlarmMutable: setAlarmCalled,
        getAlarmMutable: getAlarmCalled,
        deleteAlarmMutable: deleteAlarmCalled
      };
      
    } catch (error: any) {
      return {
        setAlarmMutable: false,
        getAlarmMutable: false,
        deleteAlarmMutable: false,
        error: error?.message || String(error)
      };
    }
  }

  /**
   * Fetch handler for HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname.endsWith('/increment')) {
      const count = await this.increment();
      return new Response(count.toString());
    }
    
    if (url.pathname.endsWith('/count')) {
      const count = await this.getCount();
      return new Response(count.toString());
    }
    
    return new Response('Not found', { status: 404 });
  }
}

// No default worker export for this test module
export default {};
