# The body-scoped Registry routes take their scope from the URL

**Status:** Drafted 2026-08-17. **Not built, not reviewed. ON HOLD 2026-09-02** — deferred past the pre-alpha wipe, on the two corrections below rather than on priority alone. Carved out of [nebula-registry-route-guards.md](../archive/nebula-registry-route-guards.md), where it was Phase 3 — a Stage-1 panel found its spec falsified on disk in three independent ways *and* found it was the only phase carrying a breaking cross-package change. That file landed 2026-08-18, so the gate is open (the route table exists to move rows within).

> ⚠️ **Two claims this file rested on were checked on disk 2026-09-02 and are FALSE. Both are corrected in place below; read them before re-planning, because together they invert the file's cost/benefit.**
>
> 1. **Its dependency has EXPIRED — the guards it planned to reuse no longer exist** (§ *Relationships*). This is a build-the-guards task now, not a move-the-rows task.
> 2. **"A breaking URL change is cheapest now" is FALSE — the cost curve is FLAT** (§ *The blast radius*). Nothing a pre-alpha user holds pins these paths, so waiting costs nothing.
>
> ⇒ What the file buys (route-table legibility, a stronger forward-body shape) is unchanged and still worth having; what it costs went up, and the reason to hurry was never real. **The value is real, the urgency was not.** ⚠️ It is deferred, **not** rejected — do not re-derive it as *"we decided against moving the scope onto the URL."* The `> **Today's code differs.**` blockquote in accepted [`docs/vision/auth.md`](../../docs/vision/auth.md) § *The layers a call passes* stands until this lands, and naming it as this file's closer is what keeps the gap enumerable.

> ⚠️ **This work was bundled into a sibling THREE TIMES and pulled out on the third.** Each bundling argument was about **edit adjacency** — *"`REGISTRY_ENDPOINTS` is right there, so deleting it and moving these paths is the same edit"* — and each time the **blast radius** appeared only in a subordinate clause. ⇒ **Do not re-bundle it.** Adjacency of the edit is not adjacency of the risk: the Set dies in one file, the path change reaches production client code, three test lanes, the `/live` harness, a Registry DO dispatch and a published README.

**Objective — move `create-galaxy`, `create-star`, `delete-scope` and `delete-scope-plan` from `/auth/{suffix}` to `/auth/:scope/{suffix}`, so a route guard decides dominion instead of the Registry DO deciding it at the top of the method it runs.**

## Context and current state

Today the edge verifies the token, injects `verifiedAccess` into the request body, and forwards to the Registry DO, which checks dominion inside the method. The check therefore lands at R7 where R6 belongs, and the route table cannot show it — which is what accepted [`docs/vision/auth.md`](../../docs/vision/auth.md) § *The layers a call passes* excepts in a `> **Today's code differs.**` blockquote naming exactly these routes.

### Three disk facts the first draft got wrong — read these before writing a phase

🚨 **(1) The DO derives its own endpoint from the path, so the move 404s all four routes unless the DO changes with them.** `forwardToRegistry` preserves `request.url`, and `NebulaAuthRegistry.fetch` computes `const endpoint = url.pathname.slice(prefix.length + 1); // after '/auth/'`. After the move that yields `"{u}.{g}/create-star"`, which matches no `case` and falls to `default: 404`. ⚠️ **A client-construct inventory cannot reach this** — the first draft's search (`post('create-galaxy'`, `authUrl(`, `registryUrl(`) names only client call sites. **The DO's `endpoint` derivation, its `case` blocks and its own `OPEN_ENDPOINTS` are in scope.**

🚨 **(2) "No request body" is FALSE, and the correct statement is stronger.** `case 'delete-scope'` destructures `{ target, verifiedAccess, callerSub, callerClaims }`: `callerSub` feeds `#computeDeletionPlan`'s caller-exclusion (warning integrity, ADR-015), and `callerClaims` **is** the [ADR-016](../../docs/adr/016-record-the-acting-principal.md) acting-principal record. Neither is derivable from a URL segment. ⇒ Say which side of the Worker→DO hop loses its body: **the client sends none** (the id is the URL segment) while **the Worker composes the forward body entirely from verified values.** That is *stronger* than today, because the client-supplied carrier that `router.ts`'s ⚠️ trust-boundary comment guards disappears.

