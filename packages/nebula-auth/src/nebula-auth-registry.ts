/**
 * NebulaAuthRegistry — the ONE singleton DO that owns all durable auth state.
 *
 * Since tasks/archive/nebula-auth-surrogate-sub.md dissolved the per-scope `NebulaAuth` DO, this registry is
 * the **single writer** of everything: the `Scopes` existence registry, `Emails` + `Memberships` (surrogate-`sub`
 * identity, was `Emails` + `Subjects`), the `MagicLinks` / `InviteTokens` login channel, and the
 * `RefreshTokenIndex` (→ reliable KV invalidation). It also writes the Workers-KV refresh record
 * (`refresh:{tokenHash}`) — the ONE hot record, read at the edge by the default Worker on refresh,
 * never touching this DO.
 *
 * Two callers:
 * - **Worker router (`fetch` endpoints)**: discover / claim-universe / create-galaxy / create-star /
 *   scope-summary / expand-scope / delete-scope(-plan). The router pre-verifies JWT/Turnstile and injects the verified
 *   `access` claim + caller `sub`.
 * - **Worker token layer (raw RPC)**: requestMagicLink / issueInvites / resolveConsume /
 *   recordSessions / acceptMembership / revokeRefreshToken / getIdentityScope / setIdentityAdmin — the login-channel +
 *   refresh-token lifecycle. The Worker generates the raw refresh token (cookie) and passes only its
 *   hash; this DO writes the index + KV.
 *
 * Identity minting: `sub` is minted ONLY at mint points — Universe/Star claim + invite
 * issuance. Login **verify** (`resolveConsume`) find-and-flips EXISTING memberships and REJECTS
 * if none, so a minted token proves authorized membership by construction (the retired `adminApproved`
 * gate).
 *
 * @see tasks/archive/nebula-auth-surrogate-sub.md § The schema / The seam / Founder & pre-create
 */
import { debug } from '@lumenize/debug';
import { DurableObject } from 'cloudflare:workers';
import { SQLSchemaMigrations } from '@lumenize/sql-migrations';
import { generateRandomString, hashString } from '@lumenize/crypto';
import { REGISTRY_MIGRATIONS } from './schemas';
import {
  NEBULA_AUTH_PREFIX, PLATFORM_SCOPE, RESERVED_STAR_SLUGS, instanceAuthUrl, scopelessAuthUrl,
  SCOPELESS_INSTANCE_TAG, MAGIC_LINK_TTL, INVITE_TTL, REFRESH_TOKEN_TTL, SWEEP_INTERVAL_SECONDS,
  SCOPE_TREE_NODE_BUDGET, SIGNUP_TICKET_TTL,
} from './types';
import type {
  AccessEntry, EmailMessage, InviteMintResult, InviteeError, InviteeMintResult,
  ConsumeMembership, ConsumePlan, EmailScopes, InviteeRequest, InvitedByStamp, MagicLinkPurpose,
  ScopeNode, ScopeSummary, Tier,
  NebulaJwtPayload, RefreshTokenKV, SessionRecord,
} from './types';
import { parseId, isValidSlug, isPlatformScope, hasDominionOver } from './parse-id';
import { projectActingToken } from './access-claims';
import { reportUnconfiguredProtections } from './router';

/**
 * What a ticket-backed claim answers with. Refusals are values rather than throws — see
 * {@link NebulaAuthRegistry.claimUniverseWithTicket} for why the RPC boundary requires it.
 */
export type TicketClaimResult =
  | { ok: true; sub: string; universeGalaxyStarId: string }
  | { ok: false; reason: 'invalid_ticket' | 'invalid_slug' | 'reserved_slug' | 'slug_taken' };

/** One affected scope in a scope-deletion plan — enough for the client to teardown the right DOs. */
export interface AffectedScope {
  /** The scope id (universeGalaxyStarId). Kept named `instanceName` for the client/UI wire contract. */
  instanceName: string;
  /** 'universe' | 'galaxy' | 'star' — picks the tier DO binding to teardown. */
  tier: string;
  /** A `{u}.{g}.dev` authoring Star. Display-only since the Galaxy collapse — the brain's
   *  state dies with the GALAXY row's own teardown, so no extra per-dev teardown exists. */
  isDev: boolean;
}

/** One other user attached to an affected scope: a warning entry, NOT a blocker. */
export interface ScopeDeletionBlocker {
  instanceName: string;
  email: string;
}

/**
 * Who else loses access, for the confirm screen's warning. **Bounded** — deleting an active Star must
 * never shuttle every attached user's email across the wire.
 *
 * `total` and `sample` count the SAME population (distinct other-user emails across `affected`), so
 * `sample.length <= min(total, 25)`: a person attached to several affected scopes appears once, under
 * one representative scope.
 */
export interface ScopeDeletionAffectedUsers {
  /** Distinct other-user emails across every affected scope. */
  total: number;
  /** At most 25 of them, each with one scope they are attached to. */
  sample: ScopeDeletionBlocker[];
}

/** The read-only deletion plan that feeds the confirm screen. */
export interface ScopeDeletionPlan {
  /** The cascade set: target + descendants, wipe order. Deletion cascades DOWN only. */
  affected: AffectedScope[];
  /**
   * Who else is attached — a **warning, never a refusal**. Dominion flows downward (ADR-015): a
   * covering admin may delete any descendant, and restraint is the UI's job, not authorization's.
   */
  affectedUsers: ScopeDeletionAffectedUsers;
}

/** Result of a login-channel consume: the identity + scope the Worker needs to mint the JWT.
 *  `devSession` rides an invite consume whose co-minted `.dev` workspace membership was also
 *  taken up — the Worker sets a SECOND Path-scoped refresh cookie for it. */
export interface ConsumeResult {
  sub: string;
  universeGalaxyStarId: string;
  devSession?: { universeGalaxyStarId: string };
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

    // Sweep on wake AND arm the recurring tick. The wake call alone is not enough: its frequency is
    // INVERSELY correlated with load (a busy singleton is never evicted, so it never re-constructs)
    // while row accumulation is DIRECTLY correlated with it — so at the traffic where hygiene matters
    // it would stop firing entirely.
    this.#sweepAndRearm();

