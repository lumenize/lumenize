/**
 * Debug log levels in order of verbosity (debug is most verbose)
 * 
 * Note: 'error' level is NEVER filtered - always outputs regardless of DEBUG environment variable
 * 
 * @internal
 */
export type DebugLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Options for debug logging (reserved for future use)
 * 
 * @internal
 */
export interface DebugOptions {
  // Future: color, custom fields, etc.
}

/**
 * Debug logger interface
 */
export interface DebugLogger {
  /** Namespace for this logger */
  readonly namespace: string;
  
  /** Whether this logger is enabled based on current filter */
  readonly enabled: boolean;
  
  /** Log at debug level (most verbose) */
  debug(message: string, data?: any, options?: DebugOptions): void;
  
  /** Log at info level */
  info(message: string, data?: any, options?: DebugOptions): void;
  
  /** Log at warn level */
  warn(message: string, data?: any, options?: DebugOptions): void;
  
  /**
   * Log at error level - **⚠️ ALWAYS OUTPUTS, NEVER FILTERED**
   * 
   * Error logs ignore the DEBUG environment variable and always output.
   * Use for true system errors, bugs, and unexpected failures that should NEVER be hidden.
   * 
   * For expected operational issues (retry exhausted, auth failed, rate limited),
   * use `warn()` instead - those are filterable and should be.
   * 
   * @example
   * ```typescript
   * // TRUE ERROR: Unexpected system failure - always visible
   * try {
   *   await stub.fetch(request);
   * } catch (e) {
   *   log.error('Unexpected DO fetch failure', {
   *     error: e.message,
   *     stack: e.stack,
   *     instanceId
   *   });
   * }
   * ```
   * 
   * @example
   * ```typescript
   * // EXPECTED ISSUE: Use warn() instead - should be filterable
   * if (retryCount >= maxRetries) {
   *   log.warn('Retry limit exhausted', { reqId, retryCount });
   * }
   * ```
   */
  error(message: string, data?: any, options?: DebugOptions): void;
}

/**
 * Structured log output format for Cloudflare dashboard
 * 
 * @internal
 */
export interface DebugLogOutput {
  type: 'debug';
  level: DebugLevel;
  namespace: string;
  message: string;
  timestamp: string;
  data?: any;
}

