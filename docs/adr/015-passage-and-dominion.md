# ADR-015: Passage and Dominion

**Date**: 2026-07-21
**Status**: Proposed — **ratification is Larry's ad-hoc call, tracked by no task file and gated on nothing (decided 2026-08-11).** His read: the model is solid, will probably see more tweaks, and the likely moment is just before or just after the Galaxy collapse. ⚠️ **No task file may reintroduce a ratification gate for this ADR**, and `/review-task` / `/build-task` MUST NOT block on one — an earlier arrangement deferred ratification until a specific task had built, which made every re-split of that task a question about this ADR. The tasks amending it are free to land without ratifying it. ⚠️ **This is a different deferral from [ADR-016](016-record-the-acting-principal.md) and [ADR-019](019-derived-artifacts-record-observations.md) — do not read the three as one**; those are deferred past pre-alpha as a scheduling call. The relevant fact here is that the text had a **line-by-line review with Larry on 2026-08-10/11** and survived a Stage-2 conformance panel, so the *model* is settled while the mechanism keeps moving — the same week's implementation-adjacent scrutiny moved it twice (a member may invite a non-admin peer at their own scope; the mint's four invariants collapsed to one), and the invite rule is still being calibrated.
**Deciders**: Larry
**Evidence**: `hasDominionOver` (`packages/nebula-auth/src/parse-id.ts`) — the single expression of both halves; the guards that consume it (`apps/nebula/src/nebula-do.ts` `requireDominionHere`/`requirePassage`, `dag-tree.ts` `requirePermission`, the subscribe-time writers); the deletion plan (`packages/nebula-auth/src/nebula-auth-registry.ts` `#computeDeletionPlan`/`#affectedUsers`). Two violations motivated it, both since fixed: an **upward** leak, where the bare `access.admin` bit was treated as dominion anywhere rather than only where the scope covers; and a **downward veto**, where the deletion plan let a descendant scope's members refuse an admin above them.

## Context

**Coarse-grained access control is determined by three concepts this ADR defines — scope, dominion and passage — working together to make lateral movement impossible while allowing certain kinds of vertical movement.**

Scopes form a strict tree: platform → universe → galaxy → star, and every principal carries a scope naming the subtree it governs. **That hierarchy is also what identifies lateral movement** — holding a scope in one branch while calling into a scope that is neither linearly above nor linearly below your own. The tree itself was never in doubt. **Vertical is what this ADR decides**: which direction dominion flows along it, and whether the `scopeAdmin` bit means anything on its own, was **assumed everywhere and written down nowhere**.

An unwritten invariant of this shape is violable in two independent directions, and at each site the violation reads as sense rather than as a bug. Honouring an admin's bit wherever they happen to be reads as "an admin is an admin." Letting a scope's own members block an admin above them reads as protecting the people actually using it. Both shipped — the Evidence line above names them — and neither reviewer had a stated invariant to check against.

> **Today's code differs.** Coverage is a derived wildcard pattern (`access.authScopePattern` matched against the node) rather than a comparison over the member's scope, a non-admin reaches downward, and **a call to a node named `nebula-platform` is refused outright** — so the predicates in § *Decision* are not yet what runs. [`tasks/nebula-passage-dominion-from-scope.md`](../../tasks/nebula-passage-dominion-from-scope.md) closes the first two; the third is a **name reservation** and closes when the name goes from **rejected to bound**, never by being opened.

## Decision

### Terminology — this ADR is the definition home

- **Scope** is the driver for coarse-grained access control. It often appears in a segment of a URL, but it can also be a parameter of a mesh call or in the body of a Request. In `https://nebula.lumenize.com/{bindingName}/{u}.{g}.{s}/`, the `{u}.{g}.{s}` would be the scope.
- **Dominion** — an *unconditional* right to act within a scope. Where it applies, nothing decided inside that scope can stand against it. **Downward only.**
- **Passage** — the right for a call to *pass* a node's outer boundary without being refused there. It confers nothing except that.

**`dominion` and `passage` are deliberately rare words.** They replaced `authority` and `admission`/`admitted`, both general enough to mean several things at once. A reader who meets `dominion` anywhere in this repo may assume this definition and nothing else. **Do not reintroduce `authority` or `admitted` as the name of either concept.** Other senses of *authority* are untouched: a **mint point** is where a `sub` is minted (a Universe or Star claim, an invite); [ADR-016](016-record-the-acting-principal.md)'s **authority-changing** actions are those altering *what a principal may do*, which is deliberately **broader than dominion** — a data-plane grant changes it while touching neither `scopeAdmin` nor the scope, so narrowing that trigger to dominion would drop those changes out of it; and plain English still says Studio's agent holds no authority of its own.

**There is deliberately no umbrella noun over dominion and passage, and `reach` is not to become one.** "reach" stays a verb — a call reaches a node, an admin reaches into a scope. Nominalised it means passage, or dominion, or their union, or the orgTree's own grants, depending on the sentence. Where a sentence seems to want one word covering both, name both.

### Predicate pair

Who holds either, exactly, is the predicate pair below:

```
isAtOrAbove(myScope, node)  — my scope covers the node: the same scope, or an ancestor of it.
                              The reserved platform scope is the ROOT of the tree, so it is
                              at or above every node.
isAtOrBelow(myScope, node)  — my scope sits at or beneath the node: the same scope, or a
                              descendant of it. Every scope is at or below the platform root.
                              Exactly isAtOrAbove with the arguments flipped:
                              isAtOrAbove(A, B) === isAtOrBelow(B, A).

dominion(myScope, scopeAdmin, node) = scopeAdmin ∧ isAtOrAbove(myScope, node)

passage(myScope, scopeAdmin, node)  = isAtOrBelow(myScope, node) ∨ dominion(myScope, scopeAdmin, node)
```

**One implementation.** Every site needing either verdict calls the shared predicate against the scope it is acting on, rather than re-inlining ([ADR-007](007-shared-node-security-core.md)) — which is what made both violations in § *Context* fixable in one place instead of N. The symbols are `hasDominionOver(access, node)` and `hasPassageInto(access, node)`, the second landing with [`tasks/nebula-passage-dominion-from-scope.md`](../../tasks/nebula-passage-dominion-from-scope.md).

**Those signatures take two arguments where the predicates take three**, because two of the three arrive together: `myScope` and `scopeAdmin` ride the caller's token as `access.authScope` and `access.scopeAdmin`, so they are passed as that one `access` claim. `node` is the scope being acted on, and is passed separately.

**Scope comparisons are hierarchical by dot-separated segments**, so `u.g.s1` does not cover `u.g.s10`, and `acme` does not cover `acme-2` — the second is the one a naive `startsWith` gets wrong.

**The bare `scopeAdmin` bit is never dominion, and neither is position without it** — dominion is the conjunction, and reading either operand on its own is the bug this ADR exists to stop.

**Passage gets a call past a node's outer boundary and no further.** What happens after that is the node's own: an `@mesh()` method with no guard function and no checks inside it is callable by anyone who arrived. Restricting who may call what is a per-method decision, never a narrowing of passage.

These things follow:

- **The two nest: dominion implies passage**, since you cannot act somewhere you cannot arrive. So for any principal, passage is never the smaller set, and what it adds is everything at-or-above that principal's own scope.
- **Passage at the platform scope is universal**, because the upward arm asks `isAtOrAbove('nebula-platform', anything)` and the root satisfies it for everyone.
- **Only superusers have dominion at the platform scope**, because `isAtOrAbove(myScope, 'nebula-platform')`, holds only when your own scope *is* the platform scope.
- **Dominion over a scope is total and non-vetoable.** No finer-grained permission mechanism in that scope can veto, block, or attenuate a `scopeAdmin` above them. The Resource orgTree is the worked example: a covering scopeAdmin acts there with no grant ever written (`apps/nebula/src/dag-tree.ts` `requirePermission`). Anything built later inherits this without being asked. Where an action is destructive or surprising, the restraint is a **UI warning carrying the information needed to decide**, never a refusal in the authorization layer.
- **A scope's finer-grained mechanisms decide for principals *without* dominion.**
- **Lacking dominion is not a denial.** A caller with passage but no dominion may still be granted a great deal by the methods it reaches, as decided by the callee's own guards.

## Alternatives considered

- **Let members block deletion of a shared scope.** The status quo before this ADR. Protects real users from a careless admin, but inverts the model: it makes dominion conditional on the consent of those it governs. In the case of Star self-signup it also becomes an attack — a squatter holds a slug hostage precisely because they are an "other user."
- **A narrow carve-out: only unblock when the scope has a single member.** Proposed and rejected 2026-07-21. It treats the symptom; the veto is wrong for every descendant, not just the single-member case, and a predicate carve-out leaves the inverted principle in place to resurface elsewhere.
- **Close the upward leak by tightening `requirePassage`'s tenant branch.** Rejected: that branch is passage, not dominion. Narrowing it breaks legitimate non-admin upward reads (a Star fetching its app's ontology) while leaving the actual defect — guards trusting a bare bit — untouched. ⚠️ **This row is retired by [`tasks/nebula-passage-dominion-from-scope.md`](../../tasks/nebula-passage-dominion-from-scope.md), and the retirement is not a reversal.** That work changes the branch's *input* from the client-chosen `aud` to the server-trusted scope, which refuses the descendant case while preserving the upward read this row defends — `docs/vision/auth.md` § *Coarse-grained access control* (`accepted`) carries that read as its own table row. The branch survives; only what it compares changes.
- **Rely on review to catch violations.** Empirically insufficient: both violations survived multiple passes, and a third was proposed during the very session that fixed the second.

## Consequences

- **Positive.** Two predicates to audit instead of a scattered conjunction. Open Star self-signup becomes implementable: a star-scoped admin's scope is inert above its own Star by construction, which is what makes an unauthorized signup safe. Remediation works: a covering admin can always clean up beneath them.
- **Negative / accepted.** A careless admin can destroy a descendant scope that other people are actively using; the only guard is the warning surface. That is deliberate, and the reason is not only that the alternative inverts the model. A Universe or Galaxy admin stands to their tenancy roughly as we stand to our own Cloudflare account: anyone holding broad access can do very nearly anything, and the discipline lives in **who you hand it to**, never in what the platform will permit once they hold it. These admins have their own customers to serve, and cannot administer that relationship through a platform that second-guesses them. What it does raise is the stakes on delete-confirmation UX, which must carry enough context (attached users, last login, activity) for an informed decision. `docs/vision/auth.md` § *Why downward is generous for admins* is the fuller argument.
- **Deliberately open.** Which methods restrict who may call them is a per-method guard decision (§ *Decision*), not covered here. An allocation inherited from before a tier existed is a latent trap: re-confirm each non-admin `@mesh()` on an ancestor against who can actually reach it today, and record the reason.
