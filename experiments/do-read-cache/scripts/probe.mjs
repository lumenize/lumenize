#!/usr/bin/env node
/**
 * Driver for experiment-do-read-cache. RESULTS.md has the question, the design and the findings.
 *
 *   node scripts/probe.mjs clock        what the object's own clock says a read took, three ways
 *   node scripts/probe.mjs records      one 10-field record per read: in memory, cache hit, cache miss
 *   node scripts/probe.mjs sweep        warm per-read cost against working-set size (the knee)
 *   node scripts/probe.mjs abort        the first pass after ctx.abort() against the pass after it
 *   node scripts/probe.mjs seed-idle    fill objects and leave them for check-idle, hours later
 *   node scripts/probe.mjs check-idle results/idle-seed-<run>.json
 *   node scripts/probe.mjs wipe results/idle-seed-<run>.json
 *
 * BASE defaults to a local `wrangler dev` on :8799; set it to the deployed URL for a deployed run,
 * then run `scripts/logs.mjs` on the result file to join each object invocation's wallTimeMs and
 * cpuTimeMs from Workers Logs. The token is BENCH_TOKEN in this experiment's own .dev.vars and is
 * never printed. Knobs (env): OBJECTS, ROUNDS, CYCLES, TARGET_READS, MAX_ROWS.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(DIR, 'results');
const BASE = (process.env.BASE ?? 'http://localhost:8799').replace(/\/$/, '');
const LOCAL = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${BASE}/`);
const TOKEN = /^BENCH_TOKEN=(.+)$/m.exec(readFileSync(join(DIR, '.dev.vars'), 'utf8'))?.[1].trim();
if (!TOKEN) throw new Error('BENCH_TOKEN is missing from experiments/do-read-cache/.dev.vars');

const num = (k, d) => Number(process.env[k] ?? d);
const OBJECTS = num('OBJECTS', LOCAL ? 3 : 10);
const ROUNDS = num('ROUNDS', 3);
const CYCLES = num('CYCLES', 10);
const TARGET_READS = num('TARGET_READS', 10_000);
const MAX_ROWS = num('MAX_ROWS', 18_000); // ≈ 63 MB of row data per api
const FILL_BATCH = 2_000; // ≈ 7 MB per fill call
const APIS = ['sql', 'kv'];
// Working sets, in rows. SQLite's default 2000 KiB cache holds roughly 470 pages of 4 KiB, so
// the grid is dense from 256 to 768 rows and sparse beyond.
const SWEEP_ROWS = [64, 128, 256, 320, 384, 416, 448, 480, 512, 576, 640, 768, 1024, 1536, 2048, 4096, 8192, 18_000]
  .filter((r) => r <= MAX_ROWS);
const ABORT_ROWS = [256, 448, 4096, 18_000].filter((r) => r <= MAX_ROWS);

const REC_COUNT = num('REC_COUNT', 100_000);
const REC_FILL_BATCH = 10_000;
const SHAPE = process.env.SHAPE === 'records' ? 'records' : 'blob';
/** One condition per row of the per-read table. `of` sets the working set; `reads` sizes the call. */
const REC_CONDITIONS = [
  { label: 'mem, 128 records', api: 'mem', of: 128, reads: 2_000_000 },
  { label: `mem, ${REC_COUNT} records`, api: 'mem', of: REC_COUNT, reads: 2_000_000 },
  { label: 'sql, cache hit', api: 'sql', of: 128, reads: 20_000 },
  { label: 'kv, cache hit', api: 'kv', of: 128, reads: 20_000 },
  { label: 'sql, cache miss', api: 'sql', of: REC_COUNT, reads: 20_000 },
  { label: 'kv, cache miss', api: 'kv', of: REC_COUNT, reads: 20_000 },
];
const run = new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const grid = (rowsList) => rowsList.flatMap((rows) => APIS.map((api) => ({ api, rows })));
const mb = (bytes) => (bytes / 1e6).toFixed(1);
const pick = (m) => ({
  seq: m.seq, workerMs: m.workerMs, workerColo: m.workerColo, nodeMs: Math.round(m.nodeMs * 10) / 10,
  frozenMs: m.frozenMs, timerMs: m.timerMs, ioMs: m.ioMs, reads: m.reads, bootId: m.bootId, built: m.built,
});
/** Per-read µs on the Worker clock, net of the adjacent ping: progress only; analyze.mjs has the real numbers. */
const perReadUs = (read, ping) => ((read.workerMs - ping.workerMs) / read.reads) * 1000;

let seq = 0;
async function op(instance, params, { retries = 0 } = {}) {
  const s = ++seq;
  const qs = new URLSearchParams({ ...params, seq: String(s) });
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    const res = await fetch(`${BASE}/op/${instance}?${qs}`, { headers: { 'x-bench-token': TOKEN } });
    const nodeMs = performance.now() - t;
    if (res.ok) return { seq: s, nodeMs, ...(await res.json()) };
    const body = await res.text();
    if (attempt >= retries) throw new Error(`${params.op} ${instance}: ${res.status} ${body.slice(0, 300)}`);
    await sleep(500);
  }
}

