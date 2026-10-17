import type { DebugLogger, DebugLevel, DebugOptions, DebugLogOutput } from './types';
import { getDebugSink } from './sink';

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
 * The Error a log entry is about: `data` itself, or the first Error among its own values.
 * Its stack is lifted to the entry's top-level `stack`.
 */
function errorIn(data: unknown): Error | undefined {
  if (data instanceof Error) return data;
  if (typeof data !== 'object' || data === null) return undefined;
  for (const value of Object.values(data)) {
    if (value instanceof Error) return value;
  }
  return undefined;
}

/**
 * An Error as plain fields. `JSON.stringify` would write `{}`, because an Error's `name`,
 * `message`, `stack`, `cause` and AggregateError's `errors` are not enumerable.
 */
function serializeError(error: Error, omitStack: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  if (!omitStack && error.stack !== undefined) out.stack = error.stack;
  const { cause, errors } = error as { cause?: unknown; errors?: unknown };
  if (cause !== undefined) out.cause = cause;
  if (Array.isArray(errors)) out.errors = errors;
  for (const [key, value] of Object.entries(error)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Safe JSON replacer: handles circular references and BigInt, and writes an Error as its fields.
 * `lifted` is the Error whose stack the entry already carries at the top level, so it is not
 * written twice.
 */
function safeReplacer(lifted?: Error) {
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
      if (value instanceof Error) return serializeError(value, value === lifted);
    }

    return value;
  };
}

/**
 * Default output function: console.debug with JSON stringified output
 * Handles circular references, BigInt and Errors safely
 */
function defaultOutput(log: DebugLogOutput): void {
  const lifted = log.stack === undefined ? undefined : errorIn(log.data);
  console.debug(JSON.stringify(log, safeReplacer(lifted), 2));
}

/**
 * One log entry. At error level, the stack of any Error in `data` is lifted to the top level; at
 * any other level it stays nested, because Workers Issues makes any line with a top-level stack an
 * issue, whatever its level.
 */
function entry(namespace: string, level: DebugLevel, message: string, data?: any): DebugLogOutput {
  const log: DebugLogOutput = {
    type: 'debug',
    level,
    namespace,
    message,
    timestamp: new Date().toISOString(),
  };
  if (data !== undefined) {
    log.data = data;
    const stack = level === 'error' ? errorIn(data)?.stack : undefined;
    if (stack !== undefined) log.stack = stack;
  }
  return log;
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
   * Check if any level is enabled (useful for expensive pre-computations).
   *
   * When a test sink is installed via `setDebugSink`, this is always `true`
   * — sink-installed implies "capture everything", and any callers gating
   * expensive work on `enabled` should run that work so the sink sees it.
   */
  get enabled(): boolean {
    if (getDebugSink() !== null) return true;
    return this.#enabledCache.get('debug') ||
           this.#enabledCache.get('info') ||
           this.#enabledCache.get('warn') ||
           false;
  }

  /**
   * Internal method to log at a specific level (for filterable levels only).
   *
   * Sink contract: when a sink is installed, the DEBUG filter is bypassed and
   * the entry goes to the sink only — the default console output is replaced,
   * not augmented.
   */
  #log(level: DebugLevel, message: string, data?: any, _options?: DebugOptions): void {
    const sink = getDebugSink();
    if (!sink && !this.#enabledCache.get(level)) return;

    const log = entry(this.namespace, level, message, data);
    if (sink) {
      sink(log);
    } else {
      this.#output(log);
    }
  }

  /**
   * Internal method to create and output a log (bypasses filter check).
   *
   * Used only by `error()`. Sink contract matches `#log` — when a sink is
   * installed, the entry goes to the sink only.
   */
  #logMessage(level: DebugLevel, message: string, data?: any): void {
    const sink = getDebugSink();
    const log = entry(this.namespace, level, message, data);
    if (sink) {
      sink(log);
    } else {
      this.#output(log);
    }
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
