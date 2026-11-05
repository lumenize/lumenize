#!/usr/bin/env node
/**
 * Summarizes experiment-do-read-cache result files: node scripts/analyze.mjs results/<file>.json …
 *
 * clock      what the object's own clock said a read took, against the runtime's record of it.
 * records    one 10-field record per read, per condition: CPU per read, and waiting per read
 *            (wall minus CPU, net of the adjacent ping's), each object's median then across objects.
 * sweep      per-read cost against working set, per api: µs per read net of the adjacent ping, and
 *            its ratio to the same object's smallest working sets. Fits the knee: flat to C rows,
 *            then h + (m − h)(1 − C/n), which is what random passes over n rows through an LRU of
 *            C pages give.
 * abort      the first pass after ctx.abort() against the next pass, paired on the same object.
 * idle-check the first pass after hours idle, against the pass after it.
 *
 * CLOCK picks the timing. `wall` and `cpu` are the invocation's wallTimeMs and cpuTimeMs from Workers
 * Logs (after scripts/logs.mjs); `worker` is the Worker's bracket around the call, counted only when
 * every call in a record ran in a Worker in the object's own colo, since a Worker elsewhere adds its
 * round trip. Default: `wall` for a deployed run, `worker` for a local one, where it is real time.
 */
import { readFileSync } from 'node:fs';

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length);
/** 95% bootstrap interval of the median. */
function ciMedian(xs, n = 2000) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 3) return [NaN, NaN];
  const meds = [];
  for (let i = 0; i < n; i++) meds.push(median(Array.from(v, () => v[Math.floor(Math.random() * v.length)])));
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(n * 0.025)], meds[Math.floor(n * 0.975)]];
}
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const groupBy = (xs, key) => {
  const m = new Map();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};
const ROW_BYTES = 3500;
const callsOf = (r) => Object.values(r).filter((v) => v && typeof v === 'object' && 'seq' in v);

/** The chosen clock's milliseconds for one call, or NaN when it has none. */
function clockOf(out) {
  const clock = process.env.CLOCK ?? (out.local ? 'worker' : 'wall');
  const ms = {
    worker: (c) => c.workerMs,
    wall: (c) => c.logs?.wallMs ?? NaN,
    cpu: (c) => c.logs?.cpuMs ?? NaN,
  }[clock];
  if (!ms) throw new Error(`CLOCK must be worker, wall or cpu, not ${clock}`);
  return { clock, ms };
}

/** The records the clock can time: all of them, except with `worker`, only the same-colo ones. */
function usable(out, clock) {
  if (clock !== 'worker' || out.local) return out.records;
  const colo = new Map(out.objects.map((o, i) => [i, o.colo]));
  const kept = out.records.filter((r) => callsOf(r).every((c) => !c.workerColo || c.workerColo === colo.get(r.object)));
  console.log(`worker clock: kept ${kept.length}/${out.records.length} records whose Workers ran in the object's colo`);
  return kept;
}

function clockArm(out) {
  console.log(`object colo ${out.objects[0]?.colo}`);
  console.log('reads  frozenMs  timerMs  ioMs  workerMs (colo)  logs wall  cpu');
  for (const r of out.records) {
    const c = r.clock;
    console.log(`${String(c.reads).padStart(5)}  ${String(c.frozenMs).padStart(8)}  ${String(c.timerMs).padStart(7)}  ${String(c.ioMs).padStart(4)}  ` +
      `${String(c.workerMs).padStart(8)} (${c.workerColo})  ${String(c.logs?.wallMs ?? '—').padStart(9)}  ${c.logs?.cpuMs ?? '—'}`);
  }
}

function recordsArm(out) {
  const colos = [...new Set(out.objects.map((o) => o.colo))].join(', ');
  const usableRecs = out.records.filter((r) => r.read.logs && r.ping.logs && !r.read.built);
  console.log(`objects ${out.objects.length} (${colos}), rounds ${out.config.ROUNDS}; ${usableRecs.length}/${out.records.length} records timed by Workers Logs`);
  const per = (r, ms) => (ms / r.read.reads) * 1000; // µs per read
  const cpu = (r) => per(r, r.read.logs.cpuMs - r.ping.logs.cpuMs);
  const wait = (r) => per(r, (r.read.logs.wallMs - r.read.logs.cpuMs) - (r.ping.logs.wallMs - r.ping.logs.cpuMs));
  const range = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? `${f(v[0], 3)}–${f(v.at(-1), 3)}` : '—'; };
  console.log('\ncondition                    CPU µs/read (median, objects' + "'" + ' range)     waiting µs/read');
  for (const c of out.config.REC_CONDITIONS) {
    const mine = usableRecs.filter((r) => r.label === c.label);
    const objs = [...new Set(mine.map((r) => r.object))];
    const cpuMed = objs.map((o) => median(mine.filter((r) => r.object === o).map(cpu)));
    const waitMed = objs.map((o) => median(mine.filter((r) => r.object === o).map(wait)));
    console.log(`${c.label.padEnd(28)} ${f(median(cpuMed), 3).padStart(8)}  (${range(cpuMed)})`.padEnd(66) + `${f(median(waitMed), 2).padStart(7)}`);
  }
}

