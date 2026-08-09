# ADR-015: Dominion Flows Strictly Downward

**Date**: 2026-07-21
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: `hasAdminOverScope` (`packages/nebula-auth/src/parse-id.ts`) — the single expression of both halves; the guards that consume it (`apps/nebula/src/nebula-do.ts` `requireAdmin`/`enforceScopeReach`, `dag-tree.ts` `requirePermission`, the subscribe-time writers); the deletion plan (`packages/nebula-auth/src/nebula-auth-registry.ts` `#computeDeletionPlan`/`#affectedUsers`). Two violations motivated it, both since fixed: an **upward** leak, where the bare `access.admin` bit was treated as dominion anywhere rather than only where the scope covers; and a **downward veto**, where the deletion plan let a descendant scope's members refuse an admin above them.

## Terminology — this ADR is the definition home

**Dominion is a CONJUNCTION, and stating it bit-first is how it gets violated.** A principal has **dominion** over a node when it holds the `scopeAdmin` bit **and** its own scope covers that node. Never the bit alone; never coverage alone.

- **Dominion** — the right to *act* on a node. Total where it applies, and **downward only** (that is this ADR's decision, not part of the definition).
- **Passage** — the right for a call to *reach* a node's boundary without being refused there. It confers nothing. Passage may run upward freely; dominion never does.

⚠️ **`dominion` and `passage` are deliberately rare words, and that is their whole value.** They replaced `authority` and `admission`/`admitted` on 2026-08-09 because both were general enough to mean several things, and the ambiguity cost real bugs — the two violations below among them. A reader who meets `dominion` anywhere in this repo may assume this definition and nothing else. **Do not reintroduce `authority` or `admitted` as the name of either concept.**

**Three neighbouring uses of "authority" survive, and none of them is dominion:**

- **Mint point** — a place in a flow where a `sub` is minted (Universe/Star claim, invite). Formerly "authority point"; renamed in the same pass, because it is the *source-of-identity* sense, unrelated to scope.
- **The authority principal** — [ADR-016](016-record-the-acting-principal.md)'s term for the token's `sub` as opposed to its `act` chain. A different question (*which principal?*), deliberately keeping its own name.
- **Plain English** — e.g. Studio's agent "holds no authority of its own". Unavoidable, and harmless once the two terms above are reserved.

**Mechanism note.** Coverage is expressed today as a derived wildcard pattern (`access.authScopePattern` matching the node). [`tasks/nebula-reach-from-scope.md`](../../tasks/nebula-reach-from-scope.md) replaces that with `isAtOrAbove(myScope, node)` over the member's scope carried verbatim. **The definition above survives that swap** — it is stated over "covers", which both mechanisms implement — which is what makes it a commitment rather than an implementation detail.

## Context

Scopes form a strict tree: universe → galaxy → star. Every principal carries a scope naming the subtree it governs.

The dominion model this implies was **assumed everywhere and written down nowhere** — and unwritten invariants are the ones that get violated. Two independent violations shipped, in opposite directions:

- **Upward leak.** `requireAdmin`, `requirePermission`, and the subscribe-time writers keyed on the bare `access.admin` bit with no reference to which node they were running in. Since `enforceScopeReach`'s tenant branch deliberately grants *passage* to a caller whose `aud` sits below a node, an admin of a child scope acted as admin on its ancestors — reachable by narrowing a `/mint-narrower-token` mint.
- **Downward veto.** `#computeDeletionPlan` refused a covering admin's deletion whenever any identity with a different email was attached to the target, letting a scope's own members overrule an admin above them.

Both passed review repeatedly because each looked locally reasonable. The upward leak read as "an admin is an admin." The downward veto read as "don't let an admin wipe a scope real people are using." Neither reviewer had a stated invariant to check against.

## Decision

**Dominion flows strictly downward along the scope tree, and only downward.**

1. **Downward is total and non-vetoable.** A principal whose scope covers a node has full dominion over that node and everything beneath it. Descendants — including a scope's own members — can never veto, block, or attenuate an admin above them. Where an action is destructive or surprising, the restraint is a **UI warning carrying the information needed to decide**, never a refusal in the authorization layer.

2. **Upward is nil.** A principal has **no** dominion over any node its scope does not cover. The bare `scopeAdmin` bit is never dominion by itself; dominion is always the pair (`scopeAdmin` ∧ covers-this-node).

3. **Passage ≠ dominion.** Being granted *passage* to a node may legitimately run upward — a member of a child may reach its parent to read tenant-facing surfaces. That passage grants no dominion there. Which reads are tenant-facing is decided per method by its guard, not by narrowing passage.

**Mechanism (current):** `hasAdminOverScope(access, node)` is the single predicate expressing points 1 and 2; every guard delegates to it rather than re-inlining the conjunction (ADR-007). It is renamed `hasDominionOver` by the reach-from-scope work.

## Alternatives considered

- **Let members block deletion of a shared scope.** The status quo before this ADR. Protects real users from a careless admin, but inverts the model: it makes dominion conditional on the consent of those it governs. Under open Star self-signup it also becomes an attack — a squatter holds a slug hostage precisely because they are an "other user."
- **A narrow carve-out: only unblock when the scope has a single member.** Proposed and rejected 2026-07-21. It treats the symptom; the veto is wrong for every descendant, not just the single-member case, and a predicate carve-out leaves the inverted principle in place to resurface elsewhere.
- **Close the upward leak by tightening `enforceScopeReach`'s tenant branch.** Rejected: that branch is passage, not dominion. Narrowing it breaks legitimate non-admin upward reads (a Star fetching its app's ontology) while leaving the actual defect — guards trusting a bare bit — untouched. ⚠️ **This row is retired by [`tasks/nebula-reach-from-scope.md`](../../tasks/nebula-reach-from-scope.md), and the retirement is not a reversal.** That work changes the branch's *input* from the client-chosen `aud` to the server-trusted scope, which refuses the descendant case while preserving the upward read this row defends — `docs/vision/auth.md` § *Coarse-grained access control* (`accepted`) carries that read as its own table row. The branch survives; only what it compares changes.
- **Rely on review to catch violations.** Empirically insufficient: both violations survived multiple passes, and a third was proposed during the very session that fixed the second.

## Consequences

- **Positive.** One predicate to audit instead of a scattered conjunction. Open Star self-signup becomes implementable: a star-scoped admin's scope is inert above its own Star by construction, which is what makes an unauthorized signup safe. Remediation works: a covering admin can always clean up beneath them.
- **Negative / accepted.** A careless admin can destroy a descendant scope that other people are actively using; the only guard is the warning surface. That is deliberate — the alternative inverts the model — but it raises the stakes on delete-confirmation UX, which must carry enough context (attached users, last login, activity) for an informed decision.
- **Deliberately open.** Which reads are tenant-facing is a per-method guard decision (point 3), not covered here. An allocation inherited from before a tier existed is a latent trap: re-confirm each non-admin `@mesh()` on an ancestor against who can actually reach it today, and record the reason.
