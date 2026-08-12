# Every Registry route states its own restrictions

**Status:** Active child, **third of four** in the passage/dominion sequence — after [nebula-dominion-vocabulary-rename.md](nebula-dominion-vocabulary-rename.md) and [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md), before [nebula-invite.md](nebula-invite.md). Carved out of the second of those on 2026-08-11, where it was Phases 3 and 4. Not built.

> 📐 **`/write-task` Pass 2 — design intent and phases are both written.** Its content carries a Stage-1 (×2) and Stage-2 heritage plus a **scoped Stage-2 pass on exactly this material** (2026-08-11, 34 raised / 30 survived), whose findings are worked in. The **shape of this file is new** and has had no panel. From here: `/review-task`, then `/build-task`.

> ✅ **Gated on nothing. Code only — no stored shape changes here** (verified 2026-08-11: this file touches no column; `Memberships` already stores `universeGalaxyStarId` and `scopeAdmin` under their final names). ⚠️ **Each file in this sequence states its OWN gating in its own banner, and siblings do not restate it** — an earlier version of this line asserted where the sequence's wipe gate lived, and went stale the moment that file re-derived it. If you need another file's gating, open its banner.

**Objective — each of the Registry's authenticated HTTP routes states what it requires, completely, in a list you can read without opening a handler; and the mint asks one question.** Today the requirement for both routes is a conjunction split across a **file boundary**, and the mint assembles four invariants inline.

## Context and current state

### There is no authorization hole here, and the correction is the more useful finding

⚠️ **An audit called the Registry gate a hole. It is not.** `verifyInstanceJwt` ([router.ts](../packages/nebula-auth/src/router.ts)) proves containment only — `matchAccess(payload.access.authScopePattern, instanceName)` — and fronts exactly two routes, and **both handlers re-read `scopeAdmin` themselves**. `handleInvite`'s own comment states the invariant outright: the router proves containment, *so the bare bit legitimately completes the conjunction, and this line must never be copied to a site that lacks the router's check.*

🚨 **Therefore `hasPassage` at that gate would be an ESCALATION**, and it was the original shape of this work. `passage` admits upward for free; the handler's bare bit then completes the conjunction, so a Star `scopeAdmin` could POST `/auth/{u}/invite` and mint identities at the Universe. `matchAccess` refuses exactly that today. It would violate ADR-015 *"upward is nil"* and falsify an `accepted` [`docs/vision/auth.md`](../docs/vision/auth.md) table row.

⚠️ **METHOD, and it cost real time: when auditing whether a site is missing an authz conjunction, read the CONSUMERS, not just the enclosing function.** The first pass read each site's enclosing function, which cannot see a conjunction whose other half lives one hop away in the callers. That error produced a false blocker *and* a dangerous phase.

### What is actually defective

**The guard asks HALF a question, and its correctness is borrowed from every consumer re-checking the bit.** That is falsified the day someone adds a third entry to `AUTHENTICATED_SUFFIXES` — a one-line addition to a `Set` that reads like ordinary route registration, with no test and no grep that would catch it. 🚨 **And today's dispatch does not fail closed on that**: it ends in a catch-all (`if (suffix === 'invite') return handleInvite(...); return mintNarrowerToken(...)`), so a third entry reaches **the mint**.

⚠️ **The location of the Worker-side half is NOT drift — the rules require it.** `raw-comm.md`: an RPC-called DO method must not throw a status-carrying error the caller inspects, because Workers RPC drops custom Error props, so expected client errors are gated *before* the RPC. `handleInvite`'s comment says exactly that. **Fix the completeness, not the location.**

⚠️ **The reason to convert is inspectability, not a stack of latent CVEs.** `profile.ts:309`, `worker-token.ts:507` and `router.ts:359` are textually identical bare containment checks; two are correct because the missing half sits ~40 lines away, and one is correct only because of its callers. Today that question costs a full function read per site. Afterwards a bare containment check outside the structural class is non-conformant **by definition**, so the next one surfaces in a grep. **Do not let a phase justify itself on urgency the audit did not find.**

