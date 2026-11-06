# `validFrom` is a resource's only version

**Status:** Pass 1, drafted 2026-11-06 for Larry's read; phases not written. Nothing gates it, and the pre-alpha roadmap waits behind it (Larry, 2026-11-06). It changes the `Snapshots` schema, so in [nebula-pre-alpha.md](nebula-pre-alpha.md)'s vocabulary it is `data`-gated and lands before the wipe.

## Objective

**Each committed write gets one moment, which the server assigns as it commits, and that moment, the snapshot's `validFrom`, is the only version a resource has.** It orders every change in a Star, a writer names it to prove it read the current snapshot, and it fills any field an outside protocol wants a version in.

A moment is an ISO 8601 millisecond string, the form [ADR-011](../docs/adr/011-iso-timestamps.md) gives every timestamp: `2026-11-06T15:09:41.007Z`. Here is one put, today and after:

```ts
// Today: the client mints the new version and sends it
transaction(ontologyVersion, 'b3c1e7d0-…', {        // newETag, the new version
  'todo-1': { op: 'put', eTag: '9f2e41aa-…', value }, // the version it read
})
// → { ok: true, eTags: { 'todo-1': 'b3c1e7d0-…' } }
// stored: eTag 'b3c1e7d0-…', validFrom '2026-11-06T15:09:41.007Z'

// After: the server mints it
transaction(ontologyVersion, {
  // the version it read
  'todo-1': { op: 'put', validFrom: '2026-11-06T15:04:05.123Z', value },
})
// → { ok: true, validFroms: { 'todo-1': '2026-11-06T15:09:41.007Z' } }
// stored: validFrom '2026-11-06T15:09:41.007Z', and no eTag
```

The field names in the second half are Q3's recommendation.

## Context

