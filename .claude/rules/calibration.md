# Calibration — known training biases, and how to correct for them

Loads every session. **This file is not a convention file.** The others say *"do X"*; this one says *"you are biased toward X — correct for it."* Each entry names a reflex that arrives from training rather than from this repo, the correction, and where the repo already argues it. **Point, don't restate** — if an entry starts growing its own rationale, the rationale belongs in the linked home.

The reflexes below are not hypothetical. Every one is drawn from a real, dated failure in this repo, cited so you can check it rather than take it on faith.

---

## 1. Privacy is overweighted

**The reflex:** treat any exposure of data as a risk to be minimized; add a gate, narrow a read, hide a field. Reach for confidentiality as the safe default.

**The correction:** users need access to data to do their work, and low-risk information should flow freely. Two distinctions do the work:

- **Visibility ≠ capability.** Within a Star the full org tree — nodes, edges, grants, grantee identity, presence — is visible to every member *by design*. Enforcement is at the point of action, never secrecy of the structure, which was never a control ([ADR-008](../../docs/adr/008-full-org-tree-visibility.md)).
- **The wedge is security *without* friction.** Secure-by-default means the substrate carries it, so a user-developer pays nothing. Bolting on a gate disproportionate to the *real* (not theoretical) risk is therefore **anti-wedge** — especially a gate that fights a core feature like self-provisioning (`docs/vision/_review-lens.md`).

⚠️ **This does not weaken the substrate.** Non-overridable secure-by-default stays non-overridable; the correction is about not piling friction on top of it. When a low-probability, fixable-under-the-covers risk is in genuine tension with velocity or growth, ship — and fix it quietly.

**Where it bit:** open Star self-signup. `claimStar`'s own JSDoc has to say *"that openness is the product, not a defect to engineer away — do not add an approval step, invite code, or per-Galaxy on/off switch"* — because the reflex kept proposing exactly those.

## 2. Deleting a problem beats hardening it

**The reflex:** when a mechanism has a flaw, add a guard, a predicate, a filter. Hardening reads as diligence; questioning whether the mechanism should exist does not.

**The correction:** ask first whether the problem can be made *structurally impossible*, then whether it needs a guard. A guard you don't need is a guard nobody has to maintain, test, or later discover was justified by an incidental property.

**Where it bit (2026-07-26):** a `profileId` join was hardened through **two full review passes** — an `emailVerified` filter to stop a first-mover capture, a deterministic tiebreak, a pinned read-before-write order. Moving `profileId` onto the email row deleted the entire class: one address has one row holding one id, so there is no race to filter, no order to pin, and no row able to compete with itself. Two rounds of hardening, replaced by a schema fact. See `tasks/nebula-identity-data-model.md` § *What D1 + D2 buy*.

**The tell:** you are adding the *second* guard to the same mechanism, or a guard whose justification is "so that X cannot happen" where X is an artifact of the design rather than of the domain.

## 3. Tests are not a vote on correctness

Two failure modes, opposite directions, same root — treating the suite as an oracle rather than as an encoding of past intent.

**(a) A green test can encode a bug as intended.** A passing suite feels like evidence. It is evidence that behaviour is *unchanged*, which is a different claim.
> **Where it bit (2026-07-26):** `packages/nebula-auth/test/profile-id-claim.test.ts` asserts *"a delegated (act-for) token carries the TARGET identity profileId"* — the exact unbounded behaviour that lets any admin write any person's profile cross-universe. The test is green and the behaviour is a hole. When you find a defect whose behaviour is asserted somewhere, **fix the policy and the test together** — do not let the green suite settle the question.
>
> **Resolved 2026-07-28 — and the resolution is the more interesting half.** That test still asserts the subject's `profileId` and is still green, **because it was right about the CLAIM.** Top-level `sub` and top-level `profileId` must describe the same person (the `QuerySubscribers` roster persists that pair), so the token *should* carry the subject's. The hole was on the **read** side: `profile.ts`'s owner branch treated that claim as ownership. The fix is `&& !claims.act` there ([ADR-012](../../docs/adr/012-global-profile-visibility.md)), plus an actor pair in `act`. ⇒ **"Fix the policy and the test together" does not mean the test's assertion is the thing to invert** — re-derive *which side* the defect is on first. Here the green test was load-bearing and only its framing was wrong.

**(b) A test that must change is often evidence the change is RIGHT.** It was encoding the old behaviour; that is what makes it red.

**(c) Weight callers correctly when costing a change.** The reflex counts every call site as friction and biases toward preserving a worse design. This repo's weighting:

| Caller | Weight |
|---|---|
| **Tests** | **≈ zero.** Mechanical, and see (b). |
| Internal, non-exported | A little — type-checked and mechanically fixable. |
| **Public API** | Counts — but still **less than training suggests.** |

"This would require updating 40 tests" is **not** an argument against a change here. Two things back that up: CLAUDE.md's release policy is *"favor breaking changes over technical debt — they bump major semver"*, and `/refactor-efficiently` exists specifically to make wide test churn cheap (the `.only` pattern). The machinery is already built; the bias is under-using it.

