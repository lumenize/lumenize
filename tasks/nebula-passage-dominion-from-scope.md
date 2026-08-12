# Passage and dominion, computed from the scope

**Status:** Active child, **NEXT** — first of the three remaining in the passage/dominion sequence. ✅ [nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md) **BUILT + archived 2026-08-11**, so its renames are in the tree; before before [nebula-registry-route-guards.md](nebula-registry-route-guards.md) and [nebula-invite.md](nebula-invite.md). This is the **spine**: every file after it reads `access.authScope`. Not built, except the `isAdmin` → `scopeAdmin` rename, which landed 2026-08-07.

> 📐 **`/write-task` Pass 2 complete; the surviving prose has had both review stages.** Re-split 2026-08-11 and condensed 2026-08-12, so a fresh `/review-task` is owed before `/build-task`.

> ✅ **Not wipe-gated, and not invite-gated.** `authScopePattern` appears nowhere in `schemas.ts`, the KV refresh record stores `universeGalaxyStarId`, and the pattern is re-derived at every token issuance and persisted nowhere. The one wipe-gated column lives in [nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md) § *Phase 2*.

## Objective

**A token carries the member's scope; `passage` and `dominion` are computed from it, and every site that needs either calls one of them.** One string — the same one in the URL and in the `Memberships` row. No second derived string, no wildcard grammar, no site re-deriving half the model inline.

⚠️ **The second half is not decoration.** ADR-007 says one predicate expresses the model and no site re-derives it. Today nine sites delegate to `hasDominionOver` while nine more call the containment check directly, and `passage` does not exist as a callable thing anywhere — `requirePassage` is the only place both arms appear together.

✅ **There are ZERO live holes** (audited 2026-08-11): every site either holds the conjunction — inside a predicate, spelled across a function, or **once across a file boundary** — or is a structural check with no principal in it, where a `scopeAdmin` conjunction would be actively *wrong*.

⚠️ **So the reason to convert is NOT danger — it is that danger is invisible from the call site.** `profile.ts:309`, `worker-token.ts:507` and `router.ts:359` are textually identical bare containment checks; two are correct only because the missing half sits ~40 lines or one file away. Today telling them apart costs a full function read each; afterwards a bare containment check outside the structural class is non-conformant **by definition**, so the next one surfaces in a grep. **The buy is inspectability, not a stack of latent CVEs — do not let a phase justify itself on urgency the audit did not find.**

🚨 **Trap that must not be reversed: `hasPassage` at the Registry gate would be an ESCALATION, which is why this file does not touch that gate.** `passage` admits upward for free; `handleInvite`'s bare `scopeAdmin` then completes the conjunction, so a Star `scopeAdmin` could POST `/auth/{u}/invite` and mint identities at the Universe. `matchAccess` refuses exactly that today. It would violate ADR-015 *"upward is nil"* and falsify an `accepted` `docs/vision/auth.md` table row (*"the bit sits beneath `u`, so it buys nothing"*) — the *"bare bit is dominion"* bug § *The conjunction survives* says has already shipped twice.

## Context and current state

**Today** — ⚠️ **"today" means AFTER [nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md) lands, because it lands first.** Verified against disk 2026-08-12, post-rename:

- **A derived second string.** `buildAuthScopePattern(instanceName)` turns a member's scope into a pattern at **token** issuance — login and every refresh — and the result goes in the JWT as `access.authScopePattern`. Star tier passes through unchanged; universe and galaxy get `.*` appended; the reserved `nebula-platform` becomes `*`.
  - ⚠️ **It is also doing a SECOND job nobody named, and deleting it drops that job silently.** In `requirePassage` it is called for its side effect as much as its value: it **throws on an unparseable callee name** (>3 segments, illegal slug) and sits *before* the reach clause deliberately, so a malformed name fails closed instead of falling through to a comparison. The replacement predicates take a plain string and would happily compare a malformed one, so **an explicit `parseId(name)` fail-closed check must stay at that position**, with its comment — otherwise the only validation of the callee name vanishes inside a diff that reads as a pure rename.
