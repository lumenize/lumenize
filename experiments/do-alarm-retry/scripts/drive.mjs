#!/usr/bin/env node
// Arms one probe object per mode named on the command line, watches each one's attempt log until
// WAIT_S has passed, then writes everything to results/<run>.json and prints a summary.
//
//   node scripts/drive.mjs throw abort abort-noretry rearm-abort rearm-throw
//   WAIT_S=480 node scripts/drive.mjs cpu
//   node scripts/drive.mjs reset          # redeploys during the first REDEPLOYS attempts
//
// Run cpu, memory and reset ALONE: objects of one Worker can share an isolate, so a loop blocks
// its neighbours, a memory kill resets them, and a redeploy resets every object mid-handler.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'https://experiment-do-alarm-retry.transformation.workers.dev';
const WAIT_S = Number(process.env.WAIT_S ?? 300);
const REDEPLOYS = Number(process.env.REDEPLOYS ?? 2);
const WRANGLER = process.env.WRANGLER ?? new URL('../node_modules/.bin/wrangler', import.meta.url).pathname;
const modes = process.argv.slice(2);
if (!modes.length) throw new Error('name at least one mode');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = new Date().toISOString().replace(/[:.]/g, '-');
const startedAt = new Date().toISOString();

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const probes = [];
for (const mode of modes) {
  const name = `${mode}-${run}`;
  probes.push({ mode, name, ...(await get(`/arm?name=${name}&mode=${mode}`)), seen: 0, report: null });
}
console.log(`armed ${probes.map((p) => p.name).join(', ')}; watching ${WAIT_S} s`);

const redeployedFor = new Set();
const t0 = Date.now();
while (Date.now() - t0 < WAIT_S * 1000) {
  await sleep(5_000);
  for (const p of probes) {
    try { p.report = await get(`/report?name=${p.name}`); } catch (e) { console.log(`${p.mode}: report failed: ${e.message}`); continue; }
    for (const a of p.report.attempts.slice(p.seen)) {
      const after = ((Date.parse(a.firedAt) - Date.parse(p.armedAt)) / 1000).toFixed(1);
      console.log(`${p.mode.padEnd(13)} attempt ${a.seq} at +${after}s retryCount=${a.retryCount} isRetry=${a.isRetry}`);
    }
    p.seen = p.report.attempts.length;
    const last = p.report.attempts.at(-1);
    if (p.mode === 'reset' && last && !last.completedAt && last.seq <= REDEPLOYS && !redeployedFor.has(last.seq)) {
      redeployedFor.add(last.seq);
      await sleep(10_000);
      console.log(`reset: redeploying during attempt ${last.seq}`);
      execFileSync(WRANGLER, ['deploy'], { cwd: new URL('..', import.meta.url), stdio: 'ignore' });
      console.log(`reset: redeploy ${last.seq} done at +${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
}

for (const p of probes) p.report = await get(`/report?name=${p.name}`);
const finishedAt = new Date().toISOString();
writeFileSync(new URL(`../results/${run}.json`, import.meta.url), JSON.stringify({ startedAt, finishedAt, waitS: WAIT_S, probes }, null, 2));
console.log(`\nresults/${run}.json  (${startedAt} → ${finishedAt})`);
for (const p of probes) {
  const as = p.report.attempts;
  const gaps = as.slice(1).map((a, i) => ((Date.parse(a.firedAt) - Date.parse(as[i].firedAt)) / 1000).toFixed(1));
  console.log(`${p.mode.padEnd(13)} attempts=${as.length} retryCount=[${as.map((a) => a.retryCount)}] isRetry=[${as.map((a) => a.isRetry)}] gaps=[${gaps}] completed=[${as.map((a) => (a.completedAt ? 'y' : '-')).join('')}] getAlarm=${p.report.alarm}`);
}
