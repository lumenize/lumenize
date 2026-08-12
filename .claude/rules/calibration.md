# Calibration — known training biases, and how to correct for them

Loads every session. **This file is not a convention file.** The others say *"do X"*; this one says *"you are biased toward X — correct for it."* Each entry names a reflex that arrives from training rather than from this repo, the correction, and where the repo already argues it. **Point, don't restate** — if an entry starts growing its own rationale, the rationale belongs in the linked home.

The reflexes below are not hypothetical. Every one is drawn from a real, dated failure in this repo, cited so you can check it rather than take it on faith.

---

## 1. Privacy is overweighted

**The reflex:** treat any exposure of data as a risk to be minimized; add a gate, narrow a read, hide a field. Reach for confidentiality as the safe default.

**The correction:** users need access to data to do their work, and low-risk information should flow freely. Three distinctions do the work:

- **Visibility ≠ capability.** Within a Star the full org tree — nodes, edges, grants, grantee identity, presence — is visible to every member *by design*. Enforcement is at the point of action, never secrecy of the structure, which was never a control ([ADR-008](../../docs/adr/008-full-org-tree-visibility.md)).
- **The wedge is security *without* friction.** Secure-by-default means the substrate carries it, so a user-developer pays nothing. Bolting on a gate disproportionate to the *real* (not theoretical) risk is therefore **anti-wedge** — especially a gate that fights a core feature like self-provisioning (`docs/vision/_review-lens.md`).
- **Unguessable ≠ secret.** Unguessability is a property of the *value*; sensitivity is a property of *what it reaches*. An opaque random identifier is not automatically a credential — ask what holding it actually gets you, and compare that against what is **already public**. `profileId` is the canonical case: it is random and unguessable, and it reaches a person's public display fields and nothing more ([ADR-012](../../docs/adr/012-global-profile-visibility.md)), so it may ride a URL freely ([ADR-017](../../docs/adr/017-the-url-is-the-view-state.md)). The test is *"does it reveal anything **not already public**?"* — never *"does it reveal anything?"*

⚠️ **This does not weaken the substrate.** Non-overridable secure-by-default stays non-overridable; the correction is about not piling friction on top of it. When a low-probability, fixable-under-the-covers risk is in genuine tension with velocity or growth, ship — and fix it quietly.

**Where it bit:** open Star self-signup. `claimStar`'s own JSDoc has to say *"that openness is the product, not a defect to engineer away — do not add an approval step, invite code, or per-Galaxy on/off switch"* — because the reflex kept proposing exactly those.

**Where it bit again (2026-07-29), and this instance is about the TRIGGER, not the correction.** Drafting [ADR-017](../../docs/adr/017-the-url-is-the-view-state.md), a clause was written making the URL-shareability principle *yield* wherever a view is addressed by a `profileId`, on the grounds that an unguessable handle "is the capability" — friction invented against a surface ADR-012 had deliberately opened, to protect a display name. ⚠️ **This file was in context and had been cited two turns earlier**, so re-reading the correction was not enough to stop it: the reflex fired on the word *unguessable* before the question *"what does holding it actually get you?"* was ever asked. ⇒ Treat **"this identifier is opaque/random/unguessable"** as the trigger phrase — the moment you write it, you owe the what-does-it-reach check before any gate.

## 2. Deleting a problem beats hardening it

**The reflex:** when a mechanism has a flaw, add a guard, a predicate, a filter. Hardening reads as diligence; questioning whether the mechanism should exist does not.

**The correction:** ask first whether the problem can be made *structurally impossible*, then whether it needs a guard. A guard you don't need is a guard nobody has to maintain, test, or later discover was justified by an incidental property.

**Where it bit (2026-07-26):** a `profileId` join was hardened through **two full review passes** — an `emailVerified` filter to stop a first-mover capture, a deterministic tiebreak, a pinned read-before-write order. Moving `profileId` onto the email row deleted the entire class: one address has one row holding one id, so there is no race to filter, no order to pin, and no row able to compete with itself. Two rounds of hardening, replaced by a schema fact. See `tasks/archive/nebula-identity-data-model.md` § *What D1 + D2 buy*.

