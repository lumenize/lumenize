---
paths:
  - "packages/**/*.ts"
  - "apps/**/*.ts"
---

# Writing a Durable Object

This file applies to every DO — the concerns herein apply in **every layer, including Nebula**: storage, synchronous discipline, no mutable instance state, IDs, wall-clock billing, DO class registration. None of this is "dropping down to raw primitives" — it's just how you write a correct DO (e.g. `ctx.storage.sql.exec()` with no cross-DO call is exactly right anywhere).

**How a DO *communicates* is a separate concern, and which rules apply depends on your layer:** on Mesh → [mesh.md](mesh.md); without Mesh (raw-DO infrastructure + framework internals) → [raw-comm.md](raw-comm.md). Not sure which layer you're in? → [workers-projects.md](workers-projects.md).

## Storage
Always synchronous, never the legacy async API (`await ctx.storage.put/get`).
- **`this.svc.sql` template literal (when in Mesh)** — everyday queries with relatively small return sets. Readable `${value}` interpolation with automatic parameter binding (also your SQL-injection defense — never string-concat user input into SQL); returns results as an array.
- **`ctx.storage.sql.exec()` directly** — a recommended first-class choice (not a fallback) when you need streaming/cursors (process rows without loading all into memory), large result sets (`LIMIT`/`OFFSET` pagination), metadata (`rowsRead`, `rowsWritten`), or raw mode (arrays instead of repeated-column-name objects).
- **`ctx.storage.kv.*`** — counters, flags, single-entity lookups, config state.

## Initialization (schema setup, in-DO migrations)
Do one-time setup — `CREATE TABLE IF NOT EXISTS`, in-DO schema migration, config — at startup so it completes before any request.
- **Raw DOs**: synchronous setup in the constructor body is enough — the constructor runs to completion before any request is dispatched, and sync storage needs no `await`. Use `ctx.blockConcurrencyWhile(async () => …)` **only** when setup must `await`; it's unnecessary for purely-sync setup.
- **Mesh DOs (`LumenizeDO`)**: put setup in the **`onStart()` hook, never by overloading the constructor**. The base constructor already calls `onStart()` inside `ctx.blockConcurrencyWhile(...)`, so requests block until it finishes and `onStart` may be `async`. Overloading the `LumenizeDO` constructor fights that machinery.

## Avoid opening input gates or account for race condition risk
`setTimeout`, `setInterval`, or `await` from inside a DO will open input gates, so avoid unless you account for the race-condition risk. `waitUntil` is never needed in a DO but may be in a default Worker or `WorkerEntrypoint`

## Keep methods synchronous
These entry points should be `async`: `fetch()`, `alarm()`, `webSocketMessage()`, `webSocketClose()`, `webSocketError()`. Other methods except those that must use `await` — business logic, route handlers, helpers — should be synchronous. 

**Exceptions**: only methods calling APIs with no synchronous alternative (`crypto.subtle.*`, `fetch()`, Workers RPC calls, etc.) may be `async`.

## No mutable instance state
DOs can be hibernated or evicted at any time, so instance variables holding mutable state are lost. Use `ctx.storage.kv`/`ctx.storage.sql` as the source of truth — reads are ~1/1,000th the cost of writes and frequently-read values are cache-served, so read-on-every-access has no measurable penalty and avoids inconsistency. However, write costs add up so use judiciously.

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
A DO is billed for elapsed time whenever any of these are active: `await`ing I/O, `setTimeout`/`setInterval`, or holding Workers RPC stubs open. Mitigations:
- Keep business logic synchronous (above).
- Use `using` for Workers RPC stubs in the narrowest scope so they dispose promptly:
  ```typescript
  { using stub = env.MY_DO.get(id); const result = stub.someMethod(); }
  ```
- Avoid blocking external API calls from a DO. Mesh code uses the two-one-way-call pattern ([mesh.md](mesh.md))
- Use `setTimeout`/`setInterval` only to keep a DO from hibernating for up to a few minutes; beyond that use `alarm()` or two one-way calls.

