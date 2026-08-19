# ADR-019: A Derived Artifact Records Its Observations, and Every Reader Is Re-Checked

**Date**: 2026-08-05
**Status**: Proposed — ratification deliberately **deferred past pre-alpha** (Larry, 2026-08-05), and reviewed **together with [ADR-016](016-record-the-acting-principal.md)**, its write-side mirror. ⚠️ Supersedes the general ratification gate in [README.md](README.md) § *The ratification gate* for these two. This ADR has had **no contact yet** — expect its untested surfaces to move: what granularity an observation is (resource id? snapshot? query?), and whether *any derived artifact* survives codegen. Amending it from that contact is the intended path.
**Deciders**: Larry
**Evidence**: `docs/vision/strategy.md` § *Why now*, whose headline claim is an AI that "can never read what the asking user can't read"; the multi-participant Studio thread in `tasks/nebula-galaxy-collapse-and-chat.md`, where an agent reply is persisted as a `Message` Resource and rendered to every participant; [ADR-008](008-full-org-tree-visibility.md), whose per-id content-subscribe gate is what makes two members of one Star legitimately differ in what they may read; `tasks/on-hold/nebula-request-access.md`, the climb this feeds. Prior art: Cloudflare OS's "observations" (2026-08), which re-verifies a viewer against every resource an agent touched — the same idea at a coarser control point.

## Context

Our security claim is per-**asker** and it is true: the substrate gates what the AI may read on behalf of whoever is asking. But an answer does not stay with the asker. It is **persisted, shared, and re-read** — and at that moment the artifact has outlived the authorization that produced it. Nebula answers under participant A's authority; the resulting `Message` renders to participant B, whose grants may be narrower. The substrate gated the read. Nothing gates the **re**-read.

This is not a chat defect. It is a property of every artifact an agent derives from resource reads: the Studio thread, the built-in end-user chat inside a tenant app (the one the headline claim is actually about), generated views, codegen output.

The reflex is to defer it until there is a policy and somewhere durable to put it. That inverts what is replaceable — the same inversion [ADR-016](016-record-the-acting-principal.md) names on the write side. A policy can be swapped in whenever we like; **what an artifact read cannot be reconstructed after the fact.** Every artifact written before capture exists is permanently unattributable.

A competent contributor — or a fresh LLM session — renders a shared message without re-checking, in week one. It costs nothing, nothing fails, and the failure is invisible to the author because *they* could see it.

## Decision

**Any artifact derived from resource reads records the ids of what it read — immutably, at write time — and every subsequent reader is authorized against those ids, live.** Call them the artifact's **observations**.

- ⚠️ **Store the REFERENCES, never the VERDICT.** This is the boundary against ADR-016, and it is what makes the two compatible rather than contradictory. ADR-016 forbids storing asserted authority and reading it back — a stored scope-set, [ADR-013](013-identity-profileid-resolution.md)'s security bug. Observations are not a verdict: they are the *subjects of a future check*, and the check runs **fresh, against the current reader, at the current moment**. Persist "this was derived from `r1, r7`" — **never** "A was permitted to see this."
- **The re-check is the ordinary substrate check.** No parallel authorization path, no second policy language; the same enforcement everything else already goes through (ADR-007). An observation id is an input to it, never a bypass of it.
- **Capture is the commitment; the POLICY on top is not.** What a reader sees when an observation is denied — hide the artifact, render it redacted, refuse to write it into a shared thread, or surface the denial as a request — is a product decision, swappable without reopening this ADR. Capture without a policy is still worth having; a policy without capture is impossible.
- **A denial SHOULD climb, not merely block.** The observation set names exactly which resources a reader lacks, which is the missing input to the just-in-time access request up the org tree that `strategy.md` already sells ("the security boundary from a wall into a governed, auditable membrane"). Blocking is the floor, not the intent.
- **Scope: any derived artifact, never chat specifically.** Scoping this to the Studio thread would leave the tenant-facing end-user chat — the surface the product claim is about — uncovered.
- ⚠️ **The term is "observations" because "read set" COLLIDES** with the read-set/write-set vocabulary of optimistic concurrency, which [ADR-005](005-optimistic-concurrency-etags.md) makes live in this repo.

⚠️ **The ceiling, stated so the claim stays bounded.** Once text is generated, provenance is a *claim about* the text, not a property of it: a model can paraphrase `r7`'s content into a sentence that survives redacting `r7`. This commitment **caps blast radius; it is not a proof of non-leakage** — the same discipline `strategy.md` already applies to prompt injection. Say "every reader is re-authorized against what produced this," never "an artifact cannot leak."

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Rely on per-asker gating alone** (status quo) | Correct and insufficient. It secures the read and says nothing about the artifact, which outlives it. The gap is invisible to the author, who could always see the data. |
| **Store the verdict** ("A was permitted to see this") | Exactly ADR-013's stored scope-set: it goes stale the moment a grant changes, and it answers "what was allowed then" for a question that is always "what is allowed now." |
| **Check only at write time** (refuse to answer where the current audience can't all see the sources) | The audience is **dynamic** — a participant invited tomorrow was never checked. Useful as an *additional* warning, never as the mechanism. |
| **Amend [ADR-016](016-record-the-acting-principal.md) instead of a new ADR** | Its defining clause is *never read back as an authz input*; this one's is *always read back, live*. Two opposite rules in one file, where the failure mode is a reader inheriting the wrong one. They are mirrors — write side and read side — and belong side by side, not merged. |
| **Scope it to the Studio chat** | Leaves the tenant end-user chat uncovered, which is the surface the headline security claim is about. |
| **Defer until an audit/policy mechanism exists** | Inverts what is replaceable, exactly as ADR-016 rejects on the write side. Mechanism swaps in later; observations not captured at write time are gone. |

## Consequences

### Positive
- The product claim survives sharing. "Answers only from data you may see" stops being per-request and becomes per-**reader**, which is what anyone assumes it already meant.
- The leak-prevention mechanism and the flagship request-access "membrane" story become **one mechanism** rather than two — the observation set is the input the climb was missing.
- Finer than the coarse alternative: the control point is the ReBAC substrate (per record, per relationship), not a per-service connector.
- Mechanism-independent, so the observability and audit work can consume observations without renegotiating their contents.

### Negative / mitigations
- **Artifacts grow** by an id list. Bounded by what one answer actually read, and ids are small.
- **A denied observation is a UX event that will fire in normal operation**, not an error. Handled well it is the request-access on-ramp; handled badly it is noise — which is why the policy is deliberately left out of this ADR rather than guessed at now.
- **Capture must land before the artifacts do.** Pre-alpha exposure is low (a Studio thread is an owner plus a coach or invited collaborator, rarely with differentiated grants), so this is time-sensitive for the *capture*, not urgent for the *risk* — the accurate framing, and the reason it belongs as a criterion on the work that first writes agent messages rather than as a backlog row.
