# ADR-008: Full Org-Tree Visibility Within a Star (Visibility ≠ Capability)

**Date**: 2026-06-30
**Status**: Accepted
**Deciders**: Larry
**Evidence / history**: `apps/nebula/src/dag-tree.ts` (`addEdge` et al. short-circuit idempotent ops *before* `requirePermission` — non-disclosing **only** because the tree is universally visible; the comment warns every such short-circuit must move *after* the check if visibility ever goes per-branch), `tasks/nebula-query-subscriptions.md` (D9 "child-of-P disclosure accepted", D14 "always disclose the denied-node set", the M7 universal-visibility assumption), `tasks/nebula-request-access.md` (the denied-node set drives the request-access flow this ADR makes coherent). Surfaced repeatedly during pre-alpha — most recently the query-subscription denied-node enumeration (2026-06-30) — and promoted from project-pins to an ADR to stop the relitigation.

## Context

Within a Star, members constantly need access they don't yet hold to get work done. The question this ADR settles: **how much of the org/permission structure can a given member see?**

A fresh contributor — or a fresh LLM session — reaches for "hide what you can't act on," applying the least-privilege reflex to *visibility* rather than to *capability*. So every feature that surfaces structure re-opens the debate: the latest was query subscriptions, where a denied query result returns the enumerated set of org-tree nodes the caller couldn't read, so the UI can prompt "request read access to these?"

The trigger insight that reframes it: **the denied-node set names only structure the client can already see.** Because the org tree is universally visible within the Star (the decision below), a denied query result enumerates nodes the caller could already read off the tree directly — what the caller lacks, and what stays enforced, is the *content* read grant, not knowledge that the nodes exist (D9: the gate is the per-id content subscribe). The request-access disclosure is safe *because of* this policy, not despite it — and it's exactly why the client can resolve "who to ask" locally with no server round-trip (`tasks/nebula-request-access.md`).

## Decision

**Visibility and capability are orthogonal within a Star: seeing an entry confers no ability to act on it.** On that basis, **the full org tree within a Star — nodes, edges, permission grants, and the identities of the admins who hold them — is visible to every member of that Star.** Members can filter the view; nothing is hidden by default.

This is not a confidentiality concession to be hardened in a later release. **Within a Star, org structure is not confidential by design** — there is no confidentiality expectation to violate, so it is not a leak to be hardened away.

- **Visibility ≠ capability.** The security boundary is enforcement at the point of action — the DAG permission check before any tree mutation, the per-resource read check before content (the membership id-set is low-value; the gate is the per-id content subscribe, D9). Secrecy of the tree was never a control we relied on.
- **The denied-node set is always disclosed** (D14). A subscriber with denials is told which nodes it can't read — never silently truncated — so the UI can non-modally offer request-access. Silent partial results are the worse failure: users can't tell a view is incomplete, can't reconcile why two people see different things, and have no path to the access they need.
- **Admin identity is included, at the same firmness as structure.** Making admins identifiable is what enables self-service "who do I ask?" — and it makes fishing-style probing *detectable* via audit logging of permission _requests_ (who asked for what, when), the load-bearing detection surface for that exposure. **That audit log is not yet built** (tracked in `tasks/backlog.md`); until it lands, abuse of admin-identity visibility is unobserved, not undetectable-by-design.
- **No per-subtree hiding.** This is the committed answer to "what if a subtree must be hidden?", not an open question: provision a **separate Star**. We do not implement per-subtree visibility flags.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Per-branch / least-privilege *visibility* (hide what you can't act on) | Produces "permission denied" dead-ends with no path forward; relitigation-by-default each time a feature surfaces structure; and it buys little — within-Star members are already trusted, and enforcement at the point of action is the real control. It would also force every existence short-circuit (`addEdge`/`removeEdge`/`deleteNode`/`undeleteNode`/`revokePermission`) to move *after* the permission check or leak existence anyway. |
| GitHub secret-teams / Slack private-channels model (broad default visibility + hideable sensitive subsets) | The hideable-subset *is* the per-subtree hiding we reject. In Nebula that need is met by provisioning a **separate Star**, which keeps the model a single rule with no per-branch visibility logic. The precedent's *default* (expose org/team structure broadly) is the part we adopt. |
| Silent truncation of denied results (show the partial, hide the denial) | Worst UX failure mode and a worse security story than disclosure: users get an incomplete view with no signal and no recourse (D14). Disclosing the denied set turns the same moment into "here's who to ask." |

## Consequences

### Positive
- **Self-service permission discovery.** "Here's who to ask" replaces the dead-end "permission denied"; the denied-node set drives the request-access flow directly.
- **One simple rule.** Legible structure, no per-branch visibility logic to build, test, or reason about.
- **Permission short-circuits stay correct.** Idempotent tree ops can return before the permission check without disclosing anything — the property `dag-tree.ts` already depends on.

### Negative / open
- **Members can enumerate the Star's permission structure and admin identities.** Accepted as intended within-Star visibility, not a leak.
- **Hard dependency: access control must be correctly enforced at the point of action — as it always has been.** That is the actual security boundary, unchanged by this ADR. This is a statement about *visibility* and **does not relax, defer, or qualify any enforcement requirement**; visibility was never a substitute for enforcement.
- **Reopen bar.** This bar governs reopening the *visibility decision* (hiding the tree, or per-subtree hiding) — reopen that only on a new attack class that maps to tree visibility *as root cause*, not on unease or "could we mitigate it." It does **not** restrict *additive* hardening that operates within the full-visibility model — audit logging, request rate-limiting, count-dampening, anomaly monitoring are always welcome and need no reopen. If per-subtree confidentiality itself ever becomes a genuine requirement (e.g. regulatory or multi-customer isolation), the path is a separate Star, or a superseding ADR — never casual relitigation.

### Considered & refuted
- **"Idempotent tree ops leak node existence via a timing/error side channel, so visibility ≠ capability fails."** Not a leak under this ADR: node and edge existence is already public to every member via the visible tree, so a side channel that reveals only already-visible structure discloses nothing new. This objection in fact *depends on* the universal-visibility premise this ADR ratifies — it is why `dag-tree.ts` can short-circuit idempotent ops before the permission check at all.

## Non-goals / out of scope

- **Cross-Star / cross-tenant visibility.** The boundary is the Star; this ADR says nothing about what's visible across Stars or up the Universe/Galaxy hierarchy.
- **Does not weaken any access-control enforcement requirement** — see the hard dependency above.