### `verifyInstanceJwt` does four things, and only one of them is ever discussed

Token extraction (incl. `extractWebSocketToken`), signature verify, the containment gate, **and `checkRateLimit(env, payload.sub)`**. ⚠️ A decomposition that names one of the four is how the other three go missing — and `router.ts:57` records the rate limiter as the only abuse bound on these two routes.

## Design intent, constraints, and future state

### The shape — a linear step pipeline

Deliberately hono-shaped so a later migration is close to mechanical (`raw-comm.md` forbids the *dependency*, not the pattern). A step returns a `Response` to terminate, a `Request` to replace the one it received, or `undefined`/`void` to pass it through — **mirroring** the convention `routeDORequest`'s `onBeforeRequest` / `onBeforeConnect` use (`packages/routing/src/route-do-request.ts:56`/`:68`, typed `Response | Request | undefined | void`).

⚠️ **`onBeforeCall` is NOT that convention, and citing it teaches the opposite.** It is a **mesh** hook (`lmz-api.ts`), it returns `void`, and its JSDoc says *"reject by throwing"*. A builder who resolves the citation there writes throwing guards, which land in `routeNebulaAuthRequest`'s catch and return **500 `internal_error`** instead of a 403 — defeating the refusals rule below, and caught by no criterion, since they only require the request be *refused*. `nebula-auth`'s router imports only CORS helpers from `routing` and never calls `routeDORequest`, so this pipeline **mirrors** that hook shape rather than reusing it.

🔒 **The `*Guard` suffix is a CONTRACT, and its home is `.claude/rules/coding-style.md` § *Guard naming*** (moved there 2026-08-11 so it outlives these task files). In one line: **`require*` throws** (mesh — `requireDominionHere`, `requirePassage`, `requirePermission`); **`*Guard` returns a `Response`** (these route steps). ⚠️ **A route step named `require…` would be a 500-shaped bug, not a style preference** — `router.ts`'s blanket catch has no typed-error branch, so a step written by analogy with its throwing neighbour returns `500 internal_error` where a 403 belongs. The first draft of this file had exactly that, naming these steps one letter from `requireDominion`. ⚠️ **Do not "unify" the mesh `requirePassage` with this pipeline's `passageGuard`** — same verdict, two boundaries, two error contracts.

⚠️ **`dominionOverInstanceGuard` spells out its operand on purpose.** It takes the **URL's instance**, never the impersonation subject, and it sits on the endpoint where `canMintFor` exists precisely because `hasDominionOver(access, instanceName)` versus `hasDominionOver(access, subject.authScope)` is *"the same call, the wrong second argument."* An earlier `…OverTarget` was read as the subject by a Stage-2 reviewer, who filed a blocker on that reading.

```
'invite':              [verifyJwt, rateLimit, passageGuard, dominionOverInstanceGuard, handleInvite]
'mint-narrower-token': [verifyJwt, rateLimit, passageGuard, dominionOverInstanceGuard, mintNarrowerToken]
```

⚠️ **The two lists being IDENTICAL is the honest state of today's code, not a smell — and saying so is what makes the next file's diff legible.** Both routes genuinely require dominion over the route's instance right now; the difference is that today one of them says so across two files and the other across two files as well. 🔓 **[nebula-invite.md](nebula-invite.md) is what makes them diverge**, by opening `/invite` to a member at their own scope. That file owns the openness question entirely — see § *Non-goals*.

