/**
 * Shared by the driver scripts: the deployed URL, the token, the index configurations, and `call`.
 * Deployed only: Workers Logs, which times the object's work, exists nowhere else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { END_OF_TIME } from '../src/fixture.js';

export const DIR = fileURLToPath(new URL('..', import.meta.url));
export const RESULTS = join(DIR, 'results');
export const BASE = process.env.BASE?.replace(/\/$/, '');
if (!BASE || /localhost|127\.0\.0\.1/.test(BASE)) throw new Error('set BASE to the deployed URL: this experiment runs deployed only');
const TOKEN = /^BENCH_TOKEN=(.+)$/m.exec(readFileSync(join(DIR, '.dev.vars'), 'utf8'))?.[1].trim();
if (!TOKEN) throw new Error('BENCH_TOKEN is missing from experiments/query-subtree-and-catchup/.dev.vars');

/** A type's current rows, as `currentRowsSql` in packages/resources/src/query/fields.ts writes them. */
export const current = (type) => `typeName = '${type}' AND validTo = '${END_OF_TIME}' AND deleted = 0`;
/** A field's value, as `resolveField` writes it. */
export const field = (name) => `json_extract(value, '$.${name}')`;
const queryIndex = (type, name) =>
  `CREATE INDEX IF NOT EXISTS "idx_Snapshots_q_${type}:${name}" ON Snapshots(${field(name)}) WHERE ${current(type)}`;

/** The `@index`-style indexes every object carries, as `compileIndex` writes them. Task and Note have none. */
export const QUERY_INDEXES = [queryIndex('Deal', 'stage'), queryIndex('Deal', 'owner'), queryIndex('Contact', 'company')];

/** One object per index configuration, each holding the same data. */
export const INSTANCES = {
  // Q2 (a), and Q6 (b): today's schema and nothing more.
  base: [],
  // Q2 (b) and (c).
  node: [`CREATE INDEX IF NOT EXISTS idx_Snapshots_node ON Snapshots(nodeId, typeName) WHERE validTo = '${END_OF_TIME}' AND deleted = 0`],
  // Q6 (a).
  tm: ['CREATE INDEX IF NOT EXISTS idx_Snapshots_typeMoment ON Snapshots(typeName, validFrom)'],
  // Q6 (d).
  m: ['CREATE INDEX IF NOT EXISTS idx_Snapshots_moment ON Snapshots(validFrom)'],
};
// A variant neither question lists: today's idx_Snapshots_current swapped for an index that leads
// with the type and the node, over the same current rows. seed.mjs drops the old one for this object.
INSTANCES.swap = [`CREATE INDEX IF NOT EXISTS idx_Snapshots_typeNode ON Snapshots(typeName, nodeId) WHERE validTo = '${END_OF_TIME}' AND deleted = 0`];
// Every configuration's indexes on one object, so arms can be timed on one host (measure.mjs, PAIRED).
INSTANCES.all = [...INSTANCES.node, ...INSTANCES.tm, ...INSTANCES.m];

// Every call carries a seq, so each object invocation is numbered in the order the driver made it.
// Seqs start from the run's start time, so two runs' lines never share one in a join's window.
let seq = Date.now() * 1000;
export async function call(instance, op, tries = 4) {
  const s = ++seq;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}/run/${instance}`, {
        method: 'POST', headers: { 'x-bench-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ seq: s, op }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 300)}`);
      return { seq: s, ...JSON.parse(body) };
    } catch (e) {
      // workers.dev resets a connection from this machine a few times an hour.
      if (attempt >= tries || /^4\d\d /.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
