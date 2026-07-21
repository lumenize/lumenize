# ADR-015: Scope Authority Flows Strictly Downward

**Date**: 2026-07-21
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: `hasAdminOverScope` (`packages/nebula-auth/src/parse-id.ts`) — the single expression of both halves; the guards that consume it (`apps/nebula/src/nebula-do.ts` `requireAdmin`/`enforceScopeReach`, `dag-tree.ts` `requirePermission`, the subscribe-time writers); the deletion plan (`packages/nebula-auth/src/nebula-auth-registry.ts` `#computeDeletionPlan`/`#otherUsers`); the two violations and their fixes in `tasks/nebula-confine-admin-bypass.md` and `tasks/nebula-star-founder-provisioning.md`.

## Context

Scopes form a strict tree: universe → galaxy → star. Every principal carries an `authScopePattern` naming the subtree it governs (`*`, `{u}.*`, `{u}.{g}.*`, or an exact star id).

The authority model this implies was **assumed everywhere and written down nowhere** — and unwritten invariants are the ones that get violated. Two independent violations shipped, in opposite directions:

- **Upward leak.** `requireAdmin`, `requirePermission`, and the subscribe-time writers keyed on the bare `access.admin` bit with no reference to which node they were running in. Since `enforceScopeReach`'s tenant branch deliberately *admits* a caller whose `aud` sits below a node, an admin of a child scope acted as admin on its ancestors — reachable by narrowing a `/delegated-token` mint.
- **Downward veto.** `#computeDeletionPlan` refused a covering admin's deletion whenever any identity with a different email was attached to the target, letting a scope's own members overrule an admin above them.

Both passed review repeatedly because each looked locally reasonable. The upward leak read as "an admin is an admin." The downward veto read as "don't let an admin wipe a scope real people are using." Neither reviewer had a stated invariant to check against.

## Decision

**Authority flows strictly downward along the scope tree, and only downward.**

1. **Downward is total and non-vetoable.** A principal whose `authScopePattern` covers a node has full authority over that node and everything beneath it. Descendants — including a scope's own founder or members — can never veto, block, or attenuate an admin above them. Where an action is destructive or surprising, the restraint is a **UI warning carrying the information needed to decide**, never a refusal in the authorization layer.

2. **Upward is nil.** A principal has **no** authority over any node its pattern does not cover. The bare `admin` bit is never authority by itself; authority is always the pair (`admin` ∧ pattern-covers-this-node).

3. **Admission ≠ authority.** Being *admitted* to a node may legitimately flow upward — a member of a child may reach its parent to read tenant-facing surfaces. That admission grants no authority there. Which reads are tenant-facing is decided per method by its guard, not by narrowing admission.

**Mechanism (current):** `hasAdminOverScope(access, node)` is the single predicate expressing points 1 and 2; every guard delegates to it rather than re-inlining the conjunction (ADR-007).

## Alternatives considered

- **Let members block deletion of a shared scope.** The status quo before this ADR. Protects real users from a careless admin, but inverts the model: it makes authority conditional on the consent of those it governs. Under open Star self-signup it also becomes an attack — a squatter holds a slug hostage precisely because they are an "other user."
- **A narrow carve-out: only unblock when the scope has a single founder.** Proposed and rejected 2026-07-21. It treats the symptom; the veto is wrong for every descendant, not just the single-member case, and a predicate carve-out leaves the inverted principle in place to resurface elsewhere.
- **Close the upward leak by tightening `enforceScopeReach`'s tenant branch.** Rejected: that is admission, not authority. Narrowing it breaks legitimate non-admin upward reads (a Star fetching its app's ontology) while leaving the actual defect — guards trusting a bare bit — untouched.
- **Rely on review to catch violations.** Empirically insufficient: both violations survived multiple passes, and a third was proposed during the very session that fixed the second.

## Consequences

- **Positive.** One predicate to audit instead of a scattered conjunction. Open Star self-signup becomes implementable: a star founder's exact-star pattern is inert above its own Star by construction, which is what makes an unauthorized signup safe. Remediation works: a covering admin can always clean up beneath them.
- **Negative / accepted.** A careless admin can destroy a descendant scope that other people are actively using; the only guard is the warning surface. That is deliberate — the alternative inverts the model — but it raises the stakes on delete-confirmation UX, which must carry enough context (attached users, last login, activity) for an informed decision.
- **Deliberately open.** Which reads are tenant-facing is a per-method guard decision (point 3), not covered here. An allocation inherited from before a tier existed is a latent trap: re-confirm each non-admin `@mesh()` on an ancestor against who can actually reach it today, and record the reason.