- **`passageGuard` replaces the router's containment check**, and is the same verdict the mesh boundary computes — which is what makes `docs/vision/auth.md` § *The Registry* true rather than aspirational; it currently claims the scoped routes are gated by the same two rules, and they are not.
  - ⚠️ **It is strictly SUBSUMED on both of today's routes, and stating that is the honest framing.** `dominionOverInstanceGuard` implies dominion, and dominion implies passage, so every refusal the criteria assert is produced identically with `passageGuard` removed — it can never *decide* a verdict here. It is a **uniform boundary step**, present so a route whose endpoint guard is weaker inherits the boundary rule (which is what `/invite` becomes next file), and because accepted `auth.md` § *The Registry* requires it. ⚠️ **Its behavioural limb therefore cannot show it; the shape limb is what covers it.** Left unsaid, this is the defect § *Decisions* levels at `caller.scopeAdmin && subject.scopeAdmin` — *"an operand that can never be false is dead code inside a security predicate, invisible to mutation testing"* — rebuilt one level up. `worker-token.ts:521`'s *"eligibility strictly subsumes this gate's verdict"* comment is the in-repo model for stating it at the site.
- **Each handler's bare `scopeAdmin` read becomes a named guard** asking one complete question. Both take `dominionOverInstanceGuard`, which is exactly today's verdict for both.
  - ⚠️ **`dominionOverInstanceGuard`, never `…OverTarget`.** "Target" is the one word that reads as *either* operand: it was `matchAccess(pattern, target)`'s second argument, and in archived vocabulary it was the impersonation **subject**. This guard takes the **URL's instance**, and it sits on the one endpoint where `canMintFor` exists precisely because `hasDominionOver(access, instanceName)` versus `hasDominionOver(access, subject.authScope)` is *"the same call, the wrong second argument"*. A guard named for the ambiguous operand, one file from the call the wrapper exists to foreclose, is the confusion pre-built. (A Stage-2 reviewer read it as the subject and filed a blocker on that reading — one explanation is the rename signal, `calibration.md` §5.)
- **Claims travel in an explicit `ctx`** populated by the verify step — **`{ env, instanceName, claims: NebulaJwtPayload }`**, the whole verified payload.
  - 🚨 **`access` alone is NOT enough — narrowing to it makes the ADR-016 record unbuildable.** `handleInvite`'s JSDoc says so outright: it takes the whole payload because issuing an invite mints a membership, so *"narrowing to `access` here would make that record unbuildable downstream without re-verifying, and a `sub`-only record names the person acted upon as the person who acted."* `issueInvites` calls `projectActingToken(callerClaims)` — the ONE shared projection ADR-016 mandates. `mintNarrowerToken` needs `act` (root-identity gate), `sub` (self-narrow refusal, actor pair) and `profileId`. **Guards read `ctx.claims.access`; handlers take `ctx.claims` whole.** ⚠️ The crude narrowing fails type-check; the **quiet** failure is a *reconstructed partial* claims object, which `ActingTokenRecord`'s optional `act`/`profileId` project as a wrong-but-believed record — unrecoverable, since a record not captured at write time is gone.
  - **`claims` is non-optional on the guard steps.** The verify step returns the populated ctx and the guards take that type, so **mis-ordering a guard before verify does not compile.** ⚠️ An optional `access?` makes it a runtime concern instead, and the runtime behaviour is worse than it looks: `isAtOrBelow(access.authScope, node)` on an absent `access` throws at `.endsWith` exactly as `matchAccess(undefined, x)` does today — which is why `hasDominionOver`'s truthiness guard is documented as *"load-bearing, not defensive noise."*
