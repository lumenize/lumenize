# Nebula Resource History on R2 (not per-resource DOs)

**Status**: On Hold — design captured, not started
**App**: `apps/nebula/`
**Supersedes**: `tasks/icebox/nebula-5.4-capability-tickets.md` (per-resource `ResourceHistory` DO + capability tickets — iceboxed)
**Master task file**: `tasks/archive/nebula.md` (archived)
**Relevant engine**: `apps/nebula/src/resources.ts` (`Snapshots` table, Snodgrass-style temporal storage in Star)

## Goal

Move resource **history** (old snapshot blobs) off Durable Object storage and onto
**R2**, so a Star's footprint stays bounded and history scales without limit — while
preserving the strongly-consistent, eTag-based transaction model already in
`Resources`. **No per-resource DO is introduced.** Star (the existing
per-tenant-app singleton) stays the metadata source of truth; R2 is an async
**outbox** for blobs.

## The decision (settled — do not re-litigate)

History blobs live in **R2**, keyed by resource. The per-resource `ResourceHistory`
DO idea (one DO instance per resourceId, fan-out/fan-in across them, capability
tickets for direct client→DO access) is **abandoned**. Three reasons, all of which
the per-resource-DO design made *worse* and R2 makes *better*:

1. **Capacity.** A Star holding the full temporal history of every resource trends
   toward the per-object storage ceiling (~10 GB). History is the unbounded-**over-time**
   axis; R2 is effectively unbounded.
2. **Fan-out/fan-in.** A separate DO per resource turns any cross-resource or
   temporal-range read into a map/reduce across many DO instances. R2 (and Star-held
   metadata) keeps reads single-hop.
3. **Cost.** DO SQLite writes are **$1.00/M rows** ($1/M, 1,000× reads — see
   `.claude/rules/durable-objects.md` § SQLite write-cost). R2 storage + operations are
   dramatically cheaper for write-once history blobs. The Cloudflare Agents team's
   broadening use of R2 beyond classic S3/OLAP workloads is corroborating evidence that
   R2's behavior is trustworthy for this pattern.

> **On the voice-memo summary that seeded this task:** it framed metadata as living in
> "a Durable Object **per resource**." That was an oversimplification by a context-free
> chat — Nebula already has the **Star** singleton (one DO per `{universe}.{galaxy}.{star}`)
> holding all resource metadata in SQLite. We do **not** add per-resource metadata DOs;
> that would reintroduce exactly the fan-out we're eliminating. The DO in the roles below
> **is the Star**.

## Roles

- **Star DO** = source of truth for **metadata**: the `Snapshots` rows minus the heavy
  `value` blob — `resourceId, validFrom, validTo, eTag, nodeId, typeName,
  ontologyVersion, changedBy, deleted`. Small, predictable, already indexed
  (`idx_Snapshots_current`). The eTag check and the temporal index stay synchronous and
  in-DO.
- **R2** = durable store for snapshot **blobs** (the `value` column today). Eventually
  consistent; treated as an async outbox the DO writes through.

## How it maps onto today's engine (`Resources` in `resources.ts`)

The `Snapshots` table is already Snodgrass-temporal: `PRIMARY KEY (resourceId, validFrom)`,
`validTo` defaults to `END_OF_TIME` for the current version, debounce window
`config.debounceMs` (default 60 min). The change is surgical:

- **Drop the `value` TEXT column to R2.** Star keeps the metadata row; the blob is in R2.
- **R2 key = `<resourceId>/<validFrom>`** — resource id first, `validFrom` appended. This
  is a 1:1 mirror of the SQLite PK, so the existing temporal logic already produces the
  right key on every path.
  - **Within the debounce window** the engine updates the current row *in place* (same
    `validFrom`) → same R2 key → **PUT overwrites**. Coalesced edits = one history entry,
    new eTag each time.
  - **Outside the window** the engine closes the current row (`validTo = now`) and inserts
    a new row (`validFrom = now`) → **new R2 key**. R2 grows as the complete history,
    naturally.

