# `validFrom` is a resource's only version

**Status:** Pass 1, drafted 2026-11-06 and read by Larry the same day, who took all four open questions as recommended (D5–D8), then at the Stage 1 gate changed D4, D5 and D6 and took D9 to D11. Every finding of that first Stage 1 run is folded in or decided here. Larry's hand review began 2026-11-07, and a fresh Stage 1 runs after it; phases not written. Nothing gates it, and the pre-alpha roadmap waits behind it (Larry, 2026-11-06). It changes the `Snapshots` schema, so in [nebula-pre-alpha.md](nebula-pre-alpha.md)'s vocabulary it is `data`-gated and lands before the wipe.

## Objective

**Each committed transaction gets one moment, which the server assigns as it commits, and that moment, the `validFrom` of every snapshot it writes, is the only version a resource has.** It orders every change in the Durable Object that holds the resources, a Star or a Galaxy today. It fills any version-like field that an outside protocol wants, such as HTTP's `ETag` or the `revision` in the MCP Filesystems draft.

A moment is an ISO 8601 millisecond string, the form [ADR-011](../docs/adr/011-iso-timestamps.md) gives every timestamp: `2026-11-06T15:09:41.007Z`.

Right now, two values serve as a resource's version: (1) `validFrom`, and (2) `eTag`. The goal of this task file is to reduce that to just `validFrom`. After this change, a writer shows that it holds the most recent `validFrom` before any change is permitted.

Here is one put, today and after:

```ts
// Today: the client mints the new version and sends it
transaction(ontologyVersion, 'b3c1e7d0-…', {        // newETag, the new version
  'todo-1': { op: 'put', eTag: '9f2e41aa-…', value }, // the version it read
})
// → { ok: true, eTags: { 'todo-1': 'b3c1e7d0-…' } }
// stored: eTag 'b3c1e7d0-…', validFrom '2026-11-06T15:09:41.007Z'

// After: the server mints it
transaction(ontologyVersion, {
  'todo-1': { op: 'put', ifValidFromMatches: '2026-11-06T15:04:05.123Z', value },
})
// → { ok: true, validFrom: '2026-11-06T15:09:41.007Z' }
// stored: validFrom '2026-11-06T15:09:41.007Z', and no eTag
```

The field names in the second half are D7's.

## Context

