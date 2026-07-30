/**
 * Impersonation — an admin's client producing a working client that acts as another person.
 *
 * **Everything this feature knows lives here.** `NebulaClient` gets exactly TWO touchpoints: the
 * internal construction seam — {@link INTERNAL_REFRESH} plus its companion {@link INTERNAL_PARENT},
 * two symbols but one seam, both read in the same constructor — and one teardown hook, reached from
 * the three end-of-session doors (`dispose()`, `logout()`, `[Symbol.dispose]()`). ⚠️ Deliberately NOT
 * `disconnect()`, which those doors route through but which application code also calls to pause a
 * connection reversibly. The only reason a `NebulaClient` would otherwise know `/mint-narrower-token`
 * exists is this feature, so the endpoint's URL, its body shape, its error mapping, the child's
 * naming rule, the chain refusal and the parent↔child registry are all here rather than smeared
 * across the client.
 *
 * ⚠️ **Node/browser-safe on purpose.** This module is reachable from `nebula-client.ts`, which must
 * stay importable from Node and from the Studio bundle, so it must never import
 * `@lumenize/nebula-auth`'s main barrel (that re-exports a `DurableObject` → `cloudflare:workers`).
 * Types only, from the `/client` subpath — same rule the client's own header states.
 *
 * @see tasks/nebula-impersonation-client.md
 */
import { debug } from '@lumenize/debug';

/** What a caller may tune about the minted token. */
export interface ImpersonateOptions {
  /**
   * Requested lifetime of the impersonated token, in seconds. Clamped server-side to the access-token
   * ceiling — it can only ever SHORTEN — and replayed on every re-mint, so it sets the cadence of the
   * whole session rather than just the first token.
   *
   * ⚠️ **Below ~120s the session re-mints continuously.** The client refreshes when a token is within
   * 30s of expiry, so anything at or under that window is *born* already due; 120s is 4× the window,
   * which leaves most of a token's life outside it.
   *
   * ⚠️ **A shorter TTL does NOT shorten the caller-side revocation window**, which is the tempting
   * misreading. Each re-mint re-runs the endpoint's gate chain, but that chain reads the CALLER's
   * token for caller-side authority and the registry only for the subject — so a moved or deleted
   * *subject* ends the session at the next re-mint, while a demoted *admin* stays bounded by their
   * own token's lifetime plus KV propagation no matter how short this value is.
   */
  ttlSeconds?: number;
}

/**
 * The construction seam. A client built through this symbol supplies its own `refresh` instead of
 * the cookie one — reachable from `NebulaClient.impersonate()`, unreachable from
 * `NebulaClientConfig`, which is what keeps a caller from ever building a client whose token and
 * `authScope` disagree.
 *
 * Deliberately NOT exported from the package barrel: a relative import inside `apps/nebula` only.
 */
export const INTERNAL_REFRESH = Symbol('lumenize.nebula.impersonation.refresh');

/** Companion seam: hands the child its parent, for the post-construction users only. */
export const INTERNAL_PARENT = Symbol('lumenize.nebula.impersonation.parent');

/** Exactly the parent config a child inherits. Named so the contract is a type, not a convention. */
export interface ChildConfigBase {
  baseUrl?: string;
  appVersion: string;
  fetch?: typeof fetch;
  WebSocket?: unknown;
  sessionStorage?: unknown;
  BroadcastChannel?: unknown;
  resourceHostBinding: string;
}

/** The `refresh` shape `LumenizeClient` expects. */
export type RefreshFn = () => Promise<{ access_token: string; sub: string }>;

/** Thrown when `impersonate()` is called on a client that is already impersonating. */
export class ImpersonationChainError extends Error {
  name = 'ImpersonationChainError';
}

/** Thrown when the endpoint refuses a mint — carries the endpoint's own status and message. */
export class ImpersonationMintError extends Error {
  name = 'ImpersonationMintError';
  readonly status: number;
  /** True when retrying cannot help: the gate chain now refuses this pairing. */
  readonly terminal: boolean;
  constructor(status: number, message: string, terminal?: boolean) {
    super(message);
    this.status = status;
    // 4xx is terminal, 5xx and network failures are transient. Stated STRUCTURALLY rather than as a
    // status list so a status the endpoint gains later inherits the right behaviour instead of
    // falling into whichever default this happened to pick.
    //
    // ⚠️ The explicit override exists for failures that never had an HTTP status at all — chiefly
    // the torn-down-parent latch, which is terminal BY CONSTRUCTION (the session it would re-mint
    // through is over). Leaving that to the structural rule would classify it transient, and mesh
    // would then reconnect-loop the child forever on the one signal that can never succeed.
    this.terminal = terminal ?? (status >= 400 && status < 500);
  }
}

