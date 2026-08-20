# Calibration — known training biases, and how to correct for them

Loads every session. **This file is not a convention file.** The others say *"do X"*; this one says *"you are biased toward X — correct for it."*

Each entry names a habit that arrives from training rather than from this repo, says what to do instead, and points at where the repo already argues it. Point at the argument rather than repeating it — an entry that grows its own rationale should hand that rationale to the file it links.

None of these is hypothetical. Every one is drawn from a real, dated failure here, cited so you can check it rather than take it on faith.

---

## 1. Privacy is overweighted

**What you'll do:** treat any exposure of data as a risk to minimize — add a gate, narrow a read, hide a field — and reach for confidentiality as the safe default.

**What to do instead:** users need access to data to do their work, and low-risk information should flow freely. Two of the three corrections are already on your screen, in `workflow.md`'s always-loaded ADR index: [ADR-008](../../docs/adr/008-full-org-tree-visibility.md)'s *visibility ≠ capability*, and [ADR-017](../../docs/adr/017-the-url-is-the-view-state.md)'s test — *does it reveal anything **not already public**?*, never *does it reveal anything?* Read them there. The third loads nowhere else:

- **The business wedge is security *without* friction.** Secure-by-default means the substrate carries it, so a user-developer pays nothing. A gate disproportionate to the *real* (not theoretical) risk therefore works against the wedge — especially one fighting a core feature like self-provisioning. `docs/vision/_review-lens.md` argues it, and does not load automatically.

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

**The PARAMETERS are the model here, not the endpoint name.** `{ sub, activeScope }` — each is literally the token field the caller wants, and `act.sub` is derived from the Bearer token, so it is not a parameter and cannot be misnamed at all.

**A good name is also a falsifiable claim.** Asserting the minted token is *narrower* gave the code something it had to satisfy, and checking it exposed two real violations; `delegated` asserted nothing, so nothing could be checked against it. Assert that invariant in a predicate or a JSDoc, though — `/mint-narrower-token` names what the implementation produces, while the caller is asking to impersonate someone, which is what the rest of the system calls it (`admin.impersonate()`, `assertCanImpersonate`, two `/live` scenarios). Whether the endpoint should be renamed is open in `tasks/backlog.md` § *Nebula Auth*.

**How to catch yourself:** you are writing a glossary entry, a mapping table, or a sentence of the form *"X is really Y"* — in a task file, a comment, or a reply. That is the rename signal, not a documentation task.

*(Choosing a name in the first place: `naming-judgment` — minimize new vocabulary, flag a new term before coining it, prefer dominant-ecosystem syntax.)*

## 6. You will argue for the CHEAPER test tier, and call it calibration

**What you'll do:** prefer the fast, isolated, in-CI tier, and frame the preference as engineering judgment ("calibrate — don't reach for `/live` for a one-liner") rather than as the cost-avoidance it is.

**What to do instead:** `live.md` § *`/live` is the DEFAULT tier* carries the argument, the measurements, and how to write a scenario that can fail. None of it needs repeating here. What that file cannot do is catch you writing the rationalization, because that happens in a recommendation drafted before any test exists. The phrase to catch is **"worth it, but not as a default"** — when you write it, check whether the argument is about evidence or about your own convenience.

**The other half: you will decide you CANNOT run it, and surface that as a question at the end.** It goes like this, repeatedly. Mid-build you conclude something is out of reach — it needs Docker, real email, a deployed Worker, credentials you assume are absent — you carry on without checking, and at the end you tell Larry you need him to proceed. He says *"you don't need me."* You check, and he is right. It has never once come out the other way.

**Check when you form the belief, not when you report it.** `live.md` § *DO NOT ASSERT THAT YOU LACK THE ACCESS* inventories what is on disk; verified 2026-08-20, `.dev.vars` is 67 lines, the wrangler session is live, Docker is running, and 11 of 15 scenarios need no container. Deferring it is worse than being wrong for two reasons: **Larry answers a permission request, he does not go and verify it** — so a false belief about your own reach arrives in the one form nobody checks — and **mid-build the check is one `ls`, while at the end it is a round trip with the bottleneck**, into a build he had stopped tracking.

**How to catch yourself:** you are about to end a turn by asking for access, a credential, or a go-ahead. Run the command that would falsify the request first. An answer you have never once been right about is not a judgement call.

## 7. Agreeing with a conclusion is what stops you checking its premises

**What you'll do:** review a decision by evaluating its *verdict*. When the verdict is right, move on. The supporting clauses ride along unexamined — they are not what you were assessing.

**What to do instead:** **a correct conclusion is the condition under which a false premise survives**, so agreement is the trigger to check the argument, not the licence to skip it. A wrong conclusion gets argued with, and its premises get dragged into the light by the argument. A right one never does. Distinct from §4, which is about a justification that *was* true and expired; these were **never** true and were never checked.

**Where it bit — twice in one file, both surviving `/review-task` Stage 1 (×2), Stage 2, and a `/build-task` verifier panel (2026-07-30, `nebula-impersonation-client`):**