- ⚠️ **Not on `this` — and the reason is the WORKER isolate, not the DO rule.** `router.ts` defines no class at all (the DOs are in `nebula-auth-registry.ts` and `profile.ts`), so per `workers-projects.md` this file is Worker code and none of the three DO files apply. The hazard is **module-scope state persisting across requests in a reused isolate**: a `let currentCtx` would be shared by two in-flight requests. ⚠️ Citing `durable-objects.md` § *No mutable instance state* was wrong — it argues from hibernation/eviction loss, never mentions cross-request reads, and invites the "move the guards into the DO" move `raw-comm.md` forbids. Conclusion right, premise wrong (`calibration.md` §7).
- **The pipeline table SUBSUMES `AUTHENTICATED_SUFFIXES`** (`router.ts:53`) — the map's keys **are** the registration, so a route cannot exist without a guard list. 🚨 **This is what actually deletes the borrowed-safety failure mode.** Leave both enumerations standing and the same one-line addition still lands on a handler; make the map the registration and it cannot.
- **`checkRateLimit` survives, named.** It matters *more* after this sequence, not less: accepted `auth.md` § *Grants* says the residual risk of the own-scope invite path is precisely mail abuse — *"That is rate-limiting and attribution."*
- Refusals name **which** rule failed. The existing `insufficient_scope` message describes a *satisfied* scope relationship and would be actively misleading on the new path (ADR-008 discloses the denial).

✅ **Every guard here is a pure claim-read — `access` plus the URL's instance, no storage — so this costs the singleton nothing** (auth.md: *"this decision is completely local. No network hop is needed."*). The one Registry read on these routes is the mint's subject lookup, keyed on the request body, which therefore belongs inside the handler. **Keep the existing RPC to the DO rather than switching to `stub.fetch`**: one round trip either way, and RPC's real cost — lossy errors, hence pre-gating — is already paid by these very guards.

### The mint asks one question

The mint's authorization becomes **one predicate call**, behind a thin `canMintFor(callerClaims, subject)` whose job is naming which scope goes in. ⚠️ **This DELETES checks rather than reorganising them.** The old `activeScope` bounds were asserting by hand what two already-pinned decisions guarantee:

- **A derived token carries the SUBJECT's `authScope`**, not something derived from `activeScope`.
- **`verify.ts` already forces `aud` ⊆ `authScope`** on every read — verified: the check is unconditional, runs on every verification, and returns `null` (fails closed).

Chain them and the old invariants fall out as *consequences*: eligibility places the subject's whole scope inside the caller's dominion; the minted `authScope` **is** the subject's scope; `aud` must sit inside it or the token is dead. So `aud ⊆ subject ⊆ caller` is a theorem.

```
authorize:  hasDominionOver(caller.access, subject.authScope)  ∧  caller.sub ≠ subject.sub
mint:       { sub, authScope, scopeAdmin } ← all the SUBJECT's;  aud ← requested;  act ← caller
```

🔒 **Keep a thin named `canMintFor(callerClaims, subject)`, for one reason only: naming which scope goes in.** With a single predicate call there is no passage-vs-dominion substitution left to guard — that risk was a product of the four-invariant shape. What survives is the live one: `hasDominionOver(access, instanceName)` versus `hasDominionOver(access, subject.authScope)` — the same call, the wrong second argument, and the route's `instanceName` is right there in scope. ⚠️ It takes **no `activeScope` parameter**. It lives with the mint in `nebula-auth`, not exported to `apps/nebula`, which has no business minting.

🚨 **The deletion inventory is PER-SITE, and getting it wrong is how this ships a hole.**

| Site | Today | After |
|---|---|---|
| `:507` | `matchAccess(caller pattern, activeScope)` — the caller-reach bound | **DELETED** — subsumed, since dominion over the subject plus the row below gives `aud ⊆ subject ⊆ caller` |
| `:554` | `matchAccess(subject pattern, activeScope)` — the subject bound | 🔒 **RETAINED**, reworded in place as the **`aud` validation**. Never deleted, not even briefly |
| `:569` | `caller.scopeAdmin && subject.scopeAdmin` — the intersection | **DELETED** — the left operand can never be false once dominion holds (§ *Decisions*) |
| `:575` | `authScopePattern: buildAuthScopePattern(body.activeScope)` | the **subject's** `authScope`, verbatim |

