/**
 * Type definitions for @lumenize/proxy-fetch
 */

/**
 * Configuration options for proxy fetch retry and timeout behavior
 */
export interface ProxyFetchOptions {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum number of retry attempts for transient failures (default: 3) */
  maxRetries?: number;
  /** Initial retry delay in milliseconds for exponential backoff (default: 1000) */
  retryDelay?: number;
  /** Maximum retry delay in milliseconds (default: 10000) */
  maxRetryDelay?: number;
  /** Whether to retry on 5xx server errors (default: true) */
  retryOn5xx?: boolean;
}

/**
 * Message sent to queue from DO
 */
export interface ProxyFetchQueueMessage {
  /** Unique request ID */
  reqId: string;
  /** Serialized Request object (not a Request instance) */
  request: any; // Serialized form from serializeWebApiObject()
  /** DO binding name for return routing */
  doBindingName: string;
  /** DO instance ID for return routing */
  instanceId: string;
  /** Name of the handler method to call on the DO (optional for fire-and-forget) */
  handlerName?: string;
  /** Current retry attempt number (starts at 0) */
  retryCount?: number;
  /** Configuration options for this request */
  options?: ProxyFetchOptions;
  /** Timestamp when request was initiated */
  timestamp: number;
  /** Timestamp when this retry should be processed (for exponential backoff, DO variant only) */
  retryAfter?: number;
}

/**
 * Item passed to user's handler method
 */
export interface ProxyFetchHandlerItem {
  /** Unique request ID */
  reqId: string;
  /** Response from external API (if successful) */
  response?: Response;
  /** Error from fetch or processing (if failed) */
  error?: Error;
  /** Number of retry attempts made (0 for first attempt) */
  retryCount?: number;
  /** Total duration in milliseconds from initial request to completion */
  duration?: number;
}

/**
 * Worker Variant Types
 */

/**
 * Options for proxyFetchWorker
 */
export interface ProxyFetchWorkerOptions {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Binding name for origin DO (for callbacks) */
  originBinding?: string;
  /** Binding name for FetchOrchestrator DO (default: 'FETCH_ORCHESTRATOR') */
  orchestratorBinding?: string;
  /** Instance name for FetchOrchestrator DO (default: 'singleton') */
  orchestratorInstanceName?: string;
  /** Binding name for FetchExecutor service (default: 'FETCH_EXECUTOR') */
  executorBinding?: string;
}

/**
 * Message sent from origin DO to FetchOrchestrator
 * @internal
 */
export interface FetchOrchestratorMessage {
  /** Unique request ID */
  reqId: string;
  /** Serialized Request object */
  request: any; // Serialized via structured-clone
  /** Origin DO binding name */
  originBinding: string;
  /** Origin DO instance ID */
  originId: string;
  /** Options */
  options?: ProxyFetchWorkerOptions;
  /** Timestamp when request was initiated */
  timestamp: number;
}

/**
 * Message sent from FetchOrchestrator to Worker
 * @internal
 */
export interface WorkerFetchMessage {
  /** Unique request ID */
  reqId: string;
  /** Serialized Request object */
  request: any;
  /** Origin DO binding name (for direct callback) */
  originBinding: string;
  /** Origin DO instance ID (for direct callback) */
  originId: string;
  /** Retry attempt number */
  retryCount: number;
  /** Options */
  options?: ProxyFetchWorkerOptions;
  /** Timestamp when request was initiated */
  startTime: number;
}

/**
 * Result message sent from Worker back to origin DO
 * @internal
 */
export interface FetchResult {
  /** Unique request ID */
  reqId: string;
  /** Serialized Response (if successful) */
  response?: any;
  /** Error (if failed) */
  error?: Error;
  /** Retry attempt number */
  retryCount: number;
  /** Duration in milliseconds */
  duration: number;
}