🚨 **(3) The delete routes' dominion check is NOT where the first draft said.** It named `#hasDominionOverUniverse` / `#hasDominionOverGalaxy`, which exist only for `createGalaxy`/`createStar`. The delete routes' check is a bare `hasDominionOver(callerAccess, target)` inside the **private `#computeDeletionPlan`, shared by `planScopeDeletion` and `executeScopeDeletion`** — so a literal build leaves exactly the belt-and-braces the work exists to remove. ⚠️ **That same helper throws a SECOND `403 'forbidden'`** when `#emailForSub` returns empty, documented at the site as fail-closed for warning integrity and explicitly **not** a revocation gate. It is **RETAINED**. A builder hunting "the forbidden" can delete the wrong one.

⇒ **State the removal as a PROPERTY, never as a symbol list:** *no Registry DO method reachable from a route carrying `dominionOverScopeGuard` re-computes dominion over that route's `:scope`.*

### The blast radius, which is the reason this is its own file

Production client (`apps/nebula/src/nebula-client.ts` — its `post()` hardcodes `/auth/${endpoint}`, so each site must derive a *different* scope), three test lanes, the `/live` harness, the Registry DO dispatch above, and `packages/nebula-auth/README.md` (which carries the endpoint table with `/auth/create-galaxy` etc. and `(+verifiedAccess injected)`). ⚠️ **Build a construct-anchored inventory** (`tasks/README.md` § *Inventories*) covering **both** sides of the hop — client constructs *and* the DO's endpoint derivation.

⚠️ **CORRECTION 2026-09-02 — that radius is WIDE but entirely FIRST-PARTY, which makes the cost curve FLAT, not rising.** This file was carried on *"a breaking URL change is cheapest now and only gets dearer"*; the premise was never checked, and it is false. **Every consumer is ours and ships when we ship** — measured on disk, 2026-09-02:

| Consumer | Sites | Pinned by anyone? |
|---|---|---|
| `apps/nebula/src/nebula-client.ts` | 4 | No — Studio's client, served from our Worker, redeployed with it |
| `/live` harness | 1 real `fetch` (`passage-not-dominion.ts`) + comments | No |
| Tests (`apps/nebula` + `packages/nebula-auth`) | ~50 | No — and `calibration.md` §3(c) weights these ≈ zero |
| Registry DO (`nebula-auth-registry.ts` + `router.ts`) | endpoint derivation, `case` blocks, `OPEN_ENDPOINTS` | No |
| `packages/nebula-auth/README.md` | 1 endpoint table | No |
| **A pre-alpha user's generated app** | **0** | — |

🚨 **The zero is the whole finding.** These four are **platform** operations — creating a galaxy or star, deleting a scope — reachable only from Studio. `apps/nebula/src/frontend/` — the directory vendored into a user's built bundle — contains **no `/auth/` reference at all**, so no artifact a pre-alpha user holds names these paths. ⇒ The set above is the same set a year from now, and **arriving in pre-alpha does not ossify these URLs the way it ossifies a data-plane path.** ⚠️ **Do not re-file this as "no consumers, so YAGNI"** ([[no-consumer-is-not-no-use-case]]) — the point is narrower and only about *timing*: waiting is free, so waiting is not a cost to weigh against building.

⇒ **Re-verify the zero before building, don't inherit it.** It holds only while these routes stay Studio-only; the moment a generated app or a published Star is taught to create or delete a scope, the curve starts rising and this file's urgency becomes real. The check is one command: `grep -rn '/auth/' apps/nebula/src/frontend/`.

⚠️ **Name the tests that must go red and their intended verdicts**, the way a sibling phase does for the mint: `nebula-auth-registry.test.ts` asserts precisely the DO-side refusals this work deletes, across several `it` blocks with surviving sibling assertions, so "the suite is red" is not a diagnosis.

## Open question — should the Worker→DO carrier for verified claims be a HEADER rather than the body?

