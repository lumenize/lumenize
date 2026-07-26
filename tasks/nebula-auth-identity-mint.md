# Collaborator invite + one human, one profile — the nebula-auth identity path

**Status:** Prerequisite detour for the *collaborator* half of the multi-user headline in [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) (its Costs/risks **B1**). The **coach (super-admin) + owner** enroll without it; only a **non-admin peer** (Austen the UX designer) needs it. Business decision pinned with Larry 2026-07-19.

**Objective.** Two changes to the `nebula-auth` identity path, built as one story — they touch the same table (`Identities`) in the same milestone, and Phase 3 needs both (a collaborator who is an admin *and* renders with a name):

1. **An admin can invite a peer who becomes an admin bounded to the invited scope** — least privilege. At the Galaxy tier that is a collaborator on one app who is not an admin of the whole Universe. `issueInvites(universeGalaxyStarId, …)` is already generic on scope, so this needs no new mechanism: only a per-invitee `isAdmin` flag and dropping a hardcoded `false`.
2. **One human, one `profileId`, forever** — same email, any scope, from the moment they prove control of the mailbox.

The invitee then reaches everything through the **already-built scope-admin bypass** — no grant code, no new mechanism. Recognizing one human under *two different emails* is out of scope ([on-hold/nebula-profile-link-breadcrumb.md](on-hold/nebula-profile-link-breadcrumb.md)); the interim convention is **one email per human**, sufficient for every pre-alpha case.

