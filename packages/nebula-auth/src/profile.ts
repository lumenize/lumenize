/**
 * Profile — the global, per-`profileId` Durable Object that holds a person's PUBLIC OIDC fields
 * (`name`/`nickname`/`picture`) plus a PRIVATE field set, of which `privateNotes` ("what the LLM knows
 * about you") is the first and currently the only member.
 *
 * ⚠️ **Private is DERIVED, not enumerated: the public set is the `PUBLIC_FIELDS` allow-list, and every
 * other field is private by construction** (ADR-012). So a newly added field is private without anyone
 * deciding, and cannot leak by omission. Build the pushed snapshot FROM the allow-list — never by
 * subtracting known-private keys from the stored record, which is the shape that ships a leak the first
 * time someone adds a field and forgets the deny-list.
 *
 * Layer: **raw-DO infrastructure that COMPOSES the mesh comms core** (`ComposedMeshDO`, ADR-007) — it
 * needs the client-facing mesh subscribe AND a raw-RPC read of the raw `NebulaAuthRegistry` (the
 * scoped-admin authz check), which a `LumenizeDO` (Mesh-layer, never-raw) could not do. It takes ONLY
 * the receive core — no `onStart`/`alarms`/`svc.broadcast` (a raw composer has no `onStart`; the fanout
 * is hand-rolled for the cross-scope PROFILE-fence). Code home is `@lumenize/nebula-auth`; it RUNS in
 * the one `nebula` Worker (re-exported there, bound as `PROFILE`).
 *
 * AuthZ (ADR-012):
 *  - **Public read/subscribe is OPEN** — any authenticated caller holding the `profileId` reads the
 *    public fields. No gate, NO registry read on the hot path. AuthN + the `PUBLIC_FIELDS` allow-list
 *    are what carry the trust; unguessability only bounds enumeration (ADR-012, re-weighted 2026-08-20).
 *  - **`requireOwnerOrAdmin` gates public-field writes + the private set's read/write** — EXACTLY two
 *    capability levels, never per-field roles: anyone who can read a private field can also write it and
 *    write every public one. Owner (JWT `profileId` === this instance, and no `act` chain) and
 *    super-admin (`authScope` is the platform root) short-circuit with NO read; a scoped admin whose scope
 *    covers a scope where this profile holds an **ACCEPTED** membership is the ONE path that reads (the
 *    registry's `getScopesForProfile`, whose acceptance predicate is what makes that branch safe — see
 *    the comment at the branch). Fail CLOSED.
 *
 * A private field NEVER rides a pushed/subscribed snapshot — it is served solely by a separate gated read.
 *
 * @see docs/adr/012-global-profile-visibility.md — authz; docs/adr/013-identity-profileid-resolution.md
 *      — data model; tasks/archive/nebula-profile-store.md — the frozen design record
 */
import { DurableObject } from 'cloudflare:workers';
import { ComposedMeshDO, mesh, newContinuation, type Continuation } from '@lumenize/mesh';
import { ulidFactory } from 'ulid-workers';
import { debug } from '@lumenize/debug';
import { hasDominionOver, isPlatformScope } from './parse-id';
import { REGISTRY_INSTANCE_NAME } from './types';
import type { NebulaJwtPayload } from './types';

/** The PUBLIC OIDC fields — the ONLY fields a read/subscribed/pushed snapshot carries. */
export interface ProfilePublicFields {
  name?: string;
  nickname?: string;
  picture?: string;
}

/**
 * The delivery shape the client's reactive store consumes — a LOCAL structural mirror of apps/nebula's
 * `Snapshot` (nebula-auth must NOT import apps/nebula — mesh.md § dependency-direction). The client
 * engine dereferences only `value` + `meta.eTag` (verified 2026-07-14), so this minimal meta suffices.
 */
export interface ProfileSnapshot {
  value: ProfilePublicFields;
  meta: { eTag: string };
}

