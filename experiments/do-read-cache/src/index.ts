/**
 * Does a SQLite-backed Durable Object keep what it reads in memory, and up to what size?
 *
 * workerd's source says there is no key→value cache, only SQLite's page cache at its default
 * 2000 KiB, dropped with the object (RESULTS.md § *What the source says*). This measures it.
 *
 * Data: `fill` writes rows of ROW_BYTES random bytes, ids 0..n-1, into the user table `t` (`sql`)
 * or through `ctx.storage.kv` (`kv`). A `read` pass touches rows 0..rows-1 once each in a freshly
 * shuffled order, so `rows` sets the working set and nothing is read sequentially.
 *
 * Timing. `read` and `ping` are synchronous and each logs `{ probe, seq }` on entry, which
 * `scripts/logs.mjs` joins to that invocation's wallTimeMs and cpuTimeMs in Workers Logs: the
 * primary measurement, taken by the runtime. The Worker also brackets every RPC (`workerMs`),
 * which is trustworthy only when the Worker ran in the object's own colo.
 *
 * Not the object's own clock: `clock` records why. `Date.now()` does not move during synchronous
 * work (`frozenMs`), resumes at a timer's scheduled time after `await setTimeout(0)` (`timerMs`),
 * and, deployed, advances after an RPC to itself by far less than the work's CPU time (`ioMs`).
 *
 * Records: the same questions for one 10-field record per read (about 200 bytes), the size a real
 * read usually is. `fillRecords` writes record i to table `r` as 10 columns (`sql`) or as the
 * object itself through `ctx.storage.kv` (`kv`). `readRecords` reads `reads` records sampled from
 * ids 0..of-1, so `of` sets the working set; `mem` reads the same records from a Map held on the
 * instance, built on first use.
 *
 * Routes, gated by the `x-bench-token` header:
 *   /op/{instance}?op=fill|fillRecords&api=&from=&count=
 *   /op/{instance}?op=read|clock&api=&rows=&passes=&seq=
 *   /op/{instance}?op=readRecords&api=sql|kv|mem&of=&reads=&seq=
 *   /op/{instance}?op=ping|abort|info|colo|wipe&seq=
 */
import { DurableObject } from 'cloudflare:workers';

/**
 * Bytes per row. In `t` a row this size fills one 4 KiB leaf page on its own. `_cf_KV` is WITHOUT
 * ROWID, so SQLite keeps 489 bytes of each row on a shared leaf (about 8 rows a page) and puts the
 * rest on an overflow page.
 */
const ROW_BYTES = 3500;

/** Where every object is created: near the driver, so a run's round trips stay short. */
const LOCATION_HINT = 'enam';

type Api = 'sql' | 'kv';

const keyOf = (i: number) => `k${String(i).padStart(7, '0')}`;

/** One 10-field record, about 200 bytes stored: the value the record arms read. */
interface Rec {
  id: number; name: string; email: string; status: string; plan: string;
  count: number; score: number; createdAt: string; active: boolean; tags: string;
}

const REC_COLUMNS = 'id, name, email, status, plan, count, score, createdAt, active, tags';
const recKeyOf = (i: number) => `r${String(i).padStart(7, '0')}`;

/** How many records the in-memory Map holds: every id a record arm can sample. */
const MEM_RECORDS = 100_000;

function recordOf(i: number): Rec {
  const n = String(i).padStart(7, '0');
  return {
    id: i, name: `User ${n}`, email: `user${n}@example.com`, status: i % 7 ? 'active' : 'paused',
    plan: ['free', 'pro', 'team'][i % 3], count: i % 1000, score: ((i * 7919) % 10007) / 10007,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), active: i % 2 === 0, tags: 'alpha,beta,gamma',
  };
}

/** `reads` ids from 0..of-1: distinct when reads ≤ of, otherwise whole shuffles back to back. */
function sampleIds(of: number, reads: number): Int32Array {
  if (reads <= of) return shuffled(of).subarray(0, reads);
  const out = new Int32Array(reads);
  for (let at = 0; at < reads; at += of) out.set(shuffled(of).subarray(0, Math.min(of, reads - at)), at);
  return out;
}

