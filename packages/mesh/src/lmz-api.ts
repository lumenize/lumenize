import { isDurableObjectId, getDOStub } from '@lumenize/routing';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getOperationChain, executeOperationChain, replaceNestedOperationMarkers, type OperationChain, type Continuation, type AnyContinuation } from './ocan/index.js';
import type { NodeType, NodeIdentity, CallContext, CallOptions, OriginAuth } from './types.js';

// Re-export types for convenience
export type { NodeType, NodeIdentity, CallContext, CallOptions, OriginAuth };

// ============================================
// CallContext AsyncLocalStorage
// ============================================

/**
 * AsyncLocalStorage for call context propagation
 *
 * This provides request-scoped storage for CallContext, ensuring that
 * `this.lmz.callContext` always returns the correct context even when
 * multiple concurrent requests are being processed.
 *
 * @internal
 */
export const callContextStorage = new AsyncLocalStorage<CallContext>();

/**
 * Get the current call context from AsyncLocalStorage
 *
 * @returns The current CallContext, or undefined if not in a call context
 * @internal
 */
export function getCurrentCallContext(): CallContext | undefined {
  return callContextStorage.getStore();
}

/**
 * Run a function with a specific call context
 *
 * @param context - The CallContext to use
 * @param fn - The function to run
 * @returns The result of the function
 * @internal
 */
export function runWithCallContext<T>(context: CallContext, fn: () => T): T {
  return callContextStorage.run(context, fn);
}

/**
 * Clone the current call context for capture
 *
 * When capturing context for later execution (e.g., in lmz.call() handlers),
 * we must deep clone to prevent mutations from affecting the captured snapshot.
 *
 * @returns A deep clone of the current CallContext, or undefined if not in a call context
 * @internal
 */
export function captureCallContext(): CallContext | undefined {
  const current = callContextStorage.getStore();
  if (!current) return undefined;

  return {
    ...current,
    callChain: [...current.callChain],
    state: { ...current.state }
  };
}

// ============================================
// Shared Call Helpers
// ============================================

/**
 * Type for a local chain executor function
 *
 * Both LumenizeDO and LumenizeWorker expose this via `__localChainExecutor`.
 * LumenizeClient uses `executeOperationChain` directly.
 *
 * @internal
 */
export type LocalChainExecutor = (
  chain: OperationChain,
  options?: { requireMeshDecorator?: boolean }
) => Promise<any>;

/**
 * Extract and validate operation chains from continuations
 *
 * Shared logic for DO, Worker, and Client call() methods.
 *
 * @param remoteContinuation - The remote continuation to execute
 * @param handlerContinuation - Optional handler continuation for callbacks
 * @returns Object with remoteChain and handlerChain (if provided)
 * @throws Error if continuations are invalid
 * @internal
 */
export function extractCallChains(
  remoteContinuation: AnyContinuation,
  handlerContinuation?: AnyContinuation
): { remoteChain: OperationChain; handlerChain?: OperationChain } {
  const remoteChain = getOperationChain(remoteContinuation);
  if (!remoteChain) {
    throw new Error('Invalid remoteContinuation: must be created with this.ctn()');
  }

  let handlerChain: OperationChain | undefined;
  if (handlerContinuation) {
    handlerChain = getOperationChain(handlerContinuation);
    if (!handlerChain) {
      throw new Error('Invalid handlerContinuation: must be created with this.ctn()');
    }
  }

  return { remoteChain, handlerChain };
}

/**
 * Create a handler executor function with captured context
 *
 * Shared logic for executing handler callbacks with proper context restoration.
 * Used by DO, Worker, and Client call() methods.
 *
 * @param localExecutor - Function to execute the chain locally
 * @param capturedContext - The call context captured at call time (may be undefined)
 * @returns A function that executes a chain with the captured context
 * @internal
 */
export function createHandlerExecutor(
  localExecutor: LocalChainExecutor,
  capturedContext: CallContext | undefined
): (chain: OperationChain) => Promise<any> {
  return async (chain: OperationChain) => {
    if (capturedContext) {
      return runWithCallContext(capturedContext, async () => {
        return await localExecutor(chain, { requireMeshDecorator: false });
      });
    } else {
      return await localExecutor(chain, { requireMeshDecorator: false });
    }
  };
}

