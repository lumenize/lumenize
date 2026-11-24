#!/usr/bin/env node
/**
 * Prints a joined run as the Markdown tables RESULTS.md carries:
 *
 *   node scripts/tables.mjs results/run-<time>.json > results/tables.md
 *
 * A case's CPU is the median over its timed rounds of cpuTimeMs / reps, from Workers Logs. A cell
 * with no joined round prints `?`.
 */
import { readFileSync } from 'node:fs';

const out = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN; };
const perRep = (r, key) => (r.timed ?? []).filter((t) => t.logs).map((t) => (t.logs[key] * 1000) / t.reps);
/** Median microseconds per rep, printed in the unit that reads best. */
const time = (r, key = 'cpuMs') => {
  const us = median(perRep(r, key));
  if (Number.isNaN(us)) return '?';
  return us >= 10_000 ? `${(us / 1000).toFixed(0)} ms` : us >= 1000 ? `${(us / 1000).toFixed(1)} ms` : `${us.toFixed(0)} µs`;
};
const spread = (r) => { const xs = perRep(r, 'cpuMs'); return xs.length > 1 ? (Math.max(...xs) / Math.min(...xs)).toFixed(2) : '?'; };
const n = (x) => (x ?? 0).toLocaleString('en-US');
// A paired run made before (b) was dropped from it holds (b) cases that did not scan; leave them out.
const valid = (r) => !(out.config?.PAIRED && r.q === 'Q6' && r.meta.arm === 'b');
const by = (pred) => out.records.filter((r) => !r.error && valid(r) && pred(r.meta, r));
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const SUBTREE_NODES = { n1: 1, n4: 4, n41: 41, n411: 411, n4111: '4,111' };

console.log(`<!-- from ${process.argv[2].split('/').pop()}, run ${out.startedAt} to ${out.finishedAt} -->\n`);

// ─── Q2, one whole read ──────────────────────────────────────────────
const WHOLE_ARMS = ['a', 'b', 'b-node', 'b-node-nodeorder', 'swap', 'swap-node', 'c'].filter((arm) => by((m) => m.shape === 'whole' && m.arm === arm).length);
for (const filter of ['stage', 'owner', 'all'].filter((f) => by((m) => m.shape === 'whole' && m.filter === f).length)) {
  console.log(`### Q2 whole read, filter \`${filter}\`\n`);
  for (const [title, cell] of [['Rows read', (r) => n(r.first.rowsRead)], ['CPU', (r) => time(r)]]) {
    const rows = Object.keys(SUBTREE_NODES).map((sk) => {
      const rs = WHOLE_ARMS.map((arm) => by((m) => m.shape === 'whole' && m.filter === filter && m.subtree === sk && m.arm === arm)[0]);
      return [SUBTREE_NODES[sk], n(rs.find(Boolean)?.first.rows), ...rs.map((r) => (r ? cell(r) : '?'))];
    });
    console.log(`${title}:\n\n${table(['Nodes in subtree', 'Results', ...WHOLE_ARMS.map((a) => `(${a})`)], rows)}\n`);
  }
}

// ─── Q2, a first read in pages ───────────────────────────────────────
console.log('### Q2 first read in pages\n');
console.log(table(
  ['Filter', 'Nodes', 'Page', 'Arm', 'Results', 'Statements', 'Pages', 'Rows read, all pages', 'Rows read, first three pages', 'CPU, all pages'],
  by((m) => m.shape === 'paged').map((r) => [
    r.meta.filter, SUBTREE_NODES[r.meta.subtree], `${r.meta.budgetBytes / 1000} kB`, `(${r.meta.arm})`, n(r.first.rows), n(r.first.statements),
    n(r.first.pageCount ?? r.first.statements), n(r.first.rowsRead), (r.first.pages ?? []).slice(0, 3).map((p) => n(p.rowsRead)).join(', '), time(r),
  ])));

