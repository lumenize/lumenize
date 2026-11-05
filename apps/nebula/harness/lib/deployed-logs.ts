/**
 * A deployed run's capture of the Worker's lines: `wrangler tail` for nearly all of them, as they
 * arrive, plus each line Workers Logs holds that the tail never delivered. Neither channel is
 * complete, and in `experiments/tail-abort/RESULTS.md` no line was lost by both. The text reads
 * like a local stack's stdio, so `DevStack.logs` and `debugLines` work the same in both venues.
 *
 * The capture only ever grows at its end. Whichever channel delivers a line first adds it there,
 * and the other channel's copy is left out, so a line keeps its position between reads; a reader
 * comparing two reads of one line by position (`loggedAfter`) would otherwise see it move. A line
 * only Workers Logs has arrives up to about ten minutes late, which `LOG_WAIT_MS` allows for.
 */
import { startTail } from './tail';
import { debugLineKey, startLogsBackfill } from './workers-logs';

export interface DeployedLogs { text: () => string; stop: () => void }

/** How far before the run's start Workers Logs is read: a margin for clock skew with Cloudflare. */
const SKEW_MS = 60_000;

/** The key of a console line that is one of our JSON lines, or undefined for anything else. */
function keyOf(line: string): string | undefined {
  if (!line.startsWith('{')) return undefined;
  try { return debugLineKey(JSON.parse(line)); } catch { return undefined; }
}

export async function startDeployedLogs(worker: string, ping: () => Promise<unknown>): Promise<DeployedLogs> {
  const since = Date.now() - SKEW_MS;
  // Copies of each line per channel, and in the capture. Two copies of one line from one invocation
  // share a key, so these count; the capture holds as many as the channel that delivered more.
  const fromTail = new Map<string, number>();
  const fromLogs = new Map<string, number>();
  const shown = new Map<string, number>();
  /** Count a channel's copy of `key`, and say whether the capture lacks it. */
  const isNew = (channel: Map<string, number>, key: string): boolean => {
    const n = (channel.get(key) ?? 0) + 1;
    channel.set(key, n);
    if (n <= (shown.get(key) ?? 0)) return false;
    shown.set(key, n);
    return true;
  };
  const tail = await startTail(worker, ping, undefined, (line) => {
    const key = keyOf(line);
    return key === undefined || isNew(fromTail, key);
  });
  let logs;
  try {
    logs = await startLogsBackfill(worker, since,
      (line) => { if (isNew(fromLogs, line.key)) tail.append(line.text); },
      (note) => tail.append(note));
  } catch (e) {
    tail.stop();
    throw e;
  }
  const backfill = logs;
  return { text: tail.text, stop: () => { backfill.stop(); tail.stop(); } };
}
