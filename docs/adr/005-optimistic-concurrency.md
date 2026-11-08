# ADR-005: Optimistic Concurrency, Versioned by `validFrom`

**Date**: 2026-06-11; mechanism 2026-11-08
**Status**: Proposed
**Deciders**: Larry
**Evidence**: `packages/resources/src/snapshots.ts` (the moment, the monotonic pre-check, recognition), `packages/resources/src/frontend/conflict-outcome.ts` (the client keeps the later version), `apps/nebula/harness/scenarios/each-transaction-gets-one-moment.ts`, `website/docs/nebula/resources.md` (conflict handlers)

## Context

Writers are browsers that debounce their own writes, and LLM agents. Both disconnect, retry and race each other. The server is one single-threaded Durable Object per Star. A lock held by a vanished browser is poison, and last-write-wins silently destroys data. The platform needs one story for detecting a conflict, making a retry safe, and merging, without a user-developer ever learning those words.

Every snapshot already carries a version: its `validFrom`, the moment its transaction committed (ADR-004). The rest of this ADR uses that one value for all three jobs.

## Decision

**Writes are optimistic and prove currency by naming the `validFrom` they read. Only the server mints a version, versions only move forward, and a repeat is recognized from what it wrote. No locks, no leases, no separate dedupe ledger.**

- **A write names the version it read.** A put on a resource read at `2026-11-08T21:04:50.588Z` sends `ifValidFromMatches: '2026-11-08T21:04:50.588Z'`. A mismatch is a conflict, never a silent overwrite. A create names no version, since it asserts the resource does not exist yet.
- **The server mints one moment per transaction, at commit.** It is the later of the clock and one millisecond past the Durable Object's latest moment. So moments only move forward, two transactions never share one, and every snapshot a transaction writes carries its moment.
- **A repeat is recognized from the snapshots it wrote.** A transaction is a repeat when the snapshot each op would have written exists, all at one moment, written by the same writer, holding the same stored value. It is told that moment and writes nothing.
- **The writer is compared by identity alone**: the subject's `sub` and the `act` chain's `sub`s (ADR-016). A re-minted token may change the rest of the claims, and a write made under impersonation is not the member's own.
- **Recognition runs before the permission and conflict checks**, so a write that landed is never refused after the fact. A resend after a revoked grant is told it committed, because it did.
- **Conflicts surface as transaction outcomes resolved by handlers**: per call, then per type, then the framework default. A handler gets a common-ancestor `base` for a 3-way merge, and **the base is client-held, not a history lookup**, so a merge never depends on how long history is kept (ADR-004).
- **The client keeps the later version.** A recognized repeat answers with the moment it first committed at, which can be older than a version a collaborator's write already brought the client. The client keeps the newer version and its value, so its next write names it.
- **Corollary — the monotonic pre-check rule.** A fast-fail check outside the transaction is allowed only when its conclusion cannot flip. "This resource has moved past the version the op names" qualifies, since versions only move forward. Permission and not-found do not, since an admin can grant mid-flight, so they stay inside the transaction.
- **A stale op skips its validator only when another writer wrote what followed the version it names.** A stale op from the same writer may be a repeat, and recognition compares its value in stored form, after the validator fills its `@default`s.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Pessimistic locks / leases | A disconnected browser holding a lock blocks everyone; lease tuning just trades that against spurious lock loss. Optimism holds no state that can leak. |
| Last-write-wins | Silent data destruction, invisible to the user-developer it happens to. |
| A client-minted `newETag` naming the version a write creates | A retry reusing it was recognized as committed, but the client chose every version. So no server moment could be the version, a regenerated `newETag` turned an honest retry into a conflict, and two tabs of one person creating one resource could not both be told it committed. Recognition from what a transaction wrote asks the client to keep nothing stable. |
| Server version numbers plus idempotency keys (a dedupe ledger) | Two concepts where one suffices, and a guaranteed extra write per transaction to dedupe rare replays. |
| CRDTs (as the concurrency model) | Convergence without authority doesn't fit schema-validated resources behind permission checks; the Star's single-threaded ordering already provides authority. Not a ban: field-level CRDTs, such as large collaborative text, may layer in later, and a CRDT-merged field would still commit through a versioned snapshot write. |

## Consequences

### Positive
- Retry is safe by construction. A reconnect, or a resend after a lost answer, is told what happened instead of being refused, which one-way messaging (ADR-003) needs, since it cannot deliver exactly once.
- A version is a moment in commit order. History sorted by `validFrom` lists commits in order, and a catch-up can ask for every resource changed after a moment.
- Monotonic pre-checks give cheap fast-fails against state already read.
- User-developers see outcomes and handlers; versions stay under the hood of the frontend factory.

### Negative
- Recognition is load-bearing on every write path. A path that skips it turns an honest retry into a spurious "already exists" or conflict.
- Recognition tells one person's tabs apart from two people. Two people creating the same resource at once are two writers, so the second is told "already exists", for the client to disambiguate.
- A repeat is recognized only while its snapshots are in hot storage. If history is compacted past them, a resend that old answers as a conflict: safe, but noisier.
- A repeat reads the snapshot each op wrote, and a stale op from the same writer pays a validator call before recognition compares it.