async function fill(instance, shape = 'blob') {
  for (const api of APIS) {
    if (shape === 'records') {
      for (let from = 0; from < REC_COUNT; from += REC_FILL_BATCH) {
        await op(instance, { op: 'fillRecords', api, from, count: Math.min(REC_FILL_BATCH, REC_COUNT - from) });
      }
      continue;
    }
    for (let from = 0; from < MAX_ROWS; from += FILL_BATCH) {
      await op(instance, { op: 'fill', api, from, count: Math.min(FILL_BATCH, MAX_ROWS - from) });
    }
  }
  const [where, info] = [await op(instance, { op: 'colo' }), await op(instance, { op: 'info' })];
  console.log(`${instance}: colo ${where.colo}, database ${mb(info.databaseSize)} MB, page ${info.pageSize} B`);
  return { instance, colo: where.colo, databaseSize: info.databaseSize, pageSize: info.pageSize };
}

// ---------------------------------------------------------------------------------------------

function header(mode) {
  return {
    mode, run, base: BASE, local: LOCAL, startedAt: new Date().toISOString(),
    config: { OBJECTS, ROUNDS, CYCLES, TARGET_READS, MAX_ROWS, SWEEP_ROWS, ABORT_ROWS },
    objects: [], records: [],
  };
}

function save(out) {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${out.mode}-${LOCAL ? 'local' : 'deployed'}-${run}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  return file;
}

async function measured(out, body) {
  try {
    await body();
  } finally {
    out.finishedAt = new Date().toISOString();
    const file = save(out);
    console.log(`wrote ${file}${LOCAL ? '' : `\nthen: node scripts/logs.mjs ${file}`}`);
  }
}

async function clockArm() {
  const out = header('clock');
  await measured(out, async () => {
    const instance = `clock-${run}`;
    const rows = 2048;
    for (const api of APIS) await op(instance, { op: 'fill', api, from: 0, count: rows });
    const where = await op(instance, { op: 'colo' });
    out.objects.push({ instance, colo: where.colo });
    for (let i = 0; i < 10; i++) {
      const ping = await op(instance, { op: 'ping' });
      const clock = await op(instance, { op: 'clock', api: 'sql', rows, passes: 5 });
      out.records.push({ arm: 'clock', object: 0, i, ping: pick(ping), clock: pick(clock) });
      console.log(`  ${clock.reads} reads: frozen ${clock.frozenMs} ms, after setTimeout ${clock.timerMs} ms, after self-RPC ${clock.ioMs} ms; Worker ${clock.workerMs} ms (${clock.workerColo}, object ${where.colo})`);
    }
    await op(instance, { op: 'wipe' });
  });
}

async function records() {
  const out = header('records');
  out.config.REC_COUNT = REC_COUNT;
  out.config.REC_CONDITIONS = REC_CONDITIONS;
  await measured(out, async () => {
    for (let o = 0; o < OBJECTS; o++) {
      const instance = `records-${run}-${o}`;
      out.objects.push(await fill(instance, 'records'));
      for (let round = 0; round < ROUNDS; round++) {
        for (const c of shuffle(REC_CONDITIONS)) {
          const ping = await op(instance, { op: 'ping' });
          // Loads this working set, and builds the Map on the mem arm's first call.
          await op(instance, { op: 'readRecords', api: c.api, of: c.of, reads: Math.min(c.reads, 20_000) });
          const read = await op(instance, { op: 'readRecords', api: c.api, of: c.of, reads: c.reads });
          out.records.push({ arm: 'records', object: o, round, label: c.label, api: c.api, of: c.of, read: pick(read), ping: pick(ping) });
        }
        console.log(`  round ${round} done`);
      }
      await op(instance, { op: 'wipe' });
      save(out);
    }
  });
}

async function sweep() {
  const out = header('sweep');
  await measured(out, async () => {
    for (let o = 0; o < OBJECTS; o++) {
      const instance = `sweep-${run}-${o}`;
      out.objects.push(await fill(instance));
      for (let round = 0; round < ROUNDS; round++) {
        for (const { api, rows } of shuffle(grid(SWEEP_ROWS))) {
          const ping = await op(instance, { op: 'ping' });
          await op(instance, { op: 'read', api, rows, passes: 1 }); // load this working set
          const passes = Math.max(1, Math.round(TARGET_READS / rows));
          const read = await op(instance, { op: 'read', api, rows, passes });
          out.records.push({ arm: 'warm', object: o, round, api, rows, passes, read: pick(read), ping: pick(ping) });
        }
        const line = APIS.map((api) => `${api} ${[64, 448, 1024, MAX_ROWS].map((rows) => {
          const r = out.records.find((x) => x.object === o && x.round === round && x.api === api && x.rows === rows);
          return r ? `${rows}:${perReadUs(r.read, r.ping).toFixed(2)}` : '';
        }).join(' ')}`).join(' | ');
        console.log(`  round ${round} µs/read  ${line}`);
      }
      await op(instance, { op: 'wipe' });
      save(out);
    }
  });
}

