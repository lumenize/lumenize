/**
 * How a query reads only its node's subtree, and how a catch-up finds what was written since a
 * moment. RESULTS.md has the questions, the design and the findings.
 *
 * One object holds one index configuration over the same data (src/fixture.js): a copy of
 * `Snapshots`, `Nodes` and `Edges` as `packages/resources` creates them, plus whatever indexes the
 * driver's `ddl` op adds. The object is a statement runner: the driver (scripts/measure.mjs) writes
 * every statement, and each `run` call executes one operation `reps` times and answers what the
 * sql cursor counted, `rowsRead` and `rowsWritten`.
 *
 * Timing is the runtime's, not the object's: `run` logs `{ probe, seq }` first, and
 * scripts/logs.mjs joins that line to the invocation's cpuTimeMs and wallTimeMs in Workers Logs.
 * The object's own clock does not move during synchronous work (experiments/do-read-cache).
 */
import { DurableObject } from 'cloudflare:workers';
import {
  claimsOf, edges, END_OF_TIME, momentOf, NODE_COUNT, nodeId, nodeOf, resourceId, typeOf, valueOf, writeOf,
} from './fixture.js';

const LOCATION_HINT = 'enam';

type Param = string | number;
type Row = Record<string, SqlStorageValue>;
interface Stmt { sql: string; params?: Param[] }

export type Op =
  | { kind: 'noop' }
  | { kind: 'info' }
  /** `dropCurrent` also drops `idx_Snapshots_current` and keeps the constructor from making it again. */
  | { kind: 'ddl'; sql: string[]; dropCurrent?: boolean }
  | { kind: 'tree' }
  | { kind: 'seed'; from: number; count: number }
  /** One statement. With `cursorCols` it is read in pages of `budgetBytes`, each resuming past the last row. */
  | { kind: 'sql'; sql: string; params?: Param[]; reps?: number; explain?: boolean; budgetBytes?: number; cursorCols?: string[];
      /** Sorted node ids. A `$nodes` parameter becomes the JSON array of those at or past the cursor's node. */
      nodes?: string[] }
  /** One statement per parameter set, merged in JS. With `budgetBytes`, read in pages that resume mid-set. */
  | { kind: 'each'; sql: string; paramSets: Param[][]; reps?: number; explain?: boolean; sort?: boolean; budgetBytes?: number }
  /** Find what was written since `moment`, then read each resource found at both ends by its key. */
  | { kind: 'catchup'; find: Stmt[]; moment: string; reps?: number; explain?: boolean;
      /** `both`: each resource as the page leaves it and as the client holds it. `before`: only the second, when `find` already read the first. */
      keyReads?: 'both' | 'before'; sort?: boolean }
  | { kind: 'writes'; n: number };

