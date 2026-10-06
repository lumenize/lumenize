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

**Where it bit again (2026-07-29), and this one is about the TRIGGER, not the correction.** Drafting ADR-017, a clause was written making its own URL-shareability principle *yield* wherever a view is addressed by a `profileId` — friction invented against a surface [ADR-012](../../docs/adr/012-global-profile-visibility.md) had deliberately opened, to protect a display name. This file was in context and had been cited two turns earlier, so re-reading the correction was not what stopped it, because it did not stop it: the word *unguessable* fired first, before anyone asked what holding the value actually gets you. ⇒ **"opaque" / "random" / "unguessable" is the trigger phrase.** The moment you write one, you owe the what-does-it-reach check before any gate.

## 2. Deleting a problem beats hardening it

**What you'll do:** when a mechanism has a flaw, add a guard, a predicate, a filter. Hardening reads as diligence; questioning whether the mechanism should exist does not.

**What to do instead:** ask first whether the problem can be made *structurally impossible*, and only then whether it needs a guard. A guard you don't need is a guard nobody has to maintain, test, or later discover was justified by something incidental.

**Where it bit (2026-07-26):** a `profileId` join was hardened through **two full review passes** — an `emailVerified` filter to stop a first-mover capture, a deterministic tiebreak, a pinned read-before-write order. Moving `profileId` onto the email row deleted the entire class: one address has one row holding one id, so there is no race to filter, no order to pin, and no row able to compete with itself. Two rounds of hardening, replaced by a schema fact. See `tasks/archive/nebula-identity-data-model.md` § *What D1 + D2 buy*.

**How to catch yourself:** you are adding the *second* guard to the same mechanism, or a guard whose justification is "so that X cannot happen" where X is an artifact of the design rather than of the domain. ⚠️ **Noticing the second guard requires noticing you are mid-failure, so it fires late.** The reliable occasion is an event you can see instead: something landed, so ask what each thing it touches is still for. `/build-task` runs it per phase; Larry supplies it by hand as *"what does X actually do now that we've adopted Y?"* — which is where the 2026-07-30 case below came from.

**Knowing that does not fire it — a SCOPE-WIDENING QUESTION does.** Treat **"which other cases need this same treatment?"** as the trigger to re-derive. If the honest answer is a per-case table, you are enumerating where you should be deriving. Deriving from an incidental property of the input beats a per-case table, being handed the value beats both, and once you stop enumerating, ask **what the derivation itself still cannot see**. Writing a comment that justifies a case you are **not** handling is the same smell as the second guard.

**Where it bit again (2026-07-30, then 2026-07-31):** `NebulaEmailSender` stamped its routing header through a per-message-type hook that covered magic-link but not invite, so invite mail went untagged and `waitForEmail({ instance })` died on a 60 s timeout. The first fix added the *second* per-type override, with a JSDoc paragraph reasoning about why a *third* type didn't need one. Larry asking **"why not also X? are there others? can the base class do it?"** broke it open: five hooks collapsed to one that derived the tag from the message's URL. The derivation still missed a message that *is* about an instance but links to `/app` (`invite-existing`), so the sender is now **told**: `EmailMessage.instanceName` is required on every variant, and a send site that forgets does not compile (`tasks/archive/nebula-auth-decouple-from-auth.md`).

## 3. Tests are not a vote on correctness

Four failure modes, same root — treating the suite as an oracle rather than as an encoding of past intent.

**(a) A green test can encode a bug as intended.** A passing suite is evidence that behaviour is *unchanged*, which is a different claim. When you find a defect whose behaviour is asserted somewhere, fix the policy and the test together — do not let the green suite settle the question.

⚠️ **But "together" does not mean inverting the test's assertion — re-derive which SIDE the defect is on first.** `packages/nebula-auth/test/profile-id-claim.test.ts` asserts that a delegated token carries the target's `profileId`, and looked like the bug. It was right: `sub` and top-level `profileId` must describe the same person. The hole was on the **read** side, where `profile.ts`'s owner branch treated that claim as ownership — fixed by adding a no-actor-chain conjunct there ([ADR-012](../../docs/adr/012-global-profile-visibility.md)). The test is still green and still correct. (2026-07-26, resolved 2026-07-28.) ⓘ That conjunct was itself retired 2026-09-08 — acceptance is now enforced at the mint instead — which changes nothing about the lesson: the assertion was on the right side both times.

**(b) A test that must change is often evidence the change is RIGHT.** It was encoding the old behaviour; that is what makes it red.

**(c) Weight callers correctly when costing a change.** You will count every call site as friction, which biases toward preserving a worse design.

