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
