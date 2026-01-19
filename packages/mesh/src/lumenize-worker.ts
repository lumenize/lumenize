import { WorkerEntrypoint } from 'cloudflare:workers';
import { postprocess } from '@lumenize/structured-clone';
import { newContinuation, executeOperationChain, type OperationChain } from './ocan/index.js';
import { createLmzApiForWorker, runWithCallContext, type LmzApi, type CallEnvelope } from './lmz-api.js';
import { ClientDisconnectedError } from './lumenize-client-gateway.js';

// Register ClientDisconnectedError on globalThis for proper structured-clone serialization
// This ensures LumenizeWorker instances can deserialize this error type when received from Gateway
(globalThis as any).ClientDisconnectedError = ClientDisconnectedError;

/**
 * Continuation type for method chaining across Workers/DOs
 * 
 * Created via `this.ctn()`, continuations allow building method chains
 * that can be serialized and executed remotely or passed as parameters.
 */
export type Continuation<T> = T & { __ocan_metadata?: any };

/**
 * Base class for Worker Entrypoints with RPC infrastructure
 * 
 * Provides:
 * - Identity management via `this.lmz.*` (bindingName only, no persistence)
 * - RPC infrastructure via `this.lmz.callRaw()` and `this.lmz.call()`
 * - Continuation support via `this.ctn()`
 * - Automatic envelope handling via `__executeOperation()`
 * 
 * **Key differences from LumenizeBase**:
 * - Workers are ephemeral (no storage, no persistence)
 * - No `instanceName` or `id` (always undefined)
 * - `call()` is async (no `blockConcurrencyWhile`)
 * - No NADIS support (no `this.svc`)
 * 
 * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
 * 
 * @example
 * ```typescript
 * export class MyWorker extends LumenizeWorker<Env> {
 *   constructor(ctx: ExecutionContext, env: Env) {
 *     super(ctx, env);
 *     this.lmz.init({ bindingName: 'MY_WORKER' });
 *   }
 *   
 *   async someMethod() {
 *     // Make RPC call to DO
 *     await this.lmz.callRaw('USER_DO', 'user-123', this.ctn<UserDO>().getData());
 *   }
 * }
 * ```
 */
export class LumenizeWorker<Env = any> extends WorkerEntrypoint<Env> {
  #lmzApi: LmzApi | null = null;

  /**
   * Access Lumenize infrastructure: identity and RPC methods
   * 
   * Provides clean abstraction over identity management and RPC infrastructure:
   * - **Identity**: `bindingName`, `type` (instanceName/id/instanceNameOrId always undefined)
   * - **RPC**: `callRaw()` (async), `call()` (async with continuations)
   * - **Convenience**: `init()` to set bindingName
   * 
   * Properties use closure storage (no persistence across requests).
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  get lmz(): LmzApi {
    if (!this.#lmzApi) {
      this.#lmzApi = createLmzApiForWorker(this.env, this);
    }
    return this.#lmzApi;
  }

  /**
   * Create a continuation for method chaining
   * 
   * Continuations enable building method chains that can be:
   * - Executed remotely via RPC
   * - Passed as parameters to other methods
   * - Used with nested operation markers for result substitution
   * 
   * **Usage**:
   * - Remote calls: `this.ctn<RemoteDO>().method(args)`
   * - Local handlers: `this.ctn().handleResult(remoteResult)`
   * - Nesting: Use remote continuation as handler parameter
   * 
   * @example
   * ```typescript
   * // Remote continuation
   * const remote = this.ctn<UserDO>().getUserData(userId);
   * 
   * // Handler continuation with nested marker
   * const handler = this.ctn().processData(remote);
   * 
   * // Make call
   * await this.lmz.call('USER_DO', userId, remote, handler);
   * ```
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  ctn<T = this>(): Continuation<T> {
    return newContinuation<T>() as Continuation<T>;
  }

  /**
   * Lifecycle hook called before each incoming mesh call is executed
   *
   * Override this method to:
   * - Validate authentication/authorization based on `this.lmz.callContext`
   * - Populate `callContext.state` with computed data
   * - Add logging or tracing metadata
   * - Reject unauthorized calls by throwing an error
   *
   * This hook is called BEFORE the operation chain is executed.
   * The `callContext` is available via `this.lmz.callContext`.
   *
   * **Important**: If you override this, remember to call `await super.onBeforeCall()`
   * to ensure any parent class logic is also executed.
   *
   * @example
   * ```typescript
   * class AuthWorker extends LumenizeWorker<Env> {
   *   async onBeforeCall(): Promise<void> {
   *     await super.onBeforeCall();
   *
   *     const { originAuth } = this.lmz.callContext;
   *
   *     // Only allow internal mesh calls (no client origin)
   *     if (this.lmz.callContext.origin.type === 'LumenizeClient') {
   *       throw new Error('Direct client access not allowed');
   *     }
   *   }
   * }
   * ```
   */
  async onBeforeCall(): Promise<void> {
    // Default: no-op. Subclasses override this for authentication/authorization.
  }

