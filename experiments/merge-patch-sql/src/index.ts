/**
 * Is RFC 7396 merge patch cheaper in JavaScript, or pushed down into the object's SQLite?
 *
 * One object holds one condition: an org tree of n nodes before and after one mutation, stored as
 * the text `@lumenize/structured-clone` writes (table `S`, as `Snapshots.value` is today) and as
 * JSONB (table `SB`), plus the patch between them (table `P`). Each `run` call does one operation
 * `reps` times, one way:
 *
 * - `apply` (a write that arrives as a patch): read the stored value, patch it, write the result
 *   as a new row. `js` round-trips the value through JSON.parse / applyMergePatch / JSON.stringify;
 *   `sql` is one INSERT … SELECT json_patch, so the value never leaves SQLite. `jsb` and `sqlb`
 *   are the same on JSONB storage.
 * - `applyRead`: `apply`, when the write path also needs the merged value in JS (to validate it,
 *   or to broadcast it). The SQL arms add RETURNING and a JSON.parse; the JS arms already hold it,
 *   so they are `apply`'s numbers.
 * - `diff` (a read or fanout that sends a patch): from the two stored values, the patch text.
 *   `js` parses both and calls `diff`; the SQL arms are `treeDiff` and `walkDiff` (sql-diff.ts),
 *   on text (`sql…`) or JSONB (`sqlb…`) storage.
 * - `part`: one component alone, so the totals can be explained.
 *
 * The patch reaches each `run` the way Mesh would deliver it, as a JS object. A SQL arm pays
 * JSON.stringify of it on every rep; a JS arm does not.
 *
 * Timing is the runtime's, not the object's: every `run` and `ping` logs `{ probe, seq }` first,
 * and scripts/logs.mjs joins that line to the invocation's cpuTimeMs and wallTimeMs in Workers
 * Logs. The object's own clock does not move during synchronous work (experiments/do-read-cache).
 */
import { DurableObject } from 'cloudflare:workers';
import { applyMergePatch, diff, type JsonValue, type MergePatch } from '@lumenize/structured-clone';
import { fixtureTexts, MUTATIONS, type Mutation } from './fixture';
import { treeDiff, walkDiff, WalkBudgetExceeded } from './sql-diff';

const ID = 'doc';
const LOCATION_HINT = 'enam';

export const ARMS = {
  apply: ['js', 'jsb', 'sql', 'sqlb'],
  applyRead: ['sql', 'sqlb'],
  diff: ['js', 'jsb', 'sqltree', 'sqlwalk', 'sqlbtree', 'sqlbwalk'],
  part: ['read', 'readb', 'parse', 'stringify', 'jsapply', 'jsdiff', 'write', 'sqlpatch', 'sqlbpatch', 'sqltree'],
} as const;
type Op = keyof typeof ARMS;

/** Sorted keys all the way down, so two patches compare as values whatever their key order. */
function canonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
}