/**
 * Execute handler continuation with result or error
 *
 * Shared logic for the then/catch handler execution pattern.
 * Substitutes result/error into the handler chain and executes it.
 *
 * @param handlerChain - The handler continuation chain (may be undefined for fire-and-forget)
 * @param resultOrError - The result or error to inject into the handler
 * @param executeHandler - The executor function (from createHandlerExecutor)
 * @internal
 */
export async function executeHandlerWithResult(
  handlerChain: OperationChain | undefined,
  resultOrError: any,
  executeHandler: (chain: OperationChain) => Promise<any>
): Promise<void> {
  if (!handlerChain) return;

  // Normalize errors
  const value = resultOrError instanceof Error
    ? resultOrError
    : resultOrError;

  const finalChain = replaceNestedOperationMarkers(handlerChain, value);
  await executeHandler(finalChain);
}

/**
 * Set up fire-and-forget call with handler callbacks
 *
 * Shared logic for DO and Client call() methods that return immediately.
 * Worker uses a slightly different async pattern but shares the helpers.
 *
 * @param callPromise - Promise that resolves with the remote call result
 * @param handlerChain - Optional handler continuation for callbacks
 * @param executeHandler - The executor function (from createHandlerExecutor)
 * @internal
 */
export function setupFireAndForgetHandler(
  callPromise: Promise<any>,
  handlerChain: OperationChain | undefined,
  executeHandler: (chain: OperationChain) => Promise<any>
): Promise<void> {
  return callPromise
    .then(async (result) => {
      await executeHandlerWithResult(handlerChain, result, executeHandler);
    })
    .catch(async (error) => {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      await executeHandlerWithResult(handlerChain, errorObj, executeHandler);
    });
}

// ============================================
// CallContext Building
// ============================================

/**
 * Build the CallContext for an outgoing call
 *
 * Handles both `newChain: true` (fresh context) and default (inherit + extend).
 *
 * @param callerIdentity - This node's identity (to add to callChain)
 * @param options - CallOptions with newChain and state
 * @returns CallContext to include in the envelope
 * @internal
 */
export function buildOutgoingCallContext(
  callerIdentity: NodeIdentity,
  options?: CallOptions
): CallContext {
  const currentContext = getCurrentCallContext();

  if (options?.newChain || !currentContext) {
    // Start a fresh chain - caller becomes the origin
    // callChain = [caller] (caller is both origin and immediate caller)
    return {
      callChain: [callerIdentity],
      originAuth: undefined,
      state: options?.state ?? {}
    };
  }

  // Inherit and extend the current context
  // Append this node to the call chain (so receiver knows who called them)
  const newCallChain = [...currentContext.callChain, callerIdentity];

  // Merge state if provided (options.state takes precedence on conflicts)
  const newState = options?.state
    ? { ...currentContext.state, ...options.state }
    : currentContext.state;

  return {
    callChain: newCallChain,
    originAuth: currentContext.originAuth,
    state: newState
  };
}

/**
 * Versioned envelope for RPC calls with automatic metadata propagation
 *
 * Enables auto-initialization of identity across distributed DO/Worker graphs.
 * Version field allows future evolution without breaking changes.
 *
 * ## Serialization Analysis
 *
 * Different fields have different serialization requirements based on what
 * types they can contain and what transport they cross:
 *
 * | Field | Extended Types? | Preprocessing |
 * |-------|-----------------|---------------|
 * | `version` | No (literal `1`) | Never |
 * | `metadata` | No (plain strings) | Never |
 * | `callContext.callChain` | No (plain strings) | Never |
 * | `callContext.originAuth` | No (from JWT) | Never |
 * | `callContext.state` | Yes (user-defined) | Over WebSocket: Yes |
 * | `chain` (contains args) | Yes (method arguments) | Over WebSocket: Yes |
 *
 * Workers RPC uses native structured clone which handles Maps, Sets, Dates, etc.
 * WebSocket uses JSON which requires preprocess/postprocess from @lumenize/structured-clone.
 *
 * Note: Response `error` fields always use preprocess/postprocess (even over Workers RPC)
 * to preserve custom Error subclass properties that native structured clone loses.
 */
