/**
 * Base class for creating NADIS-compatible plugins
 * 
 * Provides common infrastructure for NADIS plugins:
 * - Access to doInstance, ctx, and svc
 * - Static register() helper to reduce boilerplate
 * - Consistent pattern for all plugins
 * 
 * **Usage:**
 * - Extend this class for stateful plugins
 * - Use register() directly for function-based plugins
 * - See complete guide: https://lumenize.com/docs/lumenize-base/creating-plugins
 */

import type { LumenizeServices } from './types';

export abstract class NadisPlugin {
  /** The Durable Object instance that owns this plugin */
  protected doInstance: any;
  
  /** DurableObjectState for storage access */
  protected ctx: DurableObjectState;
  
  /** Access to other NADIS services */
  protected svc: LumenizeServices;

  /**
   * Initialize plugin with DO instance
   * @param doInstance - The LumenizeBase DO instance
   */
  constructor(doInstance: any) {
    this.doInstance = doInstance;
    this.ctx = doInstance.ctx;
    this.svc = doInstance.svc;
  }

  /**
   * Register a NADIS plugin in the global service registry
   * 
   * @param name - Service name (accessed as `this.svc[name]`)
   * @param factory - Factory function that receives doInstance and returns service
   */
  static register<T>(name: string, factory: (doInstance: any) => T): void {
    // Initialize registry if needed
    if (!(globalThis as any).__lumenizeServiceRegistry) {
      (globalThis as any).__lumenizeServiceRegistry = {};
    }
    
    // Register the factory
    (globalThis as any).__lumenizeServiceRegistry[name] = factory;
  }
}

