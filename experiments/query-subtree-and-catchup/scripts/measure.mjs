#!/usr/bin/env node
/**
 * Runs every case and writes results/run-<time>.json. RESULTS.md has the questions and findings.
 *
 *   BASE=https://experiment-query-subtree-and-catchup.<account>.workers.dev node scripts/measure.mjs
 *   node scripts/logs.mjs results/run-<time>.json     # joins Workers Logs cpuTimeMs / wallTimeMs
 *   node scripts/tables.mjs results/run-<time>.json   # prints the tables RESULTS.md carries
 *
 * Each case is first called once with EXPLAIN QUERY PLAN, which answers the plan and what the sql
 * cursor counted. It is then timed ROUNDS times: a timed call runs the case `reps` times in one
 * invocation and nothing else, and that invocation's cpuTimeMs in Workers Logs, divided by `reps`,
 * is the case's CPU. `reps` is sized from the first call's counts to give the invocation about
 * TARGET_MS of work, since cpuTimeMs is whole milliseconds.
 *
 * Knobs (env): PAIRED (see below), ONLY (a regex over case ids), TARGET_MS, ROUNDS, LABEL (appended to the run's file name),
 * WRITES_TOO (also measure what a write costs; see the end of this file).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { momentOf, nodeId, resourceId, SUBTREES, subtree, WRITES } from '../src/fixture.js';
import { BASE, call, current, field, RESULTS } from './lib.mjs';

const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const TARGET_MS = Number(process.env.TARGET_MS ?? 250);
const MAX_REPS = 3000;
const ROUNDS = Number(process.env.ROUNDS ?? 3);

const COLS = 'resourceId, nodeId, validFrom, value';
const IN = 'nodeId IN (SELECT value FROM json_each(?))';
const NODE_INDEX = 'Snapshots INDEXED BY idx_Snapshots_node';
/** The swap variant's index (scripts/lib.mjs), on the `swap` object and, for pairing, on `all`. */
const TYPE_NODE_INDEX = 'Snapshots INDEXED BY idx_Snapshots_typeNode';
/** Sorted node ids of each subtree, as the plane would read them from its cached tree. */
const NODES = Object.fromEntries(Object.entries(SUBTREES).map(([k, root]) => [k, subtree(root).map(nodeId).sort()]));

/** A filter: the type, its clause as `compileWhere` writes it, and its bound values. */
const FILTERS = {
  stage: { type: 'Deal', sql: `${field('stage')} = ?`, params: ['open'] },
  owner: { type: 'Deal', sql: `${field('owner')} = ?`, params: ['u0042'] },
  all: { type: 'Deal', sql: '', params: [] },
};
const where = (f, ...more) => [current(f.type), f.sql, ...more].filter(Boolean).join(' AND ');

/**
 * PAIRED=1 runs every arm on one object, `all`, which carries every configuration's indexes, and
 * names each arm's index in its statement. Two objects can sit on hosts of different speed, so
 * only arms timed on one object can be compared by CPU. The unpaired run, one object per
 * configuration, is what shows which index SQLite picks when the statement names none.
 */
const PAIRED = Boolean(process.env.PAIRED);
const on = (instance) => (PAIRED ? 'all' : instance);
const QUERY_INDEX = { stage: '"idx_Snapshots_q_Deal:stage"', owner: '"idx_Snapshots_q_Deal:owner"', all: 'idx_Snapshots_current' };
/** Arm (a)'s FROM: unpaired, whatever SQLite picks; paired, the index it picked unpaired. */
const fromA = (fk) => (PAIRED ? `Snapshots INDEXED BY ${QUERY_INDEX[fk]}` : 'Snapshots');
const cases = [];
const add = (id, meta, instance, op) => { if (!ONLY || ONLY.test(id)) cases.push({ id, ...meta, instance: on(instance), op }); };