/** 0..n-1 in a uniformly random order (Fisher–Yates). */
function shuffled(n: number): Int32Array {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

export class ProbeDO extends DurableObject<Env> {
  #bootId = crypto.randomUUID();

  /** The `mem` arm's records. Instance state on purpose: this is the thing being compared. */
  #records: Map<string, Rec> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v BLOB NOT NULL)');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS r (id INTEGER PRIMARY KEY, name TEXT, email TEXT, status TEXT,
      plan TEXT, count INTEGER, score REAL, createdAt TEXT, active INTEGER, tags TEXT)`);
  }

  fillRecords(api: Api, from: number, count: number) {
    for (let i = from; i < from + count; i++) {
      const rec = recordOf(i);
      if (api === 'sql') {
        this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO r (${REC_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          rec.id, rec.name, rec.email, rec.status, rec.plan, rec.count, rec.score, rec.createdAt, rec.active ? 1 : 0, rec.tags);
      } else {
        this.ctx.storage.kv.put(recKeyOf(i), rec);
      }
    }
    return { bootId: this.#bootId, databaseSize: this.ctx.storage.sql.databaseSize };
  }

  readRecords(api: Api | 'mem', of: number, reads: number, seq: number) {
    // Logged first: Workers Logs dropped the line of every read that logged it after ~400 ms of CPU.
    console.log(JSON.stringify({ probe: 'readRecords', seq }));
    let built = false;
    if (api === 'mem' && !this.#records) {
      this.#records = new Map();
      for (let i = 0; i < MEM_RECORDS; i++) this.#records.set(recKeyOf(i), recordOf(i));
      built = true;
    }
    const ids = sampleIds(of, reads);
    let check = 0;
    if (api === 'sql') {
      const sql = this.ctx.storage.sql;
      for (const id of ids) check ^= sql.exec(`SELECT ${REC_COLUMNS} FROM r WHERE id = ?`, id).one().count as number;
    } else if (api === 'kv') {
      const kv = this.ctx.storage.kv;
      for (const id of ids) check ^= (kv.get(recKeyOf(id)) as Rec).count;
    } else {
      const records = this.#records!;
      for (const id of ids) check ^= records.get(recKeyOf(id))!.count;
    }
    return { bootId: this.#bootId, reads, check, built };
  }

  fill(api: Api, from: number, count: number) {
    const bytes = new Uint8Array(ROW_BYTES);
    for (let i = from; i < from + count; i++) {
      crypto.getRandomValues(bytes);
      if (api === 'sql') this.ctx.storage.sql.exec('INSERT OR REPLACE INTO t (id, v) VALUES (?, ?)', i, bytes.buffer);
      else this.ctx.storage.kv.put(keyOf(i), bytes);
    }
    return { bootId: this.#bootId, databaseSize: this.ctx.storage.sql.databaseSize };
  }

  #passes(api: Api, rows: number, passes: number): number {
    let check = 0;
    for (let p = 0; p < passes; p++) {
      const order = shuffled(rows);
      if (api === 'sql') {
        const sql = this.ctx.storage.sql;
        for (const id of order) check ^= new Uint8Array(sql.exec('SELECT v FROM t WHERE id = ?', id).one().v as ArrayBuffer)[0];
      } else {
        const kv = this.ctx.storage.kv;
        for (const id of order) check ^= (kv.get(keyOf(id)) as Uint8Array)[0];
      }
    }
    return check;
  }

  read(api: Api, rows: number, passes: number, seq: number) {
    // Logged first: Workers Logs dropped the line of every read that logged it after ~400 ms of CPU.
    console.log(JSON.stringify({ probe: 'read', seq }));
    const t0 = Date.now();
    const check = this.#passes(api, rows, passes);
    const frozenMs = Date.now() - t0;
    return { bootId: this.#bootId, reads: rows * passes, check, frozenMs };
  }

  /** The baseline a read is netted against: `read`'s shape with no storage work. */
  ping(seq: number) {
    console.log(JSON.stringify({ probe: 'ping', seq }));
    return { bootId: this.#bootId };
  }

  /** `read`, then what the object's own clock says the work took, read three ways. */
  async clock(api: Api, rows: number, passes: number, seq: number) {
    // Logged before the first await: a line logged after it carries the self-call's requestId.
    console.log(JSON.stringify({ probe: 'clock', seq }));
    const t0 = Date.now();
    const check = this.#passes(api, rows, passes);
    const frozenMs = Date.now() - t0;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const timerMs = Date.now() - t0;
    await this.env.PROBE.get(this.ctx.id).tick();
    const ioMs = Date.now() - t0;
    return { bootId: this.#bootId, reads: rows * passes, check, frozenMs, timerMs, ioMs };
  }

  tick() {
    return 0;
  }

  abort(): never {
    this.ctx.abort('probe reset');
    throw new Error('ctx.abort() returned');
  }

  info() {
    return {
      bootId: this.#bootId,
      databaseSize: this.ctx.storage.sql.databaseSize,
      pageSize: this.ctx.storage.sql.exec('PRAGMA page_size').one().page_size as number,
    };
  }

  /** The colo this object runs in, from Cloudflare's trace endpoint (one outbound fetch). */
  async colo() {
    const text = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
    return { bootId: this.#bootId, colo: /colo=(\w+)/.exec(text)?.[1] ?? '?' };
  }

  wipe() {
    this.ctx.storage.deleteAll();
    return { bootId: this.#bootId };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.BENCH_TOKEN || request.headers.get('x-bench-token') !== env.BENCH_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const [, route, instance] = url.pathname.split('/');
    if (route !== 'op' || !instance) return new Response('Not Found', { status: 404 });

    const q = url.searchParams;
    const num = (k: string) => Number(q.get(k) ?? 0);
    const api = q.get('api') === 'kv' ? 'kv' : 'sql';
    const stub = env.PROBE.getByName(instance, { locationHint: LOCATION_HINT });
    const op = q.get('op');

    const t0 = Date.now();
    let out: object;
    switch (op) {
      case 'fill': out = await stub.fill(api, num('from'), num('count')); break;
      case 'fillRecords': out = await stub.fillRecords(api, num('from'), num('count')); break;
      case 'readRecords': {
        const recApi = q.get('api') === 'mem' ? 'mem' : api;
        out = await stub.readRecords(recApi, num('of'), num('reads'), num('seq'));
        break;
      }
      case 'read': out = await stub.read(api, num('rows'), num('passes'), num('seq')); break;
      case 'clock': out = await stub.clock(api, num('rows'), num('passes'), num('seq')); break;
      case 'ping': out = await stub.ping(num('seq')); break;
      case 'info': out = await stub.info(); break;
      case 'colo': out = await stub.colo(); break;
      case 'wipe': out = await stub.wipe(); break;
      case 'abort':
        try {
          await stub.abort();
          out = { aborted: false };
        } catch (e) {
          out = { aborted: true, error: e instanceof Error ? e.message : String(e) };
        }
        break;
      default: return new Response(`unknown op ${op}`, { status: 400 });
    }
    // The Worker runs where the request landed and the object where it was created, so a Worker in
    // another colo adds its round trip to workerMs. The driver keeps the colo to filter on.
    const workerColo = (request.cf as { colo?: string } | undefined)?.colo;
    return Response.json({ ...out, workerMs: Date.now() - t0, workerColo });
  },
};
