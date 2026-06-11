# ADR-004: Snodgrass-Style Temporal Resource Model

**Date**: 2026-06-11 (records the resource-model commitment, in force since Resources shipped)
**Status**: Accepted
**Deciders**: Larry
**Evidence / history**: `apps/nebula/src/resources.ts` (`Snapshots` table, `END_OF_TIME` sentinel), `tasks/on-hold/nebula-resource-history-r2.md` (history offload, decided 2026-06-08), `.claude/rules/durable-objects.md` § SQL naming (`idx_Snapshots_current`), [original Lumenize on npm](https://www.npmjs.com/package/Lumenize) (the temporal-analytics heritage)

## Context

Two needs drove this model, and both are first-class:

1. **Time-series charting and trend analytics.** The original [Lumenize](https://www.npmjs.com/package/Lumenize) was built around exactly this — time-series transformations and trend insight over temporally modeled data — and it is a major planned Nebula feature. Questions like "how many items sat in each state on each day of last quarter" or "what did this burn-down look like" are only answerable if every resource's state is addressable at any past instant. Charting the past requires storing the past.
2. **Audit trail.** Nebula apps are built agentically by user-developers who will make mistakes — and so will their LLM. "What changed, when, and by whom" must be a lookup, not a forensic reconstruction.

A second tier of needs — undo (largely covered anyway by soft delete everywhere), the common-ancestor `base` for conflict resolution (ADR-005), billing/compliance records — could each have been solved some other way; the temporal model just solves them more elegantly, as side effects.

The storage model had to decide whether history is an add-on or the substrate.

## Decision

**Resources are sequences of snapshots, in the style of Snodgrass's temporal databases — history is the substrate, not a feature.**

- Every write closes the current snapshot and opens a new one; `[validFrom, validTo)` intervals tile time with exactly one current snapshot per resource (`validTo = END_OF_TIME` sentinel, PK `(resourceId, validFrom)`).
- Committed history is immutable: ordinary writes never mutate or delete past snapshots, and "delete" is itself a snapshot transition (soft delete).
- **Granularity is the meaningful version, not the keystroke**: a write landing within the debounce window of the current snapshot's `validFrom` updates that snapshot in place (new value, new eTag) rather than opening a new one — history records versions worth remembering, while the eTag still advances on every write (concurrency is unaffected; see ADR-005).
- Reads default to current; any committed version remains addressable — state-as-of-T reads (the substrate for time-series and trend analytics), audit, and the merge `base`.
- Hot storage (the Star's SQLite) keeps current + recent; deep history offloads to R2 keyed `<scope>/<resourceId>/<validFrom>`, with the Star keeping metadata (decided 2026-06-08).

This is transaction-time history — intervals record when the platform committed each version. Application-level effective dating (valid time, in Snodgrass's full taxonomy) is an app concern, out of scope here.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Mutable current-state rows, no history | Destructive writes: nothing to chart or audit, no merge base. Kills the analytics feature outright, and is exactly the footgun-by-default we refuse to ship. |
| Current state + separate append-only event/audit log | Two representations of the truth that drift — and a log answers "what happened," not "what was the state at T," so time-series rollups become reconstruction jobs. |
| Event sourcing (state derived by replay) | Replay cost on read paths, painful schema migration, and "what was this resource on Tuesday?" becomes a computation instead of a lookup. |
| Per-resource history DO | Abandoned 2026-06-08 — capacity, fan-out, and cost. See the R2 design. |

## Consequences

### Positive
- Time-series charting and trend analytics are a platform property: state-as-of-T, time-in-state, and trend rollups are queries over snapshots, not reconstructions — the original-Lumenize capability, available to every Nebula app.
- Audit is built in: "what changed, when, and by whom" (`changedBy` rides every snapshot) is a lookup.
- Undo falls out alongside soft delete — restoring means re-addressing a prior snapshot; nothing was destroyed in the first place.
- Conflict handlers get a true common-ancestor `base` snapshot for 3-way merge (ADR-005, textMerge), and replay/idempotency checks consult committed snapshots rather than a side ledger.
- Billing/compliance get an authoritative record of state transitions for free.

### Negative
- Write amplification: writes insert rather than update, so SQLite write-cost discipline is load-bearing (compound PK, `WITHOUT ROWID`, the partial `idx_Snapshots_current` index).
- Hot storage grows without bound until the R2 offload ships — at scale the offload is required, not optional.
- Every "current" query must honor the sentinel discipline; forgetting the `validTo` filter silently reads history.
