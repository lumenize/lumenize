/**
 * `wrangler tail` on a deployed Worker, kept as text in the shape a local stack's stdio has, so a
 * deployed run's `DevStack.logs` reads the same way through `debugLines` (`lib/stdio.ts`). Each
 * console line of each event is written on its own, and `@lumenize/debug` already writes its lines
 * as pretty-printed JSON blocks, which is what `debugLines` splits on. After a request's own lines
 * comes an access line in wrangler dev's shape, `[wrangler:info] POST /auth/magic-link 200 OK`,
 * path only, which limbs wait for as the sign that the request's lines are all in.
 *
 * ⚠️ The tail delivers an invocation's lines only when that invocation ends, so the capture is in
 * ARRIVAL order, not logged order (measured 2026-10-13: a request's lines up to 19 s late, a build
 * turn's up to 171 s). Work a request awaits ends before it does, so its lines still arrive first,
 * which is what a limb's wait for its own later line relies on. Two sibling requests can arrive
 * swapped, though, so a limb compares when lines were LOGGED (`DebugLine.at`), never their
 * positions, and waits as long as `LOG_WAIT_MS` allows. Holding lines back to restore logged order
 * was tried and dropped: every read then waited out the hold.
 *
 * In JSON mode the tail prints nothing until an event arrives, so it counts as live once a request
 * `ping` makes has come back through it. It runs on the local `wrangler login` session.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STDIO_KEEP } from './harness';

/** The parts of a `wrangler tail --format json` event this module reads. */
export interface TailEvent {
  durableObjectId?: string;
  /** `ok`, or how the invocation ended otherwise: `exception`, `exceededCpu`, `canceled`, and so on. */
  outcome?: string;
  entrypoint?: string;
  truncated?: boolean;
  logs?: Array<{ message?: unknown[] }>;
  exceptions?: Array<{ name?: string; message?: string }>;
  /** A request's event, or the tail's own notice: `overload` when it starts sampling, `overload-stop` when it ends. */
  event?: { request?: { url?: string; method?: string }; response?: { status?: number }; type?: string; message?: string };
}

export interface Tail {
  /** What the Worker logged since the tail went live, in arrival order, the last few MB of it. */
  text: () => string;
  /** Add text from elsewhere to the end of the capture, as if it had just arrived. */
  append: (text: string) => void;
  stop: () => void;
}

/** How long the tail may take to show the first ping's event before the run gives up. */
const LIVE_TIMEOUT_MS = 90_000;
const PING_EVERY_MS = 2_000;

/** wrangler dev's access line for a request, path only: a query string can carry a secret. */
function accessLine(event: TailEvent['event']): string | undefined {
  const { request, response } = event ?? {};
  if (!request?.url || !request.method) return undefined;
  const status = response?.status;
  return `[wrangler:info] ${request.method} ${new URL(request.url).pathname} ${status ?? '(no response)'}${status === 200 ? ' OK' : ''}\n`;
}

/**
 * @param admit Whether to keep one console line of an event; a line it refuses is left out of the
 *   capture, for a reader that already holds that line from another channel.
 */
export async function startTail(
  worker: string,
  ping: () => Promise<unknown>,
  onEvent?: (event: TailEvent) => void,
  admit?: (line: string) => boolean,
): Promise<Tail> {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const child = spawn('npx', ['wrangler', 'tail', worker, '--format', 'json'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let captured = '';
  let pending = '';
  let stderr = '';
  let live = false;
  const append = (text: string) => {
    captured += text;
    if (captured.length > STDIO_KEEP) captured = captured.slice(-STDIO_KEEP);
  };
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-2_000);
    for (const line of chunk.split('\n')) if (line.trim()) append(`[harness tail] stderr: ${line}\n`);
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk;
    // Each event is pretty-printed, and its closing brace is the only line that is `}` alone.
    for (let end = pending.indexOf('\n}\n'); end >= 0; end = pending.indexOf('\n}\n')) {
      const text = pending.slice(0, end + 2);
      pending = pending.slice(end + 3);
      let event: TailEvent;
      try {
        event = JSON.parse(text.slice(text.indexOf('{')));
      } catch {
        append(`[harness tail] an event did not parse, so its lines are missing: ${text.slice(0, 200).replace(/\n/g, ' ')}\n`);
        continue;
      }
      live = true;
      // Under load the tail samples, dropping events, and says so only in this notice, so a limb
      // that never sees its line can tell a dropped event from a line the Worker never wrote.
      if (event.event?.type === 'overload' || event.event?.type === 'overload-stop') {
        append(`[harness tail] ${event.event.type}: ${event.event.message ?? ''}\n`);
      }
      for (const log of event.logs ?? []) {
        const line = (log.message ?? []).map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ');
        if (!admit || admit(line)) append(`${line}\n`);
      }
      for (const e of event.exceptions ?? []) append(`✘ Uncaught ${e.name ?? 'Error'}: ${e.message ?? ''}\n`);
      // An object reset mid-turn leaves no line of its own, so how each invocation ended is kept
      // whenever it was not `ok`.
      if (event.outcome && event.outcome !== 'ok') {
        append(`[harness tail] a ${event.entrypoint ?? 'Worker'} invocation ended ${event.outcome}${event.durableObjectId ? ` (object ${event.durableObjectId.slice(0, 8)})` : ''}\n`);
      }
      // Cloudflare cuts an event that logs too much; a limb counting its lines must know.
      if (event.truncated) append('[harness tail] the event above was truncated: some of its lines are missing\n');
      const access = accessLine(event.event);
      if (access) append(access);
      onEvent?.(event);
    }
  });
  for (const t = Date.now(); !live; await new Promise((r) => setTimeout(r, PING_EVERY_MS))) {
    if (child.exitCode !== null || Date.now() - t > LIVE_TIMEOUT_MS) {
      child.kill();
      throw new Error(`wrangler tail ${worker} never showed an event${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
    }
    await ping().catch(() => undefined);
  }
  return { text: () => captured, append, stop: () => child.kill() };
}
