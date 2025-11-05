/**
 * Client-side debug logging (browser/standalone)
 * 
 * Usage:
 * ```typescript
 * import { createDebug } from '@lumenize/debug/client';
 * 
 * const log = createDebug('my-app.websocket');
 * log.debug('connection opened', { id: connectionId });
 * ```
 * 
 * Configuration:
 * - Set `localStorage.DEBUG` to filter pattern (e.g., "my-app.*")
 * - Or use `setDebugNamespaces('my-app.*')` programmatically
 */

import { createMatcher } from './pattern-matcher';
import { DebugLoggerImpl } from './logger';
import type { DebugLogger } from './types';

/**
 * Current DEBUG filter (mutable for programmatic updates)
 */
let currentMatcher = createDefaultMatcher();

/**
 * Create default matcher from localStorage (browser) or empty (Node.js)
 */
function createDefaultMatcher() {
  if (typeof localStorage !== 'undefined') {
    try {
      const filter = localStorage.getItem('DEBUG') || undefined;
      return createMatcher(filter);
    } catch {
      // localStorage might not be available
      return createMatcher(undefined);
    }
  }
  return createMatcher(undefined);
}

/**
 * Set DEBUG filter programmatically
 * 
 * @param pattern - DEBUG pattern (e.g., "my-app.*")
 * 
 * @example
 * ```typescript
 * setDebugNamespaces('my-app.*');
 * setDebugNamespaces(''); // Disable all
 * ```
 */
export function setDebugNamespaces(pattern: string): void {
  currentMatcher = createMatcher(pattern || undefined);
}

/**
 * Create a debug logger for the given namespace
 * 
 * @param namespace - Dot-separated namespace (e.g., "my-app.websocket")
 * @returns DebugLogger instance
 * 
 * @example
 * ```typescript
 * const log = createDebug('my-app.websocket');
 * log.debug('message', { data });
 * log.info('milestone');
 * log.warn('problem', { error });
 * ```
 */
export function createDebug(namespace: string): DebugLogger {
  return new DebugLoggerImpl({
    namespace,
    shouldLog: currentMatcher,
  });
}