// ─── Q2: one whole read of a query's result ──────────────────────────
for (const [fk, f] of Object.entries(FILTERS)) {
  for (const sk of Object.keys(SUBTREES)) {
    const meta = { q: 'Q2', shape: 'whole', filter: fk, subtree: sk };
    const json = JSON.stringify(NODES[sk]);
    const one = (from, order) => ({ kind: 'sql', sql: `SELECT ${COLS} FROM ${from} WHERE ${where(f, IN)} ORDER BY ${order}`, params: [...f.params, json] });
    add(`q2.whole.${fk}.${sk}.a`, { ...meta, arm: 'a' }, 'base', one(fromA(fk), 'resourceId'));
    // (b) with no index named shows only which one SQLite picks, so it has no paired form.
    if (!PAIRED) add(`q2.whole.${fk}.${sk}.b`, { ...meta, arm: 'b' }, 'node', one('Snapshots', 'resourceId'));
    add(`q2.whole.${fk}.${sk}.b-node`, { ...meta, arm: 'b-node' }, 'node', one(NODE_INDEX, 'resourceId'));
    add(`q2.whole.${fk}.${sk}.b-node-nodeorder`, { ...meta, arm: 'b-node-nodeorder' }, 'node', one(NODE_INDEX, 'nodeId, resourceId'));
    if (!PAIRED) add(`q2.whole.${fk}.${sk}.swap`, { ...meta, arm: 'swap' }, 'swap', one('Snapshots', 'resourceId'));
    add(`q2.whole.${fk}.${sk}.swap-node`, { ...meta, arm: 'swap-node' }, 'swap', one(TYPE_NODE_INDEX, 'nodeId, resourceId'));
    add(`q2.whole.${fk}.${sk}.c`, { ...meta, arm: 'c' }, 'node', {
      kind: 'each', sort: true, sql: `SELECT ${COLS} FROM ${PAIRED ? NODE_INDEX : 'Snapshots'} WHERE nodeId = ? AND ${where(f)} ORDER BY resourceId`,
      paramSets: NODES[sk].map((n) => [n, ...f.params]),
    });
  }
}

// ─── Q2: a first read cut into pages ─────────────────────────────────
for (const fk of ['all', 'stage']) {
  const f = FILTERS[fk];
  for (const sk of ['n411', 'n4111']) {
    for (const budgetBytes of [2_000_000, 250_000]) {
      const meta = { q: 'Q2', shape: 'paged', filter: fk, subtree: sk, budgetBytes };
      const json = JSON.stringify(NODES[sk]);
      const id = (arm) => `q2.paged.${fk}.${sk}.${budgetBytes / 1000}k.${arm}`;
      const byId = (from) => ({
        kind: 'sql', budgetBytes, cursorCols: ['resourceId'],
        sql: `SELECT ${COLS} FROM ${from} WHERE ${where(f, IN, 'resourceId > ?')} ORDER BY resourceId`, params: [...f.params, json, '$c0'],
      });
      const byNode = (nodesParam, from = NODE_INDEX) => ({
        kind: 'sql', budgetBytes, cursorCols: ['nodeId', 'resourceId'], nodes: NODES[sk],
        sql: `SELECT ${COLS} FROM ${from} WHERE ${where(f, IN, '(nodeId, resourceId) > (?, ?)')} ORDER BY nodeId, resourceId`,
        params: [...f.params, nodesParam, '$c0', '$c1'],
      });
      add(id('a'), { ...meta, arm: 'a' }, 'base', byId(fromA(fk)));
      add(id('b-node-sort'), { ...meta, arm: 'b-node-sort' }, 'node', byId(NODE_INDEX));
      add(id('b-node-nodeorder'), { ...meta, arm: 'b-node-nodeorder' }, 'node', byNode(json));
      add(id('b-node-rest'), { ...meta, arm: 'b-node-rest' }, 'node', byNode('$nodes'));
      add(id('swap-rest'), { ...meta, arm: 'swap-rest' }, 'swap', byNode('$nodes', TYPE_NODE_INDEX));
      add(id('c'), { ...meta, arm: 'c' }, 'node', {
        kind: 'each', budgetBytes, sql: `SELECT ${COLS} FROM ${PAIRED ? NODE_INDEX : 'Snapshots'} WHERE nodeId = ? AND ${where(f, 'resourceId > ?')} ORDER BY resourceId`,
        paramSets: NODES[sk].map((n) => [n, ...f.params, '$c0']),
      });
    }
  }
}

