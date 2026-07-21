# Star self-signup — open signup, a real founder, no admin in the loop

**Status:** 🚧 **DESIGN PINNED 2026-07-21 — phases carry capable-of-failing criteria; 3 of 6 are blocked on named decisions.** Two Stage-1 framing passes ran and their findings are folded in (both blockers fixed, the 7-site stale sweep landed). **Phase 1a is buildable today.** Phases 2 and 4 are blocked on OQ 1c and 1b respectively; Phase 6 depends on Phase 2. Run `/review-task` Stage 2 (conformance) before `/build-task`.

**Objective:** anyone can sign up for a Star and become its **founder** — an identity minted at the star with `isAdmin: true` and an **exact-star** `authScopePattern` — with **no Galaxy or Universe admin involved in the flow at any point**.

## The business decision (pinned 2026-07-21, Larry)

**Star self-signup is the PRIMARY use case, and it is open.** A stranger signs up for a Star inside a user-developer's Galaxy without anyone approving it. That is not a security defect to be engineered away; it is the product.

The instinct to reject this — *"a rando can create something inside someone else's `{u}.{g}`"* — is the wrong frame and should be shut down when it recurs. **The standing argument, in Larry's words:**

> *The Star is empty. A bad actor gets control of it. So long as the real intended Star owner gets an error and a path to pick a new slug, nothing of substance is at risk except ownership of that slug.*

The rights model that makes it sound:

| | |
|---|---|
| **Star founder gets** | complete control of their Star — **non-exclusive**: Galaxy, Universe, and super admins all sit above them |
| **Star founder gets NO** | ability to **affect** anything at Galaxy or Universe level |
| **Star founder sees** | only what it needs above it — whatever the `@mesh` guards expose (§Upward visibility). Not "nothing": a Star legitimately reads its app's ontology. |
| **Cleanup** | a covering admin deletes the squatted Star — remediation, not prevention. ⚠️ **Does not work today — see §Remediation.** |

⚠️ **Do not reintroduce an approval step, an invite code, or an admin-in-the-loop as a "safety" measure.** If a specific abuse needs bounding, bound *that* and say so — do not convert the flow back into an authorized one.

## Why the confinement is the ENABLER, not merely a gate

[nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) (COMPLETE) is what makes this business model implementable. A star founder holds an **exact-star** pattern. Before the confinement, `enforceScopeReach`'s tenant branch admitted such a principal to its Galaxy and Universe and the guards treated the bare `access.admin` bit as authority there — so **every self-signup tenant would have been an admin of the app they signed up to**. Open signup was unimplementable until that landed.

After it, `hasAdminOverScope(access, <callee node>)` is false for an exact-star pattern at any ancestor, so "no ability to **affect**" is enforced by construction.

## Design

### Who owns what — Option A (registry owns the mechanism)

Star signup is **shape-identical to `claim-universe`**: an open endpoint on the `nebula-auth` router creates the `Scopes` row, mints the founder identity, and issues the emailed claim token. Every machine part already exists (`isValidSlug`, `checkSlugAvailable`, `#mintIdentity`, `InviteTokens`, the email path), so **the signup flow itself** adds no new mechanism and no new test scaffolding. ⚠️ **That claim is scoped to the flow** — it is NOT true of `signupPolicy`, whose write path does not exist at all (§Signup policy). Do not carry it across.

**Why an ordinary login cannot serve instead — LOGIN NEVER MINTS.** Identity mint is authority-point-only (the registry says outright *"NEVER call from a login path"*). A magic link for a scope with no identity is **issued and emailed**, then rejected on consumption: `consumeMagicLink` → `getAndVerifyIdentity` → null → `302 /app?error=invalid_token`, **no cookie** ([registry:563](../packages/nebula-auth/src/nebula-auth-registry.ts) — *"Magic link for non-member"*). So a Star with a `Scopes` row and no founder is not "log in and it works" — it is a scope nobody can ever enter. `claim-universe` is the **only** open founder-minting entry today. This is what makes Phase 2 non-optional rather than a convenience. (Confirmed against a live local stack 2026-07-21; documented at [email-login.ts:252-267](../apps/nebula/test/lib/email-login.ts).)