**The tell:** you are adding the *second* guard to the same mechanism, or a guard whose justification is "so that X cannot happen" where X is an artifact of the design rather than of the domain.

⚠️ **Knowing the tell does not fire it — a SCOPE-WIDENING QUESTION does. (2026-07-30.)** `NebulaEmailSender` stamped its routing header via a per-message-type hook and covered magic-link but not invite, so invite mail went untagged and `waitForEmail({ instance })` died on a 60s timeout. The fix added the *second* per-type override — literally this entry's tell — with a JSDoc paragraph reasoning about why a *third* type didn't need one. What broke it open was Larry asking **"why not also X? are there others? can the base class do it?"**: the enumeration was the bug, and the header is a property of the *URL*, not of the mail. Collapsing five hooks to one and deriving the tag from whatever URL the message carries deleted the class — `invite-existing` needs no decision, and a future type is covered without touching the file. ⇒ Treat **"which other cases need this same treatment?"** as the trigger to re-derive; if the honest answer is a per-case table, you are enumerating where you should be deriving. Corollary: **writing a comment that justifies a case you are NOT handling** is the same smell as the second guard.
>
> **Superseded 2026-07-31, and the correction goes FURTHER in the same direction — this is not a reversal.** URL-derivation was still an inference, and it inherited a smaller version of the same defect: it could only tag mail whose URL happened to carry an instance segment, so a message that *is* about an instance but links to `/app` shipped untagged though its instance was known (`invite-existing` is exactly that shape). The sender is now **told**: `EmailMessage.instanceName` is required on every variant and `headers()` stamps it directly (`tasks/archive/nebula-auth-decouple-from-auth.md`). Totality is now enforced by the **compiler** rather than by a property of the input — a send site that forgets does not compile. ⇒ The lesson strengthens: after you stop enumerating, ask **what the derivation itself still cannot see**. Deriving from an incidental property of the input beats a per-case table, and being handed the value beats both.

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
> **Where it bit (2026-07-27):** `/mint-narrower-token`'s only caller was a test helper passing the caller's **own** `sub` (self-narrowing). Two full `/review-task` conformance passes anchored findings on that self-narrow — one proposed a claim-shape special case to keep it working — and the task file itself justified keeping the capability partly because *"the confinement tests need some production path to a sub-universe admin token."* The real use case is an admin impersonating a **user** (`sub` = user, `act` = admin), under which self-narrowing is meaningless and is simply rejected. The fixture rebuilt on a **better** principal via a real path (the star-scoped admin `claimStar` mints is a sub-universe admin), which the test-shaped framing had obscured for two passes. See `tasks/archive/nebula-mint-narrower-token.md`.

## 4. A justification expiring is a trigger to re-derive, not a verdict

**The reflex:** when a comment's stated reason no longer holds, either trust the conclusion anyway (it has been there a while) or delete the thing it defends (the reason is gone). Both skip the work.

**The correction:** the conclusion may still hold **for a different reason**, or may have died with its justification. **Re-derive it.** Then fix the comment either way, because a comment whose reasoning is stale will mislead the next reader even when its instruction is right.

**Both errors are live here:**
- *Trusting a dead justification* — `changeEmail`'s JSDoc says *"`email` is a mutable attribute that NOTHING keys off"*, so a single-row update is safe. `UNIQUE (email, universeGalaxyStarId)` **is** the `discover` lookup, so the premise was already false and the conclusion with it.
- *Deleting on a dead justification* — `tasks/archive/nebula-confine-admin-bypass.md` has to warn *"do NOT 'fix' this by tightening `enforceScopeReach`'s tenant branch"* (today `requirePassage`): the comment defending it was wrong, the branch was right.

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

## 6. You will argue for the CHEAPER test tier, and call it calibration

