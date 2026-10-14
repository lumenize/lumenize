/**
 * The Worker's own debug output, parsed — for scenarios that assert on what a request recorded.
 *
 * Both venues capture it in `DevStack.logs`: a local stack its `wrangler dev` stdio, a deployed one
 * a `wrangler tail` on the test Worker filled in by Workers Logs (`lib/deployed-logs.ts`). The
 * deployed capture arrives one invocation at a time, when each ends, so a limb compares lines by
 * when they were LOGGED (`at`), never by position, and waits up to {@link LOG_WAIT_MS}.
 */
import type { DevStack } from './harness';

/**
 * How long a read of the Worker's lines may wait. A local stack prints each line as it is logged. A
 * deployed tail delivers an invocation's lines when it ends, measured 2026-10-13 at up to 19 s late
 * for a request and 171 s inside a build turn, and a line only Workers Logs holds arrives 29 s to
 * about ten minutes late (`experiments/tail-abort/RESULTS.md`). A wait returns as soon as its line
 * is in, so the deployed budget costs nothing when the line comes through the tail.
 * `HARNESS_LOG_WAIT_MS` sets it for a run that would rather fail sooner.
 */
export const LOG_WAIT_MS = Number(process.env.HARNESS_LOG_WAIT_MS)
  || (process.env.HARNESS_TARGET_URL !== undefined ? 660_000 : 20_000);

/** How long a wait runs before it says what it is waiting for. */
const ANNOUNCE_AFTER_MS = 30_000;

/**
 * What the run is waiting for in the Worker's lines right now, if anything. `drive.ts` names it when
 * a signal stops the run, so the agent that stopped it knows which line never came.
 */
export const waiting: { what?: string } = {};

/**
 * Run `wait` as the run's current wait on `what`, saying so once it has run {@link ANNOUNCE_AFTER_MS}.
 * A wait whose whole budget is that short ends before it would be worth announcing, so it stays quiet.
 */
async function asWait<T>(what: string, budgetMs: number, wait: () => Promise<T>): Promise<T> {
  waiting.what = what;
  const budget = budgetMs < 120_000 ? `${Math.round(budgetMs / 1000)} s` : `${Math.round(budgetMs / 60_000)} min`;
  const announce = budgetMs <= ANNOUNCE_AFTER_MS ? undefined : setTimeout(() => console.error(`[harness] still waiting for `
    + `${what}, up to ${budget} in all; a SIGINT or SIGTERM stops the run and keeps its capture`), ANNOUNCE_AFTER_MS);
  try {
    return await wait();
  } finally {
    clearTimeout(announce);
    if (waiting.what === what) waiting.what = undefined;
  }
}

/**
 * How long a check that a line is ABSENT waits after its barrier before it counts. A local stack
 * prints in logged order, so a barrier logged later is enough there. A deployed capture delivers
 * each invocation's lines when it ends, so a line from another invocation can arrive after a
 * barrier logged after it; the settle gives it that time. It shortens the odds of a vacuous pass
 * deployed rather than closing them, which only the local run does.
 */
export const ABSENCE_SETTLE_MS = process.env.HARNESS_TARGET_URL !== undefined ? 30_000 : 0;

/** Wait out {@link ABSENCE_SETTLE_MS}. */
export async function settleForAbsence(): Promise<void> {
  if (ABSENCE_SETTLE_MS > 0) {
    await asWait('the settle before an absence check', ABSENCE_SETTLE_MS, () => new Promise((r) => setTimeout(r, ABSENCE_SETTLE_MS)));
  }
}

/**
 * One `@lumenize/debug` JSON block from the capture. `at` is the line's own ISO `timestamp`, when
 * it was logged, and orders lines in either venue. `idx` is its position in the capture, which is
 * arrival order: on a deployed target that is not the order lines were logged in.
 */
export type DebugLine = {
  namespace: string; message: string; level?: string; data: Record<string, any>; at: string; idx: number;
};

/**
 * Whether `a` was logged after `b`: by logged time, then by position for two lines logged in the
 * same millisecond, which one invocation logs and so one capture delivers in order, in either
 * venue. Compare positions alone and a deployed capture, which arrives one invocation at a time,
 * can put a request's line after a later request's.
 */
export function loggedAfter<T extends { at: string | number; idx: number }>(a: T, b: T): boolean {
  return a.at > b.at || (a.at === b.at && a.idx > b.idx);
}

/**
 * The client id a host's log line names: the last segment of its `clientAddress`, `alice.9f2c41aa`
 * in `GALAXY/acme.crm/alice.9f2c41aa`, which a scenario compares with a client's `lmz.instanceName`.
 */
export function clientIdIn(data: Record<string, any>): string | undefined {
  return typeof data.clientAddress === 'string' ? data.clientAddress.split('/').pop() : undefined;
}

/** Every JSON debug block in `raw`, in capture order. Each is printed as a `{`…`}` block. */
export function debugLines(raw: string): DebugLine[] {
  const out: DebugLine[] = [];
  for (const block of raw.replace(/\x1b\[[0-9;]*m/g, '').split(/\n(?=\{\n)/)) {
    const end = block.indexOf('\n}');
    if (end < 0) continue;
    try {
      const obj = JSON.parse(block.slice(0, end + 2)) as Omit<DebugLine, 'idx' | 'at'> & { timestamp?: string };
      if (obj.namespace) out.push({ ...obj, data: obj.data ?? {}, at: obj.timestamp ?? '', idx: out.length });
    } catch { /* not one of ours */ }
  }
  return out;
}

/**
 * The parsed capture once `ready` holds of it. The capture reaches the harness late and in bursts,
 * so a limb waits for a line its own request logs after the thing it reads (`live.md`). Throws
 * naming `what` when it never arrives.
 */
export async function waitForDebugLines(
  stack: DevStack, ready: (all: DebugLine[]) => boolean, what: string, timeoutMs = LOG_WAIT_MS,
): Promise<DebugLine[]> {
  const deadline = Date.now() + timeoutMs;
  return asWait(what, timeoutMs, async () => {
    for (;;) {
      const all = debugLines(stack.logs());
      if (ready(all)) return all;
      if (Date.now() > deadline) throw new Error(`the stack's stdio never showed ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });
}
