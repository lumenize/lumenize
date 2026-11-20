#!/usr/bin/env node
/**
 * Tables from one or more result files that scripts/logs.mjs has joined:
 *
 *   node scripts/analyze.mjs results/run-<run>.json [more files…]
 *
 * Per rep: (the timed call's cpuTimeMs − the ping's just before it) / reps. Median over rounds on
 * each object, then the median across objects; the spread column is the objects' min–max.
 * Wall time is reported the same way, from wallTimeMs.
 */
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: node scripts/analyze.mjs results/run-<run>.json …');
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (ms) => (ms === undefined ? '—' : ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms >= 1 ? ms.toFixed(2) : ms.toFixed(3));

const records = [];
const objects = [];
const skipped = [];
let unjoined = 0;
for (const f of files) {
  const out = JSON.parse(readFileSync(f, 'utf8'));
  objects.push(...out.objects.map((o) => ({ ...o, object: `${out.run}/${o.object}` })));
  skipped.push(...out.skipped);
  for (const r of out.records) {
    if (!r.run.logs || !r.ping.logs || r.run.error) { unjoined++; continue; }
    records.push({
      ...r,
      object: `${out.run}/${r.object}`,
      cpuMs: (r.run.logs.cpuMs - r.ping.logs.cpuMs) / r.reps,
      wallMs: (r.run.logs.wallMs - r.ping.logs.wallMs) / r.reps,
    });
  }
}

/** key → { cpu, wall, lo, hi } over objects. */
function summarize(metric) {
  const byObj = new Map();
  for (const r of records) {
    const k = `${r.n}|${r.mutation}|${r.what}|${r.arm}`;
    const ko = `${k}|${r.object}`;
    if (!byObj.has(ko)) byObj.set(ko, { k, xs: [] });
    byObj.get(ko).xs.push(r[metric]);
  }
  const byKey = new Map();
  for (const { k, xs } of byObj.values()) {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(median(xs));
  }
  return new Map([...byKey].map(([k, per]) => [k, { mid: median(per), lo: Math.min(...per), hi: Math.max(...per), objects: per.length }]));
}
const cpu = summarize('cpuMs');
const wall = summarize('wallMs');

const ns = [...new Set(records.map((r) => r.n))].sort((a, b) => a - b);
const mutations = [...new Set(records.map((r) => r.mutation))];
const sizeOf = (n, mutation) => objects.find((o) => o.n === n && o.mutation === mutation);
const kb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(2)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${b} B`);

const OPS = {
  apply: ['js', 'jsb', 'sql', 'sqlb'],
  applyRead: ['sql', 'sqlb'],
  diff: ['js', 'jsb', 'sqltree', 'sqlwalk', 'sqlbtree', 'sqlbwalk'],
  part: ['read', 'readb', 'parse', 'stringify', 'jsapply', 'jsdiff', 'write', 'sqlpatch', 'sqlbpatch', 'sqltree'],
};

function table(title, what, arms, metric, extra) {
  const lines = [`### ${title}`, '', `| nodes | value | patch | ${arms.join(' | ')} |${extra ? ` ${extra.head} |` : ''}`,
    `|---:|---:|---:|${arms.map(() => '---:').join('|')}|${extra ? extra.head.split('|').map(() => '---:|').join('') : ''}`];
  let any = false;
  for (const mutation of mutations) {
    for (const n of ns) {
      const cells = arms.map((arm) => metric.get(`${n}|${mutation}|${what}|${arm}`));
      if (cells.every((c) => !c)) continue;
      any = true;
      const size = sizeOf(n, mutation);
      const shown = cells.map((c, i) => {
        if (c) return fmt(c.mid);
        const s = skipped.find((x) => x.n === n && x.mutation === mutation && x.what === what && x.arm === arms[i]);
        return s ? 'skipped' : '—';
      });
      lines.push(`| ${n.toLocaleString('en-US')}${mutations.length > 1 ? ` ${mutation}` : ''} | ${kb(size?.textBytes ?? 0)} | ${kb(size?.patchBytes ?? 0)} | ${shown.join(' | ')} |${extra ? ` ${extra.cell(n, mutation)} |` : ''}`);
    }
  }
  return any ? lines.join('\n') : '';
}

