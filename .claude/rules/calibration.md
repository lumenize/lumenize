# Calibration — known training biases, and how to correct for them

Loads every session. **This file is not a convention file.** The others say *"do X"*; this one says *"you are biased toward X — correct for it."*

Each entry names a habit that arrives from training rather than from this repo, says what to do instead, and points at where the repo already argues it. Point at the argument rather than repeating it — an entry that grows its own rationale should hand that rationale to the file it links.

None of these is hypothetical. Every one is drawn from a real, dated failure here, cited so you can check it rather than take it on faith.

---

## 1. Privacy is overweighted

**What you'll do:** treat any exposure of data as a risk to minimize — add a gate, narrow a read, hide a field — and reach for confidentiality as the safe default.

**What to do instead:** users need access to data to do their work, and low-risk information should flow freely. Two of the three corrections are already on your screen, in `workflow.md`'s always-loaded ADR index: [ADR-008](../../docs/adr/008-full-org-tree-visibility.md)'s *visibility ≠ capability*, and [ADR-017](../../docs/adr/017-the-url-is-the-view-state.md)'s test — *does it reveal anything **not already public**?*, never *does it reveal anything?* Read them there. The third loads nowhere else:

- **The wedge is security *without* friction.** Secure-by-default means the substrate carries it, so a user-developer pays nothing. A gate disproportionate to the *real* (not theoretical) risk therefore works against the wedge — especially one fighting a core feature like self-provisioning. `docs/vision/_review-lens.md` argues it, and does not load automatically.

⚠️ **This does not weaken the substrate.** Non-overridable secure-by-default stays non-overridable; the correction is about not piling friction on top. Where a low-probability, fixable-under-the-covers risk is in genuine tension with velocity or growth, ship — and fix it quietly.

**Where it bit:** open Star self-signup. `claimStar`'s own JSDoc has to say *"that openness is the product, not a defect to engineer away — do not add an approval step, invite code, or per-Galaxy on/off switch"* — because the habit kept proposing exactly those.

**Where it bit again (2026-07-29), and this one is about the TRIGGER, not the correction.** Drafting ADR-017, a clause was written making its own URL-shareability principle *yield* wherever a view is addressed by a `profileId` — friction invented against a surface [ADR-012](../../docs/adr/012-global-profile-visibility.md) had deliberately opened, to protect a display name. This file was in context and had been cited two turns earlier, so re-reading the correction was not what stopped it, because it did not stop it: the word *unguessable* fired first, before anyone asked what holding the value actually gets you. ⇒ **"opaque" / "random" / "unguessable" is the trigger phrase.** The moment you write one, you owe the what-does-it-reach check before any gate. ADR-012's own § *Decision* records the same incident from the other side, and names this entry as where it is filed.

## 2. Deleting a problem beats hardening it

**What you'll do:** when a mechanism has a flaw, add a guard, a predicate, a filter. Hardening reads as diligence; questioning whether the mechanism should exist does not.

**What to do instead:** ask first whether the problem can be made *structurally impossible*, and only then whether it needs a guard. A guard you don't need is a guard nobody has to maintain, test, or later discover was justified by something incidental.

**Where it bit (2026-07-26):** a `profileId` join was hardened through **two full review passes** — an `emailVerified` filter to stop a first-mover capture, a deterministic tiebreak, a pinned read-before-write order. Moving `profileId` onto the email row deleted the entire class: one address has one row holding one id, so there is no race to filter, no order to pin, and no row able to compete with itself. Two rounds of hardening, replaced by a schema fact. See `tasks/archive/nebula-identity-data-model.md` § *What D1 + D2 buy*.

**How to catch yourself:** you are adding the *second* guard to the same mechanism, or a guard whose justification is "so that X cannot happen" where X is an artifact of the design rather than of the domain.

