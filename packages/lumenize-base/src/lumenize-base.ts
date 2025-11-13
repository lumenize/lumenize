import { DurableObject } from 'cloudflare:workers';
import { newContinuation, executeOperationChain, type OperationChain } from '@lumenize/core';

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
   * Default fetch handler that auto-initializes DO metadata from headers
   * 
   * This handler automatically reads `x-lumenize-do-binding-name` and
   * `x-lumenize-do-instance-name-or-id` headers (set by routeDORequest)
   * and stores them for use by services like @lumenize/call.
   * 
   * Subclasses should call `super.fetch(request)` at the start of their
   * fetch handler to enable auto-initialization:
   * 
   * @param request - The incoming HTTP request
   * @returns HTTP 501 Not Implemented (subclasses should override)
   * 
   * @example
   * ```typescript
   * class MyDO extends LumenizeBase<Env> {
   *   async fetch(request: Request) {
   *     // Auto-initialize from headers
   *     await super.fetch(request);
   *     
   *     // Handle request
   *     return new Response('Hello');
   *   }
   * }
   * ```
   */
  async fetch(request: Request): Promise<Response> {
    try {
      await this.__initFromHeaders(request.headers);
    } catch (error) {
      // Initialization errors indicate misconfiguration
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 500 });
    }

    // Default: not implemented
    // Subclasses should override fetch() and call super.fetch() for auto-init
    return new Response('Not Implemented', { status: 501 });
  }

  /**
   * Initialize DO metadata from request headers
   * 
   * Reads `x-lumenize-do-binding-name` and `x-lumenize-do-instance-name-or-id`
   * headers and calls `__lmzInit()` if present. These headers are automatically
   * set by `routeDORequest` in @lumenize/utils.
   * 
   * This is called automatically by the default `fetch()` handler. If you
   * override `fetch()` and don't call `super.fetch()`, you can call this
   * method directly:
   * 
   * @param headers - HTTP headers from the request
   * 
   * @example
   * ```typescript
   * class MyDO extends LumenizeBase<Env> {
   *   async fetch(request: Request) {
   *     // Manual initialization (alternative to super.fetch())
   *     await this.__initFromHeaders(request.headers);
   *     
   *     // Handle request
   *     return new Response('Hello');
   *   }
   * }
   * ```
   */
  async __initFromHeaders(headers: Headers): Promise<void> {
    const doBindingName = headers.get('x-lumenize-do-binding-name');
    const doInstanceNameOrId = headers.get('x-lumenize-do-instance-name-or-id');

    // Only call init if at least one header is present
    if (doBindingName || doInstanceNameOrId) {
      await this.__lmzInit({
        doBindingName: doBindingName || undefined,
        doInstanceNameOrId: doInstanceNameOrId || undefined
      });
    }
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
   * Execute an OCAN (Operation Chaining And Nesting) operation chain on this DO.
   * 
   * This method enables remote DOs to call methods on this DO via @lumenize/call.
   * Any DO extending LumenizeBase can receive remote calls without additional setup.
   * 
   * @internal This is called by @lumenize/call, not meant for direct use
   * @param chain - The operation chain to execute
   * @returns The result of executing the operation chain
   * 
   * @example
   * ```typescript
   * // Remote DO sends this chain:
   * const remote = this.ctn<MyDO>().getUserData(userId);
   * 
   * // This DO receives and executes it:
   * const result = await this.__executeChain(remote);
   * // Equivalent to: this.getUserData(userId)
   * ```
   */
  async __executeChain(chain: OperationChain): Promise<any> {
    return await executeOperationChain(chain, this);
  }

  /**
   * Enqueue work for asynchronous processing (Actor Model)
   * 
   * This implements the actor model pattern: work is queued, sender returns
   * immediately, and receiver processes asynchronously. Used by @lumenize/call,
   * @lumenize/proxy-fetch, and other packages that need queued async processing.
   * 
   * @param workType - Type of work (e.g., 'call', 'fetch', custom types)
   * @param workId - Unique identifier for this work item
   * @param workData - Data for the work item
   * 
   * @example
   * ```typescript
   * // From @lumenize/call - queue remote operation
   * await remoteDO.__enqueueWork('call', operationId, {
   *   operationChain,
   *   returnAddress: { doBinding, instanceId }
   * });
   * 
   * // From @lumenize/proxy-fetch - queue fetch request
   * await orchestratorDO.__enqueueWork('fetch', requestId, {
   *   request,
   *   returnAddress: { doBinding, instanceId }
   * });
   * ```
   */
    async __enqueueWork(workType: string, workId: string, workData: any): Promise<void> {
      const queueKey = `__lmz_queue:${workType}:${workId}`;
      this.ctx.storage.kv.put(queueKey, workData);

    // Process queue asynchronously (after returning to caller)
    // Note: In DOs, async operations are automatically awaited
    void this.__processQueue(workType).catch((error: any) => {
      const log = (globalThis as any).__lumenizeDebug?.(this.ctx)?.('lmz.base.__enqueueWork');
      log?.error?.('Error processing queue', {
        workType,
        workId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    });
  }

  /**
   * Process queued work items for a specific work type
   * 
   * This method is called automatically after work is enqueued. Packages that
   * use the queue register handlers to process their work types.
   * 
   * @internal
   * @param workType - Type of work to process
   */
  async __processQueue(workType: string): Promise<void> {
    // Get all queue items for this work type
    const prefix = `__lmz_queue:${workType}:`;
    const queueItems = [...this.ctx.storage.kv.list({ prefix })];

    for (const [key, value] of queueItems) {
      const workId = key.substring(prefix.length);
      const workData = value;

      // Get handler for this work type
      const registry = (globalThis as any).__lumenizeWorkHandlers;
      const handler = registry?.[workType];

      if (!handler) {
        const log = (globalThis as any).__lumenizeDebug?.(this.ctx)?.('lmz.base.__processQueue');
        log?.error?.('No handler registered for work type', { workType, workId });
        // Remove invalid work item
        this.ctx.storage.kv.delete(key);
        continue;
      }

      try {
        // Call the handler
        await handler(this, workId, workData);

        // Remove from queue after successful processing
        this.ctx.storage.kv.delete(key);
      } catch (error) {
        const log = (globalThis as any).__lumenizeDebug?.(this.ctx)?.('lmz.base.__processQueue');
        log?.error?.('Work handler failed', {
          workType,
          workId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        // Note: Work item stays in queue for retry or manual cleanup
      }
    }
  }

  /**
   * Receive a result from queued work (Actor Model - Return Message)
   * 
   * This is called by remote DOs to send results back to the origin DO.
   * The result is stored and a result handler is invoked to process it.
   * 
   * @param workType - Type of work that produced this result
   * @param workId - ID of the work item
   * @param resultData - Result data (preprocessed by sender)
   * 
   * @example
   * ```typescript
   * // Remote DO sends result back after processing work
   * await originDO.__receiveResult('call', operationId, {
   *   result: userData,
   *   error: null
   * });
   * ```
   */
  async __receiveResult(workType: string, workId: string, resultData: any): Promise<void> {
    // Store result
    const resultKey = `__lmz_result:${workType}:${workId}`;
    this.ctx.storage.kv.put(resultKey, resultData);

    // Get result handler for this work type
    const registry = (globalThis as any).__lumenizeResultHandlers;
    const handler = registry?.[workType];

    if (!handler) {
      const log = (globalThis as any).__lumenizeDebug?.(this.ctx)?.('lmz.base.__receiveResult');
      log?.warn?.('No result handler registered for work type', { workType, workId });
      return;
    }

    try {
      // Call the result handler
      await handler(this, workId, resultData);

      // Remove result after successful processing
      this.ctx.storage.kv.delete(resultKey);
    } catch (error) {
      const log = (globalThis as any).__lumenizeDebug?.(this.ctx)?.('lmz.base.__receiveResult');
      log?.error?.('Result handler failed', {
        workType,
        workId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      // Note: Result stays in storage for retry or manual cleanup
    }
  }

  /**
   * Initialize DO metadata (binding name and instance name)
   * 
   * This method stores the DO's binding name and instance name in storage
   * for later use by services like @lumenize/call. Only names are stored;
   * IDs are always available via this.ctx.id.
   * 
   * This is typically called automatically when using:
   * - routeDORequest() - extracts from headers
   * - svc.call() - includes in envelope
   * 
   * But can be called manually if needed:
   * 
   * @param options - Optional initialization data
   * @param options.doBindingName - The binding name for this DO (e.g., 'USER_DO')
   * @param options.doInstanceNameOrId - The instance name or ID for this DO
   * 
   * @throws {Error} If provided values don't match stored values or this.ctx.id
   * 
   * @example
   * ```typescript
   * class MyDO extends LumenizeBase<Env> {
   *   async init(userId: string) {
   *     await this.__lmzInit({ 
   *       doBindingName: 'USER_DO',
   *       doInstanceNameOrId: userId 
   *     });
   *   }
   * }
   * ```
   */
  async __lmzInit(options?: {
    doBindingName?: string;
    doInstanceNameOrId?: string;
  }): Promise<void> {
    const { doBindingName, doInstanceNameOrId } = options || {};

    // Verify and store binding name if provided
    if (doBindingName !== undefined) {
      const storedBindingName = this.ctx.storage.kv.get('__lmz_do_binding_name');
      
      if (storedBindingName !== undefined) {
        // Verify it matches
        if (storedBindingName !== doBindingName) {
          throw new Error(
            `DO binding name mismatch: stored '${storedBindingName}' but received '${doBindingName}'. ` +
            `A DO instance cannot change its binding name.`
          );
        }
      } else {
        // Store it
        this.ctx.storage.kv.put('__lmz_do_binding_name', doBindingName);
      }
    }

    // Verify and store instance name if provided (IDs are not stored, always use this.ctx.id)
    if (doInstanceNameOrId !== undefined) {
      // Check if this is an ID or a name
      const isId = (await import('@lumenize/utils')).isDurableObjectId(doInstanceNameOrId);
      
      if (isId) {
        // Verify the ID matches this.ctx.id
        if (this.ctx.id.toString() !== doInstanceNameOrId) {
          throw new Error(
            `DO instance ID mismatch: this.ctx.id is '${this.ctx.id}' but received '${doInstanceNameOrId}'. ` +
            `A DO instance cannot change its ID.`
          );
        }
        // Don't store IDs - they're always available via this.ctx.id
      } else {
        // It's a name - verify and store it
        const storedInstanceName = this.ctx.storage.kv.get('__lmz_do_instance_name');
        
        if (storedInstanceName !== undefined) {
          // Verify it matches
          if (storedInstanceName !== doInstanceNameOrId) {
            throw new Error(
              `DO instance name mismatch: stored '${storedInstanceName}' but received '${doInstanceNameOrId}'. ` +
              `A DO instance cannot change its name.`
            );
          }
        } else {
          // Store the name
          this.ctx.storage.kv.put('__lmz_do_instance_name', doInstanceNameOrId);
        }
      }
    }
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

// Initialize global work handlers registry
if (!(globalThis as any).__lumenizeWorkHandlers) {
  (globalThis as any).__lumenizeWorkHandlers = {};
}

// Initialize global result handlers registry
if (!(globalThis as any).__lumenizeResultHandlers) {
  (globalThis as any).__lumenizeResultHandlers = {};
}

// Re-export the global LumenizeServices interface for convenience
export type { LumenizeServices } from './types';