**Copy `claimUniverse`'s ORDERING, not just its shape** — every rejection lands **before** any state change or email ([registry:305-333](../packages/nebula-auth/src/nebula-auth-registry.ts)): `isValidEmail` → `isValidSlug` → **reserved-slug** → `checkSlugAvailable` → INSERT `Scopes` → `#mintIdentity` → `#createMagicLinkAndSend`. ⇒ a would-be squatter of a taken slug gets a synchronous `RegistryError(409, 'slug_taken')` and **no email is sent to anyone**. That directly satisfies the pinned safety argument (*"the real intended Star owner gets an error and a path to pick a new slug"*) — so preserve the ordering; do not "simplify" it into a post-INSERT uniqueness catch.

⚠️ **claim-star INHERITS `claimUniverse`'s deferred double-submit gap — and is more exposed by it.** `claimUniverse`'s own header flags it: because the endpoint **mints the scope itself**, `UNIQUE(email, scope)` cannot backstop a double-submit, so idempotency was deferred for pre-alpha. Star signup is the **primary, higher-volume** use case on an open endpoint, so inheriting the gap silently is worse here than it is for Universes. Decide explicitly in review: accept-and-record, or close it (a client-supplied idempotency key is the ADR-010-shaped answer — the caller can mint one with no coordination). **Do not let it ride unnamed.**

⚠️ **The registry cannot reach platform DOs** — its own JSDoc says so ([nebula-auth-registry.ts:665-667](../packages/nebula-auth/src/nebula-auth-registry.ts)), and two prior files burned the idea ([archive/nebula-auth-surrogate-sub.md](archive/nebula-auth-surrogate-sub.md); [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) — *"a write with no reader"*). So the DAG grant is **not** the registry's job.

### The DAG root grant — lazy, on the founder's first authenticated touch

**This is a constant, not a choice.** At signup there is no authenticated principal: the founder exists as an `Identities` row but has never logged in. Any *eager* stamp therefore needs a mesh call with no `aud`, which means either minting a token to act as someone who hasn't authenticated, or exempting a Star method from `onBeforeCall` — both standing backdoors.

The founder's **first authenticated touch** has everything: `aud` = their star, exact-star pattern, `admin`. So `Star.onBeforeCall`'s existing seed stays — with a **founder preference added, and its current gate LEFT INTACT.**

🚨 **DO NOT narrow the seed to "exact-star pattern only."** An earlier revision of this file proposed exactly that. It is wrong and would have deleted shipped behavior for the **primary pre-alpha flow**:

- The seed today gates on `hasAdminOverScope(access, instanceName)` ([star.ts:135](../apps/nebula/src/star.ts)), which a `{u}.{g}.*` galaxy admin **satisfies**.
- `createStar` mints **no founder** — *"Scopes row only, NO founder + NO email"* ([registry:371](../packages/nebula-auth/src/nebula-auth-registry.ts)) — and `dev` is reserved, so an exact-star identity can never exist there.
- `nebula-client.ts:735` hardcodes `${galaxy}.dev`, and the collapse pins `{u}.{g}.{env}` Stars on the same path.

⇒ An exact-star-only predicate is a **strict subset** of the current check, so every admin-created Star — including every user-developer's `.dev` authoring workspace — would be left **permanently root-adminless**, destroying the climb-findable terminus [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) depends on and falsifying `resetDevData`'s "reseeds on the next admin call's first-touch."

⚠️ **The reasoning error is worth naming, because it is repeatable.** The rejected revision argued the narrowed seed "can never grant authority the actor did not already have" — true, and irrelevant. It proved the seed cannot **over**-grant while never asking **who qualifies when there is no founder**. A predicate needs checking in *both* directions: what it wrongly admits **and** what it wrongly excludes.

