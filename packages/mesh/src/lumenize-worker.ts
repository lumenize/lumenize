import { WorkerEntrypoint } from 'cloudflare:workers';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import {
  newContinuation,
  executeOperationChain,
  type OperationChain,
  type Continuation,
  type AnyContinuation,
} from './ocan/index.js';
import { createLmzApiForWorker, runWithCallContext, type LmzApi, type CallEnvelope } from './lmz-api.js';
import { ClientDisconnectedError } from './lumenize-client-gateway.js';

// Re-export continuation types from ocan for convenience
export type { Continuation, AnyContinuation };

// Register ClientDisconnectedError on globalThis for proper structured-clone serialization
// This ensures LumenizeWorker instances can deserialize this error type when received from Gateway
(globalThis as any).ClientDisconnectedError = ClientDisconnectedError;

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
 *   async someMethod() {
 *     // Make RPC call to DO
 *     // Identity is auto-initialized from envelope metadata
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
   * - **Identity**: `bindingName`, `type` (instanceName/id always undefined for Workers)
   * - **RPC**: `callRaw()`, `call()`
   *
   * Properties use closure storage (no persistence across requests).
   * Identity is set automatically from envelope metadata when receiving mesh calls.
   *
   * @see [Usage Examples](https://lumenize.com/docs/mesh/calls) - Complete tested examples
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
   * **Important**: If you override this, remember to call `super.onBeforeCall()`
   * to ensure any parent class logic is also executed.
   *
   * @example
   * ```typescript
   * class AuthWorker extends LumenizeWorker<Env> {
   *   onBeforeCall(): void {
   *     super.onBeforeCall();
   *
   *     const { originAuth, callChain } = this.lmz.callContext;
   *
   *     // Only allow internal mesh calls (no client origin)
   *     if (callChain[0].type === 'LumenizeClient') {
   *       throw new Error('Direct client access not allowed');
   *     }
   *   }
   * }
   * ```
   */
  onBeforeCall(): void {
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
    // Envelope is plain JSON - only chain field is preprocessed
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
      this.lmz.__init({
        bindingName: envelope.metadata.callee.bindingName,
        // instanceName ignored for Workers (always undefined)
      });
    }

    // 4. Postprocess only the chain (handles aliases/cycles and restores custom Error types)
    const operationChain = postprocess(envelope.chain);

    // 5. Execute chain within callContext (makes this.lmz.callContext available)
    // Return wrapped result/error - Workers RPC loses error properties when thrown,
    // so we return errors as { $error: preprocessedError } and unwrap in callRaw.
    try {
      const result = await runWithCallContext(envelope.callContext, async () => {
        // Call onBeforeCall hook for authentication/authorization
        this.onBeforeCall();

        // Execute the operation chain
        return await this.__executeChain(operationChain);
      });
      return { $result: result };
    } catch (error) {
      // Return error wrapped for structured clone transport
      // Preprocessing preserves custom Error properties that Workers RPC would lose
      return { $error: preprocess(error) };
    }
  }
}

