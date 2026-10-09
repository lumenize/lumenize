# do-readonly-storage: does touching a Durable Object leave stored data, if the touch only reads?

**Question (Larry, 2026-10-09).** A Client may call a `PROFILE` id nobody created. `tasks/archive/mesh-gateway-routes-client-calls.md` made sure our code writes nothing for such an id, but our code still reads storage on every touch: `MeshDO`'s constructor checks `sqlite_master` for `__lmz_alarms`, an unscoped node's envelope runs `hasAlarmRow()`, and the Profile's `read` and `subscribe` run `#written()`. Does Cloudflare keep, and bill, stored data for an object whose only storage calls were reads? Local `wrangler dev` cannot answer it: miniflare creates every object's SQLite file at construction.

**Method.** `experiment-do-readonly-storage`, deployed 2026-10-09, one SQLite-backed class per arm so each arm is a namespace of its own. A Node process touches three objects per arm by name, then lists each namespace through Cloudflare's API (`GET /accounts/{id}/workers/durable_objects/namespaces/{ns}/objects`), which reports each object's `hasStoredData`. The experiment imports nothing, so it is not in the root `workspaces` and deploys with the repo's own wrangler (`cd apps/nebula && npx wrangler deploy -c ../../experiments/do-readonly-storage/wrangler.jsonc`), as `do-placement-probe` does.

| Arm | Class | What a touch does |
|---|---|---|
| `NOTHING` | `NothingDO` | constructed and called; no storage call |
| `SCHEMA_READ` | `SchemaReadDO` | one `sqlite_master` read, as Mesh's three reads are |
| `KV_GET` | `KvGetDO` | one `kv.get` of a missing key |
| `WRITE_DELETE_ALL` | `WriteThenDeleteAllDO` | one `kv.put`, then `deleteAll()` |
| `WRITE` | `WriteDO` | one `kv.put`, kept: the positive control |

```sh
BASE=https://experiment-do-readonly-storage.<subdomain>.workers.dev node scripts/probe.mjs touch r1
node scripts/probe.mjs list r1   # needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_WORKERS_READ_TOKEN
```

## Results

**A touch that only reads leaves no stored data. Our code's reads on an id nobody wrote cost a request, not storage.** Touched 14:15 UTC on 2026-10-09 and listed until 15:01; `results/` holds every listing.

| Arm | Listed by 15:01 | `hasStoredData` |
|---|---|---|
| `NOTHING`, no storage call | 3 of 3 | false, false, false |
| `SCHEMA_READ`, one `sqlite_master` read | 2 of 3 | false, false |
| `KV_GET`, one missing-key `kv.get` | 3 of 3 | false, false, false |
| `WRITE_DELETE_ALL`, a write then `deleteAll()` | 3 of 3 | false, false, false |
| `WRITE`, a write kept (the control) | 3 of 3 | **true, true, true** |

- **The control is what makes the falses mean something.** Each object that kept one write lists with stored data, so the listing reports stored data when there is some.
- **`deleteAll()` returns an object to no stored data.** `test-nebula`'s Star namespace fits it: 1,513 of its listed Stars have none and 71 have some, and a scope deleted or re-created is torn down by `ScopedMeshDO.teardown()`, which calls `deleteAll()`. How many of the 1,513 were torn down rather than only touched is not measured.
- **An object is listed whether or not it stored anything.** Every `NOTHING` object is listed, so "listed" means the object was built, never that it holds data.
- **The listing lags, by minutes to tens of minutes.** Nothing was listed at 2 or 5 minutes; the first objects appeared by 10, the control's by 15, and one `SCHEMA_READ` object was still missing at 46. Read a listing only after its positive control appears.

**The API's documented bounds are wrong in one place.** `limit` is documented as 10 to 10,000, and `limit=10` answers `10077 Malformed parameter: limit is too low`; with no `limit`, a page holds 1,000.

**The storage analytics could not be a second signal.** `durableObjectsStorageGroups` returned no rows for 2026-10-09 with these tokens, account-wide as well as per namespace, so `hasStoredData` is the only measure here. Whether it is what billing reads is not established; it is what Cloudflare reports per object.