**Why now.** The MCP Resource Events proposal ([experimental-ext-triggers-events#19](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/pull/19)) asks three things of a server's changes: a moment for each that sorts (its R3), one moment for a write that touches several resources (R4), and a catch-up that returns every resource changed after a moment the client names. Resources is close. The server already stamps `validFrom`, it is already a string that sorts, and [ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) already makes history the substrate. Larry put the pre-alpha roadmap on hold to do this first, because it serves both strategies he is weighing: Nebula, and an open-source framework with Resources included.

Three things in `snapshots.ts` stand in the way:

1. **Coalescing keeps a write's old moment.** `#writeSnapshot` overwrites the current snapshot in place when the same actor writes within an hour of its `validFrom` (`if (withinWindow && sameActor)`), so the row keeps its key and its `validFrom`. Two writes then share one moment, which is why each write also carries an `eTag`: it is the only field that changes. In a batch, a resource that coalesces keeps its old `validFrom` while a sibling that doesn't gets the new one, so one write ends up with two moments.
2. **A moment is unique per resource, not per Star.** `#calculateValidFrom` moves `Date.now()` past the batch's own current snapshots only, so two transactions on different resources in one millisecond share a `validFrom`. The backlog's *`validFrom` global monotonicity* row has tracked this since 2026-06-30.
3. **A moment is picked before the validator's `await`, so commit order and moment order can disagree.** Step 2 of `transaction` picks it, Step 5 awaits `facet.parseBatch`, and Step 10 writes it. Say transaction T1 picks `…:05.100Z` and awaits. T2 arrives, picks `…:05.101Z`, needs no validation because it is a delete, and commits. T1 then commits at `.100`. A reader that has seen `.101` and asks for changes after it never sees T1.

**Why the eTag goes too.** The client mints it: `newETag` is a UUID from `crypto.randomUUID()`, and the server stores it as the version. Larry's second MCP prototype, `resource-webhooks-on-events`, showed that keeping eTag semantics alive beside moments costs more than it buys, and that the code got clearer once moments were the version (Larry, 2026-11-06). So the server mints the only version, and the code says `validFrom` throughout. An eTag-like field appears only where an outside protocol expects one, and `validFrom` fills it.

The sections below set what the build must make true, what exists now and what becomes of each part, the constraints, and the four questions that gate the phases.

## Goals

1. **One write gets one moment, and no other write in the Star has it.** Every resource a transaction writes gets the same `validFrom`, so a moment names a write. Today coalescing splits a batch's moments, and uniqueness stops at the resource (Context items 1 and 2).
2. **Moments sort in commit order.** A reader that has seen a moment and asks for later changes misses nothing. Today a moment is picked before the validator's `await` (item 3).
3. **Only the server mints a version.** Nothing a client chose is stored as a version. Today `newETag` comes in through the door, `transaction(ontologyVersion, newETag, ops)`, and lands in the `eTag` column, and `studio-client.ts` mints one for each message it posts.
4. **Every committed write is a snapshot.** History holds each write, so undo, audit and a merge base can find any version. Today a same-actor write within the hour overwrites the one before it.

## Relationships

- **Gated by:** nothing. The `data` gate orders it before the wipe.
- **Gates:** a Lumenize implementation of Resource Events, which has no task file yet, and the deferred query-subscription delta catch-up, whose server half is the backlog's *`validFrom` global monotonicity* row.

## Current state

Built already, each part with its fate:

- **The `Snapshots` table**, keyed `(resourceId, validFrom)` `WITHOUT ROWID`, with the partial index `idx_Snapshots_current` on `(resourceId, validTo)`. *Adapted:* the `eTag` column goes, and an index on `validFrom` arrives if Q1 goes as recommended.
- **`#calculateValidFrom`.** *Replaced:* the moment is taken inside `transactionSync`, from the marker (Design intent 1).
- **Coalescing:** the in-place `UPDATE` in `#writeSnapshot`, `coalesceWindowMs` in `#bootstrapConfig`, and `identityKey`, whose only caller is the coalesce check. *Left behind.*
- **The replay checks**, Steps 4.5a and 6.5 (`authoritative.get(resourceId)?.meta.eTag === newETag`). *Left behind* if Q2 goes as recommended.
- **The conflict checks**, Step 4.5b's hint and Step 9's verdict (`current.meta.eTag !== (op as any).eTag`). *Adapted:* they compare `validFrom`. Step 9 stays the one place a conflict is decided and a `currentSnapshot` disclosed, after the Step 8 permission gate.
- **The wire types:** `SnapshotMeta.eTag`, the `eTag` on `OperationDescriptor`'s put, move and delete, and `TransactionResult`'s `eTags`. *Adapted*, under the names Q3 settles.
- **The door** in `resources.ts`, `transaction(ontologyVersion, newETag, ops)`, and the server-side writes there that send `{ op: 'put', eTag: existing.meta.eTag, value }`. *Adapted:* `newETag` leaves the signature.
- **The client engine**, `frontend/debounce.ts`: its `baselineETag` chain, `genETag`, and the `newETag` on each `QueueSubmission`. *Adapted:* the chain carries the `validFrom` each result returns. Its rule of one transaction in flight per resource is *carried over unchanged*.
- **The client's handling of results:** `#meshSubmit`'s `meshNewETag`, `#mapTransactionResult` (`const eTag = subs[0]!.newETag`), the store adapter's `applyCommit(rt, rid, eTag)`, the `meta?.eTag` reads in `create-nebula-client.ts`, and `conflict-outcome.ts`'s resubmit at `snapshot.meta.eTag`. *Adapted.*
- **Mesh's Profile `eTag`**, a ULID the server mints for each write and stores in `ProfileFields`. *Carried over unchanged*, unless Q4 says otherwise.
- **Tests and docs.** `git grep -lE '\b(eTag|eTags|newETag)\b' -- apps packages/resources` lists the tests (about 60 files under `apps/nebula/test` at the time of writing), and `grep -rl eTag website/docs` lists the docs pages that teach `meta.eTag`, which `apps/nebula/src/platform-embed.ts` embeds for Studio. *Adapted.*

## Design intent

1. **A transaction's moment is assigned as it commits.** Inside `transactionSync`, the moment is the later of `Date.now()` and the marker plus one millisecond. Every snapshot the transaction writes gets it, and the marker becomes it. A Durable Object runs one `transactionSync` at a time and the marker only moves forward, so moments are unique in the Star and sort in commit order. With the marker at `15:09:41.007Z` and `Date.now()` pinned at the same millisecond, the next write gets `15:09:41.008Z`.
2. **The marker is the Star's latest moment.** The next moment starts from it, and later a catch-up hands it back as the client's next cursor. Whether it is read from an index or stored is Q1.
3. **A writer proves it read the current snapshot by naming that snapshot's `validFrom`.** A put, move or delete names it, and a mismatch is a conflict, decided at Step 9 as today. A create still asserts that the resource does not exist. ADR-005's rule for checks outside the transaction carries over: a resource whose `validFrom` has moved past the op's never moves back, so Step 4.5b may still skip a doomed validation.
4. **Every committed write is a snapshot, and the client's debounce sets how many there are.** The engine's default quiet window (500 ms) and maximum wait (2 s) keep keystrokes from becoming versions, and the server keeps whatever arrives. The cost lands on writes that coalesce today. An in-place update writes 1 row; a new snapshot writes 4: it closes the old row, inserts the new one, and moves the partial index's entry out and in. An index on `validFrom` (Q1) makes it 5. At $1.00 per million rows written (`durable-objects.md` § *SQLite write-cost optimization*), an hour of steady typing that submits every 2 s costs about $0.009 instead of $0.0018.
5. **Only the server mints a version, and an outside protocol's version field is filled from it.** `newETag` leaves the door, the engine and storage. An HTTP `ETag`, the strawman's `revision` or an MCP resource's revision would carry a `validFrom`; nothing serves one today. A collection's version is the marker, because a resource leaving the collection moves the marker without moving the latest `validFrom` among the resources left.
6. **A transaction repeated after it committed is a conflict.** Its put, move or delete names a `validFrom` the resource has since moved past, and its create finds the resource already there. Nothing commits twice, and the safety comes from the precondition, as ADR-005's own consequences say, not from the replay check. Whether the server should also recognize a repeat and answer `committed` is Q2.

These claims carry the design, and each can be checked:

- **C1. A client learns its own write's moment only from the result.** Resource fanout skips the client that wrote (`#broadcast`'s `if (row.clientAddress === originatorAddress) continue;`), so no fanout of a client's own write races its result.
- **C2. A version the server mints costs the client no extra wait.** The engine keeps at most one transaction in flight per resource and advances `baselineETag` only on a commit, so it already waits for each result before it sends that resource's next write.
- **C3. No shipped client path sends a transaction again after it committed.** Mesh never re-sends a message once sent (`#sendOrQueue`'s comment, "a message already SENT is never replayed"). Across a reconnect, the engine keeps the original `callAsync` waiting rather than firing a new one (`setConnectionState`, and the debounce test that asserts "(A): NO re-fire"). `#versioned` re-sends only after a `checking` refusal, which ran nothing. The engine's header still says an in-flight submission "replays with its SAME `newETag`", which predates that.
- **C4. Only a wipe deletes `Snapshots` rows**, and it drops the whole table (`#wipe`'s `DROP TABLE IF EXISTS`), so while the table stands its latest moment stays in it.

## Constraints

- **[ADR-005](../docs/adr/005-optimistic-concurrency-etags.md) (Accepted) is superseded.** This task writes its successor as a `Proposed` ADR: `validFrom` proves currency, only the server mints it, and a repeat is a conflict. During pre-alpha no ADR is ratified, and Larry reads it himself (`docs/adr/README.md` § *The ratification gate*).
- **[ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) (Accepted) is amended.** Its *Granularity is the meaningful version, not the keystroke* bullet goes, and so does the reason it gives for a client-held merge base. Its core, history as the substrate and `[validFrom, validTo)` intervals that tile time, stays.
- **[ADR-006](../docs/adr/006-resources-reference-by-id.md)**'s transaction bullet names `newETag`, and that clause changes.
- **[ADR-010](../docs/adr/010-random-opaque-keys.md) governs keys, and a version is not a key**, but its three reasons against a server counter apply to a version as well. The client must wait to learn it, which C2 answers. A retry cannot get the same one back, which Design intent 6 answers. And a client cut off mid-write cannot tell whether its write landed, which is already so: a lost result times out, and the engine rolls the write back and reports it `retryable` (`#meshSubmit`'s JSDoc).
- **[ADR-011](../docs/adr/011-iso-timestamps.md):** moments stay fixed-width ISO strings from `toISOString()`, so a moment moved forward by a millisecond still sorts as a string.
- **`durable-objects.md` § *SQLite write-cost optimization*** prices every row and index entry this task adds.
- **The `data` gate.** Prod still serves `ada3f31`, deployed 2026-07-04, behind the one wipe, so the schema changes without a migration.

## Future state

- **The catch-up read** scans the `validFrom` index from the client's moment, keeps current snapshots and tombstones, and hands back the marker as the next cursor. A Resource Events implementation and the deferred query-subscription delta both build on it. ⚠️ Design consideration: a `.dev` wipe drops `Snapshots`, so a cursor from before it names nothing, and the read should tell its client to drop what it holds.
- **Compaction** brings coalescing back as a batch job that folds a same-actor run of snapshots into its last one, only behind a catch-up cutoff, so a catch-up stays exact. ⚠️ Design consideration: it rewrites history older than the cutoff, never the current snapshot.
- **A merge base from history.** With every write kept, history holds the version a writer diverged from, so the conflict resolver could look it up instead of holding it. This task leaves the base where it is, held by the client.
- **Recognizing a repeat stays possible.** A write path that retries on its own, such as an MCP client over HTTP that lost an answer, may need Q2's option (b). ⚠️ Design consideration: keep Step 9 the one place a conflict is decided, so a recognition check can sit just before it.

## Decisions

Started at the gate; only what is settled.

| ID | Decision | Rejected alternative — why |
|---|---|---|
| D1 | No coalescing: every committed write is a snapshot. Coalescing may return later as compaction behind a catch-up cutoff (Larry, 2026-11-06). | **Delayed coalescing now:** it needs a catch-up cutoff, which does not exist yet. **A short-term detailed log beside `Snapshots`:** a second timeline to keep in step. **Moving `validFrom` forward on a coalesced write:** the window would slide for as long as the actor kept typing, and history would date the earlier value at the later moment. |
| D2 | Only the server mints a version, and the version is `validFrom` (Larry, 2026-11-06). | **A client-supplied `newETag`** (ADR-005): the client chooses what is stored as the version. **Server version numbers plus idempotency keys:** ADR-005 rejected these as two concepts where one suffices, and that still holds. |
| D3 | A field an outside protocol wants a version in is filled from `validFrom`, and everywhere else the code says `validFrom` (Larry, 2026-11-06). | **Keeping an `eTag` column or alias for compatibility:** a second name for the version to keep in step, the complexity the second MCP prototype shed. |
| D4 | The Star's latest moment is called the marker (Larry, 2026-11-06). | **High-water mark**, the backlog row's term: Larry prefers marker. |

## Open questions

- **Q1. Is the marker read from an index on `validFrom`, or stored?**
  - **(a) Read from an index**, `idx_Snapshots_validFrom` on `(validFrom)`, as `MAX(validFrom)` once each time the Durable Object starts, then kept in memory. With coalescing gone, a row's `validFrom` never changes, so the index costs one write per resource written and none after.
  - **(b) Stored**, as one key written in every transaction. Larry leaned this way in the 2026-06-30 row ("probably correct regardless"), when coalescing still rewrote rows in place.
  - **The counts.** A one-resource write costs 5 rows either way. A write of N resources costs 5N under (a) and 4N + 1 under (b). Once the catch-up read exists, (b) needs the index too, and a one-resource write then costs 6 under (b) and still 5 under (a).
  - **Recommendation: (a).** It writes nothing that only restates the timeline, and the catch-up needs its index anyway.
- **Q2. Does the server recognize a transaction repeated after it committed?**
  - **(a) No.** A repeat is a conflict, or "already exists" for a create (Design intent 6). By C3 nothing in the shipped client repeats one, so no client sees a new conflict.
  - **(b) Yes, by what it wrote.** Every resource in the batch holds the value the repeat sends, the stored actor's identity matches the caller's, the resources share one `validFrom`, and each one's previous `validFrom` is the one its op names. The server then answers `committed` with that moment. It compares values in their stored form, after the validator fills `@default`s, and it keeps `identityKey`.
  - **(c) A client-supplied idempotency key** for each transaction: `newETag` by another name, stored so it can be checked.
  - **Recommendation: (a).** (b) waits for a write path that retries (Future state).
- **Q3. What do an op and a result call the version?**
  - **The op's field is `validFrom`**, one-for-one with today's op `eTag`, which already meant "the version I read" while `newETag` meant the new one.
  - **The result's map is `validFroms`**, keyed by resource id, one-for-one with today's `eTags`. It stays a map because a move to the node a resource is already on writes nothing and keeps its old `validFrom`.
  - **Recommendation: both as above.** Each reuses the snapshot's own field name, so no term is new. The risk is that `validFrom` on an op reads as the moment the op takes effect, so the docs say what it is wherever they teach an explicit op.
- **Q4. Does Mesh's Profile move to a moment too?**
  - Nothing sends a Profile's ULID back. Profile writes are last-writer-wins, and the client compares the ULID only to `NEVER_WRITTEN_ETAG` (`mesh-client.ts`, `#profilesNeverWritten`). The store reads `meta.eTag` for writes only under `store.resources`, so this task does not force a Profile change.
  - **Recommendation: a backlog row**, so this task stays inside Resources and its client. That row would give a Profile's version a moment and its never-written sentinel a name, which is a new term.
