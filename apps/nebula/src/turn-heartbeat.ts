/**
 * Keep a turn's liveness signal alive across a SILENT await — pure, so a fake clock can prove it.
 *
 * The client fails a turn that goes quiet for `TURN_IDLE_MS` (`turn-liveness.ts`); that window is
 * the "thinking… forever" fix and it errs short on purpose. But a turn is silent by construction
 * almost everywhere: every model call in it — each codegen
 * round — is whole-response (nothing arrives until it returns), and a container build emits nothing
 * until it exits. A slow-but-alive stretch therefore crossed the window and painted `failed` over a
 * turn that then completed — the flash seen on the first hand drive of a 90 s build. So the
 * heartbeat wraps the WHOLE turn (`Galaxy.#chatTurn`), not chosen awaits: a first cut wrapped only
 * the loop's two, and the live watch caught the banner painting before codegen had even begun. A
 * keepalive while the turn runs is TRUTHFUL — the DO genuinely is mid-turn — and it keeps the window
 * short rather than lengthening it to cover the slow case.
 *
 * ⚠️ **BOUNDED, deliberately.** The model fetch has no timeout of its own; a hung call runs until
 * the generation deadline releases the latch. Beating past that deadline would mask the very hang
 * the window exists to catch, so the heartbeat stops at `deadlineAt` and the client's window takes
 * over — a dead turn still fails, one window after the deadline instead of one window after its
 * last real chunk.
 *
 * The beat carries NO content: the client appends chunks, so an empty one re-arms its window
 * without altering what is on screen (`App.vue`'s stream hook declines to paint an empty
 * accumulation, which is what keeps "thinking…" showing rather than a blank bubble).
 */
export async function withHeartbeat<T>(
  work: () => Promise<T>,
  beat: () => void,
  opts: { intervalMs: number; deadlineAt: number; now?: () => number },
): Promise<T> {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
  if (now() < opts.deadlineAt) {
    timer = setInterval(() => {
      if (now() >= opts.deadlineAt) { stop(); return; }
      // A beat is fire-and-forget by contract; a throw here would surface as an unhandled
      // exception in a timer callback, and a missed heartbeat only ever costs a banner.
      try { beat(); } catch { /* deliberately swallowed */ }
    }, opts.intervalMs);
  }
  try {
    return await work();
  } finally {
    stop();
  }
}