    // Boot-time signal for every protection that silently no-ops when its config is absent (the
    // limiter bindings, the Turnstile secret — the list lives beside the guards in router.ts). The
    // constructor is the once-per-lifetime hook that sees env; a busy singleton is never evicted,
    // so this fires as a deploy-time notice rather than a per-request one.
    reportUnconfiguredProtections(env);
  }

  /**
   * Storage hygiene for the three expiry-bearing token tables, plus the re-arm. **Never correctness:**
   * every row it deletes is already inert on lookup, because the consume/verify paths gate on
   * `expiresAt` regardless — so a missed tick costs disk, never behaviour.
   *
   * ⚠️ **Exactly three tables, and the omissions are deliberate. `Scopes`, `Emails` and `Memberships`
   * MUST NOT be swept**, and in particular not by the obvious predicate "no live activation path",
   * which is wrong three separate ways: (1) `createGalaxy`/`createStar` write a `Scopes` row and
   * nothing else, ever, so an admin-created scope matches such a predicate permanently — a
   * user-developer's Galaxy would vanish within the hour, with its slug freed; (2) it would delete the
   * un-taken-up membership `#resumeClaimIfOwner` reads, which is designed to work *after* the link
   * expires, locking a legitimate claimer out of their own slug; (3) sweeping `Emails` would dangle
   * the `emailId` every surviving membership references. Reclaiming a genuinely abandoned scope needs
   * a time-based abandonment TTL reaping scope + membership + address together, which is a product
   * policy and is deferred.
   *
   * ⚠️ **Zero KV operations, by construction.** `RefreshTokenIndex` rows are deleted here without
   * touching their KV records — which is safe ONLY because these rows are already expired, so no live
   * token loses its index. Deleting an *unexpired* row here would strand a live KV record with no
   * index, invisible to every future revoke; that is the invariant `#revokeByHashes` exists to hold,
   * and this method must not become a second, quieter way to break it.
   *
   * ⚠️ **No ADR-016 record, deliberately, and the reason is "no authority moves" — never "it is only
   * hygiene".** Nothing here is done on anyone's behalf: there is no acting principal to name, not
   * even a server-composed one, and no capability is removed from anyone since the rows were already
   * inert. If this sweep is ever widened to reap something a live path still reads, that reasoning
   * expires and the exclusion must be re-derived rather than inherited.
   *
   * The period follows storage accumulation, not a correctness deadline, so it is hourly rather than
   * minutes — 12× fewer singleton wake-ups than the 5-minute figure this started at (ADR-018).
   */
  #sweepAndRearm(): void {
    const nowIso = new Date().toISOString();
    // No index on `expiresAt`: reads are ~1/1000th the cost of a write, so on these small tables a
    // periodic scan is far cheaper than an index write on every insert.
    this.ctx.storage.sql.exec('DELETE FROM MagicLinks WHERE expiresAt < ?', nowIso);
    this.ctx.storage.sql.exec('DELETE FROM InviteTokens WHERE expiresAt < ?', nowIso);
    this.ctx.storage.sql.exec('DELETE FROM SignupTickets WHERE expiresAt < ?', nowIso);
    this.ctx.storage.sql.exec('DELETE FROM RefreshTokenIndex WHERE expiresAt < ?', nowIso);
    // Un-awaited on purpose: a DO storage write needs no await (the output gate orders it), and this
    // is called from a synchronous constructor. Re-armed unconditionally so the chain cannot lapse —
    // `setAlarm` overwrites, and a DO has exactly one alarm slot, so this is idempotent.
    void this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_SECONDS * 1000);
  }

  /** The recurring hygiene tick. Re-arms itself via `#sweepAndRearm`, so one alarm slot carries the
   *  whole chain — there is no second scheduled thing to multiplex against. */
  async alarm(): Promise<void> {
    this.#sweepAndRearm();
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
  // Identity minting — mint (mint points) + verify (find-and-flip)
  // ============================================

  /**
   * MINT a membership in a scope — an **mint-point-only** operation (Universe/Star claim + invite
   * issuance). Returns the surrogate `sub`. NEVER call from a login path.
   *
   * Find-or-create at BOTH levels, so it is idempotent twice over: an address that already exists keeps
   * its row — and therefore its `profileId` — and a membership that already exists is returned unchanged
   * with its `sub` preserved, so a re-issued invite or re-claim converges rather than duplicating.
   *
   * ⚠️ **There is deliberately no `emailVerified` parameter.** Under the split, proof of the mailbox is a
   * property of the ADDRESS and taking up a membership is per-MEMBERSHIP, so a mint has nothing to say
   * about either: a new address starts unproved, an existing one is left alone, and every new membership
   * starts un-taken-up. Passing a flag here is what would let an invite into a second scope silently
   * un-verify an address the person had already proved — the parameter's absence makes that impossible
   * rather than merely discouraged.
   *
   * Returns what the caller needs to name the outcome: `created` distinguishes a fresh membership
   * from the early-returned existing one, and for an existing row `scopeAdmin`/`accepted` report the
   * row's CURRENT state (the mint never touches either — promotion is `issueInvites`' explicit,
   * guarded call to {@link setIdentityAdmin}, never a side effect here).
   */
  #mintIdentity(
    email: string, universeGalaxyStarId: string, scopeAdmin: boolean, invitedBy?: InvitedByStamp,
  ): { sub: string; created: boolean; scopeAdmin: boolean; accepted: boolean } {
    const lc = normalizeEmail(email);
    const nowIso = new Date().toISOString();

    // The address row. `profileId` is real from the moment the row exists — no provisional state, no
    // promotion step, and no second path that could mint a competing id for the same address (ADR-010:
    // both ids are random opaque UUIDs, generated without coordination).
    const existingEmail = this.#sql`SELECT emailId FROM Emails WHERE email = ${lc}`;
    let emailId: string;
    if (existingEmail.length > 0) {
      emailId = existingEmail[0].emailId as string;
    } else {
      emailId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        'INSERT INTO Emails (emailId, email, profileId, emailVerified, createdAt) VALUES (?, ?, ?, 0, ?)',
        emailId, lc, crypto.randomUUID(), nowIso,
      );
    }

    const existing = this.#sql`
      SELECT sub, scopeAdmin, acceptedAt FROM Memberships
      WHERE emailId = ${emailId} AND universeGalaxyStarId = ${universeGalaxyStarId}
    `;
    if (existing.length > 0) {
      return {
        sub: existing[0].sub as string,
        created: false,
        scopeAdmin: Boolean(existing[0].scopeAdmin),
        accepted: existing[0].acceptedAt != null,
      };
    }

    const sub = crypto.randomUUID();
    // `acceptedAt` stays NULL: minting a membership is not taking it up. That NULL is what the Profile
    // DO's scoped-admin authz check keys on (ADR-012), so it is load-bearing, not bookkeeping.
    //
    // The `invitedBy*` columns are written HERE and never again — ADR-013's write-time-pinned
    // attribution. Their presence is also the consent modal's flavor discriminator: a stamped row was
    // created FOR this person by someone else, an unstamped one they created themselves.
    this.ctx.storage.sql.exec(
      `INSERT INTO Memberships
         (sub, emailId, universeGalaxyStarId, scopeAdmin, acceptedAt, createdAt,
          invitedBySub, invitedByName, invitedByProfileId)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      sub, emailId, universeGalaxyStarId, scopeAdmin ? 1 : 0, nowIso,
      invitedBy?.sub ?? null, invitedBy?.name ?? null, invitedBy?.profileId ?? null,
    );
    debug('nebula-auth.Registry.identity.minted').info('Membership minted', {
      sub, emailId, universeGalaxyStarId, email: lc, scopeAdmin,
    });
    return { sub, created: true, scopeAdmin, accepted: false };
  }

  // ⚠️ `getAndVerifyIdentity(email, scope)` lived here and is GONE. It looked up ONE membership and
  // flipped the mailbox-proof flag; `resolveConsume` replaced it in the same build by reading EVERY
  // membership of the address (mint-all needs the whole set) and doing the same guarded flip. It sat
  // here afterwards compiling, green, and called by nothing but its own two unit tests — the shape
  // that is normally found only when the next task trips over it.

  /**
   * Re-point an ADDRESS to a new one — a single-row, single-column UPDATE on `Emails`, however many
   * scopes that address holds memberships in. Nothing keys or FKs on an address, so there is no cascade,
   * no re-key, and no token re-issue; refresh records are `sub`-anchored and survive.
   *
   * ⚠️ **This is the PRIMITIVE, not the email-change flow.** It performs no authorization and no
   * revocation, and it has no production caller. The flow that will eventually call it requires fresh
   * proof of the OLD address (a live session is not sufficient — sessions outlive mailbox control) and
   * revokes on its own schedule; its pinned contract is the skipped block in `email-mutable.test.ts`.
   * Do not expose this method as an endpoint without building that.
   *
   * Returns `false` if the sub is unknown.
   */
  changeEmail(sub: string, newEmail: string, callerClaims: NebulaJwtPayload): boolean {
    const rows = this.#sql`SELECT emailId FROM Memberships WHERE sub = ${sub}`;
    if (rows.length === 0) return false;
    this.ctx.storage.sql.exec(
      'UPDATE Emails SET email = ? WHERE emailId = ?', normalizeEmail(newEmail), rows[0].emailId as string,
    );
    // ADR-016: a re-point changes which mailbox holds the authority for every scope this address
    // touches. ⚠️ The parameter is REQUIRED even though nothing calls this yet — that is the point:
    // whoever builds the flow cannot forget it, because omitting it will not compile.
    debug('nebula-auth.Registry.identity.emailChanged').info('Email changed', {
      sub, actingToken: projectActingToken(callerClaims),
    });
    return true;
  }

  /** Resolve a `sub` → its scope + admin bit + `profileId`. `null` if unknown. Used by the refresh
   *  KV-miss self-heal, the `scopeAdmin` convergence re-put, and mint-narrower-token — each threads
   *  `profileId` into the record it rebuilds so the claim survives. */
  /**
   * The consent modal's inputs for ONE membership, by its `sub`.
   *
   * ⚠️ **Home cannot get these from the summary, and that is the whole reason this exists.** The
   * summary needs a Bearer token; a token needs a refresh; and a refresh REFUSES an unaccepted
   * membership by design — which is precisely the membership the modal is for. A claim or invite 302
   * lands on Home holding exactly one inert cookie, so without this the screen that exists to take
   * consent could never render the thing it takes consent for. (The bootstrap order in the design
   * predates inert-until-accepted; the two clauses collide, and this is the seam.)
   *
   * Deliberately NARROW: the flavour discriminator and the sender-supplied display name, nothing
   * else. The caller is authenticated by the membership's own path-scoped cookie, which reached that
   * browser only via a click on mail delivered to the address — so it tells its holder only what the
   * modal is about to show them.
   */
  getMembershipCard(sub: string):
    { universeGalaxyStarId: string; accepted: boolean; invited?: boolean; invitedByName?: string } | null {
    const rows = this.#sql`
      SELECT universeGalaxyStarId, acceptedAt, invitedBySub, invitedByName
      FROM Memberships WHERE sub = ${sub}`;
    if (rows.length === 0) return null;
    return {
      universeGalaxyStarId: rows[0].universeGalaxyStarId as string,
      accepted: rows[0].acceptedAt != null,
      // `invited` is the flavour discriminator and is a BOOLEAN on purpose — see `ScopeNode.invited`.
      // The name is decoration on top of it and may legitimately be absent.
      ...(rows[0].invitedBySub != null
        ? { invited: true, invitedByName: (rows[0].invitedByName as string | null) ?? undefined }
        : {}),
    };
  }

  getIdentityScope(sub: string): { universeGalaxyStarId: string; scopeAdmin: boolean; profileId: string } | null {
    // Entry marker: a refused-at-the-edge caller must never reach this read (the mint's non-admin
    // refusal happens before dispatch), and a 403 looks identical either way — tests assert the
    // absence of this line through the debug sink.
    debug('nebula-auth.Registry.getIdentityScope').debug('subject lookup', { sub });
    const rows = this.#sql`
      SELECT m.universeGalaxyStarId AS universeGalaxyStarId, m.scopeAdmin AS scopeAdmin, e.profileId AS profileId
      FROM Memberships m JOIN Emails e ON e.emailId = m.emailId WHERE m.sub = ${sub}
    `;
    if (rows.length === 0) return null;
    return {
      universeGalaxyStarId: rows[0].universeGalaxyStarId as string,
      scopeAdmin: Boolean(rows[0].scopeAdmin),
      profileId: rows[0].profileId as string,
    };
  }

  /**
   * Defensive refresh-path fallback for a Worker KV **miss** (NOT the normal path — the Worker reads KV
   * directly on refresh). Workers KV is eventually consistent, so on the login→first-refresh hop a
   * cross-colo read can miss the just-written record; the singleton `RefreshTokenIndex` is
   * strongly-consistent, so reconstruct the record from it (+ the current membership row, which gives
   * the CURRENT `scopeAdmin`/scope — fresher than a stale KV copy) and **self-heal KV** (re-put, so
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
      sub, universeGalaxyStarId: scope.universeGalaxyStarId, scopeAdmin: scope.scopeAdmin, expiresAt,
      profileId: scope.profileId, // writer (c): self-heal must carry profileId or the claim vanishes for the token's life
      // ⚠️ DERIVED from the membership row, never carried over from a stale copy and never written
      // back into `Memberships`. This arm is a reader: it reconstructs what the KV record should say,
      // so acceptance keeps exactly one writer on both the hit and the miss path.
      accepted: this.#isAccepted(sub),
    };
    await this.#refreshKv.put(`refresh:${tokenHash}`, JSON.stringify(record), { expirationTtl: kvTtlSeconds(expiresAt) });
    debug('nebula-auth.Registry.token.kvSelfHeal').info('refresh KV record reconstructed on miss', { sub });
    return record;
  }

  /**
   * Reverse lookup: the DISTINCT scopes a `profileId` spans (via `idx_Emails_profileId`) — the Profile
   * DO's scoped-admin authz check (`requireOwnerOrAdmin`). One `profileId` can span several addresses
   * and each address several scopes, so this can return many.
   *
   * ⚠️ **ONLY ACCEPTED memberships count — `acceptedAt IS NOT NULL` is load-bearing AUTHZ here, not a
   * tidy-up.** Without it, dominion over a profile can be MANUFACTURED, and a profile is a
   * *global* object: claim a Universe (unauthenticated, Turnstile only) → invite any address you can
   * guess → you now "administer a scope that profile touches" → the Profile DO's scoped-admin branch
   * hands you write on their public fields and read/write on their private ones. `acceptedAt` is
   * written only by {@link acceptMembership}, reached solely through the consent modal
   * delivered to the address — so it is proof of the mailbox, which no attacker can forge for someone
   * else's address. An invited-but-never-accepted membership has no value there, so it confers nothing.
   *
   * ⚠️ **Do NOT swap this predicate for `Emails.emailVerified`.** They are not interchangeable: the
   * address is proved once and globally, so `emailVerified` would count every scope a person was ever
   * *invited* into once they had proved the mailbox anywhere — which is exactly the manufactured
   * dominion this guard exists to refuse. See ADR-012, and the manufacture test in
   * `identity-mint-point.test.ts`, which reds if the predicate is dropped or swapped.
   *
   * ⚠️ RETURNS PLAIN DATA — `[]` for an unknown/absent profileId, and NEVER throws a status-carrying
   * error: custom-error own-props are dropped across raw Workers RPC (raw-comm.md § Errors). The two
   * outcomes land on DIFFERENT Profile-DO denial paths — `[]` leaves the dominion predicate matching
   * nothing (the does-not-cover refusal); only a REJECT trips its fail-closed catch.
   */
  getScopesForProfile(profileId: string): string[] {
    const rows = this.#sql`
      SELECT DISTINCT m.universeGalaxyStarId AS universeGalaxyStarId
      FROM Emails e JOIN Memberships m ON m.emailId = e.emailId
      WHERE e.profileId = ${profileId} AND m.acceptedAt IS NOT NULL
    `;
    return rows.map(r => r.universeGalaxyStarId as string);
  }

  /** The normalized address behind a `sub`, or `null` — an indexed lookup, never a key. */
  #emailForSub(sub: string): string | null {
    const rows = this.#sql`
      SELECT e.email AS email FROM Memberships m JOIN Emails e ON e.emailId = m.emailId WHERE m.sub = ${sub}
    `;
    return rows.length > 0 ? (rows[0].email as string) : null;
  }

  // ============================================
  // Existence
  // ============================================

  // ⚠️ `discover(email)` lived here and is GONE. It answered, to anyone who asked and without any
  // proof of the address, which scopes an address belonged to and which it administered — and at the
  // galaxy and universe tiers membership IS administration, while at `nebula-platform` it is
  // superuser-ship. Nothing replaces it: the question is now answered only behind a session, by
  // `getScopeSummary`, and a login no longer needs to ask it at all because the click proves the
  // mailbox first.

  /** Whether a scope id is available (no `Scopes` row). Existence is a `Scopes` fact, NOT derived
   *  from membership — a parent-managed child scope has a row here and zero members. */
  checkSlugAvailable(universeGalaxyStarId: string): boolean {
    const rows = this.#sql`SELECT 1 FROM Scopes WHERE universeGalaxyStarId = ${universeGalaxyStarId}`;
    return rows.length === 0;
  }

  // ============================================
  // Scope creation — claim (identity-minting self-signup) + create (admin, scope-only)
  // ============================================

  /**
   * Universe self-signup (open, Turnstile-gated at the Worker). Registers the `Scopes` row, mints
   * the claiming admin identity via `#mintIdentity` — an `Emails` row for a new address plus the
   * `Memberships` row (`scopeAdmin=1`; a new address starts `emailVerified=0` and the claimer proves
   * it via the magic link, which find-and-flips `emailVerified`) — and issues a magic link. A mint
   * point — this is where a Universe's first admin identity is minted.
   *
   * ⚠️ Self-signup idempotency (mints the scope itself, so `Memberships`' `UNIQUE (emailId,
   * universeGalaxyStarId)` can't backstop a double-submit) is deferred for pre-alpha — the planned
   * fix is a pending-signup single-flight keyed on the address alone; the empty `it.skip` stub in
   * `test/identity-mint-point.test.ts` marks the hole.
   */
  async claimUniverse(slug: string, email: string, origin: string):
    Promise<{ message: string; magicLinkUrl?: string }> {
    const log = debug('nebula-auth.Registry.claimUniverse');
    // Hash FIRST — see the ordering pin above `#prepareMagicLink`. No `await` may sit between the
    // checks below and the write.
    const link = await this.#prepareMagicLink();

    if (!isValidEmail(email)) throw new RegistryError(400, 'invalid_email', 'Invalid email format');
    if (!isValidSlug(slug)) throw new RegistryError(400, 'invalid_slug', 'Invalid universe slug format');
    if (slug === PLATFORM_SCOPE) {
      throw new RegistryError(400, 'reserved_slug', `"${PLATFORM_SCOPE}" is reserved`);
    }
    if (!this.checkSlugAvailable(slug)) {
      // ⚠️ **The same-address RESUME, which `claimStar` has always had and this path did not.** The
      // affordance names the workspace and derives the slug from that name, so a double-click posts
      // the SAME slug twice — and a bare 409 would tell a brand-new user their workspace is "already
      // claimed" by themselves. Resuming re-sends the link to an unfinished claim's own claimer; a
      // DIFFERENT address still gets the conflict, so a pending claim cannot be taken over. (m6's
      // convergence covers the other double-submit shape: two different slugs.)
      if (this.#resumeClaimIfOwner(slug, normalizeEmail(email), link, origin, log)) {
        // The link row is written and (outside test mode) the mail is on its way — answer exactly as
        // a first claim does, so the caller cannot tell a resume from an original.
        return this.#isTestMode
          ? { message: 'Magic link generated (test mode)', magicLinkUrl: this.#magicLinkUrl(link.rawToken, slug, origin) }
          : { message: 'Check your email for the magic link' };
      }
      throw new RegistryError(409, 'slug_taken', `Universe "${slug}" is already claimed`);
    }

    const lc = normalizeEmail(email);
    // Scope row + admin-identity mint + claim link, atomically. ⚠️ Defence-in-depth, NOT a fix for a shipped
    // bug: the orphan-`Scopes` row this guards is not currently reachable (`#mintIdentity` pre-checks
    // its only UNIQUE and returns the existing `sub`; `sub`/`profileId` are fresh UUIDs), so there is
    // no reachable throw between the writes. It is wrapped because the ordering split touches this
    // path anyway, and leaving one of three sibling write-paths unwrapped is the inconsistency the
    // design rejects.
    this.ctx.storage.transactionSync(() => {
      // No ON CONFLICT: checkSlugAvailable proved no row exists and there's no await between —
      // surface a UNIQUE conflict loudly if that invariant is ever violated (slug is not secret).
      try {
        this.ctx.storage.sql.exec('INSERT INTO Scopes (universeGalaxyStarId) VALUES (?)', slug);
      } catch (err) {
        log.error('Universe INSERT conflicted unexpectedly — checkSlugAvailable invariant violated', {
          slug, error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      // MINT the claiming admin identity (mint point). A bootstrap email founding `nebula-platform` is
      // the reserved platform-admin path — same scopeAdmin stamp, distinguished only by the reserved slug.
      this.#mintIdentity(email, slug, /* scopeAdmin */ true);
      this.#insertMagicLinkRow(link.tokenHash, lc, slug, 'claim', link.expiresAt);
    });
    log.info('Universe claimed', { slug, email: lc });

    return this.#deliverMagicLink(link.rawToken, lc, slug, origin);
  }

  /**
   * Issue a signup ticket for an address whose mailbox was just proved.
   *
   * Called from the consume when the plan resolves to zero memberships: the person is new, so there
   * is nothing to enter and nowhere to send them but the slug screen. The ticket is what makes that
   * screen's claim legal without a second email.
   *
   * Returns the RAW ticket — the only time it exists in plaintext, exactly as the magic-link and
   * invite channels do. The caller puts it in a short-lived cookie and never stores it.
   */
  async issueSignupTicket(email: string): Promise<string> {
    const rawTicket = generateRandomString(32);
    const ticketHash = await hashString(rawTicket);
    const expiresAt = new Date(Date.now() + SIGNUP_TICKET_TTL * 1000).toISOString();
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO SignupTickets (ticketHash, email, expiresAt) VALUES (?, ?, ?)',
      ticketHash, normalizeEmail(email), expiresAt,
    );
    debug('nebula-auth.Registry.signup.ticketIssued').info('Signup ticket issued', { email: normalizeEmail(email) });
    return rawTicket;
  }

  /**
   * Claim a universe by spending a signup ticket — the fallback slug screen's engine.
   *
   * ⚠️ **This claim SENDS NO LINK, and that is the point.** `claimUniverse` mails one because it is
   * reached by a stranger who has proved nothing. Here the ticket *is* the proof: it was issued
   * minutes ago to a click on mail that reached this address, so mailing again would be the second
   * email the prove-then-choose design exists to delete. The identity is minted and the caller mints
   * a session against the returned `sub` directly.
   *
   * ⚠️ **The address comes from the TICKET ROW, never from a parameter** — there is deliberately no
   * `email` argument to get wrong. A body-supplied address would let anyone holding any ticket claim
   * a workspace in someone else's name, which is the whole attack this shape forecloses.
   *
   * Single-use: the row is deleted in the same transaction as the claim, so a replayed ticket finds
   * nothing. A slug already claimed by this same address resolves rather than conflicting — reachable
   * when a person holding two tickets submits the same name from two tabs — while a different address
   * still gets the conflict.
   *
   * ⚠️ **Refusals are RETURNED, never thrown, and that is not a style choice.** This is called over
   * raw Workers RPC, which drops a custom error's own properties — `name` and `message` survive, a
   * `status` does not — so a thrown `RegistryError` reaches the Worker stripped of everything that
   * distinguishes "this ticket expired" from "the database is on fire", and the router's catch-all
   * answers 500 for both. `raw-comm.md` § *Errors over raw Workers RPC* states the rule: expected
   * client-errors come back as values and the Worker maps them to statuses; a throw here means a
   * genuine 500. Bit during this method's own first run — every negative test returned 500.
   */
  async claimUniverseWithTicket(ticketHash: string, slug: string): Promise<TicketClaimResult> {
    const log = debug('nebula-auth.Registry.claimUniverseWithTicket');
    const rows = this.#sql`
      SELECT email, expiresAt FROM SignupTickets WHERE ticketHash = ${ticketHash}`;
    // One refusal for absent and expired alike: both mean "this ticket buys nothing", and telling
    // them apart would let a caller probe which hashes exist.
    if (rows.length === 0 || (rows[0].expiresAt as string) < new Date().toISOString()) {
      return { ok: false, reason: 'invalid_ticket' };
    }
    const lc = rows[0].email as string;

    if (!isValidSlug(slug)) return { ok: false, reason: 'invalid_slug' };
    if (slug === PLATFORM_SCOPE) return { ok: false, reason: 'reserved_slug' };
    if (!this.checkSlugAvailable(slug)) {
      // The same-address resume `claimUniverse` grew, minus the re-send it has no link for: this
      // caller already holds the pending claim, so hand back its identity and let them in.
      const mine = this.#sql`
        SELECT m.sub AS sub FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
        WHERE e.email = ${lc} AND m.universeGalaxyStarId = ${slug}`;
      if (mine.length > 0) {
        this.ctx.storage.sql.exec('DELETE FROM SignupTickets WHERE ticketHash = ?', ticketHash);
        log.info('Signup claim resumed by its own claimer', { slug, email: lc });
        return { ok: true, sub: mine[0].sub as string, universeGalaxyStarId: slug };
      }
      return { ok: false, reason: 'slug_taken' };
    }

    let sub!: string;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO Scopes (universeGalaxyStarId) VALUES (?)', slug);
      sub = this.#mintIdentity(lc, slug, /* scopeAdmin */ true).sub;
      this.ctx.storage.sql.exec('DELETE FROM SignupTickets WHERE ticketHash = ?', ticketHash);
    });
    log.info('Universe claimed via signup ticket', { slug, email: lc });
    return { ok: true, sub, universeGalaxyStarId: slug };
  }

  /**
   * **Open Star self-signup** — a stranger becomes the star-scoped admin of a Star inside someone else's Galaxy,
   * with no admin in the loop. A MINT POINT: this is where a Star's star-scoped admin identity is minted.
   *
   * That openness is the product, not a defect to engineer away. A star-scoped admin holds the **star's
   * own scope** as their `authScope`, which `hasDominionOver` makes inert at every ancestor (ADR-015: dominion
   * flows strictly downward), so a squatter gains a slug and nothing else — and a covering admin can
   * delete the squatted Star. **Do not add an approval step, invite code, or per-Galaxy on/off switch.**
   *
   * ⚠️ **Not a `claimUniverse` copy.** It is open and identity-minting like `claimUniverse`, but nests
   * under an existing Galaxy like `createStar`. Three divergences are load-bearing security, each with
   * its own test: the **parent-exists** check (without it, an unauthenticated caller writes star admins
   * under galaxies that never existed — including fully-orphan stars no covering admin can remediate);
   * the **reserved-slug** reject (without it, a stranger founds the user-developer's own `.dev` Studio
   * workspace and can wipe it); and minting at the **3-segment star id** (minting at the universe
   * scope would put `{u}` in their claim — a universe admin wearing a star's name; the confinement
   * *enforces* a scope, it does not *validate* it).
   *
   * ⚠️ Turnstile is NOT applied here — the gate is `turnstileGuard`, a step in this route's entry
   * in `router.ts`'s route table, which this method never touches. Dropping that step from the
   * `claim-star` row silently ships an ungated open mutation endpoint that mints identities and
   * sends mail — the behavioural gating sweep in `turnstile-bypass.test.ts` is what reds on it.
   *
   * @param origin  read off the forwarded request by `fetch()`, never client-supplied — it builds the
   *                emailed link, so a client-controlled value would be an open-redirect vector.
   * @throws RegistryError 400 `invalid_email` | `invalid_id` | `invalid_tier` | `reserved_slug` |
   *         `parent_not_found`, 409 `slug_taken` — first failure wins, in that order.
   */
  async claimStar(universeGalaxyStarId: string, email: string, origin: string):
    Promise<{ message: string; magicLinkUrl?: string }> {
    const log = debug('nebula-auth.Registry.claimStar');
    // Hash FIRST — see the ordering pin above `#prepareMagicLink`. Keeping the only `await` ahead of
    // the checks is what stops the input gate from opening between `checkSlugAvailable` and the
    // INSERT, which would make the slug check a TOCTOU window on an unauthenticated endpoint.
    const link = await this.#prepareMagicLink();

    // ── Fail-fast validation, in the pinned order. First failure wins; the rest never run. ──
    // Multi-error UX is the CLIENT's job (the signup page format-validates before it POSTs), which
    // leaves `slug_taken` as the one realistic server-side error for a well-behaved client.
    if (!isValidEmail(email)) throw new RegistryError(400, 'invalid_email', 'Invalid email format');

    let parsed;
    try { parsed = parseId(universeGalaxyStarId); }
    catch { throw new RegistryError(400, 'invalid_id', 'Invalid universeGalaxyStarId format'); }
    if (parsed.tier !== 'star') {
      throw new RegistryError(400, 'invalid_tier', 'claim-star requires a 3-segment id (universe.galaxy.star)');
    }

    // Reserved BEFORE parent-exists: a reserved slug is reserved whether or not its parent is real,
    // and reporting `reserved_slug` there tells the truth about why it can never be claimed.
    if (RESERVED_STAR_SLUGS.has(parsed.star!)) {
      throw new RegistryError(400, 'reserved_slug', `"${parsed.star}" is a reserved environment name`);
    }

    // Parent-exists — an integrity check, NOT an admin gate (mirrors `createStar`). Note the
    // un-negated call: the slug being AVAILABLE is what proves the parent absent.
    const parentGalaxy = `${parsed.universe}.${parsed.galaxy}`;
    if (this.checkSlugAvailable(parentGalaxy)) {
      throw new RegistryError(400, 'parent_not_found', `Parent galaxy "${parentGalaxy}" does not exist`);
    }

    const lc = normalizeEmail(email);
    if (!this.checkSlugAvailable(universeGalaxyStarId)) {
      this.#resumeClaimIfOwner(universeGalaxyStarId, lc, link, origin, log);
      throw new RegistryError(409, 'slug_taken', `Star "${universeGalaxyStarId}" is already claimed`);
    }

    // Scope row + admin-identity mint + claim link, atomically — no `await` inside.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO Scopes (universeGalaxyStarId) VALUES (?)', universeGalaxyStarId);
      // MINT the star-scoped admin at the FULL 3-segment star id — the scope stored HERE is verbatim
      // what the token's `authScope` becomes, so this row is the whole of the admin's dominion.
      // Passing `parsed.universe` here would silently hand them the entire Universe.
      this.#mintIdentity(lc, universeGalaxyStarId, /* scopeAdmin */ true);
      this.#insertMagicLinkRow(link.tokenHash, lc, universeGalaxyStarId, 'claim', link.expiresAt);
    });
    log.info('Star claimed', { universeGalaxyStarId, email: lc });

    return this.#deliverMagicLink(link.rawToken, lc, universeGalaxyStarId, origin);
  }

  /**
   * The resumable claim: when the slug is taken by a claimer who never finished (link lost, failed, or
   * expired), re-send their link — **by email only**. Synchronous by construction; the caller throws
   * `slug_taken` immediately after, whether or not this fired.
   *
   * ⚠️ **The response must be identical either way.** Answering a resume with a fresh-claim-shaped
   * success would turn success-vs-`slug_taken` into an email-confirmation oracle: probe a slug with a
   * throwaway address → `slug_taken`; probe with `victim@corp.com` → success proves the victim is that
   * slug's unverified claimer, and mails them. Keeping the body identical leaves the email as the only
   * channel, and it reaches the real owner.
   *
   * ⚠️ **The send is fired, never awaited.** Only this branch would have an external hop to wait on, so
   * awaiting it makes the resume a *timing* oracle recovering exactly the bit the identical body hides.
   * Its rejection is caught here so it can't surface as an unhandled rejection. (Guaranteed delivery —
   * outbox/retries — is deferred: `tasks/backlog.md` § internal email reliability.)
   *
   * ⚠️ **Writes ONLY a `MagicLinks` row — never a membership UPDATE.** The `scopeAdmin = 1` clause
   * keeps ordinary (non-admin) pending invitees out of the resume — and "resuming" one by setting
   * `scopeAdmin = 1` would promote an invitee to star admin through an unauthenticated endpoint.
   * A pending ADMIN invitee (`issueInvites` can mint `scopeAdmin=1` under the inviter's dominion)
   * does match the predicate now, and that is fine on both counts this guard exists for: the resume
   * performs no UPDATE, and the re-sent login link reaches only that invitee's own mailbox —
   * granting nothing their unclicked invite link doesn't already.
   *
   * ⚠️ The unfinished-claim test is `acceptedAt IS NULL` — "was this membership ever taken up?" — NOT
   * whether the mailbox was proved. Those are different questions now, and this one is per-membership:
   * a claimer who had proved the same address in some *other* scope must still be able to resume here.
   * That is precisely the case the pre-split single column could not express.
   */
  #resumeClaimIfOwner(
    universeGalaxyStarId: string,
    lcEmail: string,
    link: { rawToken: string; tokenHash: string; expiresAt: string },
    origin: string,
    log: ReturnType<typeof debug>,
  ): boolean {
    const claimer = [...this.ctx.storage.sql.exec(
      `SELECT m.sub AS sub FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
       WHERE e.email = ? AND m.universeGalaxyStarId = ? AND m.scopeAdmin = 1 AND m.acceptedAt IS NULL`,
      lcEmail, universeGalaxyStarId,
    )];
    if (claimer.length === 0) return false; // not the unverified claimer — an ordinary slug_taken, no mail

    this.#insertMagicLinkRow(link.tokenHash, lcEmail, universeGalaxyStarId, 'claim', link.expiresAt);
    if (this.#isTestMode) return true; // same short-circuit as #deliverMagicLink; never leak the URL here
    void this.#sendEmail({
      type: 'magic-link',
      to: lcEmail,
      instanceName: universeGalaxyStarId,
      magicLinkUrl: this.#magicLinkUrl(link.rawToken, universeGalaxyStarId, origin),
    }).catch((err) => {
      log.error('Resume magic-link send failed', {
        universeGalaxyStarId, error: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  }

  /**
   * Create a galaxy IN-SESSION — admin-gated, `Scopes` rows only, NO identity minted + NO email. The
   * parent-Universe admin manages the new galaxy via their dominion from `{u}` (§Founder — no local
   * admin stamped). Caller (Worker) pre-verifies the JWT and passes the verified access claim.
   *
   * **Every galaxy is BORN WITH its `{galaxy}.dev` workspace star** — both rows in one
   * synchronous body, so a galaxy without a dev workspace is structurally impossible.
   * (It used to be two client calls, `createGalaxy` then create-star, with a client-side
   * lazy repair for the window where the second never landed — the first-app-is-broken
   * failure shape.) Deliberately NO membership at `.dev`: the creator's dominion from the
   * parent IS the access; a founding row would copy structural authority.
   */
  createGalaxy(universeGalaxyId: string, callerAccess: AccessEntry): { instanceName: string } {
    const log = debug('nebula-auth.Registry.createGalaxy');
    let parsed;
    try { parsed = parseId(universeGalaxyId); }
    catch { throw new RegistryError(400, 'invalid_id', 'Invalid universeGalaxyId format'); }
    if (parsed.tier !== 'galaxy') {
      throw new RegistryError(400, 'invalid_tier', 'create-galaxy requires a 2-segment id (universe.galaxy)');
    }
    if (!this.#hasDominionOverUniverse(callerAccess, parsed.universe)) {
      throw new RegistryError(403, 'forbidden', 'Caller does not have admin access to the parent universe');
    }
    if (this.checkSlugAvailable(parsed.universe)) {
      throw new RegistryError(400, 'parent_not_found', `Parent universe "${parsed.universe}" does not exist`);
    }
    if (!this.checkSlugAvailable(universeGalaxyId)) {
      throw new RegistryError(409, 'slug_taken', `Galaxy "${universeGalaxyId}" is already claimed`);
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO Scopes (universeGalaxyStarId) VALUES (?)', universeGalaxyId);
      this.ctx.storage.sql.exec('INSERT INTO Scopes (universeGalaxyStarId) VALUES (?)', `${universeGalaxyId}.dev`);
    });
    log.info('Galaxy created with its .dev workspace', { universeGalaxyId, callerAccessId: callerAccess.authScope });
    return { instanceName: universeGalaxyId };
  }

  /**
   * Create a Star IN-SESSION — admin-gated over the parent galaxy, `Scopes` row only, NO identity minted + NO
   * email (the admin already holds a session whose scope is at or above the new Star). Mirrors
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
    if (!this.#hasDominionOverGalaxy(callerAccess, parentGalaxy)) {
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

  // ⚠️ `myScopeTree` lived here and is GONE, absorbed by `getScopeSummary` above — which reads the
  // same `Scopes` table (so a member-less new galaxy still surfaces, the property this method's
  // JSDoc defended) while bounding the READ, which it never did: its platform arm selected every
  // scope in the system.


  // ============================================
  // Login channel — magic link (request + issue) + invites (issue)
  // ============================================

  /**
   * Request a login magic link (called by the Worker on `email-magic-link`, Turnstile-gated). Inserts
   * a `MagicLinks` row (token stored HASHED) and sends the email. `universeGalaxyStarId` is absent on
   * the scope-less front door, where the click proves the mailbox and the scope is chosen afterward.
   *
   * **Mints nothing, and reads nothing about the address** — one invariant now, where there used to
   * be an exception. The no-mint half is the older rule: an unauthenticated request must never create
   * membership, so a link for a scope its address was never minted into is issued, delivered, and
   * then refused at consume. The no-read half is what makes the answer uniform for member, stranger
   * and configured bootstrap address alike — any divergence would rebuild, in the response shape, the
   * enumeration oracle that retiring `discover` exists to close.
   */
  async requestMagicLink(email: string, universeGalaxyStarId: string | undefined, origin: string):
    Promise<{ message: string; magicLinkUrl?: string }> {
    // The Worker validates the email format before this RPC (Workers RPC drops custom Error props, so
    // client-error gates stay Worker-side) — here we just normalize + create the row.
    const lc = normalizeEmail(email);
    // ⚠️ **No branch reads the address.** Whether it holds memberships, holds none, or is a configured
    // bootstrap address, the work and the answer are identical: one link row, one send. That is what
    // makes the response uniform, and the uniformity is the point — this endpoint is unauthenticated,
    // so any divergence here is an oracle telling a stranger what an address reaches. The platform
    // membership used to be minted on THIS path; it now rides the consume, behind mailbox proof.
    return this.#createMagicLinkAndSend(lc, universeGalaxyStarId, 'login', origin);
  }

  /**
   * **The Home screen's one read** — every address this person holds, every membership on each, and
   * enough of the tree beneath their ADMIN memberships to choose from.
   *
   * Keyed on `profileId`, so it spans addresses: the screen is about a PERSON, and one person's
   * memberships can hang off several of their addresses (ADR-013's `Emails.profileId`).
   *
   * ⚠️ **Replaces `my-scopes`/`myScopeTree`, and is a superset of it.** The subtree beneath an admin
   * membership is read from `Scopes`, not from `Memberships`, which preserves the one property that
   * method's JSDoc defended: a galaxy someone just created has no member yet, and an email-keyed
   * read would not surface it. What the old method did NOT have is any bound — its platform arm was
   * `SELECT … FROM Scopes` entire — which is why the budget below is on the READ.
   *
   * ⚠️ **Eager descent requires an ACCEPTED admin membership.** An unaccepted one renders as a bare
   * badged row: until its holder has agreed to take it up, it confers nothing (ADR-012), and
   * fleshing a subtree under it would be answering with authority nobody has accepted.
   */
  getScopeSummary(profileId: string, currentSub: string): ScopeSummary {
    const rows = this.#sql`
      SELECT e.email AS email, m.sub AS sub, m.universeGalaxyStarId AS scope, m.scopeAdmin AS scopeAdmin,
             m.acceptedAt AS acceptedAt, m.invitedByName AS invitedByName,
             m.invitedByProfileId AS invitedByProfileId, m.invitedBySub AS invitedBySub
      FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
      WHERE e.profileId = ${profileId}
      ORDER BY e.email, m.universeGalaxyStarId`;

    let budget = SCOPE_TREE_NODE_BUDGET - rows.length; // the membership rows themselves count
    const byEmail = new Map<string, EmailScopes>();
    for (const r of rows) {
      const email = r.email as string;
      if (!byEmail.has(email)) byEmail.set(email, { email, memberships: [] });
      const scope = r.scope as string;
      const accepted = r.acceptedAt != null;
      const node: ScopeNode = {
        scope, tier: this.#tierOf(scope), scopeAdmin: Boolean(r.scopeAdmin), accepted,
        ...(r.invitedBySub != null ? {
          invited: true,
          invitedByName: (r.invitedByName as string | null) ?? undefined,
          invitedByProfileId: (r.invitedByProfileId as string | null) ?? undefined,
        } : {}),
      };
      if (r.sub === currentSub) byEmail.get(email)!.current = true;
      // Only an accepted admin membership opens its subtree.
      if (node.scopeAdmin && accepted && budget > 0) {
        budget -= this.#descend(node, budget);
      }
      byEmail.get(email)!.memberships.push(node);
    }
    return { emails: [...byEmail.values()] };
  }

  /**
   * Fill `root`'s subtree BREADTH-FIRST until `budget` nodes are spent, and report what it cost.
   *
   * ⚠️ **Breadth-first, not depth-first, and that is a product decision rather than a taste one.**
   * The screen renders a level at a time, so a budget spent depth-first would hand someone every
   * tenant of their first app and nothing about the other four. Level order means the budget buys
   * the widest useful picture, and whatever it could not reach is marked with a `childCount` the
   * client renders as "N more" — so the frontier is visible rather than silently missing.
   */
  #descend(root: ScopeNode, budget: number): number {
    let spent = 0;
    let frontier = [root];
    while (frontier.length > 0 && spent < budget) {
      const next: ScopeNode[] = [];
      for (const node of frontier) {
        if (spent >= budget) break;
        const { children, spent: cost, truncated } = this.#childLevel(node.scope, budget - spent);
        spent += cost;
        if (children.length > 0) {
          node.children = children;
          // ⚠️ A parent whose level was CUT SHORT keeps a `childCount`, and that is the frontier the
          // client renders as "N more". Without it the tree looks complete while silently missing
          // everything past the budget — the failure mode a bounded read exists to make visible.
          if (truncated) node.childCount = this.#directChildCount(node.scope);
          else delete node.childCount;
          next.push(...children);
        }
      }
      frontier = next;
    }
    return spent;
  }

  /**
   * One level of `Scopes` beneath `parent`, bounded by `budget`.
   *
   * ⚠️ **`LIMIT budget + 1`, and the +1 is the point** — it is what tells the caller a frontier
   * exists without reading past it. Trimming a full read after the fact would serve a small body
   * off an unbounded scan, which is the shape ADR-018 is about; here the singleton's work is
   * bounded too.
   */
  /**
   * One level of children beneath `parent`, bounded.
   *
   * ⚠️ **The reserved platform scope needs its own arm, because containment there is NOT a string
   * prefix.** Every other parent finds its children with `LIKE 'parent.%'`; `nebula-platform` is a
   * reserved SIBLING of every universe, not their textual ancestor, so that predicate matches
   * nothing and a superuser's tree renders as one bare row. `isPlatformScope` is what makes
   * `isAtOrAbove` true for it (ADR-015 — the platform scope is the ROOT of the tree), and this is
   * the read-side counterpart of that: the platform root's children are the universes.
   *
   * The retired `myScopeTree` carried the same arm, coupled to the reserved value by hand; dropping
   * it when the summary replaced that method cost a superuser their whole tree, silently — every
   * in-lane fixture is a single tenancy, so nothing reddened. `harness/scenarios/superuser-front-door.ts`
   * limb 4 is what caught it, and is what keeps it caught.
   */
  #childLevel(
    parent: string, budget: number, after?: string,
  ): { children: ScopeNode[]; spent: number; truncated: boolean } {
    const depth = isPlatformScope(parent) ? 0 : parent.split('.').length;
    if (depth >= 3) return { children: [], spent: 0, truncated: false }; // a star has no descendants
    // Universes for the platform root; the prefixed subtree for everyone else. `after` is the keyset
    // cursor in both arms: resume strictly past the last scope the caller already has.
    const like = isPlatformScope(parent) ? '%' : `${parent}.%`;
    const rows = after === undefined
      ? this.#sql`
        SELECT universeGalaxyStarId AS scope FROM Scopes
        WHERE universeGalaxyStarId LIKE ${like}
        ORDER BY universeGalaxyStarId
        LIMIT ${budget + 1}`
      : this.#sql`
        SELECT universeGalaxyStarId AS scope FROM Scopes
        WHERE universeGalaxyStarId LIKE ${like} AND universeGalaxyStarId > ${after}
        ORDER BY universeGalaxyStarId
        LIMIT ${budget + 1}`;
    // Direct children only — the LIKE also matches grandchildren, and a level is what the screen
    // renders. (A separate count would be a second scan; filtering the bounded read is not.)
    // ⚠️ The platform root is excluded from its own children: `LIKE '%'` matches it too.
    const direct = rows.map(r => r.scope as string)
      .filter(s => s.split('.').length === depth + 1 && !isPlatformScope(s));
    const children = direct.slice(0, budget).map(scope => ({
      scope, tier: this.#tierOf(scope),
      ...(scope.split('.').length < 3 ? { childCount: this.#directChildCount(scope) } : {}),
    } as ScopeNode));
    const truncated = direct.length > budget;
    return { children, spent: children.length + (truncated ? 1 : 0), truncated };
  }

  /**
   * How many direct children a scope has — the frontier marker the client renders as "N more".
   *
   * ⚠️ **Bounded like everything else, so it is a FLOOR rather than an exact count.** It reads at
   * most `budget + 1`, which is the whole point: an exact count of a superuser's descendants is the
   * unbounded scan this design removed. The client renders it as "at least N".
   */
  /** The frontier marker's value. Same platform arm as {@link NebulaAuthRegistry.prototype} `#childLevel` — see its JSDoc. */
  #directChildCount(parent: string): number {
    const depth = isPlatformScope(parent) ? 0 : parent.split('.').length;
    const like = isPlatformScope(parent) ? '%' : `${parent}.%`;
    const rows = this.#sql`
      SELECT universeGalaxyStarId AS scope FROM Scopes
      WHERE universeGalaxyStarId LIKE ${like} LIMIT ${SCOPE_TREE_NODE_BUDGET + 1}`;
    return rows.map(r => r.scope as string)
      .filter(s => s.split('.').length === depth + 1 && !isPlatformScope(s)).length;
  }

  #tierOf(scope: string): Tier {
    const n = scope.split('.').length;
    return n === 1 ? 'universe' : n === 2 ? 'galaxy' : 'star';
  }

  /**
   * One more level of the tree, on demand — what the Home screen calls when someone opens a
   * collapsed node.
   *
   * ⚠️ **Authorization is re-derived here, from the caller's own memberships** — never trusted from
   * the request. The caller must hold an ACCEPTED admin membership at or above `parent`, which is
   * the same rule the eager descent applies, asked again because this is a separate entry point.
   */
  expandScope(profileId: string, parent: string, after?: string): { children: ScopeNode[]; nextCursor?: string } {
    const admins = this.#sql`
      SELECT m.universeGalaxyStarId AS scope FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
      WHERE e.profileId = ${profileId} AND m.scopeAdmin = 1 AND m.acceptedAt IS NOT NULL`;
    const covered = admins.some(a => {
      const s = a.scope as string;
      return isPlatformScope(s) || s === parent || parent.startsWith(`${s}.`);
    });
    if (!covered) return { children: [] };
    const { children, truncated } = this.#childLevel(parent, SCOPE_TREE_NODE_BUDGET, after);
    // ⚠️ **KEYSET pagination, not OFFSET.** The cursor is the last scope returned and the next page
    // asks for rows ordered after it, so page N costs what page 1 costs — an `OFFSET` would re-scan
    // everything before it, which is the unbounded read this design exists to keep off the
    // singleton. Scope ids are unique and lexically ordered, so they are their own stable cursor and
    // no server-side paging state is needed. Absent `nextCursor` means the level is exhausted.
    return {
      children,
      ...(truncated && children.length > 0
        ? { nextCursor: children[children.length - 1].scope }
        : {}),
    };
  }

  /**
   * **Logout everywhere for this ADDRESS** — every membership it holds, every session on each.
   *
   * The caller proves one membership (its path-scoped cookie, resolved to `sub` by the Worker); the
   * address behind it, and the sibling memberships, are resolved HERE. Nothing about which scopes to
   * clear comes from the request: a client that could name them could clear someone else's.
   *
   * ⚠️ Scoped to one ADDRESS, not to the person's `profileId`. Two addresses that happen to share a
   * profile are two mailboxes with two sets of cookies, and only the one that proved itself is
   * signed out — "log out everywhere" means this browser's credentials for this address, which is
   * what someone on a shared machine is asking for.
   *
   * Returns the scopes cleared so the Worker can expire exactly those cookie `Path`s.
   */
  async revokeAllForAddress(sub: string, callerClaims?: NebulaJwtPayload): Promise<{ scopes: string[] }> {
    const owner = this.#sql`SELECT emailId FROM Memberships WHERE sub = ${sub}`;
    if (owner.length === 0) return { scopes: [] };
    const siblings = this.#sql`
      SELECT sub, universeGalaxyStarId AS scope FROM Memberships WHERE emailId = ${owner[0].emailId}`;
    for (const s of siblings) {
      await this.#invalidateRefreshTokensForSub(s.sub as string, 'logout-all', callerClaims);
    }
    return { scopes: siblings.map((s: any) => s.scope as string) };
  }

  /** Is this membership taken up? The one read behind every `accepted` copy — so the flag has one
   *  source, and a stale copy can never outvote the row. */
  #isAccepted(sub: string): boolean {
    const rows = this.#sql`SELECT acceptedAt FROM Memberships WHERE sub = ${sub}`;
    return rows.length > 0 && rows[0].acceptedAt != null;
  }

  /** Every membership an address holds, newest first — mint-all's input. */
  #membershipsForAddress(lcEmail: string): ConsumeMembership[] {
    const rows = this.#sql`
      SELECT m.sub AS sub, m.universeGalaxyStarId AS scope, m.scopeAdmin AS scopeAdmin,
             m.acceptedAt AS acceptedAt, e.profileId AS profileId
      FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
      WHERE e.email = ${lcEmail}
      ORDER BY m.createdAt DESC`;
    return rows.map((r: any) => ({
      sub: r.sub as string,
      universeGalaxyStarId: r.scope as string,
      scopeAdmin: Boolean(r.scopeAdmin),
      profileId: r.profileId as string,
      accepted: r.acceptedAt != null,
    }));
  }

  /**
   * RPC 1 of a consume: validate the login-channel token, prove the mailbox, and return everything
   * the Worker needs to mint cookies — WITHOUT minting any itself.
   *
   * ⚠️ **The split is forced by where the raw tokens live.** Under mint-all the number of sessions is
   * not known until the address resolves, so the Worker cannot pre-generate them the way the old
   * single-session consume did; it needs this answer first, then mints N raw values (which only it
   * ever holds, for the cookies) and records their hashes through {@link recordSessions}. An eviction
   * between the two calls leaves a proved mailbox and zero sessions — harmless, and healed by
   * re-clicking a link that is multi-use within its TTL.
   *
   * Returns `null` for an unknown, expired, or address-less token; the Worker maps that to its
   * ordinary error redirect.
   */
  async resolveConsume(kind: 'magic-link' | 'invite', tokenHash: string): Promise<ConsumePlan | null> {
    const table = kind === 'magic-link' ? 'MagicLinks' : 'InviteTokens';
    const rows = kind === 'magic-link'
      ? this.#sql`SELECT email, universeGalaxyStarId, purpose, expiresAt FROM MagicLinks WHERE tokenHash = ${tokenHash}`
      : this.#sql`SELECT email, universeGalaxyStarId, expiresAt FROM InviteTokens WHERE tokenHash = ${tokenHash}`;
    if (rows.length === 0) return null;
    const row = rows[0];
    if (new Date().toISOString() > (row.expiresAt as string)) return null;
    const lc = normalizeEmail(row.email as string);

    // Mailbox proof has landed. A configured bootstrap address gets its platform membership here —
    // purpose-agnostic, so whichever route carried the click, and UNACCEPTED like every other mint.
    this.#ensureBootstrapMembership(lc);

    // The address's mailbox is proved once and globally (`Emails.emailVerified`), which is what makes
    // it safe to hand back every membership it holds rather than only the one a scope named.
    const proved = this.ctx.storage.sql.exec(
      'UPDATE Emails SET emailVerified = 1 WHERE email = ? AND emailVerified = 0', lc,
    );
    if (proved.rowsWritten > 0) debug('nebula-auth.Registry.identity.mailboxProved').info('Mailbox proved', { email: lc });

    const linkScope = (row.universeGalaxyStarId as string | null) ?? undefined;
    const purpose: MagicLinkPurpose = kind === 'invite'
      ? 'login' // an invite lands on Home with the invite-flavor modal; its scope is the link's
      : ((row.purpose as MagicLinkPurpose | undefined) ?? 'login');
    debug('nebula-auth.Registry.login.resolved').info('Consume resolved', { table, purpose, linkScope });
    return { email: lc, purpose, linkScope, memberships: this.#membershipsForAddress(lc) };
  }

  /**
   * RPC 2 of a consume: record the sessions whose raw tokens the Worker just minted. Index row first,
   * then the KV record, per the index-first invariant `#revokeByHashes` documents.
   *
   * Each record carries the membership's CURRENT acceptance, and an unaccepted one mints a cookie
   * that refuses to produce a token until the consent modal flips it — the cookie is placed, inert.
   *
   * ⚠️ **This is where a session becomes real, so this is where ADR-016 records one** — establishing
   * a session is named in that ADR's § *In scope today*: a login moves no authority, but it is the
   * first thing a post-incident reader asks about, and it is the moment a principal starts acting.
   * The record lives HERE rather than at the three call sites because every path that establishes a
   * session has to pass through this method to get a durable one — both consume paths and the
   * signup-ticket claim — so a fourth caller inherits the record instead of having to remember it.
   * Enumerating the sites is the shape ADR-016 explicitly rules out.
   *
   * ⚠️ **There is no `actingToken`, and its absence is the accurate record rather than a gap.** A
   * consume presents no token — proving a mailbox is what a magic link is FOR — so there are no
   * verified claims to hand the shared projection, and naming an actor nobody verified would be the
   * `sub`-only defect in a friendlier shape (`#revokeByHashes`'s logout path says the same of its
   * own). What the record names instead is every principal this act put into play: `sub` identifies
   * the membership, `profileId` the human behind it (write-time-pinned, so it still names them after
   * they are gone), and `scopeAdmin` the authority each cookie will carry once accepted.
   */
  async recordSessions(records: SessionRecord[], expiresAt: string): Promise<void> {
    const established: Array<Record<string, unknown>> = [];
    for (const r of records) {
      const scope = this.getIdentityScope(r.sub);
      if (!scope) continue; // membership vanished between the two calls — nothing to record
      const accepted = this.#isAccepted(r.sub);
      await this.#recordRefreshToken(
        r.sub, scope.universeGalaxyStarId, scope.scopeAdmin, scope.profileId, r.tokenHash, expiresAt,
        accepted,
      );
      established.push({
        sub: r.sub,
        universeGalaxyStarId: scope.universeGalaxyStarId,
        scopeAdmin: scope.scopeAdmin,
        profileId: scope.profileId,
        accepted,
      });
    }
    // ONE line for the whole act, because one click establishes N sessions under mint-all and a
    // reader asking "what did that login turn into?" wants the set, not N lines to reassemble.
    // ⚠️ Identifiers only — never a token hash, never the raw value (critical.md).
    debug('nebula-auth.Registry.login.established').info('Sessions established', {
      sessions: established,
      requested: records.length,
      expiresAt,
    });
  }

  /**
   * **The one writer of `acceptedAt`** — reached only through the consent modal's Accept, and
   * authenticated by the membership's own path-scoped cookie, which the Worker resolves to `sub`
   * before calling. Taking up a membership is a deliberate act by the person it belongs to, and this
   * is where that act is recorded.
   *
   * ⚠️ **Why no consume writes it.** A link click is not consent: corporate mail scanners fetch and
   * follow links, so a consume-time flip lets a stranger's guessed-address invite be "accepted" by
   * the victim's own mail gateway — and ADR-012 hands an admin of any scope a profile touches
   * read/write over that profile's private fields. Acceptance behind a form submit cannot be forged
   * by any fetch, redirect-follow, or JS render.
   *
   * An invited membership's Accept also takes up the `.dev` sibling minted alongside it: they arrived
   * as one act from one inviter, so consenting to the invitation consents to the workspace it came
   * with. Every affected session's KV record is converged, so the cookies stop being inert.
   */
  async acceptMembership(sub: string, callerClaims?: NebulaJwtPayload): Promise<{ accepted: string[] }> {
    const rows = this.#sql`
      SELECT m.emailId AS emailId, m.universeGalaxyStarId AS scope, m.invitedBySub AS invitedBySub
      FROM Memberships m WHERE m.sub = ${sub}`;
    if (rows.length === 0) return { accepted: [] };
    const emailId = rows[0].emailId as string;
    const scope = rows[0].scope as string;
    const invited = rows[0].invitedBySub != null;

    // The sibling: an invite into a galaxy co-mints `{galaxy}.dev` for the same address.
    const subs = [sub];
    if (invited) {
      const sibling = this.#sql`
        SELECT sub FROM Memberships
        WHERE emailId = ${emailId} AND universeGalaxyStarId = ${`${scope}.dev`} AND acceptedAt IS NULL`;
      if (sibling.length > 0) subs.push(sibling[0].sub as string);
    }

    const nowIso = new Date().toISOString();
    const flipped: string[] = [];
    for (const s of subs) {
      const res = this.ctx.storage.sql.exec(
        'UPDATE Memberships SET acceptedAt = ? WHERE sub = ? AND acceptedAt IS NULL', nowIso, s,
      );
      if (res.rowsWritten > 0) flipped.push(s);
    }
    if (flipped.length === 0) return { accepted: [] }; // already accepted — idempotent

    // Converge every live session for the affected memberships: the cookies exist already and are
    // inert until this lands. Re-applies each token's ORIGINAL absolute expiry, never a fresh TTL.
    for (const s of flipped) {
      const identity = this.getIdentityScope(s);
      if (!identity) continue;
      const tokens = this.#sql`SELECT tokenHash, expiresAt FROM RefreshTokenIndex WHERE sub = ${s}`;
      for (const tk of tokens) {
        const record: RefreshTokenKV = {
          sub: s, universeGalaxyStarId: identity.universeGalaxyStarId, scopeAdmin: identity.scopeAdmin,
          accepted: true, expiresAt: tk.expiresAt as string, profileId: identity.profileId,
        };
        await this.#refreshKv.put(`refresh:${tk.tokenHash as string}`, JSON.stringify(record), {
          expirationTtl: kvTtlSeconds(tk.expiresAt as string),
        });
      }
    }

    // ADR-016: acceptance moves authority — it is what `getScopesForProfile` counts, so it decides
    // who administers a profile. The acting principal is the membership's own holder, authenticated
    // by the cookie the Worker resolved; `callerClaims` is absent on that cookie-credentialed path,
    // and `projectActingToken` is given whatever the caller did present rather than a fabricated one.
    debug('nebula-auth.Registry.identity.membershipAccepted').info('Membership accepted', {
      subjectSub: sub, accepted: flipped, actingToken: callerClaims ? projectActingToken(callerClaims) : undefined,
    });

    // m6 — the pending-signup single-flight, fired by the ACCEPT and nothing else.
    // ⚠️ **AFTER the flip above, and that ordering is what protects the accepted scope.** The target
    // set below matches on `acceptedAt IS NULL`, so this membership excludes itself by having just
    // been taken up. Move this call above the flip and the accept deletes its own Universe — which
    // is why an explicit "not this scope" conjunct was removed rather than kept as a second guard:
    // it made the ordering look optional while duplicating what it already guarantees. The
    // "accepted claim wins" assertion in `identity-mint-point.test.ts` reds if the order changes.
    await this.#convergePendingClaims(sub, emailId, scope, invited);
    return { accepted: flipped };
  }

  /**
   * **m6: one address, one Universe.** Taking up a self-created Universe retires the address's OTHER
   * pending Universe claims — the "changed my mind about the name" case, which self-signup admits
   * because a claim mints the scope itself, so `Memberships`' `UNIQUE (emailId, scope)` cannot
   * backstop a second submission at a different slug.
   *
   * ⚠️ **Both sides carry the SAME conjuncts, and that symmetry is the whole safety argument.**
   * A bare `acceptedAt IS NULL` is a STANDING state under this design — every unaccepted invitation
   * and the never-entered bootstrap membership match it — so an unqualified predicate on either side
   * destroys other people's live scopes. Hence, on both the trigger and the targets:
   *
   *  - **unstamped** (`invitedBySub IS NULL`) — self-created, never an invitation someone sent you;
   *  - **universe-tier** — a `claimStar` take-up must not retire a pending Universe;
   *  - **`scopeAdmin = 1`** — the claimant's own founding membership, not a peer seat;
   *  - **not the platform scope** — the superuser's first login destroys nothing;
   *  - and on the target side additionally **unaccepted** — which is also what excludes the scope
   *    being accepted, since its flip commits first — and **within its claim link's TTL**, because an
   *    older pending claim whose link can no longer be consumed is nobody's live intention.
   *
   * ⚠️ **No transaction spans this.** Revoking a session awaits KV deletes, and `transactionSync`
   * takes a SYNCHRONOUS closure — an async one type-checks and commits before the writes land (the
   * pin above `#prepareMagicLink` documents the same trap). So: sync SELECT of the sibling set,
   * `await` the revokes OUTSIDE any transaction, then the sync deletes in one `transactionSync`.
   * `executeScopeDeletion` is the live precedent and this mirrors its body, link and invite rows
   * included — a slug freed by deleting only its `Scopes` row would leave a consumable login channel
   * pointed at a scope that no longer exists.
   */
  async #convergePendingClaims(
    acceptedSub: string, emailId: string, acceptedScope: string, invited: boolean,
  ): Promise<void> {
    // ── The TRIGGER side. Anything but a self-created universe-tier founding membership converges
    // nothing at all — this is where a `claimStar` take-up and the bootstrap login stop.
    if (invited || acceptedScope === PLATFORM_SCOPE) return;
    if (acceptedScope.includes('.')) return; // universe-tier is the one-segment case
    const self = this.#sql`SELECT scopeAdmin FROM Memberships WHERE sub = ${acceptedSub}`;
    if (self.length === 0 || !self[0].scopeAdmin) return;

    // ── The TARGET side, same conjuncts + unaccepted + live-link + not-self.
    const nowIso = new Date().toISOString();
    const siblings = this.#sql`
      SELECT m.sub AS sub, m.universeGalaxyStarId AS scope
      FROM Memberships m
      WHERE m.emailId = ${emailId}
        AND m.universeGalaxyStarId != ${PLATFORM_SCOPE}
        AND m.invitedBySub IS NULL
        AND m.scopeAdmin = 1
        AND m.acceptedAt IS NULL
        AND m.universeGalaxyStarId NOT LIKE '%.%'
        AND EXISTS (
          SELECT 1 FROM MagicLinks l
          WHERE l.universeGalaxyStarId = m.universeGalaxyStarId AND l.expiresAt > ${nowIso}
        )`;
    if (siblings.length === 0) return;

    // Revoke first, OUTSIDE any transaction — these await KV. A session minted from a superseded
    // claim must not outlive it: the slug is about to be free for someone else to take.
    for (const s of siblings) {
      await this.#invalidateRefreshTokensForSub(s.sub as string, 'pending-claim-superseded');
    }

    this.ctx.storage.transactionSync(() => {
      for (const s of siblings) {
        const name = s.scope as string;
        this.ctx.storage.sql.exec('DELETE FROM Memberships WHERE universeGalaxyStarId = ?', name);
        this.ctx.storage.sql.exec('DELETE FROM MagicLinks WHERE universeGalaxyStarId = ?', name);
        this.ctx.storage.sql.exec('DELETE FROM InviteTokens WHERE universeGalaxyStarId = ?', name);
        this.ctx.storage.sql.exec('DELETE FROM Scopes WHERE universeGalaxyStarId = ?', name);
      }
    });

    // ADR-016. The actor is SERVER-COMPOSED and syntactically not a human: nobody presented a token
    // for this — the platform executed a convergence the accept implied. Naming the address as the
    // actor would be ADR-016's own failure shape, a record that names the person acted upon.
    debug('nebula-auth.Registry.claim.converged').info('Pending claims superseded', {
      actor: 'agent:nebula', keptScope: acceptedScope,
      retired: siblings.map((s: any) => s.scope as string),
    });
  }

  /**
   * Ensure the reserved platform membership for a configured bootstrap address — called from the
   * SHARED consume, so it fires on whatever route carried the click and every existing scoped
   * bootstrap path keeps working unchanged.
   *
   * ⚠️ **Behind mailbox proof, and UNACCEPTED.** Minting used to happen on the unauthenticated link
   * REQUEST, which meant an unauthenticated call wrote a membership at the most powerful scope in the
   * system. Here the caller has already produced a token delivered to that address. The membership is
   * left un-taken-up like every other mint: entering the platform scope still passes the consent
   * modal, and until then `getScopesForProfile` does not count it.
   *
   * ⚠️ **The `#bootstrapEmails` conjunct is the whole gate** — it is what stands between any stranger
   * and platform `scopeAdmin`. It is deliberately NOT paired with a scope test here (the caller has
   * no scope to test on a bare login), which is exactly why mint-all excludes this membership from
   * the cookies it sets unless the consumed link itself named the platform scope.
   */
  #ensureBootstrapMembership(lcEmail: string): void {
    if (!this.#bootstrapEmails.includes(lcEmail)) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO Scopes (universeGalaxyStarId) VALUES (?)', PLATFORM_SCOPE);
      this.#mintIdentity(lcEmail, PLATFORM_SCOPE, /* scopeAdmin */ true);
    });
  }

  // ── The magic-link helper, split into three by await-ness ───────────────────────────────────
  //
  // `transactionSync` takes a SYNCHRONOUS closure, but hashing a token is `crypto.subtle` and thus
  // async — so a naive "wrap the old #createMagicLinkAndSend in transactionSync" does not compose.
  // Worse, it fails SILENTLY: `transactionSync<T>` infers `T = Promise<…>` from an async closure, so
  // it type-checks and COMMITS BEFORE the link row is ever written.
  //
  // The split makes the correct ordering the only expressible one. Every caller that writes more than
  // the link row follows it:
  //   1. `#prepareMagicLink()`  — async (the hash), FIRST, before any check
  //   2. validation             — synchronous
  //   3. `transactionSync(… #insertMagicLinkRow …)` — no `await` inside
  //   4. `#deliverMagicLink()`  — async, AFTER commit (a send inside a transaction is neither
  //                               rollback-able nor gate-safe)
  //
  // ⚠️ Step 1 sits before validation on purpose: it guarantees no `await` ever lands between the
  // checks and the write, which would open the input gate and make the slug check a TOCTOU window.
  // (A synchronous digest would dissolve the whole constraint — see `tasks/backlog.md` § sync digest.)

  /** Mint a link token + its hash. **Async** (`crypto.subtle`) — call BEFORE opening a transaction. */
  async #prepareMagicLink(): Promise<{ rawToken: string; tokenHash: string; expiresAt: string }> {
    const rawToken = generateRandomString(32);
    return {
      rawToken,
      tokenHash: await hashString(rawToken),
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL * 1000).toISOString(),
    };
  }

  /**
   * INSERT the `MagicLinks` row. **Synchronous** — safe inside a `transactionSync` closure.
   *
   * `email` must already be `normalizeEmail`d: it has to match the `Emails` normalization or
   * consume-time verification won't find the row.
   */
  #insertMagicLinkRow(
    tokenHash: string, lcEmail: string, universeGalaxyStarId: string | undefined,
    purpose: MagicLinkPurpose, expiresAt: string,
  ): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO MagicLinks (tokenHash, email, universeGalaxyStarId, purpose, expiresAt) VALUES (?, ?, ?, ?, ?)',
      tokenHash, lcEmail, universeGalaxyStarId ?? null, purpose, expiresAt,
    );
  }

  /** The link a `rawToken` resolves to. Synchronous; the DO reads `origin` off the forwarded request.
   *  A scope-less link takes the shorter route — there is no scope segment to put in it. */
  #magicLinkUrl(rawToken: string, universeGalaxyStarId: string | undefined, origin: string): string {
    return universeGalaxyStarId === undefined
      ? scopelessAuthUrl(origin, 'magic-link', { one_time_token: rawToken })
      : instanceAuthUrl(origin, universeGalaxyStarId, 'magic-link', { one_time_token: rawToken });
  }

  /** Send (or, in test mode, return) the link. **Async** — call AFTER the transaction commits. */
  async #deliverMagicLink(
    rawToken: string, lcEmail: string, universeGalaxyStarId: string | undefined, origin: string,
  ): Promise<{ message: string; magicLinkUrl?: string }> {
    const magicLinkUrl = this.#magicLinkUrl(rawToken, universeGalaxyStarId, origin);
    if (this.#isTestMode) {
      return { message: 'Magic link generated (test mode)', magicLinkUrl };
    }
    // `instanceName` is what routes the mail for `waitForEmail` and is required on every variant, so a
    // scope-less link reports the one thing that IS true of it — it belongs to no instance.
    await this.#sendEmail({
      type: 'magic-link', to: lcEmail, instanceName: universeGalaxyStarId ?? SCOPELESS_INSTANCE_TAG, magicLinkUrl,
    });
    return { message: 'Check your email for the magic link' };
  }

  /**
   * Insert a hashed `MagicLinks` row + send the link — the single-write path.
   *
   * One row, so it is trivially atomic and needs no transaction. Callers that write a `Scopes` row or
   * mint an identity alongside the link must NOT use this: they compose the three halves above inside
   * a `transactionSync` themselves (see `claimUniverse` / `claimStar`).
   */
  async #createMagicLinkAndSend(
    email: string, universeGalaxyStarId: string | undefined, purpose: MagicLinkPurpose, origin: string,
  ): Promise<{ message: string; magicLinkUrl?: string }> {
    const lc = normalizeEmail(email);
    const link = await this.#prepareMagicLink();
    this.#insertMagicLinkRow(link.tokenHash, lc, universeGalaxyStarId, purpose, link.expiresAt);
    return this.#deliverMagicLink(link.rawToken, lc, universeGalaxyStarId, origin);
  }

  /**
   * Issue invites into an EXISTING scope — **mint-only** (no send: a send awaited here would hold
   * the singleton's input gates through external I/O, and `ctx.waitUntil` means nothing in a DO —
   * the ENTRY dispatches the mail post-return via `invite-entry.ts`). Per invitee:
   *
   *  - MINT the identity (`emailVerified=0`, un-taken-up) — a mint point, pre-creating the
   *    "authorized member" row `resolveConsume` will later find-and-flip → `invited`;
   *  - an existing member is early-returned unchanged → `already-member` — EXCEPT when the capped
   *    bit is true and the row's bit is 0, which executes the promotion via
   *    {@link setIdentityAdmin} (flips the row AND converges every live KV refresh record, so open
   *    sessions gain the bit on their next refresh) → `promoted`. **Promote-only is structural**:
   *    the call is reached only under (capped bit ∧ row bit 0) — a capped-false bit never reaches
   *    it (never "demote"), and an already-admin re-invite is an ordinary `already-member` with no
   *    update, no KV write, and no authority-change record;
   *  - INSERT a fresh `InviteTokens` row (HASHED, reusable within its TTL) and return the URL for
   *    the entry's sender, alongside the acceptance fact that picks the template.
   *
   * **Eligibility refusals are the caller's job** — the entry's claims-only verdicts: exact-scope
   * membership or dominion over the target (RPC drops custom Error props, so this method stays
   * throw-free for expected client errors) — but
   * never the admin bit: the full cap rule is re-asserted in-method, and a `scopeAdmin: true` entry
   * arriving without dominion in `callerClaims` THROWS as an invariant breach (the entry should
   * have capped it), before any entry's writes. Malformed entries join the per-invitee errors; the
   * batch never fails whole.
   */
  async issueInvites(
    universeGalaxyStarId: string, invitees: InviteeRequest[], origin: string,
    callerClaims: NebulaJwtPayload, inviterName?: string,
  ): Promise<InviteMintResult> {
    const results: InviteeMintResult[] = [];
    const errors: InviteeError[] = [];

    // The in-method cap re-assertion, BEFORE any write so the bug path leaves no partial state.
    // The bit passes only `=== true` — `"true"`, `1`, `"false"` never mint an admin (they are
    // treated as unrequested, per the contract's wrong-typed rule).
    const dominion = hasDominionOver(callerClaims?.access, universeGalaxyStarId);
    for (const entry of invitees) {
      if (entry != null && typeof entry === 'object' && entry.scopeAdmin === true && !dominion) {
        throw new Error(
          'issueInvites: a scopeAdmin entry arrived without dominion in callerClaims — the entry ' +
          'guard must cap the bit (invariant breach, not a client error)',
        );
      }
    }

    for (const entry of invitees) {
      const rawEmail = (entry != null && typeof entry === 'object') ? entry.email : undefined;
      const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : '';
      if (!email || !isValidEmail(email)) {
        errors.push({ email: typeof rawEmail === 'string' ? rawEmail : '', error: 'Invalid email format' });
        continue;
      }
      const requestedBit = entry.scopeAdmin === true;
      try {
        // Who is doing the inviting, pinned at mint for the invitee's consent modal. `sub` and
        // `profileId` come from the caller's VERIFIED claims; the name is what that caller asserted
        // about themselves (capped and stripped at the facade), which is why the modal attributes it
        // as sender-supplied rather than vouching for it.
        const invitedBy: InvitedByStamp = {
          sub: callerClaims?.sub, name: inviterName, profileId: callerClaims?.profileId,
        };

        // Pre-create the invitee identity (idempotent on (email, scope)) — the mint point.
        const minted = this.#mintIdentity(email, universeGalaxyStarId, requestedBit, invitedBy);

        // The workspace SECOND HALF (galaxy-tier invites only): a galaxy collaborator is
        // ALSO enrolled in the `.dev` workspace Star, so she can work in the preview
        // while her galaxy membership carries no admin bit at all.
        //
        // ⚠️ **The workspace bit is DOMINION-PRICED, on the same `dominion` the cap
        // above uses.** `issueInvites` is reachable by a PEER — the facade admits an
        // exact-scope member with no admin bit and no dominion — so minting the `.dev`
        // bit unconditionally let such a member hand a third party admin over the whole
        // workspace, which the inviter does not hold and cannot delegate (ADR-015:
        // dominion flows downward from what you actually have, and upward is nil). The
        // peer case still enrolls the invitee, just without the bit: passage into the
        // workspace is the collaboration grant; admin over it is the inviter's to give
        // only if they have it. Idempotent like the primary.
        let galaxyTier = false;
        try { galaxyTier = parseId(universeGalaxyStarId).tier === 'galaxy'; } catch { /* not a scope id */ }
        // ⚠️ The sibling carries the SAME stamps, written in the same statement-pair as the primary.
        // It is a membership a third party created for this person exactly as the primary is, so an
        // unstamped one would render the self-flavor consent modal — "only accept if you initiated
        // this signup" — over a row they had nothing to do with.
        if (galaxyTier) this.#mintIdentity(email, `${universeGalaxyStarId}.dev`, dominion, invitedBy);

        let outcome: InviteeMintResult['outcome'] = minted.created ? 'invited' : 'already-member';
        if (!minted.created && requestedBit && !minted.scopeAdmin) {
          // The promotion — reached ONLY under (capped bit ∧ row bit 0), which is what makes
          // promote-only structural rather than a branch: a false bit can never demote, and an
          // already-admin re-invite never re-writes the row or its KV records. An authority
          // change, so the acting claims thread through (setIdentityAdmin emits the ADR-016
          // record via the shared projection).
          await this.setIdentityAdmin(minted.sub, true, callerClaims);
          outcome = 'promoted';
        }

        const rawToken = generateRandomString(32);
        const tokenHash = await hashString(rawToken);
        const expiresAt = new Date(Date.now() + INVITE_TTL * 1000).toISOString();
        this.ctx.storage.sql.exec(
          'INSERT INTO InviteTokens (tokenHash, email, universeGalaxyStarId, expiresAt) VALUES (?, ?, ?, ?)',
          tokenHash, email, universeGalaxyStarId, expiresAt,
        );
        const inviteUrl =
          instanceAuthUrl(origin, universeGalaxyStarId, 'accept-invite', { invite_token: rawToken });

        // ADR-016-adjacent issuance attribution: an `invited` outcome MINTS a membership (an
        // authority change), and every outcome mints a login-channel token and sends mail on
        // someone's behalf — the abuse bound on the open invite rule is exactly this line. The
        // record names the full acting token through the shared projection — never a bare `sub`,
        // which under impersonation names the person acted upon as the person who acted. (The
        // promotion's own authority-change record is setIdentityAdmin's, not this one.)
        debug('nebula-auth.Registry.invite.issued').info('Invite issued', {
          email, universeGalaxyStarId, outcome, actingToken: projectActingToken(callerClaims),
        });
        results.push({ email, sub: minted.sub, outcome, accepted: minted.accepted, inviteUrl });
      } catch (error) {
        errors.push({ email, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    return { results, errors };
  }

  // ============================================
  // Token consume (Worker RPC) — see `resolveConsume` + `recordSessions` above
  // ============================================
  //
  // ⚠️ The single-session `consumeMagicLink` / `consumeInvite` pair that lived here is GONE, not
  // moved: under mint-all one click mints a session per membership of the address, so the number of
  // raw tokens is unknown until the address resolves and the old "Worker pre-generates one hash and
  // passes it in" shape cannot express it. Their work is split across the two RPCs above.

  /**
   * Record one session: `RefreshTokenIndex` FIRST (sync SQLite, single-writer), THEN the KV record —
   * the index-first invariant `#revokeByHashes` documents, so an eviction at the awaited put leaves
   * at worst a revocable index-row-without-record, never a live-but-unindexed token.
   *
   * Writer (a) of `profileId` into the KV record (the login funnel), and writer (a) of `accepted`.
   */
  async #recordRefreshToken(
    sub: string, universeGalaxyStarId: string, scopeAdmin: boolean, profileId: string, tokenHash: string,
    expiresAt: string, accepted: boolean,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO RefreshTokenIndex (tokenHash, sub, expiresAt) VALUES (?, ?, ?)',
      tokenHash, sub, expiresAt,
    );
    const record: RefreshTokenKV = { sub, universeGalaxyStarId, scopeAdmin, accepted, expiresAt, profileId };
    await this.#refreshKv.put(`refresh:${tokenHash}`, JSON.stringify(record), {
      expirationTtl: kvTtlSeconds(expiresAt),
    });
  }

  /**
   * Revoke a specific set of refresh tokens — **the one revoke mechanism**; every caller routes here.
   *
   * ⚠️ **THE INVARIANT: never un-index a token whose KV record you did not just delete.** Revocation
   * spans two stores with no transaction, so there are two possible orphans and they are NOT equally
   * bad:
   *   - **index row, no KV record** — the next refresh takes a KV miss and `getRefreshRecord`
   *     reconstructs the record from the index row, so the token *resurrects*; but it stays
   *     ENUMERABLE, so re-running a revoke kills it. **Recoverable.**
   *   - **KV record, no index row** — the token keeps working off the KV hit, is invisible to every
   *     future revoke, and lives to its ~30-day TTL. **Unrecoverable.**
   *
   * ⚠️ Both orderings used to be justified by "an orphaned index row is harmless — the token is
   * already dead." **That is false**, and `getRefreshRecord`'s self-heal is why: an index row IS a
   * live token. The KV-first conclusion survives, but re-derive it as recoverable-vs-unrecoverable
   * rather than harmless-vs-not, or the next reader "simplifies" the ordering on a dead premise.
   *
   * The un-index is therefore scoped to the hashes whose KV delete **resolved**, which keeps the
   * invariant under partial failure too: a rejected delete leaves that token indexed, hence
   * recoverable. `allSettled` is chosen for those failure semantics — plain `Promise.all` discards
   * *which* key failed; overlapping the round-trips is a second-order win on the DO's elapsed-time
   * billing and changes neither the operation count nor its per-operation cost.
   *
   * ⚠️ **Irreducible residual, stated rather than hidden:** a KV `put` already in flight when the
   * caller enumerated can still land after these deletes — the write is dispatched to an external
   * store and nothing here can unsend it. The window is one KV round-trip. Offboarding covers the
   * adversarial case by removing the MEMBERSHIP before revoking, since starving alone is defeated by
   * re-login.
   */
  async #revokeByHashes(
    tokenHashes: string[],
    reason: string,
    /** The verified claims of whoever ASKED for this — projected, never pre-picked. Absent only on the
     *  logout path, which is authenticated by a refresh cookie and so carries no claims at all; that
     *  absence is honest, whereas passing the token owner's `sub` here would assert an actor we never
     *  verified. Whose sessions these are is `subjectSub`, a separate field, because conflating the
     *  two is exactly the misreading ADR-016 exists to prevent. */
    actingClaims?: NebulaJwtPayload,
    subjectSub?: string,
  ): Promise<void> {
    if (tokenHashes.length === 0) return;
    const results = await Promise.allSettled(
      tokenHashes.map(h => this.#refreshKv.delete(`refresh:${h}`)),
    );
    const confirmed = tokenHashes.filter((_, i) => results[i]!.status === 'fulfilled');

    // ⚠️ **A rejected delete is LOUD, deliberately — this branch is otherwise untested defensive
    // code.** Reaching it requires a real KV failure, which no lane can induce without an injectable
    // binding, so `testing.md`'s "defensive exception conditions that are hard to reach may stay
    // uncovered" applies. What replaces the test is that the event announces itself AND says what
    // state it left, because the whole point of the filter is that this case is RECOVERABLE: the
    // token keeps its index row, so it stays enumerable and a re-run of the revoke will retry it.
    // Without that sentence a reader has to re-derive whether anything is still live.
    if (confirmed.length !== tokenHashes.length) {
      debug('nebula-auth.Registry.token.revokeIncomplete').error(
        'KV delete FAILED for some tokens — they remain INDEXED and therefore still revocable; ' +
        're-run the revoke for this sub to retry',
        { reason, subjectSub, requested: tokenHashes.length, deleted: confirmed.length },
      );
    }
    if (confirmed.length > 0) {
      const placeholders = confirmed.map(() => '?').join(',');
      this.ctx.storage.sql.exec(
        `DELETE FROM RefreshTokenIndex WHERE tokenHash IN (${placeholders})`, ...confirmed,
      );
    }
    // ADR-016: this removes state, so the record names EVERY party — the subject whose sessions died
    // AND, through the shared projection, the full verified claims of whoever asked, including the
    // `act` chain. A `sub`-only record names the person acted upon as the person who acted, which is
    // affirmatively wrong rather than merely incomplete, and it would be believed. `actingToken` is
    // absent on the logout path by design: that path carries no claims to verify, and asserting an
    // actor we never saw would be the same defect in a friendlier shape.
    debug('nebula-auth.Registry.token.revoked').warn('Refresh tokens revoked', {
      reason,
      subjectSub,
      actingToken: actingClaims ? projectActingToken(actingClaims) : undefined,
      requested: tokenHashes.length,
      revoked: confirmed.length,
    });
  }

  /**
   * Logout / revoke a single token (Worker-driven). ⚠️ KV is eventually consistent, so a revoked token
   * keeps working for the KV-propagation window (~edge cacheTtl) PLUS the full access-TTL — the short
   * access-TTL is the mitigation (security.md).
   */
  async revokeRefreshToken(refreshTokenHash: string): Promise<void> {
    const rows = this.#sql`SELECT sub FROM RefreshTokenIndex WHERE tokenHash = ${refreshTokenHash}`;
    await this.#revokeByHashes(
      [refreshTokenHash], 'logout', /* actingClaims */ undefined, rows[0]?.sub as string | undefined,
    );
  }

  /**
   * Change an identity's admin bit and CONVERGE the denormalized `scopeAdmin` in every live KV refresh
   * record for that `sub` (the ADR-010 convergence writer). ⚠️ On the KV re-put, re-apply the record's
   * ORIGINAL absolute expiry (`RefreshTokenIndex.expiresAt`) — CF KV drops `expirationTtl` across a
   * put, so a fresh TTL would EXTEND a demoted user's token and omitting it would make it IMMORTAL (M4).
   */
  async setIdentityAdmin(sub: string, scopeAdmin: boolean, callerClaims: NebulaJwtPayload): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE Memberships SET scopeAdmin = ? WHERE sub = ?', scopeAdmin ? 1 : 0, sub);
    const scope = this.getIdentityScope(sub);
    if (!scope) return;
    const tokens = this.#sql`SELECT tokenHash, expiresAt FROM RefreshTokenIndex WHERE sub = ${sub}`;
    for (const t of tokens) {
      const record: RefreshTokenKV = {
        sub, universeGalaxyStarId: scope.universeGalaxyStarId, scopeAdmin, expiresAt: t.expiresAt as string,
        profileId: scope.profileId, // writer (b): re-put must carry profileId forward or the claim vanishes after an admin change
        accepted: this.#isAccepted(sub), // likewise — a re-put that dropped this would silently deaden the session
      };
      // Re-apply the ORIGINAL absolute expiry as the ttl — never a fresh TTL (M4).
      await this.#refreshKv.put(`refresh:${t.tokenHash as string}`, JSON.stringify(record), {
        expirationTtl: kvTtlSeconds(t.expiresAt as string),
      });
    }
    // ADR-016: this is the authority change itself — the record must name every party.
    debug('nebula-auth.Registry.identity.roleUpdated').info('scopeAdmin converged', {
      sub, scopeAdmin, tokens: tokens.length, actingToken: projectActingToken(callerClaims),
    });
  }

  // ============================================
  // Scope deletion — cascade teardown (plan + execute)
  // ============================================

  /**
   * Read-only deletion PLAN (feeds the confirm screen). `callerSub` is the caller's VERIFIED surrogate
   * sub (from the JWT — never client-supplied); the registry resolves it → email internally to exclude
   * the caller from the `affectedUsers` warning. Throws 403 if the caller isn't admin over the target,
   * or if `callerSub → email` resolves empty (fail CLOSED — M2). Mutates nothing.
   *
   * `affected` is the target + its descendants — deletion cascades DOWN only, never up into emptied
   * ancestors. `affectedUsers` is a bounded warning, never a refusal.
   */
  planScopeDeletion(target: string, callerSub: string, callerAccess: AccessEntry): ScopeDeletionPlan {
    return this.#computeDeletionPlan(target, callerSub, callerAccess);
  }

  /**
   * Execute the cascade: re-verify admin + re-run the guard, then for each affected scope delete the
   * `Scopes` row, its `Memberships`, their `RefreshTokenIndex` entries + KV refresh records, and the
   * scope's `MagicLinks` / `InviteTokens`. Returns the affected set so the Worker fans out platform-DO
   * `teardown()` (the registry can't reach platform DOs — dependency direction). Throws 403 / 409.
   *
   * ⚠️ `callerClaims` is the **acting** principal (ADR-016) and is **recorded, never consulted**.
   * Authorization keys off `callerAccess`/`callerSub` exactly as before — the stored `access` is
   * *asserted* authority, immutable history, and reading it back as an authz input would be the
   * stored-scope-set ADR-013 rejects. `planScopeDeletion` writes no record, so it does not carry it.
   *
   * ⚠️ **REQUIRED, not optional — and that is the whole point of it being a parameter.** An optional
   * one lets a future dispatch branch omit it, emit a record with no acting principal, and signal
   * nothing; required makes that a compile error at every call site plus a 400 at the `fetch` guard.
   * ADR-016's contents are not retrofittable, so a silent under-record is unrecoverable history.
   */
  async executeScopeDeletion(
    target: string, callerSub: string, callerAccess: AccessEntry, callerClaims: NebulaJwtPayload,
  ): Promise<{ affected: AffectedScope[] }> {
    // No `scope_in_use` refusal: dominion flows downward (ADR-015), so a covering admin may delete any
    // descendant regardless of who else is attached. `affectedUsers` is a UI warning, never a gate.
    const plan = this.#computeDeletionPlan(target, callerSub, callerAccess);

    const log = debug('nebula-auth.Registry.executeScopeDeletion');
    for (const scope of plan.affected) {
      const name = scope.instanceName;
      // Invalidate every refresh token for every identity in this scope (KV + index), then drop rows.
      const subs = this.#sql`SELECT sub FROM Memberships WHERE universeGalaxyStarId = ${name}`
        .map(r => r.sub as string);
      for (const sub of subs) {
        await this.#invalidateRefreshTokensForSub(sub, 'scope-deletion', callerClaims);
      }
      this.ctx.storage.sql.exec('DELETE FROM Memberships WHERE universeGalaxyStarId = ?', name);
      this.ctx.storage.sql.exec('DELETE FROM MagicLinks WHERE universeGalaxyStarId = ?', name);
      this.ctx.storage.sql.exec('DELETE FROM InviteTokens WHERE universeGalaxyStarId = ?', name);
      this.ctx.storage.sql.exec('DELETE FROM Scopes WHERE universeGalaxyStarId = ?', name);
    }

    // ADR-016 — the FULL verified claims of the ACTING token, write-time-pinned. All four elements:
    // the subject `sub`, the complete `act` chain, `profileId`, and the `access` entry. Under
    // impersonation `sub` is the person acted UPON, so `act` is what names who actually drove this;
    // a `sub`-only record is affirmatively wrong, not merely incomplete.
    log.info('Scope deleted', {
      target,
      callerSub,
      // ⚠️ **Named for the TOKEN, not for a role — deliberately.** The field is ADR-016's own
      // phrase: "the FULL verified claims of the acting token". So `actingToken.sub` reads as *the
      // token's subject*, which is what it is; nobody expects a token's `sub` to be its actor.
      // A ROLE name inverts and misleads here: `actor.sub` reads as "the actor", but under
      // impersonation `sub` is the person acted UPON — the actor is `act.sub`. That is the exact
      // misreading ADR-016 exists to prevent, and it would be believed. (`actingClaims` was the same
      // defect one step removed — "the acting claims" still invites "the acting sub".) Let the
      // structure carry the meaning: a token has a subject and an actor, and `act` names the actor.
      actingToken: projectActingToken(callerClaims),
      affected: plan.affected.map(a => a.instanceName),
    });
    return { affected: plan.affected };
  }

  /**
   * Revoke every refresh token for a `sub`.
   *
   * ⚠️ **The enumeration is a SNAPSHOT, and the delete is scoped to it — never `WHERE sub = ?`.** A
   * blanket delete would remove index rows for tokens this operation never touched: the awaited KV
   * deletes open the input gate, and a login landing in that window writes its index row synchronously
   * (`#recordRefreshToken` is index-first by design), so the blanket sweep would un-index a token whose
   * KV record it never deleted — converting the recoverable orphan into the unrecoverable one. A token
   * minted after this snapshot simply survives, which is correct: it is a login that happened after the
   * revoke began, and it remains enumerable and revocable.
   */
  async #invalidateRefreshTokensForSub(
    sub: string, reason: string, actingClaims?: NebulaJwtPayload,
  ): Promise<void> {
    const tokens = this.#sql`SELECT tokenHash FROM RefreshTokenIndex WHERE sub = ${sub}`;
    await this.#revokeByHashes(tokens.map(t => t.tokenHash as string), reason, actingClaims, sub);
  }

  #computeDeletionPlan(target: string, callerSub: string, callerAccess: AccessEntry): ScopeDeletionPlan {
    if (target === PLATFORM_SCOPE) {
      throw new RegistryError(400, 'reserved_slug', `"${PLATFORM_SCOPE}" cannot be deleted`);
    }
    let parsed;
    try { parsed = parseId(target); }
    catch { throw new RegistryError(400, 'invalid_id', 'Invalid scope id'); }

    if (!hasDominionOver(callerAccess, target)) {
      throw new RegistryError(403, 'forbidden', `Caller is not an admin of "${target}"`);
    }

    // Resolve the caller's own email (sub → email) — it exists to compute `#affectedUsers`' caller
    // EXCLUSION, not to gate.
    //
    // ⚠️ **Fail CLOSED on empty (M2), for WARNING INTEGRITY.** `#affectedUsers`' own JSDoc has the
    // real reason: a null here would silently under-count and make the warning lie ("no other users
    // affected" → the admin wipes a shared scope believing it empty). ADR-015 §1 makes that warning
    // the restraint on a destructive action, so a lying warning is the failure this prevents.
    // This is NOT a revocation gate — a 15-minute post-revocation access-token window is the accepted
    // posture repo-wide (`security.md`), and tightening this to act as one would be a downward veto.
    const callerEmailLc = this.#emailForSub(callerSub);
    if (!callerEmailLc) {
      throw new RegistryError(403, 'forbidden', 'Caller identity not found');
    }

    // Down: the target + all registered descendants.
    // ⚠️ **ALLOW-LISTED off the shared predicate** — `isAtOrAbove` computed in SQL, for the same
    // reason the scope-tree read's query is: routing per row would mean fetching every scope first. The
    // `.%` matches the predicate's whole-segment contract, and here a dot-dropped `LIKE ${target}%`
    // would widen a DESTRUCTIVE operation to a prefix-colliding sibling (`{u}` deleting `{u}-2`).
    const down = this.#sql`
      SELECT universeGalaxyStarId FROM Scopes
      WHERE universeGalaxyStarId = ${target} OR universeGalaxyStarId LIKE ${target + '.%'}
    `.map(r => r.universeGalaxyStarId as string);

    if (!down.includes(target)) {
      return { affected: [], affectedUsers: { total: 0, sample: [] } };
    }

    // Deletion cascades DOWN only — `affected` is exactly `down`. There is deliberately NO prune-up
    // of emptied ancestors: it destroyed scopes the admin never named (a solo user-developer deleting
    // one tenant Star also lost their Galaxy and Universe, since `createGalaxy` mints no identities so
    // both read as "empty"), and it made `affected` depend on mutable state — which, with the
    // `scope_in_use` refusal gone, is a data-loss path: `executeScopeDeletion` RECOMPUTES the plan, so
    // an identity disappearing between confirm and execute would silently enlarge the wipe set. Now
    // plan and execute cannot disagree, so no plan-currency token is needed. To remove a whole tree,
    // delete its TOP scope — the down-cascade handles the rest.
    return {
      affected: down.map(n => this.#toAffected(n)),
      // ⚠️ **Accepted residual under impersonation.** The exclusion is the token's principal — which,
      // for a narrower token, is the SUBJECT — so an admin acting as someone else sees a warning that
      // omits the very person they are acting as from "who else is affected." Self-consistent with
      // keying off `sub` (`security.md` rule (1)), and ADR-015 §1 makes this warning the restraint on
      // a destructive action, so it is worth naming rather than silently leaving.
      affectedUsers: this.#affectedUsers(down, callerEmailLc),
    };
  }

  #toAffected(universeGalaxyStarId: string): AffectedScope {
    const p = parseId(universeGalaxyStarId);
    return { instanceName: universeGalaxyStarId, tier: p.tier, isDev: p.tier === 'star' && p.star === 'dev' };
  }

  /**
   * Who else is attached across `scopes`, **bounded**: a COUNT plus at most 25 rows. Never materializes
   * one row per attached user — deleting an active Star must not shuttle every attached email over the
   * wire. `total` and `sample` count the same population (distinct emails), so they stay commensurable.
   *
   * The caller is excluded by email. ⚠️ That exclusion is why `#emailForSub` fails CLOSED upstream: a
   * null there would silently under-count and make the warning lie.
   */
  #affectedUsers(scopes: string[], callerEmailLc: string): ScopeDeletionAffectedUsers {
    if (scopes.length === 0) return { total: 0, sample: [] };
    // Scope names come from our own `Scopes` table, but bind them anyway — never concatenate into SQL.
    const placeholders = scopes.map(() => '?').join(',');
    const args = [...scopes, callerEmailLc];

    const totalRows = [...this.ctx.storage.sql.exec(
      `SELECT COUNT(DISTINCT e.email) AS total FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
       WHERE m.universeGalaxyStarId IN (${placeholders}) AND e.email != ?`,
      ...args,
    )];

    const sample = [...this.ctx.storage.sql.exec(
      `SELECT e.email AS email, MIN(m.universeGalaxyStarId) AS instanceName
       FROM Memberships m JOIN Emails e ON e.emailId = m.emailId
       WHERE m.universeGalaxyStarId IN (${placeholders}) AND e.email != ?
       GROUP BY email ORDER BY email LIMIT 25`,
      ...args,
    )].map(r => ({ instanceName: r.instanceName as string, email: r.email as string }));

    return { total: Number(totalRows[0]?.total ?? 0), sample };
  }

  // ============================================
  // Email
  // ============================================

  async #sendEmail(message: EmailMessage): Promise<void> {
    // ⚠️ Typed on BOTH sides deliberately — `message: EmailMessage` and the binding below. This is
    // the choke point every outbound mail passes through, so it is the only place that can make
    // `EmailMessage`'s required `instanceName` actually bite: while this read `(message: any)` over
    // `(this.env as any)`, the type was erased twice and adding a required field produced ZERO
    // diagnostics. The binding is widened by intersection rather than declared locally because
    // `nebula-auth`'s own generated `Env` has no `AUTH_EMAIL_SENDER` — the consumer
    // (`apps/nebula`) declares it (`packaging.md` § Use the global `Env`).
    const sender = (this.env as Env & { AUTH_EMAIL_SENDER?: { send(m: EmailMessage): Promise<void> } })
      .AUTH_EMAIL_SENDER;
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

    // Entry marker: a request the edge is going to REFUSE (wrong verb, unknown path, failed guard)
    // must never enter the singleton — an edge 405 and a DO 405 are identical to the caller, so
    // tests assert non-entry through the debug sink on this line. `headerNames` (names only, never
    // values) is what makes forward FIDELITY observable: a raw forward preserves every header,
    // where a rebuild drops all but Content-Type. Pathname only — never the full URL.
    // `forEach` rather than the iterator helpers: this file is also type-checked under Node-lib
    // programs (the /live harness compiles it transitively via the nebula-auth barrel), whose
    // `Headers` lacks `.keys()`; `forEach` exists in both lib worlds.
    const headerNames: string[] = [];
    request.headers.forEach((_value, name) => headerNames.push(name));
    debug('nebula-auth.Registry.fetch').debug('entry', {
      method: request.method, pathname: url.pathname, headerNames,
    });

    // Defense in depth: the edge already answers 405 itself; this holds for any non-router caller.
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const endpoint = url.pathname.slice(prefix.length + 1); // after '/auth/'

    // ⚠️ The three OPEN endpoints are forwarded RAW (`stub.fetch(request)`) — the Worker no longer
    // rebuilds their body, so its `?? {}` no longer absorbs a malformed one. Without this guard
    // `await request.json()` throws a `SyntaxError`, which is not a `RegistryError` and so falls to
    // the 500 fallback below — turning a client's bad JSON into an internal error. Parse once, here,
    // and answer in the same `{ error, error_description }` shape as the six sibling 400s.
    // A non-object body (`null`, `"str"`, `[]`) is rejected the same way: every field read below would
    // otherwise TypeError into the 500 fallback, which is the very shape this guard exists to prevent.
    const OPEN_ENDPOINTS = new Set(['claim-universe', 'claim-star']);
    let openBody: Record<string, any> | undefined;
    if (OPEN_ENDPOINTS.has(endpoint)) {
      let parsedBody: unknown;
      try { parsedBody = await request.json(); }
      catch { parsedBody = undefined; }
      if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
        return Response.json(
          { error: 'invalid_request', error_description: 'Request body must be JSON' },
          { status: 400 },
        );
      }
      openBody = parsedBody as Record<string, any>;
    }

    try {
      switch (endpoint) {
        case 'claim-universe': {
          const { slug, email } = openBody as { slug: string; email: string };
          return Response.json(await this.claimUniverse(slug, email, url.origin));
        }
        case 'claim-star': {
          const { universeGalaxyStarId, email } = openBody as {
            universeGalaxyStarId: string; email: string;
          };
          return Response.json(await this.claimStar(universeGalaxyStarId, email, url.origin));
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
        case 'scope-summary': {
          const { verifiedProfileId, verifiedSub } = await request.json() as
            { verifiedProfileId?: string; verifiedSub?: string };
          if (!verifiedProfileId || !verifiedSub) {
            return Response.json({ error: 'invalid_request', error_description: 'Missing verified identity' }, { status: 400 });
          }
          return Response.json(this.getScopeSummary(verifiedProfileId, verifiedSub));
        }
        case 'expand-scope': {
          const { verifiedProfileId, parent, after } = await request.json() as
            { verifiedProfileId?: string; parent?: string; after?: string };
          if (!verifiedProfileId || typeof parent !== 'string') {
            return Response.json({ error: 'invalid_request', error_description: 'Missing verified identity or parent' }, { status: 400 });
          }
          return Response.json(this.expandScope(verifiedProfileId, parent, typeof after === 'string' ? after : undefined));
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
          const { target, verifiedAccess, callerSub, callerClaims } = await request.json() as {
            target: string; verifiedAccess?: AccessEntry; callerSub?: string;
            callerClaims?: NebulaJwtPayload;
          };
          // `callerClaims` is in the fail-closed guard deliberately: ADR-016's record is not
          // retrofittable, so a branch that forgets to inject it must 400, never under-record.
          if (!verifiedAccess || !callerSub || !callerClaims) {
            return Response.json({ error: 'invalid_request', error_description: 'Missing verified caller identity' }, { status: 400 });
          }
          return Response.json(await this.executeScopeDeletion(target, callerSub, verifiedAccess, callerClaims));
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

  // Both delegate to the ONE shared predicate (ADR-007 — one guard path, one place to audit).
  // They are kept as named private wrappers only because their call sites read better with the TIER
  // named; neither may reintroduce an inline `scopeAdmin && isAtOrAbove(...)`.
  //
  // ⚠️ A third wrapper, `#hasDominionOver`, was deleted: it shadowed the imported predicate under
  // the identical name and added nothing, so its one caller now calls `hasDominionOver` directly.
  // Adding a tier to the name is what earns a wrapper here; re-spelling the same name is not.

  /**
   * Dominion over a universe. Delegates to the shared predicate; its sole caller passes
   * `parsed.universe`, which `isValidSlug` guarantees is a single dot-free segment.
   */
  #hasDominionOverUniverse(access: AccessEntry | undefined, universe: string): boolean {
    return hasDominionOver(access, universe);
  }

  /** Dominion over a galaxy via the one shared predicate. */
  #hasDominionOverGalaxy(access: AccessEntry | undefined, galaxyId: string): boolean {
    return hasDominionOver(access, galaxyId);
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
 * scope), the consume and summary WHERE clauses, the delete-scope caller-exclusion), so
 * a stray leading/trailing space at mint that a trimmed login can't match would silently split an
 * identity and lock the owner out. Lowercasing alone is not enough — trim too.
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
