import { Container } from '@cloudflare/containers';
import { newContinuation, type Continuation } from './ocan/index.js';
import { ComposedMeshDO, initIdentityFromHeaders } from './lmz-api.js';
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
 * `Container` base via the shared {@link ComposedMeshDO} mixin — it cannot, and
 * should not, inherit `LumenizeDO`. The DO ancestry (via `Container extends
 * DurableObject`) is incidental.
 *
 * ## Composition (how the core sits on a non-`LumenizeDO` base)
 * `extends ComposedMeshDO(Container, 'LumenizeContainer')` supplies the receive
 * glue shared with `LumenizeDO` — the lazy `lmz` getter, `ctn()`, the default
 * `onBeforeCall`, and the `__executeOperation`/`__handleResponse` seams — never
 * reimplemented. This class adds only the container-specific pieces below. (No
 * `__localChainExecutor` — this node has no alarms/fetch consumer for it.)
 *
 * Identity persists in `ctx.storage.kv` (`__lmz_do_*`), so the class MUST be
 * registered in `exports` with `storage: "sqlite"` (Container storage is SQLite-backed).
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
export class LumenizeContainer<Env = any> extends ComposedMeshDO(Container, 'LumenizeContainer') {
  /**
   * Pin outbound internet OFF (the base defaults to `true`). SSRF/exfil-safe
   * default for a node that fronts a vite container and ultimately runs
   * agent-authored code. Override deliberately (allow-list / EgressBroker).
   */
  override enableInternet = false;

  // `ctn()` stays per-class (not on ComposedMeshDO) — its `Continuation<this>` return can't cross
  // the mixin boundary cleanly (see the ComposedMeshDO doc). It's a trivial 3-line stanza.
  ctn(): Continuation<this>;
  ctn<T>(): Continuation<T>;
  ctn(): Continuation<unknown> {
    return newContinuation() as Continuation<unknown>;
  }

  /**
   * Public preview surface. Two things before delegating to the base proxy:
   *  1. **Stamp identity from the routed headers** (`routeDORequest` sets
   *     `x-lumenize-do-*` before routing here) so `this.lmz.instanceName` is valid
   *     on the fetch() path — the mesh path stamps via envelope metadata, but a
   *     cold public GET (the normal browser navigation) never hits it, so any
   *     server-derived value (e.g. a subclass injecting `activeScope` into a
   *     served shell) would otherwise be empty. Mirrors `LumenizeDO.fetch()`;
   *     composes the shared `initIdentityFromHeaders` (ADR-007 identity-on-every-
   *     entry-path). A 64-hex id / binding-mismatch surfaces as a 400/500 here.
   *  2. **Strip `cf-container-target-port`** — the base `Container.fetch()` honors
   *     that header and forwards to ANY port (incl. the command port); stripping
   *     it pins the public surface to `defaultPort` (M1).
   * `onBeforeCall` does not run here; serve only the public shell.
   */
  override async fetch(request: Request): Promise<Response> {
    const initError = initIdentityFromHeaders(request.headers, this.lmz, 'LumenizeContainer');
    if (initError) return initError;
    return super.fetch(stripContainerTargetPort(request));
  }
}