🚨 **`:554` is what makes every intermediate ordering safe.** Retained, it bounds `activeScope` inside the subject's scope, so even while `:575` still derives from `body.activeScope` the minted token cannot exceed the subject. ⚠️ **The hazard is a window in which `:554` is ABSENT** — deleted "to be replaced by the validation later" — because `:575` then derives an unbounded `authScope` from a caller-chosen `activeScope`, and an admin at `{u}` impersonating a `scopeAdmin` subject at `{u}.{g}` receives a token covering **all** of `{u}` carrying the subject's bit. It verifies cleanly, because `aud` sits inside the widened scope. ⇒ **Reword `:554` in place; never delete-then-reintroduce it.**

> ⚠️ **An earlier draft had this backwards, and the error is instructive.** It listed `:554` among the bounds to *"delete"* and built its worked example on `:507` refusing. `matchAccess('{u}.*', '{u}')` is **true** — a `prefix.*` pattern matches the prefix itself — so `:507` does not refuse that example; `:554` does. The paragraph named the one line that must never go, as one to remove.

🚨 **`canMintFor` runs BEFORE the `aud` validation, and the validation's 403 MUST NOT name the subject's scope.** An explicit ADR-008 disclosure decision lives **only** in the comment at `worker-token.ts:533-542`, which this work deletes along with the check it orders, while the validation survives: *"A faithfulness bound can pass while eligibility fails, so running the mirror first would tell a caller who is about to be refused WHERE the subject sits in the tree… Neither 403 body may name the subject's scope."* ⚠️ The *"fail-fast on an unverifiable token"* framing pushes the validation **earlier** — the order that comment forbids. No criterion, ADR or rule restates it, so **carry the rationale into the new comment**.

🚨 **The `aud` validation is a FOURTH containment site and needs the platform disjunct.** `#bootstrapEmails` is an array, so a platform caller can hold dominion over a second platform subject via `canMintFor` — then hit a validation asking `isAtOrAbove('nebula-platform', '{u}')`, **false** under any honest hierarchy comparison, rejecting *every* `aud`. ⇒ **Express it by calling the same helper `verify.ts` uses** for its internal-consistency check, so the disjunct is **inherited rather than re-derived** (ADR-007).

**Delete the `authScopePattern` override too, or it outlives its own safety argument.** `access-claims.ts`'s `authScopePattern?` opt exists solely for this mint, and its JSDoc argues its safety from exactly the two bounds this work deletes — *"separately bounded by BOTH the caller's reach and the subject's."* Afterwards it has **no caller at all**, yet stays exported via `testing.ts`, keeping constructible the shape this work deletes: a token whose `authScope` is decoupled from its issuing scope. Remove it from `NebulaAccessClaimInput` / `buildNebulaAccessEntry` / `mintAccessToken`'s opts; the mint then passes `universeGalaxyStarId: subjectIdentity.universeGalaxyStarId` with `activeScope: body.activeScope`, so **one parameter carries the claim and one carries `aud`**.

### Constraints

