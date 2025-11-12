import { DurableObject } from 'cloudflare:workers';
import { debug } from '../index';
import { parseDebugFilter, shouldLog } from '../pattern-matcher';
import type { DebugLevel } from '../types';

/**
 * Test DO for debug functionality
 * 
 * This will be used to test the debug NADIS plugin with actual
 * Durable Object instances.
 */
export class DebugTestDO extends DurableObject<Env> {
  #log = debug(this)('lmz.test.DebugTestDO');

  testBasicLogging() {
    this.#log.debug('Debug message', { level: 'debug' });
    this.#log.info('Info message', { level: 'info' });
    this.#log.warn('Warning message', { level: 'warn' });
    
    return { logged: true };
  }

  testEnabledFlag() {
    return { 
      enabled: this.#log.enabled,
      namespace: 'test.debug-do'
    };
  }

  testStructuredData() {
    const data = {
      requestId: 'req-123',
      userId: 'user-456',
      timestamp: Date.now()
    };
    
    this.#log.info('Processing request', data);
    
    return { processed: true };
  }

  /**
   * Test pattern matching directly
   * @param namespace - Namespace to test
   * @param filter - DEBUG filter string
   * @param level - Log level to test
   * @returns Whether the namespace+level should log
   */
  testNamespaceMatch(namespace: string, filter: string, level: DebugLevel) {
    const patterns = parseDebugFilter(filter);
    const result = shouldLog(namespace, level, patterns);
    return { shouldLog: result };
  }
}

// Export default worker (required by vitest-pool-workers)
export default {
  fetch(): Response {
    return new Response('Worker entrypoint for debug tests');
  }
};

