#!/usr/bin/env node
// What Workers Logs recorded for this Worker between two times: every alarm invocation's event
// (its outcome, the object it ran on, the version) and every console line that is not one of the
// probe's own attempt lines — which is where a give-up notice would appear, if there were one.
//
//   node scripts/logs.mjs <fromISO> <toISO>
//
// Writes the raw events to results/logs-raw-<from>.json, which the root .gitignore's `*-raw-*`
// rule keeps out of git: each request event carries the client's IP and location. Workers Logs
// lags by up to about ten minutes (experiments/tail-abort/RESULTS.md), so run it a while after
// the drive.
// Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN from the root
// .dev.vars, never printing the token.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../../../', import.meta.url);
const SERVICE = 'experiment-do-alarm-retry';
const PAGE = 2000;

function devVar(name) {
  const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} is missing from the root .dev.vars`);
  return value;
}
const ACCOUNT = devVar('CLOUDFLARE_ACCOUNT_ID');
const TOKEN = devVar('CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN');

async function query(from, to) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      queryId: `do-alarm-retry-${crypto.randomUUID()}`, view: 'events', limit: PAGE, timeframe: { from, to },
      parameters: { filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: SERVICE }] },
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error(`Workers Logs answered ${res.status}: ${body.errors?.[0]?.message ?? 'no message'}`);
  return body.result?.events?.events ?? [];
}

/** Every event in [from, to]: newest first, paged by narrowing `to` (an event id is not unique). */
async function allEvents(from, to) {
  const seen = new Map();
  for (let page = 0; page < 100; page++) {
    const events = await query(from, to);
    for (const e of events) seen.set(`${e.$metadata?.requestId}|${e.$metadata?.id}|${e.timestamp}`, e);
    if (events.length < PAGE) break;
    to = Math.min(...events.map((e) => e.timestamp)) + 1;
  }
  return [...seen.values()].sort((a, b) => a.timestamp - b.timestamp);
}

const [fromArg, toArg] = process.argv.slice(2);
if (!fromArg || !toArg) throw new Error('usage: node scripts/logs.mjs <fromISO> <toISO>');
const events = await allEvents(Date.parse(fromArg), Date.parse(toArg));
writeFileSync(new URL(`../results/logs-raw-${fromArg.replace(/[:.]/g, '-')}.json`, import.meta.url), JSON.stringify(events, null, 2));

const probeOf = new Map();
for (const e of events) if (e.source && typeof e.source === 'object' && 'probe' in e.source) probeOf.set(e.$metadata.requestId, e.source);
console.log(`${events.length} events`);
for (const e of events) {
  const w = e.$workers ?? {};
  const at = new Date(e.timestamp).toISOString();
  if (e.$metadata?.type === 'cf-worker-event' && w.eventType === 'alarm') {
    const p = probeOf.get(e.$metadata.requestId);
    console.log(`${at} ALARM outcome=${w.outcome} ${p ? `${p.mode} seq=${p.seq} retryCount=${p.retryCount}` : '(no probe line)'} version=${w.scriptVersion?.id?.slice(0, 8) ?? '?'} wall=${w.wallTimeMs} cpu=${w.cpuTimeMs}`);
  } else if (e.$metadata?.type === 'cf-worker' && !(e.source && typeof e.source === 'object' && 'probe' in e.source)) {
    console.log(`${at} LINE ${e.$metadata?.level ?? ''} ${JSON.stringify(e.source ?? e.$metadata?.message).slice(0, 300)}`);
  }
}
