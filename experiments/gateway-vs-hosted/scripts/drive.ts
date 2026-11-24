/**
 * Drives both arms of the experiment from one Node process, so every timestamp comes from one
 * clock outside Cloudflare (`performance.now()` here, never `Date.now()` in a Worker).
 *
 *   BENCH_BASE_URL=https://experiment-gateway-vs-hosted.<account>.workers.dev \
 *   BENCH_TOKEN=<the deployed secret> npx tsx scripts/drive.ts [latency|throughput|broadcast|all]
 *
 * Every step gets a fresh BenchDO (a new `runId`) and fresh clients, so neither arm inherits the
 * other's warm objects. Arms alternate which goes first each round, so drift over a run lands on
 * both. Raw numbers go to `results/`, and a summary prints at the end.
 *
 * Knobs (env): ROUNDS (2) · LATENCY_CALLS (300) · THROUGHPUT_M ("16,64,256") ·
 * WORKLOADS ("echo,write") · WARMUP_S (5) · WINDOW_S (15) · BROADCAST_N ("10,100,250,500,1000") ·
 * BROADCAST_PUBLISHES (5) · ARMS ("gateway,hosted")
 */
import { LumenizeClient, mesh } from '@lumenize/mesh/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

type Arm = 'gateway' | 'hosted';
type Workload = 'echo' | 'write' | 'heavy';