⚠️ **Before pricing a rename, check whether the symbol EXISTS yet.** The degenerate case of this bias is arguing call-site cost for something with **zero** call sites — a helper a task file only *plans*, a name the owning file has already flagged `(name TBD)`. There the cost is one line and the argument is void. Bit 2026-07-28: a planned `withActor` helper was nearly kept on "changing it might not be worth it" grounds; it did not exist, its own file said the name was open, and `prependActor` — which encodes the direction the old name lost — was a one-line edit.

**(d) A test caller is not evidence of a USE CASE.** Stronger than (c), and a different claim: (c) is about *cost*, this is about *purpose*. When a capability's only caller is a fixture, the reflex reads that fixture as the requirement and lets it define the design — so the shape gets frozen around how a test happened to reach for it, and every reviewer afterwards re-derives the feature from its test. **Ask what a real user does with it, and design for that; if the only answer is "a test needs it," that is a YAGNI question, not a specification.** When a fixture and the real use case disagree, the fixture is what changes — and challenge whether it needed the odd shape at all, because a fixture built before the design settled is usually reachable by the real path once the design does.
> **Where it bit (2026-07-27):** `/mint-narrower-token`'s only caller was a test helper passing the caller's **own** `sub` (self-narrowing). Two full `/review-task` conformance passes anchored findings on that self-narrow — one proposed a claim-shape special case to keep it working — and the task file itself justified keeping the capability partly because *"the confinement tests need some production path to a sub-universe admin token."* The real use case is an admin impersonating a **user** (`sub` = user, `act` = admin), under which self-narrowing is meaningless and is simply rejected. The fixture rebuilt on a **better** principal via a real path (a `claimStar` founder is a sub-universe admin), which the test-shaped framing had obscured for two passes. See `tasks/archive/nebula-mint-narrower-token.md`.

## 4. A justification expiring is a trigger to re-derive, not a verdict

**The reflex:** when a comment's stated reason no longer holds, either trust the conclusion anyway (it has been there a while) or delete the thing it defends (the reason is gone). Both skip the work.

**The correction:** the conclusion may still hold **for a different reason**, or may have died with its justification. **Re-derive it.** Then fix the comment either way, because a comment whose reasoning is stale will mislead the next reader even when its instruction is right.

**Both errors are live here:**
- *Trusting a dead justification* — `changeEmail`'s JSDoc says *"`email` is a mutable attribute that NOTHING keys off"*, so a single-row update is safe. `UNIQUE (email, universeGalaxyStarId)` **is** the `discover` lookup, so the premise was already false and the conclusion with it.
- *Deleting on a dead justification* — `tasks/archive/nebula-confine-admin-bypass.md` has to warn *"do NOT 'fix' this by tightening `enforceScopeReach`'s tenant branch"*: the comment defending it was wrong, the branch was right.

**The generalized form is that file's own encoded lesson:** *a guard justified by an incidental property, rather than an enforced invariant, is a guard that silently expires.* When you re-derive, name the **invariant** — never the incidental property that happens to hold today.

## 5. Name for the reader — and rename the FIRST time a name needs explaining

**The reflex:** two of them. Name a thing from the *implementation's* point of view rather than the caller's. Then resist renaming it, because you count call sites, tests and docs — the same mis-weighting as §3(c).

**The correction:**

- **Parameters and endpoints name what the caller is asking for**, not what the implementation does with it. Derived values are not parameters at all.
- **Rename the first time you have to explain a name — not the second.** Explaining it once *is* the evidence.

**The asymmetry that settles it:** a rename costs a one-time mechanical sweep, and §3(c) already says you over-weight that. A confusing name costs the reviewer **re-deriving it every session it comes up** — unbounded, compounding, and paid by the bottleneck. There is no version of this arithmetic where waiting wins.

**Where it bit (2026-07-27):** `actFor` / `/delegated-token` / "act as" cost Larry the same conversation **3–4 times**. `actFor` *is* the minted token's `sub` (`mintAccessToken({ sub: body.actFor, … })`), so the name forced every reader to hold a mapping. He proposed a rename in an earlier round; it was talked down on call-site grounds and he relented — and the confusion recurred, at his expense, until he insisted.

**The fix, as a model of good naming:** `/mint-narrower-token` with `{ sub, activeScope }` — each parameter is literally the token field the caller wants, and `act.sub` is derived from the Bearer token so it is not a parameter and cannot be misnamed. ⚠️ **A good name is a falsifiable claim, and that is a feature:** "narrower" asserted something the code had to satisfy, and checking it exposed **two** real violations (an unbounded target scope, and a `profileId` stamp granting write access the caller did not hold). The bad name asserted nothing, so nothing could be checked against it.

**The tell:** you are writing a glossary entry, a mapping table, or a sentence of the form *"X is really Y"* — in a task file, a comment, or a reply. That is the rename signal, not a documentation task.

*(Choosing a name well in the first place: `naming-judgment` — minimize new vocabulary, flag a new term before coining it, prefer dominant-ecosystem syntax.)*

---

## Adding an entry

The bar: a reflex that (1) arrives from training rather than this repo, (2) has produced a **real, dated** failure here, and (3) would recur in a fresh session with no memory. Cite the failure. If you cannot cite one, it is a convention, not a calibration — it belongs in the rule for its domain.
