/**
 * Debug log levels in order of verbosity (debug is most verbose)
 *
 * Note: 'error' level is NEVER filtered - always outputs regardless of DEBUG environment variable
 */
export type DebugLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Options for debug logging (reserved for future use)
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
   * Log at error level - **ALWAYS OUTPUTS, NEVER FILTERED**
   *
   * Error logs ignore the DEBUG environment variable and always output.
   * Use for true system errors, bugs, and unexpected failures that should NEVER be hidden.
   *
   * For expected operational issues (retry exhausted, auth failed, rate limited),
   * use `warn()` instead - those are filterable and should be.
   */
  error(message: string, data?: any, options?: DebugOptions): void;
}

/**
 * Structured log output format for Cloudflare dashboard
 */
export interface DebugLogOutput {
  type: 'debug';
  level: DebugLevel;
  namespace: string;
  message: string;
  timestamp: string;
  data?: any;
  /**
   * On an error-level entry, the stack of the Error it carries — `data` itself, or the first Error
   * among its own values. Top-level because Workers Issues reads a stack only here: it source-maps
   * it, adds the top frame to the issue's signature and keeps `message` as the title. Never set on
   * another level, since a top-level stack makes Issues treat any line as an error (measured in
   * `experiments/workers-issues/RESULTS.md`).
   */
  stack?: string;
}
