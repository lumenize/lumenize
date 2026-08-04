---
paths:
  - "packages/**/*.ts"
  - "apps/**/*.ts"
---

# Writing a Durable Object

This file applies to every DO — the concerns herein apply in **every layer, including Nebula**: storage, synchronous discipline, no mutable instance state, IDs, wall-clock billing, DO class registration. None of this is "dropping down to raw primitives" — it's just how you write a correct DO (e.g. `ctx.storage.sql.exec()` with no cross-DO call is exactly right anywhere).

**How a DO *communicates* is a separate concern, and which rules apply depends on your layer:** on Mesh → [mesh.md](mesh.md); without Mesh (raw-DO infrastructure + framework internals) → [raw-comm.md](raw-comm.md). Not sure which layer you're in? → [workers-projects.md](workers-projects.md).

## Storage
Storage access MUST be synchronous; the legacy async API (`await ctx.storage.put/get`) MUST NOT be used.
- **`this.svc.sql` template literal (when in Mesh)** — everyday queries with relatively small return sets. Readable `${value}` interpolation with automatic parameter binding (also your SQL-injection defense — user input MUST NOT be string-concatenated into SQL); returns results as an array.
- **`ctx.storage.sql.exec()` directly** — a first-class choice, not a fallback: it MAY be used whenever you need streaming/cursors (process rows without loading all into memory), large result sets (`LIMIT`/`OFFSET` pagination), metadata (`rowsRead`, `rowsWritten`), or raw mode (arrays instead of repeated-column-name objects).
- **`ctx.storage.kv.*`** — counters, flags, single-entity lookups, config state.

## Persist before `ctx.abort()` — yield a macrotask first
A storage write immediately before `ctx.abort()` is **silently dropped**, so a macrotask MUST be yielded between the write and the abort. Verified on deployed CF:

```typescript
ctx.storage.kv.put(k, v); ctx.abort();                                  // ❌ LOST
await ctx.storage.put(k, v); ctx.abort();                               // ❌ LOST — the async API is not a fix
ctx.storage.kv.put(k, v); await Promise.resolve(); ctx.abort();         // ❌ LOST — a microtask is not enough
ctx.storage.kv.put(k, v); await new Promise(r => setTimeout(r, 0)); ctx.abort();  // ✅ SURVIVES — macrotask
```

(Sync `kv` and async `storage` share one keyspace, which is why swapping APIs changes nothing.) ⚠️ **This is
deploy-only verifiable**: under local `wrangler dev` (miniflare), `ctx.abort()` reconstructs the DO with
**wiped** storage, so *no* write survives locally regardless — a local test can neither confirm the fix nor
catch the bug. Bit us on an abort-cooldown timestamp that never persisted.

## Initialization (schema setup, in-DO migrations)
One-time setup — `CREATE TABLE IF NOT EXISTS`, in-DO schema migration, config — MUST run at startup so it completes before any request.
- **Raw DOs**: synchronous setup in the constructor body is enough — the constructor runs to completion before any request is dispatched, and sync storage needs no `await`. `ctx.blockConcurrencyWhile(async () => …)` MAY be used **only** when setup must `await`; it's unnecessary for purely-sync setup.
⚠️ **A rewritten migration list MUST start above the highest id any live storage has already applied — never renumber it downward, and never restart a collapsed baseline at 1.** Ids are a high-water mark, not list positions: `@lumenize/sql-migrations` selects on `id > marker`, so a storage whose marker already exceeds the new list's highest id matches nothing, creates nothing, throws nothing, and returns `{rowsRead: 0, rowsWritten: 0}` — **byte-identical to a healthy already-current construct**. The first symptom is a `no such table` from an unrelated method much later. The temptation arrives specifically when collapsing several migrations into one fresh baseline during a wipe, where renumbering from 1 *looks* like the clean move. Full detail in `runAll`'s JSDoc.

- **Mesh DOs (`LumenizeDO`)**: setup MUST go in the **`onStart()` hook**, and MUST NOT be done by overloading the constructor. The base constructor already calls `onStart()` inside `ctx.blockConcurrencyWhile(...)`, so requests block until it finishes and `onStart` MAY be `async`. Overloading the `LumenizeDO` constructor fights that machinery.

## Avoid opening input gates or account for race condition risk
`setTimeout`, `setInterval`, or `await` from inside a DO will open input gates, so they SHOULD be avoided unless you account for the race-condition risk. `waitUntil` is never needed in a DO but MAY be in a default Worker or `WorkerEntrypoint`

## Keep methods synchronous
These entry points SHOULD be `async`: `fetch()`, `alarm()`, `webSocketMessage()`, `webSocketClose()`, `webSocketError()`. Every other method — business logic, route handlers, helpers — SHOULD be synchronous.