| Caller | Weight |
|---|---|
| **Tests** | **≈ zero.** Mechanical, and see (b). |
| Internal, non-exported | A little — type-checked and mechanically fixable. |
| **Public API** | Counts — but still **less than training suggests.** |

"This would require updating 40 tests" is **not** an argument against a change here: CLAUDE.md's release policy favours breaking changes over technical debt, and `/refactor-efficiently` exists to make wide test churn cheap. And before pricing a rename, check the symbol **exists** — a planned `withActor` was nearly kept on call-site grounds with zero call sites (2026-07-28, `tasks/archive/nebula-mint-narrower-token.md`).

**(d) A test caller is not evidence of a USE CASE.** When a capability's only caller is a fixture, you will read that fixture as the requirement and let it define the design. **Ask what a real user does with it; if the only answer is "a test needs it," that is a YAGNI question, not a specification.** When a fixture and the real use case disagree, the fixture is what changes — and challenge whether it needed the odd shape at all. (2026-07-27: two `/review-task` passes anchored findings on `/mint-narrower-token`'s only caller — a fixture — before anyone asked what an admin actually does with the endpoint. Self-narrowing later turned out to have a real product use case, recorded in `tasks/backlog.md` § *Nebula Auth*: no consumer is a question, never a verdict.)

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

**The PARAMETERS are the model here, not the method name.** `impersonate(sub)` takes the one thing the caller asks for, literally the token field it wants. The child's `aud` is the caller's own page and `act.sub` comes from the caller's verified token, so neither is a parameter and neither can be misnamed.

**A good name is also a falsifiable claim.** Asserting the minted token is *narrower* gave the code something it had to satisfy, and checking it exposed two real violations; `delegated` asserted nothing, so nothing could be checked against it. Assert that invariant in a predicate or a JSDoc, though, and name the entry for the caller: the mint is `NebulaAuthFacade.impersonate`, because the caller is asking to impersonate someone, which is what the rest of the system already called it (`admin.impersonate()`, `assertCanImpersonate`, two `/live` scenarios). `/mint-narrower-token` named what the implementation produced.

**How to catch yourself:** you are writing a glossary entry, a mapping table, or a sentence of the form *"X is really Y"* — in a task file, a comment, or a reply. That is the rename signal, not a documentation task.

*(Choosing a name in the first place: `naming-judgment` — minimize new vocabulary, flag a new term before coining it, prefer dominant-ecosystem syntax.)*

## 6. You will argue for the CHEAPER test tier, and call it calibration

**What you'll do:** prefer the fast, isolated, in-CI tier, and frame the preference as engineering judgment ("calibrate — don't reach for `/live` for a one-liner") rather than as the cost-avoidance it is.

**What to do instead:** `live.md` § *`/live` is the DEFAULT tier* carries the argument, the measurements, and how to write a scenario that can fail. None of it needs repeating here. What that file cannot do is catch you writing the rationalization, because that happens in a recommendation drafted before any test exists. The phrase to catch is **"worth it, but not as a default"** — when you write it, check whether the argument is about evidence or about your own convenience.

**The other half: you will decide you CANNOT run it, and surface that as a question at the end.** It goes like this, repeatedly. Mid-build you conclude something is out of reach — it needs Docker, real email, a deployed Worker, credentials you assume are absent — you carry on without checking, and at the end you tell Larry you need him to proceed. He says *"you don't need me."* You check, and he is right. It has never once come out the other way.

**Check when you form the belief, not when you report it.** `live.md` § *DO NOT ASSERT THAT YOU LACK THE ACCESS* inventories what is on disk, and one `ls` confirms it. Deferring it is worse than being wrong for two reasons: **Larry answers a permission request, he does not go and verify it** — so a false belief about your own reach arrives in the one form nobody checks — and **mid-build the check is one `ls`, while at the end it is a round trip with the bottleneck**, into a build he had stopped tracking.

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

**The boundary is DIRECTION, not verification.** A bet on where the ecosystem is heading is his to take, and he is usually right. How a thing actually behaves is still yours to measure: perf on a path we depend on, local-vs-prod fidelity, import-time startup cost, a transitive dep fighting an ADR. **Measurements survive an override and labels do not** — on 2026-08-03 the `@cloudflare/computer` recommendation was overridden on its "not suitable for production use" label, while its FUSE-throughput objections stood untouched (`tasks/archive/nebula-galaxy-collapse-and-chat.md`).

**How to catch yourself:** your objection rests on a label — a version number, a beta stage, a README warning — or on the fact that something is newer and less proven, rather than on a number you measured or a code path you read. A maturity label is the vendor telling teams **with users** not to break them; ask whether we are them.

⚠️ **The licence EXPIRES.** "Adopt early" is right *because we have nobody to break*, not because new is better. When Nebula has paying users the answer changes while the instinct does not, and per §4 that is a trigger to **re-derive**, never to invert on sight.

