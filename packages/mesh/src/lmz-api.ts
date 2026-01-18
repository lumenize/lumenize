import { isDurableObjectId, getDOStub } from '@lumenize/utils';
import { preprocess } from '@lumenize/structured-clone';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getOperationChain, executeOperationChain, replaceNestedOperationMarkers, type OperationChain } from './ocan/index.js';
import type { Continuation } from './lumenize-do.js';
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

/**
 * Build the CallContext for an outgoing call
 *
 * Handles both `newChain: true` (fresh context) and default (inherit + extend).
 *
 * @param callerIdentity - This node's identity (to add to callChain)
 * @param calleeIdentity - The target node's identity
 * @param options - CallOptions with newChain and state
 * @returns CallContext to include in the envelope
 * @internal
 */
export function buildOutgoingCallContext(
  callerIdentity: NodeIdentity,
  calleeIdentity: NodeIdentity,
  options?: CallOptions
): CallContext {
  const currentContext = getCurrentCallContext();

  if (options?.newChain || !currentContext) {
    // Start a fresh chain - caller becomes the origin
    return {
      origin: callerIdentity,
      originAuth: undefined,
      callChain: [],
      callee: calleeIdentity,
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
    origin: currentContext.origin,
    originAuth: currentContext.originAuth,
    callChain: newCallChain,
    callee: calleeIdentity,
    state: newState
  };
}

/**
 * Versioned envelope for RPC calls with automatic metadata propagation
 *
 * Enables auto-initialization of identity across distributed DO/Worker graphs.
 * Version field allows future evolution without breaking changes.
 */
export interface CallEnvelope {
  /** Version number for envelope format (currently 1) */
  version: 1;

  /** Preprocessed operation chain to execute on remote DO/Worker */
  chain: any;

  /**
   * Call context propagated through the mesh
   *
   * Contains origin, originAuth, callChain, and state.
   * Required for all mesh calls.
   */
  callContext: CallContext;

  /** Metadata about caller and callee for auto-initialization */
  metadata?: {
    /** Information about the caller (who is making this call) */
    caller: {
      /** Type of caller */
      type: NodeType;
      /** Binding name of caller (e.g., 'USER_DO') */
      bindingName?: string;
      /** Instance name or ID of caller (DOs only, Workers are ephemeral) */
      instanceNameOrId?: string;
    };
    /** Information about the callee (who should receive this call) */
    callee: {
      /** Type of callee */
      type: NodeType;
      /** Binding name of callee (e.g., 'REMOTE_DO') */
      bindingName: string;
      /** Instance name or ID of callee (DOs only, undefined for Workers) */
      instanceNameOrId?: string;
    };
  };
}

/**
 * Lumenize API - Identity and RPC infrastructure for LumenizeDO and LumenizeWorker
 * 
 * Provides clean abstraction over identity management (binding name, instance name/id)
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
  bindingName?: string;
  
  /**
   * Instance name for this DO (undefined for Workers)
   * 
   * - **LumenizeDO**: Stored in `ctx.storage.kv.get('__lmz_do_instance_name')`
   * - **LumenizeWorker**: Always undefined (Workers are ephemeral)
   * 
   * **Validation**: Cannot be changed once set to a different value
   */
  instanceName?: string;
  
  /**
   * Instance ID for this DO (undefined for Workers)
   * 
   * - **LumenizeDO**: Read from `ctx.id.toString()` (read-only)
   * - **LumenizeWorker**: Always undefined (Workers are ephemeral)
   * 
   * **Validation**: Setter throws error (ID cannot be set, only read from ctx.id)
   */
  id?: string;
  
  /**
   * Smart getter/setter for instance name OR id
   * 
   * **Getter**:
   * - Returns `instanceName` if set
   * - Otherwise returns `id` if available
   * - Otherwise returns undefined
   * 
   * **Setter**:
   * - Uses `isDurableObjectId()` to determine if value is an ID or name
   * - If ID: Validates against `ctx.id` but doesn't store (IDs always from ctx.id)
   * - If name: Stores as `instanceName` with validation
   * - If undefined: No-op (can't unset)
   */
  instanceNameOrId?: string;
  
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
   * @mesh
   * updateDocument(changes: DocumentChange) {
   *   const userId = this.lmz.callContext.originAuth?.userId;
   *   const fullPath = this.lmz.callContext.callChain.map(n => n.bindingName).join(' → ');
   * }
   * ```
   */
  readonly callContext: CallContext;

  /**
   * Immediate caller of this request (convenience getter)
   *
   * Returns the last node in `callChain`, or `origin` if the chain is empty
   * (i.e., the origin is calling this node directly).
   *
   * @throws Error if accessed outside of a mesh call context
   *
   * @example
   * ```typescript
   * @mesh
   * handleRequest() {
   *   const caller = this.lmz.caller;
   *   console.log(`Called by ${caller.bindingName}:${caller.instanceName}`);
   * }
   * ```
   */
  readonly caller: NodeIdentity;

  /**
   * Convenience method to initialize multiple properties at once
   * 
   * Equivalent to setting properties individually, but more concise.
   * 
   * @param options - Properties to initialize
   * @param options.bindingName - Binding name (e.g., 'USER_DO')
   * @param options.instanceNameOrId - Instance name or ID (name or hex string)
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  init(options?: { bindingName?: string; instanceNameOrId?: string }): void;
  
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
   * - `calleeInstanceNameOrId` - Instance name/ID for DOs, undefined for Workers
   * - `chainOrContinuation` - Operation chain or Continuation from `this.ctn()`
   * - `options` - Optional configuration
   * 
   * **Returns**: Postprocessed result from remote DO/Worker
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  callRaw(
    calleeBindingName: string,
    calleeInstanceNameOrId: string | undefined,
    chainOrContinuation: OperationChain | Continuation<any>,
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
   * - `calleeInstanceNameOrId` - Instance name/ID of target DO (undefined for Workers)
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
    calleeInstanceNameOrId: string | undefined,
    remoteContinuation: Continuation<T>,
    handlerContinuation?: Continuation<any>,
    options?: CallOptions
  ): void;
}

/**
 * Create LmzApi implementation for LumenizeDO
 * 
 * Identity stored in Durable Object storage:
 * - `bindingName` → `ctx.storage.kv.get/put('__lmz_do_binding_name')`
 * - `instanceName` → `ctx.storage.kv.get/put('__lmz_do_instance_name')`
 * - `id` → `ctx.id.toString()` (read-only, not stored)
 * 
 * @internal Used by LumenizeDO.lmz getter
 */
export function createLmzApiForDO(ctx: DurableObjectState, env: any, doInstance: any): LmzApi {
  return {
    // --- Getters ---
    
    get bindingName(): string | undefined {
      return ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
    },
    
    get instanceName(): string | undefined {
      return ctx.storage.kv.get('__lmz_do_instance_name') as string | undefined;
    },
    
    get id(): string | undefined {
      return ctx.id?.toString();
    },
    
    get instanceNameOrId(): string | undefined {
      // Return instanceName if set, otherwise id
      const name = ctx.storage.kv.get('__lmz_do_instance_name') as string | undefined;
      if (name !== undefined) {
        return name;
      }
      return ctx.id?.toString();
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

    get caller(): NodeIdentity {
      const context = getCurrentCallContext();
      if (!context) {
        throw new Error(
          'Cannot access caller outside of a mesh call. ' +
          'caller is only available during @mesh handler execution.'
        );
      }
      // Return last node in callChain, or origin if chain is empty
      return context.callChain.length > 0
        ? context.callChain[context.callChain.length - 1]
        : context.origin;
    },

    // --- Setters ---
    
    set bindingName(value: string | undefined) {
      if (value === undefined) {
        return; // Can't unset
      }
      
      const stored = ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;
      
      if (stored !== undefined && stored !== value) {
        throw new Error(
          `DO binding name mismatch: stored '${stored}' but received '${value}'. ` +
          `A DO instance cannot change its binding name.`
        );
      }
      
      ctx.storage.kv.put('__lmz_do_binding_name', value);
    },
    
    set instanceName(value: string | undefined) {
      if (value === undefined) {
        return; // Can't unset
      }
      
      const stored = ctx.storage.kv.get('__lmz_do_instance_name') as string | undefined;
      
      if (stored !== undefined && stored !== value) {
        throw new Error(
          `DO instance name mismatch: stored '${stored}' but received '${value}'. ` +
          `A DO instance cannot change its name.`
        );
      }
      
      ctx.storage.kv.put('__lmz_do_instance_name', value);
    },
    
    set id(value: string | undefined) {
      throw new Error(
        `Cannot set DO id - it's read-only from ctx.id. ` +
        `Current id: '${ctx.id}', attempted to set: '${value}'`
      );
    },
    
    set instanceNameOrId(value: string | undefined) {
      if (value === undefined) {
        return; // Can't unset
      }
      
      // Determine if this is an ID or name
      const isId = isDurableObjectId(value);
      
      if (isId) {
        // Validate against ctx.id but don't store
        if (ctx.id.toString() !== value) {
          throw new Error(
            `DO instance ID mismatch: ctx.id is '${ctx.id}' but received '${value}'. ` +
            `A DO instance cannot change its ID.`
          );
        }
        // Don't store IDs - they're always available via ctx.id
      } else {
        // It's a name - use instanceName setter
        const stored = ctx.storage.kv.get('__lmz_do_instance_name') as string | undefined;
        
        if (stored !== undefined && stored !== value) {
          throw new Error(
            `DO instance name mismatch: stored '${stored}' but received '${value}'. ` +
            `A DO instance cannot change its name.`
          );
        }
        
        ctx.storage.kv.put('__lmz_do_instance_name', value);
      }
    },
    
    // --- Methods ---
    
    init(options?: { bindingName?: string; instanceNameOrId?: string }): void {
      if (!options) {
        return; // No-op if no options provided
      }
      
      const { bindingName, instanceNameOrId } = options;
      
      if (bindingName !== undefined) {
        this.bindingName = bindingName;
      }
      
      if (instanceNameOrId !== undefined) {
        this.instanceNameOrId = instanceNameOrId;
      }
    },
    
    async callRaw(
      calleeBindingName: string,
      calleeInstanceNameOrId: string | undefined,
      chainOrContinuation: OperationChain | Continuation<any>,
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

      // 3. Determine callee type and build callee identity
      const calleeType: NodeType = calleeInstanceNameOrId ? 'LumenizeDO' : 'LumenizeWorker';
      const calleeIdentity: NodeIdentity = {
        type: calleeType,
        bindingName: calleeBindingName,
        instanceName: calleeInstanceNameOrId
      };

      // 4. Build callContext for outgoing call (includes callee)
      const callContext = buildOutgoingCallContext(callerIdentity, calleeIdentity, options);

      // 5. Gather metadata (legacy, for auto-init of uninitialized nodes)
      const metadata = {
        caller: {
          type: this.type,
          bindingName: this.bindingName,
          instanceNameOrId: this.instanceNameOrId
        },
        callee: {
          type: calleeType,
          bindingName: calleeBindingName,
          instanceNameOrId: calleeInstanceNameOrId
        }
      };

      // 7. Preprocess operation chain
      const preprocessedChain = preprocess(chain);

      // 8. Create versioned envelope with callContext
      const envelope: CallEnvelope = {
        version: 1,
        chain: preprocessedChain,
        callContext,
        metadata
      };

      // 9. Get stub based on callee type
      let stub: any;
      if (calleeType === 'LumenizeDO') {
        // DO: Use getDOStub from @lumenize/utils
        stub = getDOStub(env[calleeBindingName], calleeInstanceNameOrId!);
      } else {
        // Worker: Direct access to entrypoint
        stub = env[calleeBindingName];
      }

      // 10. Send to remote and return result (already postprocessed by receiver)
      return await stub.__executeOperation(envelope);
    },
    
    call<T = any>(
      calleeBindingName: string,
      calleeInstanceNameOrId: string | undefined,
      remoteContinuation: Continuation<T>,
      handlerContinuation?: Continuation<any>,
      options?: CallOptions
    ): void {
      // 1. Extract operation chains from continuations
      const remoteChain = getOperationChain(remoteContinuation);

      if (!remoteChain) {
        throw new Error('Invalid remoteContinuation: must be created with this.ctn()');
      }

      // Extract handler chain if provided
      let handlerChain: OperationChain | undefined;
      if (handlerContinuation) {
        handlerChain = getOperationChain(handlerContinuation);
        if (!handlerChain) {
          throw new Error('Invalid handlerContinuation: must be created with this.ctn()');
        }
      }

      // 2. Validate caller knows its own binding (fail fast!)
      if (!this.bindingName) {
        throw new Error(
          `Cannot use call() from a DO that doesn't know its own binding name. ` +
          `Call this.lmz.init({ bindingName }) in your constructor.`
        );
      }

      // 3. Capture current callContext for handler execution (deep clone!)
      const capturedContext = captureCallContext();

      // Helper to execute handler with captured context
      const executeHandler = async (chain: OperationChain) => {
        if (capturedContext) {
          return runWithCallContext(capturedContext, async () => {
            return await executeOperationChain(chain, doInstance);
          });
        } else {
          return await executeOperationChain(chain, doInstance);
        }
      };

      // 4. Fire-and-forget: use Promise.then/catch instead of blockConcurrencyWhile
      // This returns immediately while the async work executes in the background
      const callPromise = capturedContext
        ? runWithCallContext(capturedContext, () =>
            this.callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options))
        : this.callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options);

      callPromise
        .then(async (result) => {
          // Execute handler if provided
          if (handlerChain) {
            // Substitute result into handler continuation
            const finalChain = replaceNestedOperationMarkers(handlerChain, result);
            // Execute handler locally on the DO instance with captured context
            await executeHandler(finalChain);
          }
        })
        .catch(async (error) => {
          // Execute error handler if provided
          if (handlerChain) {
            // Inject Error into handler continuation
            const errorObj = error instanceof Error ? error : new Error(String(error));
            const finalChain = replaceNestedOperationMarkers(handlerChain, errorObj);
            // Execute handler with error on the DO instance with captured context
            await executeHandler(finalChain);
          }
          // If no handler, silently swallow error (fire-and-forget)
        });

      // Returns immediately! Handler executes when result arrives (or fire-and-forget)
    },
  };
}

