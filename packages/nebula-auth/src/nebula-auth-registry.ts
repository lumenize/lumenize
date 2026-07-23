/**
 * NebulaAuthRegistry — the ONE singleton DO that owns all durable auth state.
 *
 * Since tasks/nebula-auth-surrogate-sub.md dissolved the per-scope `NebulaAuth` DO, this registry is
 * the **single writer** of everything: the `Scopes` existence registry, `Identities` (surrogate-`sub`
 * identity, was `Emails` + `Subjects`), the `MagicLinks` / `InviteTokens` login channel, and the
 * `RefreshTokenIndex` (→ reliable KV invalidation). It also writes the Workers-KV refresh record
 * (`refresh:{tokenHash}`) — the ONE hot record, read at the edge by the default Worker on refresh,
 * never touching this DO.
 *
 * Two callers:
 * - **Worker router (`fetch` endpoints)**: discover / claim-universe / create-galaxy / create-star /
 *   my-scopes / delete-scope(-plan). The router pre-verifies JWT/Turnstile and injects the verified
 *   `access` claim + caller `sub`.
 * - **Worker token layer (raw RPC)**: requestMagicLink / issueInvites / consumeMagicLink /
 *   consumeInvite / revokeRefreshToken / getIdentityScope / setIdentityAdmin — the login-channel +
 *   refresh-token lifecycle. The Worker generates the raw refresh token (cookie) and passes only its
 *   hash; this DO writes the index + KV.
 *
 * Identity authority: `sub` is minted ONLY at authority points — Universe/Star claim + invite
 * issuance. Login **verify** (`getAndVerifyIdentity`) find-and-flips an EXISTING identity and REJECTS
 * if none, so a minted token proves authorized membership by construction (the retired `adminApproved`
 * gate).
 *
 * @see tasks/nebula-auth-surrogate-sub.md § The schema / The seam / Founder & pre-create
 */
import { debug } from '@lumenize/debug';
import { DurableObject } from 'cloudflare:workers';
import { SQLSchemaMigrations } from '@lumenize/sql-migrations';
import { generateRandomString, generateUuid, hashString } from '@lumenize/auth';
import { REGISTRY_MIGRATIONS } from './schemas';
import {
  NEBULA_AUTH_PREFIX, PLATFORM_INSTANCE_NAME,
  MAGIC_LINK_TTL, INVITE_TTL, REFRESH_TOKEN_TTL,
} from './types';
import type { AccessEntry, DiscoveryEntry, RefreshTokenKV } from './types';
import { parseId, isValidSlug, matchAccess, getParentId, hasAdminOverScope } from './parse-id';

/** One affected scope in a scope-deletion plan — enough for the client to teardown the right DOs. */
export interface AffectedScope {
  /** The scope id (universeGalaxyStarId). Kept named `instanceName` for the client/UI wire contract. */
  instanceName: string;
  /** 'universe' | 'galaxy' | 'star' — picks the tier DO binding to teardown. */
  tier: string;
  /** A `{u}.{g}.dev` authoring Star → the client also tears down DevStudio + DevContainer. */
  isDev: boolean;
}

/** A reason a scope can't be deleted: another user is attached to an affected scope. */
export interface ScopeDeletionBlocker {
  instanceName: string;
  email: string;
}

/** The read-only deletion plan that feeds the confirm screen. */
export interface ScopeDeletionPlan {
  /** The full cascade set (target + descendants + pruned-up empty ancestors), wipe order. */
  affected: AffectedScope[];
  /** Non-empty → deletion is refused (a shared scope); each entry names who/where. */
  blockedBy: ScopeDeletionBlocker[];
}

/** Result of a login-channel consume: the identity + scope the Worker needs to mint the JWT. */
export interface ConsumeResult {
  sub: string;
  universeGalaxyStarId: string;
}

