#!/usr/bin/env node
// The Durable Object SQL that costs the most, one Worker at a time: the DO version of D1's
// "find expensive queries" (developers.cloudflare.com/d1/observability/find-expensive-queries/).
//
//   node scripts/do-queries.mjs --worker test-nebula                     # the last 7 days
//   node scripts/do-queries.mjs --worker test-nebula --since 6h --by reads
//   node scripts/do-queries.mjs --worker test-nebula --deploy 7781a1f3-7bf9-4b52-92dd-4126be07d551
//
// --since takes an ISO time, epoch milliseconds, or a duration back from now (`90m`, `6h`, `2d`).
//   Workers Logs keeps 7 days, so a longer window finds nothing older.
// --by ranks by `cost` (the default), `reads` or `writes`. A written row is billed at 1,000× a
//   read row ($1.00 against $0.001 per million, the same as D1), so cost is what the bill sees.
// --class keeps one Durable Object class, such as `Galaxy`.
// --deploy keeps one deployed version, so two deploys of the same code can be compared.
// --limit is how many queries to show (default 20, at most 200). --json prints one object per row.
//
// The data is the trace span Cloudflare records for every `ctx.storage.sql.exec`, which carries
// the query text, with `?` for each binding, and the final rows read and written. So it needs
// `observability.traces` on in the Worker's wrangler.jsonc. What it cannot show, beside D1's
// page: a duration (a DO's SQL runs synchronously inside the isolate, so every span reads 0 ms)
// and rows returned. The second table covers the key-value API and alarms, whose spans carry a
// key count but no rows; each key is one row in the hidden table that backs them.
//
// Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN from the root
// .dev.vars and never prints the token.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';
const READ_RATE = 0.001 / 1e6;
const WRITE_RATE = 1.0 / 1e6;
const ROWS_READ = 'cloudflare.durable_object.response.rows_read';
const ROWS_WRITTEN = 'cloudflare.durable_object.response.rows_written';
const KV_KEYS = 'cloudflare.durable_object.kv.query.keys.count';
// The storage spans other than exec, and which way each key counts. A list's rows are not on
// its span, so it shows calls only.
const KV_ROWS = {
  durable_object_storage_kv_get: 'read',
  durable_object_storage_kv_put: 'written',
  durable_object_storage_kv_delete: 'written',
  durable_object_storage_setAlarm: 'alarm',
};

function devVar(name) {
  const line = readFileSync(join(ROOT, '.dev.vars'), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} is missing from .dev.vars (see .dev.vars.example)`);
  return value;
}

function parseArgs(argv) {
  const args = { since: '7d', by: 'cost', limit: '20', json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (['--worker', '--since', '--by', '--class', '--deploy', '--limit'].includes(flag)) args[flag.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.worker) throw new Error('--worker is required, such as --worker test-nebula');
  if (!['cost', 'reads', 'writes'].includes(args.by)) throw new Error(`--by ${args.by} is not cost, reads or writes`);
  args.limit = Number(args.limit);
  if (!(args.limit >= 1 && args.limit <= 200)) throw new Error('--limit takes 1 to 200');
  return args;
}

/** Epoch ms for an ISO time, epoch ms, or a duration back from now. */
function sinceMs(since) {
  const ago = /^(\d+)([mhd])$/.exec(since);
  if (ago) return Date.now() - Number(ago[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2]];
  if (/^\d+$/.test(since)) return Number(since);
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new Error(`--since ${since} is not an ISO time, epoch ms or a duration like 6h`);
  return ms;
}

let args, since, account, token;
try {
  args = parseArgs(process.argv.slice(2));
  since = sinceMs(args.since);
  account = devVar('CLOUDFLARE_ACCOUNT_ID');
  token = devVar('CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN');
} catch (e) {
  console.error(`do-queries.mjs: ${e.message}`);
  process.exit(2);
}

const eq = (key, value) => ({ key, operation: 'eq', type: 'string', value });
const scope = [eq('$metadata.service', args.worker)];
if (args.class) scope.push(eq('cloudflare.entrypoint', args.class));
if (args.deploy) scope.push(eq('cloudflare.script_version.id', args.deploy));

/**
 * One `calculations` query, folded into a row per group: `{ groups: [...], <alias>: value }`.
 * Totals over a long window come back as estimates, so each row keeps the largest sample
 * interval any of its aggregates reported.
 */
async function calculate(filters, groupBys, calculations, orderBy, limit) {
  const response = await fetch(`${API}/accounts/${account}/workers/observability/telemetry/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      // The group count is `parameters.limit`. The top-level `limit` alone leaves it at 10.
      queryId: 'do-queries', view: 'calculations', timeframe: { from: since, to: Date.now() }, limit,
      parameters: { filters, groupBys: groupBys.map((value) => ({ type: 'string', value })), calculations, orderBy: { value: orderBy, order: 'desc' }, limit },
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`telemetry query answered ${response.status}: ${JSON.stringify(body.errors ?? body).replaceAll(token, '[token]')}`);
  }
  const rows = new Map();
  for (const calculation of body.result.calculations ?? []) {
    for (const aggregate of calculation.aggregates) {
      const row = rows.get(aggregate.groupKey) ?? { groups: aggregate.groups.map((g) => g.value), sample: 1 };
      row[calculation.alias] = aggregate.value;
      row.sample = Math.max(row.sample, aggregate.sampleInterval ?? 1);
      rows.set(aggregate.groupKey, row);
    }
  }
  return [...rows.values()];
}

