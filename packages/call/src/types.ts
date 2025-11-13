import type { OperationChain } from '@lumenize/core';

/**
 * Options for call operations
 */
export interface CallOptions {
  /**
   * Timeout in milliseconds (default: 30000 = 30 seconds)
   */
  timeout?: number;
}

/**
 * Internal message sent from origin DO to remote DO
 * @internal
 */
export interface CallMessage {
  /** ID of the origin DO instance */
  originId: string;
  /** Name of the origin DO binding in env */
  originBinding: string;
  /** Name or ID of the origin DO instance (may be undefined if not set) */
  originInstanceNameOrId?: string;
  /** Name of the target (remote) DO binding in env */
  targetBinding: string;
  /** Name or ID of the target (remote) DO instance */
  targetInstanceNameOrId: string;
  /** Unique ID for this operation */
  operationId: string;
  /** Operation chain to execute on remote DO */
  operationChain: OperationChain;
}

/**
 * Internal message sent from remote DO back to origin DO
 * @internal
 */
export interface CallResult {
  /** ID matching the original operation */
  operationId: string;
  /** Result of the operation (if successful) */
  result?: any;
  /** Error from the operation (if failed) */
  error?: Error;
}

/**
 * Pending call stored in origin DO's storage
 * @internal
 */
export interface PendingCall {
  /** Unique ID for this operation */
  operationId: string;
  /** Operation chain for the continuation handler */
  continuationChain: OperationChain;
  /** Timeout alarm ID (if timeout is set) */
  timeoutAlarmId?: string;
  /** Timestamp when call was initiated */
  createdAt: number;
}