- **`raw-comm.md`** — expected client errors are gated Worker-side before the RPC; custom error own-properties are dropped across raw Workers RPC. This is what puts the guards where they are, and it is why they must not "move into the DO."
- **`security.md` rule (2)** — already narrowed 2026-08-11 to the one predicate plus the identity check, and it says restoring the deleted invariants is a **regression, not hardening**. ⚠️ **The rule file must NOT be "translated to scope terms"** — translating four invariants that no longer exist would preserve the shape this deletes.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)** — the ctx carries full claims because of this. ⚠️ **Ratification is Larry's ad-hoc call and no phase here owns it.**
- **[ADR-008](../docs/adr/008-full-org-tree-visibility.md)** — the denied-node set is disclosed, but the mint's refusal must not disclose the subject's scope.
- **[`docs/vision/auth.md`](../docs/vision/auth.md) — `status: accepted`**, so contradicting it is a blocker. § *The Registry* is the statement to conform to.
- ⚠️ **Vocabulary: MUST NOT use "reach" as a noun for either verdict.** `dominion` and `passage` are ADR-015's reserved terms.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Each route states its complete requirement, in a readable list** | `hasPassage` at the shared gate — an **escalation**: passage admits upward, the handler's bare bit completes the conjunction, and a Star admin mints at the Universe. |
| **The guards stay Worker-side** | Moving the conjunction into the DO — `raw-comm.md` forbids it: RPC drops custom Error props, so expected client errors are gated before the RPC. |
| **The pipeline table is the route registration** | Keeping `AUTHENTICATED_SUFFIXES` beside it — two enumerations means the one-line-addition failure returns in the new shape, and today's catch-all dispatch sends the forgotten suffix to **the mint**. |
| **`/invite` keeps today's verdict here** | Opening it in the same change — that is a capability addition, and this phase's binding constraint is already that the swap and the guards land together. Widening the blast radius of the one thing that must not go wrong, to save one guard swap later, is a bad trade. → [nebula-invite.md](nebula-invite.md). |
| **`passageGuard` stays though it is subsumed** | Dropping it — accepted `auth.md` § *The Registry* requires the same two rules as the mesh boundary, and `/invite` gains a weaker endpoint guard next file, at which point it starts deciding. Stated as subsumed so it is not mistaken for dead code nobody noticed. |
| **The mint's four invariants become ONE named predicate** | Leaving them assembled inline behind a ⚠️ comment. There is one caller, so the reuse argument is absent — but the substitution this change makes easiest to write is a one-token edit that type-checks and mints a universe-admin token. `calibration.md` §2: make it structurally impossible rather than guarding it. |
| **The minted `scopeAdmin` is the subject's, mirrored** | `caller.scopeAdmin ∧ subject.scopeAdmin` — equivalent under every reachable input, which is what makes it worse than useless: an operand that can never be false is dead code inside a security predicate, invisible to mutation testing. |
| **`activeScope` leaves the mint's security model** | Deciding authorization on it — it is already confined by `authScope`, so a decision on it is a decision on a derived value. It survives as a **validation**, never an authorization. |

## Acceptance criteria

