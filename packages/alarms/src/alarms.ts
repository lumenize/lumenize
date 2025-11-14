// Adapted from @cloudflare/actors Alarms package
// Source: https://github.com/cloudflare/actors/tree/e910e86ac1567fe58e389d1938afbdf1e53750ff/packages/alarms
// License: Apache-2.0 (https://github.com/cloudflare/actors/blob/main/LICENSE)
// Modifications: Complete rewrite to use OCAN (Operation Chaining And Nesting),
// NADIS dependency injection pattern, lazy table initialization, TypeScript generics

import { parseCronExpression } from 'cron-schedule';
import { debug, executeOperationChain, getOperationChain } from '@lumenize/core';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { ulidFactory } from 'ulid-workers';
import type { sql as sqlType, DebugLogger, OperationChain } from '@lumenize/core';
import type { Schedule } from './types.js';

// Create monotonic ULID generator for FIFO ordering
const ulid = ulidFactory({ monotonic: true });

function getNextCronTime(cron: string): Date {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}

/**
 * Alarms - Powerful alarm scheduling for Cloudflare Durable Objects
 * 
 * Supports one-time alarms, delayed alarms, and recurring cron schedules.
 * All alarms are persisted to SQL storage and survive DO eviction.
 * Uses OCAN (Operation Chaining And Nesting) for type-safe callbacks.
 * 
 * @example
 * Standalone usage:
 * ```typescript
 * import { Alarms } from '@lumenize/alarms';
 * import { sql } from '@lumenize/core';
 * import { DurableObject } from 'cloudflare:workers';
 * 
 * class MyDO extends DurableObject {
 *   #alarms: Alarms;
 *   
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.#alarms = new Alarms(ctx, this, { sql: sql(this) });
 *   }
 *   
 *   // Required: delegate to Alarms
 *   async alarm() {
 *     await this.#alarms.alarm();
 *   }
 *   
 *   scheduleTask() {
 *     // Use OCAN to define what to execute
 *     const schedule = this.#alarms.schedule(
 *       60,  // 60 seconds from now
 *       this.ctn().handleTask({ data: 'example' })
 *     );
 *   }
 *   
 *   handleTask(payload: { data: string }) {
 *     console.log('Task executed:', payload);
 *   }
 * }
 * ```
 * 
 * @example
 * With LumenizeBase (auto-injected):
 * ```typescript
 * import '@lumenize/alarms';  // Registers alarms in this.svc
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   async alarm() {
 *     await this.svc.alarms.alarm();
 *   }
 *   
 *   scheduleTask() {
 *     const schedule = this.svc.alarms.schedule(
 *       60,
 *       this.ctn().handleTask({ data: 'example' })
 *     );
 *   }
 *   
 *   handleTask(payload: { data: string }) {
 *     console.log('Task executed:', payload);
 *   }
 * }
 * ```
 */
export class Alarms {
  #parent: any;
  #sql: ReturnType<typeof sqlType>;
  #storage: DurableObjectStorage;
  #tableInitialized = false;
  #log: DebugLogger;
  #ctx: DurableObjectState;

  constructor(
    ctx: DurableObjectState,
    doInstance: any,
    deps?: { sql?: ReturnType<typeof sqlType> }
  ) {
    this.#ctx = ctx;
    this.#parent = doInstance;
    this.#storage = ctx.storage;
    this.#log = debug(ctx)('lmz.alarms.Alarms');
    
    // Use provided sql or get from DO instance (NADIS pattern)
    if (deps?.sql) {
      this.#sql = deps.sql;
    } else if ('svc' in doInstance && doInstance.svc && 'sql' in doInstance.svc) {
      this.#sql = (doInstance.svc as any).sql;
    } else {
      throw new Error('Alarms requires sql injectable. Pass it in deps or use LumenizeBase.');
    }

    // Try to initialize in blockConcurrencyWhile if we're in constructor phase
    // This will fail silently if called outside constructor (lazy init case)
    try {
      void ctx.blockConcurrencyWhile(async () => {
        this.#ensureTable();
        // Execute any pending alarms and schedule the next alarm
        await this.alarm();
        this.#tableInitialized = true;
      });
    } catch (e) {
      // Outside constructor phase - will initialize lazily on first operation
    }
  }

