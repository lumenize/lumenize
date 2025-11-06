// Adapted from @cloudflare/actors Alarms package
// Source: https://github.com/cloudflare/actors/tree/e910e86ac1567fe58e389d1938afbdf1e53750ff/packages/alarms
// License: Apache-2.0 (https://github.com/cloudflare/actors/blob/main/LICENSE)
// Modifications: Adapted for NADIS dependency injection pattern, lazy table initialization,
// removed actor-specific dependencies, added TypeScript generics for type safety

import { parseCronExpression } from 'cron-schedule';
import { nanoid } from 'nanoid';
import type { sql as sqlType } from '@lumenize/core';

/**
 * Represents a scheduled task within a Durable Object
 * @template T Type of the payload data
 * @template K Type of the callback
 */
export type Schedule<T = string, K extends keyof any = string> = {
  /** Unique identifier for the schedule */
  id: string;
  /** Name of the method to be called */
  callback: K;
  /** Data to be passed to the callback */
  payload: T;
} & (
  | {
      /** Type of schedule for one-time execution at a specific time */
      type: 'scheduled';
      /** Timestamp when the task should execute */
      time: number;
    }
  | {
      /** Type of schedule for delayed execution */
      type: 'delayed';
      /** Timestamp when the task should execute */
      time: number;
      /** Number of seconds to delay execution */
      delayInSeconds: number;
    }
  | {
      /** Type of schedule for recurring execution based on cron expression */
      type: 'cron';
      /** Timestamp for the next execution */
      time: number;
      /** Cron expression defining the schedule */
      cron: string;
    }
);

function getNextCronTime(cron: string): Date {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}

/**
 * Alarms - Powerful alarm scheduling for Cloudflare Durable Objects
 * 
 * Supports one-time alarms, delayed alarms, and recurring cron schedules.
 * All alarms are persisted to SQL storage and survive DO eviction.
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
 *     this.#alarms.schedule(60, 'handleTask', { data: 'example' });
 *   }
 *   
 *   handleTask(payload: any, schedule: Schedule) {
 *     console.log('Task executed:', payload);
 *   }
 * }
 * ```
 * 
 * @example
 * With LumenizeBase (auto-injected):
 * ```typescript
 * import '@lumenize/alarms';  // Registers alarms in this.svc
 * // You could also do this: import { Alarms } from '@lumenize/alarms';
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   async alarm() {
 *     await this.svc.alarms.alarm();
 *   }
 *   
 *   scheduleTask() {
 *     this.svc.alarms.schedule(60, 'handleTask', { data: 'example' });
 *   }
 *   
 *   handleTask(payload: any, schedule: Schedule) {
 *     console.log('Task executed:', payload);
 *   }
 * }
 * ```
 */
export class Alarms<P extends { [key: string]: any }> {
  #parent: P;
  #sql: ReturnType<typeof sqlType>;
  #storage: DurableObjectStorage;
  #tableInitialized = false;

  constructor(
    ctx: DurableObjectState,
    doInstance: P,
    deps?: { sql?: ReturnType<typeof sqlType> }
  ) {
    this.#parent = doInstance;
    this.#storage = ctx.storage;
    
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
        CREATE TABLE IF NOT EXISTS _lumenize_alarms (
          id TEXT PRIMARY KEY NOT NULL,
          callback TEXT NOT NULL,
          payload TEXT NOT NULL,
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
      // TODO: Fix wrong log format - should use object: { error: e }
      console.error('Error ensuring alarms table:', e);
    }
  }

