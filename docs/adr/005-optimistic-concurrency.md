# ADR-005: Optimistic Concurrency and Idempotent Retries

**Date**: 2026-06-11; mechanism 2026-11-08
**Status**: Proposed
**Deciders**: Larry
**Evidence**: `packages/resources/src/snapshots.ts` (the moment, the monotonic pre-check, recognition), `packages/resources/src/frontend/conflict-outcome.ts` (what the client does with each answer, and keeping the later version), `apps/nebula/harness/scenarios/each-transaction-gets-one-moment.ts`, `website/docs/nebula/resources.md` (conflict handlers)

## Context

Writers disconnect, retry and race each other. The server is one single-threaded Durable Object. A lock held by a vanished client is poison, and last-write-wins silently destroys data. So the platform needs three things from every write:

1. **A write from an outdated version fails**, so nothing is silently overwritten. Call it a stale write.
2. **A retry changes nothing.** A client resends a write whose answer it never received. If the first attempt landed, the resend must add no second snapshot and no second broadcast to subscribers. That is idempotency in HTTP's sense, which is about the server's state alone.
3. **A retry of a write that landed is told it succeeded.** It gets the answer the first attempt got, so the client treats its write as landed, rather than as a failure to retry, resubmit or put to a person.

Every snapshot already carries a version: its `validFrom`, the moment its transaction committed (ADR-004). The Decision gets all three from that one value. Its first three sections take the needs in order, and its fourth says what the client does with each answer.

## Decision

### A stale write fails

- **A write names the version it was working from.** A put on a resource that the client believes was current at `2026-11-08T21:04:50.588Z` sends `ifValidFromMatches: '2026-11-08T21:04:50.588Z'`. A mismatch is a conflict, never a silent overwrite. A create names no version, since it asserts the resource does not exist yet. It carries the id the client minted for it (ADR-006), so a second create of that id fails as "already exists".
- **Only the server mints a version: one moment per transaction, at commit.** It is the later of the clock and one millisecond past the Durable Object's latest moment. So moments only move forward, two transactions never share one, and every snapshot a transaction writes carries its moment.
- **Corollary — the monotonic pre-check rule.** A fast-fail check outside the transaction is allowed only when its conclusion cannot flip. "This resource has moved past the version the op names" qualifies, since versions only move forward. Permission and not-found do not, since an admin can grant mid-flight, so they stay inside the transaction.

### A retry changes nothing

- **The version check already gives this.** A put, move or delete that landed moved its resource past the version it named, so its retry conflicts. A create that landed took its id, so its retry fails "already exists". Nothing is written or broadcast twice.

### A retry of a write that landed is told it succeeded

The version check alone would answer that retry with a conflict or "already exists". A client acting on that wrong answer might do the wrong thing. So:

- **The server recognizes a repeat.** It looks for the snapshot each op would have written: the one that followed the version a put, move or delete names, or a create's first snapshot. When every op's is there, all at one moment, by the same writer, holding the same stored value, it answers `committed` at that moment, which is what the first attempt was answered. It writes and broadcasts nothing.
- **Recognizing a repeat comes before the permission and conflict checks**, so neither refuses a write that landed. A resend after a revoked grant is told it committed, because it did. Only a newer ontology version comes first: a resend pinned to the old one is told it is stale.
- **Each comparison keeps a different write from being told it committed:**
  1. **The same stored value.** Two tabs of one person both hold one version. One sets the title to "Q3 plan" and commits, then the other sets it to "Q4 plan", naming the same version. Without comparing values, the second tab would be told it committed, and "Q4 plan" would be lost without a word.
  2. **The same writer.** Alice and Bob both hold one version and set the same title. Bob is not told that Alice's write was his, which matters because recognition skipped the permission check, and Bob may have no right to write at all. The writer is compared by identity alone: the subject's `sub` and the `act` chain's `sub`s (ADR-016). A re-minted token may change the rest of the claims, and a write made under impersonation is not the member's own.
  3. **One moment.** A transaction commits at one moment, so ops whose snapshots carry two moments were never this transaction.
- **A fast-fail check never gets in recognition's way.** The monotonic pre-check skips validating an op it knows will conflict, to save the work. But recognition compares an op's value as it would be stored, with the `@default`s the validator fills in. So the pre-check skips only an op that cannot be a repeat: one whose named version was followed by another writer's snapshot, or by none.

### What the client does with each answer

- **Conflicts surface as transaction outcomes resolved by handlers**: per call, then per type, then the framework default. A handler gets a common-ancestor `base` for a 3-way merge, and **the base is client-held, not a history lookup**, so a merge never depends on how long history is kept (ADR-004). How a handler merges is the frontend's, in `website/docs/nebula/resources.md`.
- **The client keeps the newest version it knows.** A recognized repeat answers with the moment it first committed at. That can be older than a version the client has since heard from a collaborator or committed itself, and the client keeps that newer version and its value, so its next write names it.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Pessimistic locks / leases | A disconnected browser holding a lock blocks everyone; lease tuning just trades that against spurious lock loss. Optimism holds no state that can leak. |
| Last-write-wins | Silent data destruction, invisible to the user-developer it happens to. |
| A client-minted `newETag` naming the version a write creates | A retry reusing it was recognized as committed, but the client chose every version. So no server moment could be the version, a regenerated `newETag` turned an honest retry into a conflict, and two tabs of one person creating one resource could not both be told it committed. Looking for the snapshots a transaction would have written asks the client to keep nothing stable. |
| Server version numbers plus idempotency keys (a dedupe ledger) | Two concepts where one suffices, and a guaranteed extra write per transaction to dedupe rare replays. |
| CRDTs (as the concurrency model) | Convergence without authority doesn't fit schema-validated resources behind permission checks; the Star's single-threaded ordering already provides authority. Not a ban: field-level CRDTs, such as large collaborative text, may layer in later, and a CRDT-merged field would still commit through a versioned snapshot write. |
| A separate server-minted version: a ULID, or a zero-padded counter | A second value doing what `validFrom` already does. Every snapshot carries its `validFrom` anyway (ADR-004), and one moment per transaction makes it unique and ordered. A ULID's random half buys uniqueness without coordination, which a single-threaded Durable Object minting every version never needs. And milliseconds are fine enough: a Durable Object handles a little over 1,000 requests a second at best, and about 410 when every request writes (ADR-018). Even past that, the one-millisecond step keeps moments unique, running briefly ahead of the clock. |

## Consequences

### Positive
- A client may resend any transaction whose answer it lost, without first asking whether it landed. One-way messaging (ADR-003) cannot deliver exactly once, so resending is how a lost write gets through.
- A version is a moment in commit order. History sorted by `validFrom` lists commits in order, and a catch-up can ask for every resource changed after a moment.
- Monotonic pre-checks give cheap fast-fails against state already read.
- User-developers see outcomes and handlers; versions stay under the hood of the frontend factory.

### Negative
- Every write path must run recognition.
- Recognition tells one person's tabs apart from two people. Two people creating the same resource at once are two writers, so the second is told "already exists", for the client to disambiguate.
- Recognition reads the snapshots it compares from hot storage, so moving history to R2 must leave a snapshot there for longer than any resend of its write could take to arrive.
- An ordinary write pays nothing for recognition. Only an op that would otherwise fail, as a conflict or "already exists", pays a read of one stored snapshot. A stale op whose next snapshot came from the same writer also pays the validator call the pre-check would otherwise skip.
