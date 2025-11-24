/**
 * Type definitions for @lumenize/proxy-fetch
 */

/**
 * Options for proxyFetch
 */
export interface ProxyFetchWorkerOptions {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Binding name for FetchExecutor service (default: 'FETCH_EXECUTOR') */
  executorBinding?: string;
  /** 
   * Test mode options (for testing only)
   * @internal
   */
  testMode?: {
    /** Simulate delivery failure to test alarm timeout */
    simulateDeliveryFailure?: boolean;
    /** Override alarm timeout (ms) for faster tests */
    alarmTimeoutOverride?: number;
  };
}
