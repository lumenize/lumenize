import { DurableObject } from 'cloudflare:workers';
import { newContinuation, executeOperationChain, replaceNestedOperationMarkers, type OperationChain } from './ocan/index.js';
import { postprocess } from '@lumenize/structured-clone';
import { isDurableObjectId } from '@lumenize/utils';

/**
 * Continuation type with $result marker for explicit result placement.
 * $result is typed as `any` because it's a placeholder that gets replaced
 * at runtime with the actual result (which can be any type).
 */
export type Continuation<T> = T & { $result: any };

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
      this.__initFromHeaders(request.headers);
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
   * Default alarm handler that delegates to @lumenize/alarms service
   * 
   * If @lumenize/alarms is installed, this delegates to its alarm() handler.
   * Otherwise, this is a no-op.
   * 
   * Subclasses that need custom alarm handling should call `super.alarm()` first
   * to ensure alarms service alarms are processed.
   */
  async alarm(): Promise<void> {
    // Delegate to alarms service if installed
    if (this.svc && typeof this.svc.alarms?.alarm === 'function') {
      await this.svc.alarms.alarm();
    }
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
   *     this.__initFromHeaders(request.headers);
   *     
   *     // Handle request
   *     return new Response('Hello');
   *   }
   * }
   * ```
   */
  __initFromHeaders(headers: Headers): void {
    const doBindingName = headers.get('x-lumenize-do-binding-name');
    const doInstanceNameOrId = headers.get('x-lumenize-do-instance-name-or-id');

    // Only call init if at least one header is present
    if (doBindingName || doInstanceNameOrId) {
      this.__lmzInit({
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
  ctn<T = this>(): Continuation<T> {
    return newContinuation<T>() as Continuation<T>;
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
   * The result is deserialized, injected into the stored continuation, and executed.
   * 
   * **Idempotency**: This method prevents duplicate result processing (race conditions).
   * If the same result arrives multiple times (e.g., Executor succeeds + Orchestrator
   * times out), only the first result is processed. Subsequent duplicates are logged
   * as errors and ignored.
   * 
   * **OCAN Integration**: Uses @lumenize/core's operation chain machinery to:
   * - Deserialize the stored continuation and result (via postprocess)
   * - Inject the result into the continuation (via replaceNestedOperationMarkers)
   * - Execute the continuation (via executeOperationChain)
   * 
   * Used by @lumenize/call, @lumenize/proxy-fetch, and other async actor-model packages.
   * 
   * @param workType - Type of work that produced this result (e.g., 'call', 'proxyFetch')
   * @param workId - ID of the work item (e.g., operationId, reqId)
   * @param preprocessedResult - Result data (preprocessed by sender via preprocess())
   * 
   * @example
   * ```typescript
   * // Executor sends result back after external fetch completes
   * await originDO.__receiveResult('proxyFetch', reqId, 
   *   await preprocess({ response: responseSync })
   * );
   * 
   * // Origin DO executes stored continuation:
   * // this.handleResult({ userId: '123' }, responseSync)
   * ```
   */
  async __receiveResult(workType: string, workId: string, preprocessedResult: any): Promise<void> {
    const log = (globalThis as any).__lumenizeDebug?.(this.ctx)?.('lmz.base.__receiveResult');

    // 1. Idempotency check - prevent duplicate result processing
    const processedKey = `__lmz_result_processed:${workType}:${workId}`;
    const alreadyProcessed = this.ctx.storage.kv.get(processedKey);
    
    if (alreadyProcessed !== undefined) {
      log?.error?.('Duplicate result received - race condition detected', {
        workId,
        workType,
        firstProcessedAt: alreadyProcessed,
        duplicateNote: 'Race between successful delivery and timeout (expected in rare cases)'
      });
      return; // Ignore duplicate
    }
    
    // Mark as processed BEFORE executing continuation (prevents race)
    this.ctx.storage.kv.put(processedKey, Date.now());
    
    // 2. Get stored continuation
    const pendingKey = `__lmz_${workType}_pending:${workId}`;
    const pendingData = this.ctx.storage.kv.get(pendingKey);
    
    if (!pendingData) {
      log?.warn?.('No pending continuation found', { workId, workType });
      return;
    }
    
    try {
      // 3. Deserialize continuation and result (REUSE: structured-clone)
      const continuation = await postprocess(pendingData.continuation);
      const result = await postprocess(preprocessedResult);
      
      // 4. Inject result into continuation (REUSE: OCAN)
      const chainWithResult = replaceNestedOperationMarkers(continuation, result);
      
      // 5. Execute continuation (REUSE: OCAN)
      await executeOperationChain(chainWithResult, this);
      
      // 6. Clean up pending continuation
      this.ctx.storage.kv.delete(pendingKey);
      
      // Clean up processed marker after 5 minutes (prevents storage bloat)
      setTimeout(() => {
        this.ctx.storage.kv.delete(processedKey);
      }, 5 * 60 * 1000);
      
    } catch (error) {
      log?.error?.('Continuation execution failed', {
        workId,
        workType,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      // Note: Pending continuation stays in storage for manual investigation
      // Processed marker stays to prevent re-execution
    }
  }

  /**
   * Process a queued call operation (internal handler for @lumenize/call)
   * 
   * This method is called by alarms.schedule(0, ...) from call() to process
   * async operations (preprocessing and RPC) without blocking the caller.
   * 
   * The call data is retrieved from storage using the callId to avoid
   * passing complex operation chains through OCAN.
   * 
   * @param callId - Unique identifier for this call (stored in __lmz_call_data:{callId})
   * 
   * @internal Called by @lumenize/call via alarms
   */
  async __processCallQueue(
    callId: string
  ): Promise<void> {
    // Implemented by @lumenize/call - this is just a placeholder
    throw new Error('__processCallQueue called but @lumenize/call is not imported');
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
   *   init(userId: string) {
   *     this.__lmzInit({ 
   *       doBindingName: 'USER_DO',
   *       doInstanceNameOrId: userId 
   *     });
   *   }
   * }
   * ```
   */
  __lmzInit(options?: {
    doBindingName?: string;
    doInstanceNameOrId?: string;
  }): void {
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
      const isId = isDurableObjectId(doInstanceNameOrId);
      
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

// Expose LumenizeBase prototype for method overrides (e.g., __processCallQueue)
(globalThis as any).__LumenizeBasePrototype = LumenizeBase.prototype;

// Re-export the global LumenizeServices interface for convenience
export type { LumenizeServices } from './types';