/**
 * Refuse to chain. Decidable with certainty from the caller's own claims, and enforced
 * independently by the endpoint's root-identity gate — this exists to turn a structurally
 * impossible call into an accurate message rather than a 403 that reads as a problem with the
 * subject.
 *
 * ⚠️ `claims` is genuinely nullable on the base client (`NebulaClient` only re-types it non-null),
 * so the caller must pass it as possibly-absent and this must not assume otherwise.
 */
export function assertCanImpersonate(claims: { act?: unknown } | null | undefined): void {
  if (claims?.act) {
    throw new ImpersonationChainError(
      'Impersonation does not chain: this client is already acting as someone else. ' +
      'Call impersonate() on the original (non-impersonated) client instead.',
    );
  }
}

/**
 * The child's Gateway DO name.
 *
 * ⚠️ **DETERMINISTIC, never random, because a DO name reservation is PERMANENT** — it cannot be
 * deleted, by us or from the dashboard, so a random suffix would reserve a fresh Gateway name on
 * every call, forever. Determinism also means a reload with the same tab, subject and scope reuses
 * one name. (`packages/mesh/src/tab-id.ts`'s header carries the general rule.)
 *
 * ⚠️ **The SEGMENT ORDER is load-bearing, not stylistic.** `LumenizeClientGateway.onBeforeAccept`
 * rejects a name with no `.`, then requires the text before the FIRST `.` to equal the `sub` of the
 * verified JWT. So the subject's `sub` must come first; this works only because a surrogate `sub` is
 * a dotless UUID. Put the tabId or the scope first and the Gateway answers 403 "identity mismatch",
 * which reads as a token problem and sends a debugger in entirely the wrong direction.
 *
 * The scope's dots become dashes for readability only — everything after the first `.` is free.
 */
export function childInstanceName(subjectSub: string, parentTabId: string, activeScope: string): string {
  return `${subjectSub}.${parentTabId}.${activeScope.replace(/\./g, '-')}`;
}

/**
 * The parent's tabId, parsed off its `instanceName` — there is no accessor for it anywhere. It
 * exists only as a local inside `LumenizeClient#connectInternal`, embedded into the name as
 * `${sub}.${tabId}`.
 *
 * ⚠️ The caller must read `parent.lmz.instanceName` (the only reachable route, since `#instanceName`
 * is private) and that getter THROWS while unset — i.e. until the parent has connected once or was
 * constructed with an explicit name. That precondition is real and deliberate: a never-connected
 * parent cannot produce a child.
 */
export function parentTabIdFrom(parentInstanceName: string): string {
  const firstDot = parentInstanceName.indexOf('.');
  if (firstDot === -1) {
    throw new Error(
      `Cannot derive a child name: parent instanceName "${parentInstanceName}" is not "\${sub}.\${tabId}"`,
    );
  }
  return parentInstanceName.slice(firstDot + 1);
}

/**
 * Mint a narrower token through the parent's authenticated transport.
 *
 * **One mint path**, used for the first mint AND every re-mint, so the two can never drift on body
 * shape, URL or error handling — and so the child depends on the parent's *capability to mint*
 * rather than on how the parent talks to the endpoint.
 *
 * `authedFetch` is the parent's, passed in bound: it is `protected` on `LumenizeClient`, which stops
 * a free function from *calling* it, not from *receiving* it. It also refreshes the parent's own
 * token first when needed, which is why a parent holding an expired token can still mint.
 */