/**
 * The client-side continuation target for a pushed snapshot — a minimal structural interface so the
 * fanout can type `ctn<ProfileUpdateReceiver>()` WITHOUT importing `NebulaClient` (an upward edge a
 * type-only import would silently pass tests on). Matches `NebulaClient.handleProfileUpdate`.
 *
 * A **dedicated** profile channel (NOT `handleResourceUpdate('Profile', …)`): the platform profile must
 * not share the client's resource-type keyspace/routing with a dev-user ontology type named `Profile`
 * (that collision was a footgun AND a shipped reconnect mis-route — tasks/archive/nebula-subscriber-lists.md).
 */
interface ProfileUpdateReceiver {
  handleProfileUpdate(profileId: string, result: ProfileSnapshot | Error): void;
}

/** The public fields, in the ProfileFields k-v table. `privateNotes` and `eTag` are separate keys. */
const PUBLIC_FIELDS = ['name', 'nickname', 'picture'] as const;

export class Profile extends ComposedMeshDO(DurableObject, 'Profile') {
  /** Monotonic ULID factory — the forward-only per-write `eTag` (a statically-init utility; loss-safe). */
  #ulid = ulidFactory({ monotonic: true });

  constructor(ctx: DurableObjectState, env: Env) {
    // `env as Cloudflare.Env`: ComposedMeshDO erases DurableObject's env generic (mirrors LumenizeDO).
    super(ctx, env as Cloudflare.Env);
    // Synchronous raw-DO init (no `onStart` — a raw composer has none; the ctor completes before dispatch).
    // WITHOUT ROWID on the TEXT PKs (write-cost — durable-objects.md).
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ProfileFields (field TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS Subscribers (clientId TEXT PRIMARY KEY, subscriberBinding TEXT NOT NULL) WITHOUT ROWID`,
    );
    // Seed a baseline eTag once so an unwritten profile still delivers a client-usable snapshot.
    ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO ProfileFields (field, value) VALUES ('eTag', ?)`, this.#ulid(),
    );
  }

  // `ctn()` stays per-class (off ComposedMeshDO) — its `Continuation<this>` return can't cross the mixin
  // boundary when a subclass concretizes an optional base method (see backlog § Lumenize Mesh).
  ctn(): Continuation<this>;
  ctn<T>(): Continuation<T>;
  ctn(): Continuation<unknown> {
    return newContinuation() as Continuation<unknown>;
  }

  // ── Reads (OPEN — no gate, NO registry read) ─────────────────────────────────────────────────────

  /** Read the PUBLIC fields (open — any authenticated caller holding the profileId). */
  @mesh()
  read(): ProfileSnapshot {
    return this.#publicSnapshot();
  }