export interface CallEnvelope {
  /**
   * Version number for envelope format (currently 1)
   *
   * Plain number - never needs preprocessing.
   */
  version: 1;

  /**
   * Operation chain to execute on remote DO/Worker
   *
   * Contains method name and arguments (`args: any[]`) which may include
   * Maps, Sets, Dates, or other extended types.
   *
   * **Preprocessing**: Required over WebSocket; not needed over Workers RPC.
   */
  chain: any;

  /**
   * Call context propagated through the mesh
   *
   * See CallContext for field-level serialization requirements.
   */
  callContext: CallContext;

  /**
   * Metadata about caller and callee for auto-initialization
   *
   * All fields are plain strings - never needs preprocessing.
   */
  metadata?: {
    /** Information about the caller (who is making this call) */
    caller: {
      /** Type of caller */
      type: NodeType;
      /** Binding name of caller (e.g., 'USER_DO') */
      bindingName?: string;
      /** Instance name of caller (DOs only, Workers are ephemeral) */
      instanceName?: string;
    };
    /** Information about the callee (who should receive this call) */
    callee: {
      /** Type of callee */
      type: NodeType;
      /** Binding name of callee (e.g., 'REMOTE_DO') */
      bindingName: string;
      /** Instance name of callee (DOs only, undefined for Workers) */
      instanceName?: string;
    };
  };
}

/**
 * Lumenize API - Identity and RPC infrastructure for LumenizeDO and LumenizeWorker
 *
 * Provides clean abstraction over identity management (binding name, instance name)
 * and RPC infrastructure (callRaw, call) for both Durable Objects and Worker Entrypoints.
 *
 * Properties are accessed via simple getters/setters (not a Proxy - properties are known and fixed).
 * Implementation details (storage vs private fields) are hidden from users.
 *
 * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
 */
export interface LmzApi {
  /**
   * Binding name for this DO or Worker (e.g., 'USER_DO')
   *
   * - **LumenizeDO**: Stored in `ctx.storage.kv.get('__lmz_do_binding_name')`
   * - **LumenizeWorker**: Stored in private field
   *
   * **Validation**: Cannot be changed once set to a different value
   */
  readonly bindingName?: string;

  /**
   * Instance name for this DO (undefined for Workers)
   *
   * - **LumenizeDO**: Stored in `ctx.storage.kv.get('__lmz_do_instance_name')`
   * - **LumenizeWorker**: Always undefined (Workers are ephemeral)
   *
   * **Validation**: Cannot be changed once set to a different value
   */
  readonly instanceName?: string;

  /**
   * Type of this DO or Worker
   *
   * - **LumenizeDO**: Returns `'LumenizeDO'`
   * - **LumenizeWorker**: Returns `'LumenizeWorker'`
   *
   * Getter-only property determined by class type.
   */
  readonly type: NodeType;

  /**
   * Current call context (only valid during `@mesh` handler execution)
   *
   * Contains origin, originAuth, callChain, and state for the current request.
   * Uses AsyncLocalStorage internally, so concurrent requests are isolated.
   *
   * @throws Error if accessed outside of a mesh call context
   *
   * @example
   * ```typescript
   * @mesh()
   * updateDocument(changes: DocumentChange) {
   *   const sub = this.lmz.callContext.originAuth?.sub;
   *   const fullPath = this.lmz.callContext.callChain.map(n => n.bindingName).join(' → ');
   * }
   * ```
   */
  readonly callContext: CallContext;

  /**
   * Initialize identity - internal use only
   *
   * Called by `__initFromHeaders()` and envelope processing. Not for external use.
   *
   * @internal
   */
  __init(options: { bindingName?: string; instanceName?: string }): void;

