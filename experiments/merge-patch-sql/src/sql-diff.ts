/**
 * Two ways to generate an RFC 7396 merge patch inside SQLite, from two stored values.
 *
 * SQLite has `json_patch` but no diff, so both are built from JSON1's table-valued functions.
 * Both hand back only what changed, so the large values never cross into JavaScript; JS turns the
 * few changed rows into the patch object.
 *
 * - `treeDiff`: one statement. `json_tree` enumerates every node of both values, a GROUP BY pairs
 *   them by path, and the changed leaves come back. Its cost is a row per node of BOTH values,
 *   changed or not.
 * - `walkDiff`: one statement per changed container. `json_each` lists one container's children
 *   in both values, compares each child whole (a container by its rendered text), and returns the
 *   ones that differ; JS descends into a child that is an object on both sides. Unchanged subtrees
 *   are compared once, as text, and never enumerated. It mirrors `diff` in
 *   `@lumenize/structured-clone`, which compares a subtree whole before descending.
 *
 * Neither detects a Map's or Set's members changing order, which `diff` answers with two patches
 * or `{ kind: 'full' }`; no fixture reorders. Both treat arrays as atomic, as RFC 7396 does.
 */
import type { JsonValue } from '@lumenize/structured-clone';

type JsonObject = { [k: string]: JsonValue };

