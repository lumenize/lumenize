import { isDurableObjectId, getDOStub } from '@lumenize/utils';
import { preprocess } from '@lumenize/structured-clone';
import { getOperationChain, executeOperationChain, replaceNestedOperationMarkers, type OperationChain } from './ocan/index.js';
import type { Continuation } from './lumenize-base.js';

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
  
  /** Metadata about caller and callee for auto-initialization */
  metadata?: {
    /** Information about the caller (who is making this call) */
    caller: {
      /** Type of caller: 'LumenizeBase' (DO) or 'LumenizeWorker' (Worker) */
      type: 'LumenizeBase' | 'LumenizeWorker';
      /** Binding name of caller (e.g., 'USER_DO') */
      bindingName?: string;
      /** Instance name or ID of caller (DOs only, Workers are ephemeral) */
      instanceNameOrId?: string;
    };
    /** Information about the callee (who should receive this call) */
    callee: {
      /** Type of callee: 'LumenizeBase' (DO) or 'LumenizeWorker' (Worker) */
      type: 'LumenizeBase' | 'LumenizeWorker';
      /** Binding name of callee (e.g., 'REMOTE_DO') */
      bindingName: string;
      /** Instance name or ID of callee (DOs only, undefined for Workers) */
      instanceNameOrId?: string;
    };
  };
}

/**
 * Optional configuration for RPC calls
 */
export interface CallOptions {
  /** Custom options (reserved for future use) */
  [key: string]: any;
}

