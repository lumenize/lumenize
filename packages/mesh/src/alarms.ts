// Adapted from @cloudflare/actors Alarms package
// Source: https://github.com/cloudflare/actors/tree/e910e86ac1567fe58e389d1938afbdf1e53750ff/packages/alarms
// License: Apache-2.0 (https://github.com/cloudflare/actors/blob/main/LICENSE)
// Modifications: Complete rewrite to use OCAN (Operation Chaining And Nesting),
// built-in service integration, lazy table initialization, TypeScript generics

import { parseCronExpression } from 'cron-schedule';
import { debug, type DebugLogger } from '@lumenize/debug';
import { preprocess, parse } from '@lumenize/structured-clone';
import { ulidFactory } from 'ulid-workers';
import { getOperationChain, type OperationChain } from './ocan/index.js';
import type { sql as sqlType } from './sql.js';

// ============================================
// Alarm Types
// ============================================

/** One-time scheduled alarm at a specific time */
export interface ScheduledAlarm {
  id: string;
  type: 'scheduled';
  time: number;
  operationChain: OperationChain;
}

/** Delayed alarm that fires after a specified number of seconds */
export interface DelayedAlarm {
  id: string;
  type: 'delayed';
  time: number;
  delayInSeconds: number;
  operationChain: OperationChain;
}

/** Recurring cron-based alarm */
export interface CronAlarm {
  id: string;
  type: 'cron';
  time: number;
  cron: string;
  operationChain: OperationChain;
}

/**
 * Represents a scheduled task within a Durable Object.
 * The operation chain defines what will be executed when the alarm fires.
 */
export type Schedule = ScheduledAlarm | DelayedAlarm | CronAlarm;

// ============================================
// Alarms Service Implementation
// ============================================

// Create monotonic ULID generator for FIFO ordering
const ulid = ulidFactory({ monotonic: true });

function getNextCronTime(cron: string): Date {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}

/**
 * Alarm scheduling for Cloudflare Durable Objects.
 *
 * Built-in service: `this.svc.alarms`. Supports delayed, scheduled, and cron alarms.
 * @see https://lumenize.com/docs/mesh/alarms for full documentation
 */
export class Alarms {
  #doInstance: any;
  #sql: ReturnType<typeof sqlType>;
  #storage: DurableObjectStorage;
  #log: DebugLogger;

  constructor(doInstance: any) {
    this.#doInstance = doInstance;
    this.#storage = doInstance.ctx.storage;

    // Eager dependency validation - fails immediately if sql not available
    if (!doInstance.svc.sql) {
      throw new Error('Alarms requires sql service (built-in to @lumenize/mesh)');
    }
    this.#sql = doInstance.svc.sql;
    this.#log = debug('lmz.alarms.Alarms');

    // Create table synchronously (idempotent)
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
  }

