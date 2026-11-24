#!/usr/bin/env node
/**
 * Runs the cases and writes results/<mode>-<time>.json. RESULTS.md has the question and findings.
 *
 *   BASE=https://experiment-asof-index-cost.<account>.workers.dev MODE=reads node scripts/measure.mjs
 *   node scripts/logs.mjs results/reads-<time>.json     # joins Workers Logs cpuTimeMs
 *   node scripts/tables.mjs results/reads-<time>.json   # prints the tables RESULTS.md carries
 *
 * MODE=reads: each case is first called once with EXPLAIN QUERY PLAN, which answers the plan and
 * what the sql cursor counted. It is then timed ROUNDS times: a timed call runs the case `reps`
 * times in one invocation and nothing else, and that invocation's cpuTimeMs in Workers Logs,
 * divided by `reps`, is the case's CPU. Rounds run in a new random order each, and every arm of
 * one depth is a table on one object, so arms are compared on one host.
 *
 * MODE=writes: ten creates and ten updates of each type on every table, with each statement's
 * rowsWritten. Run it after the reads, since it adds rows.
 *
 * MODE=sizes: tries `dbstat` for each index's size.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { END_OF_TIME, momentOf } from '../src/fixture.js';
import { ARMS, BASE, call, current, everyVersion, field, indexName, OBJECTS, RESULTS, tableOf, writesOf } from './lib.mjs';

const MODE = process.env.MODE ?? 'reads';
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const TARGET_MS = Number(process.env.TARGET_MS ?? 250);
const MAX_REPS = 3000;
const ROUNDS = Number(process.env.ROUNDS ?? 5);

mkdirSync(RESULTS, { recursive: true });
const run = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(RESULTS, `${MODE}-${run}.json`);
const out = { run, mode: MODE, base: BASE, startedAt: new Date().toISOString(), config: { TARGET_MS, MAX_REPS, ROUNDS }, noops: [], records: [] };
const save = () => writeFileSync(file, JSON.stringify(out, null, 1));

if (MODE === 'writes') {
  for (const [object, { arms }] of Object.entries(OBJECTS)) {
    for (const [arm, n] of arms) {
      const table = tableOf(arm, n);
      const res = await call(object, { kind: 'writes', table, n: 10 });
      out.records.push({ object, arm, indexes: n, table, tally: res.tally });
      console.log(object, table, JSON.stringify(res.tally));
    }
  }
  out.finishedAt = new Date().toISOString();
  save();
  console.log(`wrote ${file}`);
  process.exit(0);
}

if (MODE === 'sizes') {
  for (const object of Object.keys(OBJECTS)) {
    const tables = OBJECTS[object].arms.map(([arm, n]) => tableOf(arm, n));
    const info = await call(object, { kind: 'info', tables });
    const record = { object, databaseSize: info.databaseSize, indexes: info.indexes };
    try {
      const res = await call(object, { kind: 'sql', rowsOut: true, sql: 'SELECT name, sum(pgsize) AS bytes, count(*) AS pages FROM dbstat GROUP BY name ORDER BY name' });
      record.dbstat = res.out;
    } catch (e) {
      record.dbstatError = e.message;
    }
    // dbstat is not there, so an index's size is what `databaseSize` grows by when it is built.
    // S_Z0 has no `@index`, so each arm's index for `stage` is built on it in turn, and never dropped.
    if (object === 'd10') {
      record.built = [];
      let before = info.databaseSize;
      for (const arm of ['A', 'B', 'C', 'F']) {
        const ddl = ARMS[arm]('S_Z0', 'stage').replace('"idx_S_Z0_q_Deal:stage"', `"idx_S_Z0_size_${arm}"`);
        const res = await call(object, { kind: 'ddl', sql: [ddl] });
        record.built.push({ arm, ddl, bytes: res.databaseSize - before, rowsRead: res.ddl[0].rowsRead, rowsWritten: res.ddl[0].rowsWritten });
        before = res.databaseSize;
      }
    }
    for (const table of tables) {
      record[table] = (await call(object, { kind: 'sql', rowsOut: true, sql: `SELECT count(*) AS n, sum(typeName = 'Deal') AS deals, sum(length(value)) AS valueBytes FROM ${table}` })).out[0];
    }
    out.records.push(record);
    console.log(JSON.stringify(record, null, 1));
  }
  out.finishedAt = new Date().toISOString();
  save();
  console.log(`wrote ${file}`);
  process.exit(0);
}

// ─── MODE=reads ──────────────────────────────────────────────────────
const COLS = 'resourceId, nodeId, validFrom, value';
const STAGE = 'open';
const stage = `${field('stage')} = ?`;
const A = tableOf('A', 1), B = tableOf('B', 1), C = tableOf('C', 1);
const by = (t) => `${t} INDEXED BY ${indexName(t, 'stage')}`;
const cases = [];
const add = (id, meta, object, op, timed = true) => { if (!ONLY || ONLY.test(id)) cases.push({ id, ...meta, object, op, timed }); };
const sql = (text, params) => ({ kind: 'sql', sql: text, params });

for (const object of Object.keys(OBJECTS)) {
  const W = writesOf(object);
  const d = object;
  // ── A current query: what matches now.
  const cur = { q: 'current', depth: d };
  add(`${d}.current.A`, { ...cur, arm: 'A' }, object, sql(`SELECT ${COLS} FROM ${by(A)} WHERE ${current('Deal')} AND ${stage} ORDER BY resourceId`, [STAGE]));
  add(`${d}.current.B`, { ...cur, arm: 'B' }, object, sql(`SELECT ${COLS} FROM ${by(B)} WHERE ${everyVersion('Deal')} AND ${stage} AND validTo = '${END_OF_TIME}' ORDER BY resourceId`, [STAGE]));
  add(`${d}.current.C`, { ...cur, arm: 'C' }, object, sql(`SELECT ${COLS} FROM ${by(C)} WHERE ${everyVersion('Deal')} AND ${stage} AND validTo = '${END_OF_TIME}' ORDER BY resourceId`, [STAGE]));
  // What SQLite picks when the statement names no index. Plan and counts only.
  add(`${d}.current.A.pick`, { ...cur, arm: 'A pick' }, object, sql(`SELECT ${COLS} FROM ${A} WHERE ${current('Deal')} AND ${stage} ORDER BY resourceId`, [STAGE]), false);
  add(`${d}.current.B.pick`, { ...cur, arm: 'B pick' }, object, sql(`SELECT ${COLS} FROM ${B} WHERE ${current('Deal')} AND ${stage} ORDER BY resourceId`, [STAGE]), false);
  add(`${d}.current.C.pick`, { ...cur, arm: 'C pick' }, object, sql(`SELECT ${COLS} FROM ${C} WHERE ${current('Deal')} AND ${stage} ORDER BY resourceId`, [STAGE]), false);

  // ── A query as of a moment, and today's first read for the same moment.
  const MOMENTS = { recent: W - 21, mid: W - 1001, far: W / 2 - 1 };
  for (const [mk, i] of Object.entries(MOMENTS)) {
    const m0 = momentOf(i);
    const meta = { q: 'asof', depth: d, moment: mk, m0, writesSince: W - 1 - i };
    const asOf = 'validTo > ? AND validFrom <= ?';
    add(`${d}.asof.${mk}.B`, { ...meta, arm: 'B' }, object, sql(`SELECT ${COLS} FROM ${by(B)} WHERE ${everyVersion('Deal')} AND ${stage} AND ${asOf} ORDER BY resourceId`, [STAGE, m0, m0]));
    add(`${d}.asof.${mk}.B.unordered`, { ...meta, arm: 'B unordered' }, object, sql(`SELECT ${COLS} FROM ${by(B)} WHERE ${everyVersion('Deal')} AND ${stage} AND ${asOf}`, [STAGE, m0, m0]));
    add(`${d}.asof.${mk}.B.ids`, { ...meta, arm: 'B ids only' }, object, sql(`SELECT resourceId, validFrom FROM ${by(B)} WHERE ${everyVersion('Deal')} AND ${stage} AND ${asOf}`, [STAGE, m0, m0]));
    add(`${d}.asof.${mk}.C`, { ...meta, arm: 'C' }, object, sql(`SELECT ${COLS} FROM ${by(C)} WHERE ${everyVersion('Deal')} AND ${stage} AND ${asOf} ORDER BY resourceId`, [STAGE, m0, m0]));
    add(`${d}.asof.${mk}.A`, { ...meta, arm: 'A (no index over history)' }, object, sql(`SELECT ${COLS} FROM ${A} WHERE ${everyVersion('Deal')} AND ${stage} AND ${asOf} ORDER BY resourceId`, [STAGE, m0, m0]));
    add(`${d}.asof.${mk}.B.pick`, { ...meta, arm: 'B pick' }, object, sql(`SELECT ${COLS} FROM ${B} WHERE ${everyVersion('Deal')} AND ${stage} AND ${asOf} ORDER BY resourceId`, [STAGE, m0, m0]), false);
    add(`${d}.asof.${mk}.C.pick`, { ...meta, arm: 'C pick' }, object, sql(`SELECT ${COLS} FROM ${C} WHERE ${everyVersion('Deal')} AND ${stage} AND ${asOf} ORDER BY resourceId`, [STAGE, m0, m0]), false);
    add(`${d}.asof.${mk}.today`, { ...meta, arm: 'today' }, object, {
      kind: 'firstRead', m0,
      scan: `SELECT ${COLS} FROM ${by(A)} WHERE ${current('Deal')} AND ${stage} ORDER BY resourceId`, scanParams: [STAGE],
      lookup: `SELECT validFrom, value, (${everyVersion('Deal')} AND ${field('stage')} = '${STAGE}') AS matches FROM ${A} WHERE resourceId = ? AND validFrom <= ? ORDER BY validFrom DESC LIMIT 1`,
    });
  }
}

// ── MODE=extra: why arm B's far read opens every row it passes, tested with two more indexes on S_B1.
// X1 has no WHERE and carries every column the scan tests. X2 is B with validFrom named in it.
const X1 = 'idx_S_B1_x1', X2 = 'idx_S_B1_x2';
const EXTRA_DDL = [
  `CREATE INDEX IF NOT EXISTS ${X1} ON ${B}(typeName, ${field('stage')}, validTo, deleted)`,
  `CREATE INDEX IF NOT EXISTS ${X2} ON ${B}(${field('stage')}, validTo, validFrom) WHERE ${everyVersion('Deal')}`,
];
if (MODE === 'extra') {
  cases.length = 0;
  out.ddl = {};
  for (const object of ['d10', 'd100']) {
    const before = (await call(object, { kind: 'info', tables: [] })).databaseSize;
    out.ddl[object] = [];
    let size = before;
    for (const ddl of EXTRA_DDL) {
      const res = await call(object, { kind: 'ddl', sql: [ddl] });
      out.ddl[object].push({ ddl, bytes: res.databaseSize - size, rowsRead: res.ddl[0].rowsRead, rowsWritten: res.ddl[0].rowsWritten });
      size = res.databaseSize;
    }
    // The writes run moved each table past its seeded end, so moments are taken from the seeded range as before.
    const W = writesOf(object);
    for (const [mk, i] of Object.entries({ recent: W - 21, far: W / 2 - 1 })) {
      const m0 = momentOf(i);
      const meta = { q: 'asof', depth: object, moment: mk, m0 };
      const w = `${everyVersion('Deal')} AND ${stage} AND validTo > ? AND validFrom <= ?`;
      const p = [STAGE, m0, m0];
      add(`${object}.x.${mk}.B`, { ...meta, arm: 'B unordered' }, object, sql(`SELECT ${COLS} FROM ${by(B)} WHERE ${w}`, p));
      add(`${object}.x.${mk}.B.ids`, { ...meta, arm: 'B ids only' }, object, sql(`SELECT resourceId, validFrom FROM ${by(B)} WHERE ${w}`, p));
      for (const [name, ix] of [['X1', X1], ['X2', X2]]) {
        add(`${object}.x.${mk}.${name}`, { ...meta, arm: `${name} unordered` }, object, sql(`SELECT ${COLS} FROM ${B} INDEXED BY ${ix} WHERE ${w}`, p));
        add(`${object}.x.${mk}.${name}.ordered`, { ...meta, arm: `${name} ordered` }, object, sql(`SELECT ${COLS} FROM ${B} INDEXED BY ${ix} WHERE ${w} ORDER BY resourceId`, p));
        add(`${object}.x.${mk}.${name}.ids`, { ...meta, arm: `${name} ids only` }, object, sql(`SELECT resourceId, validFrom FROM ${B} INDEXED BY ${ix} WHERE ${w}`, p));
      }
    }
  }
  console.log(JSON.stringify(out.ddl, null, 1));
}

/** Microseconds one rep is guessed to take, from what the first call counted. Only sizes `reps`. */
const guessUs = (first) => 50 + (first.rowsRead ?? 0) * 8;

