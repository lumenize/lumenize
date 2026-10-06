import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  newContinuation,
  executeOperationChain,
  type OperationChain,
  type Continuation,
  type AnyContinuation,
} from './ocan/index.js';
import { createLmzApiForWorker, executeEnvelope, type LmzApi, type CallEnvelope } from './lmz-api.js';
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
 * - RPC infrastructure via the members of `LmzApi` — `this.lmz.call()`, and `this.lmz.broadcast()`
 *   built on it
 * - Continuation support via `this.ctn()`
 * - Automatic envelope handling via `__executeOperation()`
 * 
 * **Key differences from LumenizeDO**:
 * - Workers are ephemeral (no storage, no persistence)
 * - No `instanceName` or `id` (always undefined)
 * - `call()` uses `ctx.waitUntil()` to keep the Worker alive across the call's ack
 * - No NADIS support (no `this.svc`)
 * 
 * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
 * 
 * @example
 * ```typescript
 * export class MyWorker extends LumenizeWorker<Env> {
 *   someMethod() {
 *     // Make a cross-node call to a DO. Identity is auto-initialized from envelope
 *     // metadata. The result fires back into the handler (never awaited).
 *     const remote = this.ctn<UserDO>().getData();
 *     this.lmz.call('USER_DO', 'user-123', remote, this.ctn().handleData(remote));
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
   * - **RPC**: the members of `LmzApi` — `call()`, and `broadcast()` built on it
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
   * this.lmz.call('USER_DO', userId, remote, handler);
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
   * - Add logging or tracing metadata
   * - Reject unauthorized calls by throwing an error
   *
   * This hook is called BEFORE the operation chain is executed, at both receive entries, but not
   * on the answers to a chain this Worker started. The `callContext` is available via
   * `this.lmz.callContext`.
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
   * Get the local chain executor for internal use
   *
   * This method provides access to __executeChain with configurable options
   * for trusted internal code (like lmz.call() result handlers).
   *
   * **Security**: The returned function can bypass @mesh checks, but it won't
   * serialize over RPC boundaries so attackers can't use it remotely.
   *
   * @internal
   */
  get __localChainExecutor(): (chain: OperationChain, options?: { requireMeshDecorator?: boolean }) => Promise<any> {
    return (chain, options) => executeOperationChain(chain, this, options);
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
   * @internal This is the RPC entry reached by a remote `this.lmz.call()` dispatch, not meant for direct use
   * @param envelope - The call envelope with version, chain, and metadata
   * @returns The result of executing the operation chain
   * @throws Error if envelope version is not 1
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  async __executeOperation(envelope: CallEnvelope): Promise<any> {
    return await executeEnvelope(envelope, this, {
      nodeTypeName: 'LumenizeWorker',
      includeInstanceName: false,
      waitUntil: (p) => this.ctx.waitUntil(p),
      env: this.env,
    });
  }

  /**
   * Receive a fire-back response — the second mesh RPC entry. Same shared
   * `executeEnvelope` path as `__executeOperation`, `requireMeshDecorator: false`:
   * `onBeforeCall` still runs, and so do the walk rules; only the member-level check is skipped.
   * A fire-back to a Worker caller lands here on a fresh stateless instance — correct because
   * the handler travels.
   *
   * @internal Fired at by the framework, not for direct use.
   */
  async __handleResponse(envelope: CallEnvelope): Promise<any> {
    return await executeEnvelope(envelope, this, {
      nodeTypeName: 'LumenizeWorker',
      includeInstanceName: false,
      requireMeshDecorator: false,
      // Every chain that arrives here was filled by the callee's `fireResponse`, so its last apply
      // is a result rather than a template's arguments.
      filled: true,
      waitUntil: (p) => this.ctx.waitUntil(p),
      env: this.env,
    });
  }
}

