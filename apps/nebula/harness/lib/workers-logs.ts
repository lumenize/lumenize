/**
 * A deployed Worker's `@lumenize/debug` lines, read from Workers Logs by API while a run goes on,
 * for the lines `wrangler tail` never delivers. `experiments/tail-abort/RESULTS.md` measured both:
 * the tail loses every line an abort ends on an object hosting live tabs, and some an abort ends
 * on an object with other work in flight; Workers Logs keeps those, loses others, and lags 29 s to
 * about ten minutes. No line was lost by both, so `lib/deployed-logs.ts` reads the tail first and
 * adds what only this has.
 *
 * Reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN` from
 * `.dev.vars`. The target must have Workers Logs on, as `scripts/test-deploy-config.mjs` gives
 * `test-nebula`.
 */
import { readDevVar } from './harness';

/** One of our lines from Workers Logs: its {@link debugLineKey}, and the text the tail would print. */
export interface LogsLine { key: string; text: string }

export interface LogsBackfill { stop: () => void }

/** How often a poll runs. Ingestion lag is the wait, so polling faster buys little. */
const POLL_MS = 30_000;
/** How far back each poll looks: past the longest lag measured, so a late line is still found. */
const WINDOW_MS = 15 * 60_000;
const PAGE = 2000;

/** A JSON value with object keys sorted, so two copies of a line compare equal: Workers Logs reorders keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * What identifies one logged line in either channel: its time, namespace, message and data. One
 * invocation's clock does not move, so two identical lines from it share a key; a reader counts
 * copies rather than collapsing them.
 */
export function debugLineKey(line: unknown): string | undefined {
  if (!line || typeof line !== 'object') return undefined;
  const { namespace, message, timestamp, data } = line as Record<string, unknown>;
  if (typeof namespace !== 'string' || typeof message !== 'string') return undefined;
  return `${String(timestamp)}|${namespace}|${message}|${canonical(data)}`;
}

/** A line in `@lumenize/debug`'s own key order and indent, as the tail and a local stack print it. */
function asPrinted(source: Record<string, unknown>): string {
  const { type, level, namespace, message, timestamp, data, stack, ...rest } = source;
  const line = { type, level, namespace, message, timestamp, ...rest,
    ...(data !== undefined ? { data } : {}), ...(stack !== undefined ? { stack } : {}) };
  return `${JSON.stringify(line, null, 2)}\n`;
}

interface LogsEvent { source?: unknown; timestamp?: number; $metadata?: { id?: string; requestId?: string } }

/**
 * What tells one Workers Logs event from every other. `$metadata.id` alone does not: it is the
 * millisecond plus a count within the invocation, so three invocations of one object in one
 * millisecond each have an event `01M4Y0434M000000000000000X`, measured 2026-10-14, and about one
 * event in ten shared its id with another.
 */
function eventKey(event: LogsEvent): string | undefined {
  const { id, requestId } = event.$metadata ?? {};
  return id === undefined ? undefined : `${requestId ?? ''}|${id}`;
}

/** One page of `worker`'s events in `[from, to]`, newest first. */
async function query(account: string, token: string, worker: string, from: number, to: number): Promise<LogsEvent[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      queryId: `harness-${crypto.randomUUID()}`, view: 'events', limit: PAGE, timeframe: { from, to },
      // Our lines are `cf-worker` events. With traces on, spans are about nine in ten of a Worker's
      // events: a poll of a busy sweep's window that kept them pulled 52 MB in 36 s, and 2.6 MB in 4 s without.
      parameters: { filters: [
        { key: '$metadata.service', operation: 'eq', type: 'string', value: worker },
        { key: '$metadata.type', operation: 'eq', type: 'string', value: 'cf-worker' },
      ] },
    }),
  });
  const body = await res.json() as { success?: boolean; errors?: Array<{ message?: string }>; result?: { events?: { events?: LogsEvent[] } } };
  if (!res.ok || !body.success) throw new Error(`Workers Logs query answered ${res.status}: ${body.errors?.[0]?.message ?? 'no message'}`);
  return body.result?.events?.events ?? [];
}

/**
 * Poll Workers Logs for `worker`'s lines logged since `sinceMs`, handing each new one to `onLine`
 * once, and each failed poll after the first to `onNote` as a line for the capture. The first poll
 * runs before this returns and throws if the API refuses, so a missing token or permission fails the
 * run at its start rather than leaving a reader that finds nothing. The poll timer is unref'd, so a
 * reader the run forgets to stop cannot hold the process open.
 */
export async function startLogsBackfill(
  worker: string, sinceMs: number, onLine: (line: LogsLine) => void, onNote: (note: string) => void,
): Promise<LogsBackfill> {
  const account = readDevVar('CLOUDFLARE_ACCOUNT_ID');
  const token = readDevVar('CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN');
  const seen = new Set<string>();
  let polling = false;
  let stopped = false;

  // A full page is followed by the window up to its oldest event's millisecond, which it repeats in
  // part; `seen` drops the repeats. Paging by an event's id would skip events sharing it.
  const poll = async () => {
    let to = Date.now();
    const from = Math.max(sinceMs, to - WINDOW_MS);
    for (let page = 0; page < 50 && !stopped; page++) {
      const events = await query(account, token, worker, from, to);
      for (const event of events) {
        const id = eventKey(event);
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        const key = debugLineKey(event.source);
        if (key) onLine({ key, text: asPrinted(event.source as Record<string, unknown>) });
      }
      const oldest = events.at(-1)?.timestamp;
      // A page one millisecond deep cannot be narrowed further; what it leaves out stays out.
      if (events.length < PAGE || oldest === undefined || oldest + 1 >= to) return;
      to = oldest + 1;
    }
  };

  await poll();
  const timer = setInterval(() => {
    if (polling || stopped) return;
    polling = true;
    poll().catch((e: Error) => onNote(`[harness logs] a Workers Logs poll failed: ${e.message}\n`))
      .finally(() => { polling = false; });
  }, POLL_MS);
  timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
