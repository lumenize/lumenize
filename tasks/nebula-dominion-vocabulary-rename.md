# The dominion vocabulary, renamed — no behaviour changes

**Status:** Active child, **first of four** in the passage/dominion sequence — ahead of [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md), [nebula-registry-route-guards.md](nebula-registry-route-guards.md) and [nebula-invite.md](nebula-invite.md). Carved out of the first of those on 2026-08-11 (§ *Why this is its own file*). Not built.

> 📐 **`/write-task` Pass 2 — design intent and phases are both written.** The content is carved from a file that had Stage 1 (×2) and Stage 2 resolved, so the *decisions* below are reviewed; the **shape of this file is new** and has had no panel. From here: `/review-task`, then `/build-task`.

> 🪟 **WIPE-WINDOW-GATED — and it is the ONLY one of the four that is.** Phase 2 renames a stored column, which is nearly free before the pre-alpha wipe and a two-mechanism migration after ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *The wipe is a CLOSING WINDOW for free schema surgery*). Every other file in this sequence is code-only. ⚠️ **That is the reason this one goes first**, not its size.

**Objective — every identifier that names dominion says `dominion`, and nothing else changes.** No behaviour moves, no claim changes shape, no predicate gains or loses an argument. A reviewer should be able to check this file's diff by reading names, and a type-check should catch everything except the stored column and the prose.

## Why this is its own file

**Because "renames are free" is exactly the belief that hides them inside a bigger diff.** The three files after this one each change real behaviour — a claim's shape, a route's guard, a mint's authorization. Renames landing in those diffs are indistinguishable from the behaviour changes at review time, and this repo has the receipt: the `isAdmin` → `scopeAdmin` sweep touched **66 files**, and two packages (`packages/auth`, `packages/mesh`) keep their own unrelated `isAdmin` that a repo-wide replace would have broken — **the mesh one silently**.

Splitting it out buys three things:

- **The reviewable property is stated and checkable:** nothing here changes what any code *does*. A diff hunk that changes control flow is a defect in this file, by definition.
- **The wipe gate collapses onto one small file.** The other three stop being wipe-gated at all.
- **It settles the vocabulary before anything designs against it.** [nebula-invite.md](nebula-invite.md) currently parks a naming decision — its wire field is `invitees[].isAdmin` while the column is `Memberships.scopeAdmin` — on the grounds that *"deciding it here would be designing this endpoint from another task's cleanup."* After this file the cleanup has landed and that decision costs one line.

## Context and current state

`isAdmin` → `scopeAdmin` already shipped 2026-08-07 (at rest and in flight, 66 files, type-check green). This file finishes the same job for the *verdict* names, which lagged.

The vocabulary itself is settled: **`dominion`** and **`passage`** are reserved terms defined in [ADR-015](../docs/adr/015-passage-and-dominion.md) § *Terminology*. They replaced `authority` and `admission` on 2026-08-09 because both general words carried four meanings apiece and the ambiguity had shipped real bugs. ⚠️ **`reach` is not their umbrella noun** — it stays a verb, and MUST NOT be used as a noun for either verdict.

**Missing:** the guards and helpers are still named for the **bit** or for the **deleted general word**, while the predicate they delegate to is about to be named for the **verdict**. That gap is the translation the reader carries, and this layer is where a carried translation becomes a security hole.

## Design intent, constraints, and future state

### The three tiers govern which name a symbol gets

A **structural fact** gets a literal name · a **verdict** gets a reserved word · **data** keeps its field name. That is the rule; this file applies it only where doing so changes no behaviour.