/** FNV-1a over a string, so two ways of reading the same rows can be shown to agree. */
function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export class QueryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The tree's tables and Snapshots, as org-tree.ts and snapshots.ts create them.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Nodes (
        nodeId TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS Edges (
        parentNodeId TEXT NOT NULL,
        childNodeId TEXT NOT NULL,
        PRIMARY KEY (parentNodeId, childNodeId),
        FOREIGN KEY (parentNodeId) REFERENCES Nodes(nodeId),
        FOREIGN KEY (childNodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_Edges_child ON Edges(childNodeId);

      CREATE TABLE IF NOT EXISTS Snapshots (
        resourceId TEXT NOT NULL,
        nodeId TEXT NOT NULL,
        typeName TEXT NOT NULL,
        ontologyVersion TEXT NOT NULL,
        validFrom TEXT NOT NULL,
        validTo TEXT NOT NULL DEFAULT '${END_OF_TIME}',
        recordedClaims TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        value TEXT NOT NULL,
        PRIMARY KEY (resourceId, validFrom),
        FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID;
    `);
    if (!ctx.storage.kv.get('dropCurrent')) {
      ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_Snapshots_current
          ON Snapshots(resourceId, validTo)
          WHERE validTo = '${END_OF_TIME}';
      `);
    }
  }

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
  #write(r: number, i: number, create: boolean) {
    const id = resourceId(r);
    const validFrom = momentOf(i);
    let read = 0, closeWritten = 0;
    if (!create) {
      const cur = this.#sql.exec<{ validFrom: string }>(
        'SELECT validFrom FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1', id);
      const current = cur.toArray()[0];
      read += cur.rowsRead;
      if (!current) throw new Error(`write ${i} updates resource ${r}, which has no row`);
      const close = this.#sql.exec('UPDATE Snapshots SET validTo = ? WHERE resourceId = ? AND validFrom = ?', validFrom, id, current.validFrom);
      close.toArray();
      read += close.rowsRead;
      closeWritten = close.rowsWritten;
    }
    const insert = this.#sql.exec(
      `INSERT INTO Snapshots (resourceId, nodeId, typeName, ontologyVersion, validFrom, validTo, recordedClaims, deleted, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, nodeId(nodeOf(r)), typeOf(r), 'v1', validFrom, END_OF_TIME, claimsOf(r), 0, valueOf(r, i));
    insert.toArray();
    return { read: read + insert.rowsRead, closeWritten, insertWritten: insert.rowsWritten };
  }

  /** Read one statement's rows, stopping once `budget` bytes of `value` have been read. */
  #consume(sql: string, params: Param[], budget: number, onRow?: (row: Row) => void) {
    const cursor = this.#sql.exec<Row>(sql, ...params);
    let rows = 0, bytes = 0, last: Row | undefined, full = false;
    for (const row of cursor) {
      rows++;
      last = row;
      if (typeof row.value === 'string') bytes += row.value.length;
      else if (typeof row.bytes === 'number') bytes += row.bytes;
      onRow?.(row);
      if (bytes >= budget) { full = true; break; }
    }
    return { rows, bytes, last, full, rowsRead: cursor.rowsRead };
  }

  run(seq: number, op: Op): object {
    console.log({ probe: 'run', seq });
    switch (op.kind) {
      case 'noop': return {};
      case 'info': return {
        seeded: this.ctx.storage.kv.get<number>('seeded') ?? 0,
        databaseSize: this.#sql.databaseSize,
        indexes: this.#sql.exec<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).toArray(),
        nodes: this.#sql.exec('SELECT count(*) AS n FROM Nodes').one().n,
      };
      case 'ddl': {
        const out = [];
        if (op.dropCurrent) {
          this.ctx.storage.kv.put('dropCurrent', true);
          this.#sql.exec('DROP INDEX IF EXISTS idx_Snapshots_current');
        }
        for (const sql of op.sql) {
          const c = this.#sql.exec(sql);
          c.toArray();
          out.push({ sql, rowsRead: c.rowsRead, rowsWritten: c.rowsWritten });
        }
        return { ddl: out };
      }
      case 'tree': {
        if (Number(this.#sql.exec('SELECT count(*) AS n FROM Nodes').one().n) > 0) return { tree: 'already there' };
        for (let n = 0; n < NODE_COUNT; n++) this.#sql.exec('INSERT INTO Nodes (nodeId, slug, label) VALUES (?, ?, ?)', nodeId(n), `n${n}`, `Node ${n}`);
        for (const [p, c] of edges()) this.#sql.exec('INSERT OR IGNORE INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)', nodeId(p), nodeId(c));
        return { tree: NODE_COUNT };
      }
      case 'seed': {
        const seeded = this.ctx.storage.kv.get<number>('seeded') ?? 0;
        if (op.from !== seeded) return { seeded, skipped: true };
        let rowsWritten = 0;
        this.ctx.storage.transactionSync(() => {
          for (let i = op.from; i < op.from + op.count; i++) {
            const { r, create } = writeOf(i);
            const w = this.#write(r, i, create);
            rowsWritten += w.closeWritten + w.insertWritten;
          }
          this.ctx.storage.kv.put('seeded', op.from + op.count);
        });
        return { seeded: op.from + op.count, rowsWritten };
      }
      case 'sql': return this.#runSql(op);
      case 'each': return this.#runEach(op);
      case 'catchup': return this.#runCatchup(op);
      case 'writes': return this.#runWrites(op);
    }
  }

  #runSql(op: Extract<Op, { kind: 'sql' }>) {
    const params = op.params ?? [];
    const withCursor = (cursor: Param[]) => params.map((p) => {
      if (p === '$nodes') return JSON.stringify(op.nodes!.filter((n) => n >= cursor[0]!));
      return typeof p === 'string' && /^\$c\d$/.test(p) ? cursor[Number(p[2])]! : p;
    });
    const first = withCursor((op.cursorCols ?? []).map(() => ''));
    const plan = op.explain ? this.#plan(op.sql, first) : undefined;
    let out: object = {};
    for (let rep = 0; rep < (op.reps ?? 1); rep++) {
      let rows = 0, bytes = 0, rowsRead = 0, check = 0;
      const pages: Array<{ rows: number; bytes: number; rowsRead: number }> = [];
      const onRow = rep === 0 ? (row: Row) => { check = (check + fnv(`${row.resourceId}|${row.validFrom}`)) >>> 0; } : undefined;
      let cursor = (op.cursorCols ?? []).map((): Param => '');
      for (;;) {
        const page = this.#consume(op.sql, withCursor(cursor), op.cursorCols ? op.budgetBytes ?? Infinity : Infinity, onRow);
        rows += page.rows; bytes += page.bytes; rowsRead += page.rowsRead;
        pages.push({ rows: page.rows, bytes: page.bytes, rowsRead: page.rowsRead });
        if (!op.cursorCols || !page.full || !page.last) break;
        cursor = op.cursorCols.map((c) => page.last![c] as Param);
      }
      if (rep === 0) out = { rows, bytes, rowsRead, check, statements: pages.length, pages: op.cursorCols ? pages.slice(0, 12) : undefined };
    }
    return { ...out, plan, reps: op.reps ?? 1 };
  }

  #runEach(op: Extract<Op, { kind: 'each' }>) {
    const withCursor = (set: Param[], c: Param) => set.map((p) => (p === '$c0' ? c : p));
    const plan = op.explain && op.paramSets[0] ? this.#plan(op.sql, withCursor(op.paramSets[0], '')) : undefined;
    const budget = op.budgetBytes ?? Infinity;
    let out: object = {};
    for (let rep = 0; rep < (op.reps ?? 1); rep++) {
      let rows = 0, bytes = 0, rowsRead = 0, check = 0, statements = 0, pageBytes = 0, pageRead = 0, pageRows = 0;
      const pages: Array<{ rows: number; bytes: number; rowsRead: number }> = [];
      const merged: Array<[string, number]> = [];
      const endPage = () => { pages.push({ rows: pageRows, bytes: pageBytes, rowsRead: pageRead }); pageBytes = pageRead = pageRows = 0; };
      for (const set of op.paramSets) {
        let c: Param = '';
        for (;;) {
          const part = this.#consume(op.sql, withCursor(set, c), budget - pageBytes, (row) => {
            if (rep === 0) check = (check + fnv(`${row.resourceId}|${row.validFrom}`)) >>> 0;
            if (op.sort) merged.push([row.resourceId as string, typeof row.value === 'string' ? row.value.length : 0]);
          });
          statements++;
          rows += part.rows; bytes += part.bytes; rowsRead += part.rowsRead;
          pageRows += part.rows; pageBytes += part.bytes; pageRead += part.rowsRead;
          if (!part.full || !part.last) break;
          endPage();
          c = part.last.resourceId as Param;
        }
      }
      if (pageRows > 0 || pages.length === 0) endPage();
      if (op.sort) merged.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      if (rep === 0) out = { rows, bytes, rowsRead, check, statements, pageCount: pages.length, pages: op.budgetBytes ? pages.slice(0, 12) : undefined };
    }
    return { ...out, plan, reps: op.reps ?? 1 };
  }

  #runCatchup(op: Extract<Op, { kind: 'catchup' }>) {
    const plan = op.explain ? op.find.map((f) => this.#plan(f.sql, f.params ?? [])) : undefined;
    let out: object = {};
    for (let rep = 0; rep < (op.reps ?? 1); rep++) {
      let findRead = 0, found = 0, check = 0, keyRead = 0, keyStatements = 0, bytes = 0;
      /** resourceId → the latest moment found for it. */
      const latest = new Map<string, string>();
      const order: Array<[string, string]> = [];
      for (const f of op.find) {
        const cursor = this.#sql.exec<{ resourceId: string; validFrom: string; value?: string }>(f.sql, ...(f.params ?? []));
        for (const row of cursor) {
          found++;
          if (row.value !== undefined) bytes += row.value.length;
          if (op.sort) order.push([row.validFrom, row.resourceId]);
          if (rep === 0) check = (check + fnv(`${row.resourceId}|${row.validFrom}`)) >>> 0;
          const seen = latest.get(row.resourceId);
          if (!seen || seen < row.validFrom) latest.set(row.resourceId, row.validFrom);
        }
        findRead += cursor.rowsRead;
      }
      // Several statements each answer in write order; one page needs them merged into one order.
      if (op.sort) order.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      if (op.keyReads) {
        for (const [id, validFrom] of latest) {
          // The resource as the page leaves it, and as the client holds it.
          if (op.keyReads === 'both') {
            const after = this.#sql.exec<Row>('SELECT nodeId, deleted, value FROM Snapshots WHERE resourceId = ? AND validFrom = ?', id, validFrom);
            for (const row of after) bytes += (row.value as string).length;
            keyRead += after.rowsRead;
            keyStatements++;
          }
          const before = this.#sql.exec<Row>(
            'SELECT nodeId, deleted, value FROM Snapshots WHERE resourceId = ? AND validFrom <= ? ORDER BY validFrom DESC LIMIT 1', id, op.moment);
          for (const row of before) bytes += (row.value as string).length;
          keyRead += before.rowsRead;
          keyStatements++;
        }
      }
      if (rep === 0) out = { found, resources: latest.size, findRead, keyRead, keyStatements, bytes, check };
    }
    return { ...out, plan, reps: op.reps ?? 1 };
  }

  /**
   * `n` creates and `n` updates of each type, past the seeded writes, with each statement's
   * `rowsWritten`. A counter in storage keeps two calls from reusing a resource or a moment, and
   * the call is one transaction, so a retried call never meets half of its first attempt.
   */
  #runWrites(op: Extract<Op, { kind: 'writes' }>) {
    const seeded = this.ctx.storage.kv.get<number>('seeded') ?? 0;
    const tally: Record<string, { n: number; closeWritten: number[]; insertWritten: number[]; read: number[] }> = {};
    const note = (key: string, w: { read: number; closeWritten: number; insertWritten: number }) => {
      const t = (tally[key] ??= { n: 0, closeWritten: [], insertWritten: [], read: [] });
      t.n++;
      for (const k of ['closeWritten', 'insertWritten', 'read'] as const) if (!t[k].includes(w[k])) t[k].push(w[k]);
    };
    this.ctx.storage.transactionSync(() => {
      const salt = (this.ctx.storage.kv.get<number>('writesSalt') ?? 0) + 1;
      this.ctx.storage.kv.put('writesSalt', salt);
      let i = seeded + 1_000_000 + salt * 10_000;
      for (const slot of [0, 4, 7, 9]) { // one resource index of each type, by r % 10
        for (let k = 0; k < op.n; k++) {
          const fresh = 10_000_000 + (salt * 1000 + k) * 10 + slot;
          note(`${typeOf(fresh)} create`, this.#write(fresh, i++, true));
          const existing = (salt * 20 + k) * 10 + slot; // n ≤ 20, and seeded long before
          note(`${typeOf(existing)} update`, this.#write(existing, i++, false));
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
    const stub = env.QUERY.getByName(instance, { locationHint: LOCATION_HINT });
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
