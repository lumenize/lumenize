import { debug } from '@lumenize/debug';
import { isDurableObjectId, isDONamespace, getDOStub } from '@lumenize/routing';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { getCurrentCallContext, runWithCallContext } from '#lmz-api-context';
import { getOperationChain, executeOperationChain, replaceNestedOperationMarkers, type OperationChain, type Continuation, type AnyContinuation } from './ocan/index.js';
import type { NodeType, NodeIdentity, CallContext, CallOptions, OriginAuth } from './types.js';

// Re-export types for convenience
export type { NodeType, NodeIdentity, CallContext, CallOptions, OriginAuth };

// ============================================
// CallContext propagation
// ============================================

/**
 * Re-export the runtime-specific CallContext storage primitives.
 *
 * The actual implementation comes from `#lmz-api-context`, which the package's
 * `imports` field maps to `./lmz-api-context.workerd.ts` (workerd/worker/node)
 * or `./lmz-api-context.browser.ts` (browser). The server-side implementation
 * uses Node's `AsyncLocalStorage` for true async-context preservation; the
 * browser implementation uses a module-scoped variable with a documented
 * "no preservation across await" caveat (see that file).
 *
 * Isolating the `node:async_hooks` import behind a conditional keeps it out
 * of browser bundles — `@lumenize/mesh/client` (used by LumenizeClient and
 * other browser-bundleable consumers) imports `runWithCallContext` /
 * `getCurrentCallContext` from here transitively, so the conditional split
 * is what makes the client browser-bundleable. See
 * `tasks/playwright-test-template.md` § Known blockers item #2 for context.
 *
 * @internal
 */
export { getCurrentCallContext, runWithCallContext };

/**
 * Resolve the ambient (AsyncLocalStorage-bound) CallContext for `this.lmz.callContext`,
 * throwing outside a mesh call. Shared by the DO and Worker factories — and therefore by
 * `LumenizeContainer`, which composes `createLmzApiForDO`. The browser `LumenizeClient`
 * deliberately does NOT use this: there is no AsyncLocalStorage in the browser, so it reads
 * a synchronously-captured `#currentCallContext` field instead (its one documented divergence).
 *
 * @internal
 */
function requireCurrentCallContext(): CallContext {
  const context = getCurrentCallContext();
  if (!context) {
    throw new Error(
      'Cannot access callContext outside of a mesh call. ' +
      'callContext is only available during @mesh handler execution.'
    );
  }
  return context;
}

// ============================================
// Shared Call Helpers
// ============================================

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
 * The awaited-result `callRaw` primitive has been REMOVED from the mesh model
 * (`mesh-continuation-only-calls`): `__executeOperation` now acks early and never returns a
 * chain result, so no awaited-request/response transport exists. The `callRaw` methods below
 * (retained @deprecated on the surface for one release so unmigrated call *sites* still
 * type-check) throw this at runtime, directing callers to `call()` + a continuation handler.
 *
 * @internal
 */
function throwCallRawRemoved(): never {
  throw new Error(
    'lmz.callRaw() has been removed: cross-node calls no longer await a result (the callee ' +
    'acks early and fires its result back). Use lmz.call(binding, instance, remote, ' +
    'this.ctn().handler(remote)) — the framework delivers the result to your handler.'
  );
}

/**
 * Synchronously validate a mesh call target before dispatch, so a misrouted call
 * fails loudly at the `lmz.call(...)` site instead of being silently dropped as an
 * unhandled rejection on the fire-and-forget path. Routes by binding shape, not by
 * instance-name presence alone:
 * - instance name + non-DO binding  → a Worker/service binding was given an instance name
 * - no instance name + DO namespace → a DO binding is missing its instance name
 *
 * @internal
 */
