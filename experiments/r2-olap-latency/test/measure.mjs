#!/usr/bin/env node
/**
 * R2-OLAP-latency measurement harness (external Node observer).
 *
 * Pattern from experiments/dag-sql-perf/test/measure.mjs: node:perf_hooks timing, percentiles,
 * warmup, paired-noop baseline. Timing is client-side ON PURPOSE — a DO's clock is frozen during
 * synchronous SQL (memory: cf-clock-traps), so only an external observer measures true latency.
 * Headline metric = end-to-end latency; the noop floor only isolates SQL cost from mesh+auth.
 *
 * Usage: node test/measure.mjs <arm>     arm = do | r2
 *   ITERATIONS=200 node test/measure.mjs do
 */
import { performance } from 'node:perf_hooks';

const ARM = process.argv[2] || 'do';
const ITERATIONS = parseInt(process.env.ITERATIONS || '100', 10);
const WARMUP = 10;

// ─── stats (from dag-sql-perf) ───────────────────────────────────────
function computeStats(t) {
  const s = [...t].sort((a, b) => a - b), n = s.length;
  return {
    n, avg: s.reduce((x, v) => x + v, 0) / n,
    p50: s[(n * 0.5) | 0], p95: s[(n * 0.95) | 0], p99: s[(n * 0.99) | 0],
    min: s[0], max: s[n - 1],
  };
}
const fmt = (v) => v.toFixed(2).padStart(8) + 'ms';
const HEADER = `  ${'Query'.padEnd(34)} | ${'N'.padStart(4)} | ${'avg'.padStart(10)} | ${'p50'.padStart(10)} | ${'p95'.padStart(10)} | ${'p99'.padStart(10)} | ${'max'.padStart(10)}`;
function printRow(label, st) {
  console.log(`  ${label.padEnd(34)} | ${String(st.n).padStart(4)} | ${fmt(st.avg)} | ${fmt(st.p50)} | ${fmt(st.p95)} | ${fmt(st.p99)} | ${fmt(st.max)}`);
}

/** Warm, then time `fn` ITERATIONS times; print + return percentile stats. */
async function measure(label, fn, iterations = ITERATIONS) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    timings.push(performance.now() - start);
  }
  const st = computeStats(timings);
  printRow(label, st);
  return st;
}

// ─── arm 1: DO SQLite via the mesh path ──────────────────────────────
async function runDoArm() {
  // TODO (faithful path): connect a mesh client (@lumenize/testing) to the dev/deployed
  // Worker + Gateway; satisfy auth (minted activeScope + admin once HistoryStoreDO is a
  // NebulaDO); seed rows from data/rows-<count>.ndjson; then measure each query. e.g.:
  //   await measure('noop (mesh+auth floor)', () => client.…noop());
  //   await measure('point: resource history', () => client.…pointQuery(id));
  //   await measure('range: time window',      () => client.…rangeQuery(from, to));
  //   await measure('aggregate: per type',     () => client.…aggregateByType());
  //   await measure('top-N: most revised',     () => client.…topRevised(10));
  throw new Error('TODO: wire the mesh client + seed for the DO arm (see README "faithful-path TODO")');
}

// ─── arm 2: R2 SQL over Data Catalog (Iceberg) via REST ──────────────
async function runR2Arm() {
  const account = process.env.ACCOUNT_ID;
  const bucket = process.env.BUCKET;
  const token = process.env.WRANGLER_R2_SQL_AUTH_TOKEN;
  if (!account || !bucket || !token) {
    throw new Error('set ACCOUNT_ID, BUCKET, WRANGLER_R2_SQL_AUTH_TOKEN (see README step 2)');
  }
  const endpoint = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${account}/r2-sql/query/${bucket}`;
  // TODO: confirm the exact request body + response shape from the R2 SQL REST docs, and the
  // namespace.table name created during the Iceberg load.
  const query = (sql) => fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  }).then((r) => r.json());
  void query; // referenced once the query set below is filled in
  //   await measure('point: resource history', () => query(`SELECT * FROM ns.snapshots WHERE resourceId = '…' ORDER BY validFrom LIMIT 500`));
  //   await measure('range: time window',      () => query(`SELECT * FROM ns.snapshots WHERE validFrom >= … AND validFrom < … LIMIT 1000`));
  //   await measure('aggregate: per type',     () => query(`SELECT type, COUNT(*) AS n FROM ns.snapshots GROUP BY type ORDER BY n DESC`));
  //   await measure('top-N: most revised',     () => query(`SELECT resourceId, COUNT(*) AS v FROM ns.snapshots GROUP BY resourceId ORDER BY v DESC LIMIT 10`));
  throw new Error('TODO: confirm R2 SQL REST body/response + Iceberg table name, then run the query set');
}

async function main() {
  console.log(`\n🧪 R2-OLAP-latency — arm: ${ARM}  (iterations=${ITERATIONS}, warmup=${WARMUP})\n`);
  console.log(HEADER);
  console.log('  ' + '-'.repeat(HEADER.length - 2));
  if (ARM === 'do') await runDoArm();
  else if (ARM === 'r2') await runR2Arm();
  else throw new Error(`unknown arm '${ARM}' (use: do | r2)`);
  console.log('');
}
main().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
