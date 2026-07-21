# Star self-signup — open signup, a real founder, no admin in the loop

**Status:** 🚧 **DRAFT — design pinned with Larry 2026-07-21, not yet `/review-task`-clean.** Stage-1 framing ran on an earlier draft; its findings are folded in below. Re-run `/review-task` before `/build-task`.

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

Star signup is **shape-identical to `claim-universe`**: an open endpoint on the `nebula-auth` router creates the `Scopes` row, mints the founder identity, and issues the emailed claim token. Every machine part already exists (`isValidSlug`, `checkSlugAvailable`, `#mintIdentity`, `InviteTokens`, the email path), so this adds **no new mechanism and no new test scaffolding**.

⚠️ **The registry cannot reach platform DOs** — its own JSDoc says so ([nebula-auth-registry.ts:665-667](../packages/nebula-auth/src/nebula-auth-registry.ts)), and two prior files burned the idea ([archive/nebula-auth-surrogate-sub.md](archive/nebula-auth-surrogate-sub.md); [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) — *"a write with no reader"*). So the DAG grant is **not** the registry's job.

### The DAG root grant — lazy, on the founder's first authenticated touch

**This is a constant, not a choice.** At signup there is no authenticated principal: the founder exists as an `Identities` row but has never logged in. Any *eager* stamp therefore needs a mesh call with no `aud`, which means either minting a token to act as someone who hasn't authenticated, or exempting a Star method from `onBeforeCall` — both standing backdoors.

The founder's **first authenticated touch** has everything: `aud` = their star, exact-star pattern, `admin`. So `Star.onBeforeCall`'s existing seed stays, **narrowed** from *"first `access.admin` caller"* to *"caller holding an exact-star pattern for this star."*

✅ **Why the narrowed seed is exact, not a heuristic.** At creation the founder is the **only** principal who can hold an exact-star pattern for that star — the registry minted exactly one identity there. The only way to manufacture another is for a **Galaxy admin to deliberately invite a star-admin** into the window between signup and first login — and a Galaxy admin already holds full authority over that star. **The seed can therefore never grant authority the actor did not already have.** That is an invariant, not a coincidence; it is why no extra founder-stamping machinery is needed.