function assertCallTarget(
  env: any,
  calleeBindingName: string,
  calleeInstanceName: string | undefined
): void {
  const binding = env?.[calleeBindingName];
  if (binding == null) {
    throw new Error(`lmz.call: no binding named '${calleeBindingName}' in env.`);
  }
  const isDO = isDONamespace(binding);
  if (calleeInstanceName !== undefined && !isDO) {
    throw new Error(
      `lmz.call: binding '${calleeBindingName}' is a Worker/service binding but an instance name ` +
      `('${calleeInstanceName}') was supplied. Pass undefined for Worker calls; put trace metadata in CallOptions.`
    );
  }
  if (calleeInstanceName === undefined && isDO) {
    throw new Error(
      `lmz.call: binding '${calleeBindingName}' is a Durable Object namespace and requires an instance name.`
    );
  }
}

/**
 * Resolve the Workers-RPC stub for a mesh target. A DO binding needs a `getDOStub`
 * lookup by instance name; a Worker/service binding is used directly.
 *
 * @internal
 */
function resolveStub(env: any, calleeBindingName: string, calleeInstanceName: string | undefined): any {
  return calleeInstanceName !== undefined
    ? getDOStub(env[calleeBindingName], calleeInstanceName)
    : env[calleeBindingName];
}

/**
 * The ONE awaited transport hop (D2/D15) — collapses the old `callRaw*` trio for the
 * `call()` path. Sends the envelope to the callee's `__executeOperation`, which **acks
 * EARLY** (as soon as it is admitted, before the remote chain runs). The caller holds
 * ZERO state and is freed at the ack; the result (if any) returns later via the callee's
 * fire-back, never on this hop.
 *
 * On an admission/guard/overload reject the ack carries `{ $error }` (D6 tier 2): for a
 * 4-arg call the framework runs the handler **locally** with the Error (the caller is
 * still hot — it just awaited the short ack); a 3-arg reject is logged. A real
 * Workers-RPC transport reject (e.g. a non-`@mesh` `WorkerEntrypoint` with no
 * `__executeOperation`, B8) is folded into the same admission-reject path. Never rejects.
 *
 * @internal
 */
async function dispatchEnvelope(
  env: any,
  nodeInstance: any,
  calleeBindingName: string,
  calleeInstanceName: string | undefined,
  envelope: CallEnvelope,
  handlerChain: OperationChain | undefined,
): Promise<void> {
  const log = debug('lmz.mesh.lmzApi.dispatchEnvelope');
  const stub = resolveStub(env, calleeBindingName, calleeInstanceName);

  let ack: any;
  try {
    ack = await stub.__executeOperation(envelope);
  } catch (transportError) {
    ack = {
      $error: preprocess(transportError instanceof Error ? transportError : new Error(String(transportError))),
    };
  }

  // Admitted (early ack) → nothing to do here; any result returns via the callee's fire-back.
  if (!ack || !('$error' in ack)) return;

  let error: unknown;
  try {
    error = postprocess(ack.$error);
  } catch {
    error = new Error('Mesh call rejected at admission');
  }
  const errorObj = error instanceof Error ? error : new Error(String(error));

  if (!handlerChain) {
    // 3-arg dispatch/admission failure has no handler to receive it → log (D6), never throw async.
    log.error('dispatch/admission failure on a 3-arg call (no handler to receive the error)', {
      error: errorObj.message,
    });
    return;
  }

  // 4-arg: run the caller's handler LOCALLY with the Error (no hop — caller still hot).
  try {
    const filled = replaceNestedOperationMarkers(handlerChain, errorObj);
    await runWithCallContext(envelope.callContext, () =>
      executeOperationChain(filled, nodeInstance, { requireMeshDecorator: false }));
  } catch (handlerError) {
    log.error('failed to deliver a dispatch-rejected result to the local handler', {
      error: handlerError instanceof Error ? handlerError.message : String(handlerError),
    });
  }
}

/**
 * Shared `lmz.call` body for the DO + Worker factories (and `LumenizeContainer`).
 *
 * Builds the envelope (validation sync-throws BEFORE the hop, D6 tier 1), attaches the
 * fire-back {@link EnvelopeResponse} descriptor (D3/D10/D11), and dispatches the one
 * early-acking transport hop. The **caller holds ZERO state** — the 4-arg handler travels
 * with the call and the callee fires it back; nothing is parked here.
 *
 * The only per-node-type divergence: a `LumenizeWorker` is ephemeral, so `ctx.waitUntil`
 * keeps its runtime alive across the short ack hop; a DO/Container stays alive during an
 * active outbound RPC on its own. (The browser `LumenizeClient` does NOT use this — it keeps
 * its handler in-heap, D16, via its own `#call`.)
 *
 * @internal
 */
