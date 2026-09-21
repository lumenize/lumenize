# ADR-015: Passage and Dominion

**Date**: 2026-07-21
**Status**: Proposed — **ratification is Larry's ad-hoc call, tracked by no task file and gated on nothing (decided 2026-08-11).** His read: the model is solid, will probably see more tweaks, and the likely moment is just before or just after the Galaxy collapse. ⚠️ **No task file may reintroduce a ratification gate for this ADR**, and `/review-task` / `/build-task` MUST NOT block on one — an earlier arrangement deferred ratification until a specific task had built, which made every re-split of that task a question about this ADR. The tasks amending it are free to land without ratifying it. ⚠️ **This is a different deferral from [ADR-016](016-record-the-acting-principal.md) — do not read the two as one**; that one is deferred past pre-alpha as a scheduling call ([ADR-019](019-derived-artifacts-record-observations.md), formerly its sibling here, was withdrawn 2026-08-26). The relevant fact here is that the text had a **line-by-line review with Larry on 2026-08-10/11** and survived a Stage-2 conformance panel, so the *model* is settled while the mechanism keeps moving — the same week's implementation-adjacent scrutiny moved it twice (a member may invite a non-admin peer at their own scope; the mint's four invariants collapsed to one), and the invite rule is still being calibrated.
**Deciders**: Larry
**Evidence**: `hasDominionOver` and `hasPassageInto` (`packages/nebula-auth/src/parse-id.ts`) — one shared expression per verdict, over the two structural containment predicates beside them; the guards that consume them (`apps/nebula/src/nebula-do.ts` `requireDominionHere`/`requirePassage`, `dag-tree.ts` `requirePermission`, the subscribe-time writers); the deletion plan (`packages/nebula-auth/src/nebula-auth-registry.ts` `#computeDeletionPlan`/`#affectedUsers`). Two violations motivated it, both since fixed: an **upward** leak, where the bare `access.admin` bit was treated as dominion anywhere rather than only where the scope covers; and a **downward veto**, where the deletion plan let a descendant scope's members refuse an admin above them.

## Context

**Coarse-grained access control is determined by three concepts — scope, dominion, and passage — working together to make lateral movement impossible while allowing certain kinds of vertical movement.**

Scopes form a strict tree: platform → universe → galaxy → star. **That hierarchy is what identifies lateral movement** — holding a scope in one branch while calling into a scope that is neither linearly above nor linearly below your own. So, the prevention of lateral movement is achieved structurally by only permitting vertical movement.

Every caller presents its `authScope`, a `scopeAdmin` bit, and the `targetScope` it is acting on, as part of every call. These are used to calculate if the call qualifies as `dominion` or `passage` — the two kinds of vertical movement that are allowed. The rest of this ADR is spent precisely specifying those calculations, explaining what a call is (and is not granted) for each kind, and elaborating on the implications of those grants.

Previously, this model was assumed everywhere and in a precise written form nowhere. An unwritten invariant of this shape is violable in two independent directions, and at each site the violation reads as sense rather than as a bug. Honouring an admin's bit wherever they happen to be reads as "an admin is an admin." Letting a scope's own members block an admin above them reads as protecting the people actually using it. Both shipped — the Evidence line above names them — and neither reviewer had a stated invariant to check against.

> **Today's code differs.** § *Decision*'s predicates read the page's scope; today's code reads the member's own (`access.authScope`), which [nebula-scope-moves-to-subdomain.md](../../tasks/nebula-scope-moves-to-subdomain.md) closes. Coverage is already a comparison over that scope rather than the bare admin bit, and a non-admin already has no passage into scopes beneath their own — but **a call to a node named `nebula-platform` is still refused outright**, so the universal passage described here does not yet hold at the root. That is a **name reservation**, not a containment gap: nothing is deployed at that name, and refusing it stops an arbitrary class occupying the most reachable name in the system. It closes when the name goes from **rejected to bound**, never by being opened.

## Decision

### Terminology

- **Scope** is the driver for coarse-grained access control. It often appears in a segment of a URL, but it can also be a parameter of a mesh call or in the body of a Request. In `https://nebula.lumenize.com/{bindingName}/{u}.{g}.{s}/`, the `{u}.{g}.{s}` would be the scope.
- **Dominion** — an *unconditional* right to act within a scope. Where it applies, nothing decided inside that scope can stand against it. **Downward only.**
- **Passage** — the right for a call to arrive at the target scope without being refused at the boundary. It confers nothing except that.

**`dominion` and `passage` are deliberately rare words.** They replaced `authority` and `admission`/`admitted`, both general enough to mean several things at once. A reader who meets `dominion` anywhere in this repo may assume this definition and nothing else. **Do not reintroduce `authority` or `admitted` as the name of either concept.** Other senses of *authority* survive: a **mint point** is where a `sub` is minted (a Universe or Star claim, an invite); [ADR-016](016-record-the-acting-principal.md)'s **authority-changing** actions are those altering *what a principal may do*, which is deliberately **broader than dominion** — a data-plane grant changes it while touching neither `scopeAdmin` nor the scope, so narrowing that trigger to dominion would drop those changes out of it; and plain English still says Studio's agent holds no authority of its own.

**There is deliberately no umbrella noun over dominion and passage, and `reach` is not to become one — in either form** (Larry, 2026-09-20). Nominalised it means passage, or dominion, or their union, or the orgTree's own grants, depending on the sentence; as a verb it is not much better, because every call in the mesh arrives at the node it names and what matters is which barriers it passes. Say the one that applies: passage at the coarse-grained boundary, dominion overriding the finer-grained checks, a grant, or refused. Where a sentence seems to want one word covering both, name both. ⚠️ "reach" is fine where it names where a request GOES rather than what it may do — the Registry is reached over HTTP, a path with no entry reaches no handler.

### Predicate pair

Who holds either, exactly, is the predicate pair below:

```
isAtOrAbove(myScope, targetScope)  — my scope covers the target: the same scope, or an
                                     ancestor of it. The reserved platform scope is the ROOT
                                     of the tree, so it is at or above every scope.
isAtOrBelow(myScope, targetScope)  — my scope sits at or beneath the target: the same scope,
                                     or a descendant of it. Every scope is at or below the
                                     platform root. Exactly isAtOrAbove with the arguments
                                     flipped: isAtOrAbove(A, B) === isAtOrBelow(B, A).

dominion(aud, scopeAdmin, targetScope) = scopeAdmin ∧ isAtOrAbove(aud, targetScope)

passage(aud, scopeAdmin, targetScope)  = isAtOrBelow(aud, targetScope)
                                         ∨ dominion(aud, scopeAdmin, targetScope)

   aud is the scope of the PAGE the call came from, derived server-side from its Origin
   and never named by the client. scopeAdmin still comes from the membership the token
   rests on. A page therefore acts within its own scope and below, not within everything
   its holder's broadest membership covers.
```

**One implementation.** Every site needing either verdict calls the shared predicate against the scope it is acting on, rather than re-inlining ([ADR-007](007-shared-node-security-core.md)) — which is what made both violations in § *Context* fixable in one place instead of N. The symbols are `hasDominionOver(access, targetScope)` and `hasPassageInto(access, targetScope)`.

**Those signatures take two arguments where the predicates take three**, because two of the three arrive together: `authScope` and `scopeAdmin` are both fields of the caller's `access` claim, so they are passed as that one claim. `targetScope` is passed separately.

**Scope comparisons are hierarchical by dot-separated segments**, so `u.g.s1` does not cover `u.g.s10`, and `acme` does not cover `acme-2` — the second is the one a naive `startsWith` gets wrong.

**The bare `scopeAdmin` bit is never dominion, and neither is position without it** — dominion is the conjunction, and reading either operand on its own is a bug.

**Passage gets a call past a callee's outer boundary and no further.** What happens after that is the callee's own decision. Reads are often generously granted, writes are almost always further restricted.

These things follow:

- **The two nest: dominion implies passage**, since you cannot act somewhere you cannot arrive. So for any call, passage is never the smaller set, and what it adds is everything at-or-above that caller's own scope.
- **Passage at the platform scope is universal**, because the upward arm asks `isAtOrAbove('_platform', anything)` and the root satisfies it for everyone.
- **Nobody holds dominion at the platform scope**, because `isAtOrAbove(aud, '_platform')` holds only when the PAGE is at the root — and [ADR-022](022-every-session-lives-on-the-platform-host.md) gives no page a token there. A superuser's membership still sits at the root, which is what grants them a token on every host and passage everywhere; what it no longer does is carry dominion over the whole tree in one call. They administer every scope, one page at a time.
- **Dominion over a scope is total and non-vetoable.** No finer-grained permission mechanism in that scope can veto, block, or attenuate a `scopeAdmin` above them. The Resource orgTree is the worked example: a covering scopeAdmin acts there with no grant ever written (`apps/nebula/src/dag-tree.ts` `requirePermission`). Anything added later inherits this without being asked. Where an action is destructive or surprising, the restraint is a **UI warning carrying the information needed to decide**, never a refusal in the authorization layer.
- **A scope's finer-grained mechanisms decide for callers *without* dominion.**
- **Lacking dominion is not a denial.** A caller with passage but no dominion may still be granted a great deal by the methods it calls, as decided by the callee's own guards.

## Alternatives considered

- **Let members block deletion of a shared scope.** The status quo before this ADR. Protects real users from a careless admin, but inverts the model: it makes dominion conditional on the consent of those it governs. In the case of Star self-signup it also becomes an attack — a squatter holds a slug hostage precisely because they are an "other user."
- **A narrow carve-out: only unblock when the scope has a single member.** Proposed and rejected 2026-07-21. It treats the symptom; the veto is wrong for every descendant, not just the single-member case, and a predicate carve-out leaves the inverted principle in place to resurface elsewhere.
- **Close the upward leak by tightening `requirePassage`'s tenant branch.** Rejected: that branch is passage, not dominion. Narrowing it breaks legitimate non-admin upward reads (a Star fetching its app's ontology) while leaving the actual defect — guards trusting a bare bit — untouched. ⚠️ **This row is retired by [`tasks/nebula-passage-dominion-from-scope.md`](../../tasks/archive/nebula-passage-dominion-from-scope.md), and the retirement is not a reversal.** That work changed the branch's *input* from the client-chosen `aud` to the server-trusted scope, which refuses the descendant case while preserving the upward read this row defends. ⚠️ **§ *Decision* now reads `aud` again, and that is not a reversion**: `aud` is no longer client-chosen — it is the page's scope, taken from its `Origin` by the server ([ADR-022](022-every-session-lives-on-the-platform-host.md)) — so the input stays server-trusted and merely gets narrower — `docs/vision/auth.md` § *Coarse-grained access control* (`accepted`) carries that read as its own table row. The branch survives; only what it compares changes.
- **Rely on review to catch violations.** Empirically insufficient: both violations survived multiple passes, and a third was proposed during the very session that fixed the second.

## Consequences

- **Positive.** Two predicates to audit instead of a scattered conjunction. Open Star self-signup becomes implementable: a star-scoped admin's scope is inert above its own Star by construction, which is what makes an unauthorized signup safe. Remediation works: a covering admin can always clean up beneath them.
- **Negative / accepted.** A careless admin can destroy a descendant scope that other people are actively using; the only protection is whatever warning the UI provides. That is deliberate, and the reason is not only that the alternative inverts the model. A Universe or Galaxy admin stands to their tenancy roughly as we stand to our own Cloudflare account: anyone holding broad access can do very nearly anything, and the discipline lives in **who you hand it to**, never in what the platform will permit once they hold it. These admins have their own customers to serve, and cannot administer that relationship through a platform that second-guesses them. What it does raise is the stakes on delete-confirmation UX, which must carry enough context (attached users, last login, activity) for an informed decision. `docs/vision/auth.md` § *Why downward is generous for admins* is the fuller argument.
- **Deliberately open.** Which methods restrict who may call them is a per-method guard decision (§ *Decision*), not covered here. An allocation inherited from before a tier existed is a latent trap: re-confirm each non-admin `@mesh()` on an ancestor against who can actually reach it today, and record the reason.