**Exceptions**: only methods calling APIs with no synchronous alternative (`crypto.subtle.*`, `fetch()`, Workers RPC calls, etc.) MAY be `async`.

## No mutable instance state
DOs can be hibernated or evicted at any time, so instance variables holding mutable state are lost. `ctx.storage.kv`/`ctx.storage.sql` MUST be the source of truth — reads are ~1/1,000th the cost of writes and frequently-read values are cache-served, so read-on-every-access has no measurable penalty and avoids inconsistency. However, write costs add up so use judiciously.

```typescript
// Wrong: state won't survive eviction
#subscribers = new Set<string>();
subscribe(id: string) { this.#subscribers.add(id); }

// Right: state in storage
const subscribers = this.ctx.storage.kv.get('subscribers') ?? new Set();
subscribers.add(id);
this.ctx.storage.kv.put('subscribers', subscribers);
```

**Safe** instance-variable uses: statically initialized utilities (a pre-compiled regex, `#sql = this.ctx.storage.sql.exec`), ephemeral caches where loss is acceptable, config set in the constructor.

## Wall-clock billing
A DO is billed for elapsed time whenever it is actively working: `await`ing I/O, running a `setTimeout`/`setInterval`, or holding a **method-returned RpcTarget session** open. Mitigations:
- Business logic SHOULD stay synchronous (above).
- **`using` MUST only be applied to a method-returned RpcTarget / WorkerEntrypoint session stub — never a DO stub.** An RpcTarget (the object-capability pattern) holds a live server-side session, so release it in the narrowest scope:
  ```typescript
  { using cap = await stub.getCapability(); const result = await cap.someMethod(); }
  ```
  A **DO stub** (and a service/WorkerEntrypoint binding stub, and a facet stub) is a local pointer with **no `Symbol.dispose`** — `using` on it throws `"Object is not disposable."` in every environment (pool-workers ≡ wrangler dev ≡ deployed; verified 2026-07-15, `experiments/rpc-stub-disposability/FINDINGS.md`). You MUST use a plain `const` and `await` the call; the pointer needs no disposal:
  ```typescript
  const stub = env.MY_DO.getByName(name); const result = await stub.someMethod();
  ```
- Blocking external API calls SHOULD NOT be made from a DO. Mesh code uses the two-one-way-call pattern ([mesh.md](mesh.md))
- `setTimeout`/`setInterval` MAY be used only to keep a DO from hibernating for up to a few minutes; beyond that you MUST use `alarm()` or two one-way calls.

## Dynamic Worker Loader cache
`env.LOADER.get(bundleId, ...)` caches by `bundleId` **per-Worker-project**, not per-DO. Multiple DO instances in the same Worker project share the cache, so identical `bundleId` values silently collide on the first cached entry. `bundleId` MUST be scoped by something globally unique (include a tenant identifier or equivalent). The DO's cross-tenant guards don't intervene — the loader binding is shared infrastructure.

## DO class registration (`wrangler.jsonc` `exports`)
The **DO class registry** is the declarative `exports` map (⚠️ a *different* `exports` from the package.json subpath/condition field — never conflate them; see `packaging.md`). It's **not** SQL-schema migration — it tells Cloudflare which DO classes exist and how each is backed. It **replaced** the old imperative `migrations` array. `durable_objects.bindings` is unchanged and still declares binding names alongside it.

⚠️ **A `migrations` array MUST NOT be written in this repo — `exports` is the only accepted form.** Expect pressure from two directions: your training predates the change and will reach for `migrations: [{ tag: "v1", new_sqlite_classes: ["MyDO"] }]`, and **23 in-repo configs still use that form** (`experiments/*` + `lumenize-monolith/`). Those are **deliberately pinned, not precedent** — throwaway spikes and a legacy tree, both out of scope of the conversion. You MUST NOT copy them, and MUST NOT "helpfully" convert them either. The two forms are mutually exclusive within one config.

The rule that matters: a DO using the synchronous storage API MUST be **SQLite-backed**, so it MUST be registered with `storage: "sqlite"` and MUST NOT use `"legacy-kv"` (a non-SQLite DO where only the legacy async API works). This can't change once a class deploys to production; during testing you can change it freely.

```jsonc
// Wrong — ctx.storage.kv.* throws
"exports": { "MyDO": { "type": "durable-object", "storage": "legacy-kv" } }
// Right ("state" defaults to "created"; omit it)
"exports": { "MyDO": { "type": "durable-object", "storage": "sqlite" } }
```