- **A glob matcher.** `matchAccess(pattern, target)`: `*` matches everything, `prefix.*` matches the prefix and anything beneath, otherwise exact equality.
- **The dominion predicate.** `hasDominionOver(access, scope)` = `access.scopeAdmin && matchAccess(access.authScopePattern, scope)`, delegated to by `requireDominionHere`, `requirePermission`'s bypass, and `requirePassage`.
- **A SECOND enforcement surface, on the registry's HTTP routes.** `verifyInstanceJwt` ([router.ts](../packages/nebula-auth/src/router.ts)) is the only scope check every instance-scoped registry route passes through — `Missing` item 3.
- **Two directions, expressed identically.** `requirePassage` grants passage on either *the dominion arm* (`scopeAdmin` plus the caller's pattern covers this node) or *the tenant boundary* (a pattern built from **this node's own name** covers the caller's `aud`). The second is a child reaching its parent, and confers no dominion (ADR-015 clause 3).

**Missing:**

1. **One fact, two strings** — the scope lives in the URL and in `Memberships.universeGalaxyStarId`, and the JWT carries something derived from it that exists nowhere else, so a reader holds the derivation in their head to reconcile the three. And **the two directions look like one mechanism**: both are glob matches against `buildAuthScopePattern` output, so nothing in the shape of the code says one grants dominion and the other deliberately does not.
2. **Non-admin downward movement exists at the MESH boundary and has no consumer.** ✅ **No separate work** — only `requirePassage`'s tenant arm reads `aud`, so computing passage from the member's scope instead refuses `{u}.{g}.{s}` for a non-admin at `{u}` by construction. Today such a caller has passage to every Star in the Universe and dominion over none: pure disclosure surface (ADR-008 makes the org tree and presence visible to Star-reachable callers) with no use case behind it.
3. 🔀 **The Registry's HTTP routes BORROW their dominion from their consumers — owned entirely by [nebula-registry-route-guards.md](nebula-registry-route-guards.md).** Kept as one line because it is why that file exists and why this one does not touch `router.ts`: the conjunction is real but split across a **file boundary**, so its safety is a property of the current consumer set rather than of the gate — falsified the day someone adds a third entry to `AUTHENTICATED_SUFFIXES`, a `Set` that reads like ordinary route registration. ⚠️ **Not a live hole, and the obvious fix is an escalation** (§ *Objective*).

### The instruments that find every site

⚠️ **This file names INSTRUMENTS, not an inventory.** A hand-listed site table is a snapshot that rots when an edit lands 40 lines from a call, and it is a lower bound besides: run against disk 2026-08-12, the greps below surfaced decision sites the previous inventory did not name (`worker-token.ts:339`, `worker-token.ts:417`). **Run them, then classify what they return** — do not work from a list.

**1 — Completeness.** Every site that asks the model must read a claim field, so the claim fields are the choke point:

```sh
grep -rn '\bauthScopePattern\b\|\bscopeAdmin\b' packages/*/src apps/nebula/src --include='*.ts'
```

✅ **Measured complete 2026-08-12: 150 hits across 20 files**, and `comm`-ing it against a grep for every predicate call (`hasDominionOver(\|matchAccess(\|isPlatformInstance(`, 38 hits) leaves exactly one file uncovered — `testing.ts`, a re-export barrel containing no decision. A site cannot decide passage or dominion without reading one of these two fields, and an aliased read still contains the token at its initializer.

**2 — Triage.** Filter the wide grep down to conditional reads:

```sh
grep -rn '\bauthScopePattern\b\|\bscopeAdmin\b' packages/*/src apps/nebula/src --include='*.ts' \
  | grep -E 'if *\(|&&|\|\||\? |return .*(authScopePattern|scopeAdmin)'
```

150 → **30** on 2026-08-12, of which ~6 are comments and SQL. ⚠️ **This filter's precision DEPENDS on the naming criterion this same task installs** — it catches an aliased read only while the alias keeps the claim's name, so renaming the six `pattern` locals would blind it wherever the alias is the only hit. That is why instrument 1 is what proves completeness and this one is only triage.

**3 — Conformance, after the change.** The one the first two cannot replace, because it asks about *shape* rather than location: `isAtOrAbove` / `isAtOrBelow` may appear only inside the two verdicts plus a **named structural allow-list**, and `scopeAdmin` may be *tested* only inside `hasDominionOver`. Stated as a criterion below; today the same shape returns **14** `matchAccess` calls outside `parse-id.ts`, and that is the number that must come down to the allow-list's length.

⚠️ **BSD BRE trap:** do not narrow instrument 1 to `access\??\.scopeAdmin` — the `?` makes `s` optional and is matched literally, silently dropping `verifiedAccess.scopeAdmin`, the exact read that matters.

⚠️ **Audit by reading the CONSUMERS, not just the enclosing function** — a conjunction split across a file boundary is what an enclosing-function read cannot see, and it is what made the first audit call the Registry gate a hole.

**Classify every hit into four classes, exhaustive by construction**: a site wants one of the two verdicts, wants a structural fact, or wants neither. ✅ **The instruments say WHERE; the class is judgment** — and it is obvious at most sites (a `scopeAdmin` conjunction means dominion; a check with no principal in it is structural). So what this file pins is only the sites where a sweeper will guess **wrong**:

| Site | Class | Why a sweeper gets it wrong |
|---|---|---|
| `verify.ts` internal-consistency · `access-claims.ts` construction invariant · the refresh `activeScope` confine | **structural** | ⚠️ each needs the platform disjunct, and **none** gains a `scopeAdmin` conjunction — § *Platform, and the claims-shape blast radius* |
| `star.ts`'s root-admin seed | **exact identity** | ⚠️ it asks *"is this Star my own scope?"*; making it hierarchical hands a Star's root grant to whichever covering admin arrives first, **permanently** — the seed latch is one-shot with no re-seed. Rename only; the pinned lift in [`on-hold/nebula-dataplane-root-admin.md`](on-hold/nebula-dataplane-root-admin.md) is the same class |
| `nebula-do.ts`'s platform-name reject · `NebulaClientGateway.onBeforeCallToClient` | **neither, deliberately** | a masquerade guard and an `aud` equality check — both look convertible and are not (§ *Constraints*) |
| `requirePassage`'s tenant arm | **passage** | correct today, but on the wrong INPUT — it reads `aud` (item 2). Today **nothing** calls passage as a thing; that is the finding |
| `router.ts` `verifyInstanceJwt` + `worker-token.ts`'s two bare `scopeAdmin` reads | **not this file's** | the conjunction is split across a FILE boundary — item 3 |

⚠️ **Structural is not a lesser class**; wrapping a structural fact in a verdict puts a `scopeAdmin` conjunction where no principal exists, and breaks token verification for every superuser.

**Everything else is a plain dominion conversion.** Nine sites already delegate to `hasDominionOver` and change only by the predicate gaining its platform arm; `myScopeTree`'s bare `scopeAdmin` + `LIKE prefix.%` and the Profile scoped-admin branch's 37-line spread are the two that re-derive it by hand and become callers.

## Design intent, constraints, and future state

### The target

**Two ways in, and the direction is the meaning** — the same statement `docs/vision/auth.md` § *Coarse-grained access control* makes, which is `accepted` and therefore the wording to conform to:

- **The node is your own scope, or an ancestor of it.** Free; no `scopeAdmin` needed. This is **passage**, and it confers nothing (ADR-015 clause 3).
- **The node is a descendant of your scope, and `scopeAdmin` is set.** The only way to reach *downward*, and the only one carrying **dominion**.

In one line: your scope and the node called must be on the same vertical line, upward is free, downward needs `scopeAdmin`. Two predicates express it, and **no site re-derives either** (ADR-007):

```
dominion(access, node) = access.scopeAdmin ∧ ( isPlatformInstance(access.authScope)
                                             ∨ isAtOrAbove(access.authScope, node) )

passage(access, node)  = isAtOrBelow(access.authScope, node) ∨ dominion(access, node)
```

⚠️ **Both containment predicates take `(myScope, node)`, and `isAtOrBelow` exists SO THAT no caller ever reorders them.** Writing the upward arm as `isAtOrAbove(node, myScope)` would put the same function on adjacent lines with transposed arguments — one slip from inverting the security model in this file's two most load-bearing lines. Every line reads subject-first: *my scope is at or above the node* (dominion), *at or below* (passage).

⚠️ **`passage` is the UNION, not the upward arm alone.** An admin at `{u}` calling `{u}.{g}.{s}` has passage *because* they hold dominion there; writing passage as upward-only refuses the whole downward rule. It is also what makes the Registry-gate escalation in § *Objective* available — the same error twice.

⚠️ **Both verdicts owe an explicit fail-closed contract for an absent or partial `access`.** `hasDominionOver`'s truthiness guard is documented as *"load-bearing, not defensive noise"* because `matchAccess(undefined, x)` throws at `.endsWith`, and `isAtOrBelow(access.authScope, node)` throws identically — but `requirePassage`'s tenant arm loses its `if (!aud) throw` when it stops reading `aud`, so `hasPassage` inherits nothing and must state its own.

⚠️ **`dominion` and `passage` are RESERVED — [ADR-015](../docs/adr/015-passage-and-dominion.md) § *Terminology* is the definition home — and "reach" MUST NOT be used as a noun for either.** Three terms, one meaning each: `isAtOrBelow` the upward *structural* relation, `dominion` the downward verdict, `passage` the boundary verdict.

**The symbols THIS file pins, so no phase of it invents one.** Three tiers, and the tier decides the naming style: a **structural fact** gets a literal name, a **verdict** a reserved word, **data** its field name.

| Today | Becomes | Tier | Note |
|---|---|---|---|
| `matchAccess(pattern, target)` | `isAtOrAbove(myScope, node)` + `isAtOrBelow(myScope, node)` | structural | `Access` was vestigial — it takes two strings and never sees an `AccessEntry` |
| `hasDominionOver(access, node)` | gains the `isPlatformInstance` arm | verdict | the rename already landed in [nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md), which withheld this arm because `matchAccess('*', …)` made it dead code |
| *(does not exist)* | `hasPassage(access, node)` | verdict | its route-guard consumers (`passageGuard`, `dominionOverInstanceGuard`) are pinned in [nebula-registry-route-guards.md](nebula-registry-route-guards.md). ⚠️ **`*Guard` RETURNS a `Response`; `require*` THROWS** — a contract, not a style |
| `isPlatformInstance(id)` | unchanged | structural | already correctly tiered |
| `access` / `authScope` / `activeScope` / `scopeAdmin` | unchanged | data | always a possessed field, never a bare noun |
| `const pattern = …` (6 locals) | name it for what it holds | data | otherwise these read `const pattern = claims.access.authScope` — this task's own two-strings-for-one-fact defect rebuilt at function scope |

⚠️ **The three tiers are `.claude/rules/coding-style.md` § *Security-verdict identifiers*'s — cite it rather than re-deriving it.** They govern **every** identifier, not only exported ones: **a guard takes the name of the verdict it enforces, never of the claim field it reads; a local takes the name of what it holds, never of what it used to hold.** A predicate renamed correctly but called by a guard named for the bit, over a local named for the pattern, leaves the reader holding exactly the translation the rename was meant to delete — and **no behavioural criterion can see that**, which is why the criteria below carry a grep-shaped one.

`buildAuthScopePattern` is deleted and the claim becomes **`access.authScope`**, the member's scope verbatim. ⚠️ **The rename drops `Pattern` and nothing else:** the value stopped being a pattern, not an auth scope. `→ scope` would overstate the change, collide with `aud` (also a scope), and force every reader of `docs/vision/auth.md` — which says `authScope` throughout — to hold a translation.

⚠️ **`isAtOrAbove` compares WHOLE dot-separated segments — contract, not implementation detail.** The obvious `b === a || b.startsWith(a)` type-checks, passes every behavioural criterion below, and silently makes `u.g.s1` cover `u.g.s10` and `acme` cover `acme-2`, both legal slugs. The boundary is closed explicitly in two independent places today (`parse-id.ts:148` `startsWith(prefix + '.')`, `nebula-auth-registry.ts:689`'s `LIKE ${prefix + '.%'}`); the replacement owes the same guarantee.

✅ **`isAdmin` → `scopeAdmin` landed 2026-08-07** (66 files, at rest and in flight). ⚠️ `packages/auth` and `packages/mesh` keep their own `isAdmin` — a *different* bit (auth's `Subjects` column, and a flat top-level claim mesh mints for auth's gate) — and the Data-plane's `admin` **grant on an orgTree node** keeps its name, being one of a symmetric triple (`CHECK(permission IN ('admin','write','read'))`). A repo-wide replace would break all three, the mesh one silently.

#### Platform, and the claims-shape blast radius

**A super-admin is an ordinary membership at the reserved scope `nebula-platform`** ([nebula-auth-registry.ts:717](../packages/nebula-auth/src/nebula-auth-registry.ts) mints it only for a configured bootstrap email at that exact scope). So `authScope` carries **`nebula-platform` verbatim** — the `'*'` sentinel was the *derived* value and dies with the derivation. Not a wildcard, and emphatically not an empty string, which is falsy and would grant everything on a mis-default. `isAtOrAbove('nebula-platform', 'acme.crm')` is **false** under any honest hierarchy comparison, which is why `dominion` above carries an explicitly named `isPlatformInstance` arm ([parse-id.ts:85](../packages/nebula-auth/src/parse-id.ts), already exists).

⚠️ **This is the change's largest silent-failure surface.** Today `matchAccess('*', …)` is true, so every site touching the pattern treats a superuser as reaching everywhere *without knowing it*; afterwards, any site without the platform branch stops recognizing them. **The invariant: a superuser is authorized at every scope, may point `aud` at any scope, passes every registry route, and enumerates every scope.**

🚨 **A mechanical conversion breaks a superuser three ways, each silent somewhere different**, which is why the three structural sites are called out by name above: `verify.ts` ⇒ their token **fails to verify at all**; the refresh `activeScope` confine ⇒ they can refresh to **no** scope; `access-claims.ts` ⇒ their token is **unmintable**, throwing at every mint site including `createNebulaTestToken`. ⚠️ **The platform tests that would catch this live in the 19 `'*'` fixtures being rewritten in the same commit**, so their redness is no signal — treat the disjunct as a stated requirement of each conversion, not something a red test will remind you about.

⚠️ **Size the fixture sweep with the command, and note that NEITHER backstop covers it.** `grep -rn "authScopePattern: *'\*'" packages apps --include='*.ts'` returned **19 hits across 12 files** on 2026-08-10, including `harness/scenarios/superadmin-reach.ts` and `harness/lib/prod-drive.ts` alongside eight test files. Instrument 1 is `src`-only, and the no-`authScopePattern`-survives criterion greps the claim **name** — so a fixture rewritten to `authScope: '*'` passes both while asserting over a value production can never mint. Each moves to `authScope: 'nebula-platform'`.

### The conjunction survives — state this or the change becomes a vulnerability

⚠️ **This is NOT "`scopeAdmin` is the reach-relevant bit."** That paraphrase is one step from *the bare bit is dominion*, which has **already shipped twice** (the `access.admin` upward leak, and `#computeDeletionPlan`'s downward veto). Dominion stays a conjunction; only its second operand gets simpler. **The scope is still the bound** — it is what stops a `{u}.{g}` admin reaching `{u2}` — and it is as trustworthy as the pattern was, since the pattern was only ever derived from it. `security.md`'s delegation rules and ADR-015 both say *"the bare `admin` bit is never dominion by itself"*; that sentence becomes **more** load-bearing here, because the bit becomes the only distinguishing claim. The amendment must say so at the site.

### What this buys, and what it costs

- **Three places, one string.** URL, `Memberships` row, JWT — nothing to reconcile, and ADR-015's clauses stop needing to be memorized (same predicate, opposite arguments).
- **`discover` becomes complete.** It returns the scopes a person holds memberships in and cannot see DAG grants (those live in each Star's DagTree, unreachable from the registry). Today a teammate with one high-tier non-admin membership shows up as one entry while the truth about where they can work is scattered across N DagTrees with no index. Afterwards membership *is* the answer, and a scope picker can show it.
- **A residual disappears.** [nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md) used to file the minimum-privilege collaborator's over-reach into tenant Stars as a disclosure question to decide; with no downward reach without `scopeAdmin`, the question stops existing rather than getting answered.

**Cost, accepted: a person who works in N scopes needs N memberships and N sessions**, where a high-tier non-admin membership would have covered them with one. Grants are unaffected — DAG grants are per-node under both models — so this costs sessions, not permissions. Accepted because the surfaces are usually already separate (Studio on the Galaxy, preview on the `.dev` Star); each membership carries its own acceptance, a real per-scope consent moment that reads well to an enterprise buyer; and it is what makes `discover` honest. ⚠️ **The one friction is N invite emails**, and it cannot be waived because the address is verified elsewhere: `Memberships.acceptedAt` is set only by consuming a link delivered to the mailbox, and per-membership acceptance is ADR-012's manufacture defense. If it ever bites, the fix is a multi-invite-in-one-email flow — years away (Larry, 2026-08-05).

### Constraints

- **[ADR-015](../docs/adr/015-passage-and-dominion.md)** — this **amends** it: the commitment is unchanged (downward total, upward nil, passage ≠ dominion), and every normative sentence naming a pattern changes. ⚠️ **Ratification is OUT of this file and every sibling, and MUST NOT be re-added (decided with Larry 2026-08-11)** — he ratifies ad-hoc, gated on nothing. ADR-015's Status line is the authority.
  - ⚠️ **ADR-015's rejected-alternative row forbids this exact change, so retiring it must be said out loud.** It rejects *"tighten `requirePassage`'s tenant branch"* because *"narrowing it breaks legitimate non-admin upward reads"* — a harm that cannot occur under the new rule, since `docs/vision/auth.md` § *Coarse-grained access control* (**`accepted`**, where ADR-015 is only `Proposed`) preserves that read as its own table row while refusing only the descendant case this file deletes. Cite those rows rather than re-arguing it; per `docs/adr/README.md`, a conflict while `Proposed` is case (a), *change the decision*.
  - ⚠️ **`calibration.md` §4 is NOT amended, and MUST NOT be.** It cites the same prohibition to make a different point — *do not delete the branch because the comment defending it was wrong* — and the branch does survive here, with only its **input** changing from the client-chosen `aud` to the server-trusted `authScope`. Read the two prohibitions as one and the likely "fix" is deleting a branch that lesson correctly defends.
- 🔀 **`security.md`'s mint-side rule (2) and `canMintFor`** → [nebula-registry-route-guards.md](nebula-registry-route-guards.md). ⚠️ **That rule is ALREADY NARROWED** — four invariants collapsed to one predicate plus an identity check — and it says restoring the deleted ones is a **regression, not hardening**. It must NOT be "translated to scope terms". Nothing here touches the mint.
- **[`docs/vision/auth.md`](../docs/vision/auth.md) — `status: accepted`**, and its § *Coarse-grained access control* already states this file's target model in present tense. Per `docs/vision/_review-lens.md` § *Status convention* contradicting an accepted doc is a **blocker**, so that section is the statement to conform to; the deliverable is deleting its `> **Today's code differs.**` blockquote, not rewriting its prose.
- **[ADR-008](../docs/adr/008-full-org-tree-visibility.md)** — unchanged, but its blast radius shrinks: fewer callers are Star-reachable.
- ⚠️ **`aud` stays on the token and on the wire — this work touches the passage decision ONLY.** `NebulaClientGateway.onBeforeCallToClient` refuses a mismatch between the originating call's `aud` and the receiving connection's, so a call out to a client reaches only connections in that scope. `authScope` cannot replace it: two tabs of one Galaxy admin on sibling Stars share `authScope` and `scopeAdmin`, so comparing those would deliver one tenant's subscription updates to the other.
- **`verify.ts`'s internal-consistency check is KEPT and re-worded** — it stops guarding passage (which no longer reads `aud`) and guards only the token-internal invariant the Gateway's outbound fence assumes. Its comment currently claims a reach purpose and must not survive that way.
- **Pre-alpha** — no users and not wipe-gated, so the claim rename is free now and a compatibility problem later.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Reach is computed from the member's scope plus `scopeAdmin`** | The derived wildcard pattern — two strings for one fact, the second existing only inside a token, which is what makes the model hard to hold. |
| **Dominion stays a conjunction** — `scopeAdmin` ∧ scope-at-or-above | *"`scopeAdmin` is the only reach-relevant bit"* — true as a summary, fatal as an implementation; the ADR-015 violation that has shipped twice. |
| **Non-admin downward passage is dropped** | Keeping it — no consumer, and it is exactly the tenant-Star passage the collaborator design was about to accept as a residual. |
| **Platform is a named special case** | A wildcard covering it incidentally — the reserved name is not a hierarchical scope, and saying so once beats a grammar that hides it. |
| **The claim is renamed off `authScopePattern`** | Keeping the name — it asserts a pattern that no longer exists, and a name needing explanation is the rename signal (calibration §5). |
| **`isAdmin` → `scopeAdmin`**, one spelling at rest and in flight | Keeping `isAdmin` in storage while the token says `admin` — one concept, two spellings. Also rejected: renaming the token's `access.admin` to `isAdmin` (fights the prefix-free precedent `emailVerified` / `acceptedAt`), and `registryAdmin` (names where the bit is stored, not what it is dominion over — and wrong anyway, since the bit reaches the Data-plane through the bypass). |
| **A derived token carries the SUBJECT's membership scope** | Deriving it from `activeScope` (today) — least-privilege that protects nothing, since the admin already holds total downward dominion as themselves, while costing simulation fidelity: `myScopeTree` would show the impersonator a different scope picker than the subject sees. |
| **The minted `scopeAdmin` is the subject's, mirrored** | `caller.scopeAdmin ∧ subject.scopeAdmin` — an operand that can never be false (impersonating already requires dominion over the subject): dead code inside a security predicate, invisible to mutation testing, re-derived by every next reader. `auth.md` § *Impersonation* also says every identity claim names the subject. |
| **The upward rule reads `authScope`; `activeScope` leaves the security model entirely** | Deciding passage on `activeScope` — not independent (the refresh mint already confines it inside `authScope`), so it is a security decision on a derived value, sited inside a token endpoint where no authz reviewer would look. Checked against every row of `auth.md`'s table: all verdicts reproduce, and the two rows differing only in `activeScope` collapse. |
| **Land it before [nebula-invite.md](nebula-invite.md)'s review** | After the Galaxy collapse — every week adds surface describing the old model, and the collapse adds more. Five files already describe it. |

## Acceptance criteria

**Behaviour**

- **A non-admin reaches its own scope and nothing beneath it.** Passage at `{u}`; refused at `{u}.{g}` and `{u}.{g}.{s}`. *Reds against retaining downward reach for non-admins.*
- **An admin reaches downward, totally** — passage with dominion at `{u}`, `{u}.{g}` and `{u}.{g}.{s}`, including scopes created after the token was minted. *Reds against dropping the downward rule.*
- **Upward is nil for dominion.** An admin at `{u}.{g}` is refused **as admin** at `{u}`. *Reds against a symmetric predicate.*
- 🔒 **The scope is still the bound.** An admin at `{u1}` is refused everywhere in `{u2}`. *Reds against a predicate reading `scopeAdmin` without the scope — the "bare bit is dominion" bug, and the one this change makes easiest to write.*
- **The tenant direction survives, without dominion.** A Star member has passage to its parent Galaxy DO, then is denied at the point of action. *Reds against collapsing both directions into one rule.*
- **`aud` survives on the token and on the wire.** A call out to a client is still refused on an `aud` mismatch. *Reds against over-applying "passage no longer reads `aud`" into removing the claim — which would cross-deliver one tenant's updates to another.*
- **Platform means everywhere.** A `nebula-platform` admin reaches every scope, including the platform instance itself. *Reds against a hierarchy predicate with no case for a non-hierarchical name.*
- **A mesh call to a node NAMED `nebula-platform` is still refused**, for that same superuser. *Reds against removing the platform-name reject once its `'*'`-collapse justification is re-derived away — its reason is masquerade prevention, which survives the grammar.*
- 🔒 **Segment boundaries hold under colliding names.** `{u}.{g}.{s}1` is refused at `{u}.{g}.{s}10`; an admin at `{u}` is refused everywhere in `{u}-2`. *Reds against a prefix-match `isAtOrAbove` — the defect every other criterion is blind to, since no other scope names collide on a prefix.*
- 🔒 **A superuser is unchanged everywhere.** Their token **verifies**; authorized at every scope; may refresh to any `activeScope`; `myScopeTree` returns every scope; passes the Profile owner/admin gate with **zero registry reads**. *Reds against any consumer of `access` that lost the platform branch when `'*'` stopped being the value.* ⚠️ The verification limb fails CLOSED and TOTAL, so a miss there is a superuser who cannot log in, not one who quietly loses admin. ⚠️ Its **registry-route** and **mint-`aud`** limbs belong to [nebula-registry-route-guards.md](nebula-registry-route-guards.md) — do not look for them here, and do not re-add them.
- **Enumeration is unchanged for an admin.** `myScopeTree` returns the same set before and after, for the same identity. *Reds against a bound that narrows the query.*
- 🌐 **The same, driven as a `/live` scenario.** Real logins at three tiers, real sockets: a universe admin acts in a Star beneath, a star-scoped member is refused at the Galaxy, and a **superuser** logs in and reaches. ⚠️ **Fidelity, not capability** — pool-workers can assert the predicate, but only a real login proves the claim the *server actually minted* carries what the predicate expects.

**Shape — the half no behavioural criterion can see**

- 🔒 **Nothing re-derives either verdict** (instrument 3). `grep -rn 'isAtOrAbove(\|isAtOrBelow(' packages/*/src apps/nebula/src` returns hits only inside `hasDominionOver`, `hasPassage`, and a **named structural allow-list** — never beside a hand-assembled `scopeAdmin` conjunction. *Reds against a fix applied one site at a time.* ⚠️ **The allow-list is the deliverable, not an inventory**: a list of every site rots on an unrelated edit, while a short list of exceptions fails loudly the moment a new site appears. Today the same shape returns **14** `matchAccess` calls outside `parse-id.ts`.
- 🔒 **The instruments are capable of failing.** Run each § *The instruments that find every site* grep against the **pre-change** tree and confirm it returns the sites this file says it does; run instrument 1 against the post-change tree and confirm every hit is classified. *Reds against an instrument that goes green because it greps a name the change already deleted* — the same defect as a test that cannot fail, and the reason *No `authScopePattern` survives* cannot stand alone.
- 🔒 **No identifier still names the old model.** `grep -rnE '\b(buildAuthScopePattern|matchAccess)\b' packages/nebula-auth/src apps/nebula/src` and `grep -rnE 'const (pattern|subjectPattern|authScopePattern) *=' packages/nebula-auth/src apps/nebula/src` both return nothing; then **eyeball** `grep -rniE '[Pp]attern' packages/nebula-auth/src apps/nebula/src` for survivors holding a scope. *Reds against the shape this file most easily ships: correct predicates called over a local still named for the pattern.* ⚠️ Every behavioural criterion above passes with `hasDominionOver` called over a variable called `pattern`. ⚠️ Deliberately scoped to this file's symbols — the verdict names carry their own grep in [nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md), so including them would make this green-by-inheritance.
- **No `authScopePattern` survives.** `grep -rn 'authScopePattern' packages apps` returns nothing outside archived task files. Eyeball the remainder.
- ✅ **No `isAdmin` survives — already satisfied (2026-08-07)**, kept as a regression check: `grep -rn 'isAdmin' packages/nebula-auth/src apps/nebula/src` returns **0**. ⚠️ Eyeball any future hit — the data-plane's `'admin'` tier and `packages/auth` / `packages/mesh`'s own `isAdmin` are different concepts keeping their names.

**Standing guidance and docs**

- **No standing-guidance statement forbids narrowing the tenant branch.** ⚠️ **Stated over the BRANCH, not the symbol** — `enforceScopeReach` is already `requirePassage` by the time this builds. ADR-015's amended text must carry clause 2 restated over `scopeAdmin` ∧ scope-at-or-above, plus the impersonation answer. ⚠️ `calibration.md` §4 stays untouched and correct — confirm its lesson still reads as "the branch was right", since the branch survives with a different input. *Reds against amending only ADR-015's Mechanism paragraph.*
- **No standing-guidance statement describes the pattern model.** ⚠️ State it structurally — *no rule or ADR describes dominion as pattern-coverage* — not as a list of files. Known sites: ADR-015's mechanism, **ADR-016's normative record contents**, `security.md`'s mint-side invariants, `workflow.md`'s ADR-015 one-liner. ⚠️ **"Standing guidance" is the CLAUDE.md list**, so it includes **`.claude/skills/*/SKILL.md`** and **agent memory** — the 2026-08-09 `scopeAdmin` sweep found a stale claim in each, neither reachable by a grep over `.claude/rules docs/adr tasks`, and **memory is the worst**: it loads every session unprompted and nothing type-checks it. Sweep both explicitly.
- 🔒 **No standing-guidance statement CITES A DELETED SYMBOL.** `grep -rn 'matchAccess\|hasAdminOverScope\|enforceScopeReach\|buildAuthScopePattern\|requireAdmin\|accessAdmin' docs .claude tasks website/docs`, giving every hit a verdict. ⚠️ **A second axis, not a synonym for the criterion above**: that one sweeps the pattern *model*, this sweeps the fact that the *symbols* stop existing — `durable-objects.md` and `workflow.md` both name `hasAdminOverScope`, and ADR-015's Evidence line opens with it. **Guidance citing a deleted symbol is worse than guidance citing a deleted model**: the reader greps, finds nothing, and cannot tell whether the rule is stale or they are looking in the wrong place.
- **`website/docs` teaches the new model.** `grep -rniE 'authscopepattern|matchaccess|scopeadmin|isadmin' website/docs`, then `cd website && npm run check-examples`. ⚠️ **Not just the claim name** — the deleted grammar is taught in **prose and mermaid diagrams**, which no `@check-example` guards (`documentation.md`: *the checker guards fenced blocks, never prose*), and `auth-flows.md` alone diagrams the KV record and the discover response. ⚠️ `check-examples` is in neither CI, `npm test`, nor `test:doc`, so nothing else will run it — and this surface has already shipped one wrong instruction from this task's landed half.
- **`docs/vision/auth.md`'s gaps are closed.** ⚠️ **Stated STRUCTURALLY:** no `> **Today's code differs.**` blockquote describes behaviour this task builds. The file carries **eight**, so `grep -n '^> \*\*Today' docs/vision/auth.md` is triage, not a check. Known targets: § *Coarse-grained access control* (`:123`), § *The Registry* (`:268`), and § *Grants* (`:381`), whose *"the own-scope path … [is] unbuilt"* Phase 3 falsifies on the own-scope half. ⚠️ If the own-scope widening moves to [nebula-invite.md](nebula-invite.md) that deletion moves with it; if the derived-bit half stays unbuilt, § *Grants*' blockquote is **rewritten**, not deleted. ⚠️ **Blockquotes ONLY, re-read each before deleting** — auth.md is `accepted`, so shipping it asserting a difference that no longer exists is a conformance defect, not a docs nit.
- **`nebula-pre-alpha.md`'s Super-admin building block states the new claims shape.** Its row still gives `authScopePattern:'*'` and *"`matchAccess('*', …)` always true"* as the mechanism; both go. ⚠️ That file is the **living master**, read every session, so leaving it on the deleted model is the highest-traffic version of the unlearning cost this task exists to stop paying.
- **No active task file states dominion as pattern-coverage.** `grep -rn 'authScopePattern\|pattern-covers' tasks/*.md tasks/on-hold/*.md tasks/icebox/*.md` returns nothing (frozen `tasks/archive/` is exempt). ⚠️ **The glob must cover `on-hold/` and `icebox/`** — `nebula-collaborator-tiers.md` moved to `on-hold/` on 2026-08-09, so a bare `tasks/*.md` passes *because the file left the glob*. ⚠️ **Run the grep before sizing it**: on 2026-08-09 it hit **nine** files, five named nowhere here (`backlog.md`, `on-hold/mesh-active-callcontext-guard.md`, `on-hold/spike-r2-olap-latency.md`, `on-hold/nebula-dataplane-root-admin.md`, `icebox/think-nebula-integration.md`).

## Phases

**Four phases, ordered by dependency, not by risk.** ⚠️ **The Registry's borrowed-safety defect is NOT fixed here** — it belongs to [nebula-registry-route-guards.md](nebula-registry-route-guards.md), which lands after. Fixing it needs `hasPassage`, which needs the verdicts, which need the claim to carry the scope, so doing it earlier means writing it twice; and it is safe to wait, being not a live hole (§ *Objective*) with invites paused.

Each phase leaves the suite **no worse than the recorded baseline** — ⚠️ **not "green"**: the suite is RED today. Measure as a **delta** — same set passes, no NEW failure, no NEW skip. Baseline and the named tests live in [backlog.md](backlog.md) § *Testing & Quality*; do not restate the numbers here. A phase is done when its own criteria red against the pre-phase code and pass after. Every criterion is allocated except ✅ *No `isAdmin` survives*; 🔒 *A superuser is unchanged everywhere* spans Phases 1 and 3.

### Phase 1 — The claim carries the scope, and containment becomes a hierarchy predicate

The spine; every later phase reads `access.authScope`. **Atomic** — a half-renamed claim is a broken system, so one commit despite being the largest diff.

- The four symbol changes, per § *The target*'s table: `access.authScopePattern` → `access.authScope`; `buildAuthScopePattern` deleted (⚠️ keeping its `parseId` fail-closed job — § *Context and current state*); `matchAccess` → `isAtOrAbove` / `isAtOrBelow`, exported from `index.ts` and `testing.ts`; the reserved scope becomes `nebula-platform` verbatim.
- The three **structural** sites convert here, since they need a fact and not a verdict. ⚠️ **All three need the platform disjunct and none gains a `scopeAdmin` conjunction; each fails silently somewhere different — § *Platform, and the claims-shape blast radius*.**
- Every fixture on the old sentinel moves to `authScope: 'nebula-platform'` — size it with the grep in § *Platform, and the claims-shape blast radius*.

**Criteria:** 🔒 *Segment boundaries hold under colliding names* · *No `authScopePattern` survives* · the **verification and refresh limbs** of 🔒 *A superuser is unchanged everywhere*.

### Phase 2 — The two verdicts exist, and the mesh boundary calls them

- `hasDominionOver` gains the `isPlatformInstance` arm; `hasPassage` is new. Both shapes, argument order, and the fail-closed contract: § *The target*.
- `requirePassage` delegates to `hasPassage` instead of computing both arms inline; its tenant arm reads `authScope` instead of `aud`, which kills non-admin downward movement **by construction** (item 2 — no separate work).
- `nebula-do.ts`'s platform-name reject stays, its comment re-justified on masquerade prevention.

**Criteria:** *A non-admin reaches its own scope and nothing beneath it* · *An admin reaches downward, totally* · *Upward is nil for dominion* · 🔒 *The scope is still the bound* · *The tenant direction survives, without dominion* · *Platform means everywhere* · *A mesh call to a node NAMED `nebula-platform` is still refused* · *`aud` survives on the token and on the wire*.

### Phase 3 — The remaining callers, and nothing re-derives

- Convert every remaining hit from instrument 1, classified per § *The instruments that find every site*: the Profile scoped-admin branch and `myScopeTree` stop re-deriving the conjunction; the `'*'` literals become `isPlatformInstance`; `verify.ts`'s comment stops claiming a passage purpose; the six `pattern` locals take names for what they hold.
- ⚠️ **`star.ts` is RENAME-ONLY and MUST NOT become hierarchical.**
- 🌐 The `/live` scenario runs here, after all code lands — **including its superuser limb**, since the 19 `'*'` fixtures are being rewritten in the same work and are no backstop.

**Criteria:** 🔒 *Nothing re-derives either verdict* · 🔒 *The instruments are capable of failing* · 🔒 *No identifier still names the old model* · *Enumeration is unchanged for an admin* · the remaining limbs of 🔒 *A superuser is unchanged everywhere* (`myScopeTree`, and the Profile gate with **zero registry reads**) · 🌐 *The same, driven as a `/live` scenario*.

### Phase 4 — Standing guidance and published docs

Code is done; this is the unlearning-cost half. Every target, grep and trap is a criterion above — this phase is the sweep. Two things it owes that are not mechanical:

- **ADR-015** — its normative sentences were already restated off pattern vocabulary, and the rejected-alternative row already carries its retirement note (annotated, not deleted). ✅ **Measured remainder: one `> **Today's code differs.**` blockquote**, deleted when the code lands; re-run `grep -n 'authScopePattern\|pattern-covers' docs/adr/015-passage-and-dominion.md` rather than trusting that. ⚠️ Ratification is not part of this phase, or any phase.
- ✅ **`security.md`'s rule (2) is ALREADY NARROWED — "restate it in scope terms" is the pre-collapse plan and MUST NOT be carried out** (§ *Constraints*).

**Criteria:** *No standing-guidance statement forbids narrowing the tenant branch* · *No standing-guidance statement describes the pattern model* · 🔒 *No standing-guidance statement CITES A DELETED SYMBOL* · *`website/docs` teaches the new model* · *`docs/vision/auth.md`'s gaps are closed* · *`nebula-pre-alpha.md`'s Super-admin building block states the new claims shape* · *No active task file states dominion as pattern-coverage*.

## Non-goals

- 🔀 **The verdict RENAMES** (`requireAdmin`, `hasAdminOver*`, `enforceScopeReach`, the `accessAdmin` column) → [nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md), which lands FIRST and has already renamed them by the time this builds. Its gating is stated in its own banner and not restated here.
- 🔀 **The Registry route guards and the mint** → [nebula-registry-route-guards.md](nebula-registry-route-guards.md). This file gives it `hasPassage`; it gives the routes a caller.
- 🔀 **WHO may invite, and what bit an invite confers** → [nebula-invite.md](nebula-invite.md). This changes what a token derives from a membership, not how memberships are made.
- **Changing anything stored.** `Memberships`, the KV refresh record and the URL are already scope-shaped and stay exactly as they are.
- **Narrowing the export surface.** The replacement predicates are exported from both `index.ts` and `testing.ts`, as `hasDominionOver` is today — the Node harness re-exports it precisely so a test never re-inlines the `scopeAdmin` ∧ scope-at-or-above conjunction by hand.
- **The collaborator grant bundle** → [nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md).
- **A multi-invite-in-one-email flow** — the answer to the N-emails friction if it ever bites; years away.

## Relationships

- **Amends [ADR-015](../docs/adr/015-passage-and-dominion.md)** — commitment intact, mechanism replaced.
- **Soft-blocks** [nebula-invite.md](nebula-invite.md) — nothing in the invite mechanism depends on this, but that file's design intent and tier-coverage criterion are written in pattern vocabulary, so reviewing it first would anchor a panel on a model this deletes.
- **Already relied upon by** [nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md) — its open question 1 was closed on this file's basis (2026-08-05) and its over-reach section rewritten to depend on this landing, so shipping a different model reopens that file. It still carries the deleted vocabulary in at least three places, covered by the active-task-file criterion.
- **Touches** [nebula-profile-accepted-membership-gate.md](nebula-profile-accepted-membership-gate.md) at **two** sites in `#requireOwnerOrAdmin`, not one: `profile.ts:309`'s `scopes.some(s => matchAccess(pattern, s))` becomes the new predicate, and `profile.ts:274`'s `authScopePattern === '*'` super-admin short-circuit loses the literal it tests. The accepted-membership contract is unaffected, but that file's criterion is written over the deleted literal and must be re-worded over **behaviour** — *a platform admin passes with zero registry reads*.
- **Not related to the wipe.** Listed in [nebula-pre-alpha.md](nebula-pre-alpha.md) for sequencing only.