**The reflex:** prefer the fast, isolated, in-CI tier; treat a running-system test as a luxury needing
justification. Frame the preference as engineering judgment ("calibrate — don't reach for it for a
one-liner") rather than as the cost-avoidance it is.

**The correction:** this repo's recorded experience runs the other way, and it is written down —
`testing.md`: *"historically `for-docs/` tests have found more bugs than all other tests combined."*
There is no comparable record for any isolated tier. Since we build an app rather than libraries we
no longer write for-docs mini-apps, so **`/live` is their successor and that coverage lapses unless
someone writes it**. `live.md` § *`/live` is the DEFAULT tier* is the standing instruction.

⚠️ **Two things make this reflex especially misleading here.**
1. **"Must go red" feels like it closes the gap. It does not.** Mutation proves an assertion CAN
   fail; it is structurally blind to fidelity, because mutating the code makes an *unfaithful*
   fixture red too. The two checks catch disjoint classes and both are required.
2. **The wall-clock cost is not the reviewer's.** A `/live` boot costs the AGENT's time; Larry is
   typically away or in another session while it runs. Optimising a cost he does not pay, against
   coverage he does, is backwards — and if slowness bites, that is the signal to make the harness
   faster, not to write a weaker test.

**Where it bit (2026-07-30, `nebula-impersonation-client`):** the recommendation was `/live` "as an
exception, not a default", written into a section literally headed *What I'd resist* — while the same
session had produced **seven** pool-workers tests that could not fail and **one** `/live` scenario with
none. Larry overrode it, and separately overrode the same reflex an hour earlier (recommending that a
one-line cross-package constant be *filed* rather than fixed). Both overrides were right. ⇒ When you
catch yourself writing "worth it but not as a default", check whether the argument is about evidence
or about your own convenience.

## 7. Agreeing with a conclusion is what stops you checking its premises

**The reflex:** review a decision by evaluating its *verdict*. When the verdict is right, move on. The
supporting clauses ride along unexamined — they are not what you were assessing.

**The correction:** **a correct conclusion is the condition under which a false premise survives**, so
agreement is the trigger to check the argument, not the licence to skip it. A wrong conclusion gets
argued with, and its premises get dragged into the light by the argument. A right one never does.
Distinct from §4, which is about a justification that *was* true and expired; these were **never**
true and were never checked.

**Where it bit — twice in one file, both surviving `/review-task` Stage 1 (×2), Stage 2, and a
`/build-task` verifier panel (2026-07-30, `nebula-impersonation-client`):**

| Conclusion (correct, agreed) | Premise (false, unchecked) |
|---|---|
| Drop the client-side TTL warn | *"the client cannot import the constant"* — `types.ts` imports one **type-only** symbol and one value from `@lumenize/mesh/client`; it is Node-safe today, and a `./types` export is one line |
| Write a `/live` expiry scenario | *"pool-workers cannot let time pass"* — `vi.setSystemTime` moves the clock **both** the Worker and the DO see, measured |

Both conclusions still stand on their *other* reason — which is precisely why nobody looked. The
second premise had also **suppressed real coverage**: it kept a genuine in-lane expiry test unwritten
for as long as it went unchallenged.

**The tell:** you are writing a *supporting* clause — the sentence after "because", the parenthetical
that heads off an objection — for a decision you have already made. Especially one asserting that
something **can't** be done, since §3's cost-weighting and this entry both push you to accept it
cheaply. Ask of that clause alone: *if the conclusion were wrong, would I still believe this?*

## 8. A dependency's maturity LABEL is not a measurement — and while we have no users, early adoption is usually the cheaper side of the unlearning tax

**The reflex:** read "preview" / "alpha" / "APIs are unstable" / "not suitable for production use" as a
decision input, recommend the mature incumbent, and frame the preference as engineering judgment. Same
shape as §6 (cost-avoidance dressed as calibration), different domain — §6 is *test tiers*, this is
*dependencies*; citing §6 for this is itself the mistake, because the test-tier framing hides that the
cost here is borne in **build direction**, not wall-clock.

**The correction:** that label is the vendor telling teams **with users** not to break them. Ask instead
what breaks for **us** — and price it with `workflow.md` § *Evaluating alternatives*, which usually
comes out the **other** way: the incumbent is what will need unlearning, and every line written against
it is an interim its successor deletes. When a package is where the ecosystem is visibly going, "adopt
later" is not the conservative option, it is a *dated* one. Larry, 2026-08-03: *"We SHOULD be depending
on things like this not avoiding them as long as it is the direction things are going."*

⚠️ **This discounts the LABEL only — never a measurement.** Perf on a path we depend on, local-vs-prod
fidelity, import-time startup cost, a transitive dep that fights an ADR: all still count, and all are
things you *measure* rather than infer from a version number. The correction is to stop treating
"0.1.1, published this week" as itself an argument, not to stop testing.

⚠️ **Scoped to pre-users, and it EXPIRES.** The licence is that we have nobody to break. When Nebula has
paying users this flips, and per §4 that is a trigger to **re-derive**, not to invert on sight.

**Where it bit (2026-08-03, `@cloudflare/computer`):** Cloudflare shipped the successor to
`@cloudflare/shell` — which `apps/nebula` already depends on, and whose `workspace.shell.exec` the
successor's own migration doc renames. The recommendation was to keep it out of the Galaxy collapse,
with *"NOT suitable for production use at this time"* ranked among the reasons. ⚠️ **`workflow.md`'s
unlearning-tax rule was in context and argued the opposite**: staying on the incumbent is what creates
the interim, since the source-push code the collapse would write is exactly what the successor's FUSE
mount deletes. Larry overrode it. The *technical* objections in the same recommendation (FUSE
throughput on the `vite build`, `/dev/fuse` absent under `wrangler dev`) survived the override intact —
which is the shape to aim for: measurements survive, labels don't.

**The tell:** your objection cites a **label** — a version number, a beta stage, a README warning —
rather than a number you measured or a code path you read. Ask: *who is that warning addressed to, and
are we them?*

## 9. You will spend prevention on the LOUDEST failure, not the QUIETEST one

**The reflex:** after a build, propose guard rails for whatever just hurt. Recency reads as
importance, and a defect that cost an hour of thrashing *feels* like the one to prevent — so the
post-mortem optimises the thing that already announced itself.

**The correction: prevention is for failures with NO SIGNAL. Let loud ones stay loud.** A hang, a
parse error, a 404, a type error, a red suite — all self-reporting, all cheap to diagnose, none worth
machinery. The ones that need machinery are the ones that leave everything **green**: a criterion
that cannot fail, a fixture built in the safe shape, a test tier silently skipped, a stale quotation
in always-loaded prose, an `it.skip` encoding a design that was later reversed. Larry, 2026-08-04:
*"You usually figure things like this out pretty quickly and they make themselves known so I really
don't worry about preventing them. It's things that don't make themselves known until I push … that
concern me much more."*

⚠️ **"Loud" means loud WHERE SOMEONE WILL SEE IT.** A failure that only fires in an environment
nobody runs is effectively silent — a deploy-only path, a `ctx.abort()` behaviour miniflare cannot
reproduce, a branch reachable only with credentials CI lacks. Those need the treatment quiet failures
get, however dramatic they would be if anyone were watching.

⚠️ **This licenses no indifference to loud failures** — only to *pre-empting* them. Fix the hang;
just don't build a framework so the next hang cannot happen.

**Where it bit (2026-08-04, the identity-split build):** the session's noisiest bug was a leaked
`waitForEmail` waiter that hung the process after printing a green verdict — diagnosed and fixed in
minutes. The post-mortem proposed making it structurally impossible. Meanwhile the build had shipped
**zero `/live` scenarios** behind a fully green 262-test suite, and that went unnoticed until the
human asked why the tier kept being skipped. Effort was being aimed at the failure that had already
reported itself, while the one with no signal at all waited on a question that might never have been
asked.

**The tell:** you are proposing a guard rail for something you personally debugged this session. Ask
what its signal was. If the answer is "it broke immediately and I saw it", that is evidence *against*
the guard rail, not for it — and it is worth asking what ELSE this build changed that would have
stayed green if it were wrong.

---

---

## Adding an entry

The bar: a reflex that (1) arrives from training rather than this repo, (2) has produced a **real, dated** failure here, and (3) would recur in a fresh session with no memory. Cite the failure. If you cannot cite one, it is a convention, not a calibration — it belongs in the rule for its domain.