const cost = (row) => (row.rowsRead ?? 0) * READ_RATE + (row.rowsWritten ?? 0) * WRITE_RATE;

// The API orders by one measure, and cost mixes two. A query outside the top 200 by reads AND
// the top 200 by writes is beaten on both by 200 others, so the union holds the top 200 by cost.
const execFilters = [...scope, eq('name', 'durable_object_storage_exec')];
const execCalculations = [
  { operator: 'count', alias: 'runs' },
  { operator: 'sum', key: ROWS_READ, keyType: 'number', alias: 'rowsRead' },
  { operator: 'sum', key: ROWS_WRITTEN, keyType: 'number', alias: 'rowsWritten' },
  { operator: 'max', key: ROWS_READ, keyType: 'number', alias: 'maxRead' },
];
const groupBy = ['cloudflare.entrypoint', 'db.query.text'];
const orderings = args.by === 'cost' ? ['rowsRead', 'rowsWritten'] : [args.by === 'reads' ? 'rowsRead' : 'rowsWritten'];
const execRows = new Map();
for (const ordering of orderings) {
  for (const row of await calculate(execFilters, groupBy, execCalculations, ordering, 200)) execRows.set(row.groups.join('\0'), row);
}
const measure = { cost, reads: (r) => r.rowsRead ?? 0, writes: (r) => r.rowsWritten ?? 0 }[args.by];
const queries = [...execRows.values()].sort((a, b) => measure(b) - measure(a)).slice(0, args.limit);

const kvRows = (await calculate(
  [...scope, { key: 'name', operation: 'starts_with', type: 'string', value: 'durable_object_storage_' }],
  ['cloudflare.entrypoint', 'name'],
  [{ operator: 'count', alias: 'calls' }, { operator: 'sum', key: KV_KEYS, keyType: 'number', alias: 'keys' }],
  'calls', 100,
)).filter((row) => row.groups[1] !== 'durable_object_storage_exec');
for (const row of kvRows) {
  const way = KV_ROWS[row.groups[1]];
  if (way === 'read') row.rowsRead = row.keys;
  if (way === 'written') row.rowsWritten = row.keys;
  if (way === 'alarm') row.rowsWritten = row.calls;
}
kvRows.sort((a, b) => cost(b) - cost(a) || b.calls - a.calls);

if (args.json) {
  for (const row of queries) {
    const [doClass, query] = row.groups;
    console.log(JSON.stringify({ kind: 'sql', doClass, query, runs: row.runs, rowsRead: row.rowsRead, rowsWritten: row.rowsWritten,
      avgRead: row.rowsRead / row.runs, maxRead: row.maxRead, cost: cost(row), sampleInterval: row.sample }));
  }
  for (const row of kvRows) {
    const [doClass, span] = row.groups;
    console.log(JSON.stringify({ kind: 'kv', doClass, span, calls: row.calls, keys: row.keys, rowsRead: row.rowsRead, rowsWritten: row.rowsWritten,
      cost: cost(row), sampleInterval: row.sample }));
  }
} else {
  const n = (v) => (v === undefined ? '-' : Math.round(v).toLocaleString('en-US'));
  const usd = (v) => `$${v.toFixed(6)}`;
  const sampled = (row) => (Math.round(row.sample) > 1 ? `1/${Math.round(row.sample)}` : 'all');
  const table = (header, lines) => {
    const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
    for (const line of [header, ...lines]) console.log(line.map((c, i) => (i < line.length - 1 ? c.padStart(widths[i]) : c)).join('  '));
  };
  const filter = [args.class && `class ${args.class}`, args.deploy && `deploy ${args.deploy}`].filter(Boolean).join(', ');
  console.log(`${args.worker}: Durable Object storage since ${new Date(since).toISOString()}${filter ? ` (${filter})` : ''}, by ${args.by}`);
  console.log('cost is at list price past the included allowance; a sampled row\'s totals are estimates\n');

  if (queries.length === 0) console.log('no durable_object_storage_exec spans: are traces on for this Worker?');
  else {
    table(['cost', 'runs', 'read', 'written', 'avg read', 'max read', 'sample', 'class', 'query'], queries.map((row) => [
      usd(cost(row)), n(row.runs), n(row.rowsRead), n(row.rowsWritten), (row.rowsRead / row.runs).toFixed(1), n(row.maxRead),
      sampled(row), row.groups[0], row.groups[1].replace(/\s+/g, ' ').slice(0, 120),
    ]));
  }
  if (kvRows.length > 0) {
    console.log('\nkey-value API and alarms (rows ≈ keys; a list\'s rows are not recorded)');
    table(['cost', 'calls', 'keys', 'sample', 'class', 'span'], kvRows.map((row) => [
      usd(cost(row)), n(row.calls), n(row.keys), sampled(row), row.groups[0],
      row.groups[1].replace('durable_object_storage_', ''),
    ]));
  }
}
