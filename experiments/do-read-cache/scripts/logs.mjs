#!/usr/bin/env node
/**
 * Joins Workers Logs' per-invocation wallTimeMs and cpuTimeMs into a deployed result file, in place:
 *
 *   node scripts/logs.mjs results/<mode>-deployed-<run>.json
 *
 * Each object invocation logs `{ probe, seq }`. Workers Logs records that line and the invocation's
 * own event (type `cf-worker-event`, executionModel `durableObject`) under one requestId, so
 * requestId → seq → the call in the result file. A call the object makes to itself (`clock`'s
 * `tick`) shares the requestId and has an event of its own, so the event chosen is the one whose
 * rpcMethods name the probe. Workers Logs lags from 29 s to about ten minutes
 * (experiments/tail-abort/RESULTS.md), so this polls until the joined count stops growing, for up
 * to MAX_WAIT_MIN (default 12). Reads CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN from the root .dev.vars, never printing the token.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../../../', import.meta.url);
const SERVICE = 'experiment-do-read-cache';
const PAGE = 2000;
const MAX_WAIT_MIN = Number(process.env.MAX_WAIT_MIN ?? 12);

function devVar(name) {
  const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`${name} is missing from the root .dev.vars`);
  return value;
}
const ACCOUNT = devVar('CLOUDFLARE_ACCOUNT_ID');
const TOKEN = devVar('CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(from, to, offset) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      queryId: `do-read-cache-${crypto.randomUUID()}`, view: 'events', limit: PAGE, timeframe: { from, to },
      parameters: { filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: SERVICE }] },
      ...(offset ? { offset } : {}),
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error(`Workers Logs answered ${res.status}: ${body.errors?.[0]?.message ?? 'no message'}`);
  return body.result?.events?.events ?? [];
}

/** Every event in [from, to], paged by the last event's id. */
async function allEvents(from, to) {
  const out = [];
  let offset;
  for (let page = 0; page < 500; page++) {
    const events = await query(from, to, offset);
    out.push(...events);
    if (events.length < PAGE) break;
    offset = events.at(-1)?.$metadata?.id;
    if (!offset) break;
  }
  return out;
}

/**
 * seq → the invocation's timing. Two ways to a seq:
 * - `line`: the invocation's own `{ probe, seq }` line, under its requestId.
 * - `gap`: Workers Logs dropped the line of every invocation that logged it after ~400 ms of CPU
 *   (RESULTS.md), so a heavy read has an event and no line. Each driver call is one object
 *   invocation, in seq order, so on one object the unlabeled events between two labeled ones,
 *   seq a and seq b, are a+1 … b−1, provided there are exactly b − a − 1 of them. Any other count
 *   means an event went missing, and that gap is left unjoined.
 */
function bySeq(events) {
  const probeOf = new Map();
  const invocations = [];
  for (const e of events) {
    const requestId = e.$metadata?.requestId;
    if (!requestId) continue;
    if (e.source && typeof e.source === 'object' && 'probe' in e.source) probeOf.set(requestId, e.source);
    const w = e.$workers;
    if (e.$metadata?.type === 'cf-worker-event' && w?.executionModel === 'durableObject' && Number.isFinite(w.wallTimeMs)) {
      const methods = w.event?.rpcMethods ?? [];
      if (methods.length === 1 && methods[0] === 'tick') continue; // clock's self-call, not a driver call
      invocations.push({ requestId, object: w.durableObjectId, at: BigInt(e.$metadata.timestampNs ?? 0), methods,
        wallMs: w.wallTimeMs, cpuMs: w.cpuTimeMs, outcome: w.outcome });
    }
  }
  const out = new Map();
  const timing = (inv, via) => ({ wallMs: inv.wallMs, cpuMs: inv.cpuMs, outcome: inv.outcome, via });
  const byObject = new Map();
  for (const inv of invocations) {
    const probe = probeOf.get(inv.requestId);
    if (probe && inv.methods.includes(probe.probe)) {
      inv.seq = probe.seq;
      out.set(probe.seq, timing(inv, 'line'));
    }
    if (!byObject.has(inv.object)) byObject.set(inv.object, []);
    byObject.get(inv.object).push(inv);
  }
  for (const list of byObject.values()) {
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let last = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].seq === undefined) continue;
      if (last >= 0 && list[i].seq - list[last].seq - 1 === i - last - 1) {
        for (let k = last + 1; k < i; k++) {
          const seq = list[last].seq + (k - last);
          if (!out.has(seq)) out.set(seq, timing(list[k], 'gap'));
        }
      }
      last = i;
    }
  }
  return out;
}

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/logs.mjs results/<file>.json');
const out = JSON.parse(readFileSync(file, 'utf8'));
if (out.local) throw new Error('a local run has no Workers Logs');
const from = Date.parse(out.startedAt) - 60_000;
const to = Date.parse(out.finishedAt ?? new Date().toISOString()) + 60_000;
const calls = out.records.flatMap((r) => Object.values(r).filter((v) => v && typeof v === 'object' && 'seq' in v));

let joined = new Map();
const deadline = Date.now() + MAX_WAIT_MIN * 60_000;
// Done when every call joined, or when the count has held for three polls a minute apart.
for (let stable = 0; stable < 3 && Date.now() < deadline;) {
  const next = bySeq(await allEvents(from, Math.min(to, Date.now())));
  const have = calls.filter((c) => next.has(c.seq)).length;
  console.log(`${new Date().toISOString()}  ${have}/${calls.length} calls joined`);
  stable = next.size > 0 && next.size === joined.size ? stable + 1 : 0;
  joined = next;
  if (have === calls.length) break;
  await sleep(60_000);
}
for (const c of calls) if (joined.has(c.seq)) c.logs = joined.get(c.seq);
out.logsJoinedAt = new Date().toISOString();
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`joined ${calls.filter((c) => c.logs).length}/${calls.length}; wrote ${file}`);