  /**
   * Execute an OCAN (Operation Chaining And Nesting) operation chain on this Worker.
   *
   * This method enables remote DOs/Workers to call methods on this Worker via RPC.
   * Any Worker extending LumenizeWorker can receive remote calls without additional setup.
   * 
   * @internal This is called by this.lmz.callRaw(), not meant for direct use
   * @param chain - The operation chain to execute
   * @returns The result of executing the operation chain
   * 
   * @example
   * ```typescript
   * // Remote DO/Worker sends this chain:
   * const remote = this.ctn<MyWorker>().processData(data);
   * 
   * // This Worker receives and executes it:
   * const result = await this.__executeChain(remote);
   * // Equivalent to: this.processData(data)
   * ```
   */
  async __executeChain(chain: OperationChain): Promise<any> {
    return await executeOperationChain(chain, this);
  }

  /**
   * Receive and execute an RPC call envelope with auto-initialization
   * 
   * Handles versioned envelopes and automatically initializes this Worker's identity
   * from the callee metadata included in the envelope. This enables Workers to learn
   * their binding name from the first incoming call.
   * 
   * **Envelope format**:
   * - `version: 1` - Current envelope version (required)
   * - `chain` - Preprocessed operation chain to execute
   * - `metadata.callee` - Identity of this Worker (used for auto-initialization)
   * 
   * @internal This is called by this.lmz.callRaw(), not meant for direct use
   * @param envelope - The call envelope with version, chain, and metadata
   * @returns The result of executing the operation chain
   * @throws Error if envelope version is not 1
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  async __executeOperation(envelope: CallEnvelope): Promise<any> {
    // 1. Validate envelope version
    if (!envelope.version || envelope.version !== 1) {
      throw new Error(
        `Unsupported RPC envelope version: ${envelope.version}. ` +
        `This version of LumenizeWorker only supports v1 envelopes. ` +
        `Old-style calls without envelopes are no longer supported.`
      );
    }

    // 2. Validate callContext is present
    if (!envelope.callContext) {
      throw new Error(
        'Missing callContext in envelope. All mesh calls must include callContext.'
      );
    }

    // 3. Auto-initialize from callee metadata if present
    if (envelope.metadata?.callee) {
      this.lmz.init({
        bindingName: envelope.metadata.callee.bindingName,
        // instanceNameOrId ignored for Workers (always undefined)
      });
    }

    // 4. Postprocess the chain
    const preprocessedChain = envelope.chain;
    const operationChain = postprocess(preprocessedChain);

    // 5. Execute chain within callContext (makes this.lmz.callContext available)
    // CallContext already includes callee (set by caller)
    return await runWithCallContext(envelope.callContext, async () => {
      // Call onBeforeCall hook for authentication/authorization
      await this.onBeforeCall();

      // Execute the operation chain
      return await this.__executeChain(operationChain);
    });
  }
}