  /**
   * Raw async RPC call with automatic metadata propagation
   *
   * Infrastructure-level method for DO-to-DO and DO-to-Worker RPC calls.
   * Automatically gathers caller/callee metadata and builds versioned envelope.
   *
   * **Use cases**:
   * - NADIS plugins (proxy-fetch, alarms) that need RPC infrastructure
   * - Tests that want simple async/await pattern
   * - User code that doesn't need continuation pattern
   *
   * **Parameters**:
   * - `calleeBindingName` - Binding name of target DO or Worker (e.g., 'REMOTE_DO')
   * - `calleeInstanceName` - Instance name for DOs, undefined for Workers
   * - `chainOrContinuation` - Operation chain or Continuation from `this.ctn()`
   * - `options` - Optional configuration
   *
   * **Returns**: Postprocessed result from remote DO/Worker
   *
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  callRaw(
    calleeBindingName: string,
    calleeInstanceName: string | undefined,
    chainOrContinuation: OperationChain | AnyContinuation,
    options?: CallOptions
  ): Promise<any>;

  /**
   * Fire-and-forget RPC call with continuation pattern
   *
   * High-level method for DO-to-DO/Worker calls using continuation pattern.
   * Returns immediately while work executes asynchronously in the background.
   *
   * **Use cases**:
   * - Application code that wants actor model behavior
   * - Event handlers that need to trigger remote calls without blocking
   * - Methods that want to chain operations across DOs
   * - Fire-and-forget calls (omit handler)
   *
   * **Continuation pattern**:
   * - Remote continuation: what to execute on remote DO/Worker
   * - Handler continuation (optional): what to execute locally when result arrives
   * - Result/error automatically injected into handler via OCAN markers
   *
   * **Requirements**:
   * - Caller must know its own bindingName (set in constructor via `this.lmz.init()`)
   * - Continuations must be created with `this.ctn()`
   *
   * **Parameters**:
   * - `calleeBindingName` - Binding name of target DO/Worker (e.g., 'REMOTE_DO')
   * - `calleeInstanceName` - Instance name of target DO (undefined for Workers)
   * - `remoteContinuation` - What to execute remotely (from `this.ctn<RemoteDO>()`)
   * - `handlerContinuation` - Optional: What to execute locally when done (from `this.ctn()`)
   * - `options` - Optional configuration
   *
   * **Returns**: void (returns immediately, handler executes asynchronously if provided)
   *
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  call<T = any>(
    calleeBindingName: string,
    calleeInstanceName: string | undefined,
    remoteContinuation: Continuation<T>,
    handlerContinuation?: AnyContinuation,
    options?: CallOptions
  ): void;
}

/**
 * Create LmzApi implementation for LumenizeDO
 *
 * Identity stored in Durable Object storage:
 * - `bindingName` → `ctx.storage.kv.get/put('__lmz_do_binding_name')`
 * - `instanceName` → `ctx.storage.kv.get/put('__lmz_do_instance_name')`
 *
 * @internal Used by LumenizeDO.lmz getter
 */
export function createLmzApiForDO(ctx: DurableObjectState, env: any, doInstance: any): LmzApi {
  // Private method to set bindingName (used internally by __init)
  function setBindingName(value: string): void {
    const stored = ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;

    if (stored !== undefined && stored !== value) {
      throw new Error(
        `DO binding name mismatch: stored '${stored}' but received '${value}'. ` +
        `A DO instance cannot change its binding name.`
      );
    }

    ctx.storage.kv.put('__lmz_do_binding_name', value);
  }

  // Private method to set instanceName (used internally by __init)
  function setInstanceName(value: string): void {
    const stored = ctx.storage.kv.get('__lmz_do_instance_name') as string | undefined;

    if (stored !== undefined && stored !== value) {
      throw new Error(
        `DO instance name mismatch: stored '${stored}' but received '${value}'. ` +
        `A DO instance cannot change its name.`
      );
    }

    ctx.storage.kv.put('__lmz_do_instance_name', value);
  }

  return {
    // --- Getters (all readonly) ---

    get bindingName(): string | undefined {
      return ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
    },

    get instanceName(): string | undefined {
      return ctx.storage.kv.get('__lmz_do_instance_name') as string | undefined;
    },

    get type(): 'LumenizeDO' {
      return 'LumenizeDO';
    },

    get callContext(): CallContext {
      const context = getCurrentCallContext();
      if (!context) {
        throw new Error(
          'Cannot access callContext outside of a mesh call. ' +
          'callContext is only available during @mesh handler execution.'
        );
      }
      return context;
    },

    // --- Internal init method (called by __initFromHeaders and envelope processing) ---

    /**
     * @internal Initialize identity - not for external use
     */
    __init(options: { bindingName?: string; instanceName?: string }): void {
      if (options.bindingName !== undefined) {
        setBindingName(options.bindingName);
      }

      if (options.instanceName !== undefined) {
        setInstanceName(options.instanceName);
      }
    },
    
    async callRaw(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      chainOrContinuation: OperationChain | AnyContinuation,
      options?: CallOptions
    ): Promise<any> {
      // 1. Extract chain from Continuation if needed
      const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;

      // 2. Build caller identity for callContext
      const callerIdentity: NodeIdentity = {
        type: this.type,
        bindingName: this.bindingName!,
        instanceName: this.instanceName
      };

      // 3. Determine callee type
      const calleeType: NodeType = calleeInstanceName ? 'LumenizeDO' : 'LumenizeWorker';

      // 4. Build callContext for outgoing call
      const callContext = buildOutgoingCallContext(callerIdentity, options);

      // 5. Gather metadata for auto-init of uninitialized nodes
      const metadata = {
        caller: {
          type: this.type,
          bindingName: this.bindingName,
          instanceName: this.instanceName
        },
        callee: {
          type: calleeType,
          bindingName: calleeBindingName,
          instanceName: calleeInstanceName
        }
      };

      // 6. Create versioned envelope with callContext
      // Only chain is preprocessed - rest of envelope is plain JSON
      const envelope: CallEnvelope = {
        version: 1,
        chain: preprocess(chain),
        callContext,
        metadata
      };

      // 7. Get stub based on callee type
      let stub: any;
      if (calleeType === 'LumenizeDO') {
        // DO: Use getDOStub from @lumenize/routing
        stub = getDOStub(env[calleeBindingName], calleeInstanceName!);
      } else {
        // Worker: Direct access to entrypoint
        stub = env[calleeBindingName];
      }

      // 8. Send envelope via Workers RPC
      // Chain is already preprocessed, envelope wrapper is plain JSON
      const response = await stub.__executeOperation(envelope);

      // Unwrap result/error wrapper from executeEnvelope
      // Errors are returned (not thrown) because Workers RPC loses error properties on throw
      if (response && '$error' in response) {
        throw postprocess(response.$error);
      }
      return response?.$result;
    },

    call<T = any>(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      remoteContinuation: Continuation<T>,
      handlerContinuation?: AnyContinuation,
      options?: CallOptions
    ): void {
      // 1. Extract and validate chains (shared helper)
      const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);

      // 2. Validate caller knows its own binding (fail fast!)
      if (!this.bindingName) {
        throw new Error(
          `Cannot use call() from a DO that doesn't know its own binding name. ` +
          `Ensure routeDORequest routes to this DO or incoming calls include metadata.`
        );
      }

      // 3. Set up handler execution (shared helpers)
      const capturedContext = captureCallContext();
      const localExecutor = doInstance.__localChainExecutor;
      const executeHandler = createHandlerExecutor(localExecutor, capturedContext);

      // 4. Make remote call with context
      const callPromise = capturedContext
        ? runWithCallContext(capturedContext, () =>
            this.callRaw(calleeBindingName, calleeInstanceName, remoteChain, options))
        : this.callRaw(calleeBindingName, calleeInstanceName, remoteChain, options);

      // 5. Fire-and-forget with handler callbacks (shared helper)
      setupFireAndForgetHandler(callPromise, handlerChain, executeHandler);
    },
  };
}

