/**
 * Impersonation — an admin's client producing a working client that acts as another person.
 *
 * **Everything this feature knows lives here.** `NebulaClient` gets exactly TWO touchpoints: the
 * internal construction seam — {@link INTERNAL_REFRESH} plus its companion {@link INTERNAL_PARENT},
 * two symbols but one seam, both read in the same constructor — and one teardown hook, reached from
 * the three end-of-session doors (`dispose()`, `logout()`, `[Symbol.dispose]()`). ⚠️ Deliberately NOT
 * `disconnect()`, which those doors route through but which application code also calls to pause a
 * connection reversibly. The only reason a `NebulaClient` would otherwise know the facade's
 * `impersonate` exists is this feature, so the mint's error mapping, the child's naming rule, the
 * chain refusal and the parent↔child registry are all here rather than smeared across the client.
 * The call itself is built in `NebulaClient.impersonate()`, which alone holds the parent's `ctn`.
 *
 * ⚠️ **Node/browser-safe on purpose.** This module is reachable from `nebula-client.ts`, which must
 * stay importable from Node and from the Studio bundle, so it must never import
 * `@lumenize/mesh/auth`'s main barrel (that re-exports a `DurableObject` → `cloudflare:workers`).
 * Its one value import is `@lumenize/mesh/client`, the pure subpath, for the refusal test.
 *
 * @see tasks/archive/nebula-impersonation-client.md
 */
import { debug } from '@lumenize/debug';
import { isImpersonationRefused } from '@lumenize/mesh/client';

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
   * misreading. Each re-mint re-runs the mint's gate chain, but that chain reads the CALLER's
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
  /** Inherited only to satisfy the config's shape: a child renews through its parent, never here. */
  platformOrigin: string;
  /** Absent when the parent holds none — an app with no applied ontology still runs. */
  ontologyVersion?: string;
  fetch?: typeof fetch;
  WebSocket?: unknown;
  sessionStorage?: unknown;
  BroadcastChannel?: unknown;
  resourceHostBinding: string;
  /** Inherited so a child abandons an unacknowledged subscribe on the same schedule its parent does;
   *  a child left on the default would outwait a test that deliberately shortened the parent's. */
  subscribeTimeoutMs?: number;
}

/** The `refresh` shape `LumenizeClient` expects. */
export type RefreshFn = () => Promise<{ access_token: string; sub: string }>;

/** Thrown when `impersonate()` is called on a client that is already impersonating. */
export class ImpersonationChainError extends Error {
  name = 'ImpersonationChainError';
}

/**
 * Thrown when `impersonate()` names a subject this tab is already impersonating. The two children
 * would share one id, and their host node would replace one socket with the other.
 */
export class ImpersonationAlreadyOpenError extends Error {
  name = 'ImpersonationAlreadyOpenError';
}

/**
 * Thrown when a mint fails for good: the facade refused it, or the client it would mint through has
 * been torn down. Retrying cannot help either way, so a child that meets one ends. A transport
 * failure — a timeout, a disconnect — is never wrapped in one, and stays transient.
 */
export class ImpersonationMintError extends Error {
  name = 'ImpersonationMintError';
}

/**
 * Refuse to chain. Decidable with certainty from the caller's own claims, and enforced
 * independently by the mint's root-identity gate — this exists to turn a structurally impossible
 * call into an accurate message rather than a refusal that reads as a problem with the subject.
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
 * The child's id, under which its host node holds its socket.
 *
 * ⚠️ **DETERMINISTIC, never random.** A reload of one tab impersonating one subject on one scope
 * comes back under the same id, so its new socket replaces the old one instead of sitting beside
 * it, and `impersonate()` refuses a second open child of the same subject because the two would
 * share it.
 *
 * ⚠️ **The SEGMENT ORDER is load-bearing, not stylistic.** The Worker refuses an upgrade whose id
 * does not begin with the token's `sub` and a `.`, and the child's token is the subject's. So the
 * subject's `sub` must come first; this works only because a surrogate `sub` is a dotless UUID. Put
 * the tabId or the scope first and the upgrade answers 403 "identity mismatch", which reads as a
 * token problem and sends a debugger in entirely the wrong direction.
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
 * Mint through the parent's `impersonate` call on the facade, turning its typed refusal into an
 * {@link ImpersonationMintError}.
 *
 * **One mint path**, used for the first mint AND every re-mint, so the two cannot drift on error
 * handling — and so the child depends on the parent's *capability to mint* rather than on how the
 * parent talks to the facade. The parent's `callAsync` rides its own token, refreshing it first when
 * needed, which is why a parent holding an expired token can still mint, and waits out a paused
 * parent's reconnect, which is why a paused parent's child survives (`disconnect()` is a pause).
 *
 * ⚠️ **Only the facade's typed refusal is terminal.** Every other rejection — a `TimeoutError` after
 * 30 s, *LumenizeClient disconnected before the callAsync result arrived*, a `QuotaExceededError` —
 * is transport, and rethrown as-is so the child's reconnect loop retries it.
 */
export async function mintImpersonation(
  call: () => Promise<{ access_token: string }>, sub: string,
): Promise<{ access_token: string; sub: string }> {
  try {
    const { access_token } = await call();
    return { access_token, sub };
  } catch (e) {
    if (!isImpersonationRefused(e)) throw e;
    const message = (e as Error).message;
    // Two refusals are STRUCTURALLY IMPOSSIBLE on a re-mint: the chaining refusal and self-narrow
    // both depend on the parent, which has not changed since the first mint succeeded. They stay
    // terminal, but reaching one means the mint path is broken rather than authority having changed,
    // and the child otherwise just quietly dies.
    if (/root identity|different sub/i.test(message)) {
      debug('nebula.impersonation.impossible').warn(
        'A mint failed in a way that should be unreachable once the first mint succeeded — ' +
        'this is a defect in the mint path, not a revoked authority', { message, subOfNarrowerToken: sub });
    }
    throw new ImpersonationMintError(message);
  }
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

// ── teardown ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Clients whose session has been deliberately ended, and which may therefore no longer mint.
 *
 * ⚠️ **This is NEW STATE, not a consequence of disposal, and that is the whole point.** No teardown
 * door revokes minting on its own: `dispose()` is engine-teardown plus `disconnect()`,
 * `[Symbol.dispose]()` is just `disconnect()`, and `disconnect()` deliberately KEEPS the token so a
 * reconnect succeeds, holding a mint's `callAsync` until the next `connect()`. A disposed parent's
 * mint would therefore wait out its timeout and reject as transport, which a child retries for as
 * long as it lives. Without this latch "ending my session ends impersonation" would not be true.
 */
const TORN_DOWN = new WeakSet<object>();

export function isTornDown(client: object): boolean {
  return TORN_DOWN.has(client);
}

/**
 * The single teardown hook — **touchpoint 2 of 2** — called from `NebulaClient`'s three
 * END-OF-SESSION doors: `dispose()`, `logout()` and `[Symbol.dispose]()`. ⚠️ Never from
 * `disconnect()`, which application code also calls to PAUSE a connection: latching there would end
 * impersonation for a session the user never ended, and a paused parent's child must survive.
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