  /**
   * Schedule a task to be executed in the future
   * @template T Type of the payload data
   * @param when When to execute the task (Date, seconds delay, or cron expression)
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @returns Schedule object representing the scheduled task
   */
  schedule<T = string>(
    when: Date | string | number,
    callback: keyof P & string,
    payload?: T
  ): Schedule<T, keyof P> {
    this.#ensureTable();
    
    const id = nanoid(9);

    if (typeof callback !== 'string') {
      throw new Error('Callback must be a string');
    }

    if (typeof this.#parent[callback] !== 'function') {
      throw new Error(`this.#parent.${callback} is not a function`);
    }

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);
      this.#sql`
        INSERT OR REPLACE INTO _lumenize_alarms (id, callback, payload, type, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'scheduled', ${timestamp})
      `;
      this.#scheduleNextAlarm();
      return {
        id,
        callback: callback as keyof P,
        payload: payload as T,
        time: timestamp,
        type: 'scheduled',
      };
    }

    if (typeof when === 'number') {
      const time = new Date(Date.now() + when * 1000);
      const timestamp = Math.floor(time.getTime() / 1000);
      this.#sql`
        INSERT OR REPLACE INTO _lumenize_alarms (id, callback, payload, type, delayInSeconds, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'delayed', ${when}, ${timestamp})
      `;
      this.#scheduleNextAlarm();
      return {
        id,
        callback: callback as keyof P,
        payload: payload as T,
        delayInSeconds: when,
        time: timestamp,
        type: 'delayed',
      };
    }

    if (typeof when === 'string') {
      const nextExecutionTime = getNextCronTime(when);
      const timestamp = Math.floor(nextExecutionTime.getTime() / 1000);
      this.#sql`
        INSERT OR REPLACE INTO _lumenize_alarms (id, callback, payload, type, cron, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'cron', ${when}, ${timestamp})
      `;
      this.#scheduleNextAlarm();
      return {
        id,
        callback: callback as keyof P,
        payload: payload as T,
        cron: when,
        time: timestamp,
        type: 'cron',
      };
    }

    throw new Error('Invalid schedule type');
  }

  /**
   * Get a scheduled task by ID
   * @template T Type of the payload data
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  getSchedule<T = string>(id: string): Schedule<T> | undefined {
    this.#ensureTable();
    
    const result = this.#sql`
      SELECT * FROM _lumenize_alarms WHERE id = ${id}
    `;

    if (!result || result.length === 0) {
      return undefined;
    }

    return { ...result[0], payload: JSON.parse(result[0].payload) } as Schedule<T>;
  }

  /**
   * Get scheduled tasks matching the given criteria
   * @template T Type of the payload data
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   */
  getSchedules<T = string>(criteria: {
    id?: string;
    type?: 'scheduled' | 'delayed' | 'cron';
    timeRange?: {
      start?: Date;
      end?: Date;
    };
  } = {}): Schedule<T>[] {
    this.#ensureTable();
    
    let query = 'SELECT * FROM _lumenize_alarms WHERE 1=1';
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

    const result = [...this.#storage.sql.exec(query, ...params)].map((row: any) => ({
      ...row,
      payload: JSON.parse(row.payload),
    }));

    return result as Schedule<T>[];
  }

  /**
   * Cancel a scheduled task
   * @param id ID of the task to cancel
   * @returns true if the task was cancelled, false otherwise
   */
  cancelSchedule(id: string): boolean {
    this.#ensureTable();
    
    this.#sql`DELETE FROM _lumenize_alarms WHERE id = ${id}`;
    this.#scheduleNextAlarm();
    return true;
  }

  /**
   * Manually trigger execution of the next alarm(s) in chronological order
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
   * 
   * // Trigger multiple alarms:
   * await stub.scheduleTask('task1', 10);
   * await stub.scheduleTask('task2', 20);
   * await stub.scheduleTask('task3', 30);
   * const executed = await stub.triggerAlarms(2); // Triggers first 2
   * expect(executed.length).toBe(2);
   * ```
   */
  async triggerAlarms(count?: number): Promise<string[]> {
    this.#ensureTable();
    
    const now = Math.floor(Date.now() / 1000);
    const executedIds: string[] = [];

    // If count not specified, execute all overdue alarms, or 1 if none overdue
    if (count === undefined) {
      const overdueResult = this.#sql`
        SELECT COUNT(*) as count FROM _lumenize_alarms WHERE time <= ${now}
      `;
      count = overdueResult[0]?.count ?? 1;
    }

    // Ensure count is a number (TypeScript narrowing)
    const actualCount: number = Number(count);

    // Execute the next 'count' alarms in chronological order
    for (let i = 0; i < actualCount; i++) {
      // Get the earliest scheduled alarm (regardless of time)
      const result = this.#sql`
        SELECT * FROM _lumenize_alarms 
        ORDER BY time ASC 
        LIMIT 1
      `;

      if (!result || result.length === 0) {
        break; // No more alarms to execute
      }

      const row = result[0];
      const callback = this.#parent[row.callback];

      if (!callback) {
        // TODO: Fix wrong log format - should use object: { callback: row.callback, message: 'not found' }
        console.error(`callback ${row.callback} not found`);
        continue;
      }

      try {
        await (callback as Function).bind(this.#parent)(JSON.parse(row.payload), row);
        executedIds.push(row.id);
      } catch (e) {
        // TODO: Fix wrong log format - should use object: { callback: row.callback, error: e }
        console.error(`error executing callback "${row.callback}"`, e);
      }

      if (row.type === 'cron') {
        // Update next execution time for cron schedules
        const nextExecutionTime = getNextCronTime(row.cron);
        const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);
        this.#sql`
          UPDATE _lumenize_alarms SET time = ${nextTimestamp} WHERE id = ${row.id}
        `;
      } else {
        // Delete one-time schedules after execution
        this.#sql`
          DELETE FROM _lumenize_alarms WHERE id = ${row.id}
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
      SELECT COUNT(*) as count FROM _lumenize_alarms WHERE time <= ${now}
    `;
    const overdueCount = overdueResult[0]?.count || 0;
    
    if (overdueCount > 0) {
      await this.triggerAlarms(overdueCount);
    }
  };

  #scheduleNextAlarm(): void {
    // Find the next schedule that needs to be executed
    const result = this.#sql`
      SELECT time FROM _lumenize_alarms 
      WHERE time > ${Math.floor(Date.now() / 1000)}
      ORDER BY time ASC 
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
    alarms: Alarms<any>;
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