/**
 * Create LmzApi implementation for LumenizeWorker
 *
 * Identity stored in closure (private to this function):
 * - `bindingName` - stored in closure variable
 * - `instanceName`, `id` - always undefined (Workers are ephemeral)
 *
 * @internal Used by LumenizeWorker.lmz getter
 */
export function createLmzApiForWorker(env: any, workerInstance: any): LmzApi {
  // Private storage for Worker identity (no persistence)
  let storedBindingName: string | undefined = undefined;

  return {
    // --- Getters (all readonly) ---

    get bindingName(): string | undefined {
      return storedBindingName;
    },

    get instanceName(): string | undefined {
      // Workers don't have instance names
      return undefined;
    },

    get type(): 'LumenizeWorker' {
      return 'LumenizeWorker';
    },

    get callContext(): CallContext {
      const context = getCurrentCallContext();
      if (!context) {
        throw new Error(
          'Cannot access callContext outside of a mesh call. ' +
          'callContext is only available during @mesh handler execution.'
        );
      }
      return context;
    },

    // --- Internal init method (called by envelope processing) ---

    /**
     * @internal Initialize identity - not for external use
     */
    __init(options: { bindingName?: string; instanceName?: string }): void {
      if (options.bindingName !== undefined) {
        if (storedBindingName !== undefined && storedBindingName !== options.bindingName) {
          throw new Error(
            `Worker binding name mismatch: stored '${storedBindingName}' but received '${options.bindingName}'. ` +
            `A Worker instance cannot change its binding name.`
          );
        }
        storedBindingName = options.bindingName;
      }
      // Silently ignore instanceName for Workers (they don't have instance names)
    },

    async callRaw(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      chainOrContinuation: OperationChain | AnyContinuation,
      options?: CallOptions
    ): Promise<any> {
      // 1. Extract chain from Continuation if needed
      const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;

      // 2. Build caller identity for callContext
      const callerIdentity: NodeIdentity = {
        type: this.type,
        bindingName: this.bindingName!,
        instanceName: undefined // Workers don't have instance names
      };

      // 3. Determine callee type
      const calleeType: NodeType = calleeInstanceName ? 'LumenizeDO' : 'LumenizeWorker';

      // 4. Build callContext for outgoing call
      const callContext = buildOutgoingCallContext(callerIdentity, options);

      // 5. Gather metadata for auto-init of uninitialized nodes
      const metadata = {
        caller: {
          type: this.type,
          bindingName: this.bindingName,
          instanceName: this.instanceName
        },
        callee: {
          type: calleeType,
          bindingName: calleeBindingName,
          instanceName: calleeInstanceName
        }
      };

      // 6. Create versioned envelope with callContext
      // Only chain is preprocessed - rest of envelope is plain JSON
      const envelope: CallEnvelope = {
        version: 1,
        chain: preprocess(chain),
        callContext,
        metadata
      };

      // 7. Get stub based on callee type
      let stub: any;
      if (calleeType === 'LumenizeDO') {
        // DO: Use getDOStub from @lumenize/routing
        stub = getDOStub(env[calleeBindingName], calleeInstanceName!);
      } else {
        // Worker: Direct access to entrypoint
        stub = env[calleeBindingName];
      }

      // 8. Send envelope via Workers RPC
      // Chain is already preprocessed, envelope wrapper is plain JSON
      const response = await stub.__executeOperation(envelope);

      // Unwrap result/error wrapper from executeEnvelope
      // Errors are returned (not thrown) because Workers RPC loses error properties on throw
      if (response && '$error' in response) {
        throw postprocess(response.$error);
      }
      return response?.$result;
    },

    call<T = any>(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      remoteContinuation: Continuation<T>,
      handlerContinuation?: AnyContinuation,
      options?: CallOptions
    ): void {
      // 1. Extract and validate chains (shared helper)
      const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);

      // 2. Validate caller knows its own binding (fail fast!)
      if (!this.bindingName) {
        throw new Error(
          `Cannot use call() from a Worker that doesn't know its own binding name. ` +
          `Ensure incoming calls include metadata or call this.lmz.__init() first.`
        );
      }

      // 3. Set up handler execution (shared helpers)
      const capturedContext = captureCallContext();
      const localExecutor = workerInstance.__localChainExecutor;
      const executeHandler = createHandlerExecutor(localExecutor, capturedContext);

      // 4. Make remote call with context
      const callPromise = capturedContext
        ? runWithCallContext(capturedContext, () =>
            this.callRaw(calleeBindingName, calleeInstanceName, remoteChain, options))
        : this.callRaw(calleeBindingName, calleeInstanceName, remoteChain, options);

      // 5. Fire-and-forget with handler callbacks (shared helper)
      // Workers are ephemeral — ctx.waitUntil() keeps the runtime alive
      // until the fire-and-forget promise settles
      const handledPromise = setupFireAndForgetHandler(callPromise, handlerChain, executeHandler);
      workerInstance.ctx.waitUntil(handledPromise);
    },
  };
}

