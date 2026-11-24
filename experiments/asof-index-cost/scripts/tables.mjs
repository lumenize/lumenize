#!/usr/bin/env node
/** Prints a reads result file as Markdown tables: node scripts/tables.mjs results/reads-<time>.json */
import { readFileSync } from 'node:fs';

const out = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN; };
const fmt = (ms) => (Number.isNaN(ms) ? 'n/a' : ms >= 10 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(1)} ms` : `${(ms * 1000).toFixed(0)} µs`);
const cpu = (r) => {
  const per = r.timed.filter((t) => t.logs).map((t) => t.logs.cpuMs / t.reps);
  return { med: median(per), min: Math.min(...per), max: Math.max(...per), n: per.length };
};
const noops = (out.noops ?? []).filter((n) => n.logs).map((n) => n.logs.cpuMs);
console.log(`Empty invocations: ${noops.length} joined, median ${median(noops)} ms, max ${Math.max(...noops)} ms\n`);

const groups = new Map();
for (const r of out.records) {
  const key = r.q === 'current' ? 'current' : `asof ${r.moment}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
for (const [key, records] of groups) {
  console.log(`### ${key}\n`);
  console.log('| Depth | Arm | Results | rowsRead | CPU (median) | min – max | reps | joined | Detail |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    const f = r.first;
    const c = r.isTimed ? cpu(r) : null;
    const detail = f.scanned !== undefined ? `scan ${f.scanRead} + ${f.lookups} lookups (${f.lookupRead} read), ${f.kept} kept` : `check ${f.check}`;
    console.log(`| ${r.depth} | ${r.arm} | ${f.rows} | ${f.rowsRead} | ${c ? fmt(c.med) : 'plan only'} | ${c ? `${fmt(c.min)} – ${fmt(c.max)}` : ''} | ${r.reps} | ${c ? `${c.n}/${r.timed.length}` : ''} | ${detail} |`);
  }
  console.log('');
}
console.log('### Plans\n');
for (const r of out.records) console.log(`- \`${r.id}\`: ${JSON.stringify(r.first.plan)}`);
