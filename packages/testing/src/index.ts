// Main export - testing-optimized RPC client
export { createTestingClient } from './create-testing-client';

// DO project instrumentation
export { instrumentDOProject } from './instrument-do-project';
export type { InstrumentDOProjectConfig, InstrumentedDOProject } from './instrument-do-project';

// Alarm simulation
export { enableAlarmSimulation } from './alarm-simulation';
export type { AlarmSimulationConfig } from './alarm-simulation';

// Re-export RPC functionality for downstream messaging
export { sendDownstream } from '@lumenize/rpc';

// Re-export RPC types that are commonly needed in tests
export type { RpcAccessible, RpcClientProxy } from '@lumenize/rpc';

// Testing-optimized Browser with automatic SELF.fetch injection
import { Browser as BrowserBase, type BrowserOptions } from '@lumenize/utils';

/**
 * Testing-optimized Browser with automatic SELF.fetch injection.
 * 
 * This is a convenience wrapper around Browser from @lumenize/utils that automatically
 * uses SELF.fetch from the Cloudflare Workers test environment when no fetch function
 * is provided.
 * 
 * **Environment Requirement**: This class can only be instantiated within Cloudflare Workers
 * test environment (vitest with @cloudflare/vitest-pool-workers). It lazily imports from
 * `cloudflare:test` which is only available in that environment.
 * 
 * @example
 * ```typescript
 * import { Browser } from '@lumenize/testing';
 * 
 * const browser = new Browser(); // Automatically uses SELF.fetch
 * await browser.fetch('http://localhost/api');
 * 
 * // Can still pass custom fetch if needed
 * const customBrowser = new Browser(myCustomFetch);
 * 
 * // With metrics tracking
 * const metrics: Metrics = {};
 * const browser = new Browser(undefined, { metrics });
 * ```
 */
export class Browser extends BrowserBase {
  constructor(fetchFn?: typeof fetch, options?: BrowserOptions) {
    // Lazy import SELF to avoid top-level cloudflare:test dependency that breaks module loading
    if (!fetchFn) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SELF } = require('cloudflare:test');
      fetchFn = SELF.fetch.bind(SELF);
    }
    super(fetchFn, options);
  }
}