// ─── Q6 ──────────────────────────────────────────────────────────────
const Q6_ARMS = ['a', 'b', 'd'].filter((arm) => by((m) => m.q === 'Q6' && m.arm === arm).length);
const whats = [...new Set(by((m) => m.q === 'Q6').map((r) => r.id.split('.').slice(3).join('.')))];
for (const missed of Q6_ARMS.length ? [1, 100, 10_000] : []) {
  console.log(`\n### Q6 catch-up that missed ${n(missed)} writes\n`);
  const rows = whats.map((what) => {
    const rs = Q6_ARMS.map((arm) => by((m, r) => m.q === 'Q6' && m.missed === missed && m.arm === arm && r.id.endsWith(`.${missed}.${what}`))[0]);
    const m = rs.find(Boolean)?.meta;
    return [m?.types, m?.read, n(rs.find(Boolean)?.first.found),
      ...rs.map((r) => (r ? `${n(r.first.findRead)}${r.first.keyStatements ? ` + ${n(r.first.keyRead)}` : ''}` : '?')),
      ...rs.map((r) => (r ? time(r) : '?'))];
  });
  console.log(table(['Types', 'Read', 'Writes found', ...Q6_ARMS.map((a) => `Rows read (${a})`), ...Q6_ARMS.map((a) => `CPU (${a})`)], rows));
}

// ─── Writes ──────────────────────────────────────────────────────────
if (out.writes) {
  console.log('\n### Rows written per write\n');
  const kinds = Object.keys(out.writes.base);
  const one = (t) => { const close = t.closeWritten.join('/'), insert = t.insertWritten.join('/'); return `${close} + ${insert}`; };
  console.log(table(['Write', ...Object.keys(out.writes).map((i) => `${i} (close + insert)`)], kinds.map((k) => [k, ...Object.values(out.writes).map((w) => one(w[k]))])));
}

// ─── Plans ───────────────────────────────────────────────────────────
console.log('\n### Query plans\n');
const plans = new Map();
for (const r of out.records) {
  if (r.error) { console.log(`- \`${r.id}\` failed: ${r.error}`); continue; }
  const key = JSON.stringify([r.instance, r.sql, r.first.plan]);
  if (!plans.has(key)) plans.set(key, { r, ids: [] });
  plans.get(key).ids.push(r.id);
}
for (const { r, ids } of [...plans.values()].filter((p) => valid(p.r))) {
  console.log(`**${ids.length > 3 ? `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more` : ids.join(', ')}** (object \`${r.instance}\`)\n`);
  console.log('```sql');
  for (const sql of [r.sql].flat()) console.log(sql.replace(/\s+/g, ' '));
  console.log('```\n```text');
  for (const line of [r.first.plan].flat(2)) console.log(line);
  console.log('```\n');
}

// ─── Controls ────────────────────────────────────────────────────────
const controls = by((m) => m.q === 'control');
if (controls.length) {
  console.log('### Controls: one statement, one plan, each object\n');
  const objects = [...new Set(controls.map((r) => r.instance))];
  console.log(table(['Statement', 'Rows read', ...objects.map((o) => `CPU on \`${o}\``)], ['range', 'point'].map((what) => {
    const rs = objects.map((o) => controls.find((r) => r.meta.what === what && r.instance === o));
    return [what, n(rs[0]?.first.rowsRead), ...rs.map((r) => (r ? time(r) : '?'))];
  })));
  console.log('');
}

// ─── How steady the timings were ─────────────────────────────────────
const spreads = out.records.filter((r) => !r.error).map((r) => Number(spread(r))).filter((x) => !Number.isNaN(x));
const noops = (out.noops ?? []).filter((x) => x.logs).map((x) => x.logs.cpuMs);
console.log(`### Timing notes\n`);
console.log(`- Cases with a joined timing: ${out.records.filter((r) => perRep(r, 'cpuMs').length).length} of ${out.records.length}; with every round joined: ${out.records.filter((r) => perRep(r, 'cpuMs').length === (r.timed ?? []).length && (r.timed ?? []).length).length}.`);
console.log(`- Slowest round over fastest, per case: median ${median(spreads).toFixed(2)}, worst ${Math.max(...spreads).toFixed(2)}.`);
console.log(`- An empty invocation's cpuTimeMs: ${noops.join(', ')}.`);
console.log(`- Cases whose timed rows differed from the first call's: ${out.records.filter((r) => r.mismatch).map((r) => r.id).join(', ') || 'none'}.`);
