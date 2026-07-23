# Collaborator invite + one human, one profile — the nebula-auth identity-mint path

**Status:** Prerequisite detour for the *collaborator* half of the multi-user headline in [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) (Stage-2 blocker **B1**). The **coach (super-admin) + owner** enroll without it; only a **non-admin peer** (Austen the UX designer) needs it. **Pinned with Larry 2026-07-19.**

> 🚧 **HARD GATE — Phase 1 is released by [nebula-confine-admin-bypass.md](archive/nebula-confine-admin-bypass.md) *Phase 1*** (that file's Relationships owns the release condition at phase granularity — don't restate it here). Phase 1 lets `issueInvites` mint admins at **any** tier, and a sub-universe admin is precisely the principal that walks through the unconfined `access.admin` bypass to act as admin on its **ancestors**. The defect exists in code today but **nothing currently mints such a principal — this task is what creates them**, so the gate is a genuine prerequisite, not a formality.

> **Lineage:** §3 absorbs the email-match half of the **P2 global-person** design (formerly `tasks/icebox/nebula-profile-p2-global-person.md`, parked 2026-07-15, un-iced 2026-07-19). Its **breadcrumb/linking half was cut back out** the same day — the `/review-task` panel showed that mechanism unbuildable — and now lives at [on-hold/nebula-profile-link-breadcrumb.md](on-hold/nebula-profile-link-breadcrumb.md). ⚠️ The **frozen** [profile-store archive](archive/nebula-profile-store.md) still points at the old icebox path; archived files are never edited, so those two files are the live homes.

**Objective — the `nebula-auth` identity-mint path.** Both changes are on the same call chain (`issueInvites` → `#mintIdentity`), so they are reviewed and built as one story:
1. An admin can invite a peer who becomes an **admin at the invited scope**.
2. That mint gives one human **one `profileId`, forever**, wherever the server can see it (same email, any scope).

The invitee then reaches everything through the **already-built scope-admin bypass** — no grant code, no new mechanism. Recognizing one human under *two different emails* is explicitly **out of scope** (see the on-hold file); the interim convention is **one email per human**, which is sufficient for every pre-alpha case.

