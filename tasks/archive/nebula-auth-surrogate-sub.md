# nebula-auth: surrogate `sub` + dissolve NebulaAuth into Worker + KV

> **✅ DONE — CODE BUILT + GREEN, ARCHIVED 2026-07-13.** Phases 1–3 implemented; `nebula-auth`
> type-check clean, **vitest 184** (183 pass + 1 `it.skip` m6), branch cov 80.3%; `apps/nebula` +
> Studio UI type-check clean. `/build-task` verifier fan-out (6 adversarial verifiers + independent
> adjudicators → **8 confirmed findings, 0 false-positive**) + a focused re-verifier — ALL fixed
> (headline: removed the escalation-prone open `claimStar`; de-vacuum'd the M4 test). **NOT deployed +
> NOT committed at archive time** (the go-ahead + commit follow).
> **Deferred work re-homed to LIVE files (this archived file is frozen):**
> • **Phase 4 batch wipe** → [nebula-pre-alpha.md](../nebula-pre-alpha.md) (chat-UI milestone) — runbook is Phase 4 below.
> • **Phase 5 docs** + **`apps/nebula` baseline test re-grounding** (login no longer mints — the ~243
>   baseline-lane reds) → [backlog.md](../backlog.md) § Nebula Auth.
> • Backlog "orphaned-tokens" marked ✅ resolved; "email-reuse hardening" re-pointed to the new schema.

**Status**: **New (2026-07-08; rescoped 2026-07-11; reviewed + reshaped 2026-07-13 — `/review-task` Stage 1)** — two **coupled** auth-model fixes landed in one greenfield wipe: **(1)** stop keying identity off the email — key off a registry-minted surrogate opaque unique id, **`sub`**; **(2)** **dissolve the per-scope `NebulaAuth` DO** — its hot token/session state (key-by-token, TTL-shaped) moves to **Workers KV**, its cold identity/relational remainder moves to the **registry**, and token handling runs in the **default Worker** (which already composes nebula-auth via `routeNebulaAuthRequest`). `profileId` + the Profile store are **entirely** the follow-on [nebula-profile-store.md](nebula-profile-store.md) — not this task. Requires a full **system wipe** (fine now — no pre-alpha users). Child of [nebula-pre-alpha.md](nebula-pre-alpha.md).
> **Review decisions (2026-07-13, Larry — two `/review-task` Stage-1 rounds):** kept the two fixes **coupled** (split rejected — bank the free one-way-door, §The wipe); **`email` + `adminApproved` removed from the JWT** — delete-scope re-keyed `sub`-first, `adminApproved` retired — enforced at **MINT** (the registry won't mint for an absent/unverified identity, so a valid token proves membership; the edge gate is **removed**, not re-homed — B1/M5); **`isAdmin` at refresh is pure-KV** (stale read-through deleted); the scope-registry table is **KEPT, renamed `Instances`→`Scopes`** (existence is NOT derivable from `Identity` — a wildcard-managed child scope has zero members) → no founder-stamping, no consent inversion; **`AuthorizedActor` CUT** in the wipe (the future external-AI path is delegation-hardening §B `actAs`, not this table). **Automated review complete** (Stage-2 conformance folded in: mint-time gating; Worker-relocation server-trust — M1/M2; KV-lifetime footguns — M3/M4); human pass next.

> **Build status (2026-07-13, `/build-task` — Phases 1–3 COMPLETE, code green):** ✅ Registry logic (`nebula-auth-registry.ts` — `getAndVerifyIdentity` find-and-flip/reject, mint-at-authority, login-channel hash+verify, `Scopes` queries, `sub`-first fail-closed `executeScopeDeletion`, KV write/converge/revoke, `changeEmail`); ✅ Worker token layer + KV (`worker-token.ts` NEW + `verify.ts` NEW + `router.ts` rewritten — refresh/magic-link/logout/invite/delegated-token, JWT minted in the Worker with `email`+`adminApproved` dropped, `activeScope`-from-KV M1, index-first M3, original-expiry re-put M4, edge gate `router.ts:541` REMOVED M5); ✅ dissolved `nebula-auth.ts` (DO deleted) + `access-claims.ts`; ✅ 4 wranglers (NebulaAuth removed, `REFRESH_TOKEN_KV` added); ✅ downstream (`nebula-client.ts author:sub`, `App.vue` discover shape, harness, 3 test harnesses). **Type-check 0 errors; vitest 183 passed + 1 `it.skip` (m6); branch coverage 80.3%.** ✅ **Verifier fan-out run** (6 adversarial verifiers + independent adjudicators, 8 confirmed findings, 0 false positives) — ALL fixed: **removed the open founder-minting `claimStar`** (it re-opened the stranger-claims-a-child escalation — non-conformant with the pinned "Star = parent Galaxy admin, wildcard-managed" model; star creation is `createStar`); **fixed the vacuous M4 test** (now asserts real KV `expiration` metadata, mutation-verified); shared `normalizeEmail` (lowercase **+ trim**, m1); `revokeRefreshToken` KV-delete-first; regen 2 stale harness `worker-configuration.d.ts`; corrected the prod-wrangler migrations comment + `audit-migrations.mjs` count 8→7; updated `security.md` (no-slide + eventual-consistency revocation window). **NOT committed** (awaiting the go-ahead).
>
> **⏭️ Phase 4 (the WIPE) — DEFERRED + BATCHED (decision 2026-07-13, Larry):** do NOT wipe for surrogate-sub alone. The pre-user window stays open (F&F invites paused), so the surrogate-sub foundation lands on `pre-alpha` **undeployed**, profile → presence → chat build on it, and **one** CF-dashboard worker-delete + greenfield redeploy happens at the **multi-user-chat-UI milestone** (spends one disruptive reset, not several). ⚠️ The one thing local `wrangler dev`/vitest cannot verify is **real-CF KV read-your-write on the login→first-refresh path** (miniflare KV is strongly consistent; multi-colo prod isn't) — treat it as **verify-first** at the batch wipe (or de-risk in code: have the magic-link click hand back the first access token). Runbook preserved in **Phase 4** below.
>
> **Phase 5 (docs) — DEFERRED pending a call:** publishing nebula-auth INTERNALS to the public website is questionable (internal auth architecture); confirm whether/where before writing.

## The problem
**(1) Email is a natural key doing cross-DO FK duty.** People change email addresses (acquisition/domain change, legal name change). Today the **only** link between the singleton **registry** DO and the per-scope **NebulaAuth** DOs is the **email string** (`Emails.email` ↔ `Subjects.email`) — a natural key as a foreign key across DO boundaries (which SQLite can't enforce). It bites: **no safe email-change flow** (no cross-DO transaction/cascade/`ALTER`); a **latent migration bomb** (re-keying identity across N versioned DOs after real data is brutal — the cheap window is now); and it makes the rare **email-reuse security fix** an N-entity update instead of one write.

**(2) The per-scope `NebulaAuth` DO is the wrong home for token state.** RefreshTokens / MagicLinks / InviteTokens are pure **key-by-token, TTL-shaped** state, but they live in per-authScope SQLite. That home costs: **cleanup is manual** — and today it's a **dead `ON DELETE CASCADE`** (FK enforcement off → orphaned tokens on subject-delete); it's **single-location** (no edge reads; a hot scope serializes on one DO); and it's ~1,500 LOC of DO. The hot, registry-free part — refresh validation — wants **Workers KV** (TTL, edge reads, scale); everything else (identity, delegation, and the login-channel tokens, whose verify hits the registry anyway) belongs in the registry.

## The fix
**(1) Registry-minted surrogate `sub`** — a registry-minted UUID, **one per (email, scope)** (the same email in two scopes → two `sub`s), the identity key. `email` becomes a **mutable attribute** owned only in the registry — changing it is a one-row update, because nothing keys off it. (Today `sub` is minted per-instance in `#loginSubject` ([nebula-auth.ts:1367](packages/nebula-auth/src/nebula-auth.ts)); minting moves to the registry as the single identity authority.)

**(2) Dissolve `NebulaAuth`:**
- **Refresh tokens → Workers KV** (keyed by `tokenHash`, fixed TTL = auto-cleanup) — the ONE high-frequency, registry-free read path, served at the edge by the **default Worker** (imports nebula-auth — the same composition as today's `routeNebulaAuthRequest`, already in `apps/nebula/src/entrypoint.ts`). No per-scope DO.
- **Everything else → registry**: `Identity` (was `Emails` **+** `Subjects`) **and the `MagicLink`/`InviteToken` login channel** — their verify always calls the registry (`getAndVerifyIdentity`) anyway, they're low-frequency, and the registry's strong consistency buys atomic invite single-use + no read-your-write gap (a cheap sweep replaces KV TTL). The `Scopes` registry (renamed from `Instances`) stays here too.
- **Dropped**: `lastLoginAt` (YAGNI); the unused **subject-mgmt** HTTP surface (`GET /subjects`, subject CRUD — not app/frontend-called); **`adminApproved`** (retired — the pre-create model makes an `Identity` row itself the "authorized member" signal; §Blast radius); **`AuthorizedActor`** + its actor-mgmt endpoints + the `/delegated-token` non-admin branch (**cut** in this wipe — "surface-reduction with no consumer" per [delegation-hardening.md](on-hold/delegation-hardening.md) §A; the admin delegation branch stays).
- **Kept + renamed**: the scope registry — **`Instances` → `Scopes`** (the per-scope DO it was named for is dissolved, so "instance" is a misnomer) — as the authoritative scope-existence + Universe-consent home. Existence is **NOT** derivable from `Identity` (an admin-created child scope managed via wildcard reach has a `Scopes` row and zero members), so no founder-`Identity` stamping and no consent inversion — both dissolve. See §The schema.

## The schema (TypeScript is the schema of record — ADR-001)
**Two homes** — the **registry DO** (identity, delegation, login-channel tokens) and **Workers KV** (the one hot record: refresh). No per-scope `NebulaAuth` DO.

```typescript
// Timestamps are ISO 8601 Zulu strings (ADR-011), e.g. "2026-07-11T00:00:00.000Z".

// ── REGISTRY (singleton DO) — identity authority + THE SINGLE WRITER of all state ──
// Owns the `Scopes` registry; mints `sub`; owns `email` + the login-channel tokens; writes the
// refresh KV record. All low-frequency (login/change) — fits the singleton's write ceiling.
// The high-frequency refresh READ is the only thing on KV (edge, registry-free).

interface Scope {                  // SQL table `Scopes` (renamed from `Instances`)
  universeGalaxyStarId: string;    // PK · "this scope exists"
  improveProductConsent?: boolean; // Universe data-use consent (opt-IN)
}
// WHY the table exists: existence is INDEPENDENT of membership. An admin-created
// child scope, managed via a parent's wildcard reach, has zero Identity rows yet
// must still exist (slug reserved, in myScopeTree, blocks re-claim). So existence
// canNOT derive from Identity — this table is its home. Renamed from `Instances`
// because the per-scope DO it was named for is dissolved by this task.
// WHY each field:
//  • universeGalaxyStarId (PK) — the existence fact + FK target of the ~10
//    existence-check sites (checkSlugAvailable / parent-exists / myScopeTree).
//  • improveProductConsent — Universe-level consent (opt-IN; shipped day-one;
//    read by listConsentedInstances). Nullable on non-Universe scopes; kept here
//    so the data-use model stays opt-IN (evicting it would flip it to opt-out).
// DROPPED vs old `Instances`: createdAt (YAGNI — nothing reads it).

interface Identity {               // SQL table `Identities` email-in-a-scope (was Emails+Subjects)
  sub: string;                     // PK · registry UUID · surrogate identity key
  universeGalaxyStarId: string;    // FK → Scope · the scope this identity is in
  email: string;                   // MUTABLE · current login address
  isAdmin: boolean;                // scope-admin; set at grant/creation
  emailVerified: boolean;          // per-scope proof-click · REPLACES `adminApproved`
  createdAt: string;
}
// `adminApproved` RETIRED (was a 2nd approval flag + JWT claim + 403 gate). Enforced at
// MINT instead: the registry won't mint for an absent/unverified identity, so a valid
// token proves membership → edge gate REMOVED, not re-homed (B1/M5; §Blast radius).
// `AuthorizedActor` (non-admin act-for delegation) is CUT in this wipe (§Blast radius),
// so there is NO delegation table; the `/delegated-token` admin branch survives.

interface RefreshTokenIndex {      // live-token index → reliable invalidation
  sub: string;                     // sub-indexed: find a sub's tokens on change
  tokenHash: string;               // → KV key `refresh:{tokenHash}` (cold)
  expiresAt: string;               // pruning only (stale = harmless no-op)
}
// Login-channel tokens live here too — verify ALWAYS calls getAndVerifyIdentity, so
// co-locate: low-freq, strongly consistent (read-your-write + atomic single-use).
// Short-lived + low-volume ⇒ a sweep replaces KV TTL (cheap; today's pattern).

interface MagicLink {              // PK tokenHash · ~30m · reusable (scanner-safe)
  tokenHash: string; email: string; universeGalaxyStarId: string; expiresAt: string;
}

interface InviteToken {            // PK tokenHash · single-use (delete on claim)
  tokenHash: string; email: string; universeGalaxyStarId: string; expiresAt: string;
}

// INVARIANTS
//  • UNIQUE (email, universeGalaxyStarId) — one identity per email per scope. The
//    compound key ALSO serves `WHERE email = ?` by leftmost-prefix → NO separate
//    email index (m8: a redundant write). discover(email) rides the compound key.
//  • EMAIL LOWERCASED at mint + on change — `UNIQUE` / discover / the delete-scope
//    `#otherUsers` exclusion all compare BINARY, so casing drift splits identities
//    or fail-blocks a delete (m1).
//  • WITHOUT ROWID on every TEXT-PK table (`Identity.sub`,
//    `Scopes.universeGalaxyStarId`, `MagicLink`/`InviteToken.tokenHash`).
//    `RefreshTokenIndex`: PK `tokenHash` WITHOUT ROWID + secondary index on `sub`
//    (read by `tokenHash` at logout, by `sub` at convergence).
//  • REPLICATION (ADR-010) — `sub` copies freely; `email` stays single-copy here.
//    `isAdmin` is denormalized into the KV refresh record; the registry (single writer)
//    is the convergence mechanism — pushes to KV on any admin/user/email change.
//  • BEARER TOKENS (refresh/magic-link/invite) stored as a one-way `tokenHash`, never raw —
//    a store leak yields no usable credential; high-entropy ⇒ fast hash, no salt/KDF.

// ── WORKERS KV — the ONE hot, registry-free read path: refresh-token validation ──
// Refresh verify hits KV only (edge, never the registry); TTL auto-cleans. Everything else
// (scopes, identity, login-channel tokens) is registry-owned, above.
interface RefreshTokenKV {  // key `refresh:{tokenHash}` · read at edge, no registry
  sub: string; universeGalaxyStarId: string; isAdmin: boolean; expiresAt: string;
}
// `expiresAt`: absolute expiry, copied from the index row. WHY: CF KV drops expirationTtl on a
// re-put, so the `isAdmin`-convergence re-put MUST re-apply THIS exact expiry — never a fresh TTL
// (would extend a demoted user's token), never omit it (immortal token).

// ── Profile DO (keyed by `profileId`) — out of scope here; owned by nebula-profile-store.md. ──
```

### Where each thing lives
| What | Home | How it's mutated |
|---|---|---|
| scope existence + Universe consent | Registry `Scopes` | `createGalaxy`/`createStar` register the row; consent set at `claimUniverse` |
| `sub`, `email`, `isAdmin`, `emailVerified` | Registry `Identity` | mint · one-row update · grant · seam |
| magic-link / invite tokens | Registry `MagicLink`/`InviteToken` | login channel; verify = **find-and-flip** (`getAndVerifyIdentity` — rejects if no `Identity` row); **swept** (short-TTL, low-volume) |
| refresh tokens (+ `isAdmin`) | **Workers KV** (read path) + registry `RefreshTokenIndex` | registry writes/invalidates; **Worker reads on refresh (no registry)**; TTL cleans |

An **email change writes only the registry `Identity` row** — `email` isn't a JWT claim and no token record keys off it, so nothing cascades.

## The seam — registry is the single writer; Worker + KV serve the hot read path
The **registry is the single writer** of authoritative state, incl. the KV token records — so the singleton is on the **login/change** path (low frequency), NEVER the **refresh** path. Its hard write-rps ceiling is spent on real writes, not refreshes.
- **First touch** (magic-link verify / invite claim): the Worker calls the **registry**, which in **one call** validates the `MagicLink`/`InviteToken` row (strongly consistent — no read-your-write gap; invite is atomically deleted = true single-use), runs **`getAndVerifyIdentity`** — **find-and-flip** `emailVerified` on the **already-existing** `Identity` row, **rejecting if none exists**. Minting happens **ONLY at authority points** — Universe `claimUniverse` + invite issuance — **never at login verify** (this is the load-bearing "an `Identity` row ⇒ authorized member" invariant — §Founder — that lets `adminApproved` retire). It records `(sub, tokenHash, expiresAt)` in `RefreshTokenIndex` (**sync SQLite, single-writer**) **FIRST**, then writes `refresh:{tokenHash} → { sub, scope, isAdmin, expiresAt }` to KV (fixed TTL). **Index-first is a seam invariant** (M3): an eviction at the awaited KV put then leaves at worst a revocable index-entry-without-KV-record, never a **live-but-unindexed** (unrevocable) token. The Worker mints the JWT (`sub` + `access.admin`) and sets the cookie. **`email` never enters the JWT.**
- **Refresh**, in the **Worker**: read `refresh:{tokenHash}` from **KV** (edge, TTL-validated) → mint the JWT with `isAdmin` **from the KV record**. ⚠️ **`activeScope` is server-validated against the KV record's `universeGalaxyStarId`, NOT the client body** (M1): derive `authScopePattern = buildAuthScopePattern(kv.universeGalaxyStarId)`, `matchAccess(pattern, requestedActiveScope)`, **reject if uncovered**, mint `aud = requestedActiveScope`. (The DO validated against its server-trusted `#instanceName`; the Worker has none, so deriving the pattern from client input would let a caller mint a token for **any scope they name**.) **The registry is not touched** — refresh scales on KV.
- **`isAdmin` change / user-removal / email change** are registry writes anyway → the registry enumerates the sub's `RefreshTokenIndex` and **updates or deletes the KV records** (the ADR-010 convergence for the denormalized `isAdmin`); the next refresh reflects it within KV propagation. ⚠️ On an **update** re-put, re-apply the record's **original absolute expiry** (`RefreshTokenIndex.expiresAt`) — CF KV drops `expirationTtl` across a `put`, so a fresh TTL would **extend** a demoted user's token and omitting it would make it **immortal** (M4).
- **Logout = the registry deletes the KV record + index entry.** ⚠️ **Accepted:** KV eventual consistency → a revoked/demoted token keeps working for the **KV-propagation window (~edge cacheTtl, up to ~60s) PLUS the full access-TTL (`ACCESS_TOKEN_TTL=900s`), REPEATABLE within it** (not "one more token"). A genuine softening of security.md's "logout still revokes" vs today's strongly-consistent DO revocation — state the real bound + lean the mitigation on the short access-TTL. Document in [security.md](.claude/rules/security.md) at build.
- **No slide** (decided 2026-07-11) — the refresh token gets a **fixed 30-day TTL at login** (a 30-day re-login is a fine UX cost), so **refresh is a pure KV read — zero writes on the hot path.** (We already dropped per-refresh *rotation*; dropping the *slide* too makes refresh fully read-only. Re-login is a fresh magic-link that re-issues the cookie + KV record. This also means security.md's "refresh-token TTL **+ slide**" line drops the slide.)

## Founder & pre-create — an authority stamps roles; first-touch only flips flags
Identity/scope creation is an **explicit authority action**, never inferred from which row lands first. First-touch (login) only flips proof/activity flags on an **already-existing** `Identity` row — it never confers a role, and (except a top-level self-signup) never mints. This retires today's `#loginSubject` first-user promotion (`shouldPromote = isBootstrap || subjectCount===0 …`) and **implements the pinned who-can-claim model** in [backlog.md](backlog.md) § Nebula Auth (Universe = open self-signup; Galaxy = parent Universe admin; Star = parent Galaxy admin; cross-tree = superadmin act-as):

| Flow | Who creates | Registered at creation (in the registry) |
|---|---|---|
| **Universe** (open self-signup) | the self-signup flow, *after* email-proof | `Scopes` row **+** founder `Identity` (`isAdmin=true`, `emailVerified=true`; email from the magic-link, not the JWT) |
| **Galaxy** (no self-signup) | the parent **Universe admin** | `Scopes` row **only** — the admin manages via `{u}.*` wildcard reach; **no local admin stamped** (designated-local-admin deferred → provisioning) |
| **Star** (current: no self-signup) | the parent **Galaxy admin** | same as Galaxy (`Scopes` row; wildcard-managed) |
| **Star** (future: self-signup) | the self-signup flow, *after* email-proof | `Scopes` row **+** founder `Identity` (`isAdmin=true`, `emailVerified=true`) |
| **Invite** (into an existing scope) | invite issuance | invitee `Identity` (`isAdmin=false`, `emailVerified=false`) pre-created; claim only flips flags |

Because a child scope is **pre-created by parent-admin authority** (never "first to land wins"), the current gap — a stranger claiming a Galaxy/Star under someone else's Universe by racing to it — closes structurally. (There's no per-scope DO to pre-create anymore — scope-creation just writes the registry rows.)

⚠️ **Seam — the registry stamps `isAdmin`; it does NOT seed the orgTree.** Self-signup (Universe now, Star later) creates a *new* scope + its *first* founder-admin only (joining an existing scope is Invite). The registry stamps that founder `isAdmin=true` (→ `access.admin` for the scope in the JWT) and **stops.** It must **not** reach into the Star to seed an orgTree root grant — that reverses the infra→platform dependency (`apps/nebula` → `nebula-auth`, never the other way) and drags DataPlane internals into auth, against ADR-008's point-of-action enforcement. The Star honors `access.admin` as **root authority via a bypass** (a scope-admin acts at the orgTree root with no seeded grant) — [nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md), **not this task.** The two layers meet at the JWT's `access.admin`.

⚠️ **Self-signup idempotency (Universe only):** a self-signup mints the *scope itself*, so `UNIQUE(email, universeGalaxyStarId)` can't backstop a double-submit (`universeGalaxyStarId` is newly minted each attempt) → two clicked magic links could spawn two Universes. Guard at the pending-signup layer, keyed on **`email` alone** (single-flight pending signups, or a 1:1 magic-link→Universe mapping so re-clicks converge). Every other flow is find-and-flip → naturally idempotent.

## The wipe (required — and fine right now)
This re-keys identity (`Emails → Identity`, now `sub`-PK), **deletes the `NebulaAuth` DO class + its per-scope namespaces**, and provisions a **KV namespace**. Rather than an in-place cross-DO migration, **wipe and redeploy greenfield** — safe because **there are no pre-alpha users yet.**
- Wipe = **delete the Worker project and every DO namespace that holds data.** ⚠️ Per [[wrangler-delete-leaves-do-data]]: `wrangler delete` **keeps** DO data (→ stale schema → prod `SQLITE_MISMATCH`); only a **CF dashboard worker-delete** truly clears DO storage. **Re-put secrets** + bind the KV namespace after redeploy.
- Deliberate use of the pre-user window; no migration path built (nor needed).
- **Why both fixes ride ONE wipe** (kept coupled; split considered + rejected 2026-07-13): only the identity **re-key** *needs* the wipe (you can't re-key across DOs after data exists). The dissolution rides along because deleting the `NebulaAuth` DO class is a **one-way-door** migration once users exist (pre-alpha's migrations door is already open) — free only *during* a full worker-delete, which the re-key already forces. So doing both now spends **one** disruptive wipe instead of a wipe now + a DO-class-delete migration at alpha; the alternative (defer the dissolution) trades that for shipping a second breaking change later. Accepted the larger pre-alpha change surface to bank the free one-way-door.

## Fixes vs. defers
- **Fixes** — a safe **email-change flow** (mutable attribute; no re-key); the **natural-key-as-cross-DO-FK fragility**; **and** the dead-`ON DELETE CASCADE` orphaned-token bug (dissolved by KV TTL — was a `backlog.md` § Nebula Auth item, now solved here).
- **Defers** — **email-reuse inheritance** (a reassigned mailbox still resolves to the same `sub`; the central `email→sub` authority is the one place to add an offboarding/re-verify latch later).

## Blast radius (enumerate at `/review-task`)
- `sub` minting relocates from `#loginSubject` into the registry — minted **only at authority points** (`claimUniverse` + invite issuance); login **verify** is `getAndVerifyIdentity` (find-and-flip, **no mint**, rejects if no row). The per-instance mint site goes away.
- **`NebulaAuth` DO dissolves.** Token handling (magic-link / refresh / logout / invite) moves into the **default Worker** (extend the already-composed `routeNebulaAuthRequest`) backed by **Workers KV**; `Subject` folds into the registry `Identity`; the **unused subject-mgmt** endpoints (`GET /subjects`, subject CRUD) are **dropped, not ported** (confirm nothing outside the app relies on them — harness/tests).
- **Delegation: `AuthorizedActor` is CUT in this wipe** (the one free window — no migration, no users). Drop the `AuthorizedActor` table, its add/remove actor-mgmt endpoints, and the `/delegated-token` **non-admin** branch ([nebula-auth.ts:1054](packages/nebula-auth/src/nebula-auth.ts)); **keep the admin branch** pre-alpha uses. The escalation fix already neutered the non-admin path (an authorized-actor now gets **no** `admin`), and [delegation-hardening.md](on-hold/delegation-hardening.md) §A calls its removal *"surface-reduction with no consumer — the ONE item left."* This does **not** foreclose the future external-AI participant: that path is §B's `actAs`-on-`CallOptions`, a **separate** mechanism that never touches this table. Cost = the 3-doc consistency pass §A names (`delegation.mdx`/`getting-started.md`/`testing.mdx`) + marking §A / `pre-alpha.md:34` done.
- **`executeScopeDeletion` re-homes** ([nebula-auth-registry.ts:458](packages/nebula-auth/src/nebula-auth-registry.ts)): with no per-scope DO it **no longer calls `teardownInstance()`** — for each affected scope it deletes the `Scopes` row + the registry `Identity` rows + their `RefreshTokenIndex` entries + login-channel tokens **and** the corresponding KV `refresh:{tokenHash}` records. The `#otherUsers` guard change rides the JWT-email bullet below.
- **Scope registry KEPT, renamed `Instances` → `Scopes`** (§The schema). Scope existence is **not** derivable from `Identity`: `createGalaxy`/`createStar` ([nebula-auth-registry.ts:326,382](packages/nebula-auth/src/nebula-auth-registry.ts)) register a scope that a parent admin then manages via **wildcard reach** with **zero** local members, so the registry row *is* the authoritative existence fact. `createGalaxy`/`createStar` keep registering the row (rename only); the ~10 `SELECT … FROM Instances` sites become `Scopes` queries. **No founder-`Identity` stamping** (the row, not a phantom member, encodes existence — so no `email`-plumbing, and delete-scope's `#otherUsers` counts only real members). **Consent stays put:** `improveProductConsent` remains a `Scopes` column ([:215](packages/nebula-auth/src/nebula-auth-registry.ts)), so opt-**in** + `listConsentedInstances` are unchanged (no opt-out inversion, no consent hand-off).
- **`adminApproved` RETIRED — enforced at MINT, not re-homed as an edge gate (B1/M5).** Today it's a second approval dimension: a column, a JWT claim, and a hard **Worker gate** at [router.ts:541](packages/nebula-auth/src/router.ts) (`!access.admin && !adminApproved` → 403); the DO-side check is [nebula-auth.ts:1283](packages/nebula-auth/src/nebula-auth.ts) (`#verifyRefreshTokenIdentity`, on the refresh path pure-KV replaces — **not** :362, which only triggers `#notifyAdminsOfSignup`). Retiring it is safe **only** if "an `Identity` row ⇒ authorized member," which holds **only** because mint is authority-gated (above). **Do NOT re-home the gate onto row-presence** — the edge gate runs off JWT claims and can't read the registry without breaking the pure-KV hot path (ADR-010). Instead make it a **mint-time invariant**: the registry **refuses to mint a JWT / write a KV refresh record for an absent-or-unverified identity**. A valid token then **proves** authorized membership by construction, so [router.ts:541](packages/nebula-auth/src/router.ts) is **redundant → REMOVE it**. ⚠️ Load-bearing: this is what closes the **stranger-self-join escalation** the retired `adminApproved` currently blocks — the unauthenticated Turnstile-only `email-magic-link` path must never mint.
- **First-user promotion RETIRED (the footgun), not replaced with child-founder-stamping.** `#loginSubject`'s `shouldPromote` goes away — first-touch into an existing scope no longer confers `isAdmin` (closes the stranger-claims-a-child gap). Universe self-signup still stamps its founder at **claim** (`email` from the magic-link flow, never the JWT); admin-created child scopes stay **wildcard-managed** (no local admin stamped). *Designated local admins* for child scopes (a Galaxy handed to a specific person) need the designee's email + is **deferred** to provisioning. Keep the `nebula-platform` bootstrap; confirm `isBootstrap` is scope-gated as it moves.
- **JWT: the `email` AND `adminApproved` claims are REMOVED (a deliberate shape change, not "unchanged").** `access.admin` + `access.authScopePattern` (via `buildAuthScopePattern` at mint, never stored) are unchanged; but `email` + `adminApproved` are currently claims ([access-claims.ts:96-97](packages/nebula-auth/src/access-claims.ts)) and dropping them is load-bearing (`adminApproved`'s mint-time retirement is the bullet above). Removing `email` makes it a **single-copy** mutable attribute (registry-only — cleanest ADR-010; nothing to converge) and keeps the pure-KV refresh record minimal. **`email` consumers to re-home:**
  - **delete-scope's trusted `callerEmail`** ([router.ts:291](packages/nebula-auth/src/router.ts) → the registry `#otherUsers` guard) — **re-keyed to `sub`-first**: the router passes the caller's verified **`sub`**; the registry resolves `sub → email` internally for the `#otherUsers` guard. That guard is inherently **cross-scope** (a subtree of scopes) and `sub` is per-scope here, so `email` stays the cross-scope join — but as an **ADR-010 indexed lookup, never a key**, and never carried in the JWT. ⚠️ **Fail CLOSED if `sub → email` resolves empty (M2):** an emptied lookup makes `email != NULL` match zero rows → the guard reports "no other users" and would **wipe a shared scope** — reachable by a just-removed admin still inside their ≤15-min access-token window. Refuse the delete on empty resolution.
  - **chat author display** ([nebula-client.ts:1390](apps/nebula/src/nebula-client.ts)) — already migrating to server-stamped `changedBy.sub` in [nebula-chat-history-multiuser.md](nebula-chat-history-multiuser.md).
  - **Supersedes** [nebula-profile-store.md](nebula-profile-store.md) § JWT decisions ("email STAYS in the JWT") — its display/audit email consumers resolve via the registry; reconcile when it un-pauses.
- Confirm the mint authz invariants ([security.md](.claude/rules/security.md)) — the `/delegated-token` **admin-branch** mint (scope-bounded, caller-reach-bound; the surviving delegation path) — survive the move to the Worker.
- **New**: a KV namespace binding (KV **confirmed working** in vitest-pool-workers / miniflare / `wrangler dev`); the registry is the **single writer** of KV records + keeps `RefreshTokenIndex` for reliable invalidation, so **refresh never touches the registry** (its rps ceiling is a *write* ceiling — spent on login/change, not refresh); the **revocation-staleness** note lands in security.md at build. **Accepted:** the `RefreshTokenIndex` isn't auto-pruned for now (stale entries are harmless no-op deletes) — same "live with it" stance as the pre-TTL DO cleanup; revisit if storage grows.
- **No `profileId`/Profile scope here** — wholly [nebula-profile-store.md](nebula-profile-store.md).

## Phases
> **ADR-009 rung labels (m4):** "real-login-grounded" below means the identity/token substrate grounds on real issuance. The **package vitest** suites log in via `?_test=true` magic-link = **rung 2** (test-mode issuance), NOT rung 1 (real email) — fine for unit grounding, but don't read a rung-2 pass as "real login." **Rung 1 (real email)** is the Phase-4 end-to-end vehicle.

### Phase 1 — Registry is the identity authority (`Scopes` + `Identity`); mint at authority, verify = `getAndVerifyIdentity`
**Goal**: the registry holds the `Scopes` registry + `Identity` (was `Emails`+`Subjects`) and **mints `sub` only at authority points** (`claimUniverse` + invite issuance) — nowhere else; login verify find-and-flips (no mint). `AuthorizedActor` is cut; the `/delegated-token` admin branch survives.
**Success criteria** (capable-of-failing, real-login-grounded per [ADR-009](docs/adr/009-real-auth-path.md)):
- [ ] **Mint only at authority points:** a `sub` + `Identity` row is minted at Universe `claimUniverse` + invite issuance; **login verify (`getAndVerifyIdentity`) NEVER mints** — it find-and-flips an existing row and **rejects** if none. A **returning** email resolves to the **same** `sub` (reds if it re-mints); grep-verify no `sub` is generated outside the registry, and **no mint on the `email-magic-link` login path**.
- [ ] **First-touch never promotes:** first login into an **existing** scope confers no role (retires `#loginSubject`'s `shouldPromote`). Universe self-signup stamps its founder `isAdmin=true` at **claim** (email from the magic-link); child scopes stay wildcard-managed (no local admin stamped). The `nebula-platform` bootstrap still gets `isAdmin`. **Negative control (real-login-grounded):** a stranger requesting `email-magic-link` for a Galaxy/Star they weren't invited to gets **NO `Identity` row AND is rejected at a protected route** (not merely "no `isAdmin`" — a minted row would defeat the mint-time gate).
- [ ] **`Scopes` (renamed from `Instances`) is the existence authority:** `createGalaxy`/`createStar` register a `Scopes` row; `checkSlugAvailable` / parent-exists / `myScopeTree` query `Scopes`. **Capable-of-failing:** an admin-created-but-**member-less** Galaxy (a `Scopes` row, zero `Identity`) is still discoverable + its slug reads unavailable (reds if existence is derived from `Identity`). `improveProductConsent` stays a `Scopes` column — opt-**in** + `listConsentedInstances` unchanged.
- [ ] **`AuthorizedActor` is cut:** the table, its actor-mgmt endpoints, and the `/delegated-token` **non-admin** branch are gone; the **admin** branch (scope-bounded, caller-reach-bound — [security.md](.claude/rules/security.md)) still mints. **Capable-of-failing:** an admin act-for within reach succeeds; a non-admin caller to `/delegated-token` is **rejected** (no authorized-actor path remains).
- [ ] **Self-signup idempotency (Universe):** two sequential `claimUniverse` clicks for the same email converge to the **same** `universeGalaxyStarId` + one founder `Identity` (the pending-signup single-flight — §Founder; `UNIQUE(email,scope)` can't backstop a freshly-minted scope id). Capable-of-failing (reds without the guard); low-immediacy for pre-alpha (no real third-party signup) — `it.skip` with the blocker named is acceptable (m6).

### Phase 2 — Token layer in the default Worker + Workers KV
**Goal**: magic-link / refresh / invite run in the Worker over KV; the `NebulaAuth` DO is gone.
**Success criteria** (capable-of-failing):
- [ ] Magic-link, refresh, logout, invite round-trip through the **Worker** against **KV** (real-login-grounded); the minted JWT carries `sub` + `access` (+ optional `act`) and **not** `email` **nor** `adminApproved` (both retired claims).
- [ ] **delete-scope no longer reads a JWT `email` claim** — the router passes the caller's verified `sub`; the registry resolves `sub → email` for the cross-scope `#otherUsers` guard (email an ADR-010 indexed **lookup**, never a key). **Capable-of-failing:** a delete-scope call succeeds with `email` absent from the JWT, and the "other users attached" guard still correctly **blocks** a genuinely-shared scope (reds if the guard admits or crashes on absent email).
- [ ] **`adminApproved` enforced at mint, edge gate removed:** no token/KV record mints for an absent-or-unverified identity, so [router.ts:541](packages/nebula-auth/src/router.ts) is **removed** as redundant (not re-homed). **Capable-of-failing, with a genuine `access.admin===false` invited member** (an admin fixture short-circuits the old `!access.admin && !adminApproved` → false-greens; testing.md's canonical trap, whose worked example is *this file*): the invited non-admin passes protected routes after claim; an **unverified/uninvited** identity is refused a token at mint. Mutation-check: reinstate a mint for an unverified identity → the test **reds**.
- [ ] **Expiry: refresh via KV TTL; magic-link/invite via the registry SWEEP** (per §The schema — only refresh is KV-TTL; magic-link/invite are registry-swept on `expiresAt`, not KV). **Revocation is NOT expiry** — subject-delete / logout / demote **deletes/updates the KV record via `RefreshTokenIndex`** (the actual orphaned-token fix). **Capable-of-failing (invalidation, vitest):** a revoked KV record → next refresh 401s. Real TTL-expiry isn't fast-forwardable under miniflare (60s wall-clock min, no clock control) → assert the KV `put` carries the correct `expirationTtl`, or mark it `wrangler dev`/deploy-only.
- [ ] **Refresh is a pure KV read** — `isAdmin` from the `RefreshTokenKV` record; the **registry is NOT on the refresh path**. **Capable-of-failing:** pair the zero-registry-call probe with a **positive control** (a login/change in the same test shows the registry marker firing — the debug-sink DO-side-marker pattern) so it can't pass vacuously. Drive the `isAdmin` convergence through the registry's **real admin-change endpoint** (never a direct KV write, which false-greens), assert the refreshed JWT's `access.admin` flips; mutation-check: delete the convergence push → next refresh stays stale → **reds**.
- [ ] **Logout deletes the KV record** (+ its `RefreshTokenIndex` entry); the accepted eventual-consistency revocation window is documented in security.md.
- [ ] The `NebulaAuth` DO class + its bindings are removed; the unused subject-mgmt endpoints, the `AuthorizedActor` actor-mgmt endpoints, and the `/delegated-token` non-admin branch are all gone.
- [ ] **Test-mode surfaces relocating to the Worker stay gated:** each `_test=true` raw-link echo (invite [nebula-auth.ts:897/921](packages/nebula-auth/src/nebula-auth.ts), `email-magic-link` [:265](packages/nebula-auth/src/nebula-auth.ts)) moving to the Worker stays behind `#isTestMode` / `miniflare.bindings` + un-routable in prod (security.md); **drop `#handleTestSetSubjectData`** (writes the retired `adminApproved`) rather than re-home it (n1).

### Phase 3 — `email` as a mutable attribute + a safe email-change flow
**Success criteria** (capable-of-failing):
- [ ] An email-change updates exactly one `Identity` row; the sub's tokens stay valid (KV records are `sub`-anchored, not email); login with the **new** address resolves to the **same** `sub`, the **old** no longer resolves.
- [ ] `discover(email)` reads `Identity` (the `UNIQUE(email,scope)` compound key) → resolves `universeGalaxyStarId`. ⚠️ **Response stays `{ universeGalaxyStarId, isAdmin }` — NO `sub`** (`sub` internal only; `discover` is unauthenticated/unthrottled, so returning the surrogate identity key widens the existing enumeration oracle). Add a "inherited + deferred — see backlog.md § Nebula Auth `discover(email)` oracle" pointer so the deferral survives the wipe (m7).

### Phase 4 — the wipe + greenfield redeploy  ⏭️ DEFERRED + BATCHED to the multi-user-chat-UI milestone
> **Do NOT run this for surrogate-sub alone (decision 2026-07-13).** The code lands on `pre-alpha`
> undeployed; profile → presence → chat build on it; then ONE wipe at the chat-UI milestone. The
> `wrangler.jsonc` + KV binding + `EXPECTED_DO_CLASS_COUNT` are already prepped in the working tree; the
> steps below are the **manual runbook** for when the batch wipe happens. **Larry's manual op** — do not
> let an agent execute the CF-dashboard delete or a prod deploy.

**Runbook (manual, at the batch-wipe milestone):**
1. **Provision KV**: `cd apps/nebula && npx wrangler kv namespace create REFRESH_TOKEN_KV` → copy the
   returned `id` into `apps/nebula/wrangler.jsonc` `kv_namespaces[0].id` (replacing the
   `REPLACE_WITH_REAL_KV_NAMESPACE_ID_AT_PHASE_4` placeholder).
2. **CF-DASHBOARD worker-delete** the `nebula` worker (NOT `wrangler delete` — that keeps DO data → stale
   schema → prod `SQLITE_MISMATCH`, [[wrangler-delete-leaves-do-data]]). This clears ALL DO storage
   (Universe/Galaxy/Star/DevStudio/DevContainer/NebulaAuthRegistry + the old per-scope NebulaAuth
   namespaces). The migrations array is already clean: `NebulaAuth` absent, `new_sqlite_classes:
   [… , "NebulaAuthRegistry"]`, **no `deleted_classes`** (m9 — the dashboard-delete resets migration
   history so redeploy is a fresh v1).
3. **Re-put secrets** (dashboard-delete drops them): the JWT BLUE/GREEN keys, `TURNSTILE_SECRET_KEY`,
   `RESEND_API_KEY`, `NEBULA_AUTH_BOOTSTRAP_EMAIL`, `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN`, etc.
4. **Deploy**: `apps/nebula/scripts/deploy.sh` (its `audit-migrations.mjs` preflight now expects
   `EXPECTED_DO_CLASS_COUNT=7`).
5. **VERIFY-FIRST (the local-untestable risk)**: real email-login round-trips end-to-end on the surrogate
   `sub` over Worker+KV — **rung-1 vehicle** (real magic-link — the `studio-chat-reload` browser path /
   `apps/nebula/harness/prod.ts`), NOT a rung-3 API mint. **Specifically confirm the login→first-refresh
   KV read-your-write works across colos** (miniflare can't test it); if it flakes, de-risk by minting the
   first access token at the magic-link click.
- [ ] **Refresh `backlog.md` § Nebula Auth "Email-reuse / subject-lifecycle hardening"** — its mechanics describe the *old* `Subjects` schema; re-point the deferred offboarding-latch design at the new registry `email→sub` authority.

### Phase 5 — document the model
**Success criteria**:
- [ ] A `.md` under `website/docs/nebula-auth/` carries the two-home schema (registry + KV) + invariants + the seam. (Confirm `.md` not `.mdx`, and that publishing nebula-auth internals is intended — [critical.md](.claude/rules/critical.md).)

## Non-goals / deferred
- **Email-reuse offboarding latch** — deferred (no real users); the central `email→sub` authority makes it a later one-place fix.
- **Everything `profileId`/Profile** — minting `profileId`, the `sub↔profileId` join, and the Profile DO are **entirely** [nebula-profile-store.md](nebula-profile-store.md), building on this task's `sub`. This task does not touch `profileId`.

## Related (you do NOT need to read it to build this)
This unblocks [nebula-profile-store.md](nebula-profile-store.md) — it consumes the registry-minted `sub`, then mints `profileId` and builds the Profile DO on top.