⇒ This **narrows** rather than retires the first-touch latch, so it only *partially* supersedes [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1. Its `TODO(self-signup)` is answered (the founder is known at signup); the latch itself remains.

### Slug — caller-chosen, with a reserved-slug reject

The signer-upper picks the slug. The signup path **must reject reserved names**, mirroring `claimUniverse`'s `PLATFORM_INSTANCE_NAME` check ([registry:307-309](../packages/nebula-auth/src/nebula-auth-registry.ts)).

⚠️ **`dev` is reserved by structure and MUST be on that list.** [nebula-client.ts:735](../apps/nebula/src/nebula-client.ts) hardcodes `${galaxy}.dev` as the user-developer's authoring workspace; `star.ts:382` gates `resetDevData` on `s[2] === 'dev'`; `registry:763` flags `isDev` off it. Without the reject, a stranger founds **the user-developer's own Studio workspace** as `isAdmin: true`: their Studio then 409s `slug_taken` forever behind *"Could not start the development workspace"*, and the squatter's exact-star `isAdmin` clears `resetDevData`'s `requireAdmin` — i.e. they can **wipe it**. Seed the list with `dev` plus whatever env names [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) pins for its `{u}.{g}.{env}` cast. Collision on a non-reserved slug is an ordinary `checkSlugAvailable` → 409.

### Signup policy — data the registry owns

*"May anyone sign up for a Star in my app?"* is the **app developer's** policy, but it does not require app code. Put it as a field on the **Galaxy's `Scopes` row** (`signupPolicy`), written by the Galaxy admin through an existing admin-gated path and read by the signup path. The registry reads its own data — **no dependency inversion** — and later shapes (invite-code-required, payment-first, custom fields) extend that field without moving the flow.

That is the seam: the 80% case is free and identical across every app; the 20% we cannot yet specify has somewhere to go.

## ⚠️ Remediation — a PREREQUISITE, not a follow-up

The business decision rests on *"a covering admin deletes the squatted Star."* **That does not work today**, and open signup without it is the one combination that does not hold together.

`#computeDeletionPlan` computes `blockedBy = #otherUsers(down, callerEmailLc)` where `down` **includes the target itself** ([registry:734](../packages/nebula-auth/src/nebula-auth-registry.ts)), and `#otherUsers` ([:767](../packages/nebula-auth/src/nebula-auth-registry.ts)) returns every Identity in those scopes whose email differs from the caller's. So a Galaxy admin deleting a squatted Star gets `blockedBy = [the squatter]` → **403 at [:673](../packages/nebula-auth/src/nebula-auth-registry.ts)**. The block fires on the **Star**, so an automated sweep hits it exactly as a support ticket would. (Galaxies were never the target — the prune-up at `:739` only fires when the last child goes and nobody else is attached.)

### The fix is the principle, not a carve-out

**Authority trickles DOWN. A covering admin may delete any descendant scope — shared or not, risky or not — and the only restraint is a UI warning.** (Pinned with Larry 2026-07-21.) That is a design principle of the whole tier model, not a concession to self-signup: a Galaxy admin already holds full authority over every Star beneath them, so a Star's own members cannot be allowed to *veto* that authority.

⇒ **`blockedBy` stops blocking.** `#computeDeletionPlan` keeps computing the attached-user list — it is genuinely useful — but `executeScopeDeletion` no longer throws on it ([registry:673-676](../packages/nebula-auth/src/nebula-auth-registry.ts)). The list becomes **warning data on the confirm screen the plan endpoint already feeds**, so the admin makes an informed decision rather than hitting a wall. Rename it to say what it now means (it is not a blocker), and enrich it with what an admin needs to decide — per Larry: **last login, user count**, and similar.

⚠️ **Scoped to the deletion TARGET.** Leave the `#otherUsers` check in the **prune-up** at [:751](../packages/nebula-auth/src/nebula-auth-registry.ts) intact: that one decides whether the cascade silently climbs into an *ancestor* the admin did not name. Preventing a surprise ancestor wipe is a different concern from letting an admin delete what they explicitly chose.

**A note on the earlier framing, so it is not re-litigated:** a first pass proposed a narrow carve-out — "a Star whose only identity is its own founder is not shared, so it should not block." That is true but far too narrow, and it treats the symptom. The block is wrong for *every* descendant, not only the single-founder case. Likewise, the guard was not "correct for its original premise" — the premise itself inverted the authority model by letting members veto an admin above them; open signup only made the consequence visible.

⚠️ **`#emailForSub`'s fail-closed (M2)** was load-bearing *because* an empty email made the block match zero rows and permit a wipe. Once the block is informational, that path degrades a **warning**, not an authorization — the real gate is `#hasAdminOverScope` at [:712](../packages/nebula-auth/src/nebula-auth-registry.ts). Re-derive its behavior deliberately in review rather than deleting it by omission.

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
*(to be pinned with capable-of-failing criteria in `/review-task`)*
1. **Make deletion non-blocking** (prerequisite) — `blockedBy` becomes warning data on the existing confirm screen; `executeScopeDeletion` stops throwing on it; prune-up's `#otherUsers` stop stays. Enrich the warning with last-login / user-count so the decision is informed.
2. **Open signup endpoint on the registry router** — `Scopes` row + `#mintIdentity(email, starId, isAdmin: true)` + `InviteTokens` claim link; reserved-slug reject; `signupPolicy` read.
3. **Narrow the `Star.onBeforeCall` seed** to an exact-star-pattern caller.
4. **Audit §Upward visibility** — content of the two config blobs; record why each non-admin `@mesh()` is deliberately tenant-readable.
5. **Re-ground the ~30 baseline fixtures** onto real star founders — `adminClientAt` on a star scope starts returning one, so this is one helper body (the intent-split landed 2026-07-21).

## Open questions for `/review-task`
1. What the renamed `blockedBy` should be called and carry (last login, user count, …), and whether `#emailForSub`'s fail-closed still earns its keep once the list is informational.
2. **Eager Star creation to pin placement** — *separable, and an opportunity rather than a cost.* [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1b is BLOCKED because in-Star code runs *after* placement is pinned; it says the decision must be made at **the first `getByName` that creates the Star**. A signup request is exactly that moment and is the one time we hold the **user's own** `request.cf`. Needs `getByName(name, { locationHint })` threading, which does not exist yet. Composes with either ownership choice.
3. `signupPolicy` field shape — enum now, or an object with room for invite-code/payment later?
4. Does a Universe admin need a **delete-any-Galaxy** feature (with warnings surfacing child-Star info — last login, user count — so the decision is informed)? Adjacent, probably its own task.

## Relationships
- ✅ **Gated by [nebula-confine-admin-bypass.md](nebula-confine-admin-bypass.md) — COMPLETE 2026-07-21.** Not merely sequencing: the confinement is what makes open self-signup safe.
- **Partially supersedes [on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md) Part 1** — answers its `TODO(self-signup)` (the founder is known at signup) but narrows rather than retires the latch. Part 2 (last-admin protection) unaffected; Part 1b (placement) is Open question 2.
- **Overlaps [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md)** — star-tier admins by *invite* rather than self-signup. Same principal shape, different provenance; neither blocks the other.
- **Retires the ~30-fixture interim** recorded in the gating task's Phase 0. Not on the pre-alpha critical path — [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) does not reference this file.