## Write path (one transaction)

1. Client sends a `transaction()` with its `eTag` (existing API, unchanged).
2. Star checks the incoming eTag against the stored current-row eTag.
   - Mismatch → `{ type: 'conflict', currentSnapshot }` (unchanged — note: `currentSnapshot`
     now needs the blob; see Open decision D2 on whether conflict returns the value or just
     metadata).
   - Match → proceed.
3. Star updates its **metadata** first (the SQL `INSERT`/in-place update on `Snapshots`,
   minus `value`).
4. Star writes the blob to R2 at `<resourceId>/<validFrom>` (the outbox op):
   in-window → PUT overwrites the current key; out-of-window → PUT to the new `validFrom` key.
5. **The DO output gate holds the client response until the R2 PUT confirms**, so the client
   never sees an eTag that isn't yet backed by a blob. (Mechanics + cost of awaiting R2 from
   a DO is Open decision D1.)

## Read path

1. Read goes through Star **once** for the authoritative eTag + metadata (sync SQL).
2. **Optionally** serve the blob from a short-lived in-Star cache (TTL ≈ R2 propagation
   window) for sub-ms hot reads with zero R2 calls.
3. On cache miss, fetch the blob from R2 and validate the blob's eTag against Star's eTag.
   - R2 can only ever be **behind**, never ahead (Star commits metadata before the client is
     released, and the client can't have learned a newer eTag than Star holds). If the R2
     blob is stale, retry / force a read-through until eventual consistency settles.

## Consistency

- Star metadata is always the source of truth; R2 is eventually consistent and only ever
  trails. The eTag check on read is what guarantees correctness without Star holding the blob.
- One DO hit, R2 as outbox — no two-round-trip handshake.

## What changes vs. what doesn't

**Unchanged:** the `transaction()` / `read()` / `reads()` public API; the eTag optimistic-
concurrency model; the DAG permission check before mutation; debounce semantics; subscriptions
& fanout (they ride the metadata/eTag, which still lives in Star).

**Changed:** `Snapshots.value` leaves SQLite for R2; `read()` of a non-cached blob becomes an
async R2 fetch (it is sync-from-SQLite today); the Star needs an R2 binding.

## Supersedes / cleanup done alongside this task's creation

- **Capability tickets (Phase 5.4) → iceboxed** at `tasks/icebox/nebula-5.4-capability-tickets.md`
  (moved out of `tasks/on-hold/`). Its entire premise (clients talk *directly* to per-resource
  `ResourceHistory` DOs; HMAC tickets authorize that) evaporates when there are no per-resource
  history DOs. Reads stay single-hop through Star.
- **`apps/nebula/src/resource-history.ts`** survives **only** as the canonical tenant-scoped-
  helper **test fixture** for `tasks/nebula-do-scope-isolation.md` — it is no longer a stub for
  real history storage. Its docstring points here.
- **`tasks/archive/nebula.md`** (archived) Phase 5.4 row + the "ResourceHistory gains real temporal storage"
  framing updated to point here.

## Open decisions (resolve before "go")

- **D1 — Awaiting R2 from a DO + the output gate.** Confirm the exact mechanism that holds the
  client response until the R2 PUT confirms, and the wall-clock-billing cost of that await
  (`.claude/rules/durable-objects.md` § Wall-clock billing). If the await is too expensive,
  consider the two-one-way pattern (Star fires the blob write to a Worker, Worker PUTs to R2,
  fires back) — but that loosens the "never released before R2 confirms" guarantee, so weigh
  carefully.
- **D2 — Current-snapshot tiering: hot in Star, spill cold to R2 (the hybrid — likely end-state).**
  A Star keeps current blobs resident in SQLite (sync hot reads) up to a size threshold (set by
  experiment, **well under the 10 GB ceiling**); above it, spill the coldest current blobs to R2 and
  keep only metadata + a `resident` flag in Star. **Most Stars never cross the threshold → all-resident,
  zero R2 read latency.** History (closed `validTo`) is always R2-only (base task). The earlier
  endpoints are just this with the threshold at ∞ (**B:** all current in Star) or 0 (**A:** all current
  in R2). Pick threshold + lazy-vs-write-through from the D4 benchmark.
  - **Eviction signal without a write-per-read** (DO writes are 1,000× reads — never write on read):
    - *Free baseline — least-recently-**written** (LRW).* Every `transaction()` already writes the row,
      so write-time is free to stamp; for collaborative editing recently-written ≈ hot, a strong LRU
      proxy at zero extra cost.
    - *True read-recency, if wanted — ephemeral in-RAM CLOCK/LRU.* An instance-variable map/bit-array;
      `.claude/rules/durable-objects.md` blesses "ephemeral caches where loss is acceptable." Losing it
      on hibernation is fine — it's only a spill *heuristic*; the data is safe in SQLite+R2 and the sweep
      falls back to LRW when cold. **Reads touch RAM only; nothing persists on read.**
    - *Size-triggered batch sweep, not continuous bookkeeping.* Track `residentBytes` (updated on
      write/evict, never on read); cross a high-water mark → evict coldest to a low-water mark in one
      batched pass (alarm or piggybacked). Amortized eviction cost ≈ 0/op.
  - **Consistency is free here:** eviction only ever targets **cold** items, whose R2 copy settled long
    ago, so option A's eventual-consistency read hazard can't bite the spilled subset; the eTag check
    backstops regardless.
  - **Lazy-spill vs write-through (the one real cost fork):**
    - *Lazy-spill (default — matches "R2 only above threshold"):* R2 PUT happens **only on eviction**.
      Small Stars touch R2 ~never. Eviction = one R2 Class A PUT (~$4.50/M) that must confirm before the
      local copy is dropped; an evicted-current read = R2 GET (~$0.36/M).
    - *Write-through cache:* R2 PUT on **every** transaction; eviction is free (drop local, R2 already
      has it) and R2 is a complete durable mirror (pairs with D7 + disaster recovery). Costs an R2 PUT
      per write regardless of Star size.
  - **Workers KV rejected for the tier index / TTL-LRU.** Confirmed (2026-06): KV **writes $5.00/M**
    (5× DO SQLite's $1/M; ~1.1× R2 Class A), KV **storage $0.50/GB-mo** (33× R2's $0.015), KV reads
    $0.50/M (vs in-DO SQLite reads $0.001/M). KV TTL is **absolute expiry (min 60 s), not sliding** —
    emulating LRU = rewrite-on-read = write-per-read again, throttled by the **1 write/s/key** cap; and
    KV is eventually consistent + non-transactional with the Star, so it can't be the authoritative
    resident/evicted index. Its only edge (cheap *global edge* reads) isn't our pattern (reads go through
    the Star DO). **Keep resident/evicted state in the Star's `Snapshots` row.**
