#!/usr/bin/env node
/**
 * Driver for experiment-merge-patch-sql. RESULTS.md has the question, the design and the findings.
 *
 *   BASE=https://experiment-merge-patch-sql.<account>.workers.dev node scripts/probe.mjs
 *   node scripts/logs.mjs results/<file>.json      # joins Workers Logs cpuTimeMs/wallTimeMs
 *   node scripts/analyze.mjs results/<file>.json
 *
 * Deployed only: the object's own clock cannot time synchronous work, and Workers Logs, which can,
 * exists only deployed. The token is BENCH_TOKEN in this experiment's .dev.vars, never printed.
 *
 * Knobs (env): NS (comma list of tree sizes), MUTATIONS, OPS (apply,applyRead,diff,part),
 * OBJECTS (objects per condition), ROUNDS, TARGET_MS (work per timed call), MAX_REP_MS (an arm
 * slower than this per rep is recorded as too slow and not timed).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(DIR, 'results');
const BASE = process.env.BASE?.replace(/\/$/, '');
if (!BASE || /localhost|127\.0\.0\.1/.test(BASE)) throw new Error('set BASE to the deployed URL: this experiment runs deployed only');
const TOKEN = /^BENCH_TOKEN=(.+)$/m.exec(readFileSync(join(DIR, '.dev.vars'), 'utf8'))?.[1].trim();
if (!TOKEN) throw new Error('BENCH_TOKEN is missing from experiments/merge-patch-sql/.dev.vars');

const list = (k, d) => (process.env[k] ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const num = (k, d) => Number(process.env[k] ?? d);
const NS = list('NS', '100,1000,10000').map(Number);
const MUTATIONS = list('MUTATIONS', 'move');
const OPS = list('OPS', 'apply,applyRead,diff,part');
const OBJECTS = num('OBJECTS', 2);
const ROUNDS = num('ROUNDS', 3);
const TARGET_MS = num('TARGET_MS', 150);
const MAX_REP_MS = num('MAX_REP_MS', 4000);
const MAX_REPS = 20_000;

/** Mirrors ARMS in src/index.ts. */
const ARMS = {
  apply: ['js', 'jsb', 'sql', 'sqlb'],
  applyRead: ['sql', 'sqlb'],
  diff: ['js', 'jsb', 'sqltree', 'sqlwalk', 'sqlbtree', 'sqlbwalk'],
  part: ['read', 'readb', 'parse', 'stringify', 'jsapply', 'jsdiff', 'write', 'sqlpatch', 'sqlbpatch', 'sqltree'],
};

const run = new Date().toISOString().replace(/[:.]/g, '-');
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Every call carries a seq, so each object invocation is numbered in the order the driver made it
// (scripts/logs.mjs relies on that to place an invocation whose line Workers Logs dropped). Seqs
// start from the run's start time, so two runs' lines can never share one in a join's window.
let seq = Date.now() * 1000;
async function op(instance, params) {
  const s = ++seq;
  const qs = new URLSearchParams({ ...params, seq: String(s) });
  const res = await fetch(`${BASE}/op/${instance}?${qs}`, { headers: { 'x-bench-token': TOKEN } });
  const body = await res.text();
  if (!res.ok) return { seq: s, error: `${res.status} ${body.slice(0, 200)}` };
  return { seq: s, ...JSON.parse(body) };
}
const pick = (r) => ({ seq: r.seq, workerMs: r.workerMs, workerColo: r.workerColo, reps: r.reps, check: r.check, error: r.error });