const BASE = (process.env.BENCH_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const BENCH_TOKEN = process.env.BENCH_TOKEN ?? '';
const num = (k: string, d: number) => Number(process.env[k] ?? d);
const list = (k: string, d: string) => (process.env[k] ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const ROUNDS = num('ROUNDS', 2);
const LATENCY_CALLS = num('LATENCY_CALLS', 300);
const THROUGHPUT_M = list('THROUGHPUT_M', '16,64,256').map(Number);
const WORKLOADS = list('WORKLOADS', 'echo,write') as Workload[];
const WARMUP_S = num('WARMUP_S', 5);
const WINDOW_S = num('WINDOW_S', 15);
const BROADCAST_N = list('BROADCAST_N', '10,100,250,500,1000').map(Number);
const BROADCAST_PUBLISHES = num('BROADCAST_PUBLISHES', 5);
const ARMS = list('ARMS', 'gateway,hosted') as Arm[];
const CONNECT_BATCH = 50;

const SUB = `bench${randomBytes(4).toString('hex')}`;

/** An unsigned token: the Worker checks only the shared secret inside it, at the upgrade. */
function mintToken(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: SUB, exp: Math.floor(Date.now() / 1000) + 4 * 3600, bench: BENCH_TOKEN })}.x`;
}
const TOKEN = mintToken();

/** Times any client's socket dropped and it began reconnecting; a hosting object's reset shows here. */
let socketDrops = 0;

/** seq → arrival times of `handlePush(seq)` across every subscriber in this process. */
const arrivals = new Map<number, number[]>();

class BenchClient extends LumenizeClient {
  runId = '';

  call(workload: Workload | 'subscribe' | 'clearSubscribers' | 'publish' | 'onPushResult', x?: number): Promise<any> {
    const target = (this.ctn<any>() as any)[workload];
    const remote = x === undefined ? target() : target(x);
    return this.lmz.callAsync('BENCH_DO', this.runId, remote, { timeoutMs: 30_000 });
  }

  @mesh()
  handlePush(seq: number): void {
    const t = performance.now();
    let list = arrivals.get(seq);
    if (!list) arrivals.set(seq, (list = []));
    list.push(t);
  }
}

async function connect(arm: Arm, runId: string): Promise<BenchClient> {
  let resolveConnected!: () => void;
  let rejectConnected!: (e: Error) => void;
  const connected = new Promise<void>((res, rej) => { resolveConnected = res; rejectConnected = rej; });
  const timer = setTimeout(() => rejectConnected(new Error(`${arm}: connect timed out`)), 60_000);
  const client = new BenchClient({
    baseUrl: `${BASE}/s/${runId}`,
    gatewayBindingName: arm === 'gateway' ? 'LUMENIZE_CLIENT_GATEWAY' : 'BENCH_DO',
    instanceName: `${SUB}.${randomBytes(4).toString('hex')}`,
    accessToken: TOKEN,
    refresh: async () => ({ access_token: TOKEN }),
    WebSocket: globalThis.WebSocket,
    onConnectionStateChange: (s) => {
      if (s === 'connected') { clearTimeout(timer); resolveConnected(); }
      if (s === 'reconnecting') socketDrops++;
    },
  });
  client.runId = runId;
  await connected;
  return client;
}

async function connectMany(arm: Arm, runId: string, n: number): Promise<BenchClient[]> {
  const clients: BenchClient[] = [];
  for (let i = 0; i < n; i += CONNECT_BATCH) {
    const batch = await Promise.all(Array.from({ length: Math.min(CONNECT_BATCH, n - i) }, () => connect(arm, runId)));
    clients.push(...batch);
  }
  return clients;
}

function closeAll(clients: BenchClient[]): void {
  for (const c of clients) c.disconnect();
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function summarize(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p90: pct(s, 90), p99: pct(s, 99), max: s.at(-1) ?? NaN };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newRunId = (arm: Arm, what: string) => `${what}-${arm}-${randomUUID().slice(0, 8)}`;
const r1 = (x: number) => Math.round(x * 10) / 10;

// ── Latency: one client, one call at a time ──────────────────────────────────────────────────

async function latency(arm: Arm, workload: Workload) {
  const runId = newRunId(arm, `lat-${workload}`);
  const [client] = await connectMany(arm, runId, 1);
  try {
    for (let i = 0; i < 30; i++) await client.call(workload, i);
    const samples: number[] = [];
    for (let i = 0; i < LATENCY_CALLS; i++) {
      const t = performance.now();
      await client.call(workload, i);
      samples.push(performance.now() - t);
    }
    return { arm, workload, runId, ...summarize(samples) };
  } finally {
    closeAll([client]);
  }
}

// ── Throughput: M clients, one call in flight each, closed loop ─────────────────────────────

async function throughput(arm: Arm, workload: Workload, M: number) {
  const runId = newRunId(arm, `tp-${workload}-${M}`);
  const clients = await connectMany(arm, runId, M);
  try {
    await Promise.all(clients.map((c) => c.call(workload, 0))); // wake every path once
    const start = performance.now();
    const windowStart = start + WARMUP_S * 1000;
    const windowEnd = windowStart + WINDOW_S * 1000;
    let completions = 0;
    let errors = 0;
    const errorKinds = new Map<string, number>();
    const dropsBefore = socketDrops;
    const lat: number[] = [];
    await Promise.all(clients.map(async (c, ci) => {
      let i = 0;
      while (performance.now() < windowEnd) {
        const t = performance.now();
        try {
          await c.call(workload, ci * 1_000_000 + i++);
          const done = performance.now();
          if (done >= windowStart && done < windowEnd) { completions++; lat.push(done - t); }
        } catch (e) {
          errors++;
          const kind = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 160);
          errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
        }
      }
    }));
    return {
      arm, workload, M, runId, perSec: r1(completions / WINDOW_S), errors,
      errorKinds: Object.fromEntries(errorKinds), socketDrops: socketDrops - dropsBefore, latency: summarize(lat),
    };
  } finally {
    closeAll(clients);
  }
}

// ── Broadcast: one publisher, N subscribers, time to each delivery ──────────────────────────

async function waitForArrivals(seq: number, n: number, timeoutMs: number): Promise<number[]> {
  const deadline = performance.now() + timeoutMs;
  while ((arrivals.get(seq)?.length ?? 0) < n && performance.now() < deadline) await sleep(2);
  return arrivals.get(seq) ?? [];
}

let seqCounter = 0;
async function broadcast(arm: Arm, N: number) {
  const runId = newRunId(arm, `bc-${N}`);
  const [publisher] = await connectMany(arm, runId, 1);
  const subscribers = await connectMany(arm, runId, N);
  try {
    for (let i = 0; i < N; i += CONNECT_BATCH) {
      await Promise.all(subscribers.slice(i, i + CONNECT_BATCH).map((s) => s.call('subscribe')));
    }
    const warm = ++seqCounter;
    await publisher.call('publish', warm);
    await waitForArrivals(warm, N, 30_000);

    const runs: Array<ReturnType<typeof summarize> & { delivered: number; publishMs: number }> = [];
    for (let k = 0; k < BROADCAST_PUBLISHES; k++) {
      await sleep(1000);
      const seq = ++seqCounter;
      const t0 = performance.now();
      const published = publisher.call('publish', seq).then(() => performance.now());
      const got = await waitForArrivals(seq, N, 30_000);
      const publishMs = (await published) - t0;
      runs.push({ ...summarize(got.map((t) => t - t0)), delivered: got.length, publishMs });
    }
    const all = (key: 'p50' | 'p99' | 'max') => summarize(runs.map((r) => r[key])).p50;
    return {
      arm, N, runId,
      p50: r1(all('p50')), p99: r1(all('p99')), max: r1(all('max')),
      minDelivered: Math.min(...runs.map((r) => r.delivered)),
      runs,
    };
  } finally {
    closeAll([publisher, ...subscribers]);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const which = process.argv[2] ?? 'all';
  if (!BENCH_TOKEN) throw new Error('Set BENCH_TOKEN to the secret the deployed Worker holds');
  const health = await fetch(`${BASE}/health`).then((r) => r.text()).catch((e) => String(e));
  console.log(`target ${BASE} — health: ${health} — sub ${SUB}`);

  // Fidelity check, every run: both arms must refuse a method without `@mesh()`, which shows the
  // hosted arm runs the same entry check as the Gateway's target rather than calling methods bare.
  for (const arm of ARMS) {
    const [c] = await connectMany(arm, newRunId(arm, 'guard'), 1);
    const refused = await c.call('onPushResult').then(() => false, (e: Error) => /mesh/i.test(e.message));
    closeAll([c]);
    console.log(`guard ${arm}: undecorated method refused = ${refused}`);
    if (!refused) throw new Error(`${arm} ran a method without @mesh() — the arms are not comparable`);
  }

  const out: Record<string, unknown[]> = { latency: [], throughput: [], broadcast: [] };
  for (let round = 0; round < ROUNDS; round++) {
    const arms = round % 2 === 0 ? ARMS : [...ARMS].reverse();
    if (which === 'latency' || which === 'all') {
      for (const workload of WORKLOADS) for (const arm of arms) {
        const r = await latency(arm, workload);
        console.log(`[r${round}] latency ${workload} ${arm}: p50 ${r1(r.p50)} p90 ${r1(r.p90)} p99 ${r1(r.p99)} ms`);
        out.latency.push({ round, ...r });
      }
    }
    if (which === 'throughput' || which === 'all') {
      for (const workload of WORKLOADS) for (const M of THROUGHPUT_M) for (const arm of arms) {
        const r = await throughput(arm, workload, M);
        console.log(`[r${round}] throughput ${workload} M=${M} ${arm}: ${r.perSec}/s (errors ${r.errors}, drops ${r.socketDrops}, p50 ${r1(r.latency.p50)} ms)`);
        for (const [kind, n] of Object.entries(r.errorKinds)) console.log(`    ${n}× ${kind}`);
        out.throughput.push({ round, ...r });
        await sleep(2000);
      }
    }
    if (which === 'broadcast' || which === 'all') {
      for (const N of BROADCAST_N) for (const arm of arms) {
        const r = await broadcast(arm, N);
        console.log(`[r${round}] broadcast N=${N} ${arm}: p50 ${r.p50} p99 ${r.p99} max ${r.max} ms (min delivered ${r.minDelivered}/${N})`);
        out.broadcast.push({ round, ...r });
        await sleep(2000);
      }
    }
  }

  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const venue = BASE.includes('localhost') || BASE.includes('127.0.0.1') ? 'local' : 'deployed';
  const file = new URL(`../results/raw-${venue}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ base: BASE, which, rounds: ROUNDS, windowS: WINDOW_S, ...out }, null, 2));
  console.log(`raw → ${file.pathname}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
