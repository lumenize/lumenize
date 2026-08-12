# ADR-015: Passage and Dominion

**Date**: 2026-07-21
**Status**: Proposed — **ratification is Larry's ad-hoc call, tracked by no task file and gated on nothing (decided 2026-08-11).** His read: the model is solid, will probably see more tweaks, and the likely moment is just before or just after the Galaxy collapse. ⚠️ **No task file may reintroduce a ratification gate for this ADR**, and `/review-task` / `/build-task` MUST NOT block on one — an earlier arrangement deferred ratification until a specific task had built, which made every re-split of that task a question about this ADR. The tasks amending it are free to land without ratifying it. ⚠️ **This is a different deferral from [ADR-016](016-record-the-acting-principal.md) and [ADR-019](019-derived-artifacts-record-observations.md) — do not read the three as one**; those are deferred past pre-alpha as a scheduling call. The relevant fact here is that the text had a **line-by-line review with Larry on 2026-08-10/11** and survived a Stage-2 conformance panel, so the *model* is settled while the mechanism keeps moving — the same week's implementation-adjacent scrutiny moved it twice (a member may invite a non-admin peer at their own scope; the mint's four invariants collapsed to one), and the invite rule is still being calibrated.
**Deciders**: Larry
**Evidence**: `hasDominionOver` (`packages/nebula-auth/src/parse-id.ts`) — the single expression of both halves; the guards that consume it (`apps/nebula/src/nebula-do.ts` `requireDominionHere`/`requirePassage`, `dag-tree.ts` `requirePermission`, the subscribe-time writers); the deletion plan (`packages/nebula-auth/src/nebula-auth-registry.ts` `#computeDeletionPlan`/`#affectedUsers`). Two violations motivated it, both since fixed: an **upward** leak, where the bare `access.admin` bit was treated as dominion anywhere rather than only where the scope covers; and a **downward veto**, where the deletion plan let a descendant scope's members refuse an admin above them.

## Context

Scopes form a strict tree: universe → galaxy → star, and every principal carries a scope naming the subtree it governs. That much was never in doubt. Which direction dominion flows along that tree, and whether the `scopeAdmin` bit means anything on its own, was **assumed everywhere and written down nowhere**.

An unwritten invariant of this shape is violable in two independent directions, and at each site the violation reads as sense rather than as a bug. Honouring an admin's bit wherever they happen to be reads as "an admin is an admin." Letting a scope's own members block an admin above them reads as protecting the people actually using it. Both shipped — the Evidence line above names them — and neither reviewer had a stated invariant to check against.

## Terminology — this ADR is the definition home

- **Dominion** — an *unconditional* right to act on a node: where it applies, nothing the node itself decides can stand against it. **Downward only.**
- **Passage** — the right for a call to *arrive* at a node's boundary without being refused there. It confers nothing.

Who holds either, exactly, is the predicate pair in § *Decision*.

**The two nest: dominion implies passage**, since you cannot act somewhere you cannot arrive. So for any principal, passage is never the smaller set, and what it adds is everything at-or-above that principal's own scope — the whole of a non-admin's passage, and no one's dominion. The two coincide only at the platform instance, which covers everything.

⚠️ **Lacking dominion is not a denial.** It is an override, not a gate: hold it and nothing the node decides can stand in the way; lack it and the node's own guards decide — freely, and often in the caller's favour. A caller with passage but no dominion may still be granted a great deal by the methods it reaches, and a peer-level invite is exactly that shape.

⚠️ **`dominion` and `passage` are deliberately rare words.** They replaced `authority` and `admission`/`admitted`, both general enough to mean several things at once. A reader who meets `dominion` anywhere in this repo may assume this definition and nothing else. **Do not reintroduce `authority` or `admitted` as the name of either concept.** Other senses of *authority* are untouched: a **mint point** is where a `sub` is minted (a Universe or Star claim, an invite); [ADR-016](016-record-the-acting-principal.md)'s **authority-changing** actions are those altering *what a principal may do*, which is deliberately **broader than dominion** — a data-plane grant changes it while touching neither the bit nor the scope, so narrowing that trigger to dominion would drop those changes out of it; and plain English still says Studio's agent holds no authority of its own.

⚠️ **There is deliberately no umbrella noun over the two, and `reach` is not to become one.** *Reach* stays a verb — a call reaches a node, an admin reaches into a scope. Nominalised it means passage, or dominion, or their union, or the orgTree's own grants, depending on the sentence. Where a sentence seems to want one word covering both, name both.

**What is mechanism here, and what is not.** The predicates in § *Decision* are the commitment — which conjunction, which disjunction, which arms — and they do not vary. What varies is how `isAtOrAbove` is *computed*, over the member's scope carried verbatim. One property of that computation is contract rather than implementation, because getting it wrong is silent: it compares whole dot-separated segments, so `u.g.s1` does not cover `u.g.s10`, and `acme` does not cover `acme-2`.

> **Today's code differs.** Coverage is a derived wildcard pattern (`access.authScopePattern` matched against the node) rather than a comparison over the member's scope, and a non-admin reaches downward — so the predicates in § *Decision* are not yet what runs. [`tasks/nebula-passage-dominion-from-scope.md`](../../tasks/nebula-passage-dominion-from-scope.md) closes both.

## Decision

**Dominion flows strictly downward along the scope tree, and only downward.** Two predicates say it exactly:

```
isAtOrAbove(myScope, node)  — my scope covers the node
isAtOrBelow(myScope, node)  — my scope sits at or beneath the node

dominion(access, node) = access.scopeAdmin ∧ ( isPlatformInstance(access.authScope)
                                             ∨ isAtOrAbove(access.authScope, node) )

passage(access, node)  = isAtOrBelow(access.authScope, node) ∨ dominion(access, node)
```

Neither arm of that conjunction is ever enough alone, and the platform instance satisfies the position half rather than escaping it. Passage confers nothing when it lands: which reads are tenant-facing is a per-method guard decision, never a narrowing of passage.

Three things follow that no predicate can state, because they govern how these are used:

1. **Dominion is total and non-vetoable.** Dominion over a node is dominion over everything beneath it, and it is unconditional. Descendants — including a scope's own members — can never veto, block, or attenuate an admin above them. Where an action is destructive or surprising, the restraint is a **UI warning carrying the information needed to decide**, never a refusal in the authorization layer.

2. **It binds every finer-grained permission mechanism the node runs, not just its boundary.** Such a mechanism decides for principals *without* dominion and is overridden for one who has it — otherwise a descendant's own permission model becomes exactly the attenuation point 1 forbids, and the more expressive that model is, the more of the decision it quietly takes back. The Resource orgTree is the worked example: a covering admin acts there with no grant ever written (`apps/nebula/src/dag-tree.ts` `requirePermission`). Anything built later inherits this without being asked.

3. **One predicate, one implementation.** Every site needing either verdict calls the shared predicate against the node it is acting on, rather than re-inlining the conjunction ([ADR-007](007-shared-node-security-core.md)) — which is what made both violations above fixable in one place instead of N. The live symbol is `hasDominionOver(access, node)`.

## Alternatives considered

- **Let members block deletion of a shared scope.** The status quo before this ADR. Protects real users from a careless admin, but inverts the model: it makes dominion conditional on the consent of those it governs. Under open Star self-signup it also becomes an attack — a squatter holds a slug hostage precisely because they are an "other user."
- **A narrow carve-out: only unblock when the scope has a single member.** Proposed and rejected 2026-07-21. It treats the symptom; the veto is wrong for every descendant, not just the single-member case, and a predicate carve-out leaves the inverted principle in place to resurface elsewhere.
- **Close the upward leak by tightening `requirePassage`'s tenant branch.** Rejected: that branch is passage, not dominion. Narrowing it breaks legitimate non-admin upward reads (a Star fetching its app's ontology) while leaving the actual defect — guards trusting a bare bit — untouched. ⚠️ **This row is retired by [`tasks/nebula-passage-dominion-from-scope.md`](../../tasks/nebula-passage-dominion-from-scope.md), and the retirement is not a reversal.** That work changes the branch's *input* from the client-chosen `aud` to the server-trusted scope, which refuses the descendant case while preserving the upward read this row defends — `docs/vision/auth.md` § *Coarse-grained access control* (`accepted`) carries that read as its own table row. The branch survives; only what it compares changes.
- **Rely on review to catch violations.** Empirically insufficient: both violations survived multiple passes, and a third was proposed during the very session that fixed the second.

## Consequences

- **Positive.** Two predicates to audit instead of a scattered conjunction. Open Star self-signup becomes implementable: a star-scoped admin's scope is inert above its own Star by construction, which is what makes an unauthorized signup safe. Remediation works: a covering admin can always clean up beneath them.
- **Negative / accepted.** A careless admin can destroy a descendant scope that other people are actively using; the only guard is the warning surface. That is deliberate, and the reason is not only that the alternative inverts the model. A Universe or Galaxy admin stands to their tenancy roughly as we stand to our own Cloudflare account: anyone holding broad access can do very nearly anything, and the discipline lives in **who you hand it to**, never in what the platform will permit once they hold it. These admins have their own customers to serve, and cannot administer that relationship through a platform that second-guesses them. What it does raise is the stakes on delete-confirmation UX, which must carry enough context (attached users, last login, activity) for an informed decision. `docs/vision/auth.md` § *Why downward is generous for admins* is the fuller argument.
- **Deliberately open.** Which reads are tenant-facing is a per-method guard decision (§ *Decision*), not covered here. An allocation inherited from before a tier existed is a latent trap: re-confirm each non-admin `@mesh()` on an ancestor against who can actually reach it today, and record the reason.