// ============================================
// Envelope Execution Helper
// ============================================

/**
 * Node interface for executeEnvelope helper
 *
 * Represents the minimal interface needed to execute an incoming call envelope.
 * Both LumenizeDO and LumenizeWorker implement this interface.
 *
 * @internal
 */
export interface EnvelopeExecutorNode {
  /** Initialize node identity from envelope metadata */
  lmz: {
    __init(opts: { bindingName?: string; instanceName?: string }): void;
  };
  /** Authorization hook called before chain execution */
  onBeforeCall(): void;
  /** Execute the operation chain on this node */
  __executeChain(chain: any): Promise<any>;
}

/**
 * Execute an incoming call envelope on a mesh node
 *
 * Shared logic for processing incoming RPC calls on LumenizeDO and LumenizeWorker.
 * Handles envelope validation, auto-initialization, and chain execution within
 * the proper call context.
 *
 * @param envelope - The incoming call envelope
 * @param node - The node (DO or Worker) to execute on
 * @param options - Optional configuration
 * @param options.nodeTypeName - Name for error messages (e.g., 'LumenizeDO')
 * @param options.includeInstanceName - Whether to pass instanceName to __init (false for Workers)
 * @param options.onValidationError - Optional callback for validation errors (e.g., logging)
 * @returns The result of executing the operation chain
 * @throws Error if envelope version is not 1 or callContext is missing
 *
 * @internal
 */