export class PatchDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS S (id TEXT NOT NULL, vf TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (id, vf)) WITHOUT ROWID');
    sql.exec('CREATE TABLE IF NOT EXISTS SB (id TEXT NOT NULL, vf TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY (id, vf)) WITHOUT ROWID');
    sql.exec('CREATE TABLE IF NOT EXISTS P (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  get #sql() {
    return this.ctx.storage.sql;
  }

  #text(vf: string): string {
    return this.#sql.exec('SELECT value FROM S WHERE id = ? AND vf = ?', ID, vf).one().value as string;
  }

  #textB(vf: string): string {
    return this.#sql.exec('SELECT json(value) AS value FROM SB WHERE id = ? AND vf = ?', ID, vf).one().value as string;
  }

  #patch(): MergePatch {
    return JSON.parse(this.#sql.exec('SELECT v FROM P WHERE k = ?', 'patch').one().v as string);
  }

  setup(n: number, mutation: Mutation) {
    if (!MUTATIONS.includes(mutation)) throw new Error(`unknown mutation ${mutation}`);
    const { before, after } = fixtureTexts(n, mutation);
    const d = diff(JSON.parse(before), JSON.parse(after));
    if (d.kind !== 'patches' || d.patches.length !== 1) throw new Error(`diff answered ${d.kind}`);
    const sql = this.#sql;
    sql.exec('DELETE FROM S');
    sql.exec('DELETE FROM SB');
    for (const [vf, text] of [['v0', before], ['v1', after]]) {
      sql.exec('INSERT INTO S (id, vf, value) VALUES (?, ?, ?)', ID, vf, text);
      sql.exec('INSERT INTO SB (id, vf, value) VALUES (?, ?, jsonb(?))', ID, vf, text);
    }
    sql.exec('INSERT OR REPLACE INTO P (k, v) VALUES (?, ?)', 'patch', JSON.stringify(d.patches[0]));
    return {
      n, mutation,
      textBytes: before.length,
      jsonbBytes: sql.exec("SELECT length(value) AS b FROM SB WHERE vf = 'v0'").one().b as number,
      patchBytes: JSON.stringify(d.patches[0]).length,
      databaseSize: sql.databaseSize,
    };
  }

  /** One rep of one operation, one way. Returns a number so nothing is optimized away. */
  #once(op: Op, arm: string, patch: MergePatch, held: Held): number {
    const sql = this.#sql;
    switch (`${op}/${arm}`) {
      case 'apply/js': {
        const merged = applyMergePatch(JSON.parse(this.#text('v0')), patch);
        sql.exec('INSERT OR REPLACE INTO S (id, vf, value) VALUES (?, ?, ?)', ID, 'out', JSON.stringify(merged));
        return 1;
      }
      case 'apply/jsb': {
        const merged = applyMergePatch(JSON.parse(this.#textB('v0')), patch);
        sql.exec('INSERT OR REPLACE INTO SB (id, vf, value) VALUES (?, ?, jsonb(?))', ID, 'out', JSON.stringify(merged));
        return 1;
      }
      case 'apply/sql':
        sql.exec("INSERT OR REPLACE INTO S (id, vf, value) SELECT id, 'out', json_patch(value, ?) FROM S WHERE id = ? AND vf = 'v0'",
          JSON.stringify(patch), ID);
        return 1;
      case 'apply/sqlb':
        sql.exec("INSERT OR REPLACE INTO SB (id, vf, value) SELECT id, 'out', jsonb_patch(value, ?) FROM SB WHERE id = ? AND vf = 'v0'",
          JSON.stringify(patch), ID);
        return 1;
      case 'applyRead/sql': {
        const row = sql.exec("INSERT OR REPLACE INTO S (id, vf, value) SELECT id, 'out', json_patch(value, ?) FROM S WHERE id = ? AND vf = 'v0' RETURNING value",
          JSON.stringify(patch), ID).one();
        return Object.keys(JSON.parse(row.value as string)).length;
      }
      case 'applyRead/sqlb': {
        const row = sql.exec("INSERT OR REPLACE INTO SB (id, vf, value) SELECT id, 'out', jsonb_patch(value, ?) FROM SB WHERE id = ? AND vf = 'v0' RETURNING json(value) AS value",
          JSON.stringify(patch), ID).one();
        return Object.keys(JSON.parse(row.value as string)).length;
      }
      case 'diff/js':
      case 'diff/jsb': {
        const read = arm === 'js' ? (vf: string) => this.#text(vf) : (vf: string) => this.#textB(vf);
        const d = diff(JSON.parse(read('v0')), JSON.parse(read('v1')));
        if (d.kind !== 'patches') throw new Error(`diff answered ${d.kind}`);
        return JSON.stringify(d.patches[0]).length;
      }
      case 'diff/sqltree': return JSON.stringify(treeDiff(sql, 'S', ID, 'v0', 'v1')).length;
      case 'diff/sqlwalk': return JSON.stringify(walkDiff(sql, 'S', ID, 'v0', 'v1')).length;
      case 'diff/sqlbtree': return JSON.stringify(treeDiff(sql, 'SB', ID, 'v0', 'v1')).length;
      case 'diff/sqlbwalk': return JSON.stringify(walkDiff(sql, 'SB', ID, 'v0', 'v1')).length;
      case 'part/read': return this.#text('v0').length;
      case 'part/readb': return this.#textB('v0').length;
      case 'part/parse': return Object.keys(JSON.parse(held.text0())).length;
      case 'part/stringify': return JSON.stringify(held.obj1()).length;
      case 'part/jsapply': return Object.keys(applyMergePatch(held.obj0(), patch) as object).length;
      case 'part/jsdiff': return diff(held.obj0(), held.obj1()).kind.length;
      case 'part/write':
        sql.exec('INSERT OR REPLACE INTO S (id, vf, value) VALUES (?, ?, ?)', ID, 'out', held.text1());
        return 1;
      case 'part/sqlpatch':
        return sql.exec("SELECT length(json_patch(value, ?)) AS b FROM S WHERE id = ? AND vf = 'v0'", JSON.stringify(patch), ID).one().b as number;
      case 'part/sqlbpatch':
        return sql.exec("SELECT length(jsonb_patch(value, ?)) AS b FROM SB WHERE id = ? AND vf = 'v0'", JSON.stringify(patch), ID).one().b as number;
      case 'part/sqltree':
        return sql.exec("SELECT count(*) AS c FROM S AS s, json_tree(s.value) WHERE s.id = ? AND s.vf = 'v0'", ID).one().c as number;
      default:
        throw new Error(`unknown ${op}/${arm}`);
    }
  }

  run(op: Op, arm: string, reps: number, seq: number) {
    // Logged first: Workers Logs has dropped a line logged after ~400 ms of CPU (experiments/do-read-cache).
    console.log(JSON.stringify({ probe: 'run', seq }));
    const patch = this.#patch();
    const held = new Held(this);
    // What a `part` rep works on is built before its loop, so the loop times only the part.
    if (op === 'part') held.prepare(arm);
    let check = 0;
    for (let i = 0; i < reps; i++) check += this.#once(op, arm, patch, held);
    return { reps, check };
  }

  /** The baseline a `run` is netted against: its shape, minus the work. */
  ping(seq: number) {
    console.log(JSON.stringify({ probe: 'ping', seq }));
    return {};
  }

  /** Runs every arm once and checks each against the stored `after` (apply) or JS `diff` (diff). */
  verify() {
    const patch = this.#patch();
    const after = this.#text('v1');
    const before = this.#text('v0');
    const want = JSON.stringify(canonical(patch));
    const held = new Held(this);
    const out: Record<string, boolean | string> = {};
    for (const arm of ARMS.apply) {
      this.#sql.exec("DELETE FROM S WHERE vf = 'out'");
      this.#sql.exec("DELETE FROM SB WHERE vf = 'out'");
      this.#once('apply', arm, patch, held);
      out[`apply/${arm}`] = (arm.endsWith('b') ? this.#textB('out') : this.#text('out')) === after;
    }
    for (const arm of ARMS.applyRead) {
      const table = arm === 'sql' ? 'S' : 'SB';
      const row = this.#sql.exec(`INSERT OR REPLACE INTO ${table} (id, vf, value) SELECT id, 'out', ${arm === 'sql' ? 'json_patch' : 'jsonb_patch'}(value, ?) FROM ${table} WHERE id = ? AND vf = 'v0' RETURNING json(value) AS value`,
        JSON.stringify(patch), ID).one();
      out[`applyRead/${arm}`] = row.value === after;
    }
    for (const arm of ARMS.diff) {
      let got: JsonValue;
      if (arm === 'js' || arm === 'jsb') {
        const d = diff(JSON.parse(before), JSON.parse(after));
        got = d.kind === 'patches' ? d.patches[0] : null;
      } else {
        const table = arm.startsWith('sqlb') ? 'SB' : 'S';
        try {
          got = arm.endsWith('tree') ? treeDiff(this.#sql, table, ID, 'v0', 'v1') : walkDiff(this.#sql, table, ID, 'v0', 'v1');
        } catch (e) {
          if (!(e instanceof WalkBudgetExceeded)) throw e;
          out[`diff/${arm}`] = e.name;
          continue;
        }
      }
      out[`diff/${arm}`] = JSON.stringify(canonical(got)) === want
        && JSON.stringify(applyMergePatch(JSON.parse(before), got)) === after;
    }
    return out;
  }

  /** The text and parsed values a `part` rep works on, read on demand. */
  read(vf: string) {
    return this.#text(vf);
  }

  /** The colo this object runs in, from Cloudflare's trace endpoint (one outbound fetch). */
  async colo() {
    const text = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
    return { colo: /colo=(\w+)/.exec(text)?.[1] ?? '?' };
  }

  wipe() {
    this.ctx.storage.deleteAll();
    return {};
  }
}

/** Lazily read values a `part` arm works on, so its loop holds only the part being timed. */
class Held {
  #do: PatchDO;
  #cache = new Map<string, unknown>();
  constructor(object: PatchDO) {
    this.#do = object;
  }
  #get<T>(key: string, make: () => T): T {
    if (!this.#cache.has(key)) this.#cache.set(key, make());
    return this.#cache.get(key) as T;
  }
  text0 = () => this.#get('text0', () => this.#do.read('v0'));
  text1 = () => this.#get('text1', () => this.#do.read('v1'));
  obj0 = () => this.#get('obj0', () => JSON.parse(this.text0()) as JsonValue);
  obj1 = () => this.#get('obj1', () => JSON.parse(this.text1()) as JsonValue);
  prepare(arm: string) {
    if (arm === 'parse') this.text0();
    if (arm === 'stringify') this.obj1();
    if (arm === 'write') this.text1();
    if (arm === 'jsapply') this.obj0();
    if (arm === 'jsdiff') this.obj0(), this.obj1();
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
    const stub = env.PATCH.getByName(instance, { locationHint: LOCATION_HINT });
    const op = q.get('op');
    const t0 = Date.now();
    let out: object;
    try {
      switch (op) {
        case 'setup': out = await stub.setup(num('n'), q.get('mutation') as Mutation); break;
        case 'run': out = await stub.run(q.get('what') as Op, q.get('arm')!, num('reps'), num('seq')); break;
        case 'ping': out = await stub.ping(num('seq')); break;
        case 'verify': out = await stub.verify(); break;
        case 'colo': out = await stub.colo(); break;
        case 'wipe': out = await stub.wipe(); break;
        default: return new Response(`unknown op ${op}`, { status: 400 });
      }
    } catch (e) {
      return new Response(e instanceof Error ? `${e.name}: ${e.message}` : String(e), { status: 500 });
    }
    // The Worker's clock is fine around an RPC: the object's work is the Worker's wait. It adds the
    // round trip when the Worker landed in another colo, so the driver keeps the colo.
    const workerColo = (request.cf as { colo?: string } | undefined)?.colo;
    return Response.json({ ...out, workerMs: Date.now() - t0, workerColo });
  },
};