**Not open, and paramount: keep work OFF the Registry singleton.** ADR-018 makes it a hard non-sharding ceiling, so the edge Worker — which scales horizontally — does the verifying. ⛔ **DO-side verification is therefore REJECTED, and it is rejected on a price rather than a principle**: it is the only design that removes the trust boundary instead of managing it (the DO would re-derive from a signature, so `router.ts`'s *"ASSIGN, never merge"* warning would have nothing to guard), but it moves Ed25519 verification — two key imports, up to two verifies, no cache — onto the scarce resource, ~0.2 ms a request. Revisit only if the trust boundary itself becomes the problem.

**What IS open: the carrier.** Today the Worker parses the client's JSON body, assigns `verifiedAccess` (and for the delete routes `callerSub` + `callerClaims`), and re-serializes. The alternative is `new Request(request, { headers })` — the body untouched as a stream, the claims in headers.

Arguments for the header, strongest first:

- 🔒 **The DO could decide authorization SYNCHRONOUSLY, before any `await`.** Reading a header needs no `await`; `request.json()` does, and `durable-objects.md` § *Avoid opening input gates* is explicit that an `await` opens the gate. Today the DO must open the gate to learn who is calling, so the authorization decision and the act it authorizes sit on opposite sides of a gate opening. A header carrier closes that window. **This is a race-risk argument, not a speed one, and it is the one that does not depend on any measurement.**
  - ⚠️ **RE-DERIVE THIS BEFORE LEANING ON IT (flagged 2026-09-02, not resolved).** It is the only *safety* argument in the file, and a partial trace weakens it. Half of it holds: `nebula-auth-registry.ts` does await `request.json()` to read `verifiedAccess`, and that opens the gate before the dominion check runs. But `hasDominionOver` is pure string logic over **request-local** claims and reads no storage, so an interleaved request has nothing to race against — and the TOCTOU that *is* real, `checkSlugAvailable` → INSERT, is already managed by keeping the only `await` ahead of the checks (§ *Design intent*, which says so and says not to move existence to the edge). ⇒ Either name the storage read this gate opening actually exposes, or **demote it to the legibility argument the other three bullets already make**. Traced to the dispatch, not through every method body — finish the trace rather than trusting either reading.
- **The Worker stops touching the body**, so a malformed body stops being its problem — exactly the defect the three OPEN routes were changed to fix (*"made a malformed body indistinguishable from an empty one — the registry's own JSON guard now owns that"*). The claim-injecting routes still carry that bug.
- **Other headers survive.** Rebuilding *"silently dropped every header but Content-Type."*
- **All eight registry rows become ONE shape**, and it is the shape `routeDORequest` already uses everywhere else in the repo. A reader who knows that pattern cold spends nothing here; today they must stop and ask why this hop is different.

⚠️ **Do NOT assume header parsing is cheaper than body parsing — measure it.** That is the one claim in favour that nobody has checked, and it is not needed for the decision: the input-gate argument stands on its own.

⚠️ **Trust is a WASH, so it is not a reason either way.** A client can forge a header as easily as a body key, so the Worker must overwrite unconditionally in both designs — which is what *"ASSIGN, never merge"* already mandates. ⛔ And the claims MUST NOT ride in `Authorization: Bearer`: that header carries a credential, and a reader will reasonably try to verify whatever is in it. `AccessEntry` is not a token.

## Design intent

🔒 **`:scope` is the TARGET being acted on, and ONE `dominionOverScopeGuard` asks dominion over it** — the galaxy being created, the star being created, the scope being deleted. No parent derivation, no second guard, no scope in the body.

⚠️ **Dominion over the TARGET is EQUIVALENT to dominion over the parent, not weaker.** The objection is that `isAtOrAbove(t, t)` is reflexively true, so a `scopeAdmin` sitting *at* the target would pass a check its parent would refuse. That principal cannot exist for a create: **if a caller's `authScope` names an EXISTING scope `S`, and the create target `T` must be ABSENT, then `S` cannot be at or below `T`** — `S` existing implies every ancestor exists, and `T` would be one. The legitimate creator passes either way by downward totality; a sibling is refused either way. ⚠️ The single residual is a claim that does **not** name an existing scope — an unexpired token for a just-deleted scope, which could recreate it as an empty `Scopes` row. Memberships were purged and `createGalaxy` mints none, so the actor gains no access and any `scopeAdmin` with dominion deletes it again: slug squatting, reversible, by someone who held dominion there minutes ago. [ADR-015](../../docs/adr/015-passage-and-dominion.md) makes that a UI concern, **not** a reason to complicate the check.

🔒 **EXISTENCE is a separate, ASYMMETRIC check that stays in the DO.** A create requires the target **absent** (409 `slug_taken`) and its parent **present** (400 `parent_not_found`); a delete requires nothing, because it is **already idempotent** — `#computeDeletionPlan` has no not-found branch, so a missing target matches an empty cascade and returns `{ affected: [] }`. ⚠️ **Do not add one.** ⚠️ **Do not lift existence to the edge**: `claimStar`'s comment states why — keeping the only `await` ahead of the checks is what stops the input gate opening between `checkSlugAvailable` and the INSERT — so an edge copy reintroduces a TOCTOU window and gives one rule two homes. ⇒ The complete requirement is **dominion at the edge ∧ existence in the DO**, stated at both sites.

⚠️ **`my-scopes` does NOT move.** `myScopeTree(callerAccess)` takes no target — it *enumerates* what the caller can reach, so the answer is the set itself and there is nothing for a guard to compare against.

## Acceptance criteria

- 🔒 **Every authenticated route that targets a scope takes it from the URL, and a guard decides.** ✅ Done-check: accepted `auth.md` § *The layers a call passes*' `> **Today's code differs.**` blockquote naming these routes is **deleted**.
- 🔒 **No Registry DO method reachable from a guarded route re-computes dominion over that route's `:scope`** — stated as a property, verified against `#computeDeletionPlan` as well as the two create methods. ⚠️ `#computeDeletionPlan`'s **second** `403 forbidden` (empty `#emailForSub`) is RETAINED.
- 🔒 **A `scopeAdmin` at the GALAXY tier can create a Star under it, and one at a sibling galaxy cannot.** *Reds against a guard checking the parent **universe** — `createStar` gates one tier below `createGalaxy`, and **every existing fixture is a universe-scoped admin**, so it passes both readings.*
- 🔒 **Deleting an already-deleted scope succeeds** — `{ affected: [] }`, not 404.
- 🔒 **An impersonated `delete-scope` records the full acting principal** (ADR-016), proving the Worker-composed forward body carries `callerClaims`.
- 🔒 **A superuser passes every instance-scoped route**, including the newly-URL'd ones.
- 🔒 **`packages/nebula-auth/README.md` names no route path this work moved.**

## Non-goals

- **The route pipeline, the table and the guards themselves** → ✅ [nebula-registry-route-guards.md](../archive/nebula-registry-route-guards.md) (BUILT + archived 2026-08-18). This file moves rows that file defined; read `packages/nebula-auth/src/router.ts` rather than the frozen file.
- **`my-scopes`' re-key onto `profileId`** → its own sibling.

## Relationships

- **Depends on** [nebula-registry-route-guards.md](../archive/nebula-registry-route-guards.md) for the **table**, which is in source and stays. ⚠️ **CORRECTION 2026-09-02 — the guard half is NO LONGER SATISFIED, and this line used to claim it was.** `dominionOverScopeGuard` and `passageGuard` **do not exist in source**; `grep -rn 'dominionOverScopeGuard'` finds them only in task files. They were deleted 2026-09-01 when every invite moved to the mesh facade, and `packages/nebula-auth/src/router.ts` records why at the site the pair used to occupy: *"served exactly one route — `/auth/:scope/invite` — and died with it … dead guards cannot be redded by any test."* That comment **anticipates this file** — it says the scoped registry routes re-introduce the pair when their scope moves onto the URL — so the deletion was deliberate and this is planned work, not a regression to repair.
  - ⇒ **Re-scope before writing phases: this task now BUILDS the two guards and THEN moves the rows.** Reconstructible from the archived file, which specifies them in detail, and three things must travel with the verdict rather than being left behind: the **post-verdict two-code branch** (`forbidden` when the caller holds no `scopeAdmin`, `insufficient_scope` when they hold it but the scope is outside their own), the **`denied` log line naming the route**, and the **subsumption note at the site** saying `passageGuard` can never decide a verdict here. ⚠️ Read that spec from source-adjacent prose where it exists; the archived file is frozen and describes a table that has since changed.
  - ⇒ **Cost moves from ~3–4 d to ~4–5 d**, and the delta is exactly the half that used to be free.