export async function executeEnvelope(
  envelope: CallEnvelope,
  node: EnvelopeExecutorNode,
  options?: {
    nodeTypeName?: string;
    includeInstanceName?: boolean;
    onValidationError?: (error: Error, details: Record<string, any>) => void;
  }
): Promise<any> {
  const nodeTypeName = options?.nodeTypeName ?? 'MeshNode';
  const includeInstanceName = options?.includeInstanceName ?? true;

  // 1. Validate envelope version
  if (!envelope.version || envelope.version !== 1) {
    const error = new Error(
      `Unsupported RPC envelope version: ${envelope.version}. ` +
      `This version of ${nodeTypeName} only supports v1 envelopes. ` +
      `Old-style calls without envelopes are no longer supported.`
    );
    options?.onValidationError?.(error, {
      receivedVersion: envelope.version,
      supportedVersion: 1,
    });
    throw error;
  }

  // 2. Validate callContext is present
  if (!envelope.callContext) {
    const error = new Error(
      'Missing callContext in envelope. All mesh calls must include callContext.'
    );
    options?.onValidationError?.(error, { envelope });
    throw error;
  }

  // 3. Auto-initialize from callee metadata if present
  if (envelope.metadata?.callee) {
    node.lmz.__init({
      bindingName: envelope.metadata.callee.bindingName,
      instanceName: includeInstanceName
        ? envelope.metadata.callee.instanceName
        : undefined,
    });
  }

  // 4. Postprocess the chain (handles aliases/cycles and restores custom Error types)
  const operationChain = postprocess(envelope.chain);

  // 5. Execute chain within callContext (makes this.lmz.callContext available)
  // Return wrapped result/error - Workers RPC loses error properties when thrown,
  // so we return errors as { $error: preprocessedError } and unwrap in callRaw.
  try {
    const result = await runWithCallContext(envelope.callContext, async () => {
      // Call onBeforeCall hook for authentication/authorization
      node.onBeforeCall();

      // Execute the operation chain
      return await node.__executeChain(operationChain);
    });
    return { $result: result };
  } catch (error) {
    // Return error wrapped for structured clone transport
    // Preprocessing preserves custom Error properties that Workers RPC would lose
    return { $error: preprocess(error) };
  }
}

