import { DurableObject } from 'cloudflare:workers';
import { debug } from '../index';

/**
 * Test DO for debug functionality
 * 
 * This will be used to test the debug NADIS plugin with actual
 * Durable Object instances.
 */
export class DebugTestDO extends DurableObject<Env> {
  #log = debug(this)('test.debug-do');

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
}

// Export default worker (required by vitest-pool-workers)
export default {
  fetch(): Response {
    return new Response('Worker entrypoint for debug tests');
  }
};

