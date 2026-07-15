/**
 * Profile — the global, per-`profileId` Durable Object that holds a person's PUBLIC OIDC fields
 * (`name`/`nickname`/`picture`) plus a PRIVATE `privateNotes` blob ("what the LLM knows about you").
 *
 * Layer: **raw-DO infrastructure that COMPOSES the mesh comms core** (`ComposedMeshDO`, ADR-007) — it
 * needs the client-facing mesh subscribe AND a raw-RPC read of the raw `NebulaAuthRegistry` (the
 * scoped-admin authz check), which a `LumenizeDO` (Mesh-layer, never-raw) could not do. It takes ONLY
 * the receive core — no `onStart`/`alarms`/`svc.broadcast` (a raw composer has no `onStart`; the fanout
 * is hand-rolled for the cross-scope PROFILE-fence). Code home is `@lumenize/nebula-auth`; it RUNS in
 * the one `nebula` Worker (re-exported there, bound as `PROFILE`).
 *
 * AuthZ (tasks/nebula-profile-store.md § The Profile DO):
 *  - **Public read/subscribe is OPEN** — any authenticated caller holding the (unguessable) `profileId`
 *    reads the public fields. No gate, NO registry read on the hot path. The handle IS the capability.
 *  - **`requireOwnerOrAdmin` gates public-field writes + `privateNotes` read/write** — owner (JWT
 *    `profileId` === this instance) and super-admin (`authScopePattern === '*'`) short-circuit with NO
 *    read; a scoped admin is the ONE path that reads (the registry's `getScopesForProfile`). Fail CLOSED.
 *
 * `privateNotes` NEVER rides a pushed/subscribed snapshot — it is served solely by a separate gated read.
 *
 * @see tasks/nebula-profile-store.md
 */
import { DurableObject } from 'cloudflare:workers';
import { ComposedMeshDO, mesh, newContinuation, type Continuation } from '@lumenize/mesh';
import { ulidFactory } from 'ulid-workers';
import { debug } from '@lumenize/debug';
import { matchAccess } from './parse-id';
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
 * fanout can type `ctn<ResourceUpdateReceiver>()` WITHOUT importing `NebulaClient` (an upward edge a
 * type-only import would silently pass tests on). Matches `NebulaClient.handleResourceUpdate`.
 */
interface ResourceUpdateReceiver {
  handleResourceUpdate(resourceType: string, resourceId: string, result: ProfileSnapshot | Error): void;
}

/** The client subscribe key is `Profile:${profileId}` — resourceType is a constant, resourceId = profileId. */
const RESOURCE_TYPE = 'Profile';
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
    // Initial-snapshot delivery (3-arg fire-and-forget), mirroring Star's deliverResourceUpdate.
    this.lmz.call(subscriberBinding, clientId,
      this.ctn<ResourceUpdateReceiver>().handleResourceUpdate(RESOURCE_TYPE, this.#profileId(), this.#publicSnapshot()));
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
    // Phase 3: fanout the new #publicSnapshot() to Subscribers rows (hand-rolled loop + PROFILE-fence).
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

  /** Build the delivery snapshot from the PUBLIC subset ONLY — `privateNotes` is structurally excluded. */
  #publicSnapshot(): ProfileSnapshot {
    const value: ProfilePublicFields = {};
    for (const row of this.ctx.storage.sql.exec(
      `SELECT field, value FROM ProfileFields WHERE field IN ('name', 'nickname', 'picture')`)) {
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

    // (1) Owner — the JWT's own profileId equals this instance. NO read. (LLM-as-owner passes here.)
    if (claims?.profileId && claims.profileId === profileId) return;
    // (2) Not an admin → reject. NO read.
    if (!claims?.access?.admin) throw new Error('Forbidden: profile write requires owner or admin');
    // (3) Super-admin (pattern '*') covers every scope → pass. NO read.
    if (claims.access.authScopePattern === '*') return;

    // (4) Scoped admin — the ONE registry read. Fail CLOSED on error (raw-RPC drops custom error props,
    // so a thrown registry error would arrive shapeless — deny rather than trust it).
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
    const pattern = claims.access.authScopePattern;
    if (scopes.some((s) => matchAccess(pattern, s))) return;
    throw new Error('Forbidden: admin does not cover any of the profile scopes');
  }

  /**
   * The scoped-admin registry read — `profileId → scopes`. A `protected` SEAM so a test subclass can
   * force the fail-closed path (`#requireOwnerOrAdmin` catches a throw here and denies). NOT public API.
   *
   * Raw Workers RPC to the raw registry (nebula-auth is raw-DO infra). NOT a `using` stub — DO stubs
   * from `getByName` aren't `Symbol.dispose`-disposable in this runtime (`using` throws "not
   * disposable"); the stub is released when this method returns after the single awaited SQL read (the
   * narrowest practical scope). The `await` is load-bearing — returning the pending promise before the
   * method's stub reference drops would race the release.
   */
  protected async lookupProfileScopes(profileId: string): Promise<string[]> {
    type RegistryStub = { getScopesForProfile(id: string): Promise<string[]> };
    const registry = (this.env as any).NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME) as RegistryStub;
    return await registry.getScopesForProfile(profileId);
  }
}