for (const object of new Set(cases.map((c) => c.object))) {
  for (let i = 0; i < 5; i++) out.noops.push({ object, ...(await call(object, { kind: 'noop' })) });
}
// Pass 1: every case once, with its plan and counts, which also sizes its reps.
for (const [n, c] of cases.entries()) {
  const record = { ...c, timed: [] , isTimed: c.timed };
  record.first = await call(c.object, { ...c.op, explain: true, reps: 1 });
  record.reps = Math.max(1, Math.min(MAX_REPS, Math.round((TARGET_MS * 1000) / guessUs(record.first))));
  out.records.push(record);
  process.stdout.write(`\rpass 1 ${n + 1}/${cases.length}`.padEnd(60));
}
save();
// Pass 2: ROUNDS timed calls of each case, in a new random order each round.
const shuffle = (xs) => {
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return xs;
};
const timedIdx = out.records.map((r, k) => (r.isTimed ? k : -1)).filter((k) => k >= 0);
for (let round = 0; round < ROUNDS; round++) {
  for (const [n, k] of shuffle([...timedIdx]).entries()) {
    const record = out.records[k];
    const timed = await call(record.object, { ...record.op, reps: record.reps });
    record.timed.push({ seq: timed.seq, round, reps: record.reps, workerMs: timed.workerMs, workerColo: timed.workerColo });
    // A labeled no-op after each timed call anchors the join when a heavy call's own line is dropped.
    out.noops.push({ object: record.object, ...(await call(record.object, { kind: 'noop' })) });
    process.stdout.write(`\rround ${round + 1}/${ROUNDS} ${n + 1}/${timedIdx.length}`.padEnd(60));
  }
  save();
}
out.finishedAt = new Date().toISOString();
save();
console.log(`\nwrote ${file}`);