  /**
   * Ensure the alarms table exists (idempotent)
   */
  #ensureTable(): void {
    if (this.#tableInitialized) {
      return;
    }

    try {
      this.#storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS __lmz_alarms (
          id TEXT PRIMARY KEY NOT NULL,
          operationChain TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')),
          time INTEGER NOT NULL,
          delayInSeconds INTEGER,
          cron TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `);
      this.#tableInitialized = true;
    } catch (e) {
      // Table might already exist or error creating - log and continue
      this.#log.error('Error ensuring alarms table', {
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined
      });
    }
  }

  /**
   * Schedule a task to be executed in the future.
   * 
   * **Synchronous:** Returns immediately after queuing. Uses blockConcurrencyWhile
   * internally for async preprocessing, ensuring safety without blocking user code.
   * 
   * @param when When to execute (Date, seconds delay, or cron expression)
   * @param continuation OCAN chain defining what to execute
   * @returns Schedule object representing the scheduled task
   * 
   * @example
   * ```typescript
   * // Delayed execution (60 seconds from now)
   * this.svc.alarms.schedule(60, this.ctn().handleTask({ data: 'example' }));
   * 
   * // Scheduled at specific time
   * this.svc.alarms.schedule(new Date('2025-12-31'), this.ctn().newYearTask());
   * 
   * // Recurring cron (every day at midnight)
   * this.svc.alarms.schedule('0 0 * * *', this.ctn().dailyTask());
   * 
   * // Chaining
   * this.svc.alarms.schedule(
   *   60,
   *   this.ctn().processData().logSuccess().notifyUser()
   * );
   * 
   * // Nesting
   * const data1 = this.ctn().getData(1);
   * const data2 = this.ctn().getData(2);
   * this.svc.alarms.schedule(
   *   60,
   *   this.ctn().combineData(data1, data2)
   * );
   * ```
   */
  schedule(
    when: Date | string | number,
    continuation: any
  ): Schedule {
    this.#ensureTable();
    
    // Extract operation chain from the continuation proxy
    const operationChain = getOperationChain(continuation);
    if (!operationChain) {
      throw new Error('Invalid continuation: must be created with newContinuation() or this.ctn()');
    }

    const id = ulid();  // Monotonic ULID for FIFO ordering

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);
      
      // Store asynchronously (fast preprocess, doesn't block return)
      this.#ctx.blockConcurrencyWhile(async () => {
        await this.#storeSchedule(id, operationChain, 'scheduled', timestamp, { time: timestamp });
        this.#scheduleNextAlarm();  // Inside block to avoid alarm scheduler conflicts
      });
      
      return {
        id,
        operationChain,
        time: timestamp,
        type: 'scheduled',
      };
    }

    if (typeof when === 'number') {
      const time = new Date(Date.now() + when * 1000);
      const timestamp = Math.floor(time.getTime() / 1000);
      
      // Store and schedule alarm (synchronously via blockConcurrencyWhile)
      // The async boundary is when the native alarm fires, not here
      this.#ctx.blockConcurrencyWhile(async () => {
        await this.#storeSchedule(id, operationChain, 'delayed', timestamp, { delayInSeconds: when });
        this.#scheduleNextAlarm();  // Inside block to avoid alarm scheduler conflicts
      });
      
      return {
        id,
        operationChain,
        delayInSeconds: when,
        time: timestamp,
        type: 'delayed',
      };
    }

    if (typeof when === 'string') {
      const nextExecutionTime = getNextCronTime(when);
      const timestamp = Math.floor(nextExecutionTime.getTime() / 1000);
      
      // Store asynchronously (fast preprocess, doesn't block return)
      this.#ctx.blockConcurrencyWhile(async () => {
        await this.#storeSchedule(id, operationChain, 'cron', timestamp, { cron: when });
        this.#scheduleNextAlarm();  // Inside block to avoid alarm scheduler conflicts
      });
      
      return {
        id,
        operationChain,
        cron: when,
        time: timestamp,
        type: 'cron',
      };
    }

    throw new Error('Invalid schedule type');
  }

  /**
   * Store a schedule in the database
   */
  async #storeSchedule(
    id: string,
    operationChain: OperationChain,
    type: 'scheduled' | 'delayed' | 'cron',
    time: number,
    extra: { delayInSeconds?: number; cron?: string; time?: number }
  ): Promise<void> {
    // Preprocess and serialize the operation chain
    const preprocessed = await preprocess(operationChain);
    const serialized = JSON.stringify(preprocessed);

    if (type === 'scheduled') {
      this.#sql`
        INSERT OR REPLACE INTO __lmz_alarms (id, operationChain, type, time)
        VALUES (${id}, ${serialized}, ${type}, ${time})
      `;
    } else if (type === 'delayed') {
      this.#sql`
        INSERT OR REPLACE INTO __lmz_alarms (id, operationChain, type, delayInSeconds, time)
        VALUES (${id}, ${serialized}, ${type}, ${extra.delayInSeconds!}, ${time})
      `;
    } else if (type === 'cron') {
      this.#sql`
        INSERT OR REPLACE INTO __lmz_alarms (id, operationChain, type, cron, time)
        VALUES (${id}, ${serialized}, ${type}, ${extra.cron!}, ${time})
      `;
    }
  }

  /**
   * Get a scheduled task by ID
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  async getSchedule(id: string): Promise<Schedule | undefined> {
    this.#ensureTable();
    
    const result = this.#sql`
      SELECT * FROM __lmz_alarms WHERE id = ${id}
    `;

    if (!result || result.length === 0) {
      return undefined;
    }

    const row = result[0];
    const operationChain = await postprocess(JSON.parse(row.operationChain));
    
    return { ...row, operationChain } as Schedule;
  }

  /**
   * Get scheduled tasks matching the given criteria
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   */
  async getSchedules(criteria: {
    id?: string;
    type?: 'scheduled' | 'delayed' | 'cron';
    timeRange?: {
      start?: Date;
      end?: Date;
    };
  } = {}): Promise<Schedule[]> {
    this.#ensureTable();
    
    let query = 'SELECT * FROM __lmz_alarms WHERE 1=1';
    const params: any[] = [];

    if (criteria.id) {
      query += ' AND id = ?';
      params.push(criteria.id);
    }

    if (criteria.type) {
      query += ' AND type = ?';
      params.push(criteria.type);
    }

    if (criteria.timeRange) {
      query += ' AND time >= ? AND time <= ?';
      const start = criteria.timeRange.start || new Date(0);
      const end = criteria.timeRange.end || new Date(999999999999999);
      params.push(
        Math.floor(start.getTime() / 1000),
        Math.floor(end.getTime() / 1000)
      );
    }

    const result = [...this.#storage.sql.exec(query, ...params)];
    
    // Deserialize operation chains
    const schedules = await Promise.all(
      result.map(async (row: any) => ({
        ...row,
        operationChain: await postprocess(JSON.parse(row.operationChain)),
      }))
    );

    return schedules as Schedule[];
  }

  /**
   * Cancel a scheduled task
   * @param id ID of the task to cancel
   * @returns true if the task was cancelled, false otherwise
   */
  cancelSchedule(id: string): boolean {
    this.#ensureTable();
    
    // Use blockConcurrencyWhile for consistency with schedule()
    this.#ctx.blockConcurrencyWhile(async () => {
      this.#sql`DELETE FROM __lmz_alarms WHERE id = ${id}`;
      this.#scheduleNextAlarm();
    });
    
    return true;
  }

  /**
   * Manually trigger execution of the next alarm(s) in chronological order.
   * 
   * This is useful for testing when alarm simulation timing is unreliable.
   * Call this method over RPC to force execution of pending alarms without
   * waiting for Cloudflare's native alarm to fire.
   * 
   * Triggers alarms in order by scheduled time, regardless of whether they're
   * overdue or scheduled in the future. This enables fast-forwarding through
   * alarm execution in tests.
   * 
   * @param count Number of alarms to trigger (default: all overdue, or next if none overdue)
   * @returns Array of executed alarm IDs
   * 
   * @example
   * ```typescript
   * // In tests - trigger all overdue alarms:
   * await stub.scheduleTask('task1', -5); // 5 seconds ago
   * await stub.scheduleTask('task2', -3); // 3 seconds ago
   * const executed = await stub.triggerAlarms();
   * expect(executed.length).toBe(2);
   * 
   * // Trigger next alarm even if in future:
   * await stub.scheduleTask('future', 60); // 60 seconds from now
   * const executed = await stub.triggerAlarms(1);
   * expect(executed.length).toBe(1);
   * ```
   */
  async triggerAlarms(count?: number): Promise<string[]> {
    this.#ensureTable();
    
    const now = Math.floor(Date.now() / 1000);
    const executedIds: string[] = [];

    // If count not specified, execute all overdue alarms, or 1 if none overdue
    if (count === undefined) {
      const overdueResult = this.#sql`
        SELECT COUNT(*) as count FROM __lmz_alarms WHERE time <= ${now}
      `;
      count = overdueResult[0]?.count ?? 1;
    }

    // Ensure count is a number (TypeScript narrowing)
    const actualCount: number = Number(count);

    // Execute the next 'count' alarms in chronological order
    for (let i = 0; i < actualCount; i++) {
      // Get the earliest scheduled alarm (regardless of time)
      // Use ULID id for FIFO ordering within same timestamp
      const result = this.#sql`
        SELECT * FROM __lmz_alarms 
        ORDER BY time ASC, id ASC 
        LIMIT 1
      `;

      if (!result || result.length === 0) {
        break; // No more alarms to execute
      }

      const row = result[0];

      try {
        // Deserialize and execute the operation chain
        const operationChain = await postprocess(JSON.parse(row.operationChain));
        await executeOperationChain(operationChain, this.#parent);
        executedIds.push(row.id);
      } catch (e) {
        this.#log.error('Error executing alarm', {
          id: row.id,
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined
        });
      }

      if (row.type === 'cron') {
        // Update next execution time for cron schedules
        const nextExecutionTime = getNextCronTime(row.cron);
        const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);
        this.#sql`
          UPDATE __lmz_alarms SET time = ${nextTimestamp} WHERE id = ${row.id}
        `;
      } else {
        // Delete one-time schedules after execution
        this.#sql`
          DELETE FROM __lmz_alarms WHERE id = ${row.id}
        `;
      }
    }

    // Schedule the next alarm
    await this.#scheduleNextAlarm();

    return executedIds;
  }

  /**
   * Alarm handler - must be called from DO's alarm() method
   */
  readonly alarm = async (alarmInfo?: AlarmInvocationInfo): Promise<void> => {
    // Execute all overdue alarms
    const now = Math.floor(Date.now() / 1000);
    const overdueResult = this.#sql`
      SELECT COUNT(*) as count FROM __lmz_alarms WHERE time <= ${now}
    `;
    const overdueCount = overdueResult[0]?.count || 0;
    
    if (overdueCount > 0) {
      await this.triggerAlarms(overdueCount);
    }
  };

  #scheduleNextAlarm(): void {
    // Find the next schedule that needs to be executed
    // Use ULID id for FIFO ordering within same timestamp
    const result = this.#sql`
      SELECT time FROM __lmz_alarms 
      WHERE time > ${Math.floor(Date.now() / 1000)}
      ORDER BY time ASC, id ASC 
      LIMIT 1
    `;

    if (!result || result.length === 0) {
      return;
    }

    if ('time' in result[0]) {
      const nextTime = (result[0].time as number) * 1000;
      this.#storage.setAlarm(nextTime);
    }
  }
}

// TypeScript declaration merging magic
// This augments the global LumenizeServices interface so TypeScript knows
// about this.svc.alarms when you import this package
declare global {
  interface LumenizeServices {
    alarms: Alarms;
  }
}

// Register service in global registry for LumenizeBase auto-injection
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}
(globalThis as any).__lumenizeServiceRegistry.alarms = (doInstance: any) => {
  // Auto-inject dependencies
  const deps: any = {};
  
  // Alarms needs sql - get it from doInstance.svc (will be cached by LumenizeBase)
  if (doInstance.svc && doInstance.svc.sql) {
    deps.sql = doInstance.svc.sql;
  }
  
  return new Alarms(doInstance.ctx, doInstance, deps);
};
