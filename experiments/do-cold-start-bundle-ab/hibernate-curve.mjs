/**
 * Hibernate-wake cost vs. bundle size — mapping the SHAPE of the curve.
 *
 * WHY. We know post-idle wake cost rises with bundle size (RESULTS.md), but from only two
 * points 91x apart. That's enough to say "smaller is better" and not enough to say HOW small a
 * hot path must be — proportional means any trimming pays off incrementally; a threshold means
 * what matters is getting under it. That distinction decides how aggressively to split the
 * Nebula worker, so it's worth six real points instead of two.
 *
 * MEASURE: end-to-end round trip of `echo` from this client. No decomposition — we're mapping a
 * curve, not attributing one number, and end-to-end is what a user actually feels. `warm` is
 * captured per arm as the network+dispatch floor, so `hibernate - warm` strips the baseline out
 * if conditions drift between arms.
 *
 * ABORT IS DROPPED. `ctx.abort()` leaves the isolate resident, so it modeled neither a redeploy
 * (new script version => every old isolate retired) nor idle eviction. It served its diagnostic
 * purpose and is gone.
 *
 * DESIGN. All arms run in LOCKSTEP within a round, so ONE idle wait serves all six and CF-side
 * drift hits every arm equally. Arm order ROTATES each round so none is systematically first.
 * The DO returns isolate/instance ids so lifecycle state is OBSERVED, not inferred from timing.
 *
 * RUN:  node hibernate-curve.mjs      (~5 min at defaults: 10 rounds x 20 s idle)
 */

const ARMS = [
  { id: 'mesh', kib: 130.8, note: 'baseline (mesh only)' },
  { id: 'auth', kib: 217.9, note: '@lumenize/nebula-auth' },
  { id: 'shell', kib: 240.7, note: '@cloudflare/shell' },
  { id: 'git', kib: 683.7, note: 'isomorphic-git' },
  { id: 'nebula-lite', kib: 2704.3, note: 'nebula MINUS validator (post-refactor shape)' },
  { id: 'validator', kib: 9241.3, note: 'ts-runtime-parser-validator (tsc)' },
  { id: 'nebula', kib: 11826.6, note: 'full @lumenize/nebula barrel' },
];

const urlFor = (id) => process.env[`URL_${id.toUpperCase()}`] ?? `https://do-cs-${id}.transformation.workers.dev`;
const ROUNDS = Number(process.env.ROUNDS ?? 10);
const IDLE_MS = Number(process.env.IDLE_MS ?? 20_000);
const STATES = ['create', 'warm', 'hibernate'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hit(id, name) {
  const t0 = performance.now();
  const res = await fetch(`${urlFor(id)}/echo?name=${encodeURIComponent(name)}`);
  const text = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${id} → ${res.status}: ${text.slice(0, 160)}`);
  const b = JSON.parse(text);
  return { ms, isolateId: b.value.isolateId, instanceId: b.value.instanceId };
}

function classify(prev, now) {
  if (!prev) return 'create';
  const sameIso = prev.isolateId === now.isolateId;
  const sameInst = prev.instanceId === now.instanceId;
  if (sameIso && sameInst) return 'resident';
  if (sameIso) return 'do-rebuilt';
  return 'isolate-rebuilt';
}

const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs) => xs.reduce((a, v) => a + v, 0) / xs.length;
const f = (n) => n.toFixed(1).padStart(9);

async function main() {
  const t = {};
  const v = {};
  for (const a of ARMS) {
    t[a.id] = Object.fromEntries(STATES.map((s) => [s, []]));
    v[a.id] = {};
  }

  // Preheat is NOT measured, and a freshly-deployed worker can 500 while it propagates.
  // Swallow failures here only; every measured phase stays strict.
  for (let i = 0; i < 3; i++) {
    for (const a of ARMS) {
      try {
        await hit(a.id, 'preheat');
      } catch { /* propagation race — not measured, ignore */ }
    }
  }

  for (let round = 0; round < ROUNDS; round++) {
    const uid = crypto.randomUUID().slice(0, 8);
    const prev = {};
    // Rotate so no arm is systematically measured first.
    const shift = round % ARMS.length;
    const order = [...ARMS.slice(shift), ...ARMS.slice(0, shift)];

    const all = async (state) => {
      for (const a of order) {
        const obs = await hit(a.id, `hc-${uid}-${a.id}`);
        t[a.id][state].push(obs.ms);
        if (state === 'hibernate') {
          const c = classify(prev[a.id], obs);
          v[a.id][c] = (v[a.id][c] ?? 0) + 1;
        }
        prev[a.id] = obs;
      }
    };

    await all('create');
    await all('warm');
    process.stdout.write(`round ${round + 1}/${ROUNDS}: idling ${IDLE_MS / 1000}s...`);
    await sleep(IDLE_MS);
    await all('hibernate');
    process.stdout.write(' done\n');
  }

  console.log(`\n=========== hibernate-wake vs bundle size (n=${ROUNDS}, ${IDLE_MS / 1000}s idle) ===========`);
  console.log(`arm         |    KiB |  create |    warm | hibernate | hib-warm | observed`);
  console.log(`------------+--------+---------+---------+-----------+----------+---------`);
  for (const a of ARMS) {
    const c = p50(t[a.id].create);
    const w = p50(t[a.id].warm);
    const h = p50(t[a.id].hibernate);
    const verdicts = Object.entries(v[a.id]).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}x${n}`).join(' ');
    console.log(
      `${a.id.padEnd(11)} |${a.kib.toFixed(0).padStart(7)} |${f(c)}|${f(w)}|${f(h)}|${f(h - w)}| ${verdicts}`,
    );
  }
  console.log(`
All p50, end-to-end round trip from this client.
  hib-warm  = wake cost with the network/dispatch floor removed
  observed  = what the isolate/instance ids say actually happened on the hibernate call
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
