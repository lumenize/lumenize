# do-read-cache: does a SQLite-backed Durable Object cache what it reads?

**Question.** Kenton Varda's post *Durable Objects: Easy, Fast, Correct — Choose three* (2021-08-03) describes an automatic in-memory cache in front of an object's storage. Someone at Cloudflare wasn't sure it survived the move to the SQLite storage engine. Does it? If not, what caches reads now, how much does it hold, and what does a miss cost?

**Answer.**

- **The cache from the 2021 post is gone on SQLite-backed objects.** Every `kv.get` runs a SQL lookup. What keeps reads in memory now is SQLite's own page cache, at its default 2000 KiB per object, and it goes away with the object.
- **Deployed, the knee sits where that cache predicts.** Reads stay flat up to about 480 single-page rows (1.7 MB of row data), then climb.
- **While the host's RAM holds the file, the cache matters less than the per-call cost.** Deployed, a cached `sql.exec` point read costs about 21 µs of CPU, and missing the cache adds about 5.6 µs, all CPU. A 3.5 KB `kv.get` costs about 25 µs cached and about 56 µs at a 63 MB working set, because each value spans two pages. Locally the same cached read costs 6.4 µs.
- **After an hour idle, a DO's data had to come back from somewhere slower, in one of two ways.** Five of 8 DOs woke quickly and then waited about 90 µs per page on first touch (164–216 µs per page in all), the profile of a random flash read. Three woke after about 0.4 s of waiting and then read at RAM speed.
- **The object can't time its own work with `Date.now()`, even across an await.** That shaped the method (§ *The object's clock can't time its own work*).

## What the source says

Read at workerd `96fb2ba` (main, 2026-10-14), which builds SQLite 3.53.4.

