import type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';

/**
 * Configuration for creating a debug logger
 */
export interface DebugLoggerConfig {
  /** The namespace for this logger */
  namespace: string;

  /** Function to check if namespace+level should log */
  shouldLog: (namespace: string, level: DebugLevel) => boolean;

  /** Function to output the log (default: console.debug with JSON.stringify) */
  output?: (log: DebugLogOutput) => void;
}

/**
 * Safe JSON replacer that handles circular references and BigInt
 */
function safeReplacer() {
  const seen = new WeakSet();
  return (_key: string, value: any) => {
    // Handle BigInt
    if (typeof value === 'bigint') {
      return value.toString() + 'n';
    }

    // Handle circular references
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }

    return value;
  };
}

/**
 * Default output function: console.debug with JSON stringified output
 * Handles circular references and BigInt safely
 */
function defaultOutput(log: DebugLogOutput): void {
  console.debug(JSON.stringify(log, safeReplacer(), 2));
}

/**
 * Debug logger implementation
 *
 * Provides debug(), info(), warn(), and error() methods with namespace-based filtering.
 * Each method (except error) checks if logging is enabled before doing any work (zero-cost when disabled).
 *
 * IMPORTANT: error() always outputs regardless of DEBUG filter - see method documentation.
 */
export class DebugLoggerImpl implements DebugLogger {
  readonly namespace: string;
  #shouldLog: (namespace: string, level: DebugLevel) => boolean;
  #output: (log: DebugLogOutput) => void;
  #enabledCache: Map<DebugLevel, boolean>;

  constructor(config: DebugLoggerConfig) {
    this.namespace = config.namespace;
    this.#shouldLog = config.shouldLog;
    this.#output = config.output || defaultOutput;
    this.#enabledCache = new Map();

    // Pre-compute enabled state for filterable levels
    this.#enabledCache.set('debug', this.#shouldLog(this.namespace, 'debug'));
    this.#enabledCache.set('info', this.#shouldLog(this.namespace, 'info'));
    this.#enabledCache.set('warn', this.#shouldLog(this.namespace, 'warn'));
    // Note: 'error' level is not cached because it always outputs
  }

  /**
   * Check if any level is enabled (useful for expensive pre-computations)
   */
  get enabled(): boolean {
    return this.#enabledCache.get('debug') ||
           this.#enabledCache.get('info') ||
           this.#enabledCache.get('warn') ||
           false;
  }

  /**
   * Internal method to log at a specific level (for filterable levels only)
   */
  #log(level: DebugLevel, message: string, data?: any, _options?: DebugOptions): void {
    if (!this.#enabledCache.get(level)) return;

    const log: DebugLogOutput = {
      type: 'debug',
      level,
      namespace: this.namespace,
      message,
      timestamp: new Date().toISOString(),
    };

    if (data !== undefined) {
      log.data = data;
    }

    this.#output(log);
  }

  /**
   * Internal method to create and output a log (bypasses filter check)
   */
  #logMessage(level: DebugLevel, message: string, data?: any): void {
    const log: DebugLogOutput = {
      type: 'debug',
      level,
      namespace: this.namespace,
      message,
      timestamp: new Date().toISOString(),
    };

    if (data !== undefined) {
      log.data = data;
    }

    this.#output(log);
  }

  debug(message: string, data?: any, options?: DebugOptions): void {
    this.#log('debug', message, data, options);
  }

  info(message: string, data?: any, options?: DebugOptions): void {
    this.#log('info', message, data, options);
  }

  warn(message: string, data?: any, options?: DebugOptions): void {
    this.#log('warn', message, data, options);
  }

  /**
   * Log at error level - **ALWAYS OUTPUTS, NEVER FILTERED**
   *
   * Error logs ignore the DEBUG environment variable and always output.
   * Use for true system errors, bugs, and unexpected failures that should NEVER be hidden.
   *
   * For expected operational issues (retry exhausted, auth failed, rate limited),
   * use `warn()` instead - those are filterable and should be.
   */
  error(message: string, data?: any, _options?: DebugOptions): void {
    // ALWAYS output errors, regardless of DEBUG filter
    this.#logMessage('error', message, data);
  }
}
