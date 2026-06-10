import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  newContinuation,
  continuationFromChain,
  executeOperationChain,
  replaceNestedOperationMarkers,
  type OperationChain,
  type Continuation,
  type AnyContinuation,
} from './ocan/index.js';
import { createLmzApiForWorker, executeEnvelope, type LmzApi, type CallEnvelope } from './lmz-api.js';
import { ClientDisconnectedError } from './lumenize-client-gateway.js';
import { mesh } from './mesh-decorator.js';
import { BROADCAST_TIER_BINDING, type BroadcastTarget } from './broadcast.js';

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
 * **Key differences from LumenizeDO**:
 * - Workers are ephemeral (no storage, no persistence)
 * - No `instanceName` or `id` (always undefined)
 * - `call()` uses `ctx.waitUntil()` to keep the Worker alive for fire-and-forget calls
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
   * @internal This is called by this.lmz.callRaw(), not meant for direct use
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
    });
  }

  /**
   * Recursive tier handler for `svc.broadcast` (Phase 5b primitive).
   *
   * The originating DO calls `svc.broadcast(targets, remote, opts)` which,
   * when `targets.length > directThreshold`, dispatches into this method via
   * the `LUMENIZE_BROADCAST_TIER` service binding (which the user wires to
   * their own Worker entry; any LumenizeWorker subclass inherits this
   * method). The tier:
   *
   *   - if `targets.length <= branch`, dispatches `remote` to each target
   *     directly (fire-and-forget, no result handler in v1);
   *   - otherwise partitions targets into `branch` groups and recurses
   *     through itself via the same service binding — each child runs in
   *     a fresh Worker isolate with its own subrequest budget.
   *
   * `remote` arrives as a pre-extracted `OperationChain` rather than a
   * `Continuation` because it's already been serialized across the wire;
   * `lmz.call` accepts either form. We re-dispatch it as-is at each leaf.
   *
   * v1 is fire-and-forget. v2 will add a per-target onResult handler that
   * forwards results back to `callChain[0]` (the originating DO).
   *
   * @internal Framework method — do not override or call directly.
   */
  @mesh()
  __broadcastTier(
    targets: BroadcastTarget[],
    remote: OperationChain,
    branch: number,
    onResultChain?: OperationChain,
  ): void {
    if (targets.length === 0) return;
    if (targets.length <= branch) {
      // Re-wrap the incoming serialized chain back into a Continuation
      // (lmz.call only accepts proxies, not raw OperationChain arrays).
      const remoteContinuation = continuationFromChain<any>(remote);
      if (onResultChain) {
        // 4-arg form: result comes back here on this tier worker via
        // `__forwardBroadcastResult`, which substitutes the result into the
        // onResult chain and forwards to callChain[0] (the originating DO).
        // `onErrorOnly: true` skips the success-path handler dispatch — both
        // a CPU save and (on workerd) a structural latency lift, since
        // success-path .then() handlers attached to outbound subrequests
        // appear to keep the tier worker's invocation alive until they
        // settle.
        for (const t of targets) {
          this.lmz.call(
            t.bindingName,
            t.instanceName,
            remoteContinuation,
            this.ctn<LumenizeWorker>().__forwardBroadcastResult(onResultChain),
            { onErrorOnly: true },
          );
        }
      } else {
        for (const t of targets) {
          this.lmz.call(t.bindingName, t.instanceName, remoteContinuation);
        }
      }
      return;
    }
    const groupSize = Math.ceil(targets.length / branch);
    for (let g = 0; g < branch; g++) {
      const start = g * groupSize;
      if (start >= targets.length) break;
      const slice = targets.slice(start, start + groupSize);
      this.lmz.call(
        BROADCAST_TIER_BINDING,
        undefined,
        this.ctn<LumenizeWorker>().__broadcastTier(slice, remote, branch, onResultChain),
      );
    }
  }

  /**
   * Tier-side helper for `svc.broadcast`'s `onResult` path. Runs locally on
   * the tier worker when each per-target leaf call settles (success or
   * error). The framework appends the call's `result` to this method's
   * args via the standard last-argument convention. We then:
   *
   *   1. Substitute `result` into the caller-supplied `onResultChain` (the
   *      partial continuation built by the originating DO) using
   *      `replaceNestedOperationMarkers` — the same helper that powers the
   *      4-arg `lmz.call` form's result wiring.
   *   2. Forward the resolved chain to `callChain[0]` (the originating DO)
   *      via a fresh `lmz.call`. `callChain[0]` is the DO that started
   *      this broadcast because `__broadcastTier` was originally invoked
   *      from there.
   *
   * @internal Framework method — do not override or call directly.
   */
  @mesh()
  __forwardBroadcastResult(
    onResultChain: OperationChain,
    // The framework appends the per-target call result here via the
    // last-argument convention; declared optional so call-site code that
    // pre-binds only `onResultChain` (which is what the tier does) still
    // type-checks.
    result?: unknown,
  ): void {
    // **Tier optimization**: only forward to `callChain[0]` when the result
    // is an Error. Success-path callbacks would otherwise pile up on the
    // originating DO's input gate at high N (e.g., 1000 incoming
    // `onBroadcastResult` calls all serialized through Star's gate measurably
    // slows throughput). Drop-on-failed-fanout style cleanup only cares about
    // errors anyway. Direct-branch behavior is unchanged — there the
    // handler always runs locally on the originating DO via the 4-arg
    // `lmz.call` form, success or error.
    if (!(result instanceof Error)) return;
    const origin = this.lmz.callContext.callChain[0];
    if (!origin) {
      // No origin to forward to — silently drop.
      return;
    }
    const resolved = replaceNestedOperationMarkers(onResultChain, result);
    // `lmz.call` requires a Continuation proxy. Wrap the resolved chain.
    this.lmz.call(
      origin.bindingName,
      origin.instanceName,
      continuationFromChain<any>(resolved),
    );
  }
}

