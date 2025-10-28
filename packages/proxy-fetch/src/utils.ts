import type { ProxyFetchOptions } from './types';

/**
 * Default configuration options
 */
export const DEFAULT_OPTIONS: Required<ProxyFetchOptions> = {
  timeout: 30000, // 30 seconds
  maxRetries: 3,
  retryDelay: 1000, // 1 second
  maxRetryDelay: 10000, // 10 seconds
  retryOn5xx: true,
};

/**
 * Determine if an error or response is retryable
 */
export function isRetryable(error: Error | null, response: Response | null, options: Required<ProxyFetchOptions>): boolean {
  // Network errors are always retryable
  if (error) {
    return true;
  }
  
  // 5xx errors are retryable if configured
  if (response && options.retryOn5xx && response.status >= 500 && response.status < 600) {
    return true;
  }
  
  return false;
}

/**
 * Calculate retry delay with exponential backoff
 */
export function getRetryDelay(retryCount: number, options: Required<ProxyFetchOptions>): number {
  const delay = options.retryDelay * Math.pow(2, retryCount);
  return Math.min(delay, options.maxRetryDelay);
}

/**
 * Maximum age for a request before it's considered expired (30 minutes)
 */
export const MAX_REQUEST_AGE_MS = 30 * 60 * 1000;

/**
 * Alarm interval when processing queue at capacity (500ms)
 */
export const ALARM_INTERVAL_AT_CAPACITY_MS = 500;

/**
 * Alarm interval when processing queue below capacity (100ms)
 */
export const ALARM_INTERVAL_NORMAL_MS = 100;

/**
 * Batch size for processing queued items per alarm
 */
export const QUEUE_PROCESS_BATCH_SIZE = 100;
