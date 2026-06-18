import { Container } from '@cloudflare/containers';
import {
  newContinuation,
  executeOperationChain,
  type OperationChain,
  type Continuation,
} from './ocan/index.js';
import { createLmzApiForDO, executeEnvelope, type LmzApi, type CallEnvelope } from './lmz-api.js';
import { ClientDisconnectedError } from './lumenize-client-gateway.js';

// Register ClientDisconnectedError on globalThis so a container node can
// deserialize it from Gateway-originated structured-clone errors — mirrors
// LumenizeDO/LumenizeWorker, which register the same symbol for the same reason.
(globalThis as any).ClientDisconnectedError = ClientDisconnectedError;

/**
 * The header the base `Container.fetch()` honors to route to a named port
 * (`@cloudflare/containers` container.js:990). A public request carrying this
 * would otherwise reach ANY port — including the agent command port.
 * @internal
 */
const CONTAINER_TARGET_PORT_HEADER = 'cf-container-target-port';

/**
 * Return `request` with any inbound `cf-container-target-port` header removed.
 *
 * The base `Container.fetch()` reads this header and forwards to whatever port
 * it names; absent the header it falls back to `defaultPort`. Stripping it on
 * the public surface guarantees a browser request can only reach the preview
 * port (`defaultPort`), never the command port that DevContainer reaches
 * exclusively via its internal `containerFetch(req, <cmd-port>)`. The command
 * port must also never appear in a publicly-reachable `defaultPort`/
 * `requiredPorts`. See tasks/nebula-devcontainer-node-type.md § M1.
 *
 * Pure + synchronous so the pin is unit-testable without a live container.
 * @internal
 */
