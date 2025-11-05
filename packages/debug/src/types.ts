/**
 * Debug log levels in order of verbosity (debug is most verbose)
 */
export type DebugLevel = 'debug' | 'info' | 'warn';

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
}