## 9. You will spend prevention on the LOUDEST failure, not the QUIETEST one

**What you'll do:** after a build, propose guard rails for whatever just hurt. Recency reads as importance, so the post-mortem optimises what already announced itself.

**What to do instead: fix the loud one and build nothing; spend prevention on failures with no signal WHERE ANYONE IS LOOKING.** A hang, a type error, a red suite are self-reporting and cheap to diagnose. What needs machinery is what leaves everything **green** — a criterion that cannot fail, a fixture built in the safe shape, a test tier silently skipped — and equally, anything that would be loud but fires only where nobody runs it: a deploy-only path, a `ctx.abort()` miniflare cannot reproduce, a branch reachable only with credentials CI lacks. Larry, 2026-08-04: *"things that don't make themselves known until I push … concern me much more."*

**Where it bit (2026-08-04):** the noisiest bug was a leaked `waitForEmail` waiter that hung the process after printing a green verdict, and the post-mortem proposed making it structurally impossible. The same build had shipped **zero `/live` scenarios** behind a green 262-test suite, unnoticed until Larry asked.

**How to catch yourself:** you are proposing a guard rail for something you personally debugged this session. Ask what its signal was — "it broke immediately and I saw it" is evidence *against* the guard rail, and a prompt to ask what else this build changed would have stayed green if it were wrong.

## 11. You will expose a composed capability with per-host `@mesh()` shims

**What you'll do:** when a capability is composed onto more than one node type, give each host its own `@mesh()` method that forwards to the composed instance — then write that same forwarding method again on the next host, and call the duplication unavoidable.

**What to do instead:** one gate returns a surface built for the wire and the caller chains — `@mesh() get resources() { return this.#resources.requests }` on each host, called as `ctn<Galaxy>().resources.invite(nodeId, invitees)`. The capability then arrives by composition with no per-host code at all, and a continuation chains the same way. Hand back `requests`, never the composed instance: past the gate nothing is checked, so every member reachable from what it returns is on the wire and must check itself. The answers the node's own continuations ask for — reapers, fire-back handlers — take a second gate with NO `@mesh()` (`get resourcesResults`), because every path that reaches them runs with the member-level check off, and decorating it would open them to the wire. `mesh.md` § *Object-capability access: gate once, then chain* carries the mechanism, a worked example, and the discipline. Read it there.

**Where it bit (2026-08-21):** designing where `invite` should live once `Star` and the collapsed `Galaxy` both compose `Resources`. The answer offered was two thin `@mesh()` methods per host plus a bridge closure, described as irreducible — *"two thin shims have to stay on the host class"* — when `nebula-client.ts` had been chaining through the org tree's single `@mesh()` gate all along, and `dev-studio.ts` (since folded into `galaxy.ts`) documented that gate as the tree's one entry. Larry: *"Creating all of these thin methods is silly."*

**Why the rule did not stop it, which is the reusable part:** `mesh.md` is path-scoped to mesh and nebula **source**, and this decision was made while editing a **task file**, where it never loads. Mesh shape gets decided in prose long before anyone touches a `.ts`. That rule even predicts the bias in its own last line — *"the per-method `@mesh(guard)` shape is the default reflex (and what LLM training knows)"* — so the correction was written down, loaded nowhere, and read too late.

**How to catch yourself:** you are about to write the same `@mesh()` method on two host classes, or a method whose entire body forwards to a composed instance. Either one means the gate belongs one level up.

## 12. You will put a decision in a framework's syntax, where no test can see it

**What you'll do:** express which of two things a user sees as the ORDER of a `v-if` / `v-else-if`
chain — the idiomatic Vue spelling, and the one every example shows. Route order, middleware order
and CSS precedence are the same shape. It reads as layout, so nobody reviews it as logic.

**What to do instead:** when the chain's order is what decides the outcome, **put the decision in a
named function and let the template key on its result.** The order then lives somewhere a mutation
can flip and a test can catch.

**Where it bit (2026-08-28):** Studio's chat status put the transient stream ahead of the failed
banner. A turn that streamed and then died left a frozen partial reply — and `streaming` only clears
when its own message lands durably, so nothing ever cleared it, and the banner was `v-else`'d away
forever. That is the "thinking… forever" hang the phase existed to kill, wearing a half-written
answer instead of a spinner. Every unit test passed, the live scenario passed, and the build note
claimed *"the reducer owns every decision"* — false, because the template owned one too. Extracting
`deriveTurnDisplay` (`apps/nebula/src/turn-liveness.ts`) made the precedence assertable; the original
bug now reds a named test.