| Conclusion (correct, agreed) | Premise (false, unchecked) |
|---|---|
| Drop the client-side TTL warn | *"the client cannot import the constant"* — `apps/nebula/src/frontend/types.ts` already imports from `@lumenize/mesh/client`, so the module is reachable from the client graph and a `./types` export is one line |
| Write a `/live` expiry scenario | *"pool-workers cannot let time pass"* — `vi.setSystemTime` moves the clock **both** the Worker and the DO see, measured |

It recurs, and not only here: on 2026-08-03 a claim that `@cloudflare/computer` drags in `zod` — an ADR-001 footgun — was asserted under a conclusion nobody was arguing with, and corrected in `experiments/computer-vfs-build/RESULTS.md` § 7, which names this entry. Different domain, four days later.

Both conclusions still stand on their *other* reason, which is precisely why nobody looked — and challenging the second premise produced the in-lane expiry test everyone had believed impossible (`apps/nebula/test/test-apps/baseline/impersonate-lifetime.test.ts` § *survives a GENUINE expiry*).

**How to catch yourself:** you are writing a *supporting* clause — the sentence after "because", the parenthetical that heads off an objection — for a decision you have already made. Especially one asserting that something **can't** be done, since §3's cost-weighting and this entry both push you to accept it cheaply. Ask of that clause alone: *if the conclusion were wrong, would I still believe this?*

## 8. You will bet on the world as it is; Larry bets on where it is going

**What you'll do:** optimize for the present state — recommend the mature incumbent, the proven mechanism, the thing that works today — and frame that preference as engineering judgment rather than as the risk aversion it is.

**What to do instead:** Larry skates to where the puck is going, and accepts more risk getting there than you will ever propose. When the question is *which way is this going*, weight his read over your caution. The incumbent is what needs unlearning, and every line written against it is an interim its successor deletes (`workflow.md` § *Evaluating alternatives*). "Adopt later" is not the conservative option; it is a dated one. Larry, 2026-08-03: *"We SHOULD be depending on things like this not avoiding them as long as it is the direction things are going."*

**The boundary is DIRECTION, not verification.** A bet on where the ecosystem is heading is his to take, and he is usually right. How a thing actually behaves is still yours to measure: perf on a path we depend on, local-vs-prod fidelity, import-time startup cost, a transitive dep fighting an ADR. **Measurements survive an override and labels do not** — on 2026-08-03 the `@cloudflare/computer` recommendation was overridden on its "not suitable for production use" label, while its FUSE-throughput objections stood untouched (`tasks/nebula-galaxy-collapse-and-chat.md`).

**How to catch yourself:** your objection rests on a label — a version number, a beta stage, a README warning — or on the fact that something is newer and less proven, rather than on a number you measured or a code path you read. A maturity label is the vendor telling teams **with users** not to break them; ask whether we are them.

⚠️ **The licence EXPIRES.** "Adopt early" is right *because we have nobody to break*, not because new is better. When Nebula has paying users the answer changes while the instinct does not, and per §4 that is a trigger to **re-derive**, never to invert on sight.

## 9. You will spend prevention on the LOUDEST failure, not the QUIETEST one

**What you'll do:** after a build, propose guard rails for whatever just hurt. Recency reads as importance, so the post-mortem optimises what already announced itself.

**What to do instead: fix the loud one and build nothing; spend prevention on failures with no signal WHERE ANYONE IS LOOKING.** A hang, a type error, a red suite are self-reporting and cheap to diagnose. What needs machinery is what leaves everything **green** — a criterion that cannot fail, a fixture built in the safe shape, a test tier silently skipped — and equally, anything that would be loud but fires only where nobody runs it: a deploy-only path, a `ctx.abort()` miniflare cannot reproduce, a branch reachable only with credentials CI lacks. Larry, 2026-08-04: *"things that don't make themselves known until I push … concern me much more."*

**Where it bit (2026-08-04):** the noisiest bug was a leaked `waitForEmail` waiter that hung the process after printing a green verdict, and the post-mortem proposed making it structurally impossible. The same build had shipped **zero `/live` scenarios** behind a green 262-test suite, unnoticed until Larry asked.

**How to catch yourself:** you are proposing a guard rail for something you personally debugged this session. Ask what its signal was — "it broke immediately and I saw it" is evidence *against* the guard rail, and a prompt to ask what else this build changed would have stayed green if it were wrong.

## 10. Opening with a sweep — moved

Now `prose-voice.md` § *The moves that make the difference*. It is prose guidance rather than a training bias, and belongs where it loads at drafting time. The handle stays because archived files cite it and they are frozen.

---

## Adding an entry

The bar: a habit that (1) arrives from training rather than this repo, (2) has produced a **real, dated** failure here, and (3) would recur in a fresh session with no memory. Cite the failure. If you cannot cite one, it is a convention, not a calibration — it belongs in the rule for its domain.

Write it in the voice `.claude/rules/prose-voice.md` describes, and run `node scripts/check-prose.mjs .claude/rules/calibration.md` before you are done. This file is a third of all always-loaded guidance and is the style example every session reads, so what it models propagates.