// ─── Q6: a catch-up that missed N writes ─────────────────────────────
/**
 * Each Q6 arm's FROM when paired: its index named. (b) has no paired form: `NOT INDEXED` does not
 * stop SQLite using a secondary index on a WITHOUT ROWID table (it was tried, and the plan still
 * named idx_Snapshots_typeMoment), so (b)'s scan is timed only on `base`, and the controls say how
 * that host compares.
 */
const Q6_FROM = { a: 'Snapshots INDEXED BY idx_Snapshots_typeMoment', d: 'Snapshots INDEXED BY idx_Snapshots_moment' };
const ORDER = 'ORDER BY validFrom, resourceId';
const SEVERAL = ['Deal', 'Contact', 'Task'];
for (const [arm, instance] of [['a', 'tm'], ['b', 'base'], ['d', 'm']]) {
  if (PAIRED && arm === 'b') continue;
  for (const missed of [1, 100, 10_000]) {
    // The moment of the last write the client holds: exactly `missed` writes came after it.
    const moment = momentOf(WRITES - missed - 1);
    const meta = { q: 'Q6', arm, missed };
    const from = PAIRED ? Q6_FROM[arm] : 'Snapshots';
    const FIND = `SELECT resourceId, validFrom FROM ${from}`;
    const FIND_ROW = `SELECT resourceId, validFrom, nodeId, deleted, value FROM ${from}`;
    const id = (what) => `q6.${arm}.${missed}.${what}`;
    const cu = (find, more = {}) => ({ kind: 'catchup', moment, find, ...more });
    const oneType = (type, select = FIND) => [{ sql: `${select} WHERE typeName = ? AND validFrom > ? ${ORDER}`, params: [type, moment] }];
    for (const type of ['Deal', 'Note']) {
      add(id(`${type}.ids`), { ...meta, types: type, read: 'ids' }, instance, cu(oneType(type)));
      add(id(`${type}.flow-ids`), { ...meta, types: type, read: 'ids, then both versions by key' }, instance, cu(oneType(type), { keyReads: 'both' }));
    }
    add(id('Deal.rows'), { ...meta, types: 'Deal', read: 'rows' }, instance, cu(oneType('Deal', FIND_ROW)));
    add(id('Deal.flow-rows'), { ...meta, types: 'Deal', read: 'rows, then the earlier version by key' }, instance, cu(oneType('Deal', FIND_ROW), { keyReads: 'before' }));
    add(id('Deal.where'), { ...meta, types: 'Deal', read: 'ids, WHERE over value and node' }, instance, cu([{
      sql: `${FIND} WHERE typeName = ? AND validFrom > ? AND ${field('stage')} = ? AND ${IN} ${ORDER}`, params: ['Deal', moment, 'open', JSON.stringify(NODES.n4111)],
    }]));
    add(id('several.per-type'), { ...meta, types: 'several', read: 'ids, one statement per type' }, instance,
      cu(SEVERAL.flatMap((t) => oneType(t)), { sort: true }));
    add(id('several.in'), { ...meta, types: 'several', read: 'ids, one statement, typeName IN' }, instance,
      cu([{ sql: `${FIND} WHERE typeName IN (?, ?, ?) AND validFrom > ? ${ORDER}`, params: [...SEVERAL, moment] }]));
    add(id('several.any-type'), { ...meta, types: 'every type', read: 'ids, one statement, no type test' }, instance,
      cu([{ sql: `${FIND} WHERE validFrom > ? ${ORDER}`, params: [moment] }]));
    add(id('several.any-type-named'), { ...meta, types: 'every type', read: 'ids and typeName, one statement, no type test' }, instance,
      cu([{ sql: `SELECT resourceId, validFrom, typeName FROM ${from} WHERE validFrom > ? ${ORDER}`, params: [moment] }]));
  }
}

