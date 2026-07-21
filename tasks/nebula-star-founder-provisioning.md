# Star self-signup — open signup, a real founder, no admin in the loop

**Status:** 🚧 **DESIGN PINNED 2026-07-21 — Phase 2, the headline capability, is now UNBLOCKED.** Three Stage-1 framing passes have run; findings folded in (the citation blocker fixed, the missing Turnstile gate caught, the 7-site stale sweep landed). Larry pinned three scope calls 2026-07-21: **Phase 4 cut**, **`signupPolicy` moved wholly to Phase 6**, **a minimal signup UI added as Phase 4b, served from Galaxy**.

**Build order — derive it from the ⛔ markers, not from this summary:**
| | Phases |
|---|---|
| **Buildable today** | **1a** (deletion authorization) · **2** (the signup endpoint) · **5** (visibility audit) |
| **Blocked on a decision** | **1b** ⛔ OQ 1e (`lastLogin` mechanism) |
| **Blocked on a phase** | **3** and **6** ⛔ depend on Phase 2 · **4b** ⛔ depends on [collapse](nebula-galaxy-collapse-and-chat.md) Phase 3 |
| **Cut** | ~~4~~ — resolved by pinning; see §The DAG root grant |

⚠️ **Phase 3 is the big one** (78 call sites / 39 files) and is transitively blocked — nothing but Phase 2's `claim-star` mints a star founder. Schedule it the moment Phase 2 lands. Run `/review-task` Stage 2 (conformance) before `/build-task`.

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

**Why an ordinary login cannot serve instead — LOGIN NEVER MINTS.** Identity mint is authority-point-only (the registry says outright *"NEVER call from a login path"*). A magic link for a scope with no identity is **issued and emailed**, then rejected on consumption: `consumeMagicLink` → `getAndVerifyIdentity` → null → `302 /app?error=invalid_token`, **no cookie** (the `'Magic link for non-member'` warn in `login` — [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)). So a Star with a `Scopes` row and no founder is not "log in and it works" — it is a scope nobody can ever enter. `claim-universe` is the **only** open founder-minting entry today. This is what makes Phase 2 non-optional rather than a convenience. (Confirmed against a live local stack 2026-07-21; documented at [email-login.ts:252-267](../apps/nebula/test/lib/email-login.ts).)

**Copy `claimUniverse`'s ORDERING, not just its shape** — every rejection lands **before** any state change or email (`claimUniverse` in [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)): `isValidEmail` → `isValidSlug` → **reserved-slug** → `checkSlugAvailable` → INSERT `Scopes` → `#mintIdentity` → `#createMagicLinkAndSend`. ⇒ a would-be squatter of a taken slug gets a synchronous `RegistryError(409, 'slug_taken')` and **no email is sent to anyone**. That directly satisfies the pinned safety argument (*"the real intended Star owner gets an error and a path to pick a new slug"*) — so preserve the ordering; do not "simplify" it into a post-INSERT uniqueness catch.

⚠️ **claim-star INHERITS `claimUniverse`'s deferred double-submit gap — and is more exposed by it.** `claimUniverse`'s own header flags it: because the endpoint **mints the scope itself**, `UNIQUE(email, scope)` cannot backstop a double-submit, so idempotency was deferred for pre-alpha. Star signup is the **primary, higher-volume** use case on an open endpoint, so inheriting the gap silently is worse here than it is for Universes. Decide explicitly in review: accept-and-record, or close it (a client-supplied idempotency key is the ADR-010-shaped answer — the caller can mint one with no coordination). **Do not let it ride unnamed.**

⚠️ **The registry cannot reach platform DOs** — its own JSDoc says so — *"the registry can't reach platform DOs — dependency direction"*, above `executeScopeDeletion` ([nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)), and two prior files burned the idea ([archive/nebula-auth-surrogate-sub.md](archive/nebula-auth-surrogate-sub.md); [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) — *"a write with no reader"*). So the DAG grant is **not** the registry's job.

### The DAG root grant — lazy, on the founder's first authenticated touch

**This is a constant, not a choice.** At signup there is no authenticated principal: the founder exists as an `Identities` row but has never logged in. Any *eager* stamp therefore needs a mesh call with no `aud`, which means either minting a token to act as someone who hasn't authenticated, or exempting a Star method from `onBeforeCall` — both standing backdoors.

The founder's **first authenticated touch** has everything: `aud` = their star, exact-star pattern, `admin`. So `Star.onBeforeCall`'s existing seed stays — with a **founder preference added, and its current gate LEFT INTACT.**