- 🔒 **The Registry's HTTP routes compute `passage`, and by calling it.** A non-admin at `{u}` gets `insufficient_scope` on an instance-scoped route for `{u}.{g}.{s}`, while still passing its own scope's routes; an admin at `{u}` passes both. ⚠️ **Assert the CALL, not only the behaviour** — a hand-inlined two-arm check passes every behavioural limb while leaving `passage` uncallable, which is the defect. **The shape limb is a COMMAND**: a positive grep proving the wrapper is what the route entries name, plus a negative grep proving the primitives appear in `router.ts` only inside the guard definitions. ⚠️ **Re-derive the exact commands against where the symbols land** — `passageGuard` yields its definition *plus* two route references, so a blanket "returns nothing" form contradicts itself.
- 🔒 **A `scopeAdmin` at `{u}.{g}.{s}` is refused at `/auth/{u}.{g}/invite` and `/auth/{u}/invite`.** *Reds against a mechanical `passageGuard` swap that leaves the handler guards behind — the escalation this work is most likely to ship.*
- 🔒 **A route cannot exist without a guard list.** A suffix the router can reach with no pipeline entry returns 404 and **never reaches a handler**. *Reds against today's catch-all dispatch, which sends any unrecognized authenticated suffix to `mintNarrowerToken`.* Assert with a throwaway key, the shape `mint-narrower-token.test.ts:44` already uses for the retired `delegated-token` route.
- 🔒 **The rate limiter survives the decomposition.** With a low-limit `NEBULA_AUTH_RATE_LIMITER`, a second `/invite` POST from the same `sub` returns 429 `rate_limited`. *Reds against a decomposition that names the containment gate and silently drops `checkRateLimit`.* `packages/auth/test/auth.test.ts:2775` proves the limiter is exercisable in-lane.
- 🔒 **Two concurrent requests get their own verdicts.** Two `/invite` requests via `await Promise.all([...])` under tokens of different scopes each get their own answer — one 200 at its own scope, one 403 upward. *Reds against per-request claims parked at module scope in a reused Worker isolate, which every single-request criterion is blind to.*
- 🔒 **An impersonated invite still records the full acting principal.** An invite issued under a derived token records `sub` + the complete `act` chain + `profileId` + `access`, asserted on `nebula-auth.Registry.invite.sent`'s `actingToken` via the debug sink. *Reds against a ctx narrowed to `access`, and against a hand-reconstructed partial claims object — which type-checks and projects a wrong-but-believed record.*
- 🔒 **The mint cannot widen, and an upward impersonation is refused.** A `{u}.{g}` admin impersonating a `{u}.{g}.{s}` subject gets a token whose `authScope` is the **subject's**, carrying the **subject's** `scopeAdmin`; an admin at `{u}.{g}` impersonating a subject at `{u}` is **refused**. ⚠️ Also assert a `nebula-platform` subject is un-impersonable by any non-platform caller.
- 🔒 **The mint asks ONE question, and `activeScope` is not part of it.** The handler authorizes with a single `canMintFor(callerClaims, subject)` call and **contains no containment check used as an AUTHORIZATION**; the one containment check present is the **`aud` validation**, which runs *after* `canMintFor` and refuses `403 insufficient_scope`. ⚠️ **Assert the SHAPE** with a command: a positive grep for `canMintFor` at the handler, plus a negative grep proving `hasDominionOver(` appears in `worker-token.ts` nowhere but inside `canMintFor`'s body. ⚠️ `canMintFor` defined *and* called in that file yields 2 hits, not 1.
- 🔒 **The dominion refusal precedes the `aud` validation, and neither 403 names the subject's scope.** *Reds against hoisting the validation for "fail-fast", which discloses where the subject sits in the tree to a caller about to be refused (ADR-008).*
- 🔒 **A derived token is indistinguishable from a self-minted one.** An admin impersonating a subject whose membership sits **above** the chosen `activeScope` gets a token whose `authScope` is the **subject's membership**, whose `aud` is the chosen scope, and whose `myScopeTree` returns exactly what the subject's own token returns.
- 🔒 **A superuser passes both routes and may point `aud` anywhere.** A platform caller passes every instance-scoped registry route, and impersonating a second platform subject may point `aud` at any scope. *Reds against an `aud` validation that re-derives containment without the platform disjunct — § Platform calls this the change's largest silent-failure surface.*
- 🌐 **Driven as a `/live` scenario, on real logins.** A real `claimStar` admin — genuinely star-scoped, not minted — POSTing `/auth/{u}/invite` and being refused is the fixture-free form of the upward-refusal criterion. Extend `harness/scenarios/impersonation-lifecycle.ts` (already container-free, already on real logins) for the mint: log the subject in for real, capture `access.authScope`/`scopeAdmin`/`myScopeTree`, have a real admin impersonate them, assert equal. ⚠️ **Fidelity, not capability** — *indistinguishable from a self-minted one* is a **comparison of two tokens**, and the reference token can only be produced by the subject actually logging in; in-lane it must be hand-written, which is what `mint-narrower-token.test.ts` does today.

## Phases