**The rule to build instead — founder preference, covering-admin fallback:**
1. If the caller is the Star's **founder**, seed them. (Self-signup tenants own their own Star's root, rather than whichever covering admin happened to touch first.)
2. Otherwise fall back to the **current** `hasAdminOverScope` gate, unchanged — so admin-created and `.dev` Stars keep seeding exactly as they do today.

**Pin the founder-marker mechanism in review.** The registry already knows who the founder is (it minted them); the cheap route is a marker on the `Identities` row carried into the access claim, which `access-claims.ts` already builds from that row. If that is rejected, choose explicitly between (a) fallback-only — i.e. accept that a covering admin may win the root grant on a self-signup Star, which is benign since they can re-grant it — and (b) a registry lookup from the Star.

⚠️ **State the rule host-generically, not Star-specifically.** The collapse lands the first DagTree on the non-Star host `{u}.{g}`, and the pending DataPlane lift moves this seed off Star entirely — so express it against `this.lmz.instanceName`, never a tier special-case. Same cost, no drift.

⇒ This **augments** rather than retires the first-touch latch, so it only *partially* supersedes [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1. Its `TODO(self-signup)` is answered (the founder is known at signup); the latch itself remains.

### Slug — caller-chosen, with a reserved-slug reject

The signer-upper picks the slug. The signup path **must reject reserved names**, mirroring `claimUniverse`'s `PLATFORM_INSTANCE_NAME` check ([registry:307-309](../packages/nebula-auth/src/nebula-auth-registry.ts)).

⚠️ **`dev` is reserved by structure and MUST be on that list.** [nebula-client.ts:735](../apps/nebula/src/nebula-client.ts) hardcodes `${galaxy}.dev` as the user-developer's authoring workspace; `star.ts:382` gates `resetDevData` on `s[2] === 'dev'`; `registry:763` flags `isDev` off it. Without the reject, a stranger founds **the user-developer's own Studio workspace** as `isAdmin: true`: their Studio then 409s `slug_taken` forever behind *"Could not start the development workspace"*, and the squatter's exact-star `isAdmin` clears `resetDevData`'s `requireAdmin` — i.e. they can **wipe it**. Seed the list with `dev` plus whatever env names [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) pins for its `{u}.{g}.{env}` cast. Collision on a non-reserved slug is an ordinary `checkSlugAvailable` → 409.

### Signup policy — data the registry owns

*"May anyone sign up for a Star in my app?"* is the **app developer's** policy, but it does not require app code. Put it as a field on the **Galaxy's `Scopes` row** (`signupPolicy`), read by the signup path. The registry reads its own data — **no dependency inversion** — and later shapes (invite-code-required, payment-first, custom fields) extend that field without moving the flow.

That is the seam: the 80% case is free and identical across every app; the 20% we cannot yet specify has somewhere to go.

🚨 **There is NO existing write path — an earlier revision claimed one, and it does not exist.** Verified: `Scopes` has exactly two columns (`universeGalaxyStarId`, `improveProductConsent` — [schemas.ts:28-31](../packages/nebula-auth/src/schemas.ts)), there is **zero** `UPDATE Scopes` anywhere in the package (rows are INSERT-only, DELETE at `:690`), and the registry's endpoint surface is the seven at `router.ts:40-43`. So a writer needs: an append-only `REGISTRY_MIGRATIONS` entry, a new admin-gated endpoint, a registry method, a client method, and tests.

⇒ **Two consequences.** (1) The **read** (this task) and the **write** (admin UI to toggle it) are separate phases — do not smuggle a schema migration + endpoint + client + UI into the read. (2) This punctures the *"no new mechanism and no new test scaffolding"* claim made for Option A: that claim is true of the **signup flow itself**, which genuinely reuses `claim-universe`'s machinery — it is **not** true of `signupPolicy`. Keep the two claims separate.

🚨 **PIN the default-on-absent, and pin it CLOSED.** Every pre-existing Galaxy row predates the column, so it reads NULL. If NULL means *open*, **shipping this silently flips every existing Galaxy to accepting public signups** — a security change nobody opted into, delivered by a migration. The safe default is **closed on absent**, with opening it an explicit act by the Galaxy admin. ⚠️ That trades against the pinned business decision (signup is the product and should be on by default), so it is a genuine decision, not a formality: *default-closed for pre-existing Galaxies, default-open for newly created ones* is a defensible split — but it must be **written down**, not left to the implementer's reading of NULL.

## ⚠️ Remediation — a PREREQUISITE, not a follow-up

The business decision rests on *"a covering admin deletes the squatted Star."* **That does not work today**, and open signup without it is the one combination that does not hold together.

`#computeDeletionPlan` computes `blockedBy = #otherUsers(down, callerEmailLc)` where `down` **includes the target itself** ([registry:734](../packages/nebula-auth/src/nebula-auth-registry.ts)), and `#otherUsers` ([:767](../packages/nebula-auth/src/nebula-auth-registry.ts)) returns every Identity in those scopes whose email differs from the caller's. So a Galaxy admin deleting a squatted Star gets `blockedBy = [the squatter]` → **403 at [:673](../packages/nebula-auth/src/nebula-auth-registry.ts)**. The block fires on the **Star**, so an automated sweep hits it exactly as a support ticket would. (Galaxies are not the target — but ⚠️ they *become* reachable if the early return at `:735-737` is removed as "a gate that no longer gates anything". See Phase 1a: that removal would let a squatted-Star delete cascade into the Galaxy and Universe. This parenthetical is true today and false the moment `blockedBy` stops throwing, so do not read it as standing reassurance.)

### The fix is the principle, not a carve-out

**Authority trickles DOWN. A covering admin may delete any descendant scope — shared or not, risky or not — and the only restraint is a UI warning.** (Pinned with Larry 2026-07-21.) That is a design principle of the whole tier model, not a concession to self-signup: a Galaxy admin already holds full authority over every Star beneath them, so a Star's own members cannot be allowed to *veto* that authority.

⇒ **`blockedBy` stops blocking.** `#computeDeletionPlan` keeps computing the attached-user list — it is genuinely useful — but `executeScopeDeletion` no longer throws on it ([registry:673-676](../packages/nebula-auth/src/nebula-auth-registry.ts)). The list becomes **warning data on the confirm screen the plan endpoint already feeds**, so the admin makes an informed decision rather than hitting a wall. Rename it to say what it now means (it is not a blocker), and enrich it with what an admin needs to decide — per Larry: **last login, user count**, and similar.

⚠️ **Scoped to the deletion TARGET.** Leave the `#otherUsers` check in the **prune-up** at [:751](../packages/nebula-auth/src/nebula-auth-registry.ts) intact: that one decides whether the cascade silently climbs into an *ancestor* the admin did not name. Preventing a surprise ancestor wipe is a different concern from letting an admin delete what they explicitly chose.

⚠️ **`#emailForSub`'s fail-closed (M2) must STAY — an earlier claim here that it "degrades a warning, not an authorization" was wrong.** Two reasons. (1) A `null` email binds NULL, and `email != NULL` matches **zero** rows in SQL — so the failure yields a confidently **EMPTY** attached-user list, not an over-full one. Post-Phase-1a that list is the only restraint, so the screen would render "no other users attached" for a Star full of real tenants and the admin would confirm a wipe on a false premise. (2) The same helper backs the **prune-up ancestor stop** at [:751](../packages/nebula-auth/src/nebula-auth-registry.ts), which this file preserves as a genuine restraint — so it is still authorization-bearing there regardless. ⇒ Keep the fail-closed, and make **empty-vs-unknown** explicit in the plan payload so the confirm screen can say "could not determine attached users" rather than "none" (Phase 1b).

## Upward visibility — audit the allocation, don't add a mechanism

The requirement is *not* "a Star sees nothing above it" — that would break the ontology path a Star depends on. It is: **a Star sees only what it needs, and that surface is controlled by the `@mesh` guards on the Galaxy/Universe methods.** `@mesh()` vs `@mesh(requireAdmin)` **is** the control, per method. No new gating mechanism.

A star-scoped caller is admitted to its ancestors by `enforceScopeReach`'s tenant branch and may call every non-admin `@mesh()` method there. Verified 2026-07-21:

| Node | Method | Assessment |
|---|---|---|
| Galaxy | `getLatestOntologyVersion` / `getOntologyVersion` / `listOntologyVersions` | ✅ **Not a risk.** The app's source/ontology is what every tenant gets by signing up and logging in anyway — reading it is inherent to using the app. |
| Galaxy | `getGalaxyConfig` | **Audit the contents** (Larry's lean: probably fine) |
| Universe | `getUniverseConfig` | **Audit the contents** (Larry's lean: probably fine) |

⚠️ **The work is a CONTENT audit of the two config blobs**, not an architecture change — confirm nothing sensitive to the app developer or universe owner lives there, and that nothing is *expected* to later. If something is, move that field or split the method; do **not** narrow the tenant branch. This matters slightly more under open signup because a squatter gets these reads too.

⚠️ **The current allocation is incidental, not deliberate** — those methods were marked `@mesh()` when "non-admin" meant *another member of the same org*, not *an untrusted stranger who signed up five minutes ago*. Re-confirm each against the new meaning and **write the reason down**.

## Why there is no `claimStar`-shaped hole

The registry's deferral note ([:336-341](../packages/nebula-auth/src/nebula-auth-registry.ts)) rejects an open star claim as *"a stranger-claims-a-child escalation."* **Correct then, obsolete now** — that escalation is exactly what the confinement removed. What made it an escalation was never "a stranger created a row"; it was that the founder became an admin of the *parent*. Update or delete that note as part of this task; leaving it is an unlearning tax on every future reader.

## Decisions
| Decision | Rejected alternative — why |
|---|---|
| **Open self-signup, no admin in the loop** | An approval step / invite code — contradicts the business model. An approval gate is not a safer version of self-signup; it is a different product. |
| **Option A — the registry owns scope-row + founder-mint + claim-token**, shape-identical to `claim-universe` | A new `apps/nebula` signup endpoint — builds a **second** signup mechanism for what is conceptually one operation, duplicating machinery that already exists, and makes signup an app-layer concern rather than a platform primitive the developer inherits. Also worse under the ossification lens: a second shape every future test anchors to. |
| The founder's pattern is the **exact star id** | A `{u}.*` pattern — a universe admin wearing a star's name, and exactly what the gating task exists to prevent. It is also what makes open signup safe. |
| The founder is the **signing-up user** | The Galaxy admin as founder — then it is not self-signup, and the tenant cannot administer their own Star. |
| **DAG grant is lazy, on first authenticated touch**, via a narrowed seed | An eager stamp at signup — there is no authenticated principal yet, so it needs a token minted for someone who has not authenticated, or an `onBeforeCall` exemption. Both are standing backdoors. |
| **No "partially-stamped Star" phase** | Creating the Star in a pending state that only the founder can finish, protected by the slug — redundant *and* weaker. The founder's post-login JWT already carries an unguessable exact-star admin pattern, so the narrowed seed **is** "only the real founder can finish it"; a slug is guessable. Slug reservation is likewise already handled by the `Scopes` row + `checkSlugAvailable`. |
| Caller-chosen slug + **reserved-slug reject** | A server-minted opaque slug — kills squatting and the enumeration surface, but star ids stop being human-friendly and vanity slugs become their own feature later. |
| Signup policy as **registry data** on the Galaxy's `Scopes` row | A policy hook calling into `apps/nebula` — forbidden direction. App code owning the flow — see Option A above. |
| **Authority trickles DOWN: a covering admin may delete any descendant; warn, never block** | (a) The status quo, where a Star's members *veto* an admin above them — inverts the tier model. (b) A narrow "only if the Star has a single founder" carve-out — treats the symptom; the block is wrong for every descendant, not just that case. Restraint belongs in the UI warning, not the authorization. |
| **Unblocking deletion is a PREREQUISITE** | Treating it as a follow-up — the business decision's own backstop depends on it. |
| **One file, full product** — not a pre-alpha slice | Splitting pre-alpha (founder mint only) from alpha (the signup product). Rejected 2026-07-21: *"We have over-applied YAGNI. It's led us to build interims that are harder to overcome than if we had built it the way we think it will work best. Favor the goal, not the milestone."* ⚠️ **Tests are a consumer, and an interim built to make tests runnable ossifies nearly as hard as production code** — every test written against it must be unlearned too. Building the real flow means the tests drive the real flow. |

## Phases

Each phase carries a **Goal** and **capable-of-failing success criteria** — `/build-task` feeds these to its verifier panel, so a phase without them gets rubber-stamped. Where a criterion cannot be written yet, the phase names the **specific decision** it is blocked on rather than being left thin (thin-because-unpinned and thin-because-under-thought are indistinguishable to a reader — `tasks/README.md`).

### Phase 1a — deletion stops blocking (PREREQUISITE, authorization only)
**Goal:** a covering admin can delete any descendant scope, through the UI, regardless of who else is attached (ADR-015). Authorization change only — no schema, no new data.

**Scope — all four sites, or the prerequisite lands "done" with the backstop still broken:**
- `executeScopeDeletion` ([registry:673-676](../packages/nebula-auth/src/nebula-auth-registry.ts)) — stop throwing on `blockedBy`.
- 🚨 **`#computeDeletionPlan`'s early return at [:735-737](../packages/nebula-auth/src/nebula-auth-registry.ts) — PIN IT, DO NOT DELETE IT.** It looks like a gate that no longer gates anything, so an implementer will naturally remove it. **That would be catastrophic:** with it gone, deleting a squatted Star falls through to the prune-up — `wipe={star}`, the ancestor Galaxy is admin-covered, `childrenRemaining` is empty if it was the only child, and `#otherUsers([galaxy])` is empty *because `createGalaxy` mints no identities* → the **Galaxy is added to the wipe set**, and then the same logic climbs to the **Universe** (whose only identity row is the caller's own, which `#otherUsers` excludes). **A solo user-developer would lose their Galaxy and Universe by deleting one squatter's Star.** The early return must stay, or the prune-up gains its own equivalent guard — pin which.
- `App.vue:469` — early-returns on `plan.blockedBy.length > 0`, so the confirm handler no-ops.
- `App.vue:699` — drives `:disabled` from the same value, so the button is dead. (`:693-694` renders the "Blocked —" copy; that becomes the warning.)

⚠️ **`App.vue:48` hand-copies the `DeletionPlan` type** instead of importing the exported `ScopeDeletionPlan` (which `nebula-client.ts:17/:738` already imports) — and `scripts/type-check.sh` has `SKIP_PACKAGES=("nebula-studio-ui")` with no `vue-tsc`, so **renaming `blockedBy` produces zero errors in any gate** and surfaces only as a runtime `TypeError` on the confirm screen. Import the shared type as part of this phase.

**Success (capable-of-failing):**
- A covering admin deletes a Star holding **another user's** identity and it **succeeds** — reds against today's 403.
- 🔒 **The cascade still refuses to climb:** delete a squatted Star that is its Galaxy's **only** child; assert `affected` contains the **Star and NOT the Galaxy or Universe**. This is the criterion that catches the catastrophic regression above; it must exist before the phase is considered done.
- **End-to-end through the UI**, not a registry unit test — an admin clicks delete on a Star with another user attached and it completes. A registry-only test passes while the button is still dead.
- The prune-up's own `#otherUsers` stop ([:751](../packages/nebula-auth/src/nebula-auth-registry.ts)) still refuses to climb into an ancestor holding other users.

### Phase 1b — warning enrichment (schema; separable from 1a)
**Goal:** the confirm screen carries enough for an informed decision — who is attached, and how recently active.

⚠️ **This is where the migration lives — do not let it hide inside 1a.** `Identities` ([schemas.ts:41-50](../packages/nebula-auth/src/schemas.ts)) has **no `lastLogin` column**, and neither does anything else in `nebula-auth`. "User count" needs nothing new (it is `blockedBy.length`).

**Pin the mechanism — two options, both zero-cost, both ISO-8601 per ADR-011:**
1. Piggyback the `UPDATE` that `getAndVerifyIdentity` ([registry:169](../packages/nebula-auth/src/nebula-auth-registry.ts)) already performs on every login — the column is then nearly free.
2. Derive with **no new column** from `MAX(RefreshTokenIndex.expiresAt) − REFRESH_TOKEN_TTL` (fixed 30d, written only at login; stale index rows are never swept, so it survives expiry).

🚫 **Do NOT copy `packages/auth`'s `lastLoginAt INTEGER` epoch column** — that is an **ADR-011 violation** (persisted timestamps are ISO-8601 UTC strings). 🚫 And do not introduce a new hot write on the singleton registry.

**Success:** the plan payload distinguishes **"no attached users"** from **"could not determine"** (see the `#emailForSub` note in §Remediation), and the confirm screen renders them differently. Last-login is present without a new write path on the login hot path.
### Phase 2 — open signup endpoint on the registry router
**Goal:** a stranger POSTs a slug + email and becomes the founder of that Star, with no admin involved.

**Scope:** `Scopes` row + `#mintIdentity(email, starId, isAdmin: true)` + `InviteTokens` claim link; reserved-slug reject; `signupPolicy` **read only** (column + default-on-absent — the write path is Phase 6).

⛔ **BLOCKED ON:** the `signupPolicy` default-on-absent decision (OQ 1c). Every pre-existing Galaxy row reads NULL, so the wrong default silently changes the security posture of every existing Galaxy via a migration. Do not start this phase until that is pinned.

**Success (capable-of-failing):**
- A stranger signs up for a fresh slug and, after the claim link, holds `admin` with an **exact-star** `authScopePattern` — assert the pattern, not just that login worked. Reds if the mint ever widens to `{u}.*`.
- 🔒 `{galaxy}.dev` is **rejected** — the security-critical case (a squatter would 409 the user-developer's Studio forever *and* clear `resetDevData`'s `requireAdmin`). Extend to whatever env names the collapse pins.
- A second signup for a taken slug gets `RegistryError(409, 'slug_taken')` **and no email is sent** — assert both. Taken-slug rejection that still emails is the failure mode that breaks the pinned safety argument; a test asserting only the status code would pass through it.
- ✅ **`provisionAndLogin` collapses.** [email-login.ts:272](../apps/nebula/test/lib/email-login.ts) currently reaches a star founder by claiming the **universe** and creating the galaxy/star beneath it — a detour that exists *only* because `createStar` mints no founder, and whose ⚠️ names this task file as the fix. Rewriting it to a direct claim-star, with its call sites unchanged, is **part of Phase 2's DONE definition**, not a follow-up. ⚠️ Its universe-claiming path must **survive** for callers genuinely provisioning a universe — collapse the star case, don't delete the function.
- ⚠️ **Un-skip `nebula-auth-routes.test.ts` `claim-star: open self-signup mints an exact-star founder and rejects reserved slugs`** — it already carries these as skipped assertions and shows as `↓ skipped` until then. Extend with response shape + claim-token details once pinned; they are deliberately unasserted so it stays a contract, not a scaffold.

### Phase 3 — re-ground the ~30 baseline fixtures onto real star founders
**Goal:** retire the interim where a fixture asking for "an admin at this star" receives a universe admin.

⚠️ **Before Phase 4, not after** — changing the seed first reds the baseline lane for a reason unrelated to the change under test. In this order there is no such gap.

**Success (capable-of-failing):**
- **Only the `adminClientAt` body changes**; no `adminClientAt` call site is edited. That is the entire payoff of the intent-split ([test-helpers.ts](../apps/nebula/test/test-helpers.ts), landed 2026-07-21), and its JSDoc already asserts it.
- **No `universeAdminClient` call site is touched** — those 13 depend on the wildcard and must keep the universe admin.
- The baseline lane is green, and a fixture asserting an exact-star pattern now passes where it previously would have seen `{u}.*`.

### Phase 4 — founder preference in the seed
**Goal:** on a self-signup Star the **founder** gets the root DAG grant, not whichever covering admin touched first — while admin-created Stars keep seeding exactly as today.

⛔ **BLOCKED ON:** the founder-marker mechanism (OQ 1b) — claim field vs registry lookup vs fallback-only.

**Success (capable-of-failing):**
- A self-signup founder's first touch seeds **the founder**, even when a covering admin touched first — reds against today's first-caller-wins.
- 🔒 **An admin-created Star still seeds.** Create a Star via `createStar` (no founder minted) and confirm a covering admin's first touch still yields the root grant. **This is the criterion that catches the exact-star-only regression** described in §The DAG root grant — without it, `.dev` silently loses its root admin and nothing reds.
- Stated **host-generically** against `this.lmz.instanceName`, so the collapse's non-Star DagTree host and the pending DataPlane lift inherit it without a tier special-case.

### Phase 5 — audit §Upward visibility
**Goal:** every non-admin `@mesh()` on Galaxy/Universe is deliberately tenant-readable, with the reason written down.

**Success (capable-of-failing):** ⚠️ **Regenerate the inventory** (`grep -rn '@mesh()' apps/nebula/src/galaxy.ts apps/nebula/src/universe.ts`) rather than trusting §Upward visibility's table — the collapse changes what a tenant can reach. Then: a written justification line per method, and a check that neither config blob carries anything app-developer-private. A method with no written reason fails the phase.

### Phase 6 — `signupPolicy` write path
**Goal:** a Galaxy admin can turn signup on/off for their app.

**Scope:** append-only `REGISTRY_MIGRATIONS` entry + admin-gated endpoint + registry method + client method + UI toggle. **None of this exists** — see §Signup policy.

**Success:** a Galaxy admin toggles the policy and a subsequent signup to that Galaxy is accepted/rejected accordingly, end-to-end.

## Open questions for `/review-task`
1. What the renamed `blockedBy` should be called and carry (last login, user count, …), and whether `#emailForSub`'s fail-closed still earns its keep once the list is informational.
1b. The **founder-marker mechanism** (claim field vs registry lookup vs fallback-only) — see §The DAG root grant.
1c. **`signupPolicy` default-on-absent**, and whether pre-existing vs newly-created Galaxies get different defaults — see §Signup policy.
2. **Eager Star creation to pin placement** — *separable, and an opportunity rather than a cost.* [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1b is BLOCKED because in-Star code runs *after* placement is pinned; it says the decision must be made at **the first `getByName` that creates the Star**. A signup request is exactly that moment and is the one time we hold the **user's own** `request.cf`. Needs `getByName(name, { locationHint })` threading, which does not exist yet. Composes with either ownership choice.
3. `signupPolicy` field shape — enum now, or an object with room for invite-code/payment later?
4. Does a Universe admin need a **delete-any-Galaxy** feature (with warnings surfacing child-Star info — last login, user count — so the decision is informed)? Adjacent, probably its own task.

## Relationships
- ✅ **Gated by [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) — COMPLETE 2026-07-21.** Not merely sequencing: the confinement is what makes open self-signup safe.
- **Partially supersedes [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1** — answers its `TODO(self-signup)` (the founder is known at signup) but narrows rather than retires the latch. Part 2 (last-admin protection) unaffected; Part 1b (placement) is Open question 2.
- **Overlaps [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md)** — star-tier admins by *invite* rather than self-signup. Same principal shape, different provenance; neither blocks the other.
- **Retires the ~30-fixture interim** recorded in the gating task's Phase 0. Not on the pre-alpha critical path — [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) does not reference this file.