const get = (m, n, mutation, what, arm) => m.get(`${n}|${mutation}|${what}|${arm}`)?.mid;

/**
 * Hosts differ by up to 2× on every arm alike, so a ratio is taken WITHIN each object (each arm's
 * median over rounds there), then the median across objects, with the objects' range.
 */
function pairedRatio(n, mutation, a, b) {
  const objs = [...new Set(records.filter((r) => r.n === n && r.mutation === mutation).map((r) => r.object))];
  const per = [];
  for (const o of objs) {
    const med = ([what, arm]) => {
      const xs = records.filter((r) => r.n === n && r.mutation === mutation && r.object === o && r.what === what && r.arm === arm).map((r) => r.cpuMs);
      return xs.length ? median(xs) : undefined;
    };
    const [x, y] = [med(a), med(b)];
    if (x && y) per.push(x / y);
  }
  if (!per.length) return '—';
  const [lo, hi] = [Math.min(...per), Math.max(...per)];
  return `${median(per).toFixed(1)}×${per.length > 1 ? ` (${lo.toFixed(1)}–${hi.toFixed(1)})` : ''}`;
}

const sections = [
  `${records.length} timed calls joined, ${unjoined} without both log lines. CPU ms per operation, median across ${Math.max(...[...cpu.values()].map((v) => v.objects))} objects.`,
  table('apply — CPU ms per write', 'apply', OPS.apply, cpu, {
    head: 'js ÷ sql | jsb ÷ sqlb', cell: (n, m) => `${pairedRatio(n, m, ['apply', 'js'], ['apply', 'sql'])} | ${pairedRatio(n, m, ['apply', 'jsb'], ['apply', 'sqlb'])}`,
  }),
  table('apply, then the merged value in JS — CPU ms (js arms are apply\'s)', 'applyRead', OPS.applyRead, cpu, {
    head: 'apply js ÷ sql | apply jsb ÷ sqlb', cell: (n, m) => `${pairedRatio(n, m, ['apply', 'js'], ['applyRead', 'sql'])} | ${pairedRatio(n, m, ['apply', 'jsb'], ['applyRead', 'sqlb'])}`,
  }),
  table('diff — CPU ms per patch generated', 'diff', OPS.diff, cpu, {
    head: 'sqlwalk ÷ js | sqltree ÷ js | sqlbwalk ÷ jsb', cell: (n, m) => `${pairedRatio(n, m, ['diff', 'sqlwalk'], ['diff', 'js'])} | ${pairedRatio(n, m, ['diff', 'sqltree'], ['diff', 'js'])} | ${pairedRatio(n, m, ['diff', 'sqlbwalk'], ['diff', 'jsb'])}`,
  }),
  table('components — CPU ms each', 'part', OPS.part, cpu),
  table('apply — wall ms per write', 'apply', OPS.apply, wall),
  table('diff — wall ms per patch', 'diff', OPS.diff, wall),
];
console.log(sections.filter(Boolean).join('\n\n'));

const spread = [...cpu].filter(([, v]) => v.objects > 1 && v.hi > 1.25 * v.lo && v.mid > 0.05);
if (spread.length) {
  console.log('\nObjects disagreeing by more than 25%:');
  for (const [k, v] of spread) console.log(`  ${k}: ${fmt(v.lo)}–${fmt(v.hi)}`);
}
if (skipped.length) {
  console.log('\nSkipped:');
  for (const s of skipped) console.log(`  ${s.n} ${s.mutation} ${s.what}/${s.arm} (object ${s.object}): ${s.reason}`);
}
