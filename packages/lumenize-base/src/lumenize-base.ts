import { DurableObject } from 'cloudflare:workers';
import { newContinuation } from '@lumenize/core';

/**
 * LumenizeBase - Base class for Durable Objects with NADIS auto-injection
 * 
 * Provides automatic dependency injection for NADIS services via `this.svc.*`
 * 
 * Just import the NADIS packages you need and access them via `this.svc`:
 * - Stateless services (e.g., `sql`) are automatically called with `this`
 * - Stateful services (e.g., `Alarms`) are automatically instantiated with dependencies
 * - Full TypeScript autocomplete via declaration merging
 * - Lazy loading - services only instantiated when accessed
 * 
 * @example
 * Basic usage:
 * ```typescript
 * import '@lumenize/core';     // Registers sql
 * import '@lumenize/alarms';   // Registers alarms
 * import { LumenizeBase } from '@lumenize/lumenize-base';
 * 
 * class MyDO extends LumenizeBase<Env> {
 *   async alarm() {
 *     await this.svc.alarms.alarm();
 *   }
 *   
 *   async getUser(id: string) {
 *     const rows = this.svc.sql`SELECT * FROM users WHERE id = ${id}`;
 *     return rows[0];
 *   }
 *   
 *   scheduleTask() {
 *     this.svc.alarms.schedule(60, this.ctn().handleTask({ data: 'example' }));
 *   }
 *   
 *   handleTask(payload: any) {
 *     console.log('Task executed:', payload);
 *   }
 * }
 * ```
 */
export abstract class LumenizeBase<Env = any> extends DurableObject<Env> {
  #serviceCache = new Map<string, any>();
  #svcProxy: LumenizeServices | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Create an OCAN (Operation Chaining And Nesting) continuation proxy
   * 
   * Returns a proxy that records method calls into an operation chain.
   * Used with async strategies (alarms, call, proxyFetch) to define
   * what to execute when the operation completes.
   * 
   * @template T - Type to proxy (defaults to this DO's type for chaining local methods)
   * 
   * @example
   * ```typescript
   * // Local method chaining
   * this.svc.alarms.schedule(60, this.ctn().handleTask({ data: 'example' }));
   * 
   * // Remote DO calls
   * const remote = this.ctn<RemoteDO>().getUserData(userId);
   * this.svc.call(REMOTE_DO, 'instance-id', remote, this.ctn().handleResult(remote));
   * 
   * // Nesting
   * const data1 = this.ctn().getData(1);
   * const data2 = this.ctn().getData(2);
   * this.svc.alarms.schedule(60, this.ctn().combineData(data1, data2));
   * ```
   */
  ctn<T = this>(): T {
    return newContinuation<T>();
  }

  /**
   * Access NADIS services via this.svc.*
   * 
   * Services are auto-discovered from the global LumenizeServices interface
   * and lazily instantiated on first access.
   */
  get svc(): LumenizeServices {
    if (this.#svcProxy) {
      return this.#svcProxy;
    }

    this.#svcProxy = new Proxy({} as LumenizeServices, {
      get: (target, prop: string) => {
        // Return cached instance if available
        if (this.#serviceCache.has(prop)) {
          return this.#serviceCache.get(prop);
        }

        // Try to resolve the service from module scope
        const service = this.#resolveService(prop);
        
        if (service) {
          this.#serviceCache.set(prop, service);
          return service;
        }

        throw new Error(
          `Service '${prop}' not found. Did you import the NADIS package? ` +
          `Example: import '@lumenize/${prop}';`
        );
      },
    }) as LumenizeServices;

    return this.#svcProxy;
  }

  /**
   * Resolve a service by name from the global registry
   * 
   * Handles both stateless (functions) and stateful (classes) services:
   * - Stateless: Call function with `this` (e.g., sql(this))
   * - Stateful: Instantiate class with ctx, this, and dependencies
   */
  #resolveService(name: string): any {
    const registry = (globalThis as any).__lumenizeServiceRegistry;
    
    if (!registry) {
      return null;
    }

    const serviceFactory = registry[name];
    
    if (!serviceFactory) {
      return null;
    }

    // Call the factory with DO instance and let it handle instantiation
    return serviceFactory(this);
  }
}

// Initialize global service registry
if (!(globalThis as any).__lumenizeServiceRegistry) {
  (globalThis as any).__lumenizeServiceRegistry = {};
}

// Re-export the global LumenizeServices interface for convenience
export type { LumenizeServices } from './types';