function callShared(
  self: LmzApi,
  env: any,
  nodeInstance: any,
  calleeBindingName: string,
  calleeInstanceName: string | undefined,
  remoteContinuation: Continuation<any>,
  handlerContinuation?: AnyContinuation,
  options?: CallOptions,
): void {
  // 1. Extract + validate chains — sync-throw, LOUD, before the async hop (D6 tier 1).
  const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);

  // 2. Validate caller knows its own binding (fail fast!)
  if (!self.bindingName) {
    throw new Error(
      self.type === 'LumenizeWorker'
        ? `Cannot use call() from a Worker that doesn't know its own binding name. ` +
          `Ensure incoming calls include metadata or call this.lmz.__init() first.`
        : `Cannot use call() from a DO that doesn't know its own binding name. ` +
          `Ensure routeDORequest routes to this DO or incoming calls include metadata.`
    );
  }

  // 3. Validate the target binding shape — sync-throw at the call site (D6 tier 1).
  assertCallTarget(env, calleeBindingName, calleeInstanceName);

  // 4. Build the fire-back descriptor. 4-arg → the handler TRAVELS (mesh sink);
  //    3-arg → discard. onErrorOnly is evaluated callee-side (N6).
  const selfIdentity: NodeIdentity = {
    type: self.type,
    bindingName: self.bindingName,
    instanceName: self.instanceName,
  };
  const response: EnvelopeResponse = handlerChain
    ? { kind: 'mesh', returnAddr: selfIdentity, handler: preprocess(handlerChain), onErrorOnly: options?.onErrorOnly }
    : { kind: 'discard', onErrorOnly: options?.onErrorOnly };

  // 5. Build the envelope with propagated callContext.
  const calleeType: NodeType = calleeInstanceName ? 'LumenizeDO' : 'LumenizeWorker';
  const envelope: CallEnvelope = {
    version: 1,
    chain: preprocess(remoteChain),
    callContext: buildOutgoingCallContext(selfIdentity, options),
    metadata: {
      caller: { type: selfIdentity.type, bindingName: selfIdentity.bindingName, instanceName: selfIdentity.instanceName },
      callee: { type: calleeType, bindingName: calleeBindingName, instanceName: calleeInstanceName },
    },
    response,
  };

  // 6. Dispatch the one early-acking transport hop.
  const dispatchPromise = dispatchEnvelope(env, nodeInstance, calleeBindingName, calleeInstanceName, envelope, handlerChain);

  // Keep the node alive across the short ack hop so the outbound RPC completes even if the
  // invocation that fired the call is about to return (a Worker is ephemeral; a DO/Container
  // firing from a returning invocation would otherwise have its in-flight subrequest cancelled).
  // Uniform across node types — DurableObjectState.waitUntil and ExecutionContext.waitUntil both exist.
  nodeInstance.ctx.waitUntil(dispatchPromise);
}

/**
 * Fire-back routing carried on a `call()` envelope (absent on a legacy/`callRaw`
 * envelope, and absent on the fire-back envelope itself — a handler never re-fires).
 *
 * Present ⇒ the callee, **after its early ack** (D15), runs the chain under
 * `ctx.waitUntil` and then delivers the outcome per `kind`:
 * - `discard` — 3-arg fire-and-forget: run, drop the result; a post-ack throw is logged.
 * - `mesh` — 4-arg DO/Worker caller: fill `handler` with the outcome and fire it one-way
 *   to `returnAddr.__handleResponse` (run there at `requireMeshDecorator:false`, D5/D10).
 * - `client` — 4-arg client-via-Gateway caller (D16): fire the bare outcome to the Gateway's
 *   `__handleResponse` door keyed by `callId`; the client runs its own in-heap handler.
 *
 * `onErrorOnly` (N6) is evaluated **callee-side**: the success fire-back is skipped.
 *
 * @internal
 */
