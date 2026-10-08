/**
 * Driver for experiment-do-placement-probe. Every colo comes from Cloudflare's trace endpoint,
 * read by the Worker invocation or object being located.
 *
 *   BENCH_BASE_URL=https://experiment-do-placement-probe.<account>.workers.dev BENCH_TOKEN=… \
 *     node scripts/probe.mjs
 *
 * 1. local   — the Worker at this machine's PoP first-touches fresh names.
 * 2. anchors — one anchor per locationHint region; from each, fresh names are first-touched over a
 *              service binding (a host node relaying to the facade) and over a public fetch (a
 *              browser in that region).
 * 3. replace — a name first touched far away is wiped, then touched from here: does it move?
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = (process.env.BENCH_BASE_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.BENCH_TOKEN ?? '';
const HINTS = (process.env.HINTS ?? 'wnam,enam,sam,weur,eeur,apac,oc,afr,me').split(',');
const PER_ANCHOR = Number(process.env.PER_ANCHOR ?? 2);
const rand = () => randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-bench-token': TOKEN } });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, text: text.slice(0, 200) }; }
}

async function main() {
  if (!BASE || !TOKEN) throw new Error('Set BENCH_BASE_URL and BENCH_TOKEN');
  const out = { local: [], anchors: [], replace: [] };

  const ONLY = process.env.ONLY ?? '';
  if (!ONLY || ONLY === 'local') {
  console.log('== 1. local first touch');
  for (let i = 0; i < 6; i++) {
    const r = await get(`/local/local-${rand()}`);
    out.local.push(r);
    console.log(`  worker ${r.workerColo} → object ${r.targetColo}`);
  }

  }
  if (!ONLY || ONLY === 'anchors') {
  console.log('== 2. anchors');
  for (const hint of HINTS) {
    const anchor = `anchor-${hint}-${rand()}`;
    const a = await get(`/anchor/${anchor}?hint=${hint}`);
    const row = { hint, anchorColo: a.colo, binding: [], fetch: [] };
    for (let i = 0; i < PER_ANCHOR; i++) {
      const viaB = await get(`/from-anchor/${anchor}/viab-${hint}-${rand()}?via=binding`);
      row.binding.push(viaB.result ?? viaB);
      const viaF = await get(`/from-anchor/${anchor}/viaf-${hint}-${rand()}?via=fetch`);
      row.fetch.push(viaF.result ?? viaF);
    }
    out.anchors.push(row);
    const fmt = (xs) => xs.map((x) => `${x.workerColo}→${x.targetColo}`).join(' ');
    console.log(`  ${hint.padEnd(4)} anchor ${a.colo}: binding ${fmt(row.binding)} | fetch ${fmt(row.fetch)}`);
  }

  }
  if (!ONLY || ONLY === 'replace') {
  console.log('== 3. replace after wipe');
  const IDLE_MS = Number(process.env.IDLE_MS ?? 180_000);
  for (const hint of ['apac', 'oc', 'weur']) {
    for (const reset of [true, false]) {
      const anchor = `ranchor-${hint}-${rand()}`;
      await get(`/anchor/${anchor}?hint=${hint}`);
      const target = `replace-${hint}-${reset ? 'reset' : 'idle'}-${rand()}`;
      const first = await get(`/from-anchor/${anchor}/${target}?via=binding`);
      // An existing object is not moved by being touched, so reading its boot id from here is safe.
      const before = await get(`/local/${target}`);
      await get(`/mark/${target}?v=first-life`);
      const wipe = await get(`/wipe/${target}?reset=${reset ? 1 : 0}`);
      // A reset object is gone at once; an unreset one has to sit idle long enough to be evicted.
      await sleep(reset ? 5_000 : IDLE_MS);
      const after = await get(`/local/${target}`);
      const row = {
        hint, reset, firstColo: first.result?.targetColo, bootBefore: before.bootId, wipe,
        afterColo: after.targetColo, afterWorker: after.workerColo, bootAfter: after.bootId, markAfter: after.mark,
      };
      out.replace.push(row);
      console.log(`  ${hint} ${reset ? 'reset' : 'idle '}: first life ${row.firstColo} (boot ${row.bootBefore}), after wipe touched from ${row.afterWorker} → ${row.afterColo} (boot ${row.bootAfter}, mark ${row.markAfter})`);
    }
  }

  }

  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const file = new URL(`../results/placement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`raw → ${file.pathname}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
