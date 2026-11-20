import { debug } from '@lumenize/debug';
import { isDurableObjectId, isDONamespace, getDOStub } from '@lumenize/routing';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { getCurrentCallContext, runWithCallContext } from '#lmz-api-context';
import { getOperationChain, executeOperationChain, executeFilledChain, replaceNestedOperationMarkers, type OperationChain, type Continuation, type AnyContinuation } from './ocan/index.js';
import type { NodeType, NodeIdentity, CallContext, CallOptions, OriginAuth } from './types.js';
import { broadcastShared, type BroadcastTarget, type BroadcastOptions } from './broadcast.js';
import { findRawRpcMethod } from './raw-rpc-decorator.js';
import { isClientInstanceName, hostInstanceOf } from './client-address.js';
import type { ClientGateway } from './client-gateway.js';
import { PASSAGE_STEP, UNSCOPED_NODE } from './node-kinds.js';
import { parseId, isPlatformScope } from './auth/parse-id.js';
import { prependActor, type RecordedClaims } from './auth/access-claims.js';

/**
 * Whether a name is a scope's (`acme`, `acme.crm`, `acme.crm.tenant1`), the reserved `_platform` included. Not a string reads as a scope, so a
 * check refusing scope names fails closed on a frame that sent an array. Shared by `lmz.__init` and a
 * host's Gateway, so the two refuse the same names. Internal to Mesh, not exported from an entry.
 */
export function namesScope(instanceName: unknown): boolean {
  if (typeof instanceName !== 'string') return true;
  if (isPlatformScope(instanceName)) return true;
  try { parseId(instanceName); return true; } catch { return false; }
}

