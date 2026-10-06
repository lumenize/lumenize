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
 * the comms core — no `onStart`, no `svc` (a raw composer has neither) — and fans updates out with
 * `lmz.broadcast`, which the core carries. Code home is `@lumenize/nebula-auth`; it RUNS in the one
 * `nebula` Worker (re-exported there, bound as `PROFILE`).
 *
 * AuthZ (ADR-012):
 *  - **Public read/subscribe is OPEN** — any authenticated caller holding the `profileId` reads the
 *    public fields. No gate, NO registry read on the hot path. AuthN + the `PUBLIC_FIELDS` allow-list
 *    are what carry the trust; unguessability only bounds enumeration (ADR-012, re-weighted 2026-08-20).
 *  - **`requireOwnerOrAdmin` gates public-field writes + the private set's read/write** — EXACTLY two
 *    capability levels, never per-field roles: anyone who can read a private field can also write it and
 *    write every public one. Owner (JWT `profileId` === this instance — an impersonation token included,
 *    because acceptance is enforced where that token is minted) and
 *    a platform-root token on the agent's own Profile (`NEBULA_SUB`) short-circuit with NO read; an
 *    admin, a superuser included, whose page's host holds dominion over a scope where this profile
 *    holds an **ACCEPTED** membership is the ONE path that reads (the
 *    registry's `getScopesForProfile`, whose acceptance predicate is what makes that branch safe — see
 *    the comment at the branch). Fail CLOSED.
 *
 * A private field NEVER rides a pushed/subscribed snapshot — it is served solely by a separate gated read.
 *
 * @see docs/adr/012-global-profile-visibility.md — authz; docs/adr/013-identity-profileid-resolution.md
 *      — data model; tasks/archive/nebula-profile-store.md — the frozen design record
 */
import { DurableObject } from 'cloudflare:workers';
import { ComposedMeshDO, addressOf, mesh, newContinuation, rawRpc, splitAddress, type Continuation } from '@lumenize/mesh';
import { ulidFactory } from 'ulid-workers';
import { debug } from '@lumenize/debug';
import { hasDominionOver, isPlatformScope, parseId } from './parse-id';
import { NEBULA_SUB, REGISTRY_INSTANCE_NAME } from './types';
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

/**
 * The Profile's `Subscribers` table: one row per subscriber, keyed on its address, such as
 * `STAR/acme.crm.tenant1/alice.9f2c41aa`. A table still keyed on `clientId` is dropped first: its
 * rows are disposable, since every client re-subscribes, and the check drops it once, never on a
 * later wake. Run by the constructor; exported so a test can run it over a seeded old table.
 * @internal
 */