| Today | Becomes | Tier | Why it is behaviour-neutral |
|---|---|---|---|
| `hasAdminOverScope(access, node)` | `hasDominionOver(access, node)` | verdict | already the shared predicate; only the name moves. ⚠️ The `isPlatformInstance` arm it eventually gains is **NOT part of this file** — today `buildAuthScopePattern('nebula-platform')` yields `'*'` and `matchAccess('*', …)` is true, so platform works for free and adding the arm now would be dead code |
| `requireAdmin` (58 uses) | `requireDominion` | verdict | ⚠️ **it is the dominion guard wearing the bit's name** — "require admin" is one reading away from *the bare bit is dominion*, the bug that has shipped twice. It already delegates |
| `hasAdminOverUniverse` / `hasAdminOverGalaxy` | `hasDominionOverUniverse` / `…Galaxy` | verdict | registry helpers; they delegate already, only the names lag |
| `enforceScopeReach(name, claims)` | `requirePassage(name, claims)` | verdict | ✅ **a pure rename TODAY, which is not obvious.** It is already the only place both arms appear together, so it already *computes* passage — the name simply becomes honest about what the body does. Its tenant arm's **input** changes in the next file; nothing about it changes here. ⚠️ **`require`, not `enforce` (decided with Larry 2026-08-11).** `enforce` was a **one-member category** whose verb implied a distinction it never carried: it throws exactly as `requireDominion` and `requirePermission` do. `require` is both the repo's incumbent (59 sites) and the dominant-ecosystem spelling for *throws* (Solidity `require`, `assert`). ⇒ **`enforce*` disappears from the repo**, and `require*` means **throws**, everywhere |
| `Subscribers.accessAdmin` (35 uses, **a column**) | `dominionAtSubscribe` | verdict | a **frozen** dominion verdict, named for the claim field it is not. The `AtSubscribe` half is load-bearing: it is confined at subscribe time and never re-read live |

⚠️ **Three things look like they belong here and MUST NOT be taken.** Each would smuggle a behaviour change into a file whose whole claim is that it has none:

- **`matchAccess` → `isAtOrAbove` / `isAtOrBelow` is NOT a rename.** A glob matcher becomes a hierarchy predicate — different grammar, different answers on colliding segment names. It belongs to [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md).
- **The six `const pattern = …` locals are correctly named TODAY.** They hold `claims.access.authScopePattern`, which *is* a pattern. They only become misnamed once the claim carries a scope, so renaming them here would make them wrong for the duration of two files.
- **`hasPassage` cannot be born here.** It is `isAtOrBelow ∨ dominion`, and `isAtOrBelow` does not exist yet. ✅ **This file makes its absence VISIBLE rather than fixing it** — after the rename, `requirePassage` is a function computing passage inline that nothing else can call, which is the next file's finding stated in one name.

### Constraints

