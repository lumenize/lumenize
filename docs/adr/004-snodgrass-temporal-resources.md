# ADR-004: Snodgrass-Style Temporal Resource Model

**Date**: 2026-06-11 (records the resource-model commitment, in force since Resources shipped)
**Status**: Accepted
**Deciders**: Larry
**Evidence / history**: `apps/nebula/src/resources.ts` (`Snapshots` table, `END_OF_TIME` sentinel), `tasks/on-hold/nebula-resource-history-r2.md` (history offload, decided 2026-06-08), `.claude/rules/durable-objects.md` § SQL naming (`idx_Snapshots_current`)

## Context

Nebula apps are built agentically by user-developers who will make mistakes — and so will their LLM. A platform that destroys prior state on every write gives them no undo, no audit trail, and no way to debug "what changed, and when." Separately, conflict resolution (ADR-005) needs a common ancestor to merge against, and billing/compliance need authoritative records. The storage model had to decide whether history is an add-on or the substrate.

## Decision

**Resources are sequences of snapshots, in the style of Snodgrass's temporal databases — history is the substrate, not a feature.**

- Every write closes the current snapshot and opens a new one; `[validFrom, validTo)` intervals tile time with exactly one current snapshot per resource (`validTo = END_OF_TIME` sentinel, PK `(resourceId, validFrom)`).
- Committed history is immutable: ordinary writes never mutate or delete past snapshots, and "delete" is itself a snapshot transition.
- **Granularity is the meaningful version, not the keystroke**: a write landing within the debounce window of the current snapshot's `validFrom` updates that snapshot in place (new value, new eTag) rather than opening a new one — history records versions worth remembering, while the eTag still advances on every write (concurrency is unaffected; see ADR-005).
- Reads default to current; any committed version remains addressable — time-travel reads, audit, and the merge `base`.
- Hot storage (the Star's SQLite) keeps current + recent; deep history offloads to R2 keyed `<scope>/<resourceId>/<validFrom>`, with the Star keeping metadata (decided 2026-06-08).

This is transaction-time history — intervals record when the platform committed each version. Application-level effective dating (valid time, in Snodgrass's full taxonomy) is an app concern, out of scope here.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Mutable current-state rows, no history | Destructive writes: no undo, no audit, no merge base. Exactly the footgun-by-default we refuse to ship. |
| Current state + separate append-only event/audit log | Two representations of the truth that drift; history becomes something you reconstruct instead of something you address. |
| Event sourcing (state derived by replay) | Replay cost on read paths, painful schema migration, and "what was this resource on Tuesday?" becomes a computation instead of a lookup. |
| Per-resource history DO | Abandoned 2026-06-08 — capacity, fan-out, and cost. See the R2 design. |

## Consequences

### Positive
- Undo, audit, and "what changed" debugging are platform properties every Nebula app inherits for free.
- Conflict handlers get a true common-ancestor `base` snapshot for 3-way merge (ADR-005, textMerge).
- Replay/idempotency checks consult committed snapshots rather than a side ledger (ADR-005).
- Billing-grade record of state transitions.

### Negative
- Write amplification: writes insert rather than update, so SQLite write-cost discipline is load-bearing (compound PK, `WITHOUT ROWID`, the partial `idx_Snapshots_current` index).
- Hot storage grows without bound until the R2 offload ships — at scale the offload is required, not optional.
- Every "current" query must honor the sentinel discipline; forgetting the `validTo` filter silently reads history.
