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
 * Default output function: console.debug with JSON stringified output
 */
function defaultOutput(log: DebugLogOutput): void {
  console.debug(JSON.stringify(log));
}

/**
 * Debug logger implementation
 * 
 * Provides debug(), info(), and warn() methods with namespace-based filtering.
 * Each method checks if logging is enabled before doing any work (zero-cost when disabled).
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
    
    // Pre-compute enabled state for each level
    this.#enabledCache.set('debug', this.#shouldLog(this.namespace, 'debug'));
    this.#enabledCache.set('info', this.#shouldLog(this.namespace, 'info'));
    this.#enabledCache.set('warn', this.#shouldLog(this.namespace, 'warn'));
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
   * Internal method to log at a specific level
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
  
  debug(message: string, data?: any, options?: DebugOptions): void {
    this.#log('debug', message, data, options);
  }
  
  info(message: string, data?: any, options?: DebugOptions): void {
    this.#log('info', message, data, options);
  }
  
  warn(message: string, data?: any, options?: DebugOptions): void {
    this.#log('warn', message, data, options);
  }
}

