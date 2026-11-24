/**
 * Shared by the driver scripts: the deployed URL, the token, each arm's table and indexes, and `call`.
 * Deployed only: Workers Logs, which times the object's work, exists nowhere else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { END_OF_TIME, RESOURCES } from '../src/fixture.js';

export const DIR = fileURLToPath(new URL('..', import.meta.url));
export const RESULTS = join(DIR, 'results');
export const BASE = process.env.BASE?.replace(/\/$/, '');
if (!BASE || /localhost|127\.0\.0\.1/.test(BASE)) throw new Error('set BASE to the deployed URL: this experiment runs deployed only');
const TOKEN = /^BENCH_TOKEN=(.+)$/m.exec(readFileSync(join(DIR, '.dev.vars'), 'utf8'))?.[1].trim();
if (!TOKEN) throw new Error('BENCH_TOKEN is missing from experiments/asof-index-cost/.dev.vars');

/** A field's value, as `resolveField` in packages/resources/src/query/fields.ts writes it. */
export const field = (name) => `json_extract(value, '$.${name}')`;
/** A type's current rows, as `currentRowsSql` writes them. Arm A's indexes carry exactly this. */
export const current = (type) => `typeName = '${type}' AND validTo = '${END_OF_TIME}' AND deleted = 0`;
/** Every version of a type that is not a tombstone. Arms B and C carry exactly this. */
export const everyVersion = (type) => `typeName = '${type}' AND deleted = 0`;

/** The three Deal fields a type's `@index`es name. An arm with one index has the first. */
export const FIELDS = ['stage', 'owner', 'amount'];
export const indexName = (table, name) => `"idx_${table}_q_Deal:${name}"`;

/** One arm's `CREATE INDEX` for one field of Deal. */
export const ARMS = {
  // Today: `compileIndex`'s statement, partial on the type's current rows.
  A: (t, f) => `CREATE INDEX IF NOT EXISTS ${indexName(t, f)} ON ${t}(${field(f)}) WHERE ${current('Deal')}`,
  // Every version of the type, with validTo after the field, so `field = ? AND validTo > ?` is one range.
  B: (t, f) => `CREATE INDEX IF NOT EXISTS ${indexName(t, f)} ON ${t}(${field(f)}, validTo) WHERE ${everyVersion('Deal')}`,
  // Every version of the type, without validTo.
  C: (t, f) => `CREATE INDEX IF NOT EXISTS ${indexName(t, f)} ON ${t}(${field(f)}) WHERE ${everyVersion('Deal')}`,
  // B with no WHERE at all, so every row of every type is in it. Measured for writes only.
  F: (t, f) => `CREATE INDEX IF NOT EXISTS ${indexName(t, f)} ON ${t}(typeName, ${field(f)}, validTo)`,
  // No `@index` at all: the schema's own cost.
  Z: () => null,
};

/** `Snapshots` as packages/resources/src/snapshots.ts creates it, under the arm's table name. */
export const tableDdl = (t) => [
  `CREATE TABLE IF NOT EXISTS ${t} (
    resourceId TEXT NOT NULL,
    nodeId TEXT NOT NULL,
    typeName TEXT NOT NULL,
    ontologyVersion TEXT NOT NULL,
    validFrom TEXT NOT NULL,
    validTo TEXT NOT NULL DEFAULT '${END_OF_TIME}',
    recordedClaims TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    value TEXT NOT NULL,
    PRIMARY KEY (resourceId, validFrom)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_${t}_current ON ${t}(resourceId, validTo) WHERE validTo = '${END_OF_TIME}'`,
];

/** A table name such as `S_B3`: arm B with three indexes. */
export const tableOf = (arm, n) => `S_${arm}${n}`;
export const ddlOf = (arm, n) => {
  const t = tableOf(arm, n);
  return [...tableDdl(t), ...FIELDS.slice(0, n).map((f) => ARMS[arm](t, f)).filter(Boolean)];
};

/** One object per history depth. Depth 10 also holds the three-index arms and the write-only ones. */
const READ_ARMS = [['A', 1], ['B', 1], ['C', 1]];
export const OBJECTS = {
  d1: { depth: 1, arms: READ_ARMS },
  d10: { depth: 10, arms: [...READ_ARMS, ['Z', 0], ['F', 1], ['A', 3], ['B', 3], ['C', 3], ['F', 3]] },
  d100: { depth: 100, arms: READ_ARMS },
};
export const writesOf = (object) => RESOURCES * OBJECTS[object].depth;

// Every call carries a seq, so each object invocation is numbered in the order the driver made it.
let seq = Date.now() * 1000;
export async function call(instance, op, tries = 5) {
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