- **There's no key→value cache.** `kv.get` and the async `ctx.storage.get` both reach [`ActorSqlite::get`](https://github.com/cloudflare/workerd/blob/96fb2ba7430408b56c43d1d3c305a8c976788b2a/src/workerd/io/actor-sqlite.c%2B%2B#L704-L711). It runs [`SELECT value FROM _cf_KV WHERE key = ?`](https://github.com/cloudflare/workerd/blob/96fb2ba7430408b56c43d1d3c305a8c976788b2a/src/workerd/util/sqlite-kv.h#L112-L114) on every call. The 2021 cache was `ActorCache`, which only the KV backend uses.
- **`sql.exec` caches compiled statements, not results.** It keeps them [keyed by SQL text, in a 1 MB LRU](https://github.com/cloudflare/workerd/blob/96fb2ba7430408b56c43d1d3c305a8c976788b2a/src/workerd/api/sql.c%2B%2B#L20-L25).
- **The page cache is SQLite's default 2000 KiB.**
  - [The build](https://github.com/cloudflare/workerd/blob/96fb2ba7430408b56c43d1d3c305a8c976788b2a/build/BUILD.sqlite3#L13-L23) sets no `SQLITE_DEFAULT_CACHE_SIZE`.
  - `cache_size` isn't on the [pragma allowlist](https://github.com/cloudflare/workerd/blob/96fb2ba7430408b56c43d1d3c305a8c976788b2a/src/workerd/util/sqlite.c%2B%2B#L576-L606), so an object can't read or change it.
  - A [128 MB soft heap limit](https://github.com/cloudflare/workerd/blob/96fb2ba7430408b56c43d1d3c305a8c976788b2a/src/workerd/util/sqlite.c%2B%2B#L1486-L1494) covers the whole process and lets SQLite purge pages under memory pressure.
  - `ActorSqlite` owns the database handle, so abort, eviction and hibernation all drop the cache.
  - With 4 KiB pages and SQLite's per-page bookkeeping, 2000 KiB holds roughly 450 to 500 pages.
- **Whether overflow pages skip the page cache depends on the file layer.**
  - SQLite reads an overflow page straight from the file only when the file layer reports `SQLITE_IOCAP_SUBPAGE_READ` (`sqlite3PagerDirectReadOk` in `pager.c`).
  - The unix file layer always reports it (`setDeviceCharacteristics` in `os_unix.c`), and local `wrangler dev` wraps the unix file layer.
  - workerd's own `kj::File` layer reports `options.deviceCharacteristics`, which [defaults to `0x1000`](https://github.com/cloudflare/workerd/blob/96fb2ba7430408b56c43d1d3c305a8c976788b2a/src/workerd/util/sqlite.h#L859), `POWERSAFE_OVERWRITE` only.
  - That difference explains why local and deployed `kv` disagree below.
- **What's below the file layer in production isn't in workerd.** workerd times every statement with a real clock for Cloudflare's own metrics ([`reportQueryEvent`](https://github.com/cloudflare/workerd/blob/96fb2ba7430408b56c43d1d3c305a8c976788b2a/src/workerd/util/sqlite.c%2B%2B#L951-L977)), so Cloudflare can see per-query latency directly.

## Method

`experiment-do-read-cache`, deployed 2026-10-14 with compatibility date 2026-10-01, plus local `wrangler dev` 4.147.0 as a positive control.

- **The data.** Each object holds 18,000 rows of 3,500 random bytes, written both ways:
  - In `t (id INTEGER PRIMARY KEY, v BLOB)` (`sql`), each row fills one 4 KiB leaf page.
  - Through `ctx.storage.kv` (`kv`), in `_cf_KV`, which is `WITHOUT ROWID`, SQLite keeps 489 bytes of each row on a shared leaf (about 8 rows per page) and puts the rest on an overflow page.
  - The database is 158 MB.
- **The reads.** A pass reads rows 0 to n−1 once each, in a fresh random order, so n sets the working set. The read is `sql.exec('SELECT v FROM t WHERE id = ?').one()` or `kv.get(key)`.
- **The sweep.** On each object, for each n and each API, in random order over 3 rounds:
  - a ping;
  - one untimed pass to load that working set;
  - a timed call of about 10,000 reads.
- **The clocks.**
  - Deployed: each invocation's `cpuTimeMs` and `wallTimeMs` from Workers Logs, joined to the call by a `{probe, seq}` line the object logs (`scripts/logs.mjs`). The table numbers are CPU per read.
  - Locally: the Worker's bracket around the call, net of the adjacent ping. Locally that is real time.
- **Placement.** Objects are created with `locationHint: 'enam'`. Ten landed in ATL ×3, IAD ×3, MIA ×2, ORD and EWR.
- **The arms.**
  - The abort arm aborts, pings and makes one cold pass and one warm pass, 8 cycles × 8 conditions on 6 objects.
  - The idle arm fills objects, aborts them, and reads them hours later (§ *Idle*).

## Results

### The object's clock can't time its own work

On one deployed object, 10 calls of 10,240 `sql` reads each. The Worker and the object were both in IAD.

| what was read | result |
|---|---|
| `Date.now()` before vs after the reads | +0 ms, 10 of 10 |
| after `await setTimeout(0)` | +0 ms, 10 of 10. A timer resumes at its scheduled time. |
| after `await` of an RPC to itself | +38 to +223 ms |
| Workers Logs, the same invocations | wall 253–521 ms, CPU 219–479 ms |
| the Worker's bracket around the call | 260–528 ms, within 30 ms of the wall time |

The caller's clock is fine, because the callee's work is the caller's wait. Inside the busy object, the clock after an I/O reply moves by an amount unrelated to the CPU just spent. In an earlier run it read +673 ms on a call the Worker timed at 343 ms. This corrects a belief the repo had worked from, that an await reveals real elapsed time.

### Deployed: SQLite's default cache

CPU µs per read. For each object, take the median over rounds; the table shows the median across 10 objects. ×hot is each object's ratio to its own 64- and 128-row reads.

| rows | data | `sql` µs | ×hot | `kv` µs | ×hot |
|---:|---:|---:|---:|---:|---:|
| 64 | 0.2 MB | 20.9 | 0.99 | 23.3 | 1.01 |
| 256 | 0.9 MB | 19.3 | 0.91 | 23.5 | 1.09 |
| 448 | 1.6 MB | 23.3 | 1.02 | 23.7 | 1.10 |
| 512 | 1.8 MB | 21.6 | 1.12 | 26.3 | 1.18 |
| 640 | 2.2 MB | 23.0 | 1.14 | 28.4 | 1.31 |
| 1,024 | 3.6 MB | 26.9 | 1.12 | 30.3 | 1.45 |
| 2,048 | 7.2 MB | 24.6 | 1.17 | 43.1 | 1.83 |
| 4,096 | 14 MB | 24.1 | 1.23 | 42.9 | 1.96 |
| 8,192 | 29 MB | 25.5 | 1.31 | 50.7 | 2.40 |
| 18,000 | 63 MB | 28.0 | 1.24 | 56.4 | 2.31 |

- **`sql`'s knee is the default cache.** A fit of "flat to C rows, then h + (m − h)(1 − C/n)" puts C at 480 rows (480 pages), flat at 21.0 µs and approaching 26.5 µs. A miss adds about 5.6 µs of CPU.
- **`kv` climbs from about the same point** (×1.30 at 480 rows) and keeps climbing to ×2.3. Each row is an overflow page plus an eighth of a leaf. With overflow pages going through the cache, about 420 rows fill it, and past that a read misses on two pages.
- **Misses are mostly CPU.** CPU is a median 82% of a read call's wall time. The layer under SQLite is costing work, not waiting on a disk.
- **Objects differ about 2× at the same size.** Cached `sql` reads ran at 17–24 µs on eight objects and 42–44 µs on two in ATL. That fits the slow instances `do-socket-drop-probe` found. ×hot divides it out.

### Deployed: one 10-field record per read

The same comparison at the size a real read usually is. Each DO holds 100,000 records of 10 fields (`id`, `name`, `email`, `status`, `plan`, `count`, `score`, `createdAt`, `active`, `tags`). `kv` stores each as the object itself, about 200 bytes. `sql` stores it as 10 columns of table `r`, and `SELECT … FROM r WHERE id = ?` returns the same 10-key object. The in-memory arm holds the same 100,000 records in a `Map` on the instance and reads `this.#records.get(key)`. Every arm builds the key string per read.

Each cell covers 10 DOs (ORD ×3, IAD ×3, ATL ×2, EWR ×2), 3 rounds each, 20,000 reads per timed call (2,000,000 for the `Map`). 147 of 180 timed calls came back from Workers Logs. The cell is the median across DOs of each DO's median.

| condition | CPU µs per read | DOs' range | waiting µs per read |
|---|---:|---:|---:|
| `Map` on the instance, 128 records cycled | 0.22 | 0.17–0.34 | 0 |
| `Map` on the instance, all 100,000 | 0.93 | 0.43–1.73 | 0.2 |
| `kv.get`, 128 records cycled (cache hit) | 8.8 | 7.6–17.3 | 0.6 |
| `kv.get`, 20,000 of 100,000 (about 9 in 10 miss) | 15.8 | 13.5–27.7 | 0.5 |
| `sql` point read, 128 records cycled (cache hit) | 18.8 | 15.8–33.2 | 0.9 |
| `sql` point read, 20,000 of 100,000 (about 9 in 10 miss) | 24.3 | 19.7–52.1 | 1.5 |

- **A cache hit costs about 40× (`kv`) to 85× (`sql`) a `Map` lookup on the instance.** A miss, with the file still in the host's RAM, adds 5.5–7 µs of CPU and no waiting.
- **For a small record, `kv.get` costs less than half of `sql.exec`.** `kv` hands back one deserialized value, while `sql` builds the row object from 10 columns through the cursor. For the 3,500-byte blob the two were close (25 vs 21 µs).
- **"Waiting" is wall minus CPU, net of the ping's.** It stays under 2 µs per read in every row, so none of these reads wait on storage.

### Local: the same knee for `sql`; `kv`'s overflow pages skip the cache

Real-time µs per read, net of ping, median across 3 objects (`wrangler dev`, macOS).

| rows | `sql` µs | `kv` µs |
|---:|---:|---:|
| 64 | 6.49 | 13.48 |
| 448 | 6.50 | 13.05 |
| 640 | 6.85 | 13.66 |
| 1,024 | 7.18 | 13.04 |
| 2,048 | 7.28 | 13.67 |
| 4,096 | 7.57 | 14.99 |
| 18,000 | 7.83 | 16.50 |

- **`sql`'s knee fits at C = 432 rows**, flat at 6.40 µs and approaching 7.81 µs. A miss is a `pread` from the OS cache at about 1.4 µs. This is the positive control: the probe finds the cache where the source says it is.
- **`kv` stays flat to 2,048 rows, 4 to 8× further than `sql`.** Here the unix file layer lets overflow pages bypass the cache, so only the 8-rows-a-page leaves compete for it. Deployed, `kv` turns at the same point as `sql`, so production's file layer evidently doesn't report `SUBPAGE_READ`. That is an inference from the curves, not something read in production code.
- **The same cached read costs 3× more CPU deployed than local wall time.** Production does per-statement bookkeeping that the source shows (a latency measurement and a query event per statement). We didn't isolate how much of the 3× that explains.

### After `ctx.abort()`

All 384 deployed aborts produced a new object, as did all 240 local ones. The first call after an abort, which rebuilds the object, took a median 124 ms from the Worker. A ping to a live object in the sweep took 38 ms.

The cost of the cold first pass couldn't be resolved from the noise. Deployed CPU ms, cold pass minus the warm pass after it, mean ± SE:

| | 256 rows | 448 rows | 4,096 rows | 18,000 rows |
|---|---:|---:|---:|---:|
| `sql` | +1.2 ± 0.9 | −0.1 ± 2.4 | −10 ± 13 | +9 ± 33 |
| `kv` | −0.1 ± 1.0 | +3.9 ± 1.4 | −22 ± 15 | +28 ± 52 |

A dropped page cache predicts about +1.4 ms for 256 `sql` rows and about +5 ms for 448 `kv` rows. Both fit that, and so does zero, apart from `kv` at 448. At 4,096 rows and above, both passes miss and they come out equal, as they should. That the cache dies with the object rests on the source (`ActorSqlite` owns the handle). What the measurement adds is scale: refilling a 2 MB cache costs a few milliseconds, against about 85 ms to rebuild the object.

### Idle

Four objects, each filled with 18,000 rows both ways and then aborted, were read 66 minutes later. Each took one ping, then one cold pass over all 18,000 rows of each API (alternating which went first), then one warm pass of each. Per row, from Workers Logs:

| object | API, order | cold: total µs | waiting µs | CPU µs | warm: total µs | waiting µs |
|---|---|---:|---:|---:|---:|---:|
| 0 | `sql`, first | 216 | 87 | 129 | 48 | 3 |
| 0 | `kv`, second | 226 | 87 | 138 | 92 | 6 |
| 1 | `kv`, first | 194 | 97 | 97 | 76 | 9 |
| 1 | `sql`, second | 164 | 85 | 79 | 28 | 2 |
| 2 | `sql`, first | 190 | 100 | 90 | 38 | 2 |
| 2 | `kv`, second | 180 | 87 | 93 | 72 | 5 |
| 3 | `kv`, first | 182 | 86 | 95 | 73 | 6 |
| 3 | `sql`, second | 180 | 101 | 79 | — | — |

- **The file was no longer in the host's RAM.** Every cold pass waited 85–101 µs per row, about one page each, whichever API went first. In the sweep, where the data had been written minutes earlier, a miss waited for nothing.
- **About 90 µs is a random 4 KB flash read.** The 2024 SQLite post says the database sits on a local SSD. A fetch from elsewhere in the data center could also land near 90 µs, and nothing here tells the two apart.
- **CPU rose too, by about 50–85 µs per row.** Waiting alone doesn't explain the cold pass. What the extra CPU does (kernel I/O work, page-in work in Cloudflare's layer, or both) isn't visible from here.
- **Opening the object stayed cheap.** The first call after 66 minutes took 12–65 ms of the object's wall time and no CPU, so the cost lands on the first reads, not on the wake.
- **The next pass is back to RAM speed:** 28–48 µs for `sql`, with 2–3 µs of waiting.

**The same check with 10-field records came out differently.** Four DOs holding 100,000 records each (35 MB) were seeded at 17:32Z and read 65 minutes later. Each read 20,000 records sampled from all of them.

| DO | first call: DO wall | its CPU | cold reads: µs per read (waiting) | warm reads: µs per read (waiting) |
|---|---:|---:|---|---|
| 0 | 414 ms | 0 ms | `sql` 23.2 (1.4), `kv` 33.4 (1.8) | `sql` 23.2 (0.4), `kv` 35.5 (2.6) |
| 1 | 20 ms | 1 ms | `kv` 70.3 (23.6), `sql` 68.5 (15.7) | `kv` 33.3 (1.2), `sql` 77.5 (8.1) |
| 2 | 456 ms | 0 ms | `sql` 25.0 (2.4), `kv` 22.9 (2.5) | `sql` 25.5 (2.9), `kv` 17.6 (1.4) |
| 3 | 463 ms | 0 ms | `kv` 24.3 (3.1), `sql` 28.2 (3.9) | `kv` 24.4 (6.5), `sql` 29.1 (5.2) |

- **Three of the four woke slowly and then read at RAM speed.** Their first call, which reads nothing, spent 414–463 ms waiting with no CPU, and afterwards cold reads cost the same as warm ones. That looks like the whole database being brought back before the call ran.
- **The fourth behaved like the 3.5 KB DOs.** It woke in 20 ms, and then its cold reads waited 16–24 µs each. About 6 reads share each `sql` page and about 4 each `kv` page here, so that works out to roughly 90 µs per page on first touch, the same as the 3.5 KB run.
- **So after an hour idle there are at least two cold paths.** Either the first call waits about 0.4 s and nothing after it is cold, or the wake is quick and each page waits about 90 µs the first time it's read. Across 8 DOs, 3 took the first path and 5 the second, all 3 among the 35 MB record DOs and none among the 158 MB ones. Eight is too few to say what decides it.

Four more objects, seeded at 16:16Z, are for a next-day check:

```sh
cd experiments/do-read-cache
BASE=https://experiment-do-read-cache.transformation.workers.dev node scripts/probe.mjs check-idle results/idle-seed-2026-10-14T16-16-06-344Z.json
node scripts/logs.mjs results/idle-check-deployed-<run>.json && node scripts/analyze.mjs results/idle-check-deployed-<run>.json
```

## What this means

- **"Automatic in-memory caching" now means SQLite's page cache.** It holds 2000 KiB per object, can't be resized, and is gone after an abort, eviction or hibernation. A cached read still walks the B-tree and pays the full per-call cost, about 20 µs of CPU deployed, so 1,000 cached point reads cost about 20 ms of CPU.
- **For single-page rows, the cache saves about 20% while the host's RAM holds the file.** A miss adds about 5.6 µs to a 21 µs read. Values that overflow a page cost more cold: a `kv` value over about 1 KB takes two pages, and its reads come out 2.3× slower once the working set is well past 2 MB.
- **After an idle hour, a page SQLite doesn't have costs about 8× a cached read.** The first read of each page waited about 90 µs and cost about 180 µs in all. An object woken after an idle hour pays that once per page it touches, then runs at RAM speed again.
- **Per-call cost dominates a point read, not cache residency.** We didn't measure a query returning many rows per call.
- **Local runs flatter both the per-call cost (3×) and `kv`'s cache behavior.** A local measurement of either should not be quoted as production.

## Side findings

- **Workers Logs dropped the `console.log` line of nearly every read that logged after about 300–700 ms of CPU.** The invocation's own event, with its CPU and wall time, still arrived. Short invocations kept their lines.
  - `scripts/logs.mjs` recovers the lost ones from call order, filling a gap only when its event count matches its `seq` gap exactly. That recovered 816 of the sweep's calls.
  - The object now logs on entry.
- **A call that does nothing is never under a few milliseconds.** Pings across the sweep and the record run, all from one machine on the US East Coast:

  | same no-op call | min | median | p90 |
  |---|---:|---:|---:|
  | the DO's own wall time (Workers Logs) | 3 ms | 17–30 ms | 29–101 ms |
  | Worker → DO → Worker, same colo | 7 ms | 15–18 ms | 35–58 ms |
  | client → edge → DO → back | 31 ms | 60–68 ms | 100–222 ms |

- **A call an object makes to itself shares the caller's `requestId` in Workers Logs and has an event of its own.** A line logged after awaiting that call is filed under the self-call, which is why `clock` logs before its first await.
- **Some requests from this machine landed in WAW and ARN instead of IAD.** An object is created where its first request lands, and the first sweep's object was created in WAW, which put a transatlantic round trip inside every Worker-timed call. `locationHint` fixes placement. Workers Logs' CPU time doesn't depend on placement.

## Files

- `src/index.ts`: the Worker and `ProbeDO`.
- `scripts/probe.mjs`: the driver, with the `clock`, `sweep`, `abort`, `seed-idle`, `check-idle` and `wipe` modes.
- `scripts/logs.mjs`: the Workers Logs join.
- `scripts/analyze.mjs`: the tables. `CLOCK=cpu|wall|worker` picks the clock.
- `results/`: one JSON file per run. Every sweep and abort object was wiped when its run ended. The 16:15Z and 17:32Z idle batches were wiped by their checks. The 16:16Z batch holds 158 MB per DO until `check-idle` or `wipe` runs on `results/idle-seed-2026-10-14T16-16-06-344Z.json`.