export function stripContainerTargetPort(request: Request): Request {
  if (!request.headers.has(CONTAINER_TARGET_PORT_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(CONTAINER_TARGET_PORT_HEADER);
  return new Request(request, { headers });
}

/**
 * `LumenizeContainer` — the 4th Lumenize node type: a `@cloudflare/containers`
 * `Container` that is also a first-class mesh node.
 *
 * It exists because the Studio dev preview fronts a vite **container** (its
 * reason for being), yet to talk to the rest of Nebula it must speak Mesh. It
 * therefore **composes** the narrow comms+guards core (ADR-007) onto the
 * `Container` base — it cannot, and should not, inherit `LumenizeDO`. The DO
 * ancestry (via `Container extends DurableObject`) is incidental.
 *
 * ## Composition recipe (how the core sits on a non-`LumenizeDO` base)
 * Six members, each delegating to the same shared building blocks `LumenizeDO`/
 * `LumenizeWorker` use — never reimplemented:
 *  - lazy `lmz` getter → `createLmzApiForDO(this.ctx, this.env, this)` — gives
 *    identity (`__init`/`bindingName`/`instanceName`), `callContext` (the
 *    ALS-bound getter), and `call`/`callRaw` for free.
 *  - `onBeforeCall()` — no-op here; subclasses override for auth/scope guards.
 *  - `__executeChain` → `executeOperationChain(chain, this)` — the SECURE path
 *    (`requireMeshDecorator` defaults true; only `@mesh` methods are callable).
 *  - `__localChainExecutor` — the bypass executor, for the result-handler path
 *    ONLY (never wired onto inbound dispatch).
 *  - `__executeOperation(envelope)` → `executeEnvelope(…, { includeInstanceName:
 *    true })` — the DO-flavored receive seam `lmz.call` dispatches to.
 *  - `ctn()` — continuation factory.
 *
 * Identity persists in `ctx.storage.kv` (`__lmz_do_*`), so the class MUST be
 * registered with `new_sqlite_classes` (Container storage is SQLite-backed).
 *
 * ## What this node does NOT take from the core (per-node-type, per ADR-007)
 *  - **No constructor body, no `onStart` override.** `Container`'s constructor
 *    runs its own lifecycle setup inside `blockConcurrencyWhile` and owns
 *    `onStart`; identity composes purely through the lazy `lmz` getter, so
 *    `__lmz_do_*` writes land on the first inbound mesh call, after the base
 *    lifecycle is up.
 *  - **`alarm`/`onStart` are owned by `Container`** (live + load-bearing for
 *    container lifecycle) and left untouched here — never `svc.alarms` on this
 *    node type; route any future alarm need through `Container.schedule()`.
 *  - **Reserved storage names** (never reuse): kv keys `__CF_CONTAINER_STATE`,
 *    `OUTBOUND_CONFIGURATION`; SQL table `container_schedules`; the alarm slot.
 *
 * ## Egress + public-surface posture
 *  - `enableInternet = false` (the base defaults it to `true` = open outbound) —
 *    a safe default for a node fronting npm traffic and, later, agent-authored
 *    code. Open it only via an explicit `allowedHosts` allow-list or the
 *    `EgressBroker`/`globalOutbound` choke point.
 *  - `fetch()` is overridden to strip the inbound `cf-container-target-port`
 *    header and pin the public surface to `defaultPort` — the base honors that
 *    header and would forward to the command port otherwise (M1).
 *
 * `onBeforeCall` runs ONLY on the mesh path (inside `executeEnvelope`); it does
 * NOT cover `fetch()`/`containerFetch`. That is by design — `fetch()` serves
 * only the public preview shell, exactly like DevStar's intentionally-open
 * `onRequest`. All tenant data + the agent command channel travel over the mesh.
 *
 * Exported only via `@lumenize/mesh/container` so core `@lumenize/mesh` stays
 * free of the `@cloudflare/containers` dependency.
 *
 * @see tasks/nebula-devcontainer-node-type.md — full design + decisions
 * @see docs/adr/007-shared-node-security-core.md — the comms+guards invariant
 */
export class LumenizeContainer<Env = any> extends Container<Env> {
  #lmzApi: LmzApi | null = null;

  /**
   * Pin outbound internet OFF (the base defaults to `true`). SSRF/exfil-safe
   * default for a node that fronts a vite container and ultimately runs
   * agent-authored code. Override deliberately (allow-list / EgressBroker).
   */
  override enableInternet = false;

  /**
   * Lumenize identity + RPC infrastructure (`bindingName`, `instanceName`,
   * `callContext`, `call`, `callRaw`, `__init`). Composed — not reimplemented —
   * via the shared DO factory; identity persists in `ctx.storage.kv`.
   */
  get lmz(): LmzApi {
    if (!this.#lmzApi) {
      this.#lmzApi = createLmzApiForDO(this.ctx, this.env, this);
    }
    return this.#lmzApi;
  }

  ctn(): Continuation<this>;
  ctn<T>(): Continuation<T>;
  ctn(): Continuation<unknown> {
    return newContinuation() as Continuation<unknown>;
  }

  /**
   * Hook run before each incoming mesh call executes (inside `executeEnvelope`,
   * within the call context). Override for auth/scope guards. Default: no-op.
   * Does NOT run on the `fetch()`/`containerFetch` path (by design).
   */
  onBeforeCall(): void {
    // Default: no-op. Subclasses (e.g. NebulaContainer) override for tenant scope.
  }

  /**
   * Execute an incoming OCAN chain on this node. Always enforces the `@mesh`
   * decorator (secure by default) — the bypass executor below is for local
   * result-handler dispatch only and must never be wired onto inbound calls.
   * @internal Called by `executeEnvelope`/`lmz.call`, not for direct use.
   */
  async __executeChain(chain: OperationChain): Promise<any> {
    return await executeOperationChain(chain, this);
  }

  /**
   * Local chain executor for trusted internal code (`lmz.call` result handlers).
   * Can bypass the `@mesh` check, but doesn't serialize over RPC, so it's
   * unreachable remotely. @internal
   */
  get __localChainExecutor(): (chain: OperationChain, options?: { requireMeshDecorator?: boolean }) => Promise<any> {
    return (chain, options) => executeOperationChain(chain, this, options);
  }

  /**
   * Receive + execute an RPC call envelope, auto-initializing identity from
   * `metadata.callee`. The DO-flavored seam (`includeInstanceName: true`) —
   * identical to `LumenizeDO`'s. @internal Called by `lmz.callRaw`.
   */
  async __executeOperation(envelope: CallEnvelope): Promise<any> {
    return await executeEnvelope(envelope, this, {
      nodeTypeName: 'LumenizeContainer',
      includeInstanceName: true,
    });
  }

  /**
   * Public preview surface. The base `Container.fetch()` honors an inbound
   * `cf-container-target-port` header and forwards to ANY port — including the
   * command port. Strip it so a public request can only reach `defaultPort`
   * (M1). `onBeforeCall` does not run here; serve only the public shell.
   */
  override fetch(request: Request): Promise<Response> {
    return super.fetch(stripContainerTargetPort(request));
  }
}