Two phases, ordered by dependency. Each leaves the suite **no worse than the recorded baseline** — ⚠️ **not "green"**: the suite is RED today (3 known failures in `@lumenize/nebula`'s browser lane, one root). Measure as a **delta** — same set passes, no NEW failure, no NEW skip. Baseline and the three named tests live in [backlog.md](backlog.md) § *Testing & Quality*; do not restate the numbers here.

### Phase 1 — The route pipeline

The guard pipeline, `ctx` carrying full claims, `passageGuard` + `dominionOverInstanceGuard`, the table subsuming `AUTHENTICATED_SUFFIXES`, `checkRateLimit` named, refusals naming which rule failed.

🚨 **The middleware swap and the handler guards MUST land in the same commit — the phase's binding constraint.** Today's router check is downward-shaped, so it is the only thing refusing an upward invite. `passageGuard` admits upward *by design*. Swap the router first and leave the handlers holding bare bits, even for one commit, and a Star `scopeAdmin` can POST `/auth/{u}/invite` and mint identities at the Universe. Splitting this "for reviewability" is the one thing that must not happen.

⚠️ **Scope: the two authenticated routes only, and the boundary is principled rather than fatigue.** The pipeline exists to *compose guards*; the five auth-flow routes have none to compose, and a one-step pipeline is not one. Leave a note at that branch, and convert it if one ever gains a guard. Migrating all 15 routes is filed, not done.

**Criteria:** 🔒 *The Registry's HTTP routes compute `passage`, and by calling it* · 🔒 *A `scopeAdmin` at `{u}.{g}.{s}` is refused upward* · 🔒 *A route cannot exist without a guard list* · 🔒 *The rate limiter survives* · 🔒 *Two concurrent requests get their own verdicts* · 🔒 *An impersonated invite still records the full acting principal* · the route limbs of 🔒 *A superuser passes both routes*.

### Phase 2 — The mint asks one question

`canMintFor`, the per-site deletion table, the `aud` validation with its inherited platform disjunct and its ordering, the `authScopePattern` override deleted, the minted `authScope` becoming the subject's.

**Three green tests break, and two in the dangerous direction.** A builder facing a red suite *while deleting security checks* is under exactly the pressure `security.md` rule (2) warns about, and `calibration.md` §3(b) says their redness is evidence the change is right. Intended verdicts: `mint-narrower-token.test.ts:249` (asserts `access.authScopePattern === '${childScope}.*'`, and `worker-token.ts:491` cites this test **by name** as its own justification) → **inverted** to `access.authScope === the subject's membership scope` with `aud === childScope`. `:253` (*"rejects an activeScope the CALLER cannot reach"*) keeps passing **for a different reason** — eligibility, not the deleted bound — and asserts only `status`, with no `authScopePattern` or `matchAccess` in it, so it is invisible to every grep-shaped criterion and would decay silently ⇒ **rename it to what now refuses it, or rebuild it on a subject the caller genuinely does not administer.** `:207` → **kept**, against the validation's pinned status and code.

**Criteria:** 🔒 *The mint cannot widen* · 🔒 *The mint asks ONE question* · 🔒 *The dominion refusal precedes the `aud` validation* · 🔒 *A derived token is indistinguishable from a self-minted one* · the mint limb of 🔒 *A superuser passes both routes* · 🌐 *Driven as a `/live` scenario*.

## Non-goals

- 🔓 **WHO may invite, and what bit an invite confers** → [nebula-invite.md](nebula-invite.md). This file places `/invite`'s guard in the pipeline at **today's verdict** and changes no caller's outcome; that file opens it. ⚠️ **Do not "helpfully" widen it here** — accepted `auth.md` § *Grants* describes the target, but calibrating it depends on the collaborator design, F&F invites, super-admin invitability and the abuse bound all at once, which is a file's worth of design and not a guard swap.
- **Migrating the five auth-flow routes** to the pipeline — filed, not done.
- **The claim's shape, the containment predicates, `hasPassage` itself** → [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md), which lands first.
- **The verdict renames** → [nebula-dominion-vocabulary-rename.md](nebula-dominion-vocabulary-rename.md).

## Relationships

- **Depends on** [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md) — `passageGuard` needs `hasPassage`, and the mint's collapse needs the minted `authScope` to be a scope.
- **Blocks** [nebula-invite.md](nebula-invite.md) — that file changes `/invite`'s guard, which needs the pipeline to change it in.
- **Touches** [nebula-profile-accepted-membership-gate.md](nebula-profile-accepted-membership-gate.md) only indirectly; the Profile's own sites belong to the file before this one.