## Dynamic Worker Loader cache
`env.LOADER.get(bundleId, ...)` caches by `bundleId` **per-Worker-project**, not per-DO. Multiple DO instances in the same Worker project share the cache, so identical `bundleId` values silently collide on the first cached entry. Scope `bundleId` by something globally unique (include a tenant identifier or equivalent). The DO's cross-tenant guards don't intervene — the loader binding is shared infrastructure.

## DO class registration (`wrangler.jsonc` `migrations`)
Cloudflare's `wrangler.jsonc` `migrations` array is a misleading name: it does **not** migrate SQL schema. It's the **DO class registry/versioning** — it tells Cloudflare which DO classes exist, whether each is SQLite-backed, and how class renames/deletes/transfers map across deploys.

The rule that matters: a DO using the synchronous storage API must be **SQLite-backed**, so register it with `new_sqlite_classes`, **never** `new_classes` (which creates a non-SQLite DO where only the legacy async API works). This can't change once a class deploys to production; during testing you can change it freely.

```jsonc
// Wrong — ctx.storage.kv.* throws
"migrations": [{ "tag": "v1", "new_classes": ["MyDO"] }]
// Right
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyDO"] }]
```

These entries only matter when deployed to Cloudflare's cloud; in local testing every run is a fresh deploy, so they don't take effect there.

**Not the same as database/schema migration** — evolving a DO's SQLite tables (add a column, backfill, reindex) is a separate concern that lives in DO code (idempotent `CREATE TABLE IF NOT EXISTS` at construction, versioned in-DO `ALTER TABLE` logic), never in `wrangler.jsonc`.

## SQL naming
- **Tables**: PascalCase (`Subjects`, `RefreshTokens`, `MagicLinks`)
- **Columns**: camelCase (`emailVerified`, `tokenHash`, `createdAt`)
- **Indexes**: `idx_TableName_columnName` for a single column (`idx_Subjects_email`). For **compound or partial indexes**, use a concise *purpose* suffix rather than concatenating column names — `idx_TableName_<purpose>`: e.g. `idx_Snapshots_current` for `Snapshots(resourceId, validTo) WHERE validTo = <end-of-time sentinel>`, or `idx_Subjects_isAdmin` for `Subjects(sub) WHERE isAdmin = 1`.

This maps SQL rows directly to TS interfaces with minimal conversion. SQLite column names are case-insensitive in queries but case-preserved in output.

## SQLite write-cost optimization
DO SQLite charges **$1.00/M rows written — 1,000× the cost of reads** ($0.001/M). INSERT cost = `1 (row) + 1 per index updated`. Design schemas to minimize index writes:

1. **Always `WITHOUT ROWID` on tables with TEXT or compound primary keys** — otherwise SQLite keeps a hidden rowid *and* a separate index for the text PK, doubling INSERT cost. `INTEGER PRIMARY KEY` aliases the rowid and doesn't need it.
2. **Prefer compound indexes over multiple single-column indexes** — `(a, b)` costs 1 write/INSERT and covers lookups on `a` alone via leftmost-prefix.
3. **Favor compound primary keys over single-column PK + separate indexes** — with `WITHOUT ROWID` the compound PK needs no separate index.
4. **Partial indexes for sparse flags** — `CREATE INDEX idx ON t(data) WHERE isAdmin = 1` costs nothing for non-matching rows.
5. **Keep frequently-updated columns out of indexes** — UPDATE only rewrites indexes covering changed columns.
6. **Use `INSERT OR REPLACE` freely** — 1 write even when replacing.
7. **`UNIQUE` in a column definition creates a hidden index** — 1 extra write/INSERT each; consider a compound PK instead.

Evidence: [blog post](../../website/blog/2026-02-23-do-sqlite-write-costs/index.md) and `experiments/do-write-costs/`.
