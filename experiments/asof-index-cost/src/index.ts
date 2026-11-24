/**
 * What an index over every version costs a write, and what it buys a read as of a past moment.
 * RESULTS.md has the question, the arms and the findings.
 *
 * One object holds one history depth. Inside it, each arm is a table: a copy of `Snapshots` as
 * `packages/resources/src/snapshots.ts` creates it, under its own name, with the arm's indexes.
 * So every arm of one depth sits on one host and can be compared by CPU, and each table's rows
 * are written as a live host would write them, with its indexes already on. The object is a
 * statement runner: the driver (scripts/) writes every statement, and each `run` call executes
 * one operation `reps` times and answers what the sql cursor counted.
 *
 * Timing is the runtime's, not the object's: `run` logs `{ probe, seq }` first, and
 * scripts/logs.mjs joins that line to the invocation's cpuTimeMs in Workers Logs. The object's
 * own clock does not move during synchronous work (experiments/do-read-cache).
 */
import { DurableObject } from 'cloudflare:workers';
import { claimsOf, END_OF_TIME, momentOf, nodeId, resourceId, typeOf, valueOf, writeOf } from './fixture.js';

const LOCATION_HINT = 'enam';

type Param = string | number;
type Row = Record<string, SqlStorageValue>;

export type Op =
  | { kind: 'noop' }
  | { kind: 'info'; tables: string[] }
  | { kind: 'ddl'; sql: string[] }
  | { kind: 'seed'; table: string; from: number; count: number }
  /** One statement, `reps` times. `rowsOut` answers its rows too, for small bookkeeping reads. */
  | { kind: 'sql'; sql: string; params?: Param[]; reps?: number; explain?: boolean; rowsOut?: boolean }
  /**
   * Today's first read: `scan` finds current rows, and each one written after `m0` is read again
   * by key as it stood at `m0`. `lookup` takes (resourceId, m0) and answers `matches`, the
   * filter tested on that earlier version.
   */
  | { kind: 'firstRead'; scan: string; scanParams?: Param[]; lookup: string; m0: string; reps?: number; explain?: boolean }
  | { kind: 'writes'; table: string; n: number };

/** FNV-1a over a string, so two ways of reading the same rows can be shown to agree. */
function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const TABLE = /^S_[A-Za-z0-9]+$/;