**Knowing that does not fire it — a SCOPE-WIDENING QUESTION does. (2026-07-30.)** `NebulaEmailSender` stamped its routing header through a per-message-type hook, and covered magic-link but not invite, so invite mail went untagged and `waitForEmail({ instance })` died on a 60s timeout. The fix added the *second* per-type override — literally the smell above — with a JSDoc paragraph reasoning about why a *third* type didn't need one. What broke it open was Larry asking **"why not also X? are there others? can the base class do it?"**: the enumeration was the bug, and the header is a property of the *URL*, not of the mail. Collapsing five hooks to one and deriving the tag from whatever URL the message carries deleted the class — `invite-existing` needs no decision, and a future type is covered without touching the file. ⇒ Treat **"which other cases need this same treatment?"** as the trigger to re-derive; if the honest answer is a per-case table, you are enumerating where you should be deriving. Writing a comment that justifies a case you are **not** handling is the same smell as the second guard.
>
> **Superseded 2026-07-31, and the correction goes FURTHER in the same direction — this is not a reversal.** URL-derivation was still an inference, and it inherited a smaller version of the same defect: it could only tag mail whose URL happened to carry an instance segment, so a message that *is* about an instance but links to `/app` shipped untagged though its instance was known (`invite-existing` is exactly that). The sender is now **told**: `EmailMessage.instanceName` is required on every variant and `headers()` stamps it directly (`tasks/archive/nebula-auth-decouple-from-auth.md`). Totality is enforced by the **compiler** rather than by a property of the input — a send site that forgets does not compile. ⇒ After you stop enumerating, ask **what the derivation itself still cannot see**. Deriving from an incidental property of the input beats a per-case table, and being handed the value beats both.

## 3. Tests are not a vote on correctness

Four failure modes, same root — treating the suite as an oracle rather than as an encoding of past intent.

**(a) A green test can encode a bug as intended.** A passing suite is evidence that behaviour is *unchanged*, which is a different claim. When you find a defect whose behaviour is asserted somewhere, fix the policy and the test together — do not let the green suite settle the question.

⚠️ **But "together" does not mean inverting the test's assertion — re-derive which SIDE the defect is on first.** `packages/nebula-auth/test/profile-id-claim.test.ts` asserts that a delegated token carries the target's `profileId`, and looked like the bug. It was right: `sub` and top-level `profileId` must describe the same person. The hole was on the **read** side, where `profile.ts`'s owner branch treated that claim as ownership — fixed with `&& !claims.act` ([ADR-012](../../docs/adr/012-global-profile-visibility.md)). The test is still green and still correct. (2026-07-26, resolved 2026-07-28.)

**(b) A test that must change is often evidence the change is RIGHT.** It was encoding the old behaviour; that is what makes it red.

**(c) Weight callers correctly when costing a change.** You will count every call site as friction, which biases toward preserving a worse design.

| Caller | Weight |
|---|---|
| **Tests** | **≈ zero.** Mechanical, and see (b). |
| Internal, non-exported | A little — type-checked and mechanically fixable. |
| **Public API** | Counts — but still **less than training suggests.** |

"This would require updating 40 tests" is **not** an argument against a change here: CLAUDE.md's release policy favours breaking changes over technical debt, and `/refactor-efficiently` exists to make wide test churn cheap. And before pricing a rename, check the symbol **exists** — a planned `withActor` was nearly kept on call-site grounds with zero call sites (2026-07-28, `tasks/archive/nebula-mint-narrower-token.md`).

**(d) A test caller is not evidence of a USE CASE.** When a capability's only caller is a fixture, you will read that fixture as the requirement and let it define the design. **Ask what a real user does with it; if the only answer is "a test needs it," that is a YAGNI question, not a specification.** When a fixture and the real use case disagree, the fixture is what changes — and challenge whether it needed the odd shape at all. (2026-07-27: `/mint-narrower-token`'s only caller self-narrowed, and two `/review-task` passes anchored findings on it before anyone asked what an admin actually does with the endpoint. Same archive.)

## 4. A justification expiring is a trigger to re-derive, not a verdict

**What you'll do:** when a comment's stated reason no longer holds, either trust the conclusion anyway (it has been there a while) or delete the thing it defends (the reason is gone). Both skip the work.

**What to do instead:** the conclusion may still hold **for a different reason**, or may have died with its justification. **Re-derive it.** Then fix the comment either way, because stale reasoning misleads the next reader even when the instruction is right.

**Both errors are live here:**
- *Trusting a dead justification — and here re-deriving FLIPPED the verdict.* In July `changeEmail`'s JSDoc argued a single-row update was safe because nothing keyed off the address. That was false then: the address itself carried the `discover` uniqueness constraint. It is **true now** — [ADR-013](../../docs/adr/013-identity-profileid-resolution.md)'s `Emails`+`Memberships` split moved the key to `emailId` (`packages/nebula-auth/src/schemas.ts`), so nothing FKs on an address, and the method's current JSDoc states that accurately. Check the claim against today's schema before you either trust the comment or correct it.
- *Deleting on a dead justification* — `tasks/archive/nebula-confine-admin-bypass.md` (frozen, so this quotation is stable) warns *"do NOT 'fix' this by tightening `enforceScopeReach`'s tenant branch"* (today `requirePassage`): the comment defending the branch was wrong, the branch was right.

**Name the INVARIANT, never the incidental property that happens to hold today.** A guard justified by an incidental property is a guard that silently expires — which is why the first bullet needed a schema change rather than a better comment.