- **D3 — History metadata location.** Default: keep **all** metadata rows in Star (blobs only to
  R2) so temporal-index queries ("version as of T", "list versions") stay sync SQL. Alternative:
  push old metadata rows out too and use an R2 prefix-list as the history index (eventually
  consistent, slower) — only if metadata-row accumulation itself becomes a ceiling.
- **D4 — Benchmark R2 read latency from a DO** under realistic access patterns *before*
  committing — validate it's not the hundreds-of-ms figure previously assumed. Reuse the
  browser-test/bench harness (see `reference_mesh_browser_test_template`,
  `reference_fanout_bench_setup`).
  → **Spike drafted + CF research captured, then punted 2026-06-22** (the Studio recorder uses the
  Galaxy DO's SQLite; the R2-vs-DO benchmark is on-hold → [`spike-r2-olap-latency.md`](spike-r2-olap-latency.md), its API-token blocker now lifting (R2 SQL Worker binding incoming)).
  D4 remains open / unbenchmarked — revisit when resource-history-on-R2 is actually built.
- **D5 — Hot-read frequency.** How often do temporal queries / window-of-now tree traversals
  actually hit history vs. current? Drives whether the D2 short-lived cache is worth building and
  what its TTL should be.
- **D6 — Cache TTL = observed R2 propagation window.** Set empirically from D4/D5, not guessed.
- **D7 — Direct client reads of *immutable* history via R2 short-lived tokens (the native successor to
  the iceboxed HMAC capability tickets).** R2 offers two HMAC-SigV4 (`AWS4-HMAC-SHA256`) short-lived
  mechanisms: **presigned URLs** (per-object; the URL *is* the capability, holder needs no creds;
  expiry 1 s–7 days) and **temporary credentials** (scoped S3 creds + session token, bound to a
  bucket + prefix/keys + operation set, short `ttlSeconds`, minted from a parent R2 API token).
  Because a closed history blob (`validTo` set) is **immutable**, a client can GET it straight from R2
  with no eTag-staleness race — so Star can do the DAG permission check, mint a prefix-scoped temp
  credential (or per-object presigned URL) for `<scope>/<resourceId>/`, and let the client pull old
  versions without funneling MB through (and wall-clock-billing) the Star DO. Tenant isolation rides
  the prefix scope; "Star constructs keys, never the client" still holds — the token encodes Star's
  decision. **Constraints:** keep the *current/live* blob behind Star (mutable + eventually consistent
  → needs the authoritative eTag); minting needs an R2 Access Key/Secret as a platform secret (new
  secret to manage/rotate per `.claude/rules/critical.md`); the grant is coarse (no pre-expiry
  revocation — rely on short TTL) and bypasses Nebula's per-call mesh auth, so it's only for
  already-permission-checked, immutable reads. **This is an optimization on top of the through-Star
  baseline, not a prerequisite — defer until D1–D6 land.**

## Security / multi-tenancy (must hold)

- **Per-tenant R2 key isolation.** R2 keys must be namespaced so one tenant's Star can never read
  or overwrite another's blobs — prefix keys with the Star scope (`{u}.{g}.{s}/<resourceId>/<validFrom>`)
  or use a per-tenant bucket. Treat the R2 binding as shared infrastructure that does **not**
  enforce Nebula's scope model (same caution as the DWL loader cache in
  `.claude/rules/durable-objects.md`); the Star is the only thing enforcing the boundary, so it
  must construct keys, never accept a client-supplied key.