async function abortArm() {
  const out = header('abort');
  await measured(out, async () => {
    for (let o = 0; o < OBJECTS; o++) {
      const instance = `abort-${run}-${o}`;
      out.objects.push(await fill(instance));
      let boot = (await op(instance, { op: 'ping' })).bootId;
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        for (const { api, rows } of shuffle(grid(ABORT_ROWS))) {
          const abort = await op(instance, { op: 'abort' });
          const ping = await op(instance, { op: 'ping' }, { retries: 5 }); // builds the new object
          const cold = await op(instance, { op: 'read', api, rows, passes: 1 });
          const warm = await op(instance, { op: 'read', api, rows, passes: 1 });
          out.records.push({
            arm: 'abort', object: o, cycle, api, rows, aborted: abort.aborted, reset: ping.bootId !== boot,
            ping: pick(ping), cold: pick(cold), warm: pick(warm),
          });
          boot = ping.bootId;
        }
        const mine = out.records.filter((r) => r.object === o && r.cycle === cycle);
        console.log(`  cycle ${cycle}: ${mine.map((r) => `${r.api}/${r.rows} ${r.cold.workerMs}→${r.warm.workerMs}ms`).join('  ')}`);
      }
      await op(instance, { op: 'wipe' });
      save(out);
    }
  });
}

async function seedIdle() {
  const seed = { run, base: BASE, shape: SHAPE, maxRows: SHAPE === 'records' ? REC_COUNT : MAX_ROWS, objects: [] };
  for (let o = 0; o < OBJECTS; o++) {
    const instance = `idle-${run}-${o}`;
    const filled = await fill(instance, SHAPE);
    await op(instance, { op: 'abort' }); // out of memory now, not at eviction
    seed.objects.push({ ...filled, seededAt: new Date().toISOString() });
  }
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `idle-seed-${run}.json`);
  writeFileSync(file, JSON.stringify(seed, null, 1));
  console.log(`wrote ${file}; run check-idle on it hours from now`);
}

async function checkIdle(seedFile) {
  const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  if (seed.base !== BASE) throw new Error(`seeded against ${seed.base}, BASE is ${BASE}`);
  const out = header('idle-check');
  out.seedFile = seedFile;
  await measured(out, async () => {
    for (const [o, obj] of seed.objects.entries()) {
      const idleMinutes = Math.round((Date.now() - Date.parse(obj.seededAt)) / 60_000);
      const order = o % 2 ? ['kv', 'sql'] : ['sql', 'kv'];
      const ping = await op(obj.instance, { op: 'ping' }, { retries: 5 }); // first construction since seeding
      const rec = { arm: 'idle', object: o, instance: obj.instance, idleMinutes, order, ping: pick(ping) };
      // Records: 20,000 sampled from all of them, as the record arm's cache-miss condition reads.
      const readOp = seed.shape === 'records'
        ? (api) => ({ op: 'readRecords', api, of: seed.maxRows, reads: 20_000 })
        : (api) => ({ op: 'read', api, rows: seed.maxRows, passes: 1 });
      rec.shape = seed.shape ?? 'blob';
      for (const api of order) rec[`cold_${api}`] = pick(await op(obj.instance, readOp(api)));
      for (const api of order) rec[`warm_${api}`] = pick(await op(obj.instance, readOp(api)));
      out.records.push(rec);
      console.log(`${obj.instance} idle ${idleMinutes} min: ping ${ping.workerMs} ms, ` +
        order.map((api) => `${api} cold ${rec[`cold_${api}`].workerMs} warm ${rec[`warm_${api}`].workerMs} ms`).join(', '));
      await op(obj.instance, { op: 'wipe' });
    }
  });
}

async function wipe(seedFile) {
  for (const obj of JSON.parse(readFileSync(seedFile, 'utf8')).objects) {
    await op(obj.instance, { op: 'wipe' });
    console.log(`wiped ${obj.instance}`);
  }
}

const [mode, arg] = process.argv.slice(2);
const modes = { clock: clockArm, records, sweep, abort: abortArm, 'seed-idle': seedIdle, 'check-idle': () => checkIdle(arg), wipe: () => wipe(arg) };
if (!modes[mode]) {
  console.error(`usage: node scripts/probe.mjs ${Object.keys(modes).join('|')} [seed-file]`);
  process.exit(2);
}
console.log(`${mode} against ${BASE} (${LOCAL ? 'local' : 'deployed'}), run ${run}`);
await modes[mode]();