## 5. Name for the reader — and rename the FIRST time a name needs explaining

**What you'll do:** name something from the *implementation's* point of view rather than the caller's, then resist renaming it because you are counting call sites.

**What to do instead:**

- **Parameters and endpoints name what the caller is asking for**, not what the implementation does with it. Derived values are not parameters at all.
- **Rename the first time you have to explain a name — not the second.** Explaining it once *is* the evidence.

**Why waiting never wins:** a rename costs a one-time mechanical sweep, and §3(c) already says you over-weight that. A confusing name costs the reviewer **re-deriving it every session it comes up** — unbounded, compounding, and paid by the bottleneck.

**Where it bit (2026-07-27):** `actFor` *was* the minted token's `sub`, so every reader had to hold a mapping. Larry proposed the rename, it was talked down on call-site grounds, and the same conversation recurred at his expense until he insisted (`tasks/archive/nebula-mint-narrower-token.md`).

**A good name is a falsifiable claim, and that is the point.** Its replacement — `/mint-narrower-token` with `{ sub, activeScope }` — names the token fields the caller actually wants, and `act.sub` is derived from the Bearer token so it cannot be misnamed at all. Because "narrower" asserted something the code had to satisfy, checking it exposed two real violations. The old name asserted nothing, so nothing could be checked against it.

**How to catch yourself:** you are writing a glossary entry, a mapping table, or a sentence of the form *"X is really Y"* — in a task file, a comment, or a reply. That is the rename signal, not a documentation task.

*(Choosing a name in the first place: `naming-judgment` — minimize new vocabulary, flag a new term before coining it, prefer dominant-ecosystem syntax.)*

## 6. You will argue for the CHEAPER test tier, and call it calibration

**What you'll do:** prefer the fast, isolated, in-CI tier, and frame the preference as engineering judgment ("calibrate — don't reach for `/live` for a one-liner") rather than as the cost-avoidance it is.

**What to do instead:** `live.md` § *`/live` is the DEFAULT tier* carries the argument, the measurements, and how to write a scenario that can fail. None of it needs repeating here. What that file cannot do is catch you writing the rationalization, because that happens in a recommendation drafted before any test exists.

**Where it bit (2026-07-30, `nebula-impersonation-client`):** the recommendation was `/live` "as an exception, not a default", written into a section headed *What I'd resist* — while the same session had produced seven pool-workers tests that could not fail and one `/live` scenario with none. Larry overrode it, and overrode the same preference an hour earlier. Both overrides were right. ⇒ When you catch yourself writing **"worth it, but not as a default"**, check whether the argument is about evidence or about your own convenience.

## 7. Agreeing with a conclusion is what stops you checking its premises

**What you'll do:** review a decision by evaluating its *verdict*. When the verdict is right, move on. The supporting clauses ride along unexamined — they are not what you were assessing.

**What to do instead:** **a correct conclusion is the condition under which a false premise survives**, so agreement is the trigger to check the argument, not the licence to skip it. A wrong conclusion gets argued with, and its premises get dragged into the light by the argument. A right one never does. Distinct from §4, which is about a justification that *was* true and expired; these were **never** true and were never checked.

**Where it bit — twice in one file, both surviving `/review-task` Stage 1 (×2), Stage 2, and a `/build-task` verifier panel (2026-07-30, `nebula-impersonation-client`):**

| Conclusion (correct, agreed) | Premise (false, unchecked) |
|---|---|
| Drop the client-side TTL warn | *"the client cannot import the constant"* — `apps/nebula/src/frontend/types.ts` already imports from `@lumenize/mesh/client`, so the module is reachable from the client graph and a `./types` export is one line |
| Write a `/live` expiry scenario | *"pool-workers cannot let time pass"* — `vi.setSystemTime` moves the clock **both** the Worker and the DO see, measured |

Both conclusions still stand on their *other* reason, which is precisely why nobody looked — and challenging the second premise produced the in-lane expiry test everyone had believed impossible (`apps/nebula/test/test-apps/baseline/impersonate-lifetime.test.ts` § *survives a GENUINE expiry*).

**How to catch yourself:** you are writing a *supporting* clause — the sentence after "because", the parenthetical that heads off an objection — for a decision you have already made. Especially one asserting that something **can't** be done, since §3's cost-weighting and this entry both push you to accept it cheaply. Ask of that clause alone: *if the conclusion were wrong, would I still believe this?*

## 8. A maturity label is not a measurement

**What you'll do:** read "preview" / "alpha" / "not suitable for production use" as a decision input, and recommend the mature incumbent.