/** What an unscoped node, or a Gateway on its behalf, says to a call under a scope's name. */
export function scopeNameRefusal(instanceName: string): string {
  return `"${instanceName}" parses as a scope, and an UnscopedMeshDO never runs under a scope's ` +
    'name — name it by an id, such as a UUID, or extend ScopedMeshDO';
}

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
 * of browser bundles — `@lumenize/mesh/client` (used by MeshClient and
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
 * throwing outside a mesh call. Shared by the DO and Worker factories. The browser `MeshClient`
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
 * The operation chain of a call's remote continuation. Shared by every `call()` and the client's
 * `callAsync`.
 *
 * @throws Error if the continuation was not made by `this.ctn()`
 * @internal
 */
export function extractRemoteChain(remoteContinuation: AnyContinuation): OperationChain {
  const remoteChain = getOperationChain(remoteContinuation);
  if (!remoteChain) {
    throw new Error('Invalid remoteContinuation: must be created with this.ctn()');
  }
  return remoteChain;
}

/**
 * The operation chains of a call's remote and handler continuations. Shared by the DO, Worker and
 * Client `call()` methods.
 *
 * @throws Error if either continuation was not made by `this.ctn()`, or the handler does not end in
 * a call
 * @internal
 */
export function extractCallChains(
  remoteContinuation: AnyContinuation,
  handlerContinuation: AnyContinuation
): { remoteChain: OperationChain; handlerChain: OperationChain } {
  const remoteChain = extractRemoteChain(remoteContinuation);
  const handlerChain = getOperationChain(handlerContinuation);
  if (!handlerChain) {
    throw new Error('Invalid handlerContinuation: must be created with this.ctn()');
  }
  // The answer is filled into the handler's final call, so a handler ending anywhere else would
  // never hear it. A Client's server-side half refuses such a frame too, as the trust boundary.
  if (handlerChain.at(-1)?.type !== 'apply') {
    throw new Error('Invalid handlerContinuation: it must end in a call, which its answer is filled into');
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
 * @param options - CallOptions with newChain
 * @returns CallContext to include in the envelope
 * @internal
 */
export function buildOutgoingCallContext(
  callerIdentity: NodeIdentity,
  options?: CallOptions
): CallContext {
  const currentContext = getCurrentCallContext();

  // A local principal's built claims never leave its node: a call made under them is the node
  // speaking for itself, so it starts a fresh chain whatever `newChain` says.
  if (options?.newChain || !currentContext || kindOf(currentContext) === 'local-principal') {
    // Start a fresh chain - caller becomes the origin
    // callChain = [caller] (caller is both origin and immediate caller)
    return {
      callChain: [callerIdentity],
      originAuth: undefined,
    };
  }

  // Inherit and extend the current context
  // Append this node to the call chain (so receiver knows who called them)
  const newCallChain = [...currentContext.callChain, callerIdentity];

  // Spread the inherited context and override only what this hop changes — so originAuth,
  // originRequest, and any immutable field added later ride through without being named here.
  // ⚠️ `callee` is PER-HOP, and is named here precisely BECAUSE the comment above says an unnamed
  // field rides through — which is right for every other field and wrong for this one.
  // ⓘ Honestly: no test reds without this line, and none can. Every receiver overwrites the field
  // unconditionally (`executeEnvelope`), and a Client's server-side half forwards a call to it with an
  // explicit two-field list (`#forwardToClient`), so an inherited value is discarded before anything
  // reads it. What the line
  // buys is that the next per-hop field added here is added deliberately rather than by omission.
  return {
    ...currentContext,
    callChain: newCallChain,
    callee: undefined,
  };
}

// ============================================
// Running a block under claims
// ============================================

/**
 * Marks a context Mesh built for a local principal. The key is a
 * symbol, so `buildOutgoingCallContext`'s spread carries it within the isolate and no wire carries it:
 * an envelope from another node can neither bring one nor forge one.
 */
const CONTEXT_KIND = Symbol('lmz.contextKind');
type ContextKind = 'local-principal';

function kindOf(context: CallContext | undefined): ContextKind | undefined {
  return (context as (CallContext & { [CONTEXT_KIND]?: ContextKind }) | undefined)?.[CONTEXT_KIND];
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A local principal's name says what it is (ADR-025), so it can never be a person's random id. */
function requireLocalPrincipalName(principal: string): void {
  if (typeof principal !== 'string' || principal.length === 0) {
    throw new Error('A local principal needs a name, such as "agent:lumenize"');
  }
  if (UUID_SHAPE.test(principal)) {
    throw new Error(`A local principal's name says what it is, and "${principal}" is shaped like a person's id`);
  }
}

/**
 * Run `fn` under the claims a stored record holds, with `principal` prepended as the outermost
 * actor. `origin` is the acting node's own, from its stored address, and rides as the chain's
 * `originRequest.origin`, so a link a callee builds names the stack the node is served on.
 */
function actForRecord<T>(record: RecordedClaims, principal: string, origin: string | undefined, fn: () => T): T {
  requireLocalPrincipalName(principal);
  // A person's id is a UUID and a local principal's name never is, so a record a local principal
  // wrote as itself, an agent's own post say, is no one to act for.
  if (typeof record?.sub !== 'string' || !UUID_SHAPE.test(record.sub)) {
    throw new TypeError(`Cannot act for this record: its sub is not shaped like a person's id`);
  }
  const built = {
    callChain: [],
    originAuth: {
      sub: record.sub,
      claims: { ...record, act: prependActor(record.act, { sub: principal, profileId: principal }) },
    },
    ...(origin !== undefined ? { originRequest: { origin } } : {}),
  } as CallContext;
  return runWithCallContext(built, fn);
}


function asLocalPrincipalShared<T>(nodeName: string | undefined, principal: string, fn: () => T): T {
  requireLocalPrincipalName(principal);
  if (!nodeName) {
    throw new Error('A local principal acts in a named node, and this one has no name yet');
  }
  const built = {
    callChain: [],
    originAuth: {
      sub: principal,
      // No `scopeAdmin`, ever: a local principal holds grants in its node's orgTree and nothing else.
      claims: { sub: principal, profileId: principal, aud: nodeName, access: { authScope: nodeName } },
    },
    [CONTEXT_KIND]: 'local-principal' as const,
  } as CallContext;
  return runWithCallContext(built, fn);
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
 * lookup by instance name; a Worker/service binding is used directly. A Client's instance name,
 * `acme.crm.tenant1/alice.9f2c41aa`, reaches the node that hosts it, `acme.crm.tenant1`.
 *
 * @internal
 */
export function resolveStub(env: any, calleeBindingName: string, calleeInstanceName: string | undefined): any {
  return calleeInstanceName !== undefined
    ? getDOStub(env[calleeBindingName], hostInstanceOf(calleeInstanceName))
    : env[calleeBindingName];
}

/** Whether (`bindingName`, `instanceName`) addresses a Client that `node` itself hosts. */
function isOwnHostedClient(
  node: { lmz?: { bindingName?: string; instanceName?: string } } | undefined,
  bindingName: string, instanceName: string | undefined,
): instanceName is string {
  return isClientInstanceName(instanceName) && node?.lmz?.bindingName === bindingName
    && node.lmz.instanceName === hostInstanceOf(instanceName);
}

/**
 * Whether a message to (`bindingName`, `instanceName`) is for `node` itself or a Client it hosts, so
 * it goes to `node`'s own door as a method call: a call to its request door, an answer to its
 * fire-back door. Never over RPC, where each message to itself is a new invocation nested inside the
 * one that sent it, and Cloudflare refuses a call nested 16 deep: a turn streaming to a tab that had
 * gone sent its answers 16 deep and lost its reaper (2026-10-14).
 */
function isForThisNode(
  node: { lmz?: { bindingName?: string; instanceName?: string } } | undefined,
  bindingName: string, instanceName: string | undefined,
): boolean {
  if (isOwnHostedClient(node, bindingName, instanceName)) return true;
  return instanceName !== undefined && node?.lmz?.bindingName === bindingName && node.lmz.instanceName === instanceName;
}

/**
 * The ONE awaited transport hop — collapses the old `callRaw*` trio for the
 * `call()` path. Sends the envelope to the callee's `__executeOperation`, which **acks
 * EARLY** (as soon as it is admitted, before the remote chain runs). The caller holds
 * ZERO state and is freed at the ack; the result (if any) returns later via the callee's
 * fire-back, never on this hop.
 *
 * On an admission/guard/overload reject the ack carries `{ $error }`, and
 * the framework runs the handler **locally** with the Error (the caller is still hot — it
 * just awaited the short ack). A real
 * Workers-RPC transport reject (e.g. a non-`@mesh` `WorkerEntrypoint` with no
 * `__executeOperation`) is folded into the same admission-reject path. Never rejects.
 *
 * @internal
 */
async function dispatchEnvelope(
  env: any,
  nodeInstance: any,
  calleeBindingName: string,
  calleeInstanceName: string | undefined,
  envelope: CallEnvelope,
  handlerChain: OperationChain,
  remoteChain: OperationChain,
): Promise<void> {
  const log = debug('lmz.mesh.lmzApi.dispatchEnvelope');

  let ack: any;
  try {
    if (isForThisNode(nodeInstance, calleeBindingName, calleeInstanceName)) {
      // A call to this node, or a push to a Client it hosts, goes through the node's own door.
      log.debug('delivered in place', {
        bindingName: calleeBindingName, instanceName: calleeInstanceName, method: methodOf(remoteChain),
      });
      ack = await nodeInstance.__executeOperation(envelope);
    } else {
      ack = await resolveStub(env, calleeBindingName, calleeInstanceName).__executeOperation(envelope);
    }
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

  // Run the caller's handler LOCALLY with the Error (no hop — caller still hot).
  try {
    const filled = replaceNestedOperationMarkers(handlerChain, errorObj);
    // The handler runs HERE, so the address that matters to it is the one this call was sent to —
    // taken from the dispatch's own parameter, never from anything the reply carries. OVERWRITTEN
    // unconditionally: a set-if-absent would leave an upstream node's address in place, and a
    // reaper reading it would act on somebody else's.
    const handlerContext: CallContext = {
      ...envelope.callContext,
      callee: {
        type: calleeInstanceName ? 'LumenizeDO' : 'LumenizeWorker',
        bindingName: calleeBindingName,
        instanceName: calleeInstanceName,
      },
    };
    await runWithCallContext(handlerContext, () =>
      executeFilledChain(filled, nodeInstance, { requireMeshDecorator: false }));
  } catch (handlerError) {
    log.error('failed to deliver a dispatch-rejected result to the local handler', { error: handlerError });
  }
}

/**
 * Shared `lmz.call` body for the DO + Worker factories.
 *
 * Builds the envelope (validation sync-throws BEFORE the hop), attaches the
 * fire-back {@link EnvelopeResponse} descriptor, and dispatches the one
 * early-acking transport hop. The **caller holds ZERO state** — the handler travels
 * with the call and the callee fires it back; nothing is parked here.
 *
 * The only per-node-type divergence is what `ctx.waitUntil` does across the short ack hop: it
 * keeps an ephemeral `MeshWorker` alive at any compatibility date, and a DO/Container only
 * from 2026-10-01 (`durable_object_io_tasks_prevent_eviction`) — before that it is a **no-op**
 * on a DO, which the hop's few milliseconds make harmless. (The browser `MeshClient` does
 * NOT use this — it sends its handler with the call through its host node, via its own `#call`.)
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
  handlerContinuation: AnyContinuation,
  options?: CallOptions,
): void {
  // 1. Extract + validate chains — sync-throw, LOUD, before the async hop.
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

  // 3. Validate the target binding shape — sync-throw at the call site.
  assertCallTarget(env, calleeBindingName, calleeInstanceName);

  // 4. Build the fire-back descriptor: the handler TRAVELS (mesh sink). onErrorOnly is evaluated
  //    callee-side (N6).
  const selfIdentity: NodeIdentity = {
    type: self.type,
    bindingName: self.bindingName,
    instanceName: self.instanceName,
  };
  const response: EnvelopeResponse = {
    kind: 'mesh', returnAddr: selfIdentity, handler: preprocess(handlerChain), onErrorOnly: options?.onErrorOnly,
  };

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
  const dispatchPromise = dispatchEnvelope(env, nodeInstance, calleeBindingName, calleeInstanceName, envelope, handlerChain, remoteChain);

  // Keep the node alive across the short ack hop so the outbound RPC completes even if the
  // invocation that fired the call is about to return. An ephemeral `MeshWorker` needs this at
  // any compatibility date. A DO/Container is held by it only from 2026-10-01
  // (`durable_object_io_tasks_prevent_eviction`); before that it is a no-op on a DO, which is
  // harmless here because the hop takes milliseconds, far inside the 70–140 s idle window.
  nodeInstance.ctx.waitUntil(dispatchPromise);
}

/**
 * Fire-back routing carried on a `call()` envelope (absent on a non-`call()`
 * envelope — alarms — and on the fire-back envelope itself, since a handler never
 * re-fires).
 *
 * Present ⇒ the callee, **after its early ack**, runs the chain under `ctx.waitUntil`, fills
 * `handler` with the outcome, and fires it one-way to `returnAddr.__handleResponse` (run there at
 * `requireMeshDecorator:false`). The caller answers the same way whoever it is: a Client's server-side half
 * wrote this descriptor for it, with the Client as `returnAddr`, and hands the fire-back down.
 *
 * `onErrorOnly` (N6) is evaluated **callee-side**: the success fire-back is skipped. `callId` and
 * `loadId` are echoed onto the fire-back for a caller that set them; a Client uses both.
 *
 * @internal
 */
export type EnvelopeResponse = {
  kind: 'mesh';
  returnAddr: NodeIdentity;
  handler: any;
  onErrorOnly?: boolean;
  callId?: string;
  loadId?: string;
};

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
 * | `callContext.originRequest` | No (edge facts, plain strings) | Never |
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
   * Fire-back routing for an early-ack `call()` dispatch. Absent on the fire-back
   * envelope itself (a handler never re-fires) and on non-`call()` envelopes (alarms).
   * See {@link EnvelopeResponse}.
   */
  response?: EnvelopeResponse;

  /** On a fire-back: the `callId` the call's descriptor carried, echoed. */
  callId?: string;

  /** On a fire-back: the `loadId` the call's descriptor carried, echoed. */
  loadId?: string;
}

/**
 * Lumenize API - Identity and RPC infrastructure for MeshDO and MeshWorker
 *
 * Provides clean abstraction over identity management (binding name, instance name)
 * and RPC infrastructure (`call`, and `broadcast` built on it) for both Durable Objects and
 * Worker Entrypoints.
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
   * - **MeshDO**: Stored in the node's address record, `__lmz_do_address`; an unscoped node holds a
   *   call's in memory until it persists it (`createLmzApiForDO`)
   * - **MeshWorker**: Stored in private field
   *
   * **Validation**: Cannot be changed once set to a different value
   */
  readonly bindingName?: string;

  /**
   * Instance name for this DO (undefined for Workers)
   *
   * - **MeshDO**: Stored in the node's address record, `__lmz_do_address`; an unscoped node holds a
   *   call's in memory until it persists it (`createLmzApiForDO`)
   * - **MeshWorker**: Always undefined (Workers are ephemeral)
   *
   * **Validation**: Cannot be changed once set to a different value
   */
  readonly instanceName?: string;

  /**
   * Type of this DO or Worker
   *
   * - **`ScopedMeshDO`, `UnscopedMeshDO`**: Returns `'LumenizeDO'`
   * - **`MeshWorker`**: Returns `'LumenizeWorker'`
   *
   * Getter-only property determined by class type. The strings predate the class names.
   */
  readonly type: NodeType;

  /**
   * Current call context (only valid during `@mesh` handler execution)
   *
   * Contains callChain, originAuth, originRequest and callee for the current request.
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
   * Called by `__initFromHeaders()`, the `@rawRpc()` entry and envelope processing, which passes
   * `'envelope'`: there an unscoped node holds the stamp in memory rather than persisting it.
   * Not for external use.
   *
   * @internal
   */
  __init(options: { bindingName?: string; instanceName?: string }, from?: 'envelope'): void;

  /**
   * Persist an identity stamp held in memory, as an unscoped node must once it can act with no call
   * to stamp from. `Alarms.schedule` calls it. Absent on a Worker, which persists nothing.
   *
   * @internal
   */
  __persistIdentity?(): void;

  /**
   * @internal Record the origin this node's own pages are served on, from a Client's accepted
   * upgrade. Rewrites the stored address only when the scheme or the port differs from the stored
   * origin's: every host of a deployment shares both, so a persona's host on a `.dev` Star writes
   * nothing, and production writes once. A node that hosts no Clients never has one. The stored
   * host is that of the first accepted upgrade, which on a `.dev` Star can be a persona's, so a
   * reader relies on the scheme and port alone.
   */
  __setOrigin?(origin: string): void;

  /**
   * One-way call whose outcome reaches a result handler continuation
   *
   * High-level method for DO-to-DO/Worker calls using continuation pattern.
   * Returns immediately while work executes asynchronously in the background.
   *
   * **Use cases**:
   * - Application code that wants actor model behavior
   * - Event handlers that need to trigger remote calls without blocking
   * - Methods that want to chain operations across DOs
   * - Calls whose outcome matters only on failure (a handler with `onErrorOnly`)
   *
   * **Continuation pattern**:
   * - Remote continuation: what to execute on remote DO/Worker
   * - Handler continuation: what to execute locally when the result or Error arrives
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
   * - `handlerContinuation` - What to execute locally when done (from `this.ctn()`)
   * - `options` - Optional configuration
   *
   * **Returns**: void (returns immediately; the handler runs when the outcome arrives)
   *
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  call<T = any>(
    calleeBindingName: string,
    calleeInstanceName: string | undefined,
    remoteContinuation: Continuation<T>,
    handlerContinuation: AnyContinuation,
    options?: CallOptions
  ): void;

  /**
   * Run `fn` under a person's claims, with `principal`, this node's local principal, prepended as
   * the outermost actor. A call made inside carries them on, so every record the chain leaves names
   * the person and the principal both, and every check reads the person's permission.
   *
   * The claims come from a stored record: what the server stamped on a snapshot from the verified
   * claims of the write that made it. `access` and `aud` are therefore as of that write. A node
   * that hosts Clients also hands the chain its own origin, as `originRequest.origin`.
   *
   * @throws Error if `principal` is empty or shaped like a UUID; TypeError if the record's `sub` is
   *   not shaped like a person's id, as a local principal's own is not.
   */
  actFor<T>(record: RecordedClaims, principal: string, fn: () => T): T;

  /**
   * Run `fn` under claims Mesh builds for a local principal of this node: `principal` as subject,
   * this node's name as `aud` and `authScope`, and no `scopeAdmin`. The claims never leave the
   * node: a call made inside starts a fresh chain with no claims.
   *
   * @throws Error if `principal` is empty or shaped like a UUID, or the node has no name yet.
   */
  asLocalPrincipal<T>(principal: string, fn: () => T): T;

  /**
   * Send one continuation to many targets — one `call` per target, from this node, at any N.
   *
   * `options.onResult` hears only failures. Each call starts a fresh chain unless `newChain: false`.
   * A target whose binding does not route throws synchronously, before any later target is sent.
   *
   * @see `broadcast.ts` — the chain each target sees, and where `callContext.callee` names the target
   */
  broadcast<T = any>(
    targets: BroadcastTarget[],
    remoteContinuation: Continuation<T>,
    options: BroadcastOptions
  ): void;
}

/**
 * Stamp a node's identity from the routing headers `routeDORequest` sets
 * (`x-lumenize-do-binding-name` / `x-lumenize-do-instance-name-or-id`), so
 * `this.lmz.bindingName`/`instanceName` are available on the **`fetch()` path** —
 * not only the mesh receive path (`executeEnvelope` ← envelope `metadata.callee`).
 *
 * Used by `MeshDO.__initFromHeaders` (the DO HTTP path), and composed by any other
 * HTTP entry rather than reimplemented — ADR-007's "identity stamped on every
 * first-contact entry path" requirement.
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
      debug('lmz.mesh.initIdentityFromHeaders').error('Initialization from headers failed', { error });
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  }

  return undefined; // success (or no headers present)
}

/** The key a node's stored address sits under. */
const ADDRESS_KEY = '__lmz_do_address';

/** A node's stored address. `origin` is set only on a node one of whose own Clients has connected. */
interface StoredAddress { bindingName?: string; instanceName?: string; origin?: string }

function sameSchemeAndPort(a: string, b: string): boolean {
  const x = new URL(a);
  const y = new URL(b);
  return x.protocol === y.protocol && x.port === y.port;
}

/**
 * Create LmzApi implementation for MeshDO
 *
 * A node's address is persisted in Durable Object storage as one record under one key,
 * `__lmz_do_address`: its `bindingName`, its `instanceName`, and for a node that hosts Clients the
 * `origin` its own pages are served on. One key, so the stamp check on every call is one read.
 *
 * A scoped node persists both at its first contact. An unscoped node, named by an id such as a
 * `profileId`, keeps the stamp a call brings in memory, so a call naming an id nobody created
 * leaves nothing behind. It persists the stamp only where it may later act with no call to stamp
 * from: a routed request, which can accept a socket that wakes knowing its name but not its
 * binding; a `@rawRpc()` entry; and once it has an alarm row, whichever comes first, the alarm or
 * the call. The held stamp is a cache, not state: every call brings it again.
 *
 * @internal Used by MeshDO.lmz getter
 */
export function createLmzApiForDO(ctx: DurableObjectState, env: any, doInstance: any): LmzApi {
  // An unscoped node's stamp from the call that woke it, until something needs it persisted.
  let heldBindingName: string | undefined;
  let heldInstanceName: string | undefined;

  const stored = () => ctx.storage.kv.get(ADDRESS_KEY) as StoredAddress | undefined;

  /** The one place the record is written. A test counts writes by this line's debug output. */
  function putAddress(patch: StoredAddress): void {
    const next = { ...stored(), ...patch };
    ctx.storage.kv.put(ADDRESS_KEY, next);
    debug('lmz.mesh.address').debug('address stored', next);
  }

  /** Whether this node has scheduled an alarm, which may wake it with no call to stamp from. */
  function hasAlarmRow(): boolean {
    const table = ctx.storage.sql.exec(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__lmz_alarms'`).toArray();
    return table.length > 0 && ctx.storage.sql.exec(`SELECT 1 FROM __lmz_alarms LIMIT 1`).toArray().length > 0;
  }

  // `__init` runs on EVERY incoming envelope/routed request, so the already-stamped re-init is
  // the hot path: one read, and no put (SQLite writes bill 1000× reads).
  function requireSameName(kind: 'binding' | 'instance', current: string | undefined, value: string): void {
    if (current === undefined || current === value) return;
    throw new Error(kind === 'binding'
      ? `DO binding name mismatch: stored '${current}' but received '${value}'. ` +
        `A DO instance cannot change its binding name.`
      : `DO instance name mismatch: stored '${current}' but received '${value}'. ` +
        `A DO instance cannot change its name.`);
  }

  return {
    // --- Getters (all readonly) ---

    get bindingName(): string | undefined {
      return stored()?.bindingName ?? heldBindingName;
    },

    get instanceName(): string | undefined {
      return stored()?.instanceName ?? heldInstanceName;
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
    __init(options: { bindingName?: string; instanceName?: string }, from?: 'envelope'): void {
      const unscoped = doInstance?.[UNSCOPED_NODE] === true;
      // An `UnscopedMeshDO` never runs under a scope's name: passage trusts a scope-shaped name
      // to check passage into its scope, and an unscoped node checks none.
      if (options.instanceName !== undefined && unscoped && namesScope(options.instanceName)) {
        throw new Error(scopeNameRefusal(options.instanceName));
      }

      // A call to an unscoped node is held in memory, under the name the namespace addressed: the
      // name a call brings must be `ctx.id.name`, so the name held is the one the refusals checked.
      const persist = !(from === 'envelope' && unscoped && ctx.id.name !== undefined && !hasAlarmRow());
      if (!persist && options.instanceName !== undefined && options.instanceName !== ctx.id.name) {
        throw new Error(
          `DO instance name mismatch: this object is '${ctx.id.name}' but the call names '${options.instanceName}'. ` +
          `A DO instance cannot change its name.`
        );
      }

      const address = stored();
      const patch: StoredAddress = {};
      if (options.bindingName !== undefined) {
        requireSameName('binding', address?.bindingName ?? heldBindingName, options.bindingName);
        if (!persist) heldBindingName = options.bindingName;
        else if (address?.bindingName === undefined) patch.bindingName = options.bindingName;
      }
      if (options.instanceName !== undefined) {
        requireSameName('instance', address?.instanceName ?? heldInstanceName, options.instanceName);
        if (!persist) heldInstanceName = options.instanceName;
        else if (address?.instanceName === undefined) patch.instanceName = options.instanceName;
      }
      if (patch.bindingName !== undefined || patch.instanceName !== undefined) putAddress(patch);
    },

    __persistIdentity(): void {
      const address = stored();
      const patch: StoredAddress = {};
      if (heldBindingName !== undefined && address?.bindingName === undefined) patch.bindingName = heldBindingName;
      if (heldInstanceName !== undefined && address?.instanceName === undefined) patch.instanceName = heldInstanceName;
      if (patch.bindingName !== undefined || patch.instanceName !== undefined) putAddress(patch);
    },

    __setOrigin(origin: string): void {
      const current = stored()?.origin;
      if (current !== undefined && sameSchemeAndPort(current, origin)) return;
      putAddress({ origin });
    },

    call<T = any>(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      remoteContinuation: Continuation<T>,
      handlerContinuation: AnyContinuation,
      options?: CallOptions
    ): void {
      callShared(this, env, doInstance, calleeBindingName, calleeInstanceName, remoteContinuation, handlerContinuation, options);
    },

    broadcast<T = any>(
      targets: BroadcastTarget[],
      remoteContinuation: Continuation<T>,
      options: BroadcastOptions
    ): void {
      broadcastShared(this, targets, remoteContinuation, options);
    },

    actFor<T>(record: RecordedClaims, principal: string, fn: () => T): T {
      return actForRecord(record, principal, stored()?.origin, fn);
    },

    asLocalPrincipal<T>(principal: string, fn: () => T): T {
      return asLocalPrincipalShared(this.instanceName, principal, fn);
    },
  };
}

/**
 * Create LmzApi implementation for MeshWorker
 *
 * Identity stored in closure (private to this function):
 * - `bindingName` - stored in closure variable
 * - `instanceName`, `id` - always undefined (Workers are ephemeral)
 *
 * @internal Used by MeshWorker.lmz getter
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

    call<T = any>(
      calleeBindingName: string,
      calleeInstanceName: string | undefined,
      remoteContinuation: Continuation<T>,
      handlerContinuation: AnyContinuation,
      options?: CallOptions
    ): void {
      callShared(this, env, workerInstance, calleeBindingName, calleeInstanceName, remoteContinuation, handlerContinuation, options);
    },

    broadcast<T = any>(
      targets: BroadcastTarget[],
      remoteContinuation: Continuation<T>,
      options: BroadcastOptions
    ): void {
      broadcastShared(this, targets, remoteContinuation, options);
    },

    actFor<T>(record: RecordedClaims, principal: string, fn: () => T): T {
      // A Worker has no stored address, so its chain carries no origin.
      return actForRecord(record, principal, undefined, fn);
    },

    asLocalPrincipal<T>(principal: string, fn: () => T): T {
      return asLocalPrincipalShared(this.instanceName, principal, fn);
    },
  };
}

// ============================================
// Envelope Execution Helper
// ============================================

/**
 * Node interface for the shared `executeEnvelope` receive path.
 *
 * `MeshDO` and `MeshWorker` both satisfy this structurally.
 * The node's `ctx.waitUntil` and `env` (fire-back stub) are NOT on this interface —
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
    __init(opts: { bindingName?: string; instanceName?: string }, from?: 'envelope'): void;
    readonly type: NodeType;
    readonly bindingName?: string;
    readonly instanceName?: string;
  };
  /** Authorization hook run at admission (before the ack) */
  onBeforeCall(): void;
}

// The error a caller's handler gets in place of a result that cannot be encoded. The
// result is re-encoded alone so the message's path points into the result, not into
// the handler chain it was spliced into.
function unencodableResult(outcome: unknown, callee: string, encodeError: unknown): Error {
  let detail = encodeError instanceof Error ? encodeError.message : String(encodeError);
  try {
    preprocess(outcome);
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
  }
  return new DOMException(`The result of ${callee} cannot cross the mesh. ${detail}`, 'DataCloneError');
}

// `TEST_DO.remoteEcho()`: the callee's binding and the method its chain ended in.
/** The member a chain names last, such as `handleStreamChunk`, or `undefined` for a chain with none. */
function methodOf(chain: OperationChain): string | undefined {
  let method: string | undefined;
  for (const op of chain) if (op.type === 'get') method = String(op.key);
  return method;
}

function describeCallee(node: EnvelopeExecutorNode, chain: OperationChain): string {
  const method = methodOf(chain);
  const name = node.lmz.bindingName ?? node.lmz.type;
  return method === undefined ? name : `${name}.${method}()`;
}

/**
 * Fill + fire a `call()`'s response back to its origin (the post-ack half of the
 * traveling-handler model), as `answerer`, which becomes the fire-back's last hop. A node runs
 * it inside its `runWithCallContext` scope, under `ctx.waitUntil`; a Client's server-side half runs it
 * as its Client, which is why it is exported (ADR-007). Never rejects — every failure is
 * logged, so a bad handler or a rejected response leg can never crash the answering side or
 * become an unhandled rejection.
 *
 * - Fill the traveling handler and fire it one-way to `returnAddr.__handleResponse`: a node's
 *   own fire-back door, which for a Client's answer is its host's, whose server-side half hands it
 *   down. The sink's ack carries
 *   `{ $error }` only if the response leg was **rejected at admission** (e.g. the response-leg
 *   scope gate, `requirePassage`) — logged here; a handler that throws *post-ack at the sink*
 *   (N8) is logged on the sink itself.
 * - A result that cannot be encoded (a `CryptoKey`, a native `Response`) reaches the
 *   handler as a `DataCloneError` naming `callee`, in its place — on either leg — so the
 *   caller hears about it instead of waiting on a reply that never comes.
 *
 * `onErrorOnly` (N6) is honored here, callee-side: a success fire-back is skipped.
 *
 * @internal
 */
export async function fireResponse(
  answerer: NodeIdentity,
  env: any,
  inboundContext: CallContext,
  response: EnvelopeResponse | undefined,
  outcome: unknown,
  isError: boolean,
  nodeTypeName: string,
  callee: string,
  /** The answering node, when its own door may take the answer: a Client it hosts asked, or the
   *  node did, as when its Gateway answers for a Client the node called. */
  local?: { lmz: { bindingName?: string; instanceName?: string }; __handleResponse(envelope: CallEnvelope): Promise<any> },
): Promise<void> {
  const log = debug('lmz.mesh.lmzApi.fireResponse');
  // No fire-back wanted, or onErrorOnly skipping a success. An undelivered post-ack
  // throw must still surface: a continuation that throws at the fire-back door carries no
  // `response` of its own, so this is the only place its Error is logged (N8).
  if (!response || (response.onErrorOnly && !isError)) {
    if (isError) {
      // The stack rides along: a bare message (`TypeError: undefined is not a function`,
      // 2026-09-06, once in a dozen live runs) names nothing a reader can act on.
      log.error(`${nodeTypeName}: post-ack chain threw with no handler to receive the error`, { error: outcome });
    }
    return;
  }

  const chain = fillHandler(response.handler, outcome, callee);
  // The fire-back rides the same transport as any mesh hop, so callContext propagates
  // identically — the answerer appends itself; originAuth is unchanged. No
  // `response` descriptor: the handler does not itself fire back.
  const fireEnvelope: CallEnvelope = {
    version: 1,
    chain,
    callContext: {
      ...inboundContext,  // originAuth, originRequest, and any later immutable field ride through
      // The last hop is the answerer, and it is where the caller's `__handleResponse` reads the
      // handler's `callee` from, so the handler learns which target answered. The inbound
      // `callee` rides along in the spread above, and that door discards it.
      callChain: [...inboundContext.callChain, answerer],
    },
    metadata: {
      caller: { type: answerer.type, bindingName: answerer.bindingName, instanceName: answerer.instanceName },
      callee: {
        type: response.returnAddr.type,
        bindingName: response.returnAddr.bindingName,
        instanceName: response.returnAddr.instanceName,
      },
    },
    ...(response.callId !== undefined ? { callId: response.callId } : {}),
    ...(response.loadId !== undefined ? { loadId: response.loadId } : {}),
  };
  let ack: any;
  try {
    const { bindingName, instanceName } = response.returnAddr;
    if (local && isForThisNode(local, bindingName, instanceName)) {
      // The asker is this node or a Client it hosts, so the answer goes to its own door from here.
      log.debug('answered in place', { bindingName, instanceName });
      ack = await local.__handleResponse(fireEnvelope);
    } else {
      ack = await resolveStub(env, bindingName, instanceName).__handleResponse(fireEnvelope);
    }
  } catch (transportError) {
    // A transport error names no node: `Subrequest depth limit exceeded` (2026-10-13) said only
    // that some chain ran 16 calls deep. The chain and the target say which one.
    const hop = (n: { bindingName: string; instanceName?: string }) =>
      n.instanceName === undefined ? n.bindingName : `${n.bindingName}/${n.instanceName}`;
    log.error(`${nodeTypeName}: fire-back transport to __handleResponse failed`, {
      error: transportError,
      to: hop(response.returnAddr),
      callChain: fireEnvelope.callContext.callChain.map(hop),
    });
    return;
  }
  if (ack && '$error' in ack) {
    let sinkErr: unknown = 'unknown';
    try { sinkErr = postprocess(ack.$error); } catch { /* keep default */ }
    log.error(`${nodeTypeName}: response leg rejected at the sink (scope gate or admission)`, { error: sinkErr });
  }
}

/**
 * Fill a result handler continuation with a call's outcome — the code every fire-back uses,
 * exported so a Client's server-side half, `ClientGateway`, which is no node and composes no mesh
 * core, fills a continuation the same way (ADR-007). `handler` arrives preprocessed and the filled
 * chain leaves preprocessed. A result that cannot be encoded is replaced by a `DataCloneError`
 * naming `callee`, so the handler still runs.
 *
 * @internal
 */
export function fillHandler(handler: any, outcome: unknown, callee: string): any {
  const handlerChain = postprocess(handler) as OperationChain;
  try {
    return preprocess(replaceNestedOperationMarkers(handlerChain, outcome));
  } catch (encodeError) {
    return preprocess(replaceNestedOperationMarkers(handlerChain, unencodableResult(outcome, callee, encodeError)));
  }
}

/**
 * Execute an incoming call envelope on a mesh node — the shared receive path for
 * `MeshDO` and `MeshWorker`, for BOTH RPC entries:
 * `__executeOperation` (requests, `requireMeshDecorator: true`) and `__handleResponse`
 * (fire-backs, `requireMeshDecorator: false`). `onBeforeCall` runs on **both** — the
 * response leg is scope-gated by construction — except at the fire-back door on a chain this node
 * started, whose answers carry no claims. The walk rules are unconditional; only the member-level
 * check toggles.
 *
 * **Early ack:** admission (version/callContext/identity/`onBeforeCall`) runs first
 * and returns `{ $ack: true }` the instant the callee is admitted — BEFORE the chain. The
 * chain + fire-back then run as a **detached task** (started eagerly, re-bound to the envelope's
 * `callContext` via `runWithCallContext` — a fresh scope, not a captured closure). `ctx.waitUntil`
 * holds the node for that tail: a `MeshWorker` at any compatibility date, a DO from 2026-10-01
 * for up to 15 minutes. Before that date it is a **no-op** on a DO, and a long detached chain can
 * be evicted mid-run (see the ADMITTED block).
 * An admission/guard failure returns `{ $error }` on the ack instead.
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
    /**
     * True when every chain arriving at this door has ALREADY been filled with a result — the
     * fire-back door, never the request door. Its final `apply` then carries data rather than a
     * template's arguments, so it is not scanned for nested markers.
     *
     * It also selects where `callee` comes from: the fire-back's last hop, the target that
     * answered, rather than this node's own identity.
     *
     * ⚠️ **Orthogonal to `requireMeshDecorator` in both directions, so it MUST NOT be folded into
     * it.** `alarms.ts` runs a never-substituted chain with that flag off, and a pre-filled chain
     * used to reach the request door, where it is on.
     */
    filled?: boolean;
    /** The node's `ctx.waitUntil`, which holds the node for the detached post-ack tail — a DO only
     * from compatibility date 2026-10-01 (see the ADMITTED block). */
    waitUntil?: (promise: Promise<any>) => void;
    /** The node's bindings — used to resolve the fire-back return-address stub. */
    env?: any;
    /** The node's own fire-back door, which takes the answer to a Client the node hosts in place. */
    handleResponseLocally?: (envelope: CallEnvelope) => Promise<any>;
    onValidationError?: (error: Error, details: Record<string, any>) => void;
  }
): Promise<{ $ack: true } | { $error: any }> {
  const nodeTypeName = options?.nodeTypeName ?? 'MeshNode';
  const includeInstanceName = options?.includeInstanceName ?? true;
  const requireMeshDecorator = options?.requireMeshDecorator ?? true;

  let callContext: CallContext;
  let operationChain: OperationChain;

  // --- ADMISSION (pre-ack). Every failure here rejects the EARLY ACK with { $error },
  //     which the dispatcher turns into a locally-run handler. ---
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
      }, 'envelope');
    }

    // Postprocess the chain (aliases/cycles, custom Error types).
    operationChain = postprocess(envelope.chain);
    // OVERWRITTEN unconditionally — whatever `callee` the envelope carried is DISCARDED, because the
    // value must come from a source the caller cannot write. At the request door that source is
    // this node itself. At the fire-back door it is the fire-back's last hop, which the answering
    // side's framework appended (`fireResponse`), so a result handler learns which target answered.
    callContext = {
      ...envelope.callContext,
      callee: options?.filled
        ? envelope.callContext.callChain.at(-1)
        : {
          type: node.lmz.type,
          bindingName: node.lmz.bindingName!,
          instanceName: node.lmz.instanceName,
        },
    };

    // onBeforeCall is the guard — it runs under the call context; a throw here rejects
    // admission (scope/auth). This is the scope gate on the response leg too, except on a chain
    // this node started: the answers to its own broadcasts and alarms come back on that chain,
    // which carries no claims, and a guard requiring them would refuse every one. Skipping costs
    // nothing, because the envelope's `callChain` is the sender's to write at either door, and
    // only code holding this node's binding can send one.
    // A first hop and a known binding are both required: an unstamped node and an empty chain would
    // otherwise compare `undefined` with `undefined` and skip the hook for a stranger. A Client's
    // chain never passes for one its host started: a hosted Client's instance name always contains
    // a `/`, `acme.crm.tenant1/alice.9f2c41aa`, and no node's does.
    const [origin] = callContext.callChain;
    const startedHere = options?.filled === true && origin !== undefined && node.lmz.bindingName !== undefined
      && origin.bindingName === node.lmz.bindingName && origin.instanceName === node.lmz.instanceName;
    // A scoped node's passage step runs first, keyed by a symbol private to Mesh, so a subclass that
    // overrides `onBeforeCall` without `super` cannot drop it.
    if (!startedHere) {
      runWithCallContext(callContext, () => {
        (node as { [PASSAGE_STEP]?: () => void })[PASSAGE_STEP]?.();
        node.onBeforeCall();
      });
    }
  } catch (error) {
    return { $error: preprocess(error) };
  }

  // --- ADMITTED. Run the chain + fire-back as a DETACHED, eagerly-started task, re-bound to
  //     the envelope callContext. The node's waitUntil (below) holds it — a DO/Container only
  //     from compatibility date 2026-10-01. ---
  const postAck = runWithCallContext(callContext, async () => {
    let outcome: unknown;
    let isError = false;
    try {
      const run = options?.filled ? executeFilledChain : executeOperationChain;
      outcome = await run(operationChain, node, { requireMeshDecorator });
    } catch (err) {
      outcome = err instanceof Error ? err : new Error(String(err));
      isError = true;
    }
    const answerer: NodeIdentity = {
      type: node.lmz.type,
      bindingName: node.lmz.bindingName!,
      instanceName: node.lmz.instanceName,
    };
    const handleResponseLocally = options?.handleResponseLocally;
    await fireResponse(
      answerer, options?.env, callContext, envelope.response, outcome, isError, nodeTypeName,
      describeCallee(node, operationChain),
      handleResponseLocally ? { lmz: node.lmz, __handleResponse: handleResponseLocally } : undefined,
    );
  }).catch((detachedError: unknown) => {
    // Defensive: fireResponse never rejects, but a bug there must not become an
    // unhandled rejection on the waitUntil promise.
    debug('lmz.mesh.lmzApi.executeEnvelope').error(`${nodeTypeName}: detached post-ack task failed`, { error: detachedError });
  });
  // Hold the node for the detached tail; postAck runs eagerly either way. An ephemeral
  // MeshWorker is held at any compatibility date. A DO/Container is held from 2026-10-01
  // (`durable_object_io_tasks_prevent_eviction`), for up to 15 minutes from the tail's start.
  // ⚠️ Before that date `waitUntil` is a no-op on a DO, and so, for a detached chain, is a pending
  // binding call or RPC, so a long chain with idle gaps — an agentic loop awaiting a model — can be
  // idle-evicted mid-run (durable-objects.md § Wall-clock billing). A chain that must outlive
  // 15 minutes needs an alarm or two one-way calls at any date.
  options?.waitUntil?.(postAck);

  return { $ack: true };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ComposedMeshDO — the shared DO-flavored mesh-composition mixin (ADR-007)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A constructor (abstract-tolerant) with unconstrained args — the mixin base bound. */