/** Defines an own property, so a key named `__proto__` is data, as in `@lumenize/structured-clone`. */
function setOwn(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A changed child's value from what json_each/json_tree report: its JSON type and atom or text. */
function valueOf(type: string, v: unknown): JsonValue {
  switch (type) {
    case 'object':
    case 'array':
      return JSON.parse(v as string);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
    default:
      return v as JsonValue;
  }
}

/**
 * The changed leaves between two stored values: `k` is SQLite's full path, `t` the new JSON type
 * (NULL when the key was deleted), `v` the new atom or, for a container, its JSON text.
 * ?1 = id, ?2 = before's vf, ?3 = after's vf. The `{T}` is the table, text or JSONB.
 */
const TREE_SQL = `
WITH
b AS MATERIALIZED (SELECT t.fullkey, t.path, t.type, t.atom FROM {T} AS s, json_tree(s.value) AS t WHERE s.id = ?1 AND s.vf = ?2),
a AS MATERIALIZED (SELECT t.fullkey, t.path, t.type, t.atom FROM {T} AS s, json_tree(s.value) AS t WHERE s.id = ?1 AND s.vf = ?3),
j AS MATERIALIZED (
  SELECT fullkey, max(path) AS path, max(at) AS at, max(bt) AS bt, max(aa) AS aa, max(ba) AS ba FROM (
    SELECT fullkey, path, type AS at, NULL AS bt, atom AS aa, NULL AS ba FROM a
    UNION ALL SELECT fullkey, path, NULL, type, NULL, atom FROM b
  ) GROUP BY fullkey
),
objs AS MATERIALIZED (SELECT fullkey FROM j WHERE at = 'object' AND bt = 'object'),
arrs AS MATERIALIZED (SELECT fullkey FROM j WHERE at = 'array' OR bt = 'array')
SELECT j.fullkey AS k, j.at AS t,
  CASE WHEN j.at IN ('object', 'array') THEN json((SELECT value FROM {T} WHERE id = ?1 AND vf = ?3) -> j.fullkey) ELSE j.aa END AS v
FROM j
WHERE j.fullkey <> '$'
  AND j.path IN objs
  AND NOT (j.at IS 'object' AND j.bt IS 'object')
  AND (j.at IS NOT j.bt OR j.aa IS NOT j.ba
       OR (j.at = 'array' AND ((SELECT value FROM {T} WHERE id = ?1 AND vf = ?3) -> j.fullkey)
                           IS NOT ((SELECT value FROM {T} WHERE id = ?1 AND vf = ?2) -> j.fullkey)))
  AND NOT EXISTS (SELECT 1 FROM arrs WHERE j.path >= arrs.fullkey || '[' AND j.path < arrs.fullkey || '\\')`;

/**
 * One container's children that differ: `at`/`bt` are the JSON types after/before (NULL when
 * absent), `v` the new atom or container text, NULL when both sides are objects (JS descends).
 * ?1 = id, ?2 = before's vf, ?3 = after's vf, ?4 = the container's path.
 */
const LEVEL_SQL = `
WITH
b AS MATERIALIZED (SELECT t.key, t.type, t.atom, CASE WHEN t.type IN ('object', 'array') THEN t.value END AS v
  FROM {T} AS s, json_each(s.value, ?4) AS t WHERE s.id = ?1 AND s.vf = ?2),
a AS MATERIALIZED (SELECT t.key, t.type, t.atom, CASE WHEN t.type IN ('object', 'array') THEN t.value END AS v
  FROM {T} AS s, json_each(s.value, ?4) AS t WHERE s.id = ?1 AND s.vf = ?3)
SELECT a.key, a.type AS at, b.type AS bt,
  CASE WHEN a.type = 'object' AND b.type IS 'object' THEN NULL WHEN a.type IN ('object', 'array') THEN json(a.v) ELSE a.atom END AS v
  FROM a LEFT JOIN b ON b.key = a.key
  WHERE a.type IS NOT b.type OR a.atom IS NOT b.atom OR a.v IS NOT b.v
UNION ALL
SELECT b.key, NULL, b.type, NULL FROM b WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.key = b.key)`;

/** SQLite's full path (`$.a."b-c".d`) as its keys. Arrays never appear: they are atomic. */
function segmentsOf(fullkey: string): string[] {
  const out: string[] = [];
  let i = 1;
  while (i < fullkey.length) {
    if (fullkey[i] !== '.') throw new Error(`unexpected path ${fullkey}`);
    i++;
    if (fullkey[i] === '"') {
      let j = i + 1;
      while (fullkey[j] !== '"') j += fullkey[j] === '\\' ? 2 : 1;
      out.push(JSON.parse(fullkey.slice(i, j + 1)));
      i = j + 1;
    } else {
      let j = i;
      while (j < fullkey.length && fullkey[j] !== '.' && fullkey[j] !== '[') j++;
      out.push(fullkey.slice(i, j));
      i = j;
    }
  }
  return out;
}

const childPath = (path: string, key: string) => `${path}.${JSON.stringify(key)}`;

export function treeDiff(sql: SqlStorage, table: string, id: string, before: string, after: string): JsonObject {
  const patch: JsonObject = {};
  for (const row of sql.exec(TREE_SQL.replaceAll('{T}', table), id, before, after)) {
    const keys = segmentsOf(row.k as string);
    let target = patch;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) setOwn(target, key, {});
      target = target[key] as JsonObject;
    }
    setOwn(target, keys.at(-1)!, row.t === null ? null : valueOf(row.t as string, row.v));
  }
  return patch;
}

/**
 * Thrown when `walkDiff` would need more than its budget of level queries. Each changed container
 * costs one statement, and each statement re-reads both values, so a change spread across many
 * objects (every label in a 10,000-node tree) costs thousands of full-value reads.
 */
export class WalkBudgetExceeded extends Error {
  constructor(budget: number) {
    super(`walkDiff needs more than ${budget} level queries`);
    this.name = 'WalkBudgetExceeded';
  }
}

export function walkDiff(sql: SqlStorage, table: string, id: string, before: string, after: string, budget = 300): JsonObject {
  const query = LEVEL_SQL.replaceAll('{T}', table);
  let queries = 0;
  const visit = (path: string, target: JsonObject) => {
    if (++queries > budget) throw new WalkBudgetExceeded(budget);
    for (const row of sql.exec(query, id, before, after, path).toArray()) {
      const key = row.key as string;
      if (row.at === null) setOwn(target, key, null);
      else if (row.at === 'object' && row.bt === 'object') {
        const sub: JsonObject = {};
        setOwn(target, key, sub);
        visit(childPath(path, key), sub);
      } else setOwn(target, key, valueOf(row.at as string, row.v));
    }
  };
  const patch: JsonObject = {};
  visit('$', patch);
  return patch;
}