**What to do instead:** that label is the vendor telling teams **with users** not to break them. Ask what breaks for **us**, and price it with `workflow.md` § *Evaluating alternatives* — which usually comes out the other way, since the incumbent is what will need unlearning. Discount the label only, never a measurement: perf on a path we depend on, local-vs-prod fidelity, import-time startup cost, a transitive dep fighting an ADR. **Measurements survive an override and labels do not** — on 2026-08-03 the `@cloudflare/computer` recommendation was overridden on its label while its FUSE-throughput objections stood untouched (`tasks/nebula-galaxy-collapse-and-chat.md`).

⚠️ **The licence EXPIRES, and this is the half no instinct covers.** "Adopt early" is right *because we have nobody to break*, not because new is better. Larry pushes this direction naturally — which is why the entry carries almost no evidence, and why the flip is the actual risk: when Nebula has paying users the answer changes while the instinct does not. Per §4 that is a trigger to **re-derive**, never to invert on sight.

## 9. You will spend prevention on the LOUDEST failure, not the QUIETEST one

**What you'll do:** after a build, propose guard rails for whatever just hurt. Recency reads as importance, and a defect that cost an hour of thrashing *feels* like the one to prevent — so the post-mortem optimises what already announced itself.

**What to do instead: prevention is for failures with no signal WHERE ANYONE IS ACTUALLY LOOKING. Let loud ones stay loud.** A hang, a parse error, a 404, a type error, a red suite are all self-reporting and cheap to diagnose; none is worth machinery. What needs it is anything that leaves everything **green** — a criterion that cannot fail, a fixture built in the safe shape, a test tier silently skipped, a stale quotation in always-loaded prose, an `it.skip` encoding a design since reversed — and equally, anything that would be loud but fires only where nobody runs it: a deploy-only path, a `ctx.abort()` miniflare cannot reproduce, a branch reachable only with credentials CI lacks. Larry, 2026-08-04: *"You usually figure things like this out pretty quickly and they make themselves known so I really don't worry about preventing them. It's things that don't make themselves known until I push … that concern me much more."*

This licenses no indifference to loud failures — only to *pre-empting* them. Fix the hang; just don't build a framework so the next hang cannot happen.

**Where it bit (2026-08-04, the identity-split build):** the noisiest bug was a leaked `waitForEmail` waiter that hung the process after printing a green verdict, diagnosed and fixed in minutes — and the post-mortem proposed making it structurally impossible. Meanwhile the build had shipped **zero `/live` scenarios** behind a green 262-test suite, unnoticed until Larry asked why the tier kept being skipped.

**How to catch yourself:** you are proposing a guard rail for something you personally debugged this session. Ask what its signal was. If the answer is "it broke immediately and I saw it", that is evidence *against* the guard rail — and worth asking what ELSE this build changed would have stayed green if it were wrong.

## 10. You will open a paragraph with a sweep, and be accurate only underneath it

**What you'll do:** lead with a confident topic sentence, then follow it with the precise statement. The opener reads as command of the material, but it is written *before* the precise part is checked against, and it routinely overstates it. Fluency produces it; nothing in the drafting loop tests it.

**What to do instead:** `prose-voice.md` § *The moves that make the difference* carries the repair and how to spot it mid-draft. What it does not say is why this matters more than it looks: **the overclaim is the sentence most likely to be quoted back** — short, quotable, load-bearing-sounding — so its error travels further than the accurate list beneath it. In a document whose whole value is precision about who may do what, the summary is the worst place to be loose.

**Where it bit (2026-08-10/11, `docs/vision/auth.md`):** three openers in one session, every one caught by Larry. *"Everything above is a mesh node"* — except the Gateway, which the same document's third paragraph calls *"mesh mechanics, not a mesh node"*.

**The sibling failure, same session, same root.** After `passage` and `dominion` landed, the sweep applying them **amplified** them: the passage-is-not-dominion point ended up stated five times in one document, three of them cut in consecutive turns. Adopting a precise term is a **rename**, not an invitation to re-explain the concept everywhere that previously said it vaguely. Precise words need *fewer* repetitions, which is the whole reason for coining them.

---

## Adding an entry

The bar: a habit that (1) arrives from training rather than this repo, (2) has produced a **real, dated** failure here, and (3) would recur in a fresh session with no memory. Cite the failure. If you cannot cite one, it is a convention, not a calibration — it belongs in the rule for its domain.

Write it in the voice `.claude/rules/prose-voice.md` describes, and run `node scripts/check-prose.mjs .claude/rules/calibration.md` before you are done. This file is a third of all always-loaded guidance and is the style example every session reads, so what it models propagates.
