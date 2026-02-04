import { DurableObject } from 'cloudflare:workers';
import {
  newContinuation,
  executeOperationChain,
  replaceNestedOperationMarkers,
  type OperationChain,
  type Continuation,
  type AnyContinuation,
} from './ocan/index.js';
import { parse, postprocess } from '@lumenize/structured-clone';
import { isDurableObjectId } from '@lumenize/utils';
import { createLmzApiForDO, executeEnvelope, type LmzApi, type CallEnvelope } from './lmz-api.js';
import { debug } from '@lumenize/debug';
import { ClientDisconnectedError } from './lumenize-client-gateway.js';

// Re-export continuation types from ocan for convenience
export type { Continuation, AnyContinuation };

// Register ClientDisconnectedError on globalThis for proper structured-clone serialization
// This ensures LumenizeDO instances can deserialize this error type when received from Gateway
(globalThis as any).ClientDisconnectedError = ClientDisconnectedError;

/**
 * LumenizeDO - Base class for stateful Durable Objects in the Lumenize Mesh
 *
 * Provides automatic dependency injection for built-in and NADIS services via `this.svc.*`
 *
 * **Built-in services** (always available):
 * - `this.svc.sql` - SQL template literal tag for DO storage
 * - `this.svc.alarms` - Alarm scheduling with OCAN continuations
 *
 * **NADIS plugins** (import to enable):
 * - Import NADIS packages and access them via `this.svc`
 * - Full TypeScript autocomplete via declaration merging
 * - Lazy loading - services only instantiated when accessed
 *
 * @example
 * Basic usage:
 * ```typescript
 * import { LumenizeDO } from '@lumenize/mesh';
 *
 * class MyDO extends LumenizeDO<Env> {
 *   async getUser(id: string) {
 *     const rows = this.svc.sql`SELECT * FROM users WHERE id = ${id}`;
 *     return rows[0];
 *   }
 *
 *   scheduleTask() {
 *     // No import needed - alarms is built-in!
 *     this.svc.alarms.schedule(60, this.ctn().handleTask({ data: 'example' }));
 *   }
 *
 *   handleTask(payload: any) {
 *     console.log('Task executed:', payload);
 *   }
 * }
 * ```
 */
export abstract class LumenizeDO<Env = any> extends DurableObject<Env> {
  #serviceCache = new Map<string, any>();
  #svcProxy: LumenizeServices | null = null;
  #lmzApi: LmzApi | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Call onStart() wrapped in blockConcurrencyWhile if subclass defines it
    // This ensures initialization completes before any other operations
    if (this.onStart !== LumenizeDO.prototype.onStart) {
      ctx.blockConcurrencyWhile(async () => {
        try {
          await this.onStart();
        } catch (error) {
          const log = debug('lmz.mesh.LumenizeDO.onStart');
          log.error('onStart() failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          throw error;
        }
      });
    }
  }

  /**
   * Lifecycle hook for async initialization
   *
   * Override this method to perform initialization that needs to complete
   * before the DO handles any requests. Common uses:
   * - Database schema migrations (`CREATE TABLE IF NOT EXISTS`)
   * - Loading configuration from storage
   * - Setting up initial state
   *
   * This method is automatically wrapped in `blockConcurrencyWhile`, ensuring
   * it completes before fetch(), alarm(), or any RPC calls are processed.
   *
   * @example
   * ```typescript
   * class UsersDO extends LumenizeDO<Env> {
   *   async onStart() {
   *     this.svc.sql`
   *       CREATE TABLE IF NOT EXISTS users (
   *         id TEXT PRIMARY KEY,
   *         name TEXT NOT NULL
   *       )
   *     `;
   *   }
   * }
   * ```
   */
  async onStart(): Promise<void> {
    // Default: no-op. Subclasses override this for initialization.
  }