**How to catch yourself:** you are writing a second `v-else-if` whose branches are not mutually
exclusive by construction — so one of them is only unreachable because of where it sits in the list.

## 13. You will avoid the test that needs time to pass

**What you'll do:** cover a mechanism whose failure only shows across a real lapse — a token
expiring, a socket reconnecting, a tab coming back after an hour — with a fixture that *starts* in
the lapsed state, or not at all. Waiting reads as slow and fiddly; a scenario that has to sleep 50 s
looks like a worse test than one that runs in 2 s. So the mechanism gets a green suite and no
witness.

**What to do instead:** write the one that waits. Time is cheap here — `live.md` has the numbers —
and the lapse *is* the test: a token born expired proves the re-mint path runs, not that a session
survives its token lapsing under it. A reconnect, an expiry, a heartbeat window elapsing are each a
few seconds of wall clock against a mechanism nothing else can reach. If a real clock is genuinely
out of reach in a lane, `vi.setSystemTime` moves both isolates (`testing.md`) — that is the fallback,
never the "starts lapsed" fixture.

**Where it bit (2026-09-03):** `impersonation-expiry` was the only scenario in the registry that let
a token actually lapse with a socket open. It found that any client idle past its TTL lost its first
call — sent on the stale socket, refused at the Gateway's door, never resent — a "thinking… forever"
for anyone coming back after lunch. Every other test of that path started in the lapsed state and
was green. The same day, the turn heartbeat's first cut wrapped only the loop's awaits; only a watch
that ran through a real 90 s turn caught the banner painting before codegen had begun. And on
2026-10-03, every test of mesh's alarms fired its job by hand, so none saw that a job due at once
never set Cloudflare's alarm: a Galaxy's certificate order waited for its own deletion.

**How to catch yourself:** the fixture for a time-dependent mechanism constructs the *after* state
directly, and you are about to write "cannot let time pass" or "too slow to wait for" in its
justification. Both were written here, and both were false.

## 14. You will over-apply least privilege to the coarse-grained layer

**What you'll do:** narrow a token, a session or a choice of membership to where the caller happens
to be working — "this page only needs its own Star" — and present the narrowing as security. Least
privilege reads as diligence, so nobody asks what the narrowing stops. It is §1's reflex aimed at
capability instead of visibility.

**What to do instead:** ask which lateral move it stops. Dominion and passage are coarse-grained, and
their job is to stop lateral movement while allowing vertical movement: dominion runs downward from
a membership, passage upward from it. Least privilege belongs to the fine-grained layers below them,
the DAG grants and the data-plane guards. A narrowing that stops only vertical movement breaks the
design rather than hardening it. `docs/vision/auth.md` § *Why downward is generous for admins* argues
it; read it there.

**Where it bit (2026-09-14 to 2026-09-18):** ADR-022 narrowed every access token's `authScope` to
the host of the page that asked for it, and a later edit picked the *nearest* scopeAdmin membership
when several qualified. Both took a universe admin's dominion away on any page below the universe,
so they could no longer act as the Universe's admin from a galaxy's page, which the code then
allowed. Three Stage 1 panels on the task file built on it, and a rewrite of the ADR, let it through.
Larry: *"If we make the coarse-grained one too restrictive, we don't allow the system to work as
designed."*

**The host rule (Larry, 2026-09-19) narrows that same way, for a reason this entry does not
weigh: whose CODE runs on the page.** Passage and dominion read `aud`, so a universe admin on a
galaxy's page holds no dominion over the Universe. On a Star's host the page's code is the
user-developer's, and it acts with its visitor's token, so the narrowing stops that code, not the
person: they reach every scope they administer by opening its page. Narrowing a token because the
PERSON needs less is still the mistake of 2026-09-14; argue a narrowing from what runs on the page,
or not at all.

**How to catch yourself:** you are choosing the narrowest of several scopes, or confining a token to
where its page runs, and the justification is that it can then do less. If the move it stops is
vertical rather than lateral, this is the bias.

## 10. Opening with a sweep — moved

Now `prose-voice.md` § *The moves that make the difference*. It is prose guidance rather than a training bias, and belongs where it loads at drafting time. The handle stays because archived files cite it and they are frozen.

---

## Adding an entry

The bar: a habit that (1) arrives from training rather than this repo, (2) has produced a **real, dated** failure here, and (3) would recur in a fresh session with no memory. Cite the failure. If you cannot cite one, it is a convention, not a calibration — it belongs in the rule for its domain.

Write it in the voice `.claude/rules/prose-voice.md` describes, and run `node scripts/check-prose.mjs .claude/rules/calibration.md` before you are done. This file is a third of all always-loaded guidance and is the style example every session reads, so what it models propagates.