**Why now.** The MCP Resource Events proposal ([experimental-ext-triggers-events#19](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/pull/19)) asks this of a server's changes:

1. A new moment for every change to a resource, its creation and deletion included (R2). In Lumenize Resources a change is a snapshot, and its moment is the snapshot's `validFrom`.
2. Moments that strictly increase in byte order (R3).
3. One moment for a transaction that changes several resources (R4).
4. Changes that commit in the order of their moments (R5), so once a reader has seen a moment, no change at or before it can still appear. R3 orders moments as they are minted, and R5 orders them as they become visible. A server that mints a moment, awaits, and then commits keeps R2 and R3 and still breaks R5, which is item 3 below.
5. A catch-up that returns every resource changed after a moment the client names (R13).

The proposal asks this of each timeline, its word for the ordered record of changes to a set of resources. In Resources a timeline is one Durable Object, so every resource a Star holds shares the Star's moments.

Resources is close. The server already stamps `validFrom`, it is already a string that sorts, and [ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) already makes history the substrate.

Larry put the pre-alpha roadmap on hold to do this first, because it serves both strategies he is weighing: Nebula, and an open-source framework with Resources included.

Three things in `snapshots.ts` stand in the way:

1. **Coalescing keeps a write's old moment** (against R2 and R4). `#writeSnapshot` overwrites the current snapshot in place when the same actor writes within an hour of its `validFrom` (`if (withinWindow && sameActor)`), so the row keeps its key and its `validFrom`. Two transactions [I think you got this wrong. When I suggested we switch from saying "writes" to "transaction" what I meant is that a transaction is 1 or more writes at  the same moment. They either all happened or they all failed.  We never want two transactions at the same moment. Every transaction should get a different moment.] then share one moment, so only the `eTag` tells them apart. In a transaction of several resources, one that coalesces keeps its old `validFrom` while a sibling that doesn't gets the new one, so one transaction ends up with two moments.
2. **A moment is unique per resource, not per Durable Object** (against R3). `#calculateValidFrom` moves `Date.now()` past the batch's own current snapshots only, so two transactions on different resources in one millisecond share a `validFrom`. The backlog's *`validFrom` global monotonicity* row has tracked this since 2026-06-30.
3. **A moment is picked before the validator's `await`, so commit order and moment order can disagree** (against R5). Step 2 of `transaction` picks it, Step 5 awaits `facet.parseBatch`, and Step 10 writes it. Say transaction T1 picks `…:05.100Z` and awaits. T2 arrives, picks `…:05.101Z`, needs no validation because it is a delete, and commits. T1 then commits at `.100`. A reader that has seen `.101` and asks for changes after it never sees T1. Design intent 1 takes the moment inside Steps 6–10's `transactionSync` instead, after the `await`, so transactions still validate concurrently and none waits on another's validation (D12).

**Why the eTag goes too.** The client mints it: `newETag` is a UUID from `crypto.randomUUID()`, and the server stores it as the version. [ADR-005](../docs/adr/005-optimistic-concurrency-etags.md) gives it two jobs:

1. **It proves a writer holds the current snapshot.** Once coalescing goes, `validFrom` does this alone, since no two writes share one.
2. **It lets a repeated transaction be answered `committed`.** A repeat carries the same `newETag`, and Steps 4.5a and 6.5 find it already stored. With coalescing gone, history keeps every write, so the server can recognize a repeat from the snapshots it wrote instead.

Larry's second MCP prototype, `resource-webhooks-on-events`, tried at first to keep eTag semantics alive beside moments, which added complexity, and its code got clearer once moment strings were the version (Larry, 2026-11-06). So the server mints the only version, and the code says `validFrom` throughout. An eTag-like field appears only where an outside protocol expects one, and `validFrom` fills it.

The sections below set what the build must make true, what exists now and what becomes of each part, the constraints, and the decisions taken so far.

## Goals

1. **One transaction gets one moment, and no other transaction in the Durable Object has it.** Every resource the transaction writes gets that moment as its `validFrom`. Today coalescing can give one transaction two moments, and uniqueness stops at the resource (Context items 1 and 2).
2. **Moments sort in commit order.** A reader that has seen a moment and asks for later changes misses nothing. Today a moment is picked before the validator's `await` (item 3).
3. **Only the server mints a version.** Nothing a client chose is stored as a version. Today the client mints `newETag` and the server stores it (Context, *Why the eTag goes too*).
4. **Every committed op is a snapshot.** History holds every version, so undo, audit and a merge base can find any of them, and each records its writer. Today coalescing overwrites some (Context item 1). Also, a move to the node a resource is already on writes nothing, which is a bug we found while planning this task file. It should always have created a new snapshot.

## Relationships

- **Gated by:** nothing.
- **Gates:** a Lumenize implementation of Resource Events, which has no task file yet, and the deferred query-subscription delta catch-up.
- **Builds a backlog row's server half:** the *`validFrom` global monotonicity* row's option (B), a stored key read and written in every transaction, is Design intent 1 and D5. At completion the row keeps only its client half.
- **Changes what these say**, each updated or recorded as an accepted residual:
  - The backlog's *Where we contribute: SEP-3415's Open Question 2* bullet cites `mcp-events-prototype`'s `lumenize-port.md` for why `validFrom` cannot be the cursor. Its two reasons are Context items 1 and 2, which this task removes.
  - The backlog's *Mesh's subscribe could adopt the conventions* bullet says ADR-005's eTags "come close to" an `eventId`. A write's `validFrom` does after this.
  - The backlog's *Bulk demo-data load* row writes "pre-computed `validFrom` chains" and "bypasses eTag checking". A load that chooses its own moments breaks D2, and a catch-up would miss any dated before the latest moment (Design intent 2), so the row must say where a load's moments come from, such as loading only into an empty Star.
  - The backlog's *Watch what Durable Object storage costs* row carries D9's trigger, and its *Compaction* row is one bound that trigger may open.
  - [nebula-agent-posts-as-itself-alt.md](nebula-agent-posts-as-itself-alt.md) says history keeps every state "except short-lived intermediate states that one principal coalesced". That exception goes.
  - [nebula-upgrade-universe-with-a-data-plane.md](nebula-upgrade-universe-with-a-data-plane.md)'s precondition "`coalesceWindowMs` needs a home FIRST", and its criterion that `coalesceWindowMs` "survives the deletion with a named home", dissolve if this task lands first.

## Current state

Built already. Each part's fate follows its name in parentheses: *carried over unchanged*, *adapted*, *replaced* by something new, or *left behind* with nothing in its place.

- **The `Snapshots` table** (*adapted*). It is keyed `(resourceId, validFrom)` `WITHOUT ROWID`, with the partial index `idx_Snapshots_current` on `(resourceId, validTo)`. Its `eTag` column goes, and the latest moment's KV key arrives beside it (D5).
- **`#calculateValidFrom`** (*replaced*). The moment is taken inside `transactionSync` instead, from the latest moment (Design intent 1).
- **Coalescing** (*left behind*): the in-place `UPDATE` in `#writeSnapshot`, and `coalesceWindowMs` in `#bootstrapConfig`.
- **`identityKey`** (*carried over unchanged*). Its only caller today is the coalesce check, and recognizing a repeat compares identities with it (Design intent 6).
- **The replay checks** (*replaced*): Steps 4.5a and 6.5, each `authoritative.get(resourceId)?.meta.eTag === newETag`. Recognition from the snapshots a repeat wrote takes their place (Design intent 6). ⚠️ Design consideration: a repeat looks like a conflict to Step 4.5b, which then skips validating it, while recognition compares values after the validator fills `@default`s. Pass 2 places the check so a repeat still reaches the validator.
- **The docs' retry contract** (*adapted*). `api-reference.md`'s `'timeout'` row says "an idempotent resubmit (same `newETag`) can land", its `TransactionOptions` table documents a per-call `newETag` override, and its note on disconnects says held writes are "re-submitted on reconnect (idempotent via `newETag`)". A resubmit lands because it is recognized, and the `newETag` row and parenthetical go.
- **The conflict checks** (*adapted*): Step 4.5b's hint and Step 9's verdict, each `current.meta.eTag !== (op as any).eTag`. They compare `validFrom` instead. Step 9 stays the one place a conflict is decided and a `currentSnapshot` disclosed, after the Step 8 permission gate.
- **The wire types** (*adapted*): `SnapshotMeta.eTag`, the `eTag` on `OperationDescriptor`'s put, move and delete, and `TransactionResult`'s `eTags`. `SnapshotMeta.eTag` goes, and the other two take D7's names: an op's `ifValidFromMatches` and a result's single `validFrom`.
- **The same-node move skip** (*left behind*): Step 10's branch commented `// Move to same node — idempotent no-op (no write, no fanout)`, which gives that resource its old version in the result. The move writes a snapshot like any other op (D11).
- **The door** (*adapted*): `transaction(ontologyVersion, newETag, ops)` in `resources.ts`, the server-side writes there that send `{ op: 'put', eTag: existing.meta.eTag, value }`, and callers that mint a `newETag`, such as `studio-client.ts` for each message it posts. `newETag` leaves the signature.
- **The client engine** (*adapted*): `frontend/debounce.ts`'s `baselineETag` chain, `genETag`, and the `newETag` on each `QueueSubmission`. The chain carries the `validFrom` each result returns instead. Its rule of one transaction in flight per resource stays as it is.
- **The client's handling of results** (*adapted*): `#meshSubmit`'s `meshNewETag`, `#mapTransactionResult` (`const eTag = subs[0]!.newETag`), the store adapter's `applyCommit(rt, rid, eTag)`, the `meta?.eTag` reads in `create-nebula-client.ts`, and `conflict-outcome.ts`'s resubmit at `snapshot.meta.eTag`. `#mapTransactionResult` already gives every resource in a commit the same version. Today that is wrong for a same-node move, whose server version stays old, and D11 makes it right.
- **The client types an app sees** (*adapted*), taught in the docs `platform-embed.ts` embeds for Studio: the `committed` outcome's `eTag`, `conflict-pending`'s `local` and `base`, each `{ value; eTag }`, the explicit `eTag` override on an op, and the human-in-the-loop pattern that stashes `conflict.server.meta.eTag`. They take D7's names. `api-reference.md`'s row for a Profile's `meta.eTag` comes out, so the surface Studio learns names one version; the field stays (D8).
- **Query order** (*adapted*). `orderBy: 'validFrom'` is the only order a query has (`ORDER BY validFrom, resourceId`), and its JSDoc reads it as creation order: `resourceId` is "the deterministic tiebreaker for co-created rows". Today a same-actor edit within the hour keeps its resource's place. After this task, every edit moves its resource to the end of each query that holds it, so the order is last-written, and the JSDoc and docs say so. The chat thread keeps its order while a Message is never edited. ⚠️ Design consideration: a list that wants creation order needs each resource's first `validFrom`, which nothing builds yet.
- **Mesh's Profile `eTag`** (*carried over unchanged*): a ULID the server mints for each write and stores in `ProfileFields` (D8).
- **Tests, scenarios and docs** (*adapted*). What changes is found by structure, since one word finds both too much and too little. Each command below was run on 2026-11-06 and lists files:
  - **Callers of the three signatures that lose `newETag`:** the door, `doTransaction(newETag, ops, clientAddress)` and `Snapshots.transaction(ops, version, newETag, facet, …)`. `git grep -lw newETag -- apps packages` lists the files that name it. A call site may pass `crypto.randomUUID()` in that place instead, as `resources.ts`'s two server-side writes do, so `git grep -n 'doTransaction(' -- apps packages` is read too.
  - **Reads of a Resources snapshot's `meta.eTag` or a result's `eTags`:** `git grep -lwE 'eTag|eTags' -- apps packages/resources`. Its hits include what stays as it is: the Profile sites D8 keeps (`client-routes.ts`'s `NEVER_WRITTEN_ETAG` check, `unwritten-profile-heals.ts`, and the `profile-do`, `profile-subscribe` and `profile-store-wiring` tests) and recorded results (`fanout-*-raw-*.json`, `THROUGHPUT-RESULTS.md`).
  - **Consumers of `coalesceWindowMs`:** `git grep -lw coalesceWindowMs -- apps packages` lists `snapshots.ts`, the `scope-binding`, `scope-isolation`, `guards` and `star-resources` tests, and the `certificate-wake.ts` scenario. `scope-binding` and `scope-isolation` assert `{ coalesceWindowMs: 3600000 }` as the positive half of an isolation check, and `certificate-wake.ts` checks `'coalesceWindowMs' in config`, so each gets another signal that can still fail. Pointing one at `{}` does not count.
  - **Docs:** `grep -rlw eTag website/docs` lists `api-reference.md`, `resources.md`, `coding-your-ui.md` and `mesh/lumenize-client.mdx`.

## Design intent

1. **A transaction's moment is assigned as it commits.** Inside the `transactionSync` that writes its snapshots, after the validator's `await`, the transaction reads the Durable Object's latest moment and takes the later of the current time and that moment plus one millisecond, compared as ISO strings, which sort as they compare because ADR-011 fixes their width (D5, D10):

   ```ts
   // One KV key, read and written inside this transactionSync; undefined at first
   const latestMoment = kv.get<string>('latestMoment');
   const now = new Date().toISOString();
   const next = latestMoment
     ? new Date(Date.parse(latestMoment) + 1).toISOString()
     : now;
   const moment = next > now ? next : now;
   // … every snapshot this transaction writes gets `moment` …
   kv.put('latestMoment', moment);
   ```

   A Durable Object runs one `transactionSync` at a time and the key only moves forward, so moments are unique in the Durable Object and sort in commit order. The result returns `moment` once the block commits. With the latest moment at `15:09:41.007Z`, a transaction in that same millisecond gets `15:09:41.008Z`, and one at `.010` gets `.010`.
2. **The latest moment is the Durable Object's most recent moment**, the proposal's term for a timeline's. The next moment starts from it. It lives in one KV key, `latestMoment`, which each transaction reads into a local variable and writes back (D5). A `.dev` wipe deletes only the keys listed in `PLANE_KEYS`, and this key stays off that list, so moments keep rising across a wipe.
3. **A writer proves it holds the current snapshot by naming that snapshot's `validFrom`.** A put, move or delete names it as `ifValidFromMatches` (D7), and a mismatch is a conflict, decided at Step 9 as today. A create still asserts that the resource does not exist. ADR-005's monotonic pre-check rule, for checks outside the transaction, carries over: a resource whose `validFrom` has moved past the op's never moves back, so Step 4.5b may still skip a doomed validation.
4. **Every committed op is a snapshot, and the client's debounce sets how many there are.** That includes a put of the value already there and a move to the node already held, whose snapshots differ from the one before only in `validFrom`, `actingToken` and `ontologyVersion` (D11). The engine's default quiet window (500 ms) and maximum wait (2 s) keep keystrokes from becoming versions, and the server keeps whatever arrives. The cost lands on writes that coalesce today:
   - **Rows written.** An in-place update writes 1 row; a new snapshot writes 4: it closes the old row, inserts the new one, and moves the partial index's entry out and in. Writing the latest moment's key (D5) makes a one-resource transaction 5. At $1.00 per million rows written (`durable-objects.md` § *SQLite write-cost optimization*), an hour of steady typing that submits every 2 s costs about $0.009 instead of $0.0018.
   - **Storage.** Each snapshot stores the whole value and the writer's acting token, so that hour on a 10 KB note keeps about 1,800 copies, about 18 MB, where today it keeps one. At $0.20 per GB-month that costs little, but a Star is one Durable Object, which Cloudflare caps at 10 GB, so about 550 such hours fill it. D9 accepts that growth through pre-alpha and names what reopens it.
5. **Only the server mints a version.** `newETag` leaves the door, the engine and storage, and a field an outside protocol wants a version in is filled from `validFrom` (D3).
6. **A transaction repeated after it committed is answered `committed`, with the moment it committed at.** The server recognizes it from the snapshots it wrote, which D1 keeps.
   - **Where it looks.** For each op, the snapshot that followed the version the op names: the old row's `validTo` is that snapshot's `validFrom`, so it takes one key read. For a create, the resource's first snapshot.
   - **When it is the same write.** All of those snapshots share one moment, were written under the caller's identity (`identityKey`), and hold what the op would write, compared in stored form after the validator fills `@default`s. Otherwise the precondition decides, as for any write.
   - **A case.** Say `todo-1` was at `…:05.123Z`, a put moved it to `…:41.007Z`, and the answer was lost. The client sends the same put again, naming `…:05.123Z`. That row now has `validTo` `…:41.007Z`, and the snapshot there holds the same value under the same identity, so the answer is `committed` at `…:41.007Z`.
   - ⚠️ Design consideration: when someone else's later write has superseded the recognized one, the client already holds that later `validFrom` from fanout, and adopting the recognized moment must not move it back.

These claims carry the design, and each can be checked:

- **C1. A client learns its own transaction's moment only from the result.** Resource fanout skips the client that wrote (`#broadcast`'s `if (row.clientAddress === originatorAddress) continue;`), so no fanout of a client's own transaction races its result.
- **C2. A version the server mints costs the client no extra wait.** The engine keeps at most one transaction in flight per resource, so it already waits for each result before it sends that resource's next write.
- **C3. Nothing commits twice, whether or not a repeat is recognized.** Once a put, move or delete commits, its resource's `validFrom` has moved past the one the op names and never moves back, so the op's precondition fails on every later attempt. A create's existence check does the same. Recognition only changes what a repeat is told.
- **C5. Repeats are coming, though no shipped client path sends one today.** Mesh never re-sends a message once sent (`#sendOrQueue`'s comment, "a message already SENT is never replayed"), and across a reconnect the engine keeps the original `callAsync` waiting rather than firing a new one (`setConnectionState`, and the debounce test that asserts "(A): NO re-fire"). The backlog's *A Client resends a call its socket lost* row, decided 2026-10-07, resends every call whose receipt died with its socket, and counts on `resources.transaction` and `postUserMessage` being safe to repeat, and [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 11: Durable calls* builds on that row. A timed-out transaction the app resubmits is a repeat too.

## Constraints

- **[ADR-005](../docs/adr/005-optimistic-concurrency-etags.md) (Accepted) is superseded.** This task writes its successor as a `Proposed` ADR: `validFrom` proves currency, only the server mints it, and a repeat is recognized from what it wrote, with no dedupe ledger. During pre-alpha no ADR is ratified, and Larry reads it himself (`docs/adr/README.md` § *The ratification gate*).
- **[ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) (Accepted) is amended.** What rests on coalescing goes: the *Granularity is the meaningful version, not the keystroke* bullet, and one of the two reasons Context and Consequences give for a client-held merge base, that coalescing overwrites the value a client diverged from, so history may not hold it. The base stays client-held for the other reason, which still holds: it decouples the merge from history retention and the R2 offload. *Replay/idempotency checks consult committed snapshots rather than a side ledger* stays, since recognition (D6) reads committed snapshots. The Negative *Hot storage grows without bound until the R2 offload ships* grows faster (D9). Its core, history as the substrate and `[validFrom, validTo)` intervals that tile time, stays.
- **[ADR-006](../docs/adr/006-resources-reference-by-id.md)**'s transaction bullet names `newETag`, and that clause changes.
- **[ADR-003](../docs/adr/003-continuation-messaging.md)** has write retry lean on "ADR-005's replay idempotency". Recognition keeps that true, so only the pointer changes.
- **[ADR-010](../docs/adr/010-random-opaque-keys.md) governs keys, and a version is not a key**, but each reason it gives against a counter can be asked of a version. A round trip to learn it: C2. Blocking idempotent creation: a repeated create is recognized (Design intent 6). Blocking offline creation: the engine holds an offline write, naming the version it read, and the server mints the new one when it arrives. Guessable and enumerable: knowing a version lets a writer assert only that it read it. Colliding across Durable Objects: two may mint the same moment, which is harmless, since a version is compared only with another from its own Durable Object.
- **[ADR-011](../docs/adr/011-iso-timestamps.md):** moments stay fixed-width ISO strings from `toISOString()`, so a moment moved forward by a millisecond still sorts as a string.
- **`durable-objects.md` § *SQLite write-cost optimization*** prices every row this task adds.
- **This task changes no index** (Larry, at the Stage 1 gate). An index with `validFrom` in it, likely compound, is the catch-up's to design.
- **The `data` gate.** The schema changes without a migration ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *⑥ The wipe*).

## Future state

- **The catch-up read** finds every resource changed after the client's moment, through an index that task designs, likely a compound one with `validFrom` in it, keeps current snapshots and tombstones, and hands back the latest moment as the next cursor, the proposal's `nextFrom`. A Resource Events implementation and the deferred query-subscription delta both build on it.
  - **The latest moment can serve as the version of a query's results,** because a resource leaving them moves the latest moment while the newest `validFrom` among those left stays put. Say `todo-1` is at `…:05.005Z` and `todo-2` at `…:05.007Z`, and `todo-2` is deleted at `…:05.009Z`. The newest `validFrom` left is `.005`, and the latest moment is `.009`.
  - **One resource's version field carries its `validFrom`** (D3): an HTTP `ETag`, or the `revision` of the Filesystems strawman ([experimental-ext-filesystems#2](https://github.com/modelcontextprotocol/experimental-ext-filesystems/pull/2)), which the proposal's R7 fills with the moment of each change.
  - ⚠️ Design consideration: a `.dev` wipe drops `Snapshots` and keeps the latest moment's key (Design intent 2), so the catch-up also needs the oldest moment it answers from (the proposal's R21), which a wipe sets to the latest moment, as the second prototype's `Timelines.wipe()` (`version-store.ts`) does. A client whose cursor is older starts over.
- **Compaction**, coalescing brought back as a batch job over old history, has its own row in the backlog's § *Future bigger things*. `auth.md` § *Attribution* says committed history is immutable, without the exception coalescing always needed, so that sentence is clarified before compaction is built.
- **A merge base from history.** With every write kept, history holds the version a writer diverged from, so the conflict resolver could look it up instead of holding it. This task leaves the base where it is, held by the client.

## Decisions

Started at the gate; only what is settled.

| ID | Decision | Rejected alternative — why |
|---|---|---|
| D1 | No coalescing: every committed op writes a snapshot. Coalescing may return later as compaction of history older than the oldest moment a catch-up answers from, which the backlog's *Compaction* row holds (Larry, 2026-11-06). | **Delayed coalescing now:** it needs a catch-up, and the oldest moment one answers from, and neither exists yet. **A short-term detailed log beside `Snapshots`:** a second timeline to keep in step. **Moving `validFrom` forward on a coalesced write:** the window would slide for as long as the actor kept typing, and history would date the earlier value at the later moment. |
| D2 | Only the server mints a version, and the version is `validFrom` (Larry, 2026-11-06). | **A client-supplied `newETag`** (ADR-005): the client chooses what is stored as the version. **Server version numbers plus idempotency keys:** ADR-005 rejected these as two concepts where one suffices, and that still holds. |
| D3 | A field an outside protocol wants a version in is filled from `validFrom`, and everywhere else the code says `validFrom` (Larry, 2026-11-06). | **Keeping an `eTag` column or alias for compatibility:** a second name for the version to keep in step, the complexity the second MCP prototype shed. |
| D4 | A Durable Object's most recent moment is called its latest moment, `latestMoment` in code, the proposal's term (Larry, at the Stage 1 gate). | **Marker**, chosen first on 2026-11-06: a new word that needs a definition, where "latest moment" explains itself and is what the proposal's readers already know. Comments in `resources.ts` and `subscriptions.ts` also use "marker" for migration and test markers. **High-water mark**, the backlog row's term: Larry prefers neither. |
| D5 | The latest moment is stored in one KV key, `latestMoment`, which each transaction reads and writes inside `transactionSync`: one row written per transaction. A transaction of N resources costs 4N + 1 rows. (was Q1; Larry, at the Stage 1 gate, as he leaned on 2026-06-30) | **`MAX(validFrom)`, read in each transaction:** Larry wants no `MAX()` query on every transaction. With an index led by `validFrom` it is a single seek (SQLite's plan: `SEARCH Snapshots USING COVERING INDEX`), but this task changes no index, and an empty table after a wipe would start the moments over. If the catch-up adds such an index, deriving would save the key's one row per transaction. **Held in an instance variable, seeded when the Durable Object starts:** a copy beside storage, for no gain. |
| D6 | A transaction repeated after it committed is recognized from the snapshots it wrote and answered `committed` with that moment (Design intent 6). It needs no new write, because D1 keeps every snapshot it would look for. (was Q2; Larry, at the Stage 1 gate) | **No recognition, so a repeat is a conflict or "already exists":** the resend row (C5) would then answer a landed `postUserMessage` with "already exists", so a user who posts again pays for a second turn, and a resent put would conflict with its own write. **A table of answers kept by `callId` on the host:** a write on every call, the dedupe ledger ADR-005 rejected. **A client-supplied idempotency key:** `newETag` by another name, stored so it can be checked. |
| D7 | An op names the version it read as `ifValidFromMatches`, one-for-one with today's op `eTag`, and the server applies the op only if the resource's current `validFrom` equals it. A result returns one `validFrom`, the moment every op in the transaction wrote at (D11). An empty transaction writes nothing and returns the latest moment, or the current time in a Durable Object that has none. (was Q3; both names are Larry's, at the Stage 1 gate) | **`validFrom` on the op:** it reads as the moment the write takes effect, the sense the backlog's *Bulk demo-data load* row would want, so every taught example needed a comment saying otherwise. **`ifValidFrom`:** it can read as "if the resource is valid as of this moment", a check every later version passes too. **`ifMatch`, the strawman's name:** an outside protocol's word inside the code, against D3. **`validFroms`, keyed by resource id, as today's `eTags`:** every value would be the same moment. **A longer name such as `validFromAssigned` or `chosenValidFrom`:** the result's `validFrom` means what `meta.validFrom` means, so a second name adds a term without adding meaning. |
| D8 | Mesh's Profile keeps its ULID `eTag`, and a backlog row in § *Lumenize Mesh* covers giving it a moment. (was Q4) | **Moving Profiles here:** nothing in this change forces it. Profile writes are last-writer-wins, the client compares a Profile's ULID only to `NEVER_WRITTEN_ETAG` (`mesh-client.ts`, `#profilesNeverWritten`), and the store reads `meta.eTag` for writes only under `store.resources`. Moving them also needs a name for the never-written sentinel, a new term. |
| D9 | Storage grows without a bound through pre-alpha (Design intent 4). The backlog's *Watch what Durable Object storage costs* row measures bytes per Star as well as rows written, and a Star passing 1 GB, a tenth of the 10 GB ceiling, opens the bound: the R2 offload, or compaction once `auth.md` § *Attribution* is clarified to allow it. (Larry, at the Stage 1 gate) | **Bounding it now by coalescing in some form:** D1's reasons. **A longer debounce wait:** collaborators would see each other's edits later, and storage would still grow. |
| D10 | A transaction's moment is the later of the current time and the latest moment plus 1 ms, compared as ISO strings, and the latest moment's key holds an ISO string, the form `validFrom` has (Design intent 1). Above about 1,000 commits a second, each commit pushes the moment a millisecond ahead, so `validFrom` runs ahead of the clock until the rate drops; today's peak is about 400 a second. This settles the backlog's *`validFrom` global monotonicity* row's open tradeoff. (Larry, at the Stage 1 gate) | **A `(validFrom, seq)` pair:** it keeps moments true to wall time, but a version stops being one string that sorts, which the proposal's R3 asks for. **A counter or a ULID:** ADR-011 keeps timestamps ISO. **The latest moment converted to epoch milliseconds:** it saves a parse per commit, but holds a moment in a second form. |
| D11 | Every committed op writes a snapshot, with no comparison of old and new. A put of the value already there, or a move to the node a resource is already on, writes one that differs from the one before only in `validFrom`, `actingToken` (when someone else writes) and `ontologyVersion` (when the transaction names a newer one). Such ops are rare: a put whose typing was undone within the debounce window, or one that writes back what it read. (Larry, at the Stage 1 gate) | **Skipping a same-node move, as today:** that resource keeps its old version, so the result needs a moment per resource, and the writer goes unrecorded. **A snapshot only when the value or meta differs:** a comparison on every op, for a rare case. **The engine skipping a put whose value equals `baseValue`, the value it read:** a check whose only gain is a little storage in a rare case. |
| D12 | A transaction takes its moment inside the `transactionSync` that writes it, after the validator's `await`, and returns it once that block commits (Design intent 1). Transactions still validate concurrently. (Larry, 2026-11-07, hand review) | **Serializing transactions across the validator's `await`**, with `blockConcurrencyWhile` or a lock: every transaction would wait out the validation of the one ahead of it, which Larry expects would cut throughput sharply. It was not measured, since taking the moment at commit needs no lock. **Picking the moment before the `await`, as today:** commit order and moment order can disagree (Context item 3). |