🚨 **DO NOT narrow the seed to "exact-star pattern only."** An earlier revision of this file proposed exactly that. It is wrong and would have deleted shipped behavior for the **primary pre-alpha flow**:

- The seed today gates on `hasAdminOverScope(access, instanceName)` (the `hasAdminOverScope(claims?.access, this.lmz.instanceName)` gate in `Star.onBeforeCall` — [star.ts](../apps/nebula/src/star.ts)), which a `{u}.{g}.*` galaxy admin **satisfies**.
- `createStar` mints **no founder** — *"Scopes row only, NO founder + NO email"* (`createStar`'s JSDoc, [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)) — and `dev` is reserved, so an exact-star identity can never exist there.
- `nebula-client.ts` hardcodes `create-star` with `${galaxy}.dev`, and the collapse pins `{u}.{g}.{env}` Stars on the same path.

⇒ An exact-star-only predicate is a **strict subset** of the current check, so every admin-created Star — including every user-developer's `.dev` authoring workspace — would be left **permanently root-adminless**, destroying the climb-findable terminus [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) depends on and falsifying `resetDevData`'s "reseeds on the next admin call's first-touch."

⚠️ **The reasoning error is worth naming, because it is repeatable.** The rejected revision argued the narrowed seed "can never grant authority the actor did not already have" — true, and irrelevant. It proved the seed cannot **over**-grant while never asking **who qualifies when there is no founder**. A predicate needs checking in *both* directions: what it wrongly admits **and** what it wrongly excludes.

**The rule to build instead — founder preference, covering-admin fallback:**
1. If the caller is the Star's **founder**, seed them. (Self-signup tenants own their own Star's root, rather than whichever covering admin happened to touch first.)
2. Otherwise fall back to the **current** `hasAdminOverScope` gate, unchanged — so admin-created and `.dev` Stars keep seeding exactly as they do today.

✅ **PINNED 2026-07-21 (Larry): option (a), fallback-only — NO founder marker, and no Phase 4.** The seed gate is already sufficient: `hasAdminOverScope(claims?.access, this.lmz.instanceName)` is **TRUE for an exact-star founder on their own Star**, so post-Phase-2 the founder self-seeds on their first touch with **zero new code**. A marker would change the outcome in exactly one case — a covering Galaxy/Universe admin touches the Star *before* the founder ever logs in — and that case is benign **and doubly self-healing**: the admin can re-grant, and the founder's own exact-star `access.admin` clears `requirePermission` on their own Star, so they can grant themselves root unaided. Against that, a marker costs a column on `Identities` (a migration) threaded through `access-claims.ts` into the JWT. Not worth it. ⇒ **Rule: keep `Star.onBeforeCall`'s existing gate exactly as it is.** Reversible if the race ever proves non-benign.

⚠️ **State the rule host-generically, not Star-specifically.** The collapse lands the first DagTree on the non-Star host `{u}.{g}`, and the pending DataPlane lift moves this seed off Star entirely — so express it against `this.lmz.instanceName`, never a tier special-case. Same cost, no drift.