export class AsOfDO extends DurableObject<Env> {
  get #sql() {
    return this.ctx.storage.sql;
  }

  #plan(sql: string, params: Param[]): string[] {
    return this.#sql.exec<{ id: number; parent: number; detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
      .toArray().map((r) => `${r.parent === 0 ? '' : '  '}${r.detail}`);
  }

  /**
   * One write as `Snapshots.#write` makes it: read the current row by key, close it, open the new
   * one. Answers what each statement's cursor counted.
   */
  #write(table: string, r: number, i: number, create: boolean) {
    const id = resourceId(r);
    const validFrom = momentOf(i);
    let read = 0, closeWritten = 0;
    if (!create) {
      const cur = this.#sql.exec<{ validFrom: string }>(
        `SELECT validFrom FROM ${table} WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1`, id);
      const current = cur.toArray()[0];
      read += cur.rowsRead;
      if (!current) throw new Error(`write ${i} updates resource ${r}, which has no row`);
      const close = this.#sql.exec(`UPDATE ${table} SET validTo = ? WHERE resourceId = ? AND validFrom = ?`, validFrom, id, current.validFrom);
      close.toArray();
      read += close.rowsRead;
      closeWritten = close.rowsWritten;
    }
    const insert = this.#sql.exec(
      `INSERT INTO ${table} (resourceId, nodeId, typeName, ontologyVersion, validFrom, validTo, recordedClaims, deleted, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, nodeId(r), typeOf(r), 'v1', validFrom, END_OF_TIME, claimsOf(r), 0, valueOf(r, i));
    insert.toArray();
    return { read: read + insert.rowsRead, closeWritten, insertWritten: insert.rowsWritten };
  }

  run(seq: number, op: Op): object {
    console.log({ probe: 'run', seq });
    switch (op.kind) {
      case 'noop': return {};
      case 'info': return {
        databaseSize: this.#sql.databaseSize,
        seeded: Object.fromEntries(op.tables.map((t) => [t, this.ctx.storage.kv.get<number>(`seeded:${t}`) ?? 0])),
        indexes: this.#sql.exec<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).toArray(),
      };
      case 'ddl': {
        const out = [];
        for (const sql of op.sql) {
          const c = this.#sql.exec(sql);
          c.toArray();
          out.push({ sql, rowsRead: c.rowsRead, rowsWritten: c.rowsWritten });
        }
        return { ddl: out, databaseSize: this.#sql.databaseSize };
      }
      case 'seed': {
        if (!TABLE.test(op.table)) throw new Error('bad table');
        const key = `seeded:${op.table}`;
        const seeded = this.ctx.storage.kv.get<number>(key) ?? 0;
        if (op.from !== seeded) return { seeded, skipped: true };
        let rowsWritten = 0;
        this.ctx.storage.transactionSync(() => {
          for (let i = op.from; i < op.from + op.count; i++) {
            const { r, create } = writeOf(i);
            const w = this.#write(op.table, r, i, create);
            rowsWritten += w.closeWritten + w.insertWritten;
          }
          this.ctx.storage.kv.put(key, op.from + op.count);
        });
        return { seeded: op.from + op.count, rowsWritten };
      }
      case 'sql': {
        const params = op.params ?? [];
        const plan = op.explain ? this.#plan(op.sql, params) : undefined;
        let out: object = {};
        for (let rep = 0; rep < (op.reps ?? 1); rep++) {
          const cursor = this.#sql.exec<Row>(op.sql, ...params);
          let rows = 0, bytes = 0, check = 0;
          const kept: Row[] = [];
          for (const row of cursor) {
            rows++;
            if (typeof row.value === 'string') bytes += row.value.length;
            if (rep === 0) {
              check = (check + fnv(`${row.resourceId}|${row.validFrom}`)) >>> 0;
              if (op.rowsOut && kept.length < 500) kept.push(row);
            }
          }
          if (rep === 0) out = { rows, bytes, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten, check, out: op.rowsOut ? kept : undefined };
        }
        return { ...out, plan, reps: op.reps ?? 1 };
      }
      case 'firstRead': {
        const scanParams = op.scanParams ?? [];
        const plan = op.explain ? [this.#plan(op.scan, scanParams), this.#plan(op.lookup, ['x', op.m0])] : undefined;
        let out: object = {};
        for (let rep = 0; rep < (op.reps ?? 1); rep++) {
          let scanned = 0, asIs = 0, lookups = 0, found = 0, kept = 0, lookupRead = 0, bytes = 0, check = 0;
          const scan = this.#sql.exec<Row>(op.scan, ...scanParams);
          for (const row of scan) {
            scanned++;
            if ((row.validFrom as string) <= op.m0) {
              // Not written since the read began: the current row is the row at m0.
              asIs++;
              bytes += (row.value as string).length;
              if (rep === 0) check = (check + fnv(`${row.resourceId}|${row.validFrom}`)) >>> 0;
              continue;
            }
            lookups++;
            const before = this.#sql.exec<Row>(op.lookup, row.resourceId as string, op.m0);
            for (const old of before) {
              found++;
              if (old.matches) {
                kept++;
                bytes += (old.value as string).length;
                if (rep === 0) check = (check + fnv(`${row.resourceId}|${old.validFrom}`)) >>> 0;
              }
            }
            lookupRead += before.rowsRead;
          }
          if (rep === 0) out = { rows: asIs + kept, scanned, asIs, lookups, found, kept, scanRead: scan.rowsRead, lookupRead, rowsRead: scan.rowsRead + lookupRead, bytes, check };
        }
        return { ...out, plan, reps: op.reps ?? 1 };
      }
      case 'writes': return this.#runWrites(op);
    }
  }

  /**
   * `n` creates and `n` updates of each type, past the seeded writes, with each statement's
   * `rowsWritten`. A counter in storage keeps two calls from reusing a resource or a moment, and
   * the call is one transaction, so a retried call never meets half of its first attempt.
   */
  #runWrites(op: Extract<Op, { kind: 'writes' }>) {
    if (!TABLE.test(op.table)) throw new Error('bad table');
    const seeded = this.ctx.storage.kv.get<number>(`seeded:${op.table}`) ?? 0;
    const tally: Record<string, { n: number; closeWritten: number[]; insertWritten: number[]; read: number[] }> = {};
    const note = (key: string, w: { read: number; closeWritten: number; insertWritten: number }) => {
      const t = (tally[key] ??= { n: 0, closeWritten: [], insertWritten: [], read: [] });
      t.n++;
      for (const k of ['closeWritten', 'insertWritten', 'read'] as const) if (!t[k].includes(w[k])) t[k].push(w[k]);
    };
    this.ctx.storage.transactionSync(() => {
      const saltKey = `writesSalt:${op.table}`;
      const salt = (this.ctx.storage.kv.get<number>(saltKey) ?? 0) + 1;
      this.ctx.storage.kv.put(saltKey, salt);
      let i = seeded + 1_000_000 + salt * 10_000;
      for (const slot of [0, 5, 8]) { // one resource index of each type, by r % 10
        for (let k = 0; k < op.n; k++) {
          const fresh = 10_000_000 + (salt * 1000 + k) * 10 + slot;
          note(`${typeOf(fresh)} create`, this.#write(op.table, fresh, i++, true));
          const existing = (salt * 20 + k) * 10 + slot; // n <= 20 and salt < 20 keep it under RESOURCES
          note(`${typeOf(existing)} update`, this.#write(op.table, existing, i++, false));
        }
      }
    });
    return { tally };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.BENCH_TOKEN || request.headers.get('x-bench-token') !== env.BENCH_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const [, route, instance] = url.pathname.split('/');
    if (route !== 'run' || !instance || request.method !== 'POST') return new Response('Not Found', { status: 404 });
    const { seq, op } = await request.json<{ seq: number; op: Op }>();
    const stub = env.ASOF.getByName(instance, { locationHint: LOCATION_HINT });
    // The Worker's clock is fine around an RPC: the object's work is the Worker's wait.
    const t0 = Date.now();
    try {
      const out = await stub.run(seq, op);
      return Response.json({ ...out, workerMs: Date.now() - t0, workerColo: (request.cf as { colo?: string } | undefined)?.colo });
    } catch (e) {
      return new Response(e instanceof Error ? `${e.name}: ${e.message}` : String(e), { status: 500 });
    }
  },
};