- **[ADR-015](../docs/adr/015-passage-and-dominion.md)** — the definition home for both reserved terms. This file does not amend it and does not exercise it; it adopts its vocabulary. ⚠️ **Ratification is Larry's ad-hoc call and is gated on nothing** — no phase here owns it, and none may.
- **[ADR-007](../docs/adr/007-shared-comms-guards-core.md)** — one predicate expresses the model. This file does not add or remove a caller; it renames the one that exists.
- ⚠️ **Vocabulary: this file MUST NOT use "reach" as a noun.** Three terms, one meaning each — `isAtOrBelow` is the upward structural relation, `dominion` the downward verdict, `passage` the boundary verdict (**the union of both, never the upward arm alone**).
- ⚠️ **`packages/auth` and `packages/mesh` are OUT OF SCOPE and MUST NOT be swept.** They keep their own `isAdmin` — a *different* bit (auth's `Subjects` column, and a flat top-level claim mesh mints for auth's gate). A repo-wide replace breaks both, **the mesh one silently**. This is not hypothetical; it is why the 2026-08-07 sweep was scoped by hand.
- ⚠️ **The Data-plane's `admin` permission is NOT renamed.** It is one of a symmetric triple (`CHECK(permission IN ('admin','write','read'))`), so renaming it drags `resourceWrite` and `resourceRead` along for no gain. This file renames the **Registry-scope** bit's verdicts only.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **The renames land in their own file, first** | Folding them into the behaviour changes — a rename inside a diff that also moves control flow is unreviewable as a rename, and this is 58 + 35 call sites of noise laid over the changes that must not be gotten wrong. |
| **`enforceScopeReach` → `requirePassage` lands HERE**, though its input changes later | Holding it until the input changes — the body already computes passage across both arms, so the new name is true on arrival, and holding it means the next file's diff carries a rename on its most load-bearing function. |
| **`require*` means THROWS, repo-wide; a step that RETURNS a `Response` is `*Guard`** | Keeping `enforce` vs `require` as the carrier — it points the wrong way (`require` throws in Solidity and in `assert`, and in 59 of this repo's own sites) and would rename all 59 to `enforce*` to say what `require*` already says. The route steps in [nebula-registry-route-guards.md](nebula-registry-route-guards.md) take `*Guard` instead; that file's § *The shape* carries the table, because a route step named `require…` returns a **500** where a 403 belongs. |
| **`hasDominionOver` does NOT gain the platform arm here** | Adding it now "while we are in the file" — with `'*'` still the value, `isPlatformInstance` would be unreachable dead code inside a security predicate, which § *Decisions* of the next file rejects for the same reason it rejects a dead conjunction operand. |
| **The stored column is renamed with a NUMBERED migration, never a collapsed baseline** | Renumbering or rebaselining — local and test storage have applied the old list, and a list starting below their high-water mark matches nothing, writes nothing and **throws nothing**. |

## Acceptance criteria

- 🔒 **No identifier still names the old model.** `grep -rnE '\b(requireAdmin|accessAdmin|hasAdminOver|enforceScopeReach)\b' packages/nebula-auth/src apps/nebula/src` returns nothing. ✅ **Executed 2026-08-11 and returns 105 hits**, so this criterion is capable of failing rather than green-by-construction. ⚠️ **Not 151** — that is the figure for the *wider* grep in [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md), which also covers `matchAccess` and `buildAuthScopePattern`; those two are that file's, not this one's, and quoting its number here would have made this criterion look verified against a command nobody ran.
- 🔒 **Nothing changed behaviour.** The full suite passes with **no test edited except for the renamed symbols themselves** — no assertion's expected *value* changes, no test is added, none is deleted. *Reds against a behaviour change smuggled into the sweep.* ⚠️ **This is the criterion the file exists for**, and it is the one a reviewer can check by reading the diff's shape rather than its content.
- 🔒 **The two sibling packages are untouched.** `git diff --name-only` includes no path under `packages/auth/` or `packages/mesh/`. *Reds against a repo-wide replace — which breaks mesh's unrelated `isAdmin` silently, the failure mode that has no test.*
- 🔒 **The column rename reaches existing storage, on both tables.** After the rename, a DO whose storage predates it reads and writes `dominionAtSubscribe` without error on **both** `Subscribers` and `QuerySubscribers`. *Reds against an inline-DDL edit that only reaches freshly-created tables — a schema change that announces nothing on storage it never touched.*
- **The data-plane permission tier is untouched.** `grep -rn "'admin'" apps/nebula/src` still finds the `CHECK(permission IN …)` triple and its readers. *Reds against a sweep that translates the wrong `admin`.*
- **No standing-guidance statement cites a symbol this file deletes.** `grep -rn 'hasAdminOverScope\|enforceScopeReach\|requireAdmin\|accessAdmin' docs .claude tasks website/docs` — every hit gets a verdict. ⚠️ **Guidance citing a deleted symbol is worse than guidance citing a deleted model**: the reader greps, finds nothing, and cannot tell whether the rule is stale or they are looking in the wrong place. Known homes: `durable-objects.md` and `workflow.md` both name `hasAdminOverScope`; ADR-015's Evidence line opens with it. ⚠️ **"Standing guidance" is the CLAUDE.md list** — it includes `.claude/skills/*/SKILL.md` and **agent memory**, neither reachable by that grep, and memory is the worst of them: it loads every session unprompted and nothing type-checks it.

## Phases

Two phases. Each leaves the suite green.

### Phase 1 — The verdict names, in code

`hasAdminOverScope` → `hasDominionOver` · `requireAdmin` → `requireDominion` · `hasAdminOver{Universe,Galaxy}` → `hasDominionOver{…}` · `enforceScopeReach` → `requirePassage`. Exported from `index.ts` and `testing.ts` exactly as before — ⚠️ **the export surface does not narrow**; `testing.ts` re-exports the predicate precisely so a test never re-inlines the `scopeAdmin ∧ scope-at-or-above` conjunction by hand.

⚠️ **Use an LSP / `ts-morph` rename, then verify with a BARE-identifier grep** (`workflow.md` § *Symbol renames*). A quoted-literal replace silently misses member/type-position access (`x.Old`, `rels.Old.field`) and doc comments, which survive, compile, and surface as a runtime failure — that exact defect bit the `Turn` → `Message` rename **twice**.

**Criteria:** 🔒 *No identifier still names the old model* · 🔒 *Nothing changed behaviour* · 🔒 *The two sibling packages are untouched* · *The data-plane permission tier is untouched*.

### Phase 2 — The stored column, on both tables

**`accessAdmin` → `dominionAtSubscribe` — THREE DDL sites across TWO tables, and they need DIFFERENT mechanisms.** ⚠️ **Audited 2026-08-11 because "one stored column" was wrong.**

- **`Subscribers`** (`subscriptions.ts`) has a real migration list — the column arrived as `idMonotonicInc: 2`. The rename is a **new numbered entry** (`ALTER TABLE … RENAME COLUMN`), never a renumbered or collapsed baseline: local and test storage have applied the old list, and a list starting below their high-water mark matches nothing, writes nothing and **throws nothing** (`durable-objects.md` § *Initialization*).
- 🚨 **`QuerySubscribers`** (`query-subscriptions.ts`) carries the column **inline in a `CREATE TABLE IF NOT EXISTS`, and has NO migration list at all** — zero `idMonotonicInc` in the file. **Editing that DDL is a silent no-op on every table that already exists.** The code would then `SELECT dominionAtSubscribe` from a table still holding `accessAdmin` — a runtime failure on the read path, on storage that never announced it was stale. Same class as the high-water-mark trap, wearing different clothes: a schema edit that reaches only fresh storage.
- **⇒ Give `QuerySubscribers` a migration list** — the honest fix, and it owes one regardless. ⚠️ **The alternative, scoping the rename to land inside the wipe window, MUST NOT be taken silently**: it makes the rename depend on a wipe that has not happened, which is the kind of unstated precondition that breaks a local dev environment and reads as a code bug.
- ⏳ **Delete the task-file handle shipped in source**: [subscriptions.ts](../apps/nebula/src/subscriptions.ts)'s migration description reads `add accessAdmin column (D16)`, and `workflow.md` forbids a task-file handle in code — it is unresolvable the moment that file archives. This rename touches the line anyway.

**Criteria:** 🔒 *The column rename reaches existing storage, on both tables* · 🔒 *Nothing changed behaviour* · *No standing-guidance statement cites a symbol this file deletes*.

## Non-goals

- **Anything that changes an answer.** The claim's shape, the containment grammar, `hasPassage`, the platform disjunct, the route guards, the mint → the three files after this one.
- **Narrowing the export surface.** Same symbols, same modules, new names.
- **`packages/auth` and `packages/mesh`.** Their `isAdmin` is a different bit.
- **The data-plane `admin` permission.** A symmetric triple; renaming one member drags the other two.

## Relationships

- **Blocks** [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md) — that file changes what `requirePassage`'s tenant arm reads and what `hasDominionOver`'s second operand means, so it wants the names already settled.
- **Unblocks a parked decision in** [nebula-invite.md](nebula-invite.md) — its wire-field naming question (`invitees[].isAdmin` vs the `scopeAdmin` column) becomes a one-line consequence once the vocabulary is uniform.
- **Carries the wipe gate for all four files** — see [nebula-pre-alpha.md](nebula-pre-alpha.md) § *The wipe is a CLOSING WINDOW for free schema surgery*.
