/**
 * Driver for experiment-do-socket-drop-probe. Every timestamp is `performance.now()` here, in Node;
 * nothing is timed inside Cloudflare, where `Date.now()` is pinned within an invocation.
 *
 *   BENCH_BASE_URL=https://experiment-do-socket-drop-probe.<account>.workers.dev BENCH_TOKEN=… \
 *     node scripts/probe.mjs calibrate|jit|drop
 *
 * calibrate — on one instance, the cost of one call of each burn at several sizes.
 * jit       — on JIT_INSTANCES fresh instances, each burn at its ~3 ms size, side by side, plus
 *             the instance's colo. Separates "this instance's JIT is slow" from "this machine is".
 * drop      — the trigger matrix: each scenario on a fresh instance for DURATION_S, recording
 *             throughput over time, every client-side close (code, reason), every bootId seen,
 *             and the object's own record afterward (boot count, server-side close/error events).
 *
 * Sizes (env): SQL_N3, SQL_N30, SQL_N100, JSON_N3, JS_N (the gateway-vs-hosted loop, 2,000,000).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = (process.env.BENCH_BASE_URL ?? 'http://localhost:8797').replace(/\/$/, '');
const WSBASE = BASE.replace(/^http/, 'ws');
const TOKEN = process.env.BENCH_TOKEN ?? '';
const num = (k, d) => Number(process.env[k] ?? d);
const SQL_N3 = num('SQL_N3', 13_000);
const SQL_N30 = num('SQL_N30', 130_000);
const SQL_N100 = num('SQL_N100', 430_000);
const JSON_N3 = num('JSON_N3', 4);
const JS_N = num('JS_N', 2_000_000);
const DURATION_S = num('DURATION_S', 40);
const JIT_INSTANCES = num('JIT_INSTANCES', 12);
const rand = () => randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const r1 = (x) => Math.round(x * 10) / 10;

async function httpJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-bench-token': TOKEN } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** One socket to `instance`, with request/reply correlation and a record of its closes. */
function openSocket(instance, clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSBASE}/ws/${instance}/${clientId}`, ['bench', `bench.${TOKEN}`]);
    const pending = new Map();
    let nextId = 0;
    const sock = {
      ws, closes: [],
      get open() { return ws.readyState === WebSocket.OPEN; },
      send(kind, n, reps = 1) {
        const id = ++nextId;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(id); rej(new Error('timeout')); }, 30_000);
          pending.set(id, { res, rej, timer, t: performance.now() });
          ws.send(JSON.stringify({ id, kind, n, reps }));
        });
      },
    };
    ws.addEventListener('open', () => resolve(sock));
    ws.addEventListener('error', () => { if (ws.readyState !== WebSocket.OPEN) reject(new Error('ws connect error')); });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      p.res({ ...m, ms: performance.now() - p.t });
    });
    ws.addEventListener('close', (ev) => {
      sock.closes.push({ at: performance.now(), code: ev.code, reason: ev.reason });
      for (const p of pending.values()) { clearTimeout(p.timer); p.rej(new Error(`closed ${ev.code} ${ev.reason}`)); }
      pending.clear();
    });
  });
}

/** Per-call cost of a burn: median over `calls` of (burn × reps) minus echo, divided by reps. */
async function perCallMs(sock, kind, n, reps, calls) {
  const echo = [];
  const work = [];
  for (let i = 0; i < calls; i++) {
    echo.push((await sock.send('echo', 0)).ms);
    work.push((await sock.send(kind, n, reps)).ms);
  }
  return (median(work) - median(echo)) / reps;
}

async function calibrate() {
  const instance = `cal-${rand()}`;
  const where = await httpJson(`/where/${instance}`);
  const sock = await openSocket(instance, 'cal');
  for (let i = 0; i < 5; i++) await sock.send('json', 1);
  console.log(`calibrate on ${instance} (colo ${where.colo})`);
  const sweeps = { sql: [25_000, 50_000, 100_000, 300_000, 500_000], json: [1, 2, 4, 8], js: [500_000, 2_000_000] };
  const out = {};
  for (const [kind, ns] of Object.entries(sweeps)) {
    for (const n of ns) {
      const ms = await perCallMs(sock, kind, n, 5, 7);
      out[`${kind}:${n}`] = r1(ms);
      console.log(`  ${kind} n=${n}: ${r1(ms)} ms per call`);
    }
  }
  sock.ws.close(1000, 'done');
  return { instance, colo: where.colo, perCallMs: out };
}

async function jit() {
  const rows = [];
  for (let i = 0; i < JIT_INSTANCES; i++) {
    const instance = `jit-${rand()}`;
    const where = await httpJson(`/where/${instance}`);
    const sock = await openSocket(instance, 'jit');
    const row = { instance, colo: where.colo };
    const t0 = performance.now();
    try {
      // SQL and JSON first, so a reset during the JS step cannot hide them. JS runs 500k × 4 per
      // event: the same 2M iterations as gateway-vs-hosted's `heavy`, reported per 2M.
      for (let w = 0; w < 3; w++) { await sock.send('json', 1); await sock.send('sql', SQL_N3); }
      row.sql = r1(await perCallMs(sock, 'sql', SQL_N3, 5, 7));
      row.json = r1(await perCallMs(sock, 'json', JSON_N3, 5, 7));
      await sock.send('js', 500_000);
      row.js = r1(await perCallMs(sock, 'js', 500_000, 4, 7) * 4);
    } catch (e) {
      row.error = `${e.message} at ${r1((performance.now() - t0) / 1000)} s`;
    }
    sock.ws.close(1000, 'done');
    row.boots = (await httpJson(`/stats/${instance}`)).boots;
    console.log(`  ${row.instance} colo ${row.colo}: js(2M) ${row.js} ms · sql ${row.sql} ms · json ${row.json} ms · boots ${row.boots}${row.error ? ` · ${row.error}` : ''}`);
    rows.push(row);
  }
  return rows;
}

const SCENARIOS = {
  'ws16-sql30': { transport: 'ws', sockets: 16, inflight: 1, kind: 'sql', n: () => SQL_N30 },
  'rpc16-sql30': { transport: 'rpc', sockets: 16, inflight: 1, kind: 'sql', n: () => SQL_N30 },
  'ws1-sql30': { transport: 'ws', sockets: 1, inflight: 1, kind: 'sql', n: () => SQL_N30 },
  'ws1x16-sql30': { transport: 'ws', sockets: 1, inflight: 16, kind: 'sql', n: () => SQL_N30 },
  'ws16-sql3': { transport: 'ws', sockets: 16, inflight: 1, kind: 'sql', n: () => SQL_N3 },
  'ws16-sql100': { transport: 'ws', sockets: 16, inflight: 1, kind: 'sql', n: () => SQL_N100 },
  'ws16-js': { transport: 'ws', sockets: 16, inflight: 1, kind: 'js', n: () => JS_N },
  'rpc16-js': { transport: 'rpc', sockets: 16, inflight: 1, kind: 'js', n: () => JS_N },
  // One caller, one call at a time: no concurrency at all.
  'ws1-js': { transport: 'ws', sockets: 1, inflight: 1, kind: 'js', n: () => JS_N },
  'rpc1-js': { transport: 'rpc', sockets: 1, inflight: 1, kind: 'js', n: () => JS_N },
  'ws1-sql100': { transport: 'ws', sockets: 1, inflight: 1, kind: 'sql', n: () => SQL_N100 },
  // The same JS call, one every 250 ms: is sustained load part of the trigger?
  'ws1-js-paced': { transport: 'ws', sockets: 1, inflight: 1, kind: 'js', n: () => JS_N, paceMs: 250 },
};

async function scenario(name, givenInstance) {
  const s = SCENARIOS[name];
  const n = s.n();
  const instance = givenInstance ?? `drop-${name}-${rand()}`;
  const where = await httpJson(`/where/${instance}`);
  const t0 = performance.now();
  const end = t0 + DURATION_S * 1000;
  const bins = new Array(Math.ceil(DURATION_S / 2) + 1).fill(0);
  const bootIds = new Set();
  const errorKinds = {};
  let errors = 0;
  const note = (e) => { errors++; const k = String(e.message).slice(0, 80); errorKinds[k] = (errorKinds[k] ?? 0) + 1; };
  const done = (r) => { if (r.bootId) bootIds.add(r.bootId); bins[Math.floor((performance.now() - t0) / 2000)]++; };
  const allCloses = [];

  if (s.transport === 'ws') {
    await Promise.all(Array.from({ length: s.sockets }, async (_, si) => {
      let sock = await openSocket(instance, `c${si}`);
      let reopening;
      const ensureOpen = async () => {
        if (sock.open) return;
        reopening ??= (async () => {
          allCloses.push(...sock.closes.map((c) => ({ socket: si, atS: r1((c.at - t0) / 1000), code: c.code, reason: c.reason })));
          await sleep(250);
          sock = await openSocket(instance, `c${si}`);
        })().finally(() => { reopening = undefined; });
        await reopening;
      };
      await Promise.all(Array.from({ length: s.inflight }, async () => {
        while (performance.now() < end) {
          try {
            await ensureOpen();
            done(await sock.send(s.kind, n));
            if (s.paceMs) await sleep(s.paceMs);
          } catch (e) {
            note(e);
          }
        }
      }));
      allCloses.push(...sock.closes.map((c) => ({ socket: si, atS: r1((c.at - t0) / 1000), code: c.code, reason: c.reason })));
      sock.ws.close(1000, 'done');
    }));
  } else {
    await Promise.all(Array.from({ length: s.sockets * s.inflight }, async () => {
      while (performance.now() < end) {
        try {
          done(await httpJson(`/rpc/${instance}?kind=${s.kind}&n=${n}`));
          if (s.paceMs) await sleep(s.paceMs);
        } catch (e) {
          note(e);
        }
      }
    }));
  }

  await sleep(3000);
  const stats = await httpJson(`/stats/${instance}`);
  const closeCodes = {};
  for (const c of allCloses) { const k = `${c.code} ${c.reason}`; closeCodes[k] = (closeCodes[k] ?? 0) + 1; }
  const result = {
    name, instance, colo: where.colo, n, durationS: DURATION_S,
    perSecTimeline: bins.map((b) => r1(b / 2)),
    total: bins.reduce((a, b) => a + b, 0), errors, errorKinds,
    clientCloses: allCloses.filter((c) => c.code !== 1000 || c.reason !== 'done'),
    closeCodes, bootIdsSeen: bootIds.size, boots: stats.boots,
    serverEvents: stats.events.slice(0, 40),
  };
  const unexpected = result.clientCloses.length;
  console.log(`${name} (colo ${where.colo}, n=${n}): total ${result.total}, errors ${errors}, unexpected closes ${unexpected}, bootIds ${bootIds.size}, boots ${stats.boots}`);
  console.log(`   per s: ${result.perSecTimeline.join(' ')}`);
  if (unexpected) console.log(`   closes: ${JSON.stringify(closeCodes)} first at ${Math.min(...result.clientCloses.map((c) => c.atS))} s`);
  for (const [k, v] of Object.entries(errorKinds)) console.log(`   ${v}× ${k}`);
  const srv = stats.events.filter((e) => e.kind !== 'close' || !e.detail.includes('"code":1000'));
  for (const e of srv.slice(0, 8)) console.log(`   server ${e.at} ${e.kind} ${e.detail.slice(0, 140)}`);
  return result;
}

/**
 * Finds a fresh instance whose JS loop is in the wanted state, measured on a socket that is then
 * closed, so the scenario that follows runs in the same warm isolate. Slow = 2M iterations
 * over 15 ms; fast = under 8 ms (from `jit`: fast instances read 1–6 ms, slow ones 27–54 ms).
 */
async function hunt(want) {
  for (let tries = 1; tries <= 40; tries++) {
    const instance = `hunt-${want}-${rand()}`;
    const sock = await openSocket(instance, 'hunt');
    for (let w = 0; w < 2; w++) await sock.send('js', 500_000);
    const ms = (await perCallMs(sock, 'js', 500_000, 4, 5)) * 4;
    sock.ws.close(1000, 'done');
    if ((want === 'slow' && ms > 15) || (want === 'fast' && ms < 8)) return { instance, jsMs: r1(ms), tries };
  }
  throw new Error(`no ${want} instance in 40 tries`);
}

async function main() {
  const mode = process.argv[2] ?? 'drop';
  if (!TOKEN) throw new Error('Set BENCH_TOKEN');
  console.log(`target ${BASE} — health ${await (await fetch(`${BASE}/health`)).text()}`);
  let out;
  if (mode === 'calibrate') out = await calibrate();
  else if (mode === 'jit') out = await jit();
  else if (mode === 'hunt') {
    // HUNT_PLAN: comma list of scenario@state, e.g. "ws1-js@slow,rpc1-js@slow,ws1-js@fast"
    out = [];
    for (const step of (process.env.HUNT_PLAN ?? 'ws1-js@slow,rpc1-js@slow').split(',')) {
      const [name, want] = step.trim().split('@');
      const found = await hunt(want);
      console.log(`${want} instance ${found.instance}: js(2M) ${found.jsMs} ms after ${found.tries} tries`);
      out.push({ want, ...found, result: await scenario(name, found.instance) });
      await sleep(3000);
    }
  }
  else {
    const names = (process.env.SCENARIOS ?? Object.keys(SCENARIOS).join(',')).split(',').map((x) => x.trim());
    out = [];
    for (const name of names) { out.push(await scenario(name)); await sleep(3000); }
  }
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const file = new URL(`../results/${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ base: BASE, mode, out }, null, 2));
  console.log(`raw → ${file.pathname}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