const out = {
  run, base: BASE, startedAt: new Date().toISOString(),
  config: { NS, MUTATIONS, OPS, OBJECTS, ROUNDS, TARGET_MS, MAX_REP_MS },
  objects: [], skipped: [], records: [],
};
function save() {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `run-${run}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  return file;
}

/**
 * reps that make one call about TARGET_MS of work. The Worker's clock is all the driver has before
 * the logs arrive, and a few ms of round-trip jitter swamps a small call, so reps grow ×8 until the
 * call clearly outweighs its ping, and only then scale to the target. Never more than ×8 a step,
 * so one noisy reading cannot ask for a call past the object's CPU limit.
 */
async function calibrate(instance, what, arm) {
  let reps = 1;
  for (let step = 0; step < 8; step++) {
    const ping = await op(instance, { op: 'ping' });
    const r = await op(instance, { op: 'run', what, arm, reps });
    if (r.error) return { error: r.error };
    const work = r.workerMs - ping.workerMs;
    if (reps === 1 && work > MAX_REP_MS) return { error: `${work} ms for one rep` };
    if (work < 40) {
      if (reps >= MAX_REPS) return { reps };
      reps = Math.min(MAX_REPS, reps * 8);
      continue;
    }
    return { reps: Math.min(MAX_REPS, reps * 8, Math.max(1, Math.round((reps * TARGET_MS) / work))) };
  }
  return { reps };
}

try {
  for (const n of NS) {
    for (const mutation of MUTATIONS) {
      for (let o = 0; o < OBJECTS; o++) {
        const instance = `${run}-${n}-${mutation}-${o}`;
        const info = await op(instance, { op: 'setup', n, mutation });
        if (info.error) throw new Error(`setup ${instance}: ${info.error}`);
        const verify = await op(instance, { op: 'verify' });
        if (verify.error) throw new Error(`verify ${instance}: ${verify.error}`);
        const wrong = Object.entries(verify).filter(([k, v]) => k.includes('/') && v === false);
        if (wrong.length) throw new Error(`verify ${instance}: wrong answers from ${wrong.map(([k]) => k).join(', ')}`);
        const where = await op(instance, { op: 'colo' });
        out.objects.push({ instance, n, mutation, object: o, colo: where.colo, ...info, verify });
        console.log(`${instance}: ${info.textBytes} B text, ${info.jsonbBytes} B jsonb, patch ${info.patchBytes} B, colo ${where.colo}`);

        const conds = OPS.flatMap((what) => ARMS[what].map((arm) => ({ what, arm })));
        const reps = new Map();
        for (const c of conds) {
          const cal = await calibrate(instance, c.what, c.arm);
          if (cal.error) {
            out.skipped.push({ n, mutation, object: o, ...c, reason: cal.error });
            console.log(`  skip ${c.what}/${c.arm}: ${cal.error}`);
          } else reps.set(`${c.what}/${c.arm}`, cal.reps);
        }
        for (let round = 0; round < ROUNDS; round++) {
          for (const c of shuffle(conds)) {
            const r = reps.get(`${c.what}/${c.arm}`);
            if (!r) continue;
            await op(instance, { op: 'run', what: c.what, arm: c.arm, reps: 1 }); // warm this condition's pages
            const ping = await op(instance, { op: 'ping' });
            const timed = await op(instance, { op: 'run', what: c.what, arm: c.arm, reps: r });
            out.records.push({ n, mutation, object: o, round, ...c, reps: r, ping: pick(ping), run: pick(timed) });
          }
          const line = conds.filter((c) => c.what !== 'part' && reps.has(`${c.what}/${c.arm}`)).map((c) => {
            const rec = out.records.findLast((x) => x.object === o && x.n === n && x.mutation === mutation && x.what === c.what && x.arm === c.arm);
            return `${c.what}/${c.arm} ${((rec.run.workerMs - rec.ping.workerMs) / rec.reps).toFixed(2)}`;
          }).join('  ');
          console.log(`  round ${round} ms/rep (Worker clock, progress only): ${line}`);
        }
        await op(instance, { op: 'wipe' });
        save();
      }
    }
  }
} finally {
  out.finishedAt = new Date().toISOString();
  const file = save();
  console.log(`wrote ${file}\nthen: node scripts/logs.mjs ${file}`);
}