- **Reads stay authorized at Star.** Because every read still passes Star's eTag check (and the
  DAG permission check on the metadata path), removing the per-resource DO does **not** remove an
  authorization point — the capability-ticket scheme was authorizing direct-to-DO access that no
  longer exists.

## Out of scope

- **Working-set ceiling.** If a Star's *live* (current-version) data alone exceeds ~10 GB, that's a
  sharding/branching concern (deferred post-demo — `tasks/icebox/nebula-branches.md`), not this task.
  This task removes the **history** growth axis only.
- **Granularity compression** of history (merging old snapshots) — already rejected as a premature
  optimization in `docs/archive-and-outdated/nebula-resources-design.md`; debounce covers 90% of the benefit. R2's cheap
  storage weakens the case for compression even further.

## Success criteria (when this leaves On Hold)

- [ ] D1–D6 resolved; D4 benchmark numbers recorded
- [ ] `Snapshots.value` blobs stored in R2 at scope-namespaced `<resourceId>/<validFrom>` keys
- [ ] `transaction()` holds the client response until the R2 write is durable (D1 mechanism)
- [ ] `read()`/`reads()` validate the R2 blob eTag against Star's eTag; stale-read retry path tested
- [ ] eTag conflict, debounce-coalesce, and out-of-window-new-version paths all green with R2 backing
- [ ] Cross-tenant R2 isolation test: a Star cannot read/write another scope's keys
- [ ] Public `transaction()`/`read()` API and subscription/fanout behavior unchanged