  /**
   * Subscribe the calling client to public-field updates: store its subscriber row, then deliver the
   * INITIAL snapshot. The initial push is fired INSIDE this subscribe call, so it inherits the
   * subscriber's `originAuth` → passes the Gateway aud-check with or without the PROFILE-fence
   * (§ Routing). Open — no authz. (The update-fanout leg + fence land in Phase 3.)
   */
  @mesh()
  subscribe(): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) throw new Error('subscribe requires a client origin (callChain[0].instanceName)');
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) throw new Error('subscribe requires a gateway (callChain.at(-1).bindingName)');

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscribers (clientId, subscriberBinding) VALUES (?, ?)`,
      clientId, subscriberBinding,
    );
    // Initial-snapshot delivery (3-arg fire-and-forget) on the DEDICATED profile channel.
    this.lmz.call(subscriberBinding, clientId,
      this.ctn<ProfileUpdateReceiver>().handleProfileUpdate(this.#profileId(), this.#publicSnapshot()));
  }

  /** Drop the caller's subscriber row (best-effort; mirrors Star.unsubscribe). */
  @mesh()
  unsubscribe(): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (clientId) this.ctx.storage.sql.exec(`DELETE FROM Subscribers WHERE clientId = ?`, clientId);
  }

  // ── Writes (gated by requireOwnerOrAdmin) ────────────────────────────────────────────────────────

  /**
   * Replace the PUBLIC fields (last-writer-wins — NO ADR-004 history, NO ADR-005 OCC conflict-check)
   * and advance the forward-only `eTag`. Owner/admin only. (Phase 3 appends the subscriber fanout.)
   */
  @mesh()
  async writeProfile(fields: ProfilePublicFields): Promise<void> {
    await this.#requireOwnerOrAdmin();
    for (const f of PUBLIC_FIELDS) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO ProfileFields (field, value) VALUES (?, ?)`, f, fields[f] ?? null,
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ProfileFields (field, value) VALUES ('eTag', ?)`, this.#ulid(),
    );
    this.#fanout();
  }

  /**
   * Push the new public snapshot to every subscriber — a HAND-ROLLED `lmz.call` loop (not
   * `svc.broadcast`, which is `LumenizeDO`-only AND whose tier-worker path rewrites `metadata.caller`,
   * defeating the cross-scope PROFILE-fence). The loop never hops a tier worker, so `metadata.caller`
   * stays `PROFILE` and the Gateway fence is reliable at any N. 4-arg `onErrorOnly`: on a failed
   * delivery the Gateway returns a `ClientDisconnectedError` to `onProfileBroadcastResult`, which drops
   * the dead subscriber row (self-healing, per testing.md §self-healing-transient).
   */
  #fanout(): void {
    const snapshot = this.#publicSnapshot();
    const profileId = this.#profileId();
    for (const row of this.ctx.storage.sql.exec(`SELECT clientId, subscriberBinding FROM Subscribers`)) {
      const clientId = (row as { clientId: string }).clientId;
      const subscriberBinding = (row as { subscriberBinding: string }).subscriberBinding;
      this.lmz.call(
        subscriberBinding, clientId,
        this.ctn<ProfileUpdateReceiver>().handleProfileUpdate(profileId, snapshot),
        this.ctn().onProfileBroadcastResult(),
        { onErrorOnly: true },
      );
    }
  }

  /**
   * Dead-subscriber cleanup — the 4-arg fire-back from a failed fanout delivery. Drops the subscriber
   * row when the Gateway reports the client disconnected. Mirrors `Star.onBroadcastResult`, BUT is
   * **`public` and deliberately NOT `@mesh()`**: the fire-back lands via `__handleResponse`
   * (`requireMeshDecorator: false`), so no decorator is needed — and with this DO's open `onBeforeCall`,
   * an `@mesh` here would let any client forge a `ClientDisconnectedError` to drop another subscriber's
   * row (a DoS surface). Detect by `name` (custom Error classes don't keep `instanceof` — mesh.md).
   */
  onProfileBroadcastResult(result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.ctx.storage.sql.exec(`DELETE FROM Subscribers WHERE clientId = ?`, clientId);
    }
  }

  /** Read the PRIVATE `privateNotes` blob — gated (owner/admin only), NEVER via a snapshot. */
  @mesh()
  async readPrivateNotes(): Promise<string | undefined> {
    await this.#requireOwnerOrAdmin();
    const rows = [...this.ctx.storage.sql.exec(`SELECT value FROM ProfileFields WHERE field = 'privateNotes'`)];
    return rows.length ? (rows[0].value as string | undefined) ?? undefined : undefined;
  }

  /** Write the PRIVATE `privateNotes` blob — gated (owner/admin only). Does not touch the public eTag. */
  @mesh()
  async writePrivateNotes(notes: string): Promise<void> {
    await this.#requireOwnerOrAdmin();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ProfileFields (field, value) VALUES ('privateNotes', ?)`, notes,
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────────────

  /** This DO's instance name == its `profileId` (stamped by the framework on first mesh entry). */
  #profileId(): string {
    const id = this.lmz.instanceName;
    if (!id) throw new Error('Profile DO has no instanceName (not reached via a routed mesh call)');
    return id;
  }

  /** Build the delivery snapshot FROM the `PUBLIC_FIELDS` allow-list — the IN-list is interpolated
   *  from the one constant (placeholders, parameter-bound), so a stored field outside it is excluded
   *  without being named anywhere. Never a subtraction of known-private keys (see the header). */
  #publicSnapshot(): ProfileSnapshot {
    const value: ProfilePublicFields = {};
    for (const row of this.ctx.storage.sql.exec(
      `SELECT field, value FROM ProfileFields WHERE field IN (${PUBLIC_FIELDS.map(() => '?').join(', ')})`,
      ...PUBLIC_FIELDS)) {
      const v = (row as { value: string | null }).value;
      if (v != null) (value as Record<string, string>)[(row as { field: string }).field] = v;
    }
    const eTagRows = [...this.ctx.storage.sql.exec(`SELECT value FROM ProfileFields WHERE field = 'eTag'`)];
    return { value, meta: { eTag: eTagRows[0]!.value as string } };
  }

  /**
   * Owner-or-admin gate for writes + the private blob — resolve TOP-DOWN, reading the registry ONLY if
   * forced (the scoped-admin case). An async method-body call (NOT `onBeforeCall`, which is sync and
   * can't await the registry read). Throws on denial. Fail CLOSED on any registry-read failure.
   */
  async #requireOwnerOrAdmin(): Promise<void> {
    const claims = this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined;
    const profileId = this.#profileId();

    // (1) Owner — the JWT's own profileId equals this instance, AND the token carries no `act` chain.
    // NO read. (LLM-as-owner passes here.)
    //
    // ⚠️ **`!claims.act` is a deliberate EXCEPTION to `security.md`'s read-side rule, not an
    // application of it** — it is the one place where the presence of `act` changes an authz outcome,
    // and ADR-012 licenses it explicitly. Under impersonation the token carries the SUBJECT's
    // `profileId`, so without this clause the admin driving it would own that person's profile:
    // writing their public fields and reading their `privateNotes`. What licenses the exception is
    // *global*: a profile sits outside the scope tree, and dominion over one can be
    // MANUFACTURED (claim a Universe, invite any address), so a manufactured scope contains nothing
    // of the victim's except this global object.
    //
    // ⚠️ The invariant is **an admin-driven session is never an owner** — NOT "the two subs are
    // different people". `#mintIdentity` keys on (email, scope), so one human legitimately holds
    // several `sub`s. Do NOT "improve" this to `!claims.act || claims.act.sub === claims.sub` or
    // `|| claims.act.profileId === claims.profileId`: both read the chain's IDENTITY to decide authz,
    // which rule (1) forbids. This tests only that an `act` chain is PRESENT, never who the actor is.
    //
    // ⚠️ **A known, accepted consequence of presence-only** — do not "fix" it with the variants above.
    // If a future `prependActor` ever stamps the platform onto a TOKEN (it is planned only for an
    // `actingToken` RECORD), a person's own session would carry `act` and lose the owner branch on their
    // OWN profile. The remedy then is to keep such a token out of this path — or to re-open ADR-012 —
    // never to start comparing `act.sub` to `claims.sub`, which is precisely the manufacture the
    // exception exists to defeat.
    if (claims?.profileId && claims.profileId === profileId && !claims.act) return;
    // (2) Not an admin → reject. NO read.
    // ⚠️ **ALLOW-LISTED off the shared predicate — a bare `scopeAdmin` test standing alone.** It is
    // work avoidance, not the dominion decision: branch (4) below asks `hasDominionOver` about each
    // scope the profile actually touches, and this only spares the registry read for a caller who
    // could not pass it under any scope. Deleting it changes no verdict; replacing it with the
    // predicate is impossible, since the predicate needs the very list this exists to avoid fetching.
    if (!claims?.access?.scopeAdmin) throw new Error('Forbidden: profile write requires owner or admin');
    // (3) Super-admin — the reserved platform scope is the ROOT, so it covers every scope → pass. NO
    // read. ⚠️ An IDENTITY test, deliberately not `hasDominionOver`: this is a work-avoidance
    // short-circuit whose whole purpose is to answer before the registry read, and the predicate
    // would need the very scope list this branch exists to avoid fetching.
    if (isPlatformScope(claims.access.authScope)) return;

    // (4) Scoped admin — the ONE registry read. Fail CLOSED on error (raw-RPC drops custom error props,
    // so a thrown registry error would arrive shapeless — deny rather than trust it).
    //
    // ⚠️ **WHAT MAKES THIS BRANCH SAFE IS NOT HERE — it is the ACCEPTED-membership predicate inside
    // `getScopesForProfile`.** Ungated, this dominion is MANUFACTURABLE: Universe self-signup is open
    // by design and an invite mints the membership immediately, so anyone could claim a Universe,
    // invite an address they guessed, and become "an admin of a scope that stranger's profile
    // touches" — over a *global* object. Only memberships the person actually took up count, and the
    // accepted marker is written solely by the login verify path, which requires consuming a link
    // delivered to the mailbox. See ADR-012, and the manufacture test in `nebula-auth`'s
    // `identity-mint-point.test.ts`, which reds if the predicate is dropped.
    //
    // ⚠️ So: do NOT "optimize" the registry call into a plain `profileId → scopes` lookup, and do not
    // widen this branch to unaccepted memberships. Two residuals are accepted deliberately in ADR-012
    // (this points sideways across the scope tree, and reaches every scope the person belongs to);
    // scope-keying the private fields is the deferred structural answer if they ever bite.
    //
    // ⚠️ `!claims.act` on branch (1) does NOT fence impersonation out of the profile — an admin
    // impersonating someone with an accepted membership in a covered scope arrives HERE, by their own
    // dominion. That follows from impersonation meaning what it says; it is not a gap in (1).
    let scopes: string[];
    try {
      // Marker: the ONLY place a Profile authz check reads the registry (the read-counter the
      // owner/super-admin "zero reads" + scoped-admin "exactly one read" tests assert on).
      debug('nebula-auth.Profile.authz.registryRead').debug('scoped-admin scope lookup', { profileId });
      scopes = await this.lookupProfileScopes(profileId);
    } catch (err) {
      debug('nebula-auth.Profile.authz.failClosed').warn('scoped-admin registry read failed — denying', {
        profileId, error: err instanceof Error ? err.message : String(err),
      });
      throw new Error('Forbidden: profile authz check failed');
    }
    // The END shape: the ONE shared dominion predicate, asked about each scope this profile
    // actually touches. Its `scopeAdmin` conjunction is re-checked here rather than assumed from
    // branch (2) — that is the point of routing through the predicate, and it costs one boolean.
    if (scopes.some((s) => hasDominionOver(claims.access, s))) return;
    throw new Error('Forbidden: admin does not cover any of the profile scopes');
  }

  /**
   * The scoped-admin registry read — `profileId → scopes`. A `protected` SEAM so a test subclass can
   * force the fail-closed path (`#requireOwnerOrAdmin` catches a throw here and denies). NOT public API.
   *
   * Raw Workers RPC to the raw registry (nebula-auth is raw-DO infra). NOT a `using` stub — a DO stub
   * is a local pointer with no `Symbol.dispose`, so `using` throws "Object is not disposable." in EVERY
   * environment (pool-workers === wrangler dev === deployed, verified 2026-07-15; only a method-returned
   * RpcTarget is disposable — see the using-on-do-stub-not-disposable memory). A plain `const` + `await`
   * is correct everywhere; the `await` is load-bearing — returning the pending promise unawaited would
   * race the stub's release on method return.
   */
  protected async lookupProfileScopes(profileId: string): Promise<string[]> {
    type RegistryStub = { getScopesForProfile(id: string): Promise<string[]> };
    const registry = (this.env as any).NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME) as RegistryStub;
    return await registry.getScopesForProfile(profileId);
  }
}