⇒ This **augments** rather than retires the first-touch latch, so it only *partially* supersedes [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1. Its `TODO(self-signup)` is answered (the founder is known at signup); the latch itself remains.

### Slug — caller-chosen, with a reserved-slug reject

The signer-upper picks the slug. The signup path **must reject reserved names**, mirroring `claimUniverse`'s `PLATFORM_INSTANCE_NAME` check (the `reserved_slug` throw, [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)).

⚠️ **`dev` is reserved by structure and MUST be on that list.** [nebula-client.ts](../apps/nebula/src/nebula-client.ts) hardcodes `create-star` with `${galaxy}.dev` as the user-developer's authoring workspace; `Star.resetDevData` gates on `s[2] === 'dev'` ([star.ts](../apps/nebula/src/star.ts)); `#parseScope`'s returned `isDev` flags the same thing ([nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)). Without the reject, a stranger founds **the user-developer's own Studio workspace** as `isAdmin: true`: their Studio then 409s `slug_taken` forever behind *"Could not start the development workspace"*, and the squatter's exact-star `isAdmin` clears `resetDevData`'s `requireAdmin` — i.e. they can **wipe it**. Seed the list with `dev` plus whatever env names [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) pins for its `{u}.{g}.{env}` cast. Collision on a non-reserved slug is an ordinary `checkSlugAvailable` → 409.

### Signup policy — data the registry owns

*"May anyone sign up for a Star in my app?"* is the **app developer's** policy, but it does not require app code. Put it as a field on the **Galaxy's `Scopes` row** (`signupPolicy`), read by the signup path. The registry reads its own data — **no dependency inversion** — and later shapes (invite-code-required, payment-first, custom fields) extend that field without moving the flow.

That is the seam: the 80% case is free and identical across every app; the 20% we cannot yet specify has somewhere to go.

🚨 **There is NO existing write path — an earlier revision claimed one, and it does not exist.** Verified: `Scopes` has exactly two columns (`universeGalaxyStarId`, `improveProductConsent` — [schemas.ts:28-31](../packages/nebula-auth/src/schemas.ts)), there is **zero** `UPDATE Scopes` anywhere in the package (rows are INSERT-only, DELETE at `:690`), and the registry's endpoint surface is the seven at `router.ts-43`. So a writer needs: an append-only `REGISTRY_MIGRATIONS` entry, a new admin-gated endpoint, a registry method, a client method, and tests.

⇒ **Two consequences.** (1) The **read** (this task) and the **write** (admin UI to toggle it) are separate phases — do not smuggle a schema migration + endpoint + client + UI into the read. (2) This punctures the *"no new mechanism and no new test scaffolding"* claim made for Option A: that claim is true of the **signup flow itself**, which genuinely reuses `claim-universe`'s machinery — it is **not** true of `signupPolicy`. Keep the two claims separate.

✅ **PINNED 2026-07-21 (Larry): `signupPolicy` is ENTIRELY Phase 6 — read and write together. It does not gate Phase 2.**

⚠️ **An earlier revision of this section argued the opposite, on a premise that was simply false.** It claimed shipping open *"silently flips every existing Galaxy to accepting public signups — a security change nobody opted into."* That describes retrofitting a policy onto an **already-open** flow. It is not this: `claim-star` **does not exist**, so **today zero Galaxies accept Star self-signup**. Landing the endpoint open is the feature arriving exactly as pinned — not a posture regression. Do not reintroduce the default-closed argument on that footing.

⇒ Two consequences. (1) **The field has no consumer of any kind** — `grep -rn signupPolicy packages/ apps/` returns **nothing**: no column, no test, no reader — so building the read first is a capability with no consumer, and per the YAGNI rule that is exactly the flag-worthy case. (2) A field defaulting **closed** with its write path in the **last** phase ships the primary product flow **dark, with no way to turn it on** — a Galaxy admin who must act before any stranger can sign up, which directly contradicts this file's own Objective (*"no Galaxy or Universe admin involved in the flow at any point"*) and weakens the get-paid path.

The seam argument above **stands and is worth keeping** — it is why the field belongs on the `Scopes` row rather than in app code. It is just not built until it has a consumer.

## ⚠️ Remediation — a PREREQUISITE, not a follow-up

The business decision rests on *"a covering admin deletes the squatted Star."* **That does not work today**, and open signup without it is the one combination that does not hold together.

`#computeDeletionPlan` computes `blockedBy = #otherUsers(down, callerEmailLc)` where `down` **includes the target itself**, and `#otherUsers` (defined just below `#computeDeletionPlan` in [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)) returns every Identity in those scopes whose email differs from the caller's. So a Galaxy admin deleting a squatted Star gets `blockedBy = [the squatter]` → **`RegistryError(409, 'scope_in_use')`** — thrown by `executeScopeDeletion`, in [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts). The block fires on the **Star**, so an automated sweep hits it exactly as a support ticket would. (Galaxies are not the target — but ⚠️ they *become* reachable if the `if (blockedBy.length > 0)` early return is removed as "a gate that no longer gates anything". See Phase 1a: that removal would let a squatted-Star delete cascade into the Galaxy and Universe. This parenthetical is true today and false the moment `blockedBy` stops throwing, so do not read it as standing reassurance.)

### The fix is the principle, not a carve-out

**Authority trickles DOWN. A covering admin may delete any descendant scope — shared or not, risky or not — and the only restraint is a UI warning.** (Pinned with Larry 2026-07-21.) That is a design principle of the whole tier model, not a concession to self-signup: a Galaxy admin already holds full authority over every Star beneath them, so a Star's own members cannot be allowed to *veto* that authority.

⇒ **`blockedBy` stops blocking.** `#computeDeletionPlan` keeps computing the attached-user list — it is genuinely useful — but `executeScopeDeletion` no longer throws on it (the `RegistryError(409, 'scope_in_use')` throw in [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)). The list becomes **warning data on the confirm screen the plan endpoint already feeds**, so the admin makes an informed decision rather than hitting a wall. Rename it to say what it now means (it is not a blocker), and enrich it with what an admin needs to decide — per Larry: **last login, user count**, and similar.

⚠️ **Scoped to the deletion TARGET.** Leave the `#otherUsers` check in the **prune-up** — the `if (this.#otherUsers([ancestor], callerEmailLc).length > 0) break;` inside the `while (ancestor)` loop of `#computeDeletionPlan` ([nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)) — intact: that one decides whether the cascade silently climbs into an *ancestor* the admin did not name. Preventing a surprise ancestor wipe is a different concern from letting an admin delete what they explicitly chose.

⚠️ **`#emailForSub`'s fail-closed (M2) must STAY — an earlier claim here that it "degrades a warning, not an authorization" was wrong.** Two reasons. (1) A `null` email binds NULL, and `email != NULL` matches **zero** rows in SQL — so the failure yields a confidently **EMPTY** attached-user list, not an over-full one. Post-Phase-1a that list is the only restraint, so the screen would render "no other users attached" for a Star full of real tenants and the admin would confirm a wipe on a false premise. (2) The same helper backs the **prune-up ancestor stop** (`#otherUsers([ancestor], …)` in the `while (ancestor)` loop of `#computeDeletionPlan`), which this file preserves as a genuine restraint — so it is still authorization-bearing there regardless. ⇒ Keep the fail-closed, and make **empty-vs-unknown** explicit in the plan payload so the confirm screen can say "could not determine attached users" rather than "none" (Phase 1b).

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

**Settled — no action.** The registry's old objection to an open star claim (*"a stranger-claims-a-child escalation"*) was retired in the 2026-07-21 stale sweep (`0c2989d`): the note above `createGalaxy` in [nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts) now reads *"not built, NOT must never exist"* and points here, and [router.ts](../packages/nebula-auth/src/router.ts) carries the matching comment. **That note is the single source** — it names itself as what the router comment and two tests echo. The reasoning, kept because it is why the flow is safe: the escalation was never *"a stranger created a row"*, it was the founder becoming an admin of the **parent**, which the confinement removed (ADR-015).

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
| **Founder marker: NOT built — the existing seed gate suffices** | A marker on `Identities` threaded into the JWT. Rejected 2026-07-21: an exact-star founder already satisfies `hasAdminOverScope` on their own Star, so the marker buys only the covering-admin-touches-first race — benign and doubly self-healing — at the cost of a migration and a JWT-payload change. |
| **`signupPolicy` is Phase 6 in full (read + write)** | Landing the read in Phase 2. Rejected 2026-07-21: the field has **zero** consumers today, and a closed default with the write path in the last phase ships the primary flow dark, contradicting the Objective. The premise that shipping open "flips existing Galaxies" was false — `claim-star` does not exist, so nothing is being flipped. |
| **Minimal signup UI, served from Galaxy, after the collapse's serving phase** | (a) Building it in `nebula-studio-ui` — that is the user-developer control plane; a stranger has no business there. (b) Deferring the UI entirely — *"not having Star self-signup before caused us to work around its absence"* (Larry). (c) Building it before the collapse — would require standing up a Galaxy serving surface for signup alone. |
| **Unblocking deletion is a PREREQUISITE** | Treating it as a follow-up — the business decision's own backstop depends on it. |
| **One file, full product** — not a pre-alpha slice | Splitting pre-alpha (founder mint only) from alpha (the signup product). Rejected 2026-07-21: *"We have over-applied YAGNI. It's led us to build interims that are harder to overcome than if we had built it the way we think it will work best. Favor the goal, not the milestone."* ⚠️ **Tests are a consumer, and an interim built to make tests runnable ossifies nearly as hard as production code** — every test written against it must be unlearned too. Building the real flow means the tests drive the real flow. |

## Phases

Each phase carries a **Goal** and **capable-of-failing success criteria** — `/build-task` feeds these to its verifier panel, so a phase without them gets rubber-stamped. Where a criterion cannot be written yet, the phase names the **specific decision** it is blocked on rather than being left thin (thin-because-unpinned and thin-because-under-thought are indistinguishable to a reader — `tasks/README.md`).

### Phase 1a — deletion stops blocking (PREREQUISITE, authorization only)
**Goal:** a covering admin can delete any descendant scope, through the UI, regardless of who else is attached (ADR-015). Authorization change only — no schema, no new data.

**Scope — all four sites, or the prerequisite lands "done" with the backstop still broken:**
- **`executeScopeDeletion`** — remove the `if (plan.blockedBy.length > 0) throw new RegistryError(409, 'scope_in_use', …)`. ⚠️ **It is a 409, not a 403.** Two *genuine* 403s live in the same function — `'Caller is not an admin of "…"'` (`#hasAdminOverScope`) and `'Caller identity not found'` (`#emailForSub` fail-closed) — and this file requires **both to stay**. An instruction to "stop the 403" would delete a control we are keeping. ([nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts))
- 🚨 **PIN the `if (blockedBy.length > 0)` early return in `#computeDeletionPlan` — DO NOT DELETE IT.** Identify it by its predicate, not a line number: it is the return **immediately after** `const blockedBy = this.#otherUsers(down, callerEmailLc);`, and it short-circuits **before** the prune-up `while (ancestor)` loop. ⚠️ **Do not confuse it with the `if (!down.includes(target)) return { affected: [], blockedBy: [] }` guard just above it** — that one is an unrelated target-not-registered check, and pinning it instead leaves the real one deletable. ([nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)) It looks like a gate that no longer gates anything, so an implementer will naturally remove it. **That would be catastrophic:** with it gone, deleting a squatted Star falls through to the prune-up — `wipe={star}`, the ancestor Galaxy is admin-covered, `childrenRemaining` is empty if it was the only child, and `#otherUsers([galaxy])` is empty *because `createGalaxy` mints no identities* → the **Galaxy is added to the wipe set**, and then the same logic climbs to the **Universe** (whose only identity row is the caller's own, which `#otherUsers` excludes). **A solo user-developer would lose their Galaxy and Universe by deleting one squatter's Star.** The early return must stay, or the prune-up gains its own equivalent guard — pin which.
- [`nebula-studio-ui/src/App.vue:469`](../apps/nebula-studio-ui/src/App.vue) — early-returns on `plan.blockedBy.length > 0`, so the confirm handler no-ops.
- [`nebula-studio-ui/src/App.vue:699`](../apps/nebula-studio-ui/src/App.vue) — drives `:disabled` from the same value, so the button is dead. (`:693-694` renders the "Blocked —" copy; that becomes the warning.)

⚠️ **[`nebula-studio-ui/src/App.vue:48`](../apps/nebula-studio-ui/src/App.vue) hand-copies the `DeletionPlan` type** instead of importing the exported `ScopeDeletionPlan` (which `nebula-client.ts:17/:738` already imports) — and `scripts/type-check.sh` has `SKIP_PACKAGES=("nebula-studio-ui")` with no `vue-tsc`, so **renaming `blockedBy` produces zero errors in any gate** and surfaces only as a runtime `TypeError` on the confirm screen. Import the shared type as part of this phase.

**Success (capable-of-failing):**
- A covering admin deletes a Star holding **another user's** identity and it **succeeds** — reds against today's **409 `scope_in_use`**.
- 🔒 **The cascade still refuses to climb:** delete a squatted Star that is its Galaxy's **only** child; assert `affected` contains the **Star and NOT the Galaxy or Universe**. This is the criterion that catches the catastrophic regression above; it must exist before the phase is considered done.
- **End-to-end through the UI**, not a registry unit test — an admin clicks delete on a Star with another user attached and it completes. A registry-only test passes while the button is still dead. ⚠️ **Name the lane:** `apps/nebula-studio-ui` has **zero test files, no test script, and is the sole `SKIP_PACKAGES` entry** in `scripts/type-check.sh` — the only lane that renders that SPA is the Playwright + `wrangler dev` + Docker harness at `apps/nebula/test/ui-smoke`. So this criterion means a new `ui-smoke` scenario, which makes the phase's "authorization change only" framing true of the *production* diff but not of the *work*.
- ⚠️ **Retitle + re-assert `nebula-auth-registry.test.ts`'s *"guard: another user on the target blocks the delete"*.** It asserts a populated `blockedBy` and stays **GREEN** after this phase while its name states the opposite of the new behavior — the "green test enshrining the old shape" false-confidence trap (`workflow.md`). Note nothing today asserts the `409 scope_in_use` throw at all, so removing that throw reds **nothing** on its own — this test is the only place the old semantics are written down.
- The prune-up's own `#otherUsers` stop (in the `while (ancestor)` loop) still refuses to climb into an ancestor holding other users.

### Phase 1b — warning enrichment (schema; separable from 1a)
**Goal:** the confirm screen carries enough for an informed decision — who is attached, and how recently active.

⚠️ **This is where the migration lives — do not let it hide inside 1a.** `Identities` ([schemas.ts:41-50](../packages/nebula-auth/src/schemas.ts)) has **no `lastLogin` column**, and neither does anything else in `nebula-auth`. "User count" needs nothing new (it is `blockedBy.length`).

**Pin the mechanism — two options, both zero-cost, both ISO-8601 per ADR-011:**
1. Piggyback the `UPDATE` that `getAndVerifyIdentity` ([nebula-auth-registry.ts](../packages/nebula-auth/src/nebula-auth-registry.ts)) already performs on every login — the column is then nearly free.
2. Derive with **no new column** from `MAX(RefreshTokenIndex.expiresAt) − REFRESH_TOKEN_TTL` (fixed 30d, written only at login; stale index rows are never swept, so it survives expiry).

🚫 **Do NOT copy `packages/auth`'s `lastLoginAt INTEGER` epoch column** — that is an **ADR-011 violation** (persisted timestamps are ISO-8601 UTC strings). 🚫 And do not introduce a new hot write on the singleton registry.

**Success:** the plan payload distinguishes **"no attached users"** from **"could not determine"** (see the `#emailForSub` note in §Remediation), and the confirm screen renders them differently. Last-login is present without a new write path on the login hot path.
### Phase 2 — open signup endpoint on the registry router
**Goal:** a stranger POSTs a slug + email and becomes the founder of that Star, with no admin involved.

**Scope:** `Scopes` row + `#mintIdentity(email, starId, isAdmin: true)` + `InviteTokens` claim link; reserved-slug reject; **Turnstile registration (below)**. ⛔ **NOT `signupPolicy`** — the whole field, read and write, is Phase 6 (§Signup policy). Phase 2 ships the flow **open**, which is the pinned business decision.

🔒 **`claim-star` must join TWO sets in [router.ts](../packages/nebula-auth/src/router.ts), and only one of them is needed for the route to work.** `REGISTRY_ENDPOINTS` routes it; **`TURNSTILE_ENDPOINTS`** gates it. They are separate `Set`s about ten lines apart, and today `TURNSTILE_ENDPOINTS = new Set(['email-magic-link', 'claim-universe', 'discover'])` — **no `claim-star`**. ⚠️ This is the one place "shape-identical to `claim-universe`" **actively misleads**: `claimUniverse`'s own JSDoc says *"(open, Turnstile-gated at the Worker)"*, but the gate is registered somewhere the copied code does not live. An implementer who copies the registry method faithfully ships an **ungated open mutation endpoint that mints identities and sends email**, and nothing reds. This is a bound on a specific abuse (scripted mass slug-squatting + mail-send amplification), **not** an approval step — the flow stays open to any human.

⚠️ **[`packages/nebula-auth/README.md`](../packages/nebula-auth/README.md) already documents `claim-star` as SHIPPED, with Turnstile** — `:35` lists it among "public mutation endpoints", `:71` maps the route, `:124` tabulates `/auth/claim-star | POST | Turnstile`. So the docs currently promise a control on an endpoint that does not exist. Sweep all three as part of this phase; until then the README is a false assurance, not just a stale line.

**Success (capable-of-failing):**
- 🔒 With `TURNSTILE_SECRET_KEY` configured, a `claim-star` POST carrying **no** `cf-turnstile-response` and no bypass header is **rejected at the gate — before any `Scopes` INSERT and before any email**. Reds if `claim-star` is added to `REGISTRY_ENDPOINTS` alone.
- A stranger signs up for a fresh slug and, after the claim link, holds `admin` with an **exact-star** `authScopePattern` — assert the pattern, not just that login worked. Reds if the mint ever widens to `{u}.*`.
- 🔒 `{galaxy}.dev` is **rejected** — the security-critical case (a squatter would 409 the user-developer's Studio forever *and* clear `resetDevData`'s `requireAdmin`). Extend to whatever env names the collapse pins.
- A second signup for a taken slug gets `RegistryError(409, 'slug_taken')` **and no email is sent** — assert both. Taken-slug rejection that still emails is the failure mode that breaks the pinned safety argument; a test asserting only the status code would pass through it.
- ✅ **`provisionAndLogin` collapses.** [email-login.ts:272](../apps/nebula/test/lib/email-login.ts) currently reaches a star founder by claiming the **universe** and creating the galaxy/star beneath it — a detour that exists *only* because `createStar` mints no founder, and whose ⚠️ names this task file as the fix. Rewriting it to a direct claim-star, with its call sites unchanged, is **part of Phase 2's DONE definition**, not a follow-up. ⚠️ Its universe-claiming path must **survive** for callers genuinely provisioning a universe — collapse the star case, don't delete the function.
- ⚠️ **Un-skip `nebula-auth-routes.test.ts` `claim-star: open self-signup mints an exact-star founder and rejects reserved slugs`** — it already carries these as skipped assertions and shows as `↓ skipped` until then. Extend with response shape + claim-token details once pinned; they are deliberately unasserted so it stays a contract, not a scaffold.

### Phase 3 — re-ground the baseline fixtures onto real star founders
**Goal:** retire the interim where a fixture asking for "an admin at this star" receives a universe admin.

⚠️ **Before Phase 4, not after** — changing the seed first reds the baseline lane for a reason unrelated to the change under test. In this order there is no such gap.

**Success (capable-of-failing):**
⚠️ **PRE-STEP — the intent-split is NOT finished, and the criterion below is false until it is.** Enumerate with `grep -rn 'adminClientAt(' apps/nebula/test | grep -v test-helpers.ts` (**78 sites across 39 files** at time of writing — not the "~30" this file used to claim, and the helper's own JSDoc says "~70"). Several of those pass a **non-star** scope and assert wildcard cross-tier reach — `scope-isolation.test.ts` *"a galaxy admin reaches a descendant Star"* / *"a universe admin reaches a descendant Galaxy and Star"*, and sites in `scope-binding.test.ts`. A body that mints an **exact-star founder cannot serve a galaxy or universe `scope` argument**, so those must MOVE to `universeAdminClient` first. That one `it()` in `scope-isolation.test.ts` already calls `universeAdminClient` for its positive control while its primary client is still `adminClientAt` is the tell that the sweep missed them. **Do not satisfy the criterion with a tier-branch inside the helper** — that is the tier special-case this file bans, hidden in a test helper.

- **After the pre-step, only the `adminClientAt` body changes**; no *remaining* `adminClientAt` call site is edited by the re-grounding itself. That is the payoff of the intent-split ([test-helpers.ts](../apps/nebula/test/test-helpers.ts), landed 2026-07-21).
- **No `universeAdminClient` call site is touched** — they depend on the wildcard and must keep the universe admin (`grep -rn 'universeAdminClient(' apps/nebula/test | grep -v test-helpers.ts` — 13 before the pre-step, more after).
- The baseline lane is green, and a fixture asserting an exact-star pattern now passes where it previously would have seen `{u}.*`.

### Phase 4 — ~~founder preference in the seed~~ ✅ CUT 2026-07-21
**Not built — resolved by pinning, not by deferral.** The existing `Star.onBeforeCall` gate already seeds a self-signup founder on their own Star (an exact-star pattern satisfies `hasAdminOverScope`), so this phase had no consumer. See §The DAG root grant for the reasoning and the one benign case it declines to fix. **Phase numbering is left intact** so the OQ/commit references above and in git history keep resolving.

### Phase 4b — the signup UI (minimal), served from Galaxy
**Goal:** a stranger can actually sign up — a real page, on the app's own surface, not a curl command.

✅ **PINNED 2026-07-21 (Larry): build a minimal UI, and serve it from Galaxy.** The instinct is right and the collapse confirms why: [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) makes **Galaxy the thing that serves the tenant-facing app** (*"the user-developer's built app is a pre-built static artifact … served dev: Galaxy-direct/uncached — the Galaxy DO **IS** engaged per request"*). A signup page for a Star inside `{u}.{g}` belongs on exactly that surface. ⚠️ **Do NOT build it inside `nebula-studio-ui`** — that is the user-developer **control plane**, and a stranger signing up for someone else's app has no business there; it would be a textbook interim to unlearn.

⛔ **SEQUENCED AFTER [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) Phase 3 ("build-box + container-less serving").** ⚠️ **Galaxy has NO `fetch` handler today** — verified: the only HTTP surfaces in `apps/nebula/src` are `entrypoint.ts` and `dev-container.ts`. Collapse Phase 3 is what gives Galaxy its serving surface. Building signup before it means standing up a serving surface *for signup alone* — the interim this repo keeps paying to unlearn. After it, the page is a route on a surface that already exists.

🔒 **The one wire-level decision the UI cannot fix later — pin it in this file, build it in Phase 2.** `consumeAndLogin` redirects **every** claim/magic-link/invite click to `${NEBULA_AUTH_REDIRECT}/{scope}`, and `NEBULA_AUTH_REDIRECT` is a single **env-global** value pinned to `/app` — the Studio SPA. So today a Star founder clicks their claim link and lands in the user-developer control plane, in `stageMode==='help'`, reading about Universes and Galaxies. **The redirect target is baked into the emailed link**, so no later UI work can correct a link already sent. **Mechanism: derive the destination by TIER at the one site that already holds it** — `consumeAndLogin` has `result.universeGalaxyStarId` in hand, so a **star-tier** scope routes to the Galaxy-served tenant surface and universe/galaxy-tier keeps `/app`. One site, tier-derived, no per-Galaxy config to thread and no new env var per tenant.

**Success (capable-of-failing):**
- A stranger completes signup **through the rendered page** and lands authenticated on the app's own surface — **not** `/app/{scope}`. Reds against today's env-global redirect.
- A **universe or galaxy** founder's claim link still lands at `/app/{scope}` — the tier split must not regress the Studio path.
- Turnstile widget is present and enforced on the rendered form (pairs with Phase 2's gate criterion; widget provisioning is the tracked blocker in `apps/nebula/harness/FINDINGS.md` B0/B1).

### Phase 5 — audit §Upward visibility
**Goal:** every non-admin `@mesh()` on Galaxy/Universe is deliberately tenant-readable, with the reason written down.

**Success (capable-of-failing):** ⚠️ **Regenerate the inventory** (`grep -rn '@mesh()' apps/nebula/src/galaxy.ts apps/nebula/src/universe.ts`) rather than trusting §Upward visibility's table — the collapse changes what a tenant can reach. Then: a written justification line per method, and a check that neither config blob carries anything app-developer-private. A method with no written reason fails the phase.

### Phase 6 — `signupPolicy` write path
**Goal:** a Galaxy admin can turn signup on/off for their app.

**Scope:** append-only `REGISTRY_MIGRATIONS` entry + admin-gated endpoint + registry method + client method + UI toggle — **plus the read** in the `claim-star` path. **None of this exists** — see §Signup policy. Default-on-absent is decided here, where the write path exists to change it; until this phase, signup is open.

**Success:** a Galaxy admin toggles the policy and a subsequent signup to that Galaxy is accepted/rejected accordingly, end-to-end.

## Open questions for `/review-task`
1. What the renamed `blockedBy` should be called and carry (last login, user count, …). ⚠️ **The rename belongs to Phase 1b, not 1a** — 1a keeps the name and only stops *acting* on it, which is what lets 1a stay "buildable today". (The `#emailForSub` fail-closed is **NOT** an open question — §Remediation pins it as staying. It was listed here once; relitigating it re-opens the exact reasoning error this file was corrected for.)
1b. ✅ **RESOLVED 2026-07-21 — fallback-only, no marker, Phase 4 cut.** See §The DAG root grant.
1d. **`claim-star` double-submit idempotency** — accept-and-record, or close it with a client-supplied idempotency key (the ADR-010-shaped answer: the caller mints one with no coordination). §Who owns what says *"do not let it ride unnamed"*; this is where it stops riding unnamed. **Blocks nothing** — a recorded acceptance discharges it.
1e. **`lastLogin` mechanism** (Phase 1b) — the two options are pinned in the phase but neither is chosen, and one adds a schema migration while the other does not. ⛔ **Phase 1b cannot be scoped until this is picked.**
1f. **Phase 1a's prune-up either/or** — "the early return must stay, **or** the prune-up gains its own equivalent guard." Pin which. Recommend: **keep the early return** (zero new code, and the guard it would be replaced by is the one whose absence causes the Galaxy+Universe cascade).
1c. ✅ **RESOLVED 2026-07-21 — moved wholly to Phase 6**, so it no longer gates Phase 2. The default-on-absent question is real but belongs where the write path exists to act on it; until then signup is open, as pinned. See §Signup policy.
2. **Eager Star creation to pin placement** — *separable, and an opportunity rather than a cost.* [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1b is BLOCKED because in-Star code runs *after* placement is pinned; it says the decision must be made at **the first `getByName` that creates the Star**. A signup request is exactly that moment and is the one time we hold the **user's own** `request.cf`. Needs `getByName(name, { locationHint })` threading, which does not exist yet. Composes with either ownership choice.
3. `signupPolicy` field shape — enum now, or an object with room for invite-code/payment later? **(Phase 6; no longer on Phase 2's path.)**
4. Does a Universe admin need a **delete-any-Galaxy** feature (with warnings surfacing child-Star info — last login, user count — so the decision is informed)? Adjacent, probably its own task.

## Relationships
- ✅ **Gated by [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) — COMPLETE 2026-07-21.** Not merely sequencing: the confinement is what makes open self-signup safe.
- **Partially supersedes [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1** — answers its `TODO(self-signup)` (the founder is known at signup) but narrows rather than retires the latch. Part 2 (last-admin protection) unaffected; Part 1b (placement) is Open question 2.
- **Overlaps [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md)** — star-tier admins by *invite* rather than self-signup. Same principal shape, different provenance; neither blocks the other.
- **Retires the fixture interim** recorded in the gating task's Phase 0 (every `adminClientAt` call site — 78/39 files at time of writing; see Phase 3's grep). Not on the pre-alpha critical path — [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) does not reference this file.