type AbstractConstructor<T = object> = abstract new (...args: any[]) => T;

/**
 * Mixin that composes the narrow comms+guards core (ADR-007) onto any DO-flavored base
 * (`DurableObject`, or a third-party base built on it). It supplies the receive glue: the lazy `lmz`
 * getter, the default no-op `onBeforeCall`, and the two receive seams
 * (`__executeOperation` / `__handleResponse`) that delegate to {@link executeEnvelope}.
 * `nodeTypeName` is the per-type label threaded through (debug namespaces + validation logging).
 * (`ctn()` deliberately stays per-class: its `Continuation<this>` return can't cross the mixin
 * boundary cleanly when a subclass concretizes an optional base method — e.g. `MeshDO.alarm`.)
 *
 * A **mixin**, not a free helper: the glue must read the base's **protected** `ctx`/`env` (to thread
 * `ctx.waitUntil` + the fire-back `env` into `executeEnvelope`), which only a subclass may. The
 * generic `TBase` can't surface those protected members to the mixin *body*, so they're read through
 * a narrow local cast; the *concrete* base type still flows through to subclasses, so a
 * subclass keeps its base's own members for `override`/`super`.
 *
 * Today `MeshDO`, the base `ScopedMeshDO` and `UnscopedMeshDO` share, is its one user; it stays a
 * mixin so a node on another DO base can compose the same core (ADR-007). Each node adds its à-la-carte
 * capabilities on top — `svc`/`onStart`/`__localChainExecutor` for `MeshDO`, hibernation WebSockets
 * for `ScopedMeshDO` — none of which are part of the shared invariant. Its fan-out is not among them:
 * `lmz.broadcast` is part of the core this mixin supplies.
 */