// ─── Controls: the same statement and plan on every object ───────────
// Two objects can sit on hosts of different speed, so a comparison across objects needs to know by
// how much. These read the same rows through the same index on each of the four.
for (const instance of PAIRED ? [] : ['base', 'node', 'tm', 'm', 'swap', 'all']) {
  add(`control.range.${instance}`, { q: 'control', what: 'range' }, instance, {
    kind: 'sql', params: ['open'],
    sql: `SELECT ${COLS} FROM Snapshots INDEXED BY "idx_Snapshots_q_Deal:stage" WHERE ${where(FILTERS.stage)} ORDER BY resourceId`,
  });
  add(`control.point.${instance}`, { q: 'control', what: 'point' }, instance, {
    kind: 'each', sql: 'SELECT resourceId, validFrom, value FROM Snapshots WHERE resourceId = ? ORDER BY validFrom DESC LIMIT 1',
    paramSets: Array.from({ length: 200 }, (_, k) => [resourceId(k * 137)]),
  });
}

// ─── The run ─────────────────────────────────────────────────────────
const run = new Date().toISOString().replace(/[:.]/g, '-');
const out = { run, base: BASE, startedAt: new Date().toISOString(), config: { TARGET_MS, MAX_REPS, ROUNDS, WRITES, PAIRED }, noops: [], records: [] };
mkdirSync(RESULTS, { recursive: true });
const file = join(RESULTS, `run-${run}${process.env.LABEL ? `-${process.env.LABEL}` : ''}.json`);
const save = () => writeFileSync(file, JSON.stringify(out, null, 1));

/** Microseconds one rep is guessed to take, from what the first call counted. Only sizes `reps`. */
function guessUs(first) {
  const statements = (first.statements ?? 1) + (first.keyStatements ?? 0);
  const rowsRead = (first.rowsRead ?? 0) + (first.findRead ?? 0) + (first.keyRead ?? 0);
  return 40 * statements + 1.5 * rowsRead + (first.bytes ?? 0) / 400;
}

for (const instance of new Set(cases.map((c) => c.instance))) {
  for (let i = 0; i < 5; i++) out.noops.push({ instance, ...(await call(instance, { kind: 'noop' })) });
}
// Pass 1: every case once, with its plan and counts, which also sizes its reps.
for (const [n, c] of cases.entries()) {
  const record = { id: c.id, q: c.q, instance: c.instance, meta: { ...c, op: undefined, id: undefined }, sql: c.op.sql ?? c.op.find.map((f) => f.sql), timed: [] };
  try {
    record.first = await call(c.instance, { ...c.op, explain: true, reps: 1 });
    record.reps = Math.max(1, Math.min(MAX_REPS, Math.round((TARGET_MS * 1000) / guessUs(record.first))));
  } catch (e) {
    record.error = e.message;
  }
  out.records.push(record);
  save();
  process.stdout.write(`\rplan ${n + 1}/${cases.length} ${c.id}${record.error ? ` ERROR ${record.error}` : ''}`.padEnd(100) + (record.error ? '\n' : ''));
}
// Pass 2: ROUNDS timed calls of each case, in a new random order each round, so no case is
// always timed beside the same neighbour or at the same point of an object's warm-up.
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
for (let round = 0; round < ROUNDS; round++) {
  for (const [n, i] of shuffle(cases.map((_, k) => k)).entries()) {
    const record = out.records[i];
    if (record.error) continue;
    try {
      const timed = await call(cases[i].instance, { ...cases[i].op, reps: record.reps });
      if (timed.check !== record.first.check) record.mismatch = true;
      record.timed.push({ seq: timed.seq, round, reps: record.reps, workerMs: timed.workerMs, workerColo: timed.workerColo });
    } catch (e) {
      record.timedErrors = [...(record.timedErrors ?? []), e.message];
    }
    process.stdout.write(`\rround ${round + 1}/${ROUNDS} ${n + 1}/${cases.length}`.padEnd(100));
  }
  save();
}

// What each configuration costs a write. Asked for by WRITES_TOO, once, after every read is in:
// these rows land after the seeded moments, so a later catch-up would count them as missed.
if (process.env.WRITES_TOO) {
  out.writes = {};
  for (const instance of ['base', 'node', 'tm', 'm', 'swap']) out.writes[instance] = (await call(instance, { kind: 'writes', n: 10 }, 1)).tally;
}
out.finishedAt = new Date().toISOString();
save();
console.log(`\nwrote ${file}`);