## Frame — what exists, what's missing
Built already:
- **`/invite`** → `handleInvite` ([`handleInvite`](../packages/nebula-auth/src/worker-token.ts)) → `issueInvites` ([`issueInvites`](../packages/nebula-auth/src/nebula-auth-registry.ts)): an admin issues invites into a scope — mints the invitee `Identity` + a single-use hashed `InviteTokens` row + emails an `accept-invite` link (test mode returns the raw link). **Admin-over-scope gated** in `handleInvite` — [`if (verifiedAccess.admin !== true) return errorResponse(403, 'forbidden', …)`](../packages/nebula-auth/src/worker-token.ts), after the router's JWT + `matchAccess(pattern, instanceName)` check (`checkJwtForInstance`'s [`matchAccess(payload.access.authScopePattern, instanceName)` → 403 `insufficient_scope`](../packages/nebula-auth/src/router.ts)).
- **`accept-invite`** (the router's `accept-invite` branch → [`handleAcceptInvite`](../packages/nebula-auth/src/worker-token.ts)) and **magic-link** both funnel through **`consumeAndLogin`** ([here](../packages/nebula-auth/src/worker-token.ts)) — real login per ADR-009, a bodiless 302 + refresh cookie. Both reach **`getAndVerifyIdentity`** ([`getAndVerifyIdentity`](../packages/nebula-auth/src/nebula-auth-registry.ts)), the one place a human's control of a mailbox is established.
- **The scope-admin bypass** ([`requirePermission`](../apps/nebula/src/dag-tree.ts) — the `accessAdmin` early-return, before any DAG lookup), with `enforceScopeReach` ([`enforceScopeReach`](../apps/nebula/src/nebula-do.ts)) admitting the caller. **This carries the whole enrollment story** — an admin at `{u}.{g}` reaches every node on the Galaxy *and* the child `.dev` Star (`{u}.{g}.*` covers `{u}.{g}.dev`) with **no grant written and no new code**. There is no Galaxy self-grant and none is needed (`Star.onBeforeCall`'s self-grant, [`Star.onBeforeCall`](../apps/nebula/src/star.ts), is a request-access-climb terminus, not an access path). The bypass is **confined to the node it covers** — `hasAdminOverScope(access, <this node's instance name>)` at every admin check — so that Galaxy admin reaches the Galaxy and everything beneath it, and nothing above.
- **`setIdentityAdmin`** ([here](../packages/nebula-auth/src/nebula-auth-registry.ts)) — flips the column **and** converges the denormalized copy into every live KV refresh record (original expiry re-applied). Zero production callers today; this task adds the first.

Missing:
1. **`/invite` cannot express "make this one an admin", nor a per-person answer** — its body is `{ emails: string[] }` — [`let body: { emails?: string[] }` … `if (!Array.isArray(body.emails))`](../packages/nebula-auth/src/worker-token.ts), a flat batch with no discriminator.
2. **`issueInvites` mints `isAdmin=false`** — its loop calls [`#mintIdentity(email, universeGalaxyStarId, /* isAdmin */ false, /* emailVerified */ false)`](../packages/nebula-auth/src/nebula-auth-registry.ts), and [`#mintIdentity`](../packages/nebula-auth/src/nebula-auth-registry.ts) **early-returns an existing `(email, scope)` identity — `if (existing.length > 0) return existing[0].sub` — without touching `isAdmin`**, so the flag alone is a silent no-op for anyone already minted.
3. **Nothing ever joins a person's profiles** — `#mintIdentity` mints a fresh `profileId` per `(email, scope)`, and no later step reconciles them, so one human in two Galaxies has two unlinked profiles forever.

## Decisions
| Decision | Rejected alternative — why |
|---|---|
| The admin flag rides **per invitee entry** | One flag per call — silently elevates everyone in a batch sent for one person. |
| Scope rides the **URL path** | In the body — would need re-verifying against the JWT, and two scopes can disagree. |
| **Works at every tier** (no tier check in this task) | Restricting to galaxy tier — a point solution. The mint invariant is uniform across tiers (§2), and so is reach, now that every admin check is confined to its own node. |
| Promotion is **promote-only** | Demoting on an `isAdmin:false` re-invite — a plain/F&F invite must never strip someone's existing admin. |
| **No revocation path in the interim** — accepted gap | Building a demote endpoint here. `setIdentityAdmin(sub, false)` already exists and already converges KV, so it is a thin admin-gated wrapper when wanted ([backlog.md](backlog.md) § Nebula Auth, which pins the shape + a last-super-admin guard). The gap is bounded to **mis-grants, not escalation** — the reach invariant (§2) means an inviter can never grant beyond their own reach. |
| **Join at verification** — one `profileId` per human, adopted when they prove the mailbox | (a) Fresh per `(email, scope)` — one human gets two unlinked profiles and ADR-012's global profile is vacuous. (b) **Reuse at mint** — the association forms when anyone merely *types* your email (two of the four mint paths are open, Turnstile-only), and an attacker's older unverified row captures your canonical id. Verification costs **no extra step and no second email**: it rides the magic-link click the flow already requires. |
| The canonical-id lookup filters **`AND emailVerified = 1`** | Ordering by `createdAt` alone — an attacker's older *unverified* row wins the first-mover race and becomes the victim's canonical `profileId`. |
| **Same-email only**; different-email linking is out of scope | Building the breadcrumb/linking flow — verified unbuildable as designed and with no pre-alpha consumer ([on-hold](on-hold/nebula-profile-link-breadcrumb.md)). Interim convention: one email per human. |
| Profile writes are **owner + super-admin only** — drop the scoped-admin branch | Keeping it — a profile is never an authz input (§5, ADR-012 as amended). Or gating **the write** on `emailVerified=1` — closes only the pre-acceptance vector, still lets a legitimately-joined co-scope admin rewrite a global identity, and conflates the write gate with the **join** condition, which §3 owns. |
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
- **Scope from the path:** `instanceName` is parsed there and passed to `handleInvite(request, env, instanceName, verifiedAccess)` (the router's `invite` branch: `handleInvite(request, env, instanceName, authResult.payload.access)`) — so the router's existing scope-match already gates it.
- **Strict per-entry normalization at the Worker gate — pass a CLEAN array onward, never the raw parsed body.** `handleInvite` maps into a typed `{ email: string; isAdmin: boolean }[]` via `entry.isAdmin === true` (ADR-001 validate-at-the-boundary; `request.json()` is an unchecked cast, so this **is** the field's validation — `"false"` / `"0"` / `1` must never mint an admin). ⚠️ Forwarding raw entries would re-open the same truthy-sink one layer deeper. Validate `Array.isArray(body.invitees)` and that each entry is an object with a string `email`; a malformed entry joins the existing `errors` array rather than failing the batch.
- **The flag is inert on its own** — parsed only *after* the router scope-match and the admin gate pass, so it selects an outcome and never grants authority. An omitted `isAdmin` keeps every plain/F&F invite a non-admin member, so this one field **is** the shared invite/collaborator discriminator.
- **The extension point for the deferred tiers:** per-person grants later become a richer per-entry spec (`{ email, grants: […] }`) with no second reshape of the envelope.
- Response shape unchanged (`{ invited, errors, links? }`, keyed by email).

## 2. Bounded reach
**The mint invariant:** the identity lands at the **path scope**, and the router has already proved the caller is `admin` over that path scope (the router's `matchAccess` scope-check + `handleInvite`'s `verifiedAccess.admin` gate). The invitee's `authScopePattern` derives from that **invited** scope, never the inviter's ([`buildAuthScopePattern`](../packages/nebula-auth/src/parse-id.ts)). **So what is minted never exceeds the inviter's own authority — at every tier.** No self-elevation.

**Minted scope == effective reach.** Every admin check is confined to the node it runs in — `hasAdminOverScope(access, <this node's instance name>)` in `requireAdmin` / `enforceScopeReach` ([nebula-do.ts](../apps/nebula/src/nebula-do.ts)), in `requirePermission` ([dag-tree.ts](../apps/nebula/src/dag-tree.ts)), and in both subscribe-time writers ([subscriptions.ts](../apps/nebula/src/subscriptions.ts), [query-subscriptions.ts](../apps/nebula/src/query-subscriptions.ts)) — so the bare `admin` bit is never authority by itself and an admin minted at any tier reaches nothing above its own scope (ADR-015). What is minted is therefore exactly what is reached:

| Invited at | Minted pattern | Reaches |
|---|---|---|
| `{u}.{g}.{s}` (star) | `{u}.{g}.{s}` (exact) | that Star only |
| `{u}.{g}` (galaxy) | `{u}.{g}.*` | the Galaxy + every Star beneath |
| `{u}` (universe) | `{u}.*` | everything in the Universe |
| `nebula-platform` | `'*'` | everything — a **super-admin invites a super-admin**, and only a super-admin can, since `matchAccess(pattern, 'nebula-platform')` is true only for `'*'` |

**Nobody authenticates *at* a Galaxy, and nothing needs to.** No `Identities` row can exist at a 2-segment scope (`create-galaxy` mints no founder, and there is no `claim-galaxy`), so no refresh cookie can be set at `/auth/{u}.{g}/`. Callers authenticate at the universe and name the Galaxy in `activeScope` — the shape prod uses.

**Making super-admin invitable is deliberate:** adding a coach today needs an env-var change + redeploy (`NEBULA_AUTH_BOOTSTRAP_EMAIL`), and the coach loop is the conversion layer — it must not require ops. ⚠️ Note this is *not* an audit-trail improvement: nothing persists **who** minted an admin (the `Identities` INSERT has no actor column, `InviteTokens` records only `(tokenHash, email, universeGalaxyStarId, expiresAt)`, and the sole record is a DEBUG-gated mint log), whereas the env-var path leaves a git commit *and* a deploy record. A real audit trail is out of scope here. Stranger-self-join stays closed — the bootstrap gate in `requestMagicLink` is untouched.

⚠️ **The honest accepted cost** (the loud warning, not a footnote). An admin invited at `{u}.{g}` gets `{u}.{g}.*`: **read + write of end-user data in every current *and future* Star under that Galaxy** (including production/tenant Stars, which ADR-008's boundary explicitly disclaims); `create-star` and `delete-scope`; **inviting further admins**; and **no way to undo it short of DB surgery** (see the revocation Decisions row). The warning is aimed at whoever builds the inviting UI: per ADR-015 clause 1, restraint here is a UI warning carrying decision-grade information, never a refusal in the authorization layer — and there is no invite affordance in `apps/nebula-studio-ui/src` yet, so **the first one built owns that warning.**

**Defense-in-depth.** Dropping the hardcoded `false` turns a member-minting RPC into an admin-minting one, so its safety must not rest on a single Worker line: pass `verifiedAccess` into `issueInvites` and **re-assert admin-over-scope in-method**, matching [`createGalaxy`](../packages/nebula-auth/src/nebula-auth-registry.ts) / [`createStar`](../packages/nebula-auth/src/nebula-auth-registry.ts), which both re-check `#hasAdminOver…` in-method; throw on violation (an invariant breach, not the expected client error the Worker gate routes throw-free per raw-comm.md).

## 3. One human = one profile (same email, any scope, once verified)
**The model, GitHub-style: `sub` is per-(human, scope) — the *membership* record. `profileId` is the *account*: global, singular, permanent.** Grants ride scopes + the orgTree DAG, never identity duplication.

The join happens **at verification, never at mint** — two single sites, each doing one thing:

1. **[`#mintIdentity`](../packages/nebula-auth/src/nebula-auth-registry.ts) always mints fresh.** Behaviour unchanged and uniform across all four callers — no conditional, nothing to branch on. The callers are [`claimUniverse`](../packages/nebula-auth/src/nebula-auth-registry.ts), [`claimStar`](../packages/nebula-auth/src/nebula-auth-registry.ts), the bootstrap platform-admin mint inside [`requestMagicLink`](../packages/nebula-auth/src/nebula-auth-registry.ts), and [`issueInvites`](../packages/nebula-auth/src/nebula-auth-registry.ts). **All four mint at `emailVerified=0`**, and two of them (`claimUniverse`, `claimStar`) are reachable by anyone who can pass a Turnstile challenge — so a row bearing a chosen email can exist before that person has done anything. Minting fresh is what keeps such a row inert.
2. **[`getAndVerifyIdentity`](../packages/nebula-auth/src/nebula-auth-registry.ts) does the join**, beside its `UPDATE Identities SET emailVerified = 1`:

   ```sql
   SELECT profileId FROM Identities WHERE email = ? AND emailVerified = 1 ORDER BY createdAt LIMIT 1
   ```

   Adopt it if found; otherwise keep the freshly-minted one (this row becomes canonical). One `UPDATE`, on first login only.

**Why this site:** it is the single chokepoint where a human has *proved control of the mailbox* — both consume paths funnel through it (`consumeMagicLink`'s and `consumeInvite`'s `const identity = this.getAndVerifyIdentity(…)`). Under the pinned one-email-per-human convention, proving control of the email **is** the proof of identity, so the join needs no prompt, no consent screen and **no second email round trip** — it rides the click the flow already requires. *(The **different**-email case genuinely cannot be settled this way — that is [on-hold/nebula-profile-link-breadcrumb.md](on-hold/nebula-profile-link-breadcrumb.md), and it stays there.)*

⚠️ **`AND emailVerified = 1` is load-bearing on the READ, not just the write timing.** Without it an attacker's *older* unverified row captures the canonical id: they POST `claim-star` with your email on day 1; you claim your own Universe on day 2; `ORDER BY createdAt LIMIT 1` hands you **their** placeholder — attacker-chosen, and shared with a scope you never joined, re-arming exactly what §5 exists to prevent. Oldest **verified** row wins; an unverified row is never adopted and never adoptable.

**Ordering is safe — nothing has stamped a `profileId` when the join runs.** `consumeAndLogin` → `getAndVerifyIdentity` → `mintAccessToken(…, profileId: record.profileId)`, so the join settles *before* the first JWT claim and before the refresh-KV copy: no ADR-013 staleness (the immutable stamp is taken downstream of the join) and **nothing re-keys** — resources key on `sub` only, so this is purely additive. Served by the existing `UNIQUE(email, scope)` leftmost-prefix, **no new index**. The discarded fresh id is overwritten in place and referenced nowhere (no JWT, no roster, no Profile DO — those are lazy and need a holder of the id), so it leaves no orphan.

This is the designed intent: `idx_Identities_profileId` is **non-unique**, commented "`profileId ← 1..N subs` (P2 unification substrate)". **ADR-012 requires it** — "global cross-scope profile visibility" is vacuous if every scope mints a new `profileId`.

## 4. What the writes are, and when
Mint time is uniform — **every new row gets a fresh `profileId`** — so the only per-invitee variation is the admin bit:

| | **A. New to Nebula** | **B. Already at THIS scope** | **C. Known, new to this scope** |
|---|---|---|---|
| `Identities` | **INSERT** — new `sub`, fresh `profileId`, `isAdmin`←flag (≈3 row-writes: row + `UNIQUE(email,scope)` + `idx_Identities_profileId`) | **NOTHING** — early-return; `sub`+`profileId` preserved, **`isAdmin` untouched** | **INSERT** — new `sub` (the per-scope *membership*), fresh `profileId`, `isAdmin`←flag |
| Promote (`setIdentityAdmin`) | not needed | **`UPDATE … SET isAdmin=1`** + **one KV `put` per live refresh token** (via `RefreshTokenIndex WHERE sub=?`, original expiry re-applied) | not needed |
| `InviteTokens` | **INSERT** | same | same |

Only **B** needs the promote step, and it is the only case that touches KV at issue time — at a cost that scales with the invitee's live sessions (3 devices = 3 puts).

**On accept, the join runs.** `consumeInvite` DELETEs the `InviteTokens` row (single-use), calls `getAndVerifyIdentity` — which flips `emailVerified` and, per §3, **adopts the canonical `profileId` if this human already has a verified row elsewhere** (one `UPDATE`; case **C** is where it fires) — then INSERTs `RefreshTokenIndex` and writes KV `refresh:{tokenHash}` = `{ sub, universeGalaxyStarId, isAdmin, profileId, expiresAt }` carrying the *joined* id.

## 5. Drop the Profile's scoped-admin branch — a profile is never an authz input
**The invariant: a `Profile` is purely display. It is never an input to admin or any other permission decision outside the Profile DO itself** (pinned with Larry 2026-07-26; now [ADR-012](../docs/adr/012-global-profile-visibility.md) as amended). `#requireOwnerOrAdmin` ([`#requireOwnerOrAdmin`](../packages/nebula-auth/src/profile.ts)) violates it — it passes when `scopes.some(s => matchAccess(pattern, s))` over `getScopesForProfile(profileId)`, so *being an admin of some scope this profile touches* confers authority over the profile. Scope-local authority over a global object; wrong even without §3.

**§3 makes it consequential.** Before, a profile spanned one scope and the branch was near-vacuous. After, it spans every scope the human has verified into, and every admin of each of those scopes can read `privateNotes` and rewrite the person's global name and picture. **Blast radius is bounded to the Profile DO** — display fields and notes, never Universe/Galaxy/Star contents — which is why this is a correctness fix, not an emergency.

**Fix — same phase as §3: owner + super-admin only.**
- The branch contradicts the invariant above; that alone settles it.
- §3's verified join closes the *pre-acceptance* vector at its source (an unverified row never joins a profile), but it cannot close this one: a **legitimately-joined** co-scope admin would still rewrite the victim's global identity. Two independent reasons, one fix.
- Super-admin (`pattern === '*'`) short-circuits (`if (claims.access.authScopePattern === '*') return;`) **before** any read → platform moderation unaffected. ADR-012's boundary holds: `privateNotes` stays behind `requireOwnerOrAdmin`; we narrow *who qualifies*, not the gate. **No scope admin is in the loop** for a profile write.
- **Two bonuses:** it deletes the file's self-described "**ONE registry read**" (and its fail-closed complexity), and it leaves `getScopesForProfile` unused for authz — **collapsing the cross-scope membership oracle**.
- **Accepted cost:** a Galaxy admin can no longer fix a member's bad display name; moderation escalates to super-admin.
- ⚠️ **Modifies shipped code + deletes shipped tests** ([archive/nebula-profile-store.md](archive/nebula-profile-store.md) Phases 1–3, built 2026-07-14): delete the "scoped-admin exactly one read" + fail-closed-seam tests and the `lookupProfileScopes` override — remove the functionality *and* its tests, never ossify (testing.md).

## Phases

1. **Per-invitee admin mint (auth).** Reshape the body to `invitees` (§1) and thread each entry's normalized `isAdmin` through `handleInvite` → `issueInvites(instanceName, invitees, origin, verifiedAccess)` (which re-asserts admin-over-scope in-method — §2); its existing per-email loop reads `invitee.email` + `invitee.isAdmin`. **A/C** → drop the hardcoded `/* isAdmin */ false` in that loop; **B** → `setIdentityAdmin(sub, true)`. **Promote-only.**
   - **Call sites:** replace every site matching `grep -rn "emails" --include="*.ts" packages/nebula-auth apps/nebula | grep -v node_modules` (~15 at time of writing), **plus** `packages/nebula-auth/README.md` (which diagrams the body shape) and `apps/nebula/test/test-helpers.ts` (`createSubject`, imported by ~17 baseline files — wire its currently-dead `isAdmin?` option through here; Phase 3 and the collapse task's collaborator test both need it). `bootstrapUniverseAdmin` in `apps/nebula/test/browser/auth-bootstrap.ts` authenticates at the universe and names the Galaxy in `activeScope` — that is the correct shape (§2) and it **stays** unchanged. ⚠️ **Do NOT touch `@lumenize/auth`** — the MIT package has its own `#handleInvite` / `body.emails` ([`#handleInvite`](../packages/auth/src/lumenize-auth.ts)) and its own consumers.
   - **Success — assert the PERSISTED bit, never the `/invite` 200** (identical for `true`/`false`): (i) net-new `isAdmin:true` → `getIdentityScope(sub).isAdmin === true`, or stronger (ADR-009) drive accept→refresh and assert `access.admin` in the JWT; (ii) **re-invite an existing `isAdmin=0` member with `isAdmin:true` → the accepted JWT now carries `access.admin`** (reds against the early-return); (iii) omitted flag — *and* explicit `isAdmin:false`, *and* wrong-typed `isAdmin:"false"` — still leave `isAdmin=0`.
   - **Success — mixed batch:** one call with `[{a, isAdmin:true}, {b}]` mints **`a` admin, `b` not**. Reds against a batch-level flag.
   - **Success — tier coverage:** a star-tier, a universe-tier, and a platform-tier mint each land with the pattern §2's table predicts.
   - **Success — negatives, SPLIT so each is independently mutation-capable** (two disjoint gates, both 403 — assert the *body*): **(a)** non-admin, **same-scope** → refused by `handleInvite`'s `verifiedAccess.admin` gate, body `forbidden` (delete that line → reds); **(b)** admin whose pattern does **not** cover the target — a *sibling* galaxy under a galaxy-scoped admin, **not** a Universe `{u}.*` admin → refused by the router's `matchAccess` scope-check, body `insufficient_scope` (relax it → reds).
2. **One human = one profile + close the Profile gate (auth).** Leave `#mintIdentity` minting fresh (all four callers, unchanged); add the **verified join** to `getAndVerifyIdentity` (§3) — the single site both consume paths reach — and **drop the scoped-admin branch** in `#requireOwnerOrAdmin` (§5), deleting its tests and the `lookupProfileScopes` seam. Re-point `getAndVerifyIdentity`'s JSDoc, which documents only the `emailVerified` flip.
   - **Success — one human, one profile:** the same email invited into **two scopes and accepted at both** yields **different `sub`s and the SAME `profileId`**, and a name set via one is visible from the other. **Cross-path:** a human invited into someone else's Galaxy who accepts, then **claims their own Universe and verifies**, gets a new `sub` and **the same `profileId`**. Negative: a **different** email gets a **different** `profileId`.
   - **Success — an unverified row is inert, and cannot capture.** Exercised **from the open endpoint, not from an invite**: an unauthenticated `claim-star` for a victim's email mints a row whose `profileId` is **not** the victim's; and with that attacker row created **first**, the victim's later verified claim keeps its **own** id. The attacker — admin of their own Star — then **cannot** write that victim's profile or read `privateNotes`. **Mutation:** drop `AND emailVerified = 1` from the lookup → the first-mover assertion reds.
   - **Success — the gate is closed:** an admin of scope S who invites a victim's email (creating the unaccepted `emailVerified=0` row) **cannot** write that victim's profile or read `privateNotes`; the **owner** still can; a **super-admin** still can, with **zero** registry reads.
3. **Enrollment (Nebula) — verification, co-lands with the collapse.** No new grant code: confirm the accepted collaborator's admin JWT enrolls through the `access.admin` bypass. Un-skips the collaborator `it.skip` in the collapse task's final verification.
   - **Success:** an invited→accepted collaborator **posts + triggers a Nebula reply** and **creates a test user** in the `.dev` Star; a **non-enrolled but AUTHENTICATED** identity (valid JWT, no admin/grant over `{u}.{g}`) is **denied by the permission/reach check, not a 401**. Regression: the invite stays **single-use**. *(Behavioral half rides the collapse task's `/live` drive: `wrangler dev` + Docker, not pool-workers.)*
4. **Clear this task's `it.skip` debt (LAST — after Phase 2, which is what unblocks it).** Larry, 2026-07-25: the suite should be as clean as possible before the collapse starts, and this file is the one that moves the needle on the `.dev`-login blocker.

   **Why these are blocked here:** the `ui-smoke` lane logs in *at* `test-u0.test-g0.dev`, and a `.dev` star is founderless by construction — `create-star` mints no founder and `claim-star` refuses the reserved slug, so no `Identities` row (and therefore no refresh cookie at `/auth/{u}.{g}.dev/`) can exist there. `issueInvites` is already generic on scope, so inviting an admin **into the `.dev` scope** mints exactly that row.

   **Inventory re-derived 2026-07-26 against current code — 14 skips, of which this file owns 3:**

   | Owner | Count | Where |
   |---|---|---|
   | **THIS FILE** — blocked *only* on a `.dev` identity | **3** | `ui-smoke/delete-scope.test.ts` (2), `ui-smoke/smoke.test.ts` (the real-email-login test) |
   | The Galaxy collapse | 10 | 5 browser benchmarks + `chromium/conflict-modal` (the unbuilt prod ontology pull); `ui-smoke/recover.test.ts`; `baseline/confine-dag-plane.test.ts` (needs a non-leaf DagTree host); **and 2 more `ui-smoke/smoke.test.ts` tests** that drive `/dev-container/*`, the `cf-container-target-port` header and `DevStudio.chat` — surfaces that task **deletes or rewrites** |
   | Independent — no owning task | 1 | `nebula-auth/identity-authority.test.ts`, the m6 `claimUniverse` single-flight → give it a [backlog.md](backlog.md) row so it has a home (`testing.md` § Deferring ≠ deleting) |

   ⚠️ **Do not green a test whose surface the next task deletes.** The two smoke tests handed to the collapse are login-blocked *and* apparatus-blocked; un-skipping them here buys green that gets unlearned next week (`workflow.md` § unlearning tax). They also depend on the login test's session, so they cannot run before it regardless.

   - **Success:** delete `delete-scope.test.ts`'s `LANE_BLOCKED_ON_DEV_SCOPE_LOGIN` flag and its early-return in `beforeAll`; the login test and both `delete-scope` tests **run** — record real `npx vitest run --project ui-smoke` output showing them passing, not `↓ skipped`.
   - ⚠️ **`delete-scope.test.ts`'s second skip is an EMPTY STUB** — a comment describing three assertions and no body. This phase **writes** it (see Relationships § un-skip obligation), it does not merely un-skip it.
   - **Success — the surviving 11 each have a named owner** (collapse or backlog) with its blocker **re-derived against current code, not re-read.** Several comments here were accurate when written and wrong later — the `ui-smoke` lane's said `claim-star` would unblock it, but `claim-star` refuses the reserved `.dev` slug.
   - Inventory structurally, per `tasks/README.md` § Inventories: `grep -rnE '^\s*(it|test|describe)\.skip\('`. A plain `grep 'it.skip'` over-reports (comments containing the words).

## Relationships
- **Gate released 2026-07-21** by [nebula-confine-admin-bypass.md](archive/nebula-confine-admin-bypass.md) Phase 1 — that file's Relationships holds the reasoning, including why a star-tier admin's reach was ever in question (§2 is now unconditional).
- 🔓 **UN-SKIP OBLIGATION — this task owns a deferred test in another lane.** [nebula-star-founder-provisioning.md](archive/nebula-star-founder-provisioning.md) Phase 1 (deletion warn-don't-block) left `it.skip('deletes a scope WITH another user attached, showing the bounded warning')` in `apps/nebula/test/ui-smoke/delete-scope.test.ts` as an **empty stub** — deliberately not faked with an out-of-band registry seed (`workflow.md`: prefer `it.skip` over an ossifying stand-in), because no invite affordance existed to attach a second identity. **Acceptance criterion (Phase 4):** write the body — invite a second user into the target, then assert the confirm screen renders *"Warning — 1 other user will lose access: …"*, the **Delete button stays ENABLED**, and the delete completes. (Registry-level behavior is already covered in `nebula-auth-registry.test.ts` + `identity-authority.test.ts`; what lands here is the **UI rendering** of the bounded warning.)
- ⚠️ **§5 invalidates a "do not re-derive" premise in the collapse task.** [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) § *Preserved — Nebula gets its own `Profile`* argues that write-authz needs no special-casing because "*everyone else is cleanly denied (the scoped-admin branch's Registry miss **fails closed** to `Forbidden`, not a 500)*" — the exact mechanism §5 deletes. **The conclusion survives a fortiori** (denied because no branch remains), but the stated mechanism does not; update that bullet when Phase 2 lands.
- **Depends on** the collapse task's collapsed **Galaxy chat session** (`SESSION_NODE_ID` exists) — only **Phase 3** co-lands with it; **Phases 1–2 are auth-side and land anytime**, and **Phase 4 needs only Phase 2**.
- **Out of scope, parked:** different-email profile linking → [on-hold/nebula-profile-link-breadcrumb.md](on-hold/nebula-profile-link-breadcrumb.md). *(That file and this one are the live homes for the former `icebox/nebula-profile-p2-global-person.md` design; the frozen [profile-store archive](archive/nebula-profile-store.md) still points at the dead icebox path, and archived files are never edited.)*
- **Deferred:** varied per-collaborator tiers → [on-hold/nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md). Self-signup is that carrier's consumer #2.
- **Modifies shipped code** — §5 touches [archive/nebula-profile-store.md](archive/nebula-profile-store.md) Phases 1–3 and deletes some of its tests.
- **Also here:** Profile-DO teardown on scope deletion (tracked in [backlog.md](backlog.md) § Profile store follow-ons) — under unification the rule becomes *delete the Profile DO when `Identities WHERE profileId` is empty*, folded into the scope-deletion cascade.
- **F&F invites** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § Invite-gated) ride the **same `/invite`** as non-admin invites (flag defaulted `false`).