export function ComposedMeshDO<TBase extends AbstractConstructor>(Base: TBase, nodeTypeName: string) {
  abstract class MeshComposed extends Base {
    #lmzApi: LmzApi | null = null;

    /**
     * Lumenize identity + RPC infrastructure — the members of {@link LmzApi}: identity,
     * `callContext`, `call`, and `broadcast` built on it. Composed via the shared DO factory, never
     * reimplemented; identity is read from DO storage (set by `routeDORequest` headers or envelope
     * metadata on the first incoming call).
     */
    get lmz(): LmzApi {
      if (!this.#lmzApi) {
        // Base exposes ctx/env PROTECTED — invisible to a generic TBase; read via a narrow cast.
        const base = this as unknown as { ctx: DurableObjectState; env: any };
        this.#lmzApi = createLmzApiForDO(base.ctx, base.env, this);
      }
      return this.#lmzApi;
    }

    /**
     * Hook run at admission, before each incoming mesh call executes (inside `executeEnvelope`, on
     * BOTH receive entries incl. the response leg, but not on the answers to a chain this node
     * started). Override for auth/scope guards — reject by throwing; call `super.onBeforeCall()`
     * if a parent adds logic. Does NOT run on the `fetch()` path (by design). Default: no-op.
     */
    onBeforeCall(): void {
      // Default: no-op. Subclasses override for authentication/authorization.
    }

    /**
     * Request seam a remote `lmz.call` dispatches to: acks early, then runs the chain + fire-back
     * under `ctx.waitUntil` via the shared `executeEnvelope`. @internal
     */
    async __executeOperation(envelope: CallEnvelope): Promise<any> {
      const hosted = this.#forHostedClient(envelope);
      if (hosted) return hosted === 'refused' ? this.#refuseClientAddress(envelope) : await hosted.executeOperation(envelope);
      const base = this as unknown as { ctx: DurableObjectState; env: any };
      return await executeEnvelope(envelope, this, {
        nodeTypeName,
        includeInstanceName: true,
        waitUntil: (p) => base.ctx.waitUntil(p),
        env: base.env,
        handleResponseLocally: (e) => this.__handleResponse(e),
        onValidationError: (error, details) => {
          debug(`lmz.mesh.${nodeTypeName}.__executeOperation`).error(error.message.split('.')[0], { ...details, error });
        },
      });
    }

    /**
     * The server-side half of the Clients this node hosts, or `undefined` for a node that hosts
     * none. A node that hosts Clients composes a `ClientGateway` and returns it here; both doors
     * hand it every message addressed to one of them (ADR-007's "Hosting a Client adds no mode").
     * @internal
     */
    get __clientGateway(): ClientGateway | undefined {
      return undefined;
    }

    /**
     * Where a message addressed to a Client goes: this node's `ClientGateway`, or `'refused'` when
     * the node hosts none. `undefined` for a message addressed to a node. It reads only the `/` in
     * `metadata.callee`, never this node's stamped name, which a teardown's `deleteAll()` can have
     * erased, and it runs before `executeEnvelope` stamps an identity, so a Client's address never
     * becomes a node's name.
     */
    #forHostedClient(envelope: CallEnvelope): ClientGateway | 'refused' | undefined {
      if (!isClientInstanceName(envelope?.metadata?.callee?.instanceName)) return undefined;
      return this.__clientGateway ?? 'refused';
    }

    #refuseClientAddress(envelope: CallEnvelope): { $error: any } {
      const callee = envelope.metadata!.callee;
      return { $error: preprocess(new Error(
        `${callee.bindingName}/${callee.instanceName} names a Client, and this ${nodeTypeName} hosts no Clients`,
      )) };
    }

    /**
     * The one entry `rawRpcStub` calls (ADR-023): our own code reaching this node for an operation
     * no client may call. It is reached by Workers RPC on the binding, which exists only in our
     * Worker's `env`, so it runs no `onBeforeCall` and checks no claims — the decision it carries
     * out was made where claims were checked.
     *
     * Before anything else it checks that `bindingName`/`instanceName` name THIS object — their
     * `idFromName` must equal `ctx.id` — so a caller cannot stamp a wrong identity. It then refuses
     * any name `@rawRpc()` did not decorate, looking up one name and never a path or a getter,
     * stamps the identity exactly as the mesh path does, and invokes the method.
     * @internal
     */
    async __rawRpc(bindingName: string, instanceName: string, method: string, args: unknown[]): Promise<unknown> {
      const base = this as unknown as { ctx: DurableObjectState; env: any };
      const namespace = typeof bindingName === 'string' ? base.env?.[bindingName] : undefined;
      if (typeof namespace?.idFromName !== 'function' || typeof instanceName !== 'string'
        || !namespace.idFromName(instanceName).equals(base.ctx.id)) {
        throw new Error(`rawRpc: ${String(bindingName)}/${String(instanceName)} does not name this Durable Object`);
      }
      const fn = findRawRpcMethod(this, method);
      if (!fn) throw new Error(`rawRpc: '${String(method)}' is not @rawRpc()-decorated on ${nodeTypeName}`);
      this.lmz.__init({ bindingName, instanceName });
      return await fn.apply(this, Array.isArray(args) ? args : []);
    }

    /**
     * Fire-back seam: the caller's traveling handler, filled with a result/Error. Same
     * `executeEnvelope` path with `requireMeshDecorator: false` — `onBeforeCall` still runs, only the
     * member-level check is skipped (the handler is the caller's own continuation). The walk rules
     * still apply. @internal
     */
    async __handleResponse(envelope: CallEnvelope): Promise<any> {
      // An answer for a Client this node hosts goes down its socket and never runs here.
      const hosted = this.#forHostedClient(envelope);
      if (hosted) return hosted === 'refused' ? this.#refuseClientAddress(envelope) : await hosted.receiveFireBack(envelope);
      const base = this as unknown as { ctx: DurableObjectState; env: any };
      return await executeEnvelope(envelope, this, {
        nodeTypeName,
        includeInstanceName: true,
        requireMeshDecorator: false,
        handleResponseLocally: (e) => this.__handleResponse(e),
        // Every chain that arrives here was filled by the callee's `fireResponse`, so its last
        // apply is a result rather than a template's arguments.
        filled: true,
        waitUntil: (p) => base.ctx.waitUntil(p),
        env: base.env,
        onValidationError: (error, details) => {
          debug(`lmz.mesh.${nodeTypeName}.__handleResponse`).error(error.message.split('.')[0], { ...details, error });
        },
      });
    }
  }
  return MeshComposed;
}