/**
 * Lumenize API - Identity and RPC infrastructure for LumenizeBase and LumenizeWorker
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
   * - **LumenizeBase**: Stored in `ctx.storage.kv.get('__lmz_do_binding_name')`
   * - **LumenizeWorker**: Stored in private field
   * 
   * **Validation**: Cannot be changed once set to a different value
   */
  bindingName?: string;
  
  /**
   * Instance name for this DO (undefined for Workers)
   * 
   * - **LumenizeBase**: Stored in `ctx.storage.kv.get('__lmz_do_instance_name')`
   * - **LumenizeWorker**: Always undefined (Workers are ephemeral)
   * 
   * **Validation**: Cannot be changed once set to a different value
   */
  instanceName?: string;
  
  /**
   * Instance ID for this DO (undefined for Workers)
   * 
   * - **LumenizeBase**: Read from `ctx.id.toString()` (read-only)
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
   * - **LumenizeBase**: Returns `'LumenizeBase'`
   * - **LumenizeWorker**: Returns `'LumenizeWorker'`
   * 
   * Getter-only property determined by class type.
   */
  readonly type: 'LumenizeBase' | 'LumenizeWorker';
  
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
   * Synchronous RPC call with continuation pattern (LumenizeBase only)
   * 
   * High-level method for DO-to-DO calls using continuation pattern.
   * Returns immediately while work executes asynchronously via blockConcurrencyWhile.
   * 
   * **Use cases**:
   * - Application code that wants actor model behavior
   * - Event handlers that need to trigger remote calls without blocking
   * - Methods that want to chain operations across DOs
   * - Fire-and-forget calls (omit handler)
   * 
   * **Continuation pattern**:
   * - Remote continuation: what to execute on remote DO
   * - Handler continuation (optional): what to execute locally when result arrives
   * - Result/error automatically injected into handler via OCAN markers
   * 
   * **Requirements**:
   * - Caller must know its own bindingName (set in constructor via `this.lmz.init()`)
   * - Continuations must be created with `this.ctn()`
   * 
   * **Parameters**:
   * - `calleeBindingName` - Binding name of target DO (e.g., 'REMOTE_DO')
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
 * Create LmzApi implementation for LumenizeBase
 * 
 * Identity stored in Durable Object storage:
 * - `bindingName` → `ctx.storage.kv.get/put('__lmz_do_binding_name')`
 * - `instanceName` → `ctx.storage.kv.get/put('__lmz_do_instance_name')`
 * - `id` → `ctx.id.toString()` (read-only, not stored)
 * 
 * @internal Used by LumenizeBase.lmz getter
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
    
    get type(): 'LumenizeBase' {
      return 'LumenizeBase';
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
      
      // 2. Gather caller metadata using this.lmz abstraction
      const callerMetadata = {
        type: this.type,
        bindingName: this.bindingName,
        instanceNameOrId: this.instanceNameOrId
      };
      
      // 3. Determine callee type
      const calleeType: "LumenizeBase" | "LumenizeWorker" = calleeInstanceNameOrId ? 'LumenizeBase' : 'LumenizeWorker';
      
      // 4. Build metadata
      const metadata = {
        caller: callerMetadata,
        callee: {
          type: calleeType,
          bindingName: calleeBindingName,
          instanceNameOrId: calleeInstanceNameOrId
        }
      };
      
      // 5. Preprocess operation chain
      const preprocessedChain = preprocess(chain);
      
      // 6. Create versioned envelope
      const envelope: CallEnvelope = {
        version: 1,
        chain: preprocessedChain,
        metadata
      };
      
      // 7. Get stub based on callee type
      let stub: any;
      if (calleeType === 'LumenizeBase') {
        // DO: Use getDOStub from @lumenize/utils
        stub = getDOStub(env[calleeBindingName], calleeInstanceNameOrId!);
      } else {
        // Worker: Direct access to entrypoint
        stub = env[calleeBindingName];
      }
      
      // 8. Send to remote and return result (already postprocessed by receiver)
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
      
      // 3. Use blockConcurrencyWhile for non-blocking async work
      ctx.blockConcurrencyWhile(async () => {
        try {
          // Call infrastructure layer
          const result = await this.callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options);
          
          // Execute handler if provided
          if (handlerChain) {
            // Substitute result into handler continuation
            const finalChain = replaceNestedOperationMarkers(handlerChain, result);
            
            // Execute handler locally on the DO instance
            await executeOperationChain(finalChain, doInstance);
          }
          
        } catch (error) {
          // Execute error handler if provided
          if (handlerChain) {
            // Inject Error into handler continuation
            const errorObj = error instanceof Error ? error : new Error(String(error));
            const finalChain = replaceNestedOperationMarkers(handlerChain, errorObj);
            
            // Execute handler with error on the DO instance
            await executeOperationChain(finalChain, doInstance);
          }
          // If no handler, silently swallow error (fire-and-forget)
        }
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
      // Implementation identical to LumenizeBase version
      // 1. Extract chain from Continuation if needed
      const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;
      
      // 2. Gather caller metadata using this.lmz abstraction
      const callerMetadata = {
        type: this.type,
        bindingName: this.bindingName,
        instanceNameOrId: this.instanceNameOrId
      };
      
      // 3. Determine callee type
      const calleeType: "LumenizeBase" | "LumenizeWorker" = calleeInstanceNameOrId ? 'LumenizeBase' : 'LumenizeWorker';
      
      // 4. Build metadata
      const metadata = {
        caller: callerMetadata,
        callee: {
          type: calleeType,
          bindingName: calleeBindingName,
          instanceNameOrId: calleeInstanceNameOrId
        }
      };
      
      // 5. Preprocess operation chain
      const preprocessedChain = preprocess(chain);
      
      // 6. Create versioned envelope
      const envelope: CallEnvelope = {
        version: 1,
        chain: preprocessedChain,
        metadata
      };
      
      // 7. Get stub based on callee type
      let stub: any;
      if (calleeType === 'LumenizeBase') {
        // DO: Use getDOStub from @lumenize/utils
        stub = getDOStub(env[calleeBindingName], calleeInstanceNameOrId!);
      } else {
        // Worker: Direct access to entrypoint
        stub = env[calleeBindingName];
      }
      
      // 8. Send to remote and return result (already postprocessed by receiver)
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
      
      try {
        // Call infrastructure layer
        const result = await this.callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options);
        
        // Substitute result into handler continuation
        const finalChain = replaceNestedOperationMarkers(handlerChain, result);
        
        // Execute handler locally on the Worker instance
        await executeOperationChain(finalChain, workerInstance);
        
      } catch (error) {
        // Inject Error into handler continuation
        const errorObj = error instanceof Error ? error : new Error(String(error));
        const finalChain = replaceNestedOperationMarkers(handlerChain, errorObj);
        
        // Execute handler with error on the Worker instance
        await executeOperationChain(finalChain, workerInstance);
      }
      
      // Awaits completion before returning (async signature)
    },
  };
}