  /**
   * Schedule a task to execute in the future.
   * @param when Date, seconds delay, or cron expression
   * @param continuation OCAN chain from `this.ctn()`
   * @see https://lumenize.com/docs/mesh/alarms#scheduling-tasks
   */
  schedule(
    when: Date | string | number,
    continuation: any,
    options?: { id?: string }
  ): Schedule {
    
    // Extract operation chain from the continuation proxy
    const operationChain = getOperationChain(continuation);
    if (!operationChain) {
      this.#log.error('Invalid continuation passed to schedule', {
        hasContinuation: !!continuation,
        continuationType: typeof continuation
      });
      throw new Error('Invalid continuation: must be created with newContinuation() or this.ctn()');
    }

    const id = options?.id ?? ulid();  // Use provided ID or generate monotonic ULID for FIFO ordering

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);

      this.#log.debug('Scheduling alarm', {
        id,
        firesAt: when.toISOString(),
        timestamp,
        operationName: operationChain[0]?.type === 'get' ? String(operationChain[0].key) : undefined
      });

      this.#storeSchedule(id, operationChain, 'scheduled', timestamp, {});
      this.#log.debug('Alarm stored and next alarm scheduled', { id, timestamp });
      this.#scheduleNextAlarm();

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

      this.#storeSchedule(id, operationChain, 'delayed', timestamp, { delayInSeconds: when });
      this.#scheduleNextAlarm();

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

      this.#storeSchedule(id, operationChain, 'cron', timestamp, { cron: when });
      this.#scheduleNextAlarm();

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

  #storeSchedule(
    id: string,
    operationChain: OperationChain,
    type: 'scheduled' | 'delayed' | 'cron',
    time: number,
    extra: { delayInSeconds?: number; cron?: string }
  ): void {
    const serialized = JSON.stringify(preprocess(operationChain));

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
  getSchedule(id: string): Schedule | undefined {
    const result = this.#sql`SELECT * FROM __lmz_alarms WHERE id = ${id}`;
    if (result.length === 0) return undefined;
    return { ...result[0], operationChain: parse(result[0].operationChain) } as Schedule;
  }

  /**
   * Get scheduled tasks matching the given criteria
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   */
  getSchedules(criteria: {
    id?: string;
    type?: 'scheduled' | 'delayed' | 'cron';
    timeRange?: {
      start?: Date;
      end?: Date;
    };
  } = {}): Schedule[] {
    
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
    const schedules = result.map((row: any) => ({
      ...row,
      operationChain: parse(row.operationChain),
    }));

    return schedules as Schedule[];
  }

  /**
   * Cancel a scheduled task
   * @param id ID of the task to cancel
   * @returns The cancelled Schedule with its continuation data, or undefined if not found
   */
  cancelSchedule(id: string): Schedule | undefined {
    const result = this.#sql`SELECT * FROM __lmz_alarms WHERE id = ${id}`;
    if (result.length === 0) return undefined;

    this.#storage.sql.exec(`DELETE FROM __lmz_alarms WHERE id = ?`, id);
    this.#scheduleNextAlarm();

    return { ...result[0], operationChain: parse(result[0].operationChain) } as Schedule;
  }

  /**
   * Execute pending alarms. Used internally by `alarm()` and for testing.
   * @param count Alarms to execute (default: all overdue)
   * @see https://lumenize.com/docs/mesh/alarms#testing
   */
  async triggerAlarms(count?: number): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000);
    const executedIds: string[] = [];

    // If count not specified, execute all overdue alarms, or 1 if none overdue
    let effectiveCount: number;
    if (count === undefined) {
      const overdueResult = this.#sql`SELECT COUNT(*) as count FROM __lmz_alarms WHERE time <= ${now}`;
      effectiveCount = overdueResult[0]?.count ?? 1;
    } else {
      effectiveCount = count;
    }

    for (let i = 0; i < effectiveCount; i++) {
      const result = this.#sql`SELECT * FROM __lmz_alarms ORDER BY time ASC, id ASC LIMIT 1`;
      if (result.length === 0) break;

      const row = result[0];

      try {
        // Use local chain executor that allows skipping @mesh decorator check
        // Alarms are always local (within the same DO) so @mesh is not required
        const executor = (this.#doInstance as any).__localChainExecutor;
        await executor(parse(row.operationChain), { requireMeshDecorator: false });
        executedIds.push(row.id);
      } catch (e) {
        this.#log.error('Error executing alarm', {
          id: row.id,
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined
        });
      }

      if (row.type === 'cron') {
        const nextTimestamp = Math.floor(getNextCronTime(row.cron).getTime() / 1000);
        this.#sql`UPDATE __lmz_alarms SET time = ${nextTimestamp} WHERE id = ${row.id}`;
      } else {
        this.#sql`DELETE FROM __lmz_alarms WHERE id = ${row.id}`;
      }
    }

    this.#scheduleNextAlarm();
    return executedIds;
  }

  /** Alarm handler - called by LumenizeDO's alarm() lifecycle method */
  readonly alarm = async (alarmInfo?: AlarmInvocationInfo): Promise<void> => {
    const now = Math.floor(Date.now() / 1000);
    const overdueResult = this.#sql`SELECT COUNT(*) as count FROM __lmz_alarms WHERE time <= ${now}`;
    const overdueCount = overdueResult[0]?.count || 0;
    if (overdueCount > 0) {
      await this.triggerAlarms(overdueCount);
    }
  };

  #scheduleNextAlarm(): void {
    const result = this.#sql`
      SELECT time FROM __lmz_alarms WHERE time > ${Math.floor(Date.now() / 1000)}
      ORDER BY time ASC, id ASC LIMIT 1
    `;
    if (result.length > 0) {
      this.#storage.setAlarm((result[0].time as number) * 1000);
    }
  }
}

// Note: LumenizeServices.alarms is declared in types.ts (not via declaration merging)
// to ensure proper type resolution across package boundaries