/**
 * Create LmzApi implementation for LumenizeWorker
 * 
 * Identity stored in closure (private to this function):
 * - `bindingName` - stored in closure variable
 * - `instanceName`, `id`, `instanceNameOrId` - always undefined (Workers are ephemeral)
 * 
 * @internal Used by LumenizeWorker.lmz getter
 */
export function createLmzApiForWorker(env: any, workerInstance: any): LmzApi {
  // Private storage for Worker identity (no persistence)
  let bindingName: string | undefined = undefined;
  
  return {
    // --- Getters ---
    
    get bindingName(): string | undefined {
      return bindingName;
    },
    
    get instanceName(): string | undefined {
      // Workers don't have instance names
      return undefined;
    },
    
    get id(): string | undefined {
      // Workers don't have IDs
      return undefined;
    },
    
    get instanceNameOrId(): string | undefined {
      // Workers don't have instance identifiers
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

    get caller(): NodeIdentity {
      const context = getCurrentCallContext();
      if (!context) {
        throw new Error(
          'Cannot access caller outside of a mesh call. ' +
          'caller is only available during @mesh handler execution.'
        );
      }
      // Return last node in callChain, or origin if chain is empty
      return context.callChain.length > 0
        ? context.callChain[context.callChain.length - 1]
        : context.origin;
    },

    // --- Setters ---

    set bindingName(value: string | undefined) {
      if (value === undefined) {
        return; // Can't unset
      }
      
      if (bindingName !== undefined && bindingName !== value) {
        throw new Error(
          `Worker binding name mismatch: stored '${bindingName}' but received '${value}'. ` +
          `A Worker instance cannot change its binding name.`
        );
      }
      
      bindingName = value;
    },
    
    set instanceName(value: string | undefined) {
      // Workers don't have instance names - silently ignore
    },
    
    set id(value: string | undefined) {
      // Workers don't have IDs - silently ignore
    },
    
    set instanceNameOrId(value: string | undefined) {
      // Workers don't have instance identifiers - silently ignore
    },
    
    // --- Methods ---
    
    init(options?: { bindingName?: string; instanceNameOrId?: string }): void {
      if (!options) {
        return; // No-op if no options provided
      }
      
      const { bindingName: bn } = options;
      
      if (bn !== undefined) {
        this.bindingName = bn;
      }
      
      // Silently ignore instanceNameOrId for Workers
    },
    
    async callRaw(
      calleeBindingName: string,
      calleeInstanceNameOrId: string | undefined,
      chainOrContinuation: OperationChain | Continuation<any>,
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

      // 3. Determine callee type and build callee identity
      const calleeType: NodeType = calleeInstanceNameOrId ? 'LumenizeDO' : 'LumenizeWorker';
      const calleeIdentity: NodeIdentity = {
        type: calleeType,
        bindingName: calleeBindingName,
        instanceName: calleeInstanceNameOrId
      };

      // 4. Build callContext for outgoing call (includes callee)
      const callContext = buildOutgoingCallContext(callerIdentity, calleeIdentity, options);

      // 5. Gather metadata (legacy, for auto-init of uninitialized nodes)
      const metadata = {
        caller: {
          type: this.type,
          bindingName: this.bindingName,
          instanceNameOrId: this.instanceNameOrId
        },
        callee: {
          type: calleeType,
          bindingName: calleeBindingName,
          instanceNameOrId: calleeInstanceNameOrId
        }
      };

      // 7. Preprocess operation chain
      const preprocessedChain = preprocess(chain);

      // 8. Create versioned envelope with callContext
      const envelope: CallEnvelope = {
        version: 1,
        chain: preprocessedChain,
        callContext,
        metadata
      };

      // 9. Get stub based on callee type
      let stub: any;
      if (calleeType === 'LumenizeDO') {
        // DO: Use getDOStub from @lumenize/utils
        stub = getDOStub(env[calleeBindingName], calleeInstanceNameOrId!);
      } else {
        // Worker: Direct access to entrypoint
        stub = env[calleeBindingName];
      }

      // 10. Send to remote and return result (already postprocessed by receiver)
      return await stub.__executeOperation(envelope);
    },

    async call<T = any>(
      calleeBindingName: string,
      calleeInstanceNameOrId: string | undefined,
      remoteContinuation: Continuation<T>,
      handlerContinuation: Continuation<any>,
      options?: CallOptions
    ): Promise<void> {
      // Async version without blockConcurrencyWhile (Workers don't have it)
      // 1. Extract operation chains from continuations
      const remoteChain = getOperationChain(remoteContinuation);
      const handlerChain = getOperationChain(handlerContinuation);

      if (!remoteChain) {
        throw new Error('Invalid remoteContinuation: must be created with this.ctn()');
      }
      if (!handlerChain) {
        throw new Error('Invalid handlerContinuation: must be created with this.ctn()');
      }

      // 2. No binding validation for Workers (optional for them)

      // 3. Capture current callContext for handler execution (deep clone!)
      const capturedContext = captureCallContext();

      // Helper to execute handler with captured context
      const executeHandler = async (chain: OperationChain) => {
        if (capturedContext) {
          return runWithCallContext(capturedContext, async () => {
            return await executeOperationChain(chain, workerInstance);
          });
        } else {
          return await executeOperationChain(chain, workerInstance);
        }
      };

      try {
        // Call infrastructure layer with captured context
        const result = await (capturedContext
          ? runWithCallContext(capturedContext, () =>
              this.callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options))
          : this.callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options));

        // Substitute result into handler continuation
        const finalChain = replaceNestedOperationMarkers(handlerChain, result);

        // Execute handler locally on the Worker instance with captured context
        await executeHandler(finalChain);

      } catch (error) {
        // Inject Error into handler continuation
        const errorObj = error instanceof Error ? error : new Error(String(error));
        const finalChain = replaceNestedOperationMarkers(handlerChain, errorObj);

        // Execute handler with error on the Worker instance with captured context
        await executeHandler(finalChain);
      }

      // Awaits completion before returning (async signature)
    },
  };
}

