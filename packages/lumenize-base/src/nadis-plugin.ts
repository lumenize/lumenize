/**
 * NadisPlugin - Base class for creating NADIS-compatible plugins
 * 
 * Provides common infrastructure for NADIS plugins:
 * - Access to doInstance, ctx, and svc
 * - Static register() helper to reduce boilerplate
 * - Consistent pattern for all plugins
 * 
 * @example
 * Creating a stateful NADIS plugin:
 * ```typescript
 * import { NadisPlugin, type LumenizeServices } from '@lumenize/lumenize-base';
 * 
 * export class MyService extends NadisPlugin {
 *   #cache = new Map();
 *   
 *   constructor(doInstance: any) {
 *     super(doInstance);
 *     // Eager dependency validation - fails immediately if missing
 *     this.svc.sql;
 *   }
 *   
 *   getData(key: string) {
 *     if (!this.#cache.has(key)) {
 *       const rows = this.svc.sql`SELECT * FROM data WHERE key = ${key}`;
 *       this.#cache.set(key, rows[0]);
 *     }
 *     return this.#cache.get(key);
 *   }
 * }
 * 
 * // Type declaration (enables autocomplete)
 * declare global {
 *   interface LumenizeServices {
 *     myService: MyService;
 *   }
 * }
 * 
 * // Runtime registration
 * NadisPlugin.register('myService', (doInstance) => new MyService(doInstance));
 * ```
 * 
 * @example
 * Creating a stateless function-based plugin:
 * ```typescript
 * import { NadisPlugin, type LumenizeServices } from '@lumenize/lumenize-base';
 * 
 * export function myHelper(doInstance: any) {
 *   return (input: string) => {
 *     return input.toUpperCase();
 *   };
 * }
 * 
 * // Type declaration
 * declare global {
 *   interface LumenizeServices {
 *     myHelper: ReturnType<typeof myHelper>;
 *   }
 * }
 * 
 * // Runtime registration
 * NadisPlugin.register('myHelper', (doInstance) => myHelper(doInstance));
 * ```
 */

import type { LumenizeServices } from './types';

/**
 * Base class for NADIS plugins
 * 
 * Provides access to doInstance, ctx, and svc for plugins that need state.
 * Function-based plugins can use the static register() method without extending.
 */
export abstract class NadisPlugin {
  /**
   * The Durable Object instance that owns this plugin
   */
  protected doInstance: any;
  
  /**
   * DurableObjectState (ctx) for storage access
   */
  protected ctx: DurableObjectState;
  
  /**
   * Access to other NADIS services via this.svc
   */
  protected svc: LumenizeServices;

  /**
   * Initialize plugin with DO instance
   * 
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
   * This method provides a clean API for registering both class-based and
   * function-based NADIS plugins. It handles the boilerplate of initializing
   * the global registry.
   * 
   * @param name - Service name (accessed as this.svc[name])
   * @param factory - Factory function that receives doInstance and returns service
   * 
   * @example
   * Class-based plugin:
   * ```typescript
   * NadisPlugin.register('alarms', (doInstance) => new Alarms(doInstance));
   * ```
   * 
   * @example
   * Function-based plugin:
   * ```typescript
   * NadisPlugin.register('sql', (doInstance) => sql(doInstance));
   * ```
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