  /**
   * Alarm lifecycle handler - delegates to built-in alarms service
   *
   * This method is called by Cloudflare when a scheduled alarm fires.
   * It automatically delegates to `this.svc.alarms.alarm()` to execute
   * any pending scheduled tasks.
   *
   * **No override needed** - LumenizeDO handles alarm scheduling automatically.
   * Just use `this.svc.alarms.schedule()` to schedule tasks.
   *
   * @param alarmInfo - Cloudflare alarm invocation info
   *
   * @example
   * ```typescript
   * class MyDO extends LumenizeDO<Env> {
   *   scheduleTask() {
   *     // Schedule a task - alarm() handles execution automatically
   *     this.svc.alarms.schedule(60, this.ctn().handleTask({ data: 'example' }));
   *   }
   *
   *   handleTask(payload: { data: string }) {
   *     console.log('Task executed:', payload);
   *   }
   * }
   * ```
   */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.svc.alarms.alarm(alarmInfo);
  }

  /**
   * Lifecycle hook called before each incoming mesh call is executed
   *
   * Override this method to:
   * - Validate authentication/authorization based on `this.lmz.callContext`
   * - Populate `callContext.state` with computed data (sessions, permissions)
   * - Add logging or tracing metadata
   * - Reject unauthorized calls by throwing an error
   *
   * This hook is called AFTER the DO is initialized and BEFORE the operation
   * chain is executed. The `callContext` is available via `this.lmz.callContext`.
   *
   * **Important**: If you override this, remember to call `super.onBeforeCall()`
   * to ensure any parent class logic is also executed.
   *
   * @example
   * ```typescript
   * class SecureDocumentDO extends LumenizeDO<Env> {
   *   onBeforeCall(): void {
   *     super.onBeforeCall();
   *
   *     const { origin, originAuth, state } = this.lmz.callContext;
   *
   *     // Require authenticated origin for client calls
   *     if (origin.type === 'LumenizeClient' && !originAuth?.sub) {
   *       throw new Error('Authentication required');
   *     }
   *
   *     // Cache computed permissions in state (synchronously)
   *     state.canEdit = this.#permissions.get(originAuth?.sub);
   *   }
   * }
   * ```
   */
  onBeforeCall(): void {
    // Default: no-op. Subclasses override this for authentication/authorization.
  }

  /**
   * Default fetch handler that auto-initializes DO metadata from headers
   * 
   * This handler automatically reads `x-lumenize-do-binding-name` and
   * `x-lumenize-do-instance-name-or-id` headers (set by routeDORequest)
   * and stores them for use by this.lmz.call() and other services.
   * 
   * Subclasses should call `super.fetch(request)` at the start of their
   * fetch handler to enable auto-initialization:
   * 
   * @param request - The incoming HTTP request
   * @returns HTTP 501 Not Implemented (subclasses should override)
   * 
   * @example
   * ```typescript
   * class MyDO extends LumenizeDO<Env> {
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
    // Initialize from headers - returns Response on error, undefined on success
    const initError = this.__initFromHeaders(request.headers);
    if (initError) {
      return initError;
    }

    // Default: not implemented
    // Subclasses should override fetch() and call super.fetch() for auto-init
    return new Response('Not Implemented', { status: 501 });
  }

  /**
   * Initialize DO metadata from request headers
   *
   * Reads `x-lumenize-do-binding-name` and `x-lumenize-do-instance-name-or-id`
   * headers and calls `this.lmz.__init()` if present. These headers are automatically
   * set by `routeDORequest` in @lumenize/utils.
   *
   * **Validation**: If the instance header contains a Durable Object ID (64-char hex string)
   * instead of a name, returns an HTTP 400 error. LumenizeDO requires instance names for
   * proper mesh addressing.
   *
   * This is called automatically by the default `fetch()` handler. If you
   * override `fetch()` and don't call `super.fetch()`, you can call this
   * method directly:
   *
   * @param headers - HTTP headers from the request
   * @returns Response with HTTP 400 error if validation fails, undefined on success
   *
   * @example
   * ```typescript
   * class MyDO extends LumenizeDO<Env> {
   *   async fetch(request: Request) {
   *     // Manual initialization (alternative to super.fetch())
   *     const error = this.__initFromHeaders(request.headers);
   *     if (error) return error;
   *
   *     // Handle request
   *     return new Response('Hello');
   *   }
   * }
   * ```
   */
  __initFromHeaders(headers: Headers): Response | undefined {
    const doBindingName = headers.get('x-lumenize-do-binding-name');
    const doInstanceNameOrId = headers.get('x-lumenize-do-instance-name-or-id');

    // Validate that instance is a name, not an ID
    if (doInstanceNameOrId && isDurableObjectId(doInstanceNameOrId)) {
      const log = debug('lmz.mesh.LumenizeDO.__initFromHeaders');
      const message = 'LumenizeDO requires instanceName, not a DO id string.';
      log.error(message, { receivedValue: doInstanceNameOrId });
      return new Response(message, { status: 400 });
    }

    // Only call __init if at least one header is present
    if (doBindingName || doInstanceNameOrId) {
      try {
        this.lmz.__init({
          bindingName: doBindingName || undefined,
          instanceName: doInstanceNameOrId || undefined
        });
      } catch (error) {
        // __init throws on mismatch - convert to HTTP response
        const log = debug('lmz.mesh.LumenizeDO.__initFromHeaders');
        const message = error instanceof Error ? error.message : String(error);
        log.error('Initialization from headers failed', {
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        });
        return new Response(message, { status: 500 });
      }
    }

    return undefined; // Success
  }

  /**
   * Create an OCAN (Operation Chaining And Nesting) continuation proxy
   *
   * Returns a proxy that records method calls into an operation chain.
   * Used with async strategies (alarms, call, proxyFetch) to define
   * what to execute when the operation completes.
   *
   * When called without a type parameter, returns a continuation typed to the
   * concrete subclass. When called with a type parameter (e.g., `ctn<RemoteDO>()`),
   * returns a continuation for that remote type.
   *
   * @example
   * ```typescript
   * // Local method chaining
   * this.svc.alarms.schedule(60, this.ctn().handleTask({ data: 'example' }));
   *
   * // Remote DO calls
   * const remote = this.ctn<RemoteDO>().getUserData(userId);
   * this.lmz.call(REMOTE_DO, 'instance-id', remote, this.ctn().handleResult(remote));
   *
   * // Nesting
   * const data1 = this.ctn().getData(1);
   * const data2 = this.ctn().getData(2);
   * this.svc.alarms.schedule(60, this.ctn().combineData(data1, data2));
   * ```
   */
  ctn(): Continuation<this>;
  ctn<T>(): Continuation<T>;
  ctn(): Continuation<unknown> {
    return newContinuation() as Continuation<unknown>;
  }

  /**
   * Execute an OCAN (Operation Chaining And Nesting) operation chain on this DO.
   *
   * This method enables remote DOs to call methods on this DO via this.lmz.call().
   * Any DO extending LumenizeDO can receive remote calls without additional setup.
   *
   * **Security**: This method always enforces @mesh decorator requirement for
   * incoming calls. The options parameter is intentionally not exposed - use the
   * private `#executeChainLocal()` method for internal calls that need to bypass
   * the @mesh check.
   *
   * @internal This is called by this.lmz.call(), not meant for direct use
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
    // Always require @mesh decorator for RPC-exposed method (secure by default)
    return await executeOperationChain(chain, this);
  }

  /**
   * Execute an operation chain locally with configurable options
   *
   * This is a TRUE PRIVATE method (using #) so it cannot be called via RPC.
   * Used by internal services that need to execute continuations without
   * requiring @mesh decorator:
   * - Alarms service (local timer callbacks)
   * - lmz.call() handler callbacks
   *
   * @param chain - The operation chain to execute
   * @param options - Configuration options
   * @returns The result of executing the operation chain
   */
  #executeChainLocal(chain: OperationChain, options?: { requireMeshDecorator?: boolean }): Promise<any> {
    return executeOperationChain(chain, this, options);
  }

  /**
   * Get the local chain executor for internal use
   *
   * This method provides access to the private #executeChainLocal method
   * for trusted internal code (like lmz.call() handlers and alarms).
   *
   * **Security**: This returns a function bound to this instance. The returned
   * function can bypass @mesh checks, but the method itself just returns a
   * function reference - it doesn't execute anything. Attackers calling this
   * via RPC would get a function they can't actually use (it won't serialize
   * over RPC boundaries).
   *
   * @internal
   */
  get __localChainExecutor(): (chain: OperationChain, options?: { requireMeshDecorator?: boolean }) => Promise<any> {
    return this.#executeChainLocal.bind(this);
  }

  /**
   * Receive and execute an RPC call envelope with auto-initialization
   * 
   * Handles versioned envelopes and automatically initializes this DO's identity
   * from the callee metadata included in the envelope. This enables DOs to learn
   * their binding name and instance name from the first incoming call.
   * 
   * **Envelope format**:
   * - `version: 1` - Current envelope version (required)
   * - `chain` - Preprocessed operation chain to execute
   * - `metadata.callee` - Identity of this DO (used for auto-initialization)
   * 
   * @internal This is called by this.lmz.callRaw(), not meant for direct use
   * @param envelope - The call envelope with version, chain, and metadata
   * @returns The result of executing the operation chain
   * @throws Error if envelope version is not 1
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  async __executeOperation(envelope: CallEnvelope): Promise<any> {
    const log = debug('lmz.mesh.LumenizeDO.__executeOperation');

    return await executeEnvelope(envelope, this, {
      nodeTypeName: 'LumenizeDO',
      includeInstanceName: true,
      onValidationError: (error, details) => {
        log.error(error.message.split('.')[0], details);
      },
    });
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
   * **OCAN Integration**: Uses @lumenize/mesh's operation chain machinery to:
   * - Deserialize the stored continuation and result (via postprocess)
   * - Inject the result into the continuation (via replaceNestedOperationMarkers)
   * - Execute the continuation (via executeOperationChain)
   * 
   * Used by @lumenize/proxy-fetch and other async actor-model packages.
   * 
   * @param workType - Type of work that produced this result (e.g., 'call', 'proxyFetch')
   * @param workId - ID of the work item (e.g., operationId, reqId)
   * @param preprocessedResult - Result data (preprocessed by sender via preprocess())
   * 
   * @example
   * ```typescript
   * // Executor sends result back after external fetch completes
   * await originDO.__receiveResult('proxyFetch', reqId, 
   *   preprocess({ response: responseSync })
   * );
   * 
   * // Origin DO executes stored continuation:
   * // this.handleResult({ userId: '123' }, responseSync)
   * ```
   */
  async __receiveResult(workType: string, workId: string, preprocessedResult: any): Promise<void> {
    const log = debug('lmz.mesh.LumenizeDO.__receiveResult');

    // 1. Idempotency check - prevent duplicate result processing
    const processedKey = `__lmz_result_processed:${workType}:${workId}`;
    const alreadyProcessed = this.ctx.storage.kv.get(processedKey);

    if (alreadyProcessed !== undefined) {
      log.error('Duplicate result received - race condition detected', {
        workId,
        workType,
        firstProcessedAt: alreadyProcessed,
        duplicateNote: 'Race between successful delivery and timeout (expected in rare cases)',
      });
      return; // Ignore duplicate
    }

    // Mark as processed BEFORE executing continuation (prevents race)
    this.ctx.storage.kv.put(processedKey, Date.now());

    // 2. Get stored continuation
    const pendingKey = `__lmz_${workType}_pending:${workId}`;
    const pendingData = this.ctx.storage.kv.get(pendingKey) as { continuation: any } | undefined;

    if (!pendingData) {
      log.warn('No pending continuation found', { workId, workType });
      return;
    }

    try {
      // 3. Deserialize continuation and result (REUSE: structured-clone)
      const continuation = postprocess(pendingData.continuation);
      const result = postprocess(preprocessedResult);

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
      log.error('Continuation execution failed', {
        workId,
        workType,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Note: Pending continuation stays in storage for manual investigation
      // Processed marker stays to prevent re-execution
    }
  }

  /**
   * Access Lumenize infrastructure: identity and RPC methods
   *
   * Provides clean abstraction over identity management and RPC infrastructure:
   * - **Identity**: `bindingName`, `instanceName`, `id`, `type`
   * - **RPC**: `callRaw()`, `call()`
   *
   * Properties are read-only getters that read from DO storage.
   * Identity is set automatically via headers from `routeDORequest` or
   * from the envelope metadata when receiving mesh calls.
   *
   * @see [Usage Examples](https://lumenize.com/docs/mesh/calls) - Complete tested examples
   */
  get lmz(): LmzApi {
    if (!this.#lmzApi) {
      this.#lmzApi = createLmzApiForDO(this.ctx, this.env, this);
    }
    return this.#lmzApi;
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
      get: (_target, prop: string) => {
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

        const log = debug('lmz.mesh.LumenizeDO.svc');
        const error = new Error(
          `Service '${prop}' not found. Did you import the NADIS package? ` +
          `Example: import '@lumenize/${prop}';`
        );
        log.error('NADIS service not found', {
          service: prop,
          hint: `import '@lumenize/${prop}';`,
        });
        throw error;
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

// Expose LumenizeDO prototype for method overrides (e.g., __processCallQueue)
(globalThis as any).__LumenizeDOPrototype = LumenizeDO.prototype;

// Backwards compatibility alias (deprecated)
/** @deprecated Use LumenizeDO instead */
export { LumenizeDO as LumenizeBase };

// Re-export the global LumenizeServices interface for convenience
export type { LumenizeServices } from './types';

// Register built-in sql service (always available on this.svc.sql for LumenizeDO subclasses)
import { sql } from './sql';
(globalThis as any).__lumenizeServiceRegistry['sql'] = (doInstance: any) => sql(doInstance);

// Register built-in alarms service (always available on this.svc.alarms for LumenizeDO subclasses)
import { Alarms } from './alarms';
(globalThis as any).__lumenizeServiceRegistry['alarms'] = (doInstance: any) => new Alarms(doInstance);