function sweep(out) {
  const { clock, ms } = clockOf(out);
  const recs = usable(out, clock);
  const perRead = (r) => ((ms(r.read) - ms(r.ping)) / r.read.reads) * 1000;
  const colos = [...new Set(out.objects.map((o) => o.colo))].join(', ');
  const timed = recs.filter((r) => Number.isFinite(perRead(r))).length;
  console.log(`objects ${out.objects.length} (${colos}), rounds ${out.config.ROUNDS}, ~${out.config.TARGET_READS} reads per timed call; clock ${clock}, ${timed}/${recs.length} records timed`);
  const withLogs = recs.filter((r) => r.read.logs && r.ping.logs);
  if (withLogs.length) {
    console.log(`CPU share of a read's wall time: median ${f(median(withLogs.map((r) => r.read.logs.cpuMs / Math.max(1, r.read.logs.wallMs))) * 100, 0)}% over ${withLogs.length} reads`);
  }
  for (const api of ['sql', 'kv']) {
    const mine = recs.filter((r) => r.api === api);
    // Per object: the median over rounds at each size, then the ratio to its own hot plateau.
    const objMed = new Map([...groupBy(mine, (r) => `${r.object}|${r.rows}`)].map(([k, rs]) => [k, median(rs.map(perRead))]));
    const objects = [...new Set(mine.map((r) => r.object))];
    const hot = new Map(objects.map((o) => [o, median([64, 128].map((rows) => objMed.get(`${o}|${rows}`)))]));
    console.log(`\n${api}: µs per read net of ping, median across objects of each object's median`);
    console.log('   rows    MB   µs/read  95% CI            ×hot   95% CI        wall µs  cpu µs');
    const sizes = [...new Set(mine.map((r) => r.rows))].sort((a, b) => a - b);
    const points = [];
    for (const rows of sizes) {
      const abs = objects.map((o) => objMed.get(`${o}|${rows}`));
      const ratio = objects.map((o) => objMed.get(`${o}|${rows}`) / hot.get(o));
      const logged = mine.filter((r) => r.rows === rows && r.read.logs && r.ping.logs);
      const wall = median(logged.map((r) => ((r.read.logs.wallMs - r.ping.logs.wallMs) / r.read.reads) * 1000));
      const cpu = median(logged.map((r) => ((r.read.logs.cpuMs - r.ping.logs.cpuMs) / r.read.reads) * 1000));
      const [alo, ahi] = ciMedian(abs);
      const [rlo, rhi] = ciMedian(ratio);
      points.push({ rows, us: median(abs) });
      console.log(`${String(rows).padStart(7)} ${f((rows * ROW_BYTES) / 1e6, 1).padStart(5)}  ${f(median(abs)).padStart(7)}  [${f(alo)}, ${f(ahi)}]`.padEnd(48) +
        `${f(median(ratio)).padStart(5)}  [${f(rlo)}, ${f(rhi)}]`.padEnd(22) + `${f(wall).padStart(7)}  ${f(cpu).padStart(6)}`);
    }
    const fit = fitKnee(points);
    if (fit) console.log(`knee fit: flat at ${f(fit.h)} µs to C ≈ ${fit.C} rows, approaching ${f(fit.m)} µs (rms ${f(fit.rms, 3)})`);
  }
}

