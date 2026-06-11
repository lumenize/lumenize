# ADR-005: Optimistic Concurrency via Forward-Only eTags

**Date**: 2026-06-11 (records the concurrency commitment, in force since Resources shipped; idempotency semantics hardened 2026-06-10)
**Status**: Accepted
**Deciders**: Larry
**Evidence / history**: `apps/nebula/src/resources.ts` (eTag checks, monotonic pre-checks, in-transaction idempotency), `website/docs/nebula/resources.md` (conflict handlers), `tasks/nebula-frontend.md` § 5.3.7 + `tasks/factory-conflict-outcome.md` (client outcome state machine)

## Context

Writers are browsers with debounced auto-submit (and LLM agents) that disconnect, retry, and race each other; the server is a single-threaded DO per Star. A lock held by a vanished browser is poison; last-write-wins silently destroys data. The platform needed one concurrency story covering conflict detection, retry safety (idempotency), and merge — without ever making user-developers learn those words.

## Decision

**Writes are optimistic and prove currency with eTags; eTags move forward only and double as the idempotency mechanism. No locks, no leases, no separate dedupe ledger.**

- Every write names the eTag it read (expected) and the eTag it will create (`newETag`, client-supplied). An expected-eTag mismatch is a conflict — never a silent overwrite.
- eTags are forward-only: once a resource moves past an eTag, nothing takes it back. That makes "this batch already committed" and "this eTag is stale" *monotonic* conclusions — true forever once observed.
- **Idempotency = `newETag` replay detection.** A retried transaction whose `newETag` is already committed (any resource of the batch at `newETag` ⇒ the atomic batch committed) short-circuits to success. No idempotency keys, no dedupe table — the eTag already uniquely names the transition, and a ledger would trade a narrow limitation for a constant per-transaction write cost.
- Conflicts surface as transaction outcomes resolved by handlers (per-call → per-type → framework default), with the common-ancestor `base` snapshot available for 3-way merge (ADR-004).
- **Corollary — the monotonic pre-check rule:** a fast-fail check *outside* the transaction is permitted only when its conclusion is monotonic (replay-already-committed, eTag-conflict). Non-monotonic conclusions — permission denied, not-found — stay authoritative *inside* the transaction, because they can flip concurrently (an admin grants mid-flight).

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Pessimistic locks / leases | A disconnected browser holding a lock blocks everyone; lease tuning just trades that against spurious lock loss. Optimism holds no state that can leak. |
| Last-write-wins | Silent data destruction, invisible to the user-developer it happens to. |
| Server version numbers + separate idempotency keys (dedupe ledger) | Two concepts where one suffices, plus a guaranteed extra write per transaction to dedupe rare replays. |
| CRDTs (as the concurrency model) | Convergence without authority doesn't fit schema-validated resources behind permission checks; the Star's single-threaded ordering already provides authority. Not a ban: field-level CRDTs (e.g. large collaborative text) may layer in later — a CRDT-merged field would still commit through an eTag'd snapshot write. |

## Consequences

### Positive
- Retry is safe by construction: client loops (reconnect, conflict resolution) lean on replay idempotency instead of exactly-once delivery — which one-way messaging (ADR-003) cannot provide anyway.
- Monotonic pre-checks give cheap fast-fails against already-read state with zero correctness risk and zero extra reads.
- User-developers see outcomes and handlers; eTags stay under the hood of the frontend factory.

### Negative
- Replay idempotency is load-bearing on every write path; a path that misses the `newETag` short-circuit turns honest retries into spurious "already exists"/conflict errors. Exactly this was found and fixed in the 2026-06-10 design review — create-replay is now test-verified, and the full replay matrix is tracked in `tasks/nebula-frontend.md` § Phase 5.3.8.
- Replay detection recognizes "the same transaction, retried" but not "two writers creating the same resource" — distinct concurrent creates carry different `newETag`s, so the loser surfaces as a failure the client surface must disambiguate. An inherent limit of eTag-as-idempotency, not a bug.
- Replay protection depends on `newETag` *stability*: the same value must be reused across retry attempts. Regenerating per attempt downgrades a would-be replay into a conflict/already-exists outcome — still safe (forward-only eTags prevent silent double-commit), just noisier. The TS signature makes omission fail fast at compile time; the frontend factory owns stability for Nebula UIs.