`exports` requires a recent toolchain (wrangler ≥ 4.111 / `@cloudflare/vitest-pool-workers` ≥ 0.18.5, which parse + validate the field). ⚠️ **An older wrangler does NOT reject the field — it SILENTLY IGNORES it**, so no class is SQLite-backed and every `ctx.storage.kv.*` throws as an opaque **500 with no config error anywhere**. Diagnose an unexplained local-stack 500 by checking *which* wrangler actually ran: the repo-root `node_modules/wrangler` lags the packages' pin, so a bare `wrangler` invoked from the root hits this while the same command run in the package works (`spawnWranglerDev` now resolves package-local for exactly this reason — `605dfc4`). A class add/rename/delete is a one-way door on a live prod worker; states (`deleted`/`renamed`/`transferred`) exist for that, but on a fresh (post-wipe) deploy you emit only live `created` entries — no tombstones. These entries only matter when deployed to Cloudflare's cloud; in local testing every run is a fresh deploy, so they don't take effect there.

**Not the same as database/schema migration** — evolving a DO's SQLite tables (add a column, backfill, reindex) is a separate concern that MUST live in DO code (idempotent `CREATE TABLE IF NOT EXISTS` at construction, versioned in-DO `ALTER TABLE` logic), and MUST NOT go in `wrangler.jsonc`.

## SQL naming
- **Tables** MUST be PascalCase (`Subjects`, `RefreshTokens`, `MagicLinks`)
- **Columns** MUST be camelCase (`emailVerified`, `tokenHash`, `createdAt`)
- **Indexes** MUST be `idx_TableName_columnName` for a single column (`idx_Subjects_email`). **Compound or partial indexes** MUST use a concise *purpose* suffix rather than concatenating column names — `idx_TableName_<purpose>`: e.g. `idx_Snapshots_current` for `Snapshots(resourceId, validTo) WHERE validTo = <end-of-time sentinel>`, or `idx_Subjects_isAdmin` for `Subjects(sub) WHERE isAdmin = 1`.

This maps SQL rows directly to TS interfaces with minimal conversion. SQLite column names are case-insensitive in queries but case-preserved in output.

## Boolean-ish columns: declare `INTEGER`, never `BOOLEAN`
SQLite has no boolean type. A column declared `BOOLEAN` merely gets NUMERIC affinity — it still stores and returns `1`/`0` — so the declaration is a **lie that invites a real bug**: a reader sees `BOOLEAN` and writes `row.flag === true`, which is **always false**. A boolean-ish column MUST be declared `INTEGER` (which primes the reader to convert) and MUST NOT be declared `BOOLEAN`; the **TypeScript type carries the boolean** (ADR-001), converted explicitly at the write boundary (`isAdmin ? 1 : 0`).

**`CHECK (col IN (0, 1))`** SHOULD be added — it documents boolean-ness exactly where a SQL-console reader looks and rejects a stray value, at **zero write cost** (no index, no extra row written). ⚠️ **Cheap only at creation:** SQLite has **no `ALTER TABLE ADD CONSTRAINT`**, so retrofitting a CHECK onto a live table requires the full 12-step rebuild (create shadow → copy → drop → rename). ⇒ add it **when you create the column**, or during a planned greenfield/wipe window; it MUST NOT be retrofitted onto live data. (For a nullable tri-state: `CHECK (col IS NULL OR col IN (0, 1))`.)

## SQLite write-cost optimization
DO SQLite charges **$1.00/M rows written — 1,000× the cost of reads** ($0.001/M). INSERT cost = `1 (row) + 1 per index updated`. Design schemas to minimize index writes:

1. **Tables with TEXT or compound primary keys MUST be `WITHOUT ROWID`** — otherwise SQLite keeps a hidden rowid *and* a separate index for the text PK, doubling INSERT cost. `INTEGER PRIMARY KEY` aliases the rowid and doesn't need it.
2. **Compound indexes SHOULD be preferred over multiple single-column indexes** — `(a, b)` costs 1 write/INSERT and covers lookups on `a` alone via leftmost-prefix.
3. **Compound primary keys SHOULD be favored over single-column PK + separate indexes** — with `WITHOUT ROWID` the compound PK needs no separate index.
4. **Sparse flags SHOULD use partial indexes** — `CREATE INDEX idx ON t(data) WHERE isAdmin = 1` costs nothing for non-matching rows.
5. **Frequently-updated columns SHOULD be kept out of indexes** — UPDATE only rewrites indexes covering changed columns.
6. **`INSERT OR REPLACE` MAY be used freely** — 1 write even when replacing.
7. **`UNIQUE` in a column definition creates a hidden index** — 1 extra write/INSERT each; a compound PK SHOULD be considered instead.

Evidence: [blog post](../../website/blog/2026-02-23-do-sqlite-write-costs/index.md) and `experiments/do-write-costs/`.