export async function mintNarrowerToken(
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>,
  baseUrl: string,
  callerScope: string,
  body: { subOfNarrowerToken: string; activeScope: string; ttlSeconds?: number },
): Promise<{ access_token: string; sub: string }> {
  const res = await authedFetch(`${baseUrl}/auth/${callerScope}/mint-narrower-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let description = text;
    try { description = (JSON.parse(text) as { error_description?: string }).error_description ?? text; }
    catch { /* not JSON — use the raw text */ }
    const err = new ImpersonationMintError(res.status, `mint-narrower-token ${res.status}: ${description}`);
    // Two 4xx are STRUCTURALLY IMPOSSIBLE on a re-mint: the chaining refusal and self-narrow both
    // depend on the parent, which has not changed since the first mint succeeded. They stay terminal
    // — no special case in the predicate — but reaching one means the mint path is broken rather
    // than authority having changed, and the child otherwise just quietly dies.
    // ⚠️ Match on "root identity" ONLY. A bare /act/ would false-positive: several 403s interpolate
    // the requested scope into their message, and a perfectly ordinary scope (`u.app.contact`)
    // contains those letters — which would warn "the mint path is broken" at a routine refusal.
    if (res.status === 400 || (res.status === 403 && /root identity/i.test(description))) {
      debug('nebula.impersonation.impossible').warn(
        'A mint failed in a way that should be unreachable once the first mint succeeded — ' +
        'this is a defect in the mint path, not a revoked authority', {
          status: res.status, description, subOfNarrowerToken: body.subOfNarrowerToken,
        });
    }
    throw err;
  }
  return await res.json() as { access_token: string; sub: string };
}

// ── the parent → children registry ───────────────────────────────────────────────────────────────
//
// Keyed BY PARENT, with a strong iterable Set of children inside.
//
// ⚠️ Not the `WeakSet`/`WeakRef`-of-children the design rejected: that could not be iterated (so the
// cascade could not be written at all) and traded determinism for GC timing in a mechanism chosen
// *for* determinism. Keying by parent has neither problem — the Set is ordinary and iterable, and
// the WeakMap entry simply disappears with a parent nobody references.

const CHILDREN = new WeakMap<object, Set<object>>();

export function registerChild(parent: object, child: object): void {
  let set = CHILDREN.get(parent);
  if (!set) { set = new Set(); CHILDREN.set(parent, set); }
  set.add(child);
}

export function deregisterChild(parent: object, child: object): void {
  CHILDREN.get(parent)?.delete(child);
}

/** The parent's live children, as a snapshot — safe to iterate while children deregister. */
export function childrenOf(parent: object): object[] {
  return [...(CHILDREN.get(parent) ?? [])];
}

/** Test/diagnostic view: how many children a parent currently holds. */
export function childCount(parent: object): number {
  return CHILDREN.get(parent)?.size ?? 0;
}

// ── teardown ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Clients whose session has been deliberately ended, and which may therefore no longer mint.
 *
 * ⚠️ **This is NEW STATE, not a consequence of disposal, and that is the whole point.** No teardown
 * door revokes minting on its own: `dispose()` is engine-teardown plus `disconnect()`,
 * `[Symbol.dispose]()` is just `disconnect()`, and `disconnect()` deliberately KEEPS the token so a
 * reconnect succeeds — while `authedFetch` needs only a `fetch` and a token, no connection. Without
 * this latch a disposed parent keeps minting for its full remaining token life, and "ending my
 * session ends impersonation" would be true only by timing.
 */
const TORN_DOWN = new WeakSet<object>();

export function isTornDown(client: object): boolean {
  return TORN_DOWN.has(client);
}

/**
 * The single teardown hook. Called from `NebulaClient.disconnect()` — which is **touchpoint 2 of 2**
 * and is one site rather than three, because every teardown door routes through it: `dispose()`
 * calls it, `logout()` calls it, and `[Symbol.dispose]()` *is* it.
 *
 * ⚠️ **`logout()` is NOT exempt from the marking**, though it looks like it closes minting already.
 * `clearAccessToken()` does not close minting — it makes the next mint REFRESH first, since a
 * missing token sets `#needsTokenRefresh()` true and `authedFetch` refreshes before every request.
 * And `logout()`'s revoke is explicitly best-effort with a swallowed catch, so an offline or 5xx
 * logout never clears the cookie and the parent could keep minting for the **30-day cookie life**,
 * not one token lifetime.
 *
 * ⚠️ **Nothing here may fire on a transient disconnect.** A blip goes `#handleClose` →
 * `#scheduleReconnect()` → `'reconnecting'`; it never calls `disconnect()` and never reaches
 * `'disconnected'`. Hooking a connection-STATE transition instead of this seam would silently end an
 * admin's impersonation session on a network blip.
 */
export function onClientTornDown(
  client: { disconnect(): void },
  parent: { disconnect(): void } | undefined,
): void {
  TORN_DOWN.add(client);
  for (const child of childrenOf(client)) {
    // Mark the child too: its own `disconnect()` is REVERSIBLE and therefore carries no teardown,
    // so without this a caller could `child.connect()` its way back into a session whose parent has
    // ended. The parent's latch already refuses the re-mint, but marking the child makes the end of
    // the session a property of the child as well, not only of what it can obtain.
    TORN_DOWN.add(child);
    (child as { disconnect(): void }).disconnect();
  }
  // The whole set goes with the parent. ⚠️ Deregistration cannot ride the child's `disconnect()` any
  // more — that is a reversible pause, not an end-of-session — so the parent clears it here.
  CHILDREN.delete(client);
  if (parent) deregisterChild(parent, client);
}