/** Least-squares fit of t(n) = h for n ≤ C, h + (m − h)(1 − C/n) above, by grid search on C. */
function fitKnee(points) {
  const pts = points.filter((p) => Number.isFinite(p.us));
  if (pts.length < 4) return undefined;
  let best;
  for (let C = 32; C <= 8192; C += 4) {
    // Linear in (h, m) for fixed C: t = h·(1 − x) + m·x with x = max(0, 1 − C/n).
    let sxx = 0, sx1 = 0, s11 = 0, sxt = 0, s1t = 0;
    for (const { rows, us } of pts) {
      const x = Math.max(0, 1 - C / rows);
      const a = 1 - x;
      sxx += x * x; sx1 += x * a; s11 += a * a; sxt += x * us; s1t += a * us;
    }
    const det = s11 * sxx - sx1 * sx1;
    if (Math.abs(det) < 1e-12) continue;
    const h = (s1t * sxx - sxt * sx1) / det;
    const m = (s11 * sxt - sx1 * s1t) / det;
    const rms = Math.sqrt(mean(pts.map(({ rows, us }) => {
      const x = Math.max(0, 1 - C / rows);
      return (h * (1 - x) + m * x - us) ** 2;
    })));
    if (!best || rms < best.rms) best = { C, h, m, rms };
  }
  return best;
}

function abort(out) {
  const { clock, ms } = clockOf(out);
  const recs = usable(out, clock);
  const colos = [...new Set(out.objects.map((o) => o.colo))].join(', ');
  console.log(`objects ${out.objects.length} (${colos}), cycles ${out.config.CYCLES}, clock ${clock}`);
  console.log(`abort reset the object (new bootId) in ${recs.filter((r) => r.reset).length}/${recs.length} cycles`);
  const pingWall = recs.filter((r) => r.ping.logs).map((r) => r.ping.logs.wallMs);
  console.log(`first call after abort (builds the object): Worker ${f(median(recs.map((r) => r.ping.workerMs)), 1)} ms median, object wall ${f(median(pingWall), 1)} ms`);
  console.log('\napi   rows    MB  cold ms  warm ms  cold−warm ms (mean ± SE, n)    extra µs/row  ×warm  cpu cold/warm µs/row');
  const groups = [...groupBy(recs.filter((r) => r.reset), (r) => `${r.api}|${r.rows}`)].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, all] of groups) {
    const [api, rowsText] = key.split('|');
    const rows = Number(rowsText);
    const rs = all.filter((r) => Number.isFinite(ms(r.cold)) && Number.isFinite(ms(r.warm)));
    const diffs = rs.map((r) => ms(r.cold) - ms(r.warm));
    const ratio = median(rs.filter((r) => ms(r.warm) > 0).map((r) => ms(r.cold) / ms(r.warm)));
    const t = rs.filter((r) => r.cold.logs && r.warm.logs);
    const cpu = (side) => median(t.map((r) => (r[side].logs.cpuMs / rows) * 1000));
    console.log(`${api.padEnd(4)} ${String(rows).padStart(6)} ${f((rows * ROW_BYTES) / 1e6, 1).padStart(5)}  ` +
      `${f(median(rs.map((r) => ms(r.cold))), 1).padStart(7)}  ${f(median(rs.map((r) => ms(r.warm))), 1).padStart(7)}  ` +
      `${`${f(mean(diffs), 2)} ± ${f(se(diffs), 2)}, ${rs.length}`.padStart(22)}        ${f((mean(diffs) / rows) * 1000).padStart(8)}  ${f(ratio).padStart(5)}  ` +
      `${t.length ? `${f(cpu('cold'))} / ${f(cpu('warm'))}` : '—'}`);
  }
}

function idle(out) {
  const { clock, ms } = clockOf(out);
  console.log(`clock ${clock}`);
  console.log('object  idle min  first call ms (Worker / object wall)  api  cold ms  warm ms  extra µs/row  cold cpu ms');
  for (const r of out.records) {
    for (const api of r.order) {
      const cold = r[`cold_${api}`];
      const warm = r[`warm_${api}`];
      console.log(`${String(r.object).padStart(6)}  ${String(r.idleMinutes).padStart(8)}  ${`${r.ping.workerMs} / ${r.ping.logs?.wallMs ?? '—'}`.padStart(36)}  ` +
        `${api.padEnd(4)} ${f(ms(cold), 0).padStart(7)}  ${f(ms(warm), 0).padStart(7)}  ${f(((ms(cold) - ms(warm)) / cold.reads) * 1000).padStart(12)}  ${cold.logs?.cpuMs ?? '—'}`);
    }
  }
}

const handlers = { clock: clockArm, records: recordsArm, sweep, abort, 'idle-check': idle };
for (const file of process.argv.slice(2)) {
  const out = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n=== ${file}\n${out.mode}, ${out.local ? 'local' : 'deployed'} (${out.base}), started ${out.startedAt}`);
  handlers[out.mode]?.(out);
}