## Frame — what exists, what's missing
Built already:
- **`/invite`** → `handleInvite` ([worker-token.ts:277](../packages/nebula-auth/src/worker-token.ts)) → `issueInvites` ([nebula-auth-registry.ts:475](../packages/nebula-auth/src/nebula-auth-registry.ts)): an admin issues invites into a scope — mints the invitee `Identity` + a single-use hashed `InviteTokens` row + emails an `accept-invite` link (test mode returns the raw link). **Admin-over-scope gated** at [worker-token.ts:283](../packages/nebula-auth/src/worker-token.ts), after the router's JWT + `matchAccess(pattern, instanceName)` check ([router.ts:319](../packages/nebula-auth/src/router.ts)).
- **`accept-invite`** ([router.ts:221](../packages/nebula-auth/src/router.ts) → [worker-token.ts:178](../packages/nebula-auth/src/worker-token.ts)) and **magic-link** both funnel through **`consumeAndLogin`** ([worker-token.ts:145](../packages/nebula-auth/src/worker-token.ts)) — real login per ADR-009, a bodiless 302 + refresh cookie.
- **The scope-admin bypass** ([dag-tree.ts:159](../apps/nebula/src/dag-tree.ts)): `requirePermission` returns early for any `access.admin` caller **before any DAG lookup**, and `enforceScopeReach` ([nebula-do.ts:66](../apps/nebula/src/nebula-do.ts)) admits them. **This carries the whole enrollment story** — an admin at `{u}.{g}` reaches every node on the Galaxy *and* the child `.dev` Star (`{u}.{g}.*` covers `{u}.{g}.dev`) with **no grant written and no new code**. There is no Galaxy self-grant and none is needed (`Star.onBeforeCall`'s self-grant, [star.ts:116](../apps/nebula/src/star.ts), is a request-access-climb terminus, not an access path). ⚠️ This same bypass is what the gate above is about — it is currently **unconfined**.
- **`setIdentityAdmin`** ([:624](../packages/nebula-auth/src/nebula-auth-registry.ts)) — flips the column **and** converges the denormalized copy into every live KV refresh record (original expiry re-applied). Zero production callers today; this task adds the first.

Missing:
1. **`/invite` cannot express "make this one an admin", nor a per-person answer** — its body is `{ emails: string[] }` ([worker-token.ts:285](../packages/nebula-auth/src/worker-token.ts)), a flat batch with no discriminator.
2. **`issueInvites` mints `isAdmin=false`** ([:490](../packages/nebula-auth/src/nebula-auth-registry.ts)) — and `#mintIdentity` ([:132](../packages/nebula-auth/src/nebula-auth-registry.ts)) **early-returns an existing `(email, scope)` identity at [:137](../packages/nebula-auth/src/nebula-auth-registry.ts) without touching `isAdmin`**, so the flag alone is a silent no-op for anyone already minted.
3. **`#mintIdentity` mints a fresh `profileId` per `(email, scope)`** — one human in two Galaxies gets two profiles.

## Decisions
| Decision | Rejected alternative — why |
|---|---|
| The admin flag rides **per invitee entry** | One flag per call — silently elevates everyone in a batch sent for one person. |
| Scope rides the **URL path** | In the body — would need re-verifying against the JWT, and two scopes can disagree. |
| **Works at every tier** (no tier check in this task) | Restricting to galaxy tier — a point solution. The *mint* invariant is uniform (§2); the *reach* asymmetry is a separate live bug fixed by the gating task, not papered over here. |
| Promotion is **promote-only** | Demoting on an `isAdmin:false` re-invite — a plain/F&F invite must never strip someone's existing admin. |
| **No revocation path in the interim** — accepted gap | Building a demote endpoint here — `setIdentityAdmin(sub, false)` already exists, so it is a thin wrapper when wanted ([backlog](backlog.md) § Nebula Auth, with a last-super-admin guard). |
| Reuse an existing `profileId` for a known email at **any** scope | Fresh per `(email, scope)` — one human gets two unlinked profiles, and ADR-012's global profile becomes vacuous. |
| **Same-email only**; different-email linking is out of scope | Building the breadcrumb/linking flow — verified unbuildable as designed and with no pre-alpha consumer ([on-hold](on-hold/nebula-profile-link-breadcrumb.md)). Interim convention: one email per human. |
| Profile writes are **owner + super-admin only** — drop the scoped-admin branch | Keeping it, or gating it on `emailVerified=1` — under a *global* profile it grants scope-local authority over a global object (§5). |
| **No backfill** of pre-existing split profiles | Migrating them — the milestone's planned prod wipe makes every identity greenfield. |
| Collaborator = **admin at the invited scope** | Varied per-node DAG tiers — deferred to [on-hold/nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md); needs a carrier not yet pinnable. |

## 1. The `/invite` request surface
```jsonc
// POST {NEBULA_AUTH_PREFIX}/{u}.{g}/invite   ← the SCOPE rides the PATH, never the body
{ "invitees": [
    { "email": "austen@example.com", "isAdmin": true },  // collaborator → admin at this scope
    { "email": "bob@example.com" }                       // omitted → plain member
] }
```
- **`emails: string[]` → `invitees: Array<{ email: string; isAdmin?: boolean }>`.** The entries are no longer emails, so the name changes with the shape. Clean break, no dual-shape alias.
- **Scope from the path:** `instanceName` is parsed there and passed to `handleInvite(request, env, instanceName, verifiedAccess)` ([router.ts:231](../packages/nebula-auth/src/router.ts)) — so the router's existing scope-match already gates it.
- **Strict per-entry normalization at the Worker gate — pass a CLEAN array onward, never the raw parsed body.** `handleInvite` maps into a typed `{ email: string; isAdmin: boolean }[]` via `entry.isAdmin === true` (ADR-001 validate-at-the-boundary; `request.json()` is an unchecked cast, so this **is** the field's validation — `"false"` / `"0"` / `1` must never mint an admin). ⚠️ Forwarding raw entries would re-open the same truthy-sink one layer deeper. Validate `Array.isArray(body.invitees)` and that each entry is an object with a string `email`; a malformed entry joins the existing `errors` array rather than failing the batch.
- **The flag is inert on its own** — parsed only *after* the router scope-match and the admin gate pass, so it selects an outcome and never grants authority. An omitted `isAdmin` keeps every plain/F&F invite a non-admin member, so this one field **is** the shared invite/collaborator discriminator.
- **The extension point for the deferred tiers:** per-person grants later become a richer per-entry spec (`{ email, grants: […] }`) with no second reshape of the envelope.
- Response shape unchanged (`{ invited, errors, links? }`, keyed by email).

## 2. Bounded reach — what the invariant does and does not promise
**The mint invariant:** the identity lands at the **path scope**, and the router has already proved the caller is `admin` over that path scope ([router.ts:319](../packages/nebula-auth/src/router.ts) + [worker-token.ts:283](../packages/nebula-auth/src/worker-token.ts)). The invitee's `authScopePattern` derives from that **invited** scope, never the inviter's ([parse-id.ts:114-119](../packages/nebula-auth/src/parse-id.ts)). **So what is minted never exceeds the inviter's own authority — at every tier.** No self-elevation.

⚠️ **But minted scope ≠ effective reach today.** The `access.admin` bypass is **unconfined**: both `requirePermission` ([dag-tree.ts:159](../apps/nebula/src/dag-tree.ts)) and `requireAdmin` ([nebula-do.ts:33](../apps/nebula/src/nebula-do.ts)) trust the bare bit without checking *which DO they are in*, while `enforceScopeReach`'s tenant branch admits callers whose `aud` sits **below** the DO. So an admin minted at any tier would reach its **ancestors** — verified against source, and the reason for the hard gate above. ⚠️ **Not reachable today only because no mint path produces a sub-universe admin** (`claimUniverse` → `{u}.*`, bootstrap → `*`, `issueInvites` → hardcoded `isAdmin: false`) — **this task's Phase 1 is what creates them.** **After [nebula-confine-admin-bypass.md](archive/nebula-confine-admin-bypass.md) Phase 1 lands, minted scope == effective reach and this table is true:**

| Invited at | Minted pattern | Reaches |
|---|---|---|
| `{u}.{g}.{s}` (star) | `{u}.{g}.{s}` (exact) | that Star only |
| `{u}.{g}` (galaxy) | `{u}.{g}.*` | the Galaxy + every Star beneath |
| `{u}` (universe) | `{u}.*` | everything in the Universe |
| `nebula-platform` | `'*'` | everything — a **super-admin invites a super-admin**, and only a super-admin can, since `matchAccess(pattern, 'nebula-platform')` is true only for `'*'` |

Making super-admin invitable is deliberate: today it needs an env-var change + redeploy (`NEBULA_AUTH_BOOTSTRAP_EMAIL`), so an invite is an *auditable* action instead of an unreviewed ops change. Stranger-self-join stays closed — the bootstrap gate in `requestMagicLink` is untouched.

⚠️ **The honest accepted cost** (the loud warning, not a footnote). An admin invited at `{u}.{g}` gets `{u}.{g}.*`: **read + write of end-user data in every current *and future* Star under that Galaxy** (including production/tenant Stars, which ADR-008's boundary explicitly disclaims); `create-star` and `delete-scope`; **inviting further admins**; and **no way to undo it** (see the revocation Decisions row).

**Defense-in-depth.** Dropping the hardcoded `false` turns a member-minting RPC into an admin-minting one, so its safety must not rest on a single Worker line: pass `verifiedAccess` into `issueInvites` and **re-assert admin-over-scope in-method**, matching `createGalaxy` ([:356](../packages/nebula-auth/src/nebula-auth-registry.ts)) / `createStar` ([:383](../packages/nebula-auth/src/nebula-auth-registry.ts)); throw on violation (an invariant breach, not the expected client error the Worker gate routes throw-free per raw-comm.md).

## 3. One human = one profile (same email, any scope)
**The model, GitHub-style: `sub` is per-(human, scope) — the *membership* record. `profileId` is the *account*: global, singular, permanent.** Grants ride scopes + the orgTree DAG, never identity duplication.

Today `#mintIdentity` mints a **fresh `profileId` for every new `(email, scope)` row**, so one person in two Galaxies gets two profiles. The fix, in `#mintIdentity` ([registry:132](../packages/nebula-auth/src/nebula-auth-registry.ts)) **above** the fresh-`profileId` INSERT at `:142`:

`SELECT profileId FROM Identities WHERE email = ? ORDER BY createdAt LIMIT 1` — reuse it; mint fresh only when the email is unknown Nebula-wide. Served by the existing `UNIQUE(email, scope)` leftmost-prefix, **no new index**. `sub` stays per-scope and **nothing re-keys** (ADR-013: resources key on `sub` only, so this is purely additive).

⚠️ **`#mintIdentity` is the single implementation site precisely because it has THREE callers**, all authority points that must inherit the reuse — `claimUniverse` ([:330](../packages/nebula-auth/src/nebula-auth-registry.ts)), the bootstrap platform-admin mint inside `requestMagicLink` ([:441](../packages/nebula-auth/src/nebula-auth-registry.ts)), and `issueInvites` ([:490](../packages/nebula-auth/src/nebula-auth-registry.ts)). Fixing it at the invite loop alone would let a human invited into someone else's Galaxy mint a **second** profile when they later claim their own Universe.

This is the designed intent: `idx_Identities_profileId` is **non-unique**, commented "`profileId ← 1..N subs` (P2 unification substrate)". **ADR-012 requires it** — "global cross-scope profile visibility" is vacuous if every scope mints a new `profileId`. **Different-email linking is out of scope** ([on-hold](on-hold/nebula-profile-link-breadcrumb.md)); the interim convention is one email per human.

## 4. What the mint writes (per invitee)
| | **A. New to Nebula** | **B. Already at THIS scope** | **C. Known, new to this scope** |
|---|---|---|---|
| `Identities` | **INSERT** — new `sub`, new `profileId`, `isAdmin`←flag (≈3 row-writes: row + `UNIQUE(email,scope)` + `idx_Identities_profileId`) | **NOTHING** — early-return; `sub`+`profileId` preserved, **`isAdmin` untouched** | **INSERT** — new `sub` (the per-scope *membership*), `isAdmin`←flag, **reusing their existing `profileId`** (§3) |
| Promote (`setIdentityAdmin`) | not needed | **`UPDATE … SET isAdmin=1`** + **one KV `put` per live refresh token** (via `RefreshTokenIndex WHERE sub=?`, original expiry re-applied) | not needed |
| `InviteTokens` | **INSERT** | same | same |

**On accept** (unchanged): `consumeInvite` DELETEs the `InviteTokens` row (single-use), INSERTs `RefreshTokenIndex`, writes KV `refresh:{tokenHash}` = `{ sub, universeGalaxyStarId, isAdmin, profileId, expiresAt }`.

Only **B** needs the promote step, and only **B** touches KV — at a cost that scales with the invitee's live sessions (3 devices = 3 puts).

## 5. 🔴 Blocker — unification turns the Profile's scoped-admin branch into a takeover primitive
`#requireOwnerOrAdmin` ([profile.ts:231-259](../packages/nebula-auth/src/profile.ts)) passes when `scopes.some(s => matchAccess(pattern, s))` over `getScopesForProfile(profileId)`, and it gates **public-field writes + `privateNotes` read/write**. Today that is near-vacuous (a profile spans one scope). **After §3 it spans every scope the human is in — and an admin can unilaterally add their own:** `issueInvites` mints the Identities row at *issue* time (`emailVerified=0`), so typing a victim's email into `POST /{u}.{g}/invite` inserts a row carrying the victim's reused `profileId` **before they accept or are even notified**. The inviter then reads their private notes and rewrites their global identity.

**Fix — same phase as §3: drop the scoped-admin branch. Owner + super-admin only.**
- Under a global profile the branch is a category error: scope-local authority over a global object.
- `emailVerified=1` closes only the *pre-acceptance* vector; a legitimately-accepted co-scope admin could still rewrite the victim's global identity.
- Super-admin (`pattern === '*'`) short-circuits at [:240](../packages/nebula-auth/src/profile.ts) **before** any read → platform moderation unaffected. ADR-012's boundary holds: `privateNotes` stays behind `requireOwnerOrAdmin`; we narrow *who qualifies*, not the gate.
- **Two bonuses:** it deletes the file's self-described "**ONE registry read**" (and its fail-closed complexity), and it leaves `getScopesForProfile` unused for authz — **collapsing the cross-scope membership oracle**.
- **Accepted cost:** a Galaxy admin can no longer fix a member's bad display name; moderation escalates to super-admin.
- ⚠️ **Modifies shipped code + deletes shipped tests** ([archive/nebula-profile-store.md](archive/nebula-profile-store.md) Phases 1–3, built 2026-07-14): delete the "scoped-admin exactly one read" + fail-closed-seam tests and the `lookupProfileScopes` override — remove the functionality *and* its tests, never ossify (testing.md).

## Phases
🚧 **Phase 1 is released by [nebula-confine-admin-bypass.md](archive/nebula-confine-admin-bypass.md) *Phase 1* only** — its Phases 2–3 are not prerequisites for this task.

1. **Per-invitee admin mint (auth).** Reshape the body to `invitees` (§1) and thread each entry's normalized `isAdmin` through `handleInvite` → `issueInvites(instanceName, invitees, origin, verifiedAccess)` (which re-asserts admin-over-scope in-method — §2); the existing loop ([:482](../packages/nebula-auth/src/nebula-auth-registry.ts)) reads `invitee.email` + `invitee.isAdmin`. **A/C** → drop the hardcoded `false` at [:490](../packages/nebula-auth/src/nebula-auth-registry.ts); **B** → `setIdentityAdmin(sub, true)`. **Promote-only.**
   - **Call sites:** replace every site matching `grep -rn "emails" --include="*.ts" packages/nebula-auth apps/nebula | grep -v node_modules` (~15 at time of writing), **plus** `packages/nebula-auth/README.md` (~:201, which diagrams the body shape) and `apps/nebula/test/test-helpers.ts:100` (`createSubject`, imported by ~17 baseline files — wire its currently-dead `isAdmin?` option through here; the collapse task's collaborator test needs it). ⚠️ **Do NOT touch `@lumenize/auth`** — the MIT package has its own `#handleInvite` / `body.emails` ([lumenize-auth.ts:743](../packages/auth/src/lumenize-auth.ts)) and its own consumers.
   - **Success — assert the PERSISTED bit, never the `/invite` 200** (identical for `true`/`false`): (i) net-new `isAdmin:true` → `getIdentityScope(sub).isAdmin === true`, or stronger (ADR-009) drive accept→refresh and assert `access.admin` in the JWT; (ii) **re-invite an existing `isAdmin=0` member with `isAdmin:true` → the accepted JWT now carries `access.admin`** (reds against the early-return); (iii) omitted flag — *and* explicit `isAdmin:false`, *and* wrong-typed `isAdmin:"false"` — still leave `isAdmin=0`.
   - **Success — mixed batch:** one call with `[{a, isAdmin:true}, {b}]` mints **`a` admin, `b` not**. Reds against a batch-level flag.
   - **Success — tier coverage:** a star-tier, a universe-tier, and a platform-tier mint each land with the pattern §2's table predicts. *(The star case only behaves correctly once the gating task has landed — it is the reason for the gate.)*
   - **Success — negatives, SPLIT so each is independently mutation-capable** (two disjoint gates, both 403 — assert the *body*): **(a)** non-admin, **same-scope** → refused at [worker-token.ts:283](../packages/nebula-auth/src/worker-token.ts), body `forbidden` (delete :283 → reds); **(b)** admin whose pattern does **not** cover the target — a *sibling* galaxy under a galaxy-scoped admin, **not** a Universe `{u}.*` admin → refused at [router.ts:319](../packages/nebula-auth/src/router.ts), body `insufficient_scope` (relax :319 → reds).
2. **One human = one profile + close the Profile gate (auth).** Add the `profileId` reuse in `#mintIdentity` (§3) — at that one site, so all three callers inherit it — and **drop the scoped-admin branch** in `#requireOwnerOrAdmin` (§5), deleting its tests and the `lookupProfileScopes` seam.
   - **Success — one human, one profile:** the same email invited into **two scopes** yields **different `sub`s and the SAME `profileId`**, and a name set via one is visible from the other. **Cross-path:** a human invited into someone else's Galaxy who then **claims their own Universe** gets a new `sub` and **the same `profileId`** (the criterion an invite-loop-only fix would fail). Negative: a **different** email gets a **different** `profileId`.
   - **Success — the gate is closed:** an admin of scope S who invites a victim's email (creating the unaccepted `emailVerified=0` row) **cannot** write that victim's profile or read `privateNotes`; the **owner** still can; a **super-admin** still can, with **zero** registry reads.
3. **Enrollment (Nebula) — verification, co-lands with the collapse.** No new grant code: confirm the accepted collaborator's admin JWT enrolls through the `access.admin` bypass. Un-skips the collaborator `it.skip` in the collapse task's final verification.
   - **Success:** an invited→accepted collaborator **posts + triggers a Nebula reply** and **creates a test user** in the `.dev` Star; a **non-enrolled but AUTHENTICATED** identity (valid JWT, no admin/grant over `{u}.{g}`) is **denied by the permission/reach check, not a 401**. Regression: the invite stays **single-use**. *(Behavioral half rides the collapse task's `/live` drive: `wrangler dev` + Docker, not pool-workers.)*

## Relationships
- 🚧 **Phase 1 released by [nebula-confine-admin-bypass.md](archive/nebula-confine-admin-bypass.md) Phase 1** — see that file's Relationships for the phase-granular condition (§2).
- **Depends on** the collapse task's collapsed **Galaxy chat session** (`SESSION_NODE_ID` exists) — only **Phase 3** co-lands with it; **Phases 1–2 are auth-side and land anytime** (after the gate).
- **Out of scope, parked:** different-email profile linking → [on-hold/nebula-profile-link-breadcrumb.md](on-hold/nebula-profile-link-breadcrumb.md).
- **Deferred:** varied per-collaborator tiers → [on-hold/nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md). Self-signup is that carrier's consumer #2.
- **Modifies shipped code** — §5 touches [archive/nebula-profile-store.md](archive/nebula-profile-store.md) Phases 1–3 and deletes some of its tests.
- **Also here:** Profile-DO teardown on scope deletion (tracked in [backlog.md](backlog.md) § Profile store follow-ons) — under unification the rule becomes *delete the Profile DO when `Identities WHERE profileId` is empty*, folded into the scope-deletion cascade.
- **F&F invites** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § Invite-gated) ride the **same `/invite`** as non-admin invites (flag defaulted `false`).