export type EnvelopeResponse =
  | { kind: 'discard'; onErrorOnly?: boolean }
  | { kind: 'mesh'; returnAddr: NodeIdentity; handler: any; onErrorOnly?: boolean }
  | { kind: 'client'; returnAddr: NodeIdentity; callId: string; onErrorOnly?: boolean };

/**
 * The bare-result payload a mesh node fires to the Gateway's `__handleResponse` door for a
 * client-originated 4-arg call (D16/D17). Unlike a mesh fire-back it carries NO handler chain —
 * the client runs its own in-heap handler; the Gateway only re-resolves delivery by `callId` +
 * `clientInstanceName`. `$result`/`$error` are preprocessed for structured-clone transport.
 *
 * @internal
 */
export interface ClientResultEnvelope {
  callId: string;
  clientInstanceName: string;
  $result?: any;
  $error?: any;
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

  /**
   * Fire-back routing for an early-ack `call()` dispatch. Absent for the
   * deprecated awaited `callRaw` path and for the fire-back envelope itself.
   * See {@link EnvelopeResponse}.
   */
  response?: EnvelopeResponse;
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
   * @deprecated REMOVED — throws at runtime. The awaited-result `callRaw` no longer exists:
   * `__executeOperation` acks early and never returns a chain result. Use
   * `call(binding, instance, remote, this.ctn().handler(remote))` — the framework fills your
   * handler with the result (or Error) and fires it back. Retained on the surface for one
   * release so unmigrated call *sites* still type-check; it is removed entirely in the next phase.
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
 * Stamp a node's identity from the routing headers `routeDORequest` sets
 * (`x-lumenize-do-binding-name` / `x-lumenize-do-instance-name-or-id`), so
 * `this.lmz.bindingName`/`instanceName` are available on the **`fetch()` path** —
 * not only the mesh receive path (`executeEnvelope` ← envelope `metadata.callee`).
 *
 * Shared by `LumenizeDO.__initFromHeaders` (the DO HTTP path) and
 * `LumenizeContainer.fetch()` (the container's public surface), so the container
 * node **composes** this rather than reimplementing it — ADR-007's
 * "identity stamped on every first-contact entry path" requirement.
 *
 * @returns a 400 `Response` if the instance header is a 64-hex DO id (a name is
 *   required), a 500 `Response` if `__init` rejects a binding/name mismatch, or
 *   `undefined` on success (including when no routing headers are present).
 * @internal
 */
export function initIdentityFromHeaders(
  headers: Headers,
  lmz: Pick<LmzApi, '__init'>,
  nodeTypeName = 'mesh node',
): Response | undefined {
  const bindingName = headers.get('x-lumenize-do-binding-name');
  const instanceNameOrId = headers.get('x-lumenize-do-instance-name-or-id');

  // Soundness rests on name == routing key: a DO id string is not a name, so
  // reject it rather than stamp an unusable identity (mirrors the mesh path).
  if (instanceNameOrId && isDurableObjectId(instanceNameOrId)) {
    const message = `${nodeTypeName} requires instanceName, not a DO id string.`;
    debug('lmz.mesh.initIdentityFromHeaders').error(message, { receivedValue: instanceNameOrId });
    return new Response(message, { status: 400 });
  }

  if (bindingName || instanceNameOrId) {
    try {
      lmz.__init({ bindingName: bindingName || undefined, instanceName: instanceNameOrId || undefined });
    } catch (error) {
      // __init's first-write-wins guard throws on a binding/name divergence.
      const message = error instanceof Error ? error.message : String(error);
      debug('lmz.mesh.initIdentityFromHeaders').error('Initialization from headers failed', {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return new Response(message, { status: 500 });
    }
  }

  return undefined; // success (or no headers present)
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
  // __init runs on EVERY incoming envelope/routed request, so the already-stamped
  // re-init is the hot path — skip the redundant put (SQLite writes bill 1000× reads).
  function setBindingName(value: string): void {
    const stored = ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined;

    if (stored !== undefined && stored !== value) {
      throw new Error(
        `DO binding name mismatch: stored '${stored}' but received '${value}'. ` +
        `A DO instance cannot change its binding name.`
      );
    }

    if (stored === undefined) {
      ctx.storage.kv.put('__lmz_do_binding_name', value);
    }
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

    if (stored === undefined) {
      ctx.storage.kv.put('__lmz_do_instance_name', value);
    }
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
      return requireCurrentCallContext();
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
    
    callRaw(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      chainOrContinuation: OperationChain | AnyContinuation,
      options?: CallOptions
    ): Promise<any> {
      void env; void calleeBindingName; void calleeInstanceName; void chainOrContinuation; void options;
      return throwCallRawRemoved();
    },

    call<T = any>(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      remoteContinuation: Continuation<T>,
      handlerContinuation?: AnyContinuation,
      options?: CallOptions
    ): void {
      callShared(this, env, doInstance, calleeBindingName, calleeInstanceName, remoteContinuation, handlerContinuation, options);
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
      return requireCurrentCallContext();
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

    callRaw(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      chainOrContinuation: OperationChain | AnyContinuation,
      options?: CallOptions
    ): Promise<any> {
      void env; void calleeBindingName; void calleeInstanceName; void chainOrContinuation; void options;
      return throwCallRawRemoved();
    },

    call<T = any>(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      remoteContinuation: Continuation<T>,
      handlerContinuation?: AnyContinuation,
      options?: CallOptions
    ): void {
      callShared(this, env, workerInstance, calleeBindingName, calleeInstanceName, remoteContinuation, handlerContinuation, options);
    },
  };
}

// ============================================
// Envelope Execution Helper
// ============================================

/**
 * Node interface for the shared `executeEnvelope` receive path.
 *
 * `LumenizeDO`/`LumenizeWorker`/`LumenizeContainer` all satisfy this structurally.
 * The node's `ctx.waitUntil` (D15) and `env` (fire-back stub) are NOT on this interface —
 * they're `protected` on the base classes, so each node threads them into `executeEnvelope`'s
 * options from inside its own method (where protected access is allowed). `__executeChain`
 * is intentionally absent: `executeEnvelope` calls
 * `executeOperationChain(chain, node, { requireMeshDecorator })` directly (M3).
 *
 * @internal
 */
export interface EnvelopeExecutorNode {
  lmz: {
    /** Initialize node identity from envelope metadata */
    __init(opts: { bindingName?: string; instanceName?: string }): void;
    readonly type: NodeType;
    readonly bindingName?: string;
    readonly instanceName?: string;
  };
  /** Authorization hook run at admission (before the ack) */
  onBeforeCall(): void;
}

/**
 * Fill + fire a `call()`'s response back to its origin (the post-ack half of the
 * traveling-handler model). Runs inside the callee's `runWithCallContext` scope, under
 * `ctx.waitUntil`. Never rejects — every failure is logged, so a bad handler or a
 * rejected response leg can never crash the callee node or become an unhandled rejection.
 *
 * - `discard` (3-arg): drop a success; **log** a post-ack throw (D6) — it has nowhere to go.
 * - `mesh` (4-arg DO/Worker): fill the traveling handler and fire it one-way to
 *   `returnAddr.__handleResponse`. The sink's ack carries `{ $error }` only if the
 *   response leg was **rejected at admission** (e.g. `enforceScopeReach`, D5) — logged
 *   here; a handler that throws *post-ack at the sink* (N8) is logged on the sink itself.
 * - `client` (D16): delivered via the Gateway door — built in the client-leg phase.
 *
 * `onErrorOnly` (N6) is honored here, callee-side: a success fire-back is skipped.
 *
 * @internal
 */
async function fireResponse(
  node: EnvelopeExecutorNode,
  env: any,
  inboundContext: CallContext,
  response: EnvelopeResponse | undefined,
  outcome: unknown,
  isError: boolean,
  nodeTypeName: string,
): Promise<void> {
  const log = debug('lmz.mesh.lmzApi.fireResponse');
  const errText = () => (outcome instanceof Error ? outcome.message : String(outcome));

  // No fire-back wanted, or onErrorOnly skipping a success. An undelivered post-ack
  // throw must still surface (a 3-arg fire-and-forget, or a handler throw at the sink — N8).
  if (!response || response.kind === 'discard' || (response.onErrorOnly && !isError)) {
    if (isError) {
      log.error(`${nodeTypeName}: post-ack chain threw with no handler to receive the error`, { error: errText() });
    }
    return;
  }

  if (response.kind === 'mesh') {
    const calleeIdentity: NodeIdentity = {
      type: node.lmz.type,
      bindingName: node.lmz.bindingName!,
      instanceName: node.lmz.instanceName,
    };
    const handlerChain = postprocess(response.handler) as OperationChain;
    const filled = replaceNestedOperationMarkers(handlerChain, outcome);
    // The fire-back rides the same transport as any mesh hop, so callContext propagates
    // identically — the callee appends itself; originAuth is unchanged (D14/N4). No
    // `response` descriptor: the handler does not itself fire back.
    const fireEnvelope: CallEnvelope = {
      version: 1,
      chain: preprocess(filled),
      callContext: {
        callChain: [...inboundContext.callChain, calleeIdentity],
        originAuth: inboundContext.originAuth,
        state: inboundContext.state,
      },
      metadata: {
        caller: { type: calleeIdentity.type, bindingName: calleeIdentity.bindingName, instanceName: calleeIdentity.instanceName },
        callee: {
          type: response.returnAddr.type,
          bindingName: response.returnAddr.bindingName,
          instanceName: response.returnAddr.instanceName,
        },
      },
    };
    let ack: any;
    try {
      const stub = resolveStub(env, response.returnAddr.bindingName, response.returnAddr.instanceName);
      ack = await stub.__handleResponse(fireEnvelope);
    } catch (transportError) {
      log.error(`${nodeTypeName}: fire-back transport to __handleResponse failed`, {
        error: transportError instanceof Error ? transportError.message : String(transportError),
      });
      return;
    }
    if (ack && '$error' in ack) {
      let sinkErr = 'unknown';
      try { const e = postprocess(ack.$error); sinkErr = e instanceof Error ? e.message : String(e); } catch { /* keep default */ }
      log.error(`${nodeTypeName}: response leg rejected at the sink (D5 gate or admission)`, { error: sinkErr });
    }
    return;
  }

  // response.kind === 'client' (D16/D17): the client keeps its handler in-heap, so we fire the
  // BARE result (not a chain) to the Gateway's __handleResponse door, addressed to the client's
  // instanceName + callId. The Gateway re-resolves delivery to the client's current socket.
  const clientResult: ClientResultEnvelope = {
    callId: response.callId,
    clientInstanceName: response.returnAddr.instanceName!,
    ...(isError ? { $error: preprocess(outcome) } : { $result: preprocess(outcome) }),
  };
  try {
    const stub = resolveStub(env, response.returnAddr.bindingName, response.returnAddr.instanceName);
    await stub.__handleResponse(clientResult);
  } catch (transportError) {
    log.error(`${nodeTypeName}: client fire-back to the Gateway door failed`, {
      error: transportError instanceof Error ? transportError.message : String(transportError),
    });
  }
}

/**
 * Execute an incoming call envelope on a mesh node — the shared receive path for
 * `LumenizeDO`/`LumenizeWorker`/`LumenizeContainer`, for BOTH RPC entries:
 * `__executeOperation` (requests, `requireMeshDecorator: true`) and `__handleResponse`
 * (fire-backs, `requireMeshDecorator: false`). `onBeforeCall` runs on **both** — the
 * response leg is scope-gated by construction (D5), only the @mesh allowlist toggles.
 *
 * **Early ack (D15):** admission (version/callContext/identity/`onBeforeCall`) runs first
 * and returns `{ $ack: true }` the instant the callee is admitted — BEFORE the chain. The
 * chain + fire-back then run as a **detached task under `ctx.waitUntil`**, re-bound to the
 * envelope's `callContext` via `runWithCallContext` (a fresh scope, not a captured closure).
 * An admission/guard failure returns `{ $error }` on the ack instead (D6 tier 2).
 *
 * @internal
 */
export async function executeEnvelope(
  envelope: CallEnvelope,
  node: EnvelopeExecutorNode,
  options?: {
    nodeTypeName?: string;
    includeInstanceName?: boolean;
    requireMeshDecorator?: boolean;
    /** The node's `ctx.waitUntil` — keeps it alive for the detached post-ack tail (D15). */
    waitUntil?: (promise: Promise<any>) => void;
    /** The node's bindings — used to resolve the fire-back return-address stub. */
    env?: any;
    onValidationError?: (error: Error, details: Record<string, any>) => void;
  }
): Promise<{ $ack: true } | { $error: any }> {
  const nodeTypeName = options?.nodeTypeName ?? 'MeshNode';
  const includeInstanceName = options?.includeInstanceName ?? true;
  const requireMeshDecorator = options?.requireMeshDecorator ?? true;

  let callContext: CallContext;
  let operationChain: OperationChain;

  // --- ADMISSION (pre-ack). Every failure here rejects the EARLY ACK with { $error },
  //     which the dispatcher turns into a locally-run handler (4-arg) or a log (3-arg). ---
  try {
    if (!envelope.version || envelope.version !== 1) {
      const error = new Error(
        `Unsupported RPC envelope version: ${envelope.version}. ` +
        `This version of ${nodeTypeName} only supports v1 envelopes. ` +
        `Old-style calls without envelopes are no longer supported.`
      );
      options?.onValidationError?.(error, { receivedVersion: envelope.version, supportedVersion: 1 });
      throw error;
    }

    if (!envelope.callContext) {
      const error = new Error('Missing callContext in envelope. All mesh calls must include callContext.');
      options?.onValidationError?.(error, { envelope });
      throw error;
    }

    // Auto-initialize identity from callee metadata (first-write-wins guard may throw).
    if (envelope.metadata?.callee) {
      node.lmz.__init({
        bindingName: envelope.metadata.callee.bindingName,
        instanceName: includeInstanceName ? envelope.metadata.callee.instanceName : undefined,
      });
    }

    // Postprocess the chain (aliases/cycles, custom Error types).
    operationChain = postprocess(envelope.chain);
    callContext = envelope.callContext;

    // onBeforeCall is the guard — it runs under the call context and may read/mutate
    // state; a throw here rejects admission (scope/auth). This is the D5 gate on the
    // response leg too (both entries call this path).
    runWithCallContext(callContext, () => { node.onBeforeCall(); });
  } catch (error) {
    return { $error: preprocess(error) };
  }

  // --- ADMITTED. Run the chain + fire-back as a DETACHED task under the node's own
  //     waitUntil handle (uniform across node types — DurableObjectState/ExecutionContext
  //     both expose waitUntil), re-bound to the envelope callContext. ---
  const postAck = runWithCallContext(callContext, async () => {
    let outcome: unknown;
    let isError = false;
    try {
      outcome = await executeOperationChain(operationChain, node, { requireMeshDecorator });
    } catch (err) {
      outcome = err instanceof Error ? err : new Error(String(err));
      isError = true;
    }
    await fireResponse(node, options?.env, callContext, envelope.response, outcome, isError, nodeTypeName);
  }).catch((detachedError: unknown) => {
    // Defensive: fireResponse never rejects, but a bug there must not become an
    // unhandled rejection on the waitUntil promise.
    debug('lmz.mesh.lmzApi.executeEnvelope').error(`${nodeTypeName}: detached post-ack task failed`, {
      error: detachedError instanceof Error ? detachedError.message : String(detachedError),
    });
  });
  // Keep the node alive for the detached tail. `waitUntil` is always supplied by real nodes;
  // the postAck already started executing regardless (the async fn runs eagerly).
  options?.waitUntil?.(postAck);

  return { $ack: true };
}

