import type { OperationChain } from '@lumenize/mesh';

/** Base schedule properties shared by all schedule types */
interface ScheduleBase {
  /** Unique identifier for the schedule */
  id: string;
  /** Operation chain to execute when alarm fires */
  operationChain: OperationChain;
}

/** One-time scheduled alarm */
export interface ScheduledAlarm extends ScheduleBase {
  /** Type of schedule for one-time execution at a specific time */
  type: 'scheduled';
  /** Timestamp when the task should execute */
  time: number;
}

/** Delayed alarm that fires after a specified number of seconds */
export interface DelayedAlarm extends ScheduleBase {
  /** Type of schedule for delayed execution */
  type: 'delayed';
  /** Timestamp when the task should execute */
  time: number;
  /** Number of seconds to delay execution */
  delayInSeconds: number;
}

/** Recurring cron-based alarm */
export interface CronAlarm extends ScheduleBase {
  /** Type of schedule for recurring execution based on cron expression */
  type: 'cron';
  /** Timestamp for the next execution */
  time: number;
  /** Cron expression defining the schedule */
  cron: string;
}

/**
 * Represents a scheduled task within a Durable Object.
 * The operation chain defines what will be executed when the alarm fires.
 */
export type Schedule = ScheduledAlarm | DelayedAlarm | CronAlarm;