export class NebulaAuthRegistry extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Run the registry's schema migrations once, eagerly, before any request is dispatched (the
    // constructor completes before dispatch). id-gated + atomic via @lumenize/sql-migrations.
    const migrationResult = new SQLSchemaMigrations({
      doStorage: ctx.storage, migrations: REGISTRY_MIGRATIONS,
    }).runAll();
    // Post-migration constructs print {0,0}; a first migration prints the created-object count. If the
    // migration had thrown, the constructor would throw and the DO would fail to construct — so this
    // line printing at all confirms the migration succeeded.
    debug('nebula-auth.Registry.migrate').info('registry schema migrations checked', {
      rowsRead: migrationResult.rowsRead,
      rowsWritten: migrationResult.rowsWritten,
    });

    // Sweep expired login-channel tokens on every DO wake (the singleton's onStart-equivalent — the
    // constructor completes before dispatch). MagicLinks/InviteTokens live in the registry (not KV, so
    // no TTL auto-clean), are short-TTL + low-volume, so a full-scan `expiresAt <` DELETE on wake is the
    // cheap replacement (§The schema: "a cheap sweep replaces KV TTL"). No index on `expiresAt`: reads
    // are ~1/1000th the cost of a write, so on these small tables the periodic scan is far cheaper than
    // an index write on every insert. (RefreshTokenIndex is deliberately NOT swept — stale rows are
    // harmless no-op deletes; §Blast radius. Expired tokens are also inert on lookup — the consume/
    // verify paths gate on `expiresAt` regardless — so the sweep is purely storage hygiene.)
    const nowIso = new Date().toISOString();
    ctx.storage.sql.exec('DELETE FROM MagicLinks WHERE expiresAt < ?', nowIso);
    ctx.storage.sql.exec('DELETE FROM InviteTokens WHERE expiresAt < ?', nowIso);
  }

  #sql(strings: TemplateStringsArray, ...values: any[]): any[] {
    const query = strings.reduce((acc, str, i) =>
      acc + str + (i < values.length ? '?' : ''), '');
    return [...this.ctx.storage.sql.exec(query, ...values)];
  }

  /** The Workers-KV namespace holding the hot refresh records (`refresh:{tokenHash}`). */
  get #refreshKv(): KVNamespace { return (this.env as any).REFRESH_TOKEN_KV; }

  get #isTestMode(): boolean { return (this.env as any).NEBULA_AUTH_TEST_MODE === 'true'; }

  /**
   * Bootstrap-admin emails (comma-separated `NEBULA_AUTH_BOOTSTRAP_EMAIL`) → normalized `string[]`.
   * Split → trim → lowercase → drop empties → dedup. A bootstrap email founding the reserved
   * `nebula-platform` scope is stamped platform admin. Compare via array membership, never a substring
   * `String.includes` on the raw joined value.
   */
  get #bootstrapEmails(): string[] {
    const raw = (this.env as any).NEBULA_AUTH_BOOTSTRAP_EMAIL as string | undefined;
    if (!raw) return [];
    return [...new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))];
  }

  // ============================================
  // Identity authority — mint (authority points) + verify (find-and-flip)
  // ============================================

  /**
   * MINT a fresh identity in a scope — an **authority-point-only** operation (Universe/Star claim +
   * invite issuance). Returns the new surrogate `sub`. Idempotent on `(email, scope)`: if a row
   * already exists it is returned unchanged (its `sub` preserved) rather than duplicated — so a
   * re-issued invite or re-claim converges. `email` is normalized (lowercased + trimmed — m1). NEVER
   * call from a login path.
   */
  #mintIdentity(email: string, universeGalaxyStarId: string, isAdmin: boolean, emailVerified: boolean): string {
    const lc = normalizeEmail(email);
    const existing = this.#sql`
      SELECT sub FROM Identities WHERE email = ${lc} AND universeGalaxyStarId = ${universeGalaxyStarId}
    `;
    if (existing.length > 0) return existing[0].sub as string; // idempotent: existing sub AND profileId preserved

    const sub = generateUuid();
    // Mint the PUBLIC `profileId` in the SAME INSERT as `sub` (one write, not a second row). ADR-010:
    // both are random opaque UUIDs, minted without coordination. tasks/nebula-profile-store.md Phase 1.
    const profileId = generateUuid();
    this.ctx.storage.sql.exec(
      `INSERT INTO Identities (sub, profileId, universeGalaxyStarId, email, isAdmin, emailVerified, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sub, profileId, universeGalaxyStarId, lc, isAdmin ? 1 : 0, emailVerified ? 1 : 0, new Date().toISOString(),
    );
    debug('nebula-auth.Registry.identity.minted').info('Identity minted', {
      sub, profileId, universeGalaxyStarId, email: lc, isAdmin, emailVerified,
    });
    return sub;
  }

  /**
   * Login **verify** — find the identity for `(email, scope)` and flip `emailVerified` true, returning
   * `{ sub, universeGalaxyStarId, isAdmin, profileId }`. Returns `null` if **no identity exists** (the load-bearing
   * "a row ⇒ authorized member" invariant that lets `adminApproved` retire — a stranger who requested a
   * login magic link for a scope they were never minted into is rejected here). NEVER mints. Public so
   * the token layer can drive it, but only reached via the consume RPCs.
   */
  getAndVerifyIdentity(email: string, universeGalaxyStarId: string):
    { sub: string; universeGalaxyStarId: string; isAdmin: boolean; profileId: string } | null {
    const lc = normalizeEmail(email);
    const rows = this.#sql`
      SELECT sub, isAdmin, profileId FROM Identities WHERE email = ${lc} AND universeGalaxyStarId = ${universeGalaxyStarId}
    `;
    if (rows.length === 0) return null;
    const sub = rows[0].sub as string;
    this.ctx.storage.sql.exec('UPDATE Identities SET emailVerified = 1 WHERE sub = ?', sub);
    return { sub, universeGalaxyStarId, isAdmin: Boolean(rows[0].isAdmin), profileId: rows[0].profileId as string };
  }

  /**
   * Change an identity's login email — a **single-row update** (Phase 3). Because `email` is a mutable
   * attribute that NOTHING keys off (the surrogate `sub` is the identity key; no token record keys off
   * email; `email` is not a JWT claim), this is the whole email-change flow: no cross-DO cascade, no
   * token re-issue, no re-key. The sub's refresh tokens stay valid (KV records are `sub`-anchored).
   * Email is lowercased (the `UNIQUE(email, scope)` + discover + delete-scope guards compare binary).
   * Returns `false` if the sub is unknown.
   */
  changeEmail(sub: string, newEmail: string): boolean {
    const rows = this.#sql`SELECT universeGalaxyStarId FROM Identities WHERE sub = ${sub}`;
    if (rows.length === 0) return false;
    this.ctx.storage.sql.exec('UPDATE Identities SET email = ? WHERE sub = ?', normalizeEmail(newEmail), sub);
    debug('nebula-auth.Registry.identity.emailChanged').info('Email changed', { sub });
    return true;
  }

  /** Resolve a `sub` → its scope + admin bit + `profileId`. `null` if unknown. Used by the refresh
   *  KV-miss self-heal, the `isAdmin` convergence re-put, and delegated-token (actFor) — each threads
   *  `profileId` into the record it rebuilds so the `profileId` claim survives (Phase 1). */
  getIdentityScope(sub: string): { universeGalaxyStarId: string; isAdmin: boolean; profileId: string } | null {
    const rows = this.#sql`SELECT universeGalaxyStarId, isAdmin, profileId FROM Identities WHERE sub = ${sub}`;
    if (rows.length === 0) return null;
    return {
      universeGalaxyStarId: rows[0].universeGalaxyStarId as string,
      isAdmin: Boolean(rows[0].isAdmin),
      profileId: rows[0].profileId as string,
    };
  }

  /**
   * Defensive refresh-path fallback for a Worker KV **miss** (NOT the normal path — the Worker reads KV
   * directly on refresh). Workers KV is eventually consistent, so on the login→first-refresh hop a
   * cross-colo read can miss the just-written record; the singleton `RefreshTokenIndex` is
   * strongly-consistent, so reconstruct the record from it (+ the current `Identities` row, which gives
   * the CURRENT `isAdmin`/scope — fresher than a stale KV copy) and **self-heal KV** (re-put, so
   * subsequent refreshes hit KV directly — bounding the fallback to at most once per token per
   * propagation gap). Returns `null` for a genuinely-invalid / expired / revoked token (not in the
   * index → the Worker 401s). A bogus-token probe costs 1 indexed read, no write.
   */
  async getRefreshRecord(tokenHash: string): Promise<RefreshTokenKV | null> {
    const rows = this.#sql`SELECT sub, expiresAt FROM RefreshTokenIndex WHERE tokenHash = ${tokenHash}`;
    if (rows.length === 0) return null;
    const sub = rows[0].sub as string;
    const expiresAt = rows[0].expiresAt as string;
    if (new Date().toISOString() > expiresAt) return null; // expired
    const scope = this.getIdentityScope(sub);
    if (!scope) return null; // identity deleted
    const record: RefreshTokenKV = {
      sub, universeGalaxyStarId: scope.universeGalaxyStarId, isAdmin: scope.isAdmin, expiresAt,
      profileId: scope.profileId, // writer (c): self-heal must carry profileId or the claim vanishes for the token's life
    };
    await this.#refreshKv.put(`refresh:${tokenHash}`, JSON.stringify(record), { expirationTtl: kvTtlSeconds(expiresAt) });
    debug('nebula-auth.Registry.token.kvSelfHeal').info('refresh KV record reconstructed on miss', { sub });
    return record;
  }

  /**
   * Reverse lookup: the DISTINCT scopes a `profileId` spans (via `idx_Identities_profileId`) — the
   * Profile DO's scoped-admin authz check (`requireOwnerOrAdmin`, tasks/nebula-profile-store.md). A
   * profileId maps to 1..N `sub`s across scopes (P2 unification), so this can return several.
   *
   * ⚠️ RETURNS PLAIN DATA — `[]` for an unknown/absent profileId, and NEVER throws a status-carrying
   * error: custom-error own-props are dropped across raw Workers RPC (raw-comm.md § Errors), so the
   * Profile DO caller fails CLOSED on `[]`/reject rather than reading a lost `status`.
   */
  getScopesForProfile(profileId: string): string[] {
    const rows = this.#sql`SELECT DISTINCT universeGalaxyStarId FROM Identities WHERE profileId = ${profileId}`;
    return rows.map(r => r.universeGalaxyStarId as string);
  }

  /** The lowercased `email` for a `sub`, or `null` — an ADR-010 indexed lookup, never a key. */
  #emailForSub(sub: string): string | null {
    const rows = this.#sql`SELECT email FROM Identities WHERE sub = ${sub}`;
    return rows.length > 0 ? (rows[0].email as string) : null;
  }

  // ============================================
  // Discovery / existence
  // ============================================

  /**
   * Email-based scope discovery. Unauthenticated. `sub`-FREE by design (§Phase 3): `discover` is
   * unthrottled, so returning the surrogate identity key would widen the enumeration oracle. Returns
   * `{ universeGalaxyStarId, isAdmin }` per scope the email belongs to.
   * (Inherited + deferred oracle-narrowing — see backlog.md § Nebula Auth `discover(email)` oracle.)
   */
  discover(email: string): DiscoveryEntry[] {
    const rows = this.#sql`
      SELECT universeGalaxyStarId, isAdmin FROM Identities WHERE email = ${normalizeEmail(email)}
    `;
    return rows.map(r => ({
      universeGalaxyStarId: r.universeGalaxyStarId as string,
      isAdmin: Boolean(r.isAdmin),
    }));
  }

  /** Whether a scope id is available (no `Scopes` row). Existence is a `Scopes` fact, NOT derived
   *  from `Identities` — a wildcard-managed child scope has a row here and zero members. */
  checkSlugAvailable(universeGalaxyStarId: string): boolean {
    const rows = this.#sql`SELECT 1 FROM Scopes WHERE universeGalaxyStarId = ${universeGalaxyStarId}`;
    return rows.length === 0;
  }

  // ============================================
  // Scope creation — claim (founder-minting self-signup) + create (admin, scope-only)
  // ============================================

  /**
   * Universe self-signup (open, Turnstile-gated at the Worker). Registers the `Scopes` row (with
   * data-use consent opt-IN), MINTS the founder `Identity` (`isAdmin=1`, `emailVerified=0` — the
   * founder still proves via the magic link, which find-and-flips `emailVerified`), and issues a
   * magic link. An authority point — this is where a Universe's founder identity is minted.
   *
   * ⚠️ Self-signup idempotency (mints the scope itself, so `UNIQUE(email,scope)` can't backstop a
   * double-submit) is deferred for pre-alpha — §Founder / Phase-1 success criteria (m6).
   */
  async claimUniverse(slug: string, email: string, origin: string):
    Promise<{ message: string; magicLinkUrl?: string }> {
    const log = debug('nebula-auth.Registry.claimUniverse');
    if (!isValidEmail(email)) throw new RegistryError(400, 'invalid_email', 'Invalid email format');
    if (!isValidSlug(slug)) throw new RegistryError(400, 'invalid_slug', 'Invalid universe slug format');
    if (slug === PLATFORM_INSTANCE_NAME) {
      throw new RegistryError(400, 'reserved_slug', `"${PLATFORM_INSTANCE_NAME}" is reserved`);
    }
    if (!this.checkSlugAvailable(slug)) {
      throw new RegistryError(409, 'slug_taken', `Universe "${slug}" is already claimed`);
    }

    // Register the scope. No ON CONFLICT: checkSlugAvailable proved no row exists and there's no
    // await between — surface a UNIQUE conflict loudly if that invariant is ever violated (slug is
    // not secret).
    try {
      this.ctx.storage.sql.exec('INSERT INTO Scopes (universeGalaxyStarId) VALUES (?)', slug);
    } catch (err) {
      log.error('Universe INSERT conflicted unexpectedly — checkSlugAvailable invariant violated', {
        slug, error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // MINT the founder identity (authority point). A bootstrap email founding `nebula-platform` is
    // the reserved platform-admin path — same isAdmin stamp, distinguished only by the reserved slug.
    this.#mintIdentity(email, slug, /* isAdmin */ true, /* emailVerified */ false);
    log.info('Universe claimed', { slug, email: normalizeEmail(email) });

    return this.#createMagicLinkAndSend(email, slug, origin);
  }

  // NOTE: there is no open, founder-minting `claimStar` **yet**. Star creation today is
  // {@link createStar} (admin-gated over the parent galaxy, `Scopes` row only, no founder).
  //
  // ⚠️ This is "not built", NOT "must never exist" — open Star self-signup is the pinned target
  // (tasks/nebula-star-founder-provisioning.md). The objection this note used to carry — that an open
  // star claim minting an `isAdmin=true` founder inside another user-developer's Universe is a
  // "stranger-claims-a-child escalation" — is **OBSOLETE**. It was true only because the bare
  // `access.admin` bit was authority anywhere; the confinement removed exactly that, so a star
  // founder's exact-star pattern is now inert above its own Star (ADR-015: scope authority flows
  // strictly downward). What made it an escalation was never "a stranger created a row" — it was that
  // the founder became an admin of the PARENT.
  //
  // This note is the source the router comment and two registry/routes tests were echoing; if you
  // change the model again, sweep all four together.

  /**
   * Create a galaxy IN-SESSION — admin-gated, `Scopes` row only, NO founder identity + NO email. The
   * parent-Universe admin manages the new galaxy via their `{u}.*` wildcard reach (§Founder — no local
   * admin stamped). Caller (Worker) pre-verifies the JWT and passes the verified access claim.
   */
  createGalaxy(universeGalaxyId: string, callerAccess: AccessEntry): { instanceName: string } {
    const log = debug('nebula-auth.Registry.createGalaxy');
    let parsed;
    try { parsed = parseId(universeGalaxyId); }
    catch { throw new RegistryError(400, 'invalid_id', 'Invalid universeGalaxyId format'); }
    if (parsed.tier !== 'galaxy') {
      throw new RegistryError(400, 'invalid_tier', 'create-galaxy requires a 2-segment id (universe.galaxy)');
    }
    if (!this.#hasAdminOverUniverse(callerAccess, parsed.universe)) {
      throw new RegistryError(403, 'forbidden', 'Caller does not have admin access to the parent universe');
    }
    if (this.checkSlugAvailable(parsed.universe)) {
      throw new RegistryError(400, 'parent_not_found', `Parent universe "${parsed.universe}" does not exist`);
    }
    if (!this.checkSlugAvailable(universeGalaxyId)) {
      throw new RegistryError(409, 'slug_taken', `Galaxy "${universeGalaxyId}" is already claimed`);
    }
    this.ctx.storage.sql.exec('INSERT INTO Scopes (universeGalaxyStarId) VALUES (?)', universeGalaxyId);
    log.info('Galaxy created', { universeGalaxyId, callerAccessId: callerAccess.authScopePattern });
    return { instanceName: universeGalaxyId };
  }

  /**
   * Create a Star IN-SESSION — admin-gated over the parent galaxy, `Scopes` row only, NO founder + NO
   * email (the admin already holds a session that reaches the new Star via wildcard reach). Mirrors
   * {@link createGalaxy} one tier down.
   */
  createStar(universeGalaxyStarId: string, callerAccess: AccessEntry): { instanceName: string } {
    let parsed;
    try { parsed = parseId(universeGalaxyStarId); }
    catch { throw new RegistryError(400, 'invalid_id', 'Invalid universeGalaxyStarId format'); }
    if (parsed.tier !== 'star') {
      throw new RegistryError(400, 'invalid_tier', 'create-star requires a 3-segment id (universe.galaxy.star)');
    }
    const parentGalaxy = `${parsed.universe}.${parsed.galaxy}`;
    if (!this.#hasAdminOverGalaxy(callerAccess, parentGalaxy)) {
      throw new RegistryError(403, 'forbidden', `Caller is not an admin of the parent galaxy "${parentGalaxy}"`);
    }
    if (this.checkSlugAvailable(parentGalaxy)) {
      throw new RegistryError(400, 'parent_not_found', `Parent galaxy "${parentGalaxy}" does not exist`);
    }
    if (!this.checkSlugAvailable(universeGalaxyStarId)) {
      throw new RegistryError(409, 'slug_taken', `Star "${universeGalaxyStarId}" is already claimed`);
    }
    this.ctx.storage.sql.exec('INSERT INTO Scopes (universeGalaxyStarId) VALUES (?)', universeGalaxyStarId);
    debug('nebula-auth.Registry.createStar').info('Star created in-session', { universeGalaxyStarId });
    return { instanceName: universeGalaxyStarId };
  }

  /**
   * The caller's manageable scope tree — every scope under their admin authority (Universe +
   * descendants), for the Scopes hierarchy view. Keyed on the verified admin SCOPE, NOT email:
   * `createGalaxy`/`createStar` register a scope with no member, so `discover` (email-keyed) wouldn't
   * surface a galaxy you just created; this reads `Scopes` directly. Flat list; the client nests by id.
   */
  myScopeTree(callerAccess: AccessEntry): AffectedScope[] {
    // ✅ SELF-CONFINING — the bare bit is safe here because it is not the authority decision; the
    // QUERY is. Every branch below is BOUNDED BY `authScopePattern`, so the result set can never
    // exceed the caller's own reach no matter what `admin` says: the `*` branch selects every scope
    // (correct — `*` reach IS every scope), and the other two bind `${prefix}` / `${pattern}`
    // (slugs are `[a-z0-9-]`, so no LIKE-wildcard widening via `_`/`%` is possible). The bit only decides
    // "is this principal an admin at all", and a non-admin gets `[]`. Confining it against a node
    // would be meaningless: this method has no callee node — it spans the caller's whole subtree.
    if (!callerAccess?.admin) return [];
    const pattern = callerAccess.authScopePattern;
    let rows: any[];
    if (pattern === '*') {
      rows = this.#sql`SELECT universeGalaxyStarId FROM Scopes`;
    } else if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      rows = this.#sql`SELECT universeGalaxyStarId FROM Scopes WHERE universeGalaxyStarId = ${prefix} OR universeGalaxyStarId LIKE ${prefix + '.%'}`;
    } else {
      rows = this.#sql`SELECT universeGalaxyStarId FROM Scopes WHERE universeGalaxyStarId = ${pattern}`;
    }
    return rows.map(r => this.#toAffected(r.universeGalaxyStarId as string));
  }

  // ============================================
  // Login channel — magic link (request + issue) + invites (issue)
  // ============================================

  /**
   * Request a login magic link (called by the Worker on `email-magic-link`, Turnstile-gated). Inserts
   * a `MagicLinks` row (token stored HASHED) for `(email, scope)` and sends the email. **Does NOT mint
   * an identity** — the load-bearing invariant: the unauthenticated login-request path must never
   * create membership. A stranger who requests a link for a scope they were never minted into gets a
   * link that fails at consume (`getAndVerifyIdentity` → no row → reject).
   */
  async requestMagicLink(email: string, universeGalaxyStarId: string, origin: string):
    Promise<{ message: string; magicLinkUrl?: string }> {
    // The Worker validates the email format before this RPC (Workers RPC drops custom Error props, so
    // client-error gates stay Worker-side) — here we just normalize + create the row.
    const lc = normalizeEmail(email);
    // Bootstrap authority point (the ONLY email-magic-link mint): a configured bootstrap email at the
    // reserved `nebula-platform` scope is minted platform-admin (idempotent) so it can log in and get a
    // `*` token. Gated to (bootstrap-config email, nebula-platform) — a NON-bootstrap email requesting
    // a link for nebula-platform gets NO mint, so stranger-self-join stays closed. `isBootstrap` is thus
    // scope-gated (§Blast radius).
    if (universeGalaxyStarId === PLATFORM_INSTANCE_NAME && this.#bootstrapEmails.includes(lc)) {
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO Scopes (universeGalaxyStarId) VALUES (?)', PLATFORM_INSTANCE_NAME);
      this.#mintIdentity(lc, PLATFORM_INSTANCE_NAME, /* isAdmin */ true, /* emailVerified */ false);
    }
    return this.#createMagicLinkAndSend(lc, universeGalaxyStarId, origin);
  }

  /** Insert a hashed `MagicLinks` row + send (or, in test mode, return) the magic link. */
  async #createMagicLinkAndSend(email: string, universeGalaxyStarId: string, origin: string):
    Promise<{ message: string; magicLinkUrl?: string }> {
    const lc = normalizeEmail(email); // MUST match the Identities normalization (m1) or verify won't find the row
    const rawToken = generateRandomString(32);
    const tokenHash = await hashString(rawToken);
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL * 1000).toISOString();
    this.ctx.storage.sql.exec(
      'INSERT INTO MagicLinks (tokenHash, email, universeGalaxyStarId, expiresAt) VALUES (?, ?, ?, ?)',
      tokenHash, lc, universeGalaxyStarId, expiresAt,
    );
    const magicLinkUrl =
      `${origin}${NEBULA_AUTH_PREFIX}/${universeGalaxyStarId}/magic-link?one_time_token=${rawToken}`;

    if (this.#isTestMode) {
      return { message: 'Magic link generated (test mode)', magicLinkUrl };
    }
    await this.#sendEmail({ type: 'magic-link', to: lc, magicLinkUrl });
    return { message: 'Check your email for the magic link' };
  }

  /**
   * Issue invites into an EXISTING scope. **Admin-gating is the Worker's job** (it verified the JWT +
   * scope + `admin` before calling — RPC drops custom Error props, so this method stays throw-free for
   * expected client errors). For each email: MINT the invitee `Identity` (`isAdmin=0`,
   * `emailVerified=0` — an authority point, pre-creating the "authorized member" row that
   * `getAndVerifyIdentity` will later find-and-flip) and insert a single-use `InviteTokens` row
   * (HASHED), then send the invite email. In test mode the raw links are returned instead of sent.
   */
  async issueInvites(
    universeGalaxyStarId: string, emails: string[], origin: string,
  ): Promise<{ invited: string[]; errors: Array<{ email: string; error: string }>; links?: Record<string, string> }> {
    const invited: string[] = [];
    const errors: Array<{ email: string; error: string }> = [];
    const links: Record<string, string> = {};

    for (const rawEmail of emails) {
      const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : '';
      if (!email || !isValidEmail(email)) {
        errors.push({ email: rawEmail, error: 'Invalid email format' });
        continue;
      }
      try {
        // Pre-create the invitee identity (idempotent on (email, scope)) — the authority point.
        this.#mintIdentity(email, universeGalaxyStarId, /* isAdmin */ false, /* emailVerified */ false);

        const rawToken = generateRandomString(32);
        const tokenHash = await hashString(rawToken);
        const expiresAt = new Date(Date.now() + INVITE_TTL * 1000).toISOString();
        this.ctx.storage.sql.exec(
          'INSERT INTO InviteTokens (tokenHash, email, universeGalaxyStarId, expiresAt) VALUES (?, ?, ?, ?)',
          tokenHash, email, universeGalaxyStarId, expiresAt,
        );
        const inviteUrl =
          `${origin}${NEBULA_AUTH_PREFIX}/${universeGalaxyStarId}/accept-invite?invite_token=${rawToken}`;

        if (this.#isTestMode) {
          links[email] = inviteUrl;
        } else {
          await this.#sendEmail({ type: 'invite-new', to: email, inviteUrl });
        }
        debug('nebula-auth.Registry.invite.sent').info('Invite sent', { email, universeGalaxyStarId });
        invited.push(email);
      } catch (error) {
        errors.push({ email, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    const result: { invited: string[]; errors: typeof errors; links?: Record<string, string> } =
      { invited, errors };
    if (this.#isTestMode) result.links = links;
    return result;
  }

  // ============================================
  // Token consume (Worker RPC) — validate login channel, write index + KV
  // ============================================

  /**
   * Consume a magic link (Worker-driven, on the click). Validates the `MagicLinks` row by hash,
   * find-and-flips the identity (rejects if none — the stranger-self-join guard), then records the
   * refresh token: `RefreshTokenIndex` FIRST (sync SQLite, single-writer), THEN the KV record
   * (index-first invariant M3 — an eviction at the awaited KV put leaves at worst a revocable
   * index-entry-without-KV-record, never a live-but-unindexed unrevocable token). The Worker supplies
   * the already-hashed refresh token (it holds the raw for the cookie). Magic links are reusable
   * within their TTL (scanner-safe) — not deleted on consume.
   *
   * @returns `{ sub, universeGalaxyStarId }` on success, or `null` when the link is invalid/expired or
   * no identity exists (the Worker maps `null` to a login-error redirect).
   */
  async consumeMagicLink(
    magicLinkTokenHash: string, refreshTokenHash: string, refreshExpiresAt: string,
  ): Promise<ConsumeResult | null> {
    const rows = this.#sql`
      SELECT email, universeGalaxyStarId, expiresAt FROM MagicLinks WHERE tokenHash = ${magicLinkTokenHash}
    `;
    if (rows.length === 0) return null;
    const link = rows[0];
    if (new Date().toISOString() > (link.expiresAt as string)) return null;

    const identity = this.getAndVerifyIdentity(link.email as string, link.universeGalaxyStarId as string);
    if (!identity) {
      debug('nebula-auth.Registry.login.rejected').warn('Magic link for non-member', {
        universeGalaxyStarId: link.universeGalaxyStarId, reason: 'no_identity',
      });
      return null;
    }
    await this.#recordRefreshToken(identity.sub, identity.universeGalaxyStarId, identity.isAdmin, identity.profileId, refreshTokenHash, refreshExpiresAt);
    debug('nebula-auth.Registry.login.succeeded').info('Magic link login', { targetSub: identity.sub });
    return { sub: identity.sub, universeGalaxyStarId: identity.universeGalaxyStarId };
  }

  /**
   * Consume an invite (Worker-driven, on the click). Validates + single-use-DELETES the `InviteTokens`
   * row, find-and-flips the pre-created invitee identity (rejects if none), records the refresh token
   * (index-first, then KV). Same shape as {@link consumeMagicLink} but single-use.
   */
  async consumeInvite(
    inviteTokenHash: string, refreshTokenHash: string, refreshExpiresAt: string,
  ): Promise<ConsumeResult | null> {
    const rows = this.#sql`
      SELECT email, universeGalaxyStarId, expiresAt FROM InviteTokens WHERE tokenHash = ${inviteTokenHash}
    `;
    if (rows.length === 0) return null;
    const invite = rows[0];
    // Single-use: delete regardless of expiry (a re-click can't replay it).
    this.ctx.storage.sql.exec('DELETE FROM InviteTokens WHERE tokenHash = ?', inviteTokenHash);
    if (new Date().toISOString() > (invite.expiresAt as string)) return null;

    const identity = this.getAndVerifyIdentity(invite.email as string, invite.universeGalaxyStarId as string);
    if (!identity) {
      debug('nebula-auth.Registry.login.rejected').warn('Invite for non-member', {
        universeGalaxyStarId: invite.universeGalaxyStarId, reason: 'no_identity',
      });
      return null;
    }
    await this.#recordRefreshToken(identity.sub, identity.universeGalaxyStarId, identity.isAdmin, identity.profileId, refreshTokenHash, refreshExpiresAt);
    debug('nebula-auth.Registry.login.succeeded').info('Invite accepted', { targetSub: identity.sub });
    return { sub: identity.sub, universeGalaxyStarId: identity.universeGalaxyStarId };
  }

  /** Index-first refresh-token record: `RefreshTokenIndex` (sync) FIRST, then the KV record (M3).
   *  Writer (a) of `profileId` into the KV record (the login funnel). */
  async #recordRefreshToken(
    sub: string, universeGalaxyStarId: string, isAdmin: boolean, profileId: string, tokenHash: string, expiresAt: string,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO RefreshTokenIndex (tokenHash, sub, expiresAt) VALUES (?, ?, ?)',
      tokenHash, sub, expiresAt,
    );
    const record: RefreshTokenKV = { sub, universeGalaxyStarId, isAdmin, expiresAt, profileId };
    await this.#refreshKv.put(`refresh:${tokenHash}`, JSON.stringify(record), {
      expirationTtl: kvTtlSeconds(expiresAt),
    });
  }

  /**
   * Logout / revoke (Worker-driven). Deletes the KV record + its `RefreshTokenIndex` entry. ⚠️ KV is
   * eventually consistent, so a revoked token keeps working for the KV-propagation window (~edge
   * cacheTtl) PLUS the full access-TTL — the short access-TTL is the mitigation (security.md).
   */
  async revokeRefreshToken(refreshTokenHash: string): Promise<void> {
    // KV-first, THEN the index row (matching #invalidateRefreshTokensForSub). For a DELETE this is the
    // correct ordering of the M3 invariant: an interruption after the KV delete leaves at worst an
    // orphaned index row (harmless — the token is already dead). The reverse (index-first) could strand
    // a live-but-UNindexed KV record that convergence/invalidation — which enumerate by index — can
    // never reach, so it would survive to its ~30-day TTL despite logout.
    await this.#refreshKv.delete(`refresh:${refreshTokenHash}`);
    this.ctx.storage.sql.exec('DELETE FROM RefreshTokenIndex WHERE tokenHash = ?', refreshTokenHash);
    debug('nebula-auth.Registry.token.revoked').warn('Logout', { method: 'logout' });
  }

  /**
   * Change an identity's admin bit and CONVERGE the denormalized `isAdmin` in every live KV refresh
   * record for that `sub` (the ADR-010 convergence writer). ⚠️ On the KV re-put, re-apply the record's
   * ORIGINAL absolute expiry (`RefreshTokenIndex.expiresAt`) — CF KV drops `expirationTtl` across a
   * put, so a fresh TTL would EXTEND a demoted user's token and omitting it would make it IMMORTAL (M4).
   */
  async setIdentityAdmin(sub: string, isAdmin: boolean): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE Identities SET isAdmin = ? WHERE sub = ?', isAdmin ? 1 : 0, sub);
    const scope = this.getIdentityScope(sub);
    if (!scope) return;
    const tokens = this.#sql`SELECT tokenHash, expiresAt FROM RefreshTokenIndex WHERE sub = ${sub}`;
    for (const t of tokens) {
      const record: RefreshTokenKV = {
        sub, universeGalaxyStarId: scope.universeGalaxyStarId, isAdmin, expiresAt: t.expiresAt as string,
        profileId: scope.profileId, // writer (b): re-put must carry profileId forward or the claim vanishes after an admin change
      };
      // Re-apply the ORIGINAL absolute expiry as the ttl — never a fresh TTL (M4).
      await this.#refreshKv.put(`refresh:${t.tokenHash as string}`, JSON.stringify(record), {
        expirationTtl: kvTtlSeconds(t.expiresAt as string),
      });
    }
    debug('nebula-auth.Registry.identity.roleUpdated').info('isAdmin converged', { sub, isAdmin, tokens: tokens.length });
  }

  // ============================================
  // Scope deletion — cascade teardown (plan + execute)
  // ============================================

  /**
   * Read-only deletion PLAN (feeds the confirm screen). `callerSub` is the caller's VERIFIED surrogate
   * sub (from the JWT — never client-supplied); the registry resolves it → email internally for the
   * cross-scope `#otherUsers` guard. Throws 403 if the caller isn't admin over the target, or if
   * `callerSub → email` resolves empty (fail CLOSED — M2). Mutates nothing.
   */
  planScopeDeletion(target: string, callerSub: string, callerAccess: AccessEntry): ScopeDeletionPlan {
    return this.#computeDeletionPlan(target, callerSub, callerAccess);
  }

  /**
   * Execute the cascade: re-verify admin + re-run the guard, then for each affected scope delete the
   * `Scopes` row, its `Identities`, their `RefreshTokenIndex` entries + KV refresh records, and the
   * scope's `MagicLinks` / `InviteTokens`. Returns the affected set so the Worker fans out platform-DO
   * `teardown()` (the registry can't reach platform DOs — dependency direction). Throws 403 / 409.
   */
  async executeScopeDeletion(
    target: string, callerSub: string, callerAccess: AccessEntry,
  ): Promise<{ affected: AffectedScope[] }> {
    const plan = this.#computeDeletionPlan(target, callerSub, callerAccess);
    if (plan.blockedBy.length > 0) {
      throw new RegistryError(
        409, 'scope_in_use',
        `Cannot delete: other users are attached to ${plan.blockedBy.map(b => b.instanceName).join(', ')}`,
      );
    }

    const log = debug('nebula-auth.Registry.executeScopeDeletion');
    for (const scope of plan.affected) {
      const name = scope.instanceName;
      // Invalidate every refresh token for every identity in this scope (KV + index), then drop rows.
      const subs = this.#sql`SELECT sub FROM Identities WHERE universeGalaxyStarId = ${name}`
        .map(r => r.sub as string);
      for (const sub of subs) await this.#invalidateRefreshTokensForSub(sub);
      this.ctx.storage.sql.exec('DELETE FROM Identities WHERE universeGalaxyStarId = ?', name);
      this.ctx.storage.sql.exec('DELETE FROM MagicLinks WHERE universeGalaxyStarId = ?', name);
      this.ctx.storage.sql.exec('DELETE FROM InviteTokens WHERE universeGalaxyStarId = ?', name);
      this.ctx.storage.sql.exec('DELETE FROM Scopes WHERE universeGalaxyStarId = ?', name);
    }

    log.info('Scope deleted', { target, callerSub, affected: plan.affected.map(a => a.instanceName) });
    return { affected: plan.affected };
  }

  /** Delete every refresh token for a `sub` — KV records first, then the index rows. */
  async #invalidateRefreshTokensForSub(sub: string): Promise<void> {
    const tokens = this.#sql`SELECT tokenHash FROM RefreshTokenIndex WHERE sub = ${sub}`;
    for (const t of tokens) await this.#refreshKv.delete(`refresh:${t.tokenHash as string}`);
    this.ctx.storage.sql.exec('DELETE FROM RefreshTokenIndex WHERE sub = ?', sub);
  }

  #computeDeletionPlan(target: string, callerSub: string, callerAccess: AccessEntry): ScopeDeletionPlan {
    if (target === PLATFORM_INSTANCE_NAME) {
      throw new RegistryError(400, 'reserved_slug', `"${PLATFORM_INSTANCE_NAME}" cannot be deleted`);
    }
    let parsed;
    try { parsed = parseId(target); }
    catch { throw new RegistryError(400, 'invalid_id', 'Invalid scope id'); }

    if (!this.#hasAdminOverScope(callerAccess, target)) {
      throw new RegistryError(403, 'forbidden', `Caller is not an admin of "${target}"`);
    }

    // Resolve the caller's own email (sub → email). ⚠️ Fail CLOSED on empty (M2): a just-removed admin
    // still inside their access-token window must not be able to wipe a shared scope by having their
    // exclusion match zero rows (→ "no other users" → wipe). Refuse rather than proceed.
    const callerEmailLc = this.#emailForSub(callerSub);
    if (!callerEmailLc) {
      throw new RegistryError(403, 'forbidden', 'Caller identity not found');
    }

    // Down: the target + all registered descendants.
    const down = this.#sql`
      SELECT universeGalaxyStarId FROM Scopes
      WHERE universeGalaxyStarId = ${target} OR universeGalaxyStarId LIKE ${target + '.%'}
    `.map(r => r.universeGalaxyStarId as string);

    if (!down.includes(target)) {
      return { affected: [], blockedBy: [] };
    }

    const blockedBy = this.#otherUsers(down, callerEmailLc);
    if (blockedBy.length > 0) {
      return { affected: down.map(n => this.#toAffected(n)), blockedBy };
    }

    // Prune up: wipe an ancestor iff the caller admins it AND it has no remaining registered
    // descendants outside the wipe set AND no other users. Admin coverage is monotonic up the tree.
    const wipe = new Set(down);
    let ancestor = getParentId(parsed);
    while (ancestor) {
      if (!this.#hasAdminOverScope(callerAccess, ancestor)) break;
      const isRegistered = !this.checkSlugAvailable(ancestor);
      if (isRegistered) {
        const childrenRemaining = this.#sql`
          SELECT universeGalaxyStarId FROM Scopes WHERE universeGalaxyStarId LIKE ${ancestor + '.%'}
        `.map(r => r.universeGalaxyStarId as string).filter(n => !wipe.has(n));
        if (childrenRemaining.length > 0) break;
        if (this.#otherUsers([ancestor], callerEmailLc).length > 0) break;
        wipe.add(ancestor);
      }
      ancestor = getParentId(parseId(ancestor));
    }

    const ancestors = [...wipe].filter(n => !down.includes(n));
    return { affected: [...down, ...ancestors].map(n => this.#toAffected(n)), blockedBy: [] };
  }

  #toAffected(universeGalaxyStarId: string): AffectedScope {
    const p = parseId(universeGalaxyStarId);
    return { instanceName: universeGalaxyStarId, tier: p.tier, isDev: p.tier === 'star' && p.star === 'dev' };
  }

  /** Identities in any of `scopes` whose email differs from the caller's — blockers to a delete. */
  #otherUsers(scopes: string[], callerEmailLc: string): ScopeDeletionBlocker[] {
    const out: ScopeDeletionBlocker[] = [];
    for (const name of scopes) {
      const rows = this.#sql`
        SELECT DISTINCT email FROM Identities WHERE universeGalaxyStarId = ${name} AND email != ${callerEmailLc}
      `;
      for (const r of rows) out.push({ instanceName: name, email: r.email as string });
    }
    return out;
  }

  // ============================================
  // Email
  // ============================================

  async #sendEmail(message: any): Promise<void> {
    const sender = (this.env as any).AUTH_EMAIL_SENDER;
    if (sender) {
      await sender.send(message);
    } else {
      debug('nebula-auth.Registry.email').debug('Email not sent (AUTH_EMAIL_SENDER not configured)', {
        type: message.type, to: message.to,
      });
    }
  }

  // ============================================
  // HTTP fetch handler — the router-forwarded endpoints
  // ============================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const prefix = NEBULA_AUTH_PREFIX;

    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const endpoint = url.pathname.slice(prefix.length + 1); // after '/auth/'

    try {
      switch (endpoint) {
        case 'discover': {
          const { email } = await request.json() as { email: string };
          return Response.json(this.discover(email));
        }
        case 'claim-universe': {
          const { slug, email } = await request.json() as { slug: string; email: string };
          return Response.json(await this.claimUniverse(slug, email, url.origin));
        }
        case 'create-galaxy': {
          const { universeGalaxyId, verifiedAccess } = await request.json() as {
            universeGalaxyId: string; verifiedAccess?: AccessEntry;
          };
          if (!verifiedAccess) {
            return Response.json({ error: 'invalid_request', error_description: 'Missing verified access claim' }, { status: 400 });
          }
          return Response.json(this.createGalaxy(universeGalaxyId, verifiedAccess), { status: 201 });
        }
        case 'create-star': {
          const { universeGalaxyStarId, verifiedAccess } = await request.json() as {
            universeGalaxyStarId: string; verifiedAccess?: AccessEntry;
          };
          if (!verifiedAccess) {
            return Response.json({ error: 'invalid_request', error_description: 'Missing verified access claim' }, { status: 400 });
          }
          return Response.json(this.createStar(universeGalaxyStarId, verifiedAccess), { status: 201 });
        }
        case 'my-scopes': {
          const { verifiedAccess } = await request.json() as { verifiedAccess?: AccessEntry };
          if (!verifiedAccess) {
            return Response.json({ error: 'invalid_request', error_description: 'Missing verified access claim' }, { status: 400 });
          }
          return Response.json({ scopes: this.myScopeTree(verifiedAccess) });
        }
        case 'delete-scope-plan': {
          const { target, verifiedAccess, callerSub } = await request.json() as {
            target: string; verifiedAccess?: AccessEntry; callerSub?: string;
          };
          if (!verifiedAccess || !callerSub) {
            return Response.json({ error: 'invalid_request', error_description: 'Missing verified caller identity' }, { status: 400 });
          }
          return Response.json(this.planScopeDeletion(target, callerSub, verifiedAccess));
        }
        case 'delete-scope': {
          const { target, verifiedAccess, callerSub } = await request.json() as {
            target: string; verifiedAccess?: AccessEntry; callerSub?: string;
          };
          if (!verifiedAccess || !callerSub) {
            return Response.json({ error: 'invalid_request', error_description: 'Missing verified caller identity' }, { status: 400 });
          }
          return Response.json(await this.executeScopeDeletion(target, callerSub, verifiedAccess));
        }
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (err) {
      if (err instanceof RegistryError) {
        return Response.json({ error: err.errorCode, error_description: err.message }, { status: err.status });
      }
      debug('nebula-auth.Registry.fetch').error('Unexpected error in registry fetch', { error: err });
      return Response.json({ error: 'internal_error', error_description: 'An unexpected error occurred' }, { status: 500 });
    }
  }

  // ============================================
  // Authorization helpers
  // ============================================

  // All three delegate to the ONE shared predicate (ADR-007 — one guard path, one place to audit).
  // They are kept as named private wrappers only because their call sites read better with the tier
  // named; none of them may reintroduce an inline `admin && matchAccess(...)`.

  /** Admin over `scope` iff the access claim is admin AND its pattern covers the scope. */
  #hasAdminOverScope(access: AccessEntry | undefined, scope: string): boolean {
    return hasAdminOverScope(access, scope);
  }

  /**
   * Admin over a universe. Delegates to the shared predicate: on a single dot-free segment
   * `matchAccess` reduces exactly to the three cases this used to hand-roll (`*`, `u.*`, exact `u`),
   * and its sole caller passes `parsed.universe`, which `isValidSlug` guarantees is dot-free.
   */
  #hasAdminOverUniverse(access: AccessEntry | undefined, universe: string): boolean {
    return hasAdminOverScope(access, universe);
  }

  /** Admin over a galaxy via the canonical hierarchy matcher (`*` / `u.*` / `u.g.*` / exact `u.g`). */
  #hasAdminOverGalaxy(access: AccessEntry | undefined, galaxyId: string): boolean {
    return hasAdminOverScope(access, galaxyId);
  }
}

/** Basic email format validation: non-empty local part, @, non-empty domain. */
function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const atIdx = email.indexOf('@');
  return atIdx > 0 && atIdx < email.length - 1;
}

/**
 * Canonical email normalization — lowercase AND trim. The single source of truth for the m1 invariant
 * (§The schema: "casing drift splits identities or fail-blocks a delete"). EVERY email that is stored,
 * looked up, or compared must pass through this: the registry compares email BINARY (UNIQUE(email,
 * scope), the getAndVerifyIdentity/discover WHERE clauses, the delete-scope #otherUsers exclusion), so
 * a stray leading/trailing space at mint that a trimmed login can't match would silently split an
 * identity and lock the founder out. Lowercasing alone is not enough — trim too.
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * KV `expirationTtl` (seconds-from-now) from an absolute ISO expiry. CF KV requires ≥ 60s; clamp up so
 * a near-expiry re-put doesn't throw. The absolute expiry is the source of truth (M4) — this only
 * translates it to the seconds-from-now KV wants at write time.
 */
function kvTtlSeconds(expiresAtIso: string): number {
  const seconds = Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000);
  return Math.max(60, seconds);
}

/** Structured error thrown by registry methods; callers convert to HTTP responses. */
export class RegistryError extends Error {
  status: number;
  errorCode: string;
  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.errorCode = errorCode;
  }
}
