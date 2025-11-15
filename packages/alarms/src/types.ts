import type { OperationChain } from '@lumenize/lumenize-base';

/**
 * Represents a scheduled task within a Durable Object.
 * The operation chain defines what will be executed when the alarm fires.
 */
export type Schedule = {
  /** Unique identifier for the schedule */
  id: string;
  /** Operation chain to execute when alarm fires */
  operationChain: OperationChain;
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

