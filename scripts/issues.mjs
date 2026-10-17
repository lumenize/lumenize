#!/usr/bin/env node
// What Workers Issues recorded for one Worker since a given time, each issue with its latest
// occurrence's Error. The catch-up read a deployed pass ends with (.claude/rules/live.md), and
// what a nightly check reads.
//
//   node scripts/issues.mjs --worker test-nebula                        # the last 24 hours
//   node scripts/issues.mjs --worker test-nebula --since 2026-10-13T20:00:00Z
//   node scripts/issues.mjs --worker nebula --since 6h --json
//
// --since takes an ISO time, epoch milliseconds, or a duration back from now (`90m`, `6h`, `2d`).
// --types defaults to `log,exception`, the issues our code raises; `unknown` is scanner traffic,
//   and `--types all` keeps it.
// --json prints one object per issue instead of text.
//
// Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN from the root
// .dev.vars and never prints the token. Exits 0 whatever it finds: whether an issue is a finding
// is the reader's judgment, and the rule says how to make it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';
const PAGE_SIZE = 50;

function devVar(name) {
  const line = readFileSync(join(ROOT, '.dev.vars'), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} is missing from .dev.vars (see .dev.vars.example)`);
  return value;
}

function parseArgs(argv) {
  const args = { since: '24h', types: 'log,exception', json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--worker' || flag === '--since' || flag === '--types') args[flag.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.worker) throw new Error('--worker is required, such as --worker test-nebula');
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

async function get(token, path) {
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`GET ${path.split('?')[0]} answered ${response.status}: ${JSON.stringify(body.errors ?? body).replaceAll(token, '[token]')}`);
  }
  return body;
}

// A bad argument or a missing key is the caller's to fix, so it gets one line, not a stack.
let args, since, account, token;
try {
  args = parseArgs(process.argv.slice(2));
  since = sinceMs(args.since);
  account = devVar('CLOUDFLARE_ACCOUNT_ID');
  token = devVar('CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN');
} catch (e) {
  console.error(`issues.mjs: ${e.message}`);
  process.exit(2);
}
const types = args.types === 'all' ? undefined : new Set(args.types.split(','));
const base = `/accounts/${account}/workers/observability/issues`;

// Newest activity first, so paging stops at the first issue last seen before `since`.
const seen = [];
for (let page = 1; ; page++) {
  const query = new URLSearchParams({ page: String(page), perPage: String(PAGE_SIZE), orderBy: 'lastObserved', order: 'desc', service: args.worker });
  const { result, result_info: info } = await get(token, `${base}?${query}`);
  const recent = result.filter((issue) => issue.lastObserved >= since);
  seen.push(...recent);
  if (recent.length < result.length || page >= (info?.total_pages ?? page)) break;
}

const issues = seen.filter((issue) => !types || types.has(issue.type));
for (const issue of issues) {
  const { result } = await get(token, `${base}/${issue.id}/occurrences?page=1&perPage=1`);
  issue.latest = result[0];
}

if (args.json) {
  for (const issue of issues) console.log(JSON.stringify(issue));
} else {
  const iso = (ms) => new Date(ms).toISOString();
  console.log(`${args.worker}: ${issues.length} issue(s) seen since ${iso(since)}`
    + (seen.length > issues.length ? `, ${seen.length - issues.length} more of other types hidden (--types all shows them)` : ''));
  for (const issue of issues) {
    const age = issue.firstObserved >= since ? 'NEW' : 'RECURRING';
    console.log(`\n${age} ${issue.type} ×${issue.count}  ${issue.title}`);
    console.log(`  first ${iso(issue.firstObserved)}  last ${iso(issue.lastObserved)}  id ${issue.id}`);
    // A logged error's `message` is the log line's; the Error it carried is the stack's first line.
    // An uncaught exception's stack has no header line, only frames.
    const error = issue.latest?.error;
    if (error) {
      const lines = (error.stack ?? '').split('\n').filter((l) => l.trim());
      const header = lines[0] && !lines[0].trim().startsWith('at ') ? lines.shift() : undefined;
      console.log(`  ${error.mechanism ?? 'error'}: ${error.message}`);
      if (header && header !== `${error.name}: ${error.message}`) console.log(`  ${header}`);
      for (const frame of lines.slice(0, 3)) console.log(`  ${frame.trim()}`);
    }
  }
}