export function ensureSubscribersTable(sql: SqlStorage): void {
  const columns = sql.exec(`PRAGMA table_info(Subscribers)`).toArray() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'clientId')) sql.exec(`DROP TABLE Subscribers`);
  sql.exec(`CREATE TABLE IF NOT EXISTS Subscribers (clientAddress TEXT PRIMARY KEY, subscribedAt TEXT NOT NULL) WITHOUT ROWID`);
}

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
    ensureSubscribersTable(ctx.storage.sql);
    // Seed a baseline eTag once so an unwritten profile still delivers a client-usable snapshot.
    ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO ProfileFields (field, value) VALUES ('eTag', ?)`, this.#ulid(),
    );
    // The reserved Nebula LLM profile SELF-SEEDS — never a deploy step, never a manual one. An
    // instance whose own id is the reserved agent id writes ALL THREE public fields (a partial
    // seed would render Nebula unlike every human — the set is exactly the PUBLIC_FIELDS
    // allow-list); every other instance does nothing. `ctx.id.name`, not `this.lmz.instanceName`
    // — identity is not stamped this early (the same trap Resources documents), while a
    // named DO's `ctx.id.name` is available at construction. INSERT OR IGNORE: one more
    // statement in this constructor's established seed pattern, and a later super-admin edit is
    // never clobbered on reconstruct. Write-authz is `#requireOwnerOrAdmin`'s branch (3), which lets
    // a super-admin edit this one profile, since an ownerless, not-in-Registry profile has no scope
    // the scoped arm could find.
    if (ctx.id.name === NEBULA_SUB) {
      for (const [field, value] of [
        ['name', 'Lumenize'],
        ['nickname', 'Lumenize'],
        ['picture', 'https://lumenize.com/img/logo.svg'],
      ] as const) {
        ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO ProfileFields (field, value) VALUES (?, ?)`, field, value,
        );
      }
    }
  }

  /**
   * A Profile never runs under a name that parses as a scope, such as `acme.crm.bigco`.
   *
   * A Profile is named by a profile id: a UUID, a persona's version-5 UUID, or `NEBULA_SUB`
   * (`'agent:nebula'`), none of which parses as a scope. Without this check a tab could bring a
   * Profile into existence at a Star's name. Passage reads a claimless chain's scope from the name
   * of the node that started it (`NebulaDO`'s `claimsForPassage`), which is sound only if every
   * object running under a scope-shaped name checks passage into that scope, and a Profile checks
   * none. Every other caller passes, since a Profile's reads are open to any caller holding its id
   * (ADR-012) and its writes check ownership in the method.
   */
  onBeforeCall(): void {
    super.onBeforeCall();
    const name = this.lmz.instanceName;
    if (name === undefined) return;
    let isScope = true;
    try { parseId(name); } catch { isScope = false; }
    if (isScope) throw new Error(`"${name}" is a scope's name, and no Profile runs under one`);
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
   * INITIAL snapshot. The initial push is fired INSIDE this subscribe call, so it carries the
   * subscriber's own `originAuth`: it answers the subscriber's call, where every later push is this
   * Profile speaking and carries none.
   * Open — no authz.
   *
   * The row is the client's address, built from `callChain[0]`, the element its server-side half
   * stamps from the socket's verified attachment: `STAR/acme.crm.tenant1/alice.9f2c41aa`. The
   * chain's last element names whichever node relayed the call, which is not the address to push to.
   */
  @mesh()
  subscribe(): void {
    const origin = this.lmz.callContext.callChain[0];
    if (!origin?.instanceName) throw new Error('subscribe requires a client origin (callChain[0].instanceName)');
    const clientAddress = addressOf(origin);

    const subscribedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO Subscribers (clientAddress, subscribedAt) VALUES (?, ?)`,
      clientAddress, subscribedAt,
    );
    debug('nebula-auth.Profile.subscribe').debug('subscriber stored', { profileId: this.#profileId(), clientAddress });
    // Initial-snapshot delivery on the DEDICATED profile channel, reaped as a broadcast is: a tab
    // whose server-side half reports it gone loses the row this call just wrote.
    this.lmz.call(origin.bindingName, origin.instanceName,
      this.ctn<ProfileUpdateReceiver>().handleProfileUpdate(this.#profileId(), this.#publicSnapshot()),
      this.ctn().onProfileBroadcastResult(subscribedAt), { onErrorOnly: true });
  }

  /** Drop the caller's subscriber row (best-effort; mirrors the Resources plane's `requests.unsubscribe`). */
  @mesh()
  unsubscribe(): void {
    const origin = this.lmz.callContext.callChain[0];
    if (origin?.instanceName) this.ctx.storage.sql.exec(`DELETE FROM Subscribers WHERE clientAddress = ?`, addressOf(origin));
  }

  // ── Writes (gated by requireOwnerOrAdmin) ────────────────────────────────────────────────────────

  /**
   * Replace the PUBLIC fields (last-writer-wins — NO ADR-004 history, NO ADR-005 OCC conflict-check),
   * advance the forward-only `eTag`, and push the new snapshot to every subscriber. Owner/admin only.
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

  // ── The auth Worker's seam: `@rawRpc()`, never `@mesh()` ────────────────────────────────────────

  /**
   * Read the DISPLAY NAMES on behalf of a person the AUTH WORKER has already authenticated — the
   * accept-membership seam, and the only non-`@mesh` door onto a public field.
   *
   * ⚠️ **Trust boundary, named (security.md § trust-boundary crossings).** This pair cannot
   * re-validate its caller: the proof is a `refresh-token` cookie, which lives in the Worker's hands
   * and never reaches a DO, so there is nothing here for `#requireOwnerOrAdmin` to read. What stands
   * in its place is ADR-023's `@rawRpc()` bridge: only code holding the `PROFILE` binding reaches it,
   * which is our own Worker, and the Worker resolves `profileId` from the cookie it JUST verified —
   * the identical shape to `registry.acceptMembership(sub)`, which likewise acts on an identity the
   * Worker proved. No `@mesh()`, which would let any caller with a token write anyone's names.
   *
   * ⚠️ **Deliberately narrow: the two display NAMES, never `picture` and never the private set.**
   * The consent screen is the one caller and these are all it collects, so a mistake at this seam
   * cannot widen into a disclosure or a takeover. `picture` is excluded because nothing writes one
   * yet — the consent screen's avatar is a coming-soon affordance — and adding it here would be a
   * security decision rather than a refactor.
   */
  @rawRpc()
  readDisplayNames(): { nickname?: string; name?: string } {
    const out: { nickname?: string; name?: string } = {};
    for (const row of this.ctx.storage.sql.exec(
      `SELECT field, value FROM ProfileFields WHERE field IN ('nickname', 'name')`,
    )) {
      const { field, value } = row as { field: 'nickname' | 'name'; value: string | null };
      if (value) out[field] = value;
    }
    return out;
  }

  /**
   * Set the display names at that same seam — see {@link readDisplayNames} for the trust boundary.
   * Advances the forward-only `eTag` and fans out exactly as a `@mesh` public write does, so a
   * subscriber watching a byline sees the name arrive without knowing which door wrote it.
   *
   * ⚠️ **`name` is written only when SUPPLIED**, never cleared by omission: it is optional on the
   * consent screen, so an absent one means "not offered", never "remove the one I have". A person
   * accepting a second membership would otherwise wipe a full name they set at the first.
   */
  @rawRpc()
  setDisplayNames(fields: { nickname: string; name?: string }): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ProfileFields (field, value) VALUES ('nickname', ?)`, fields.nickname,
    );
    if (fields.name) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO ProfileFields (field, value) VALUES ('name', ?)`, fields.name,
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ProfileFields (field, value) VALUES ('eTag', ?)`, this.#ulid(),
    );
    this.#fanout();
  }

  /**
   * Push the new public snapshot to every subscriber with `lmz.broadcast`, which sends each push
   * from this Profile and starts each push's chain here, so the writer's claims — `sub`, `aud`,
   * `access`, and `act` under impersonation — stay behind rather than riding into every
   * subscriber's scope. A subscriber's Gateway lets the push through because this Profile's name,
   * a `profileId`, is no scope, and a client's `onBeforeCall` decides from the caller, which is
   * this Profile. On a failed delivery the Gateway fires back a `ClientDisconnectedError`, and
   * `onProfileBroadcastResult` drops that subscriber's row if it is no newer than this push
   * (self-healing, per testing.md §self-healing-transient).
   */
  #fanout(): void {
    const targets = this.ctx.storage.sql.exec(`SELECT clientAddress FROM Subscribers`)
      .toArray()
      .map((row) => splitAddress((row as { clientAddress: string }).clientAddress));
    this.lmz.broadcast(
      targets,
      this.ctn<ProfileUpdateReceiver>().handleProfileUpdate(this.#profileId(), this.#publicSnapshot()),
      { onResult: this.ctn().onProfileBroadcastResult(new Date().toISOString()) },
    );
  }

  /**
   * Dead-subscriber cleanup — the fan-out's `onResult`, run with a failed delivery's Error. Drops the
   * subscriber row when the Gateway reports the client disconnected. Mirrors the Resources plane's
   * `results.onBroadcastResult`.
   *
   * **WHICH row comes from `callContext.callee`** — the address this push was sent to, stamped by the
   * framework from a source the caller does not write. The error says only THAT delivery failed.
   *
   * ⚠️ **That is what carries the security; staying undecorated is hygiene.** The older reason —
   * that with this DO's nearly open `onBeforeCall` an `@mesh` here would let any client forge a
   * `ClientDisconnectedError` naming another subscriber — described a real hole and no longer does:
   * the error carries no identity to forge, and on a direct call `callee` is this Profile itself,
   * which names no subscriber row, so it reaps nothing. `public` and un-decorated stays right (the
   * Gateway fires the Error back to the Profile's fire-back door, where `@mesh()` is not checked), but it is now
   * the second line rather than the first. Detect by `name` (custom Error classes don't keep
   * `instanceof` — mesh.md).
   */
  onProfileBroadcastResult(sentAt: string, result?: unknown): void {
    if (!(result instanceof Error)) return;
    const callee = this.lmz.callContext.callee;
    const clientAddress = callee?.instanceName ? addressOf(callee) : undefined;
    // The reaper's receipt, so a run can see which tab an update failed to reach, and why.
    debug('nebula-auth.Profile.reap').info('update not delivered', { clientAddress, name: result.name });
    if (result.name === 'ClientDisconnectedError' && clientAddress) {
      // Only a row no newer than the failed push: a re-subscribe that landed first keeps its own.
      this.ctx.storage.sql.exec(`DELETE FROM Subscribers WHERE clientAddress = ? AND subscribedAt <= ?`, clientAddress, sentAt);
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

  /**
   * This DO's name, which is its `profileId`. Read from `ctx.id.name`, as the constructor does: the
   * name the namespace addressed is there before any entry runs, where `lmz.instanceName` is stamped
   * by whichever entry arrives first — a mesh call, or the `@rawRpc()` entry that carries a brand-new
   * person's `setDisplayNames` at acceptance.
   */
  #profileId(): string {
    const id = this.ctx.id.name;
    if (!id) throw new Error('Profile DO has no name (it must be addressed by its profileId)');
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

    // (1) Owner — the JWT's own profileId equals this instance. NO read. (LLM-as-owner passes here.)
    //
    // ⚠️ **An impersonation token IS the owner here, deliberately.** This branch reads the subject
    // and nothing else, exactly like every other authz decision in the system, so an admin driving a
    // narrower token gets that person's own access to their own profile — which is what impersonation
    // means everywhere else.
    //
    // ⚠️ **What makes that safe is not here — it is the acceptance conjunct at the MINT.**
    // The impersonation mint resolves its subject through the registry's accepted-only
    // `getIdentityScope`, so a token carrying somebody's `profileId` cannot exist unless that person
    // took their membership up, and acceptance needs the mailbox plus an explicit act behind the
    // consent modal. The escalation this branch used to carry a no-actor-chain conjunct against —
    // claim a Universe, invite an address you guessed, impersonate the stranger — is closed at the
    // token's birth instead of at this one branch. Restoring that conjunct here would re-close
    // nothing; it would only take a person's profile away from the admin their membership reaches.
    if (claims?.profileId && claims.profileId === profileId) return;
    // (2) Not an admin → reject. NO read.
    // ⚠️ **ALLOW-LISTED off the shared predicate — a bare `scopeAdmin` test standing alone.** It is
    // work avoidance, not the dominion decision: branch (4) below asks `hasDominionOver` about each
    // scope the profile actually touches, and this only spares the registry read for a caller who
    // could not pass it under any scope. Deleting it changes no verdict; replacing it with the
    // predicate is impossible, since the predicate needs the very list this exists to avoid fetching.
    if (!claims?.access?.scopeAdmin) throw new Error('Forbidden: profile write requires owner or admin');
    // (3) The system's own profile — `NEBULA_SUB`'s is ownerless and in no Registry, so the scoped
    // arm below finds no scopes for it, and a superuser is the one who may edit it. NO read.
    // ⚠️ Confined to THAT profile on purpose. A superuser's token is minted on some scope's host
    // like anyone's, and under the host rule it acts on that host's subtree alone (ADR-015 and
    // ADR-022), so for every other profile it falls through to the scoped arm, which asks
    // `hasDominionOver` from the calling host. A test on the membership here for all profiles would
    // hand private read and write on every profile to any page a superuser opens, a generated
    // app's included.
    if (profileId === NEBULA_SUB && isPlatformScope(claims.access.authScope)) return;

    // (4) Scoped admin — the ONE registry read. Fail CLOSED on error: a read that did not complete
    // proves no dominion, so deny whatever the error carries.
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
    if (scopes.some((s) => hasDominionOver(claims, s))) return;
    throw new Error('Forbidden: admin does not cover any of the profile scopes');
  }

  /**
   * The scoped-admin registry read — `profileId → scopes`. A `protected` SEAM so a test subclass can
   * force the fail-closed path (`#requireOwnerOrAdmin` catches a throw here and denies). NOT public API.
   *
   * Raw Workers RPC to the raw registry (nebula-auth is raw-DO infra). NOT a `using` stub — a DO stub
   * is a local pointer with no `Symbol.dispose`, so `using` throws "Object is not disposable." in EVERY
   * environment (vitest-plugin === wrangler dev === deployed, verified 2026-07-15; only a method-returned
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
