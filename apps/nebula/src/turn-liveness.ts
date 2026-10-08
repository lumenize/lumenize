/**
 * Turn liveness — the client-side failure story for a triggered chat turn, as a pure
 * reducer (Studio's failed-turn banner and the tests both consume it).
 *
 * Transient stream chunks are a liveness HINT, not truth — best-effort, they drop on a
 * WS reconnect, a slept tab, or a quiet model gap — so the idle window is per-SIGNAL,
 * never total-elapsed: a slow turn that keeps streaming never fails, and a genuinely
 * silent one fails within one idle window instead of hanging as "thinking… forever".
 * The durable `Message` on the subscription is truth: a reply landing (even late,
 * after `failed` already showed) settles the turn and clears the banner. Recovery from
 * `failed` is always a MANUAL re-prompt — a fresh user message, a new turn — never an
 * automatic retry, so a spurious `failed` can never double-generate on its own.
 */

export type TurnPhase = 'awaiting' | 'failed' | 'settled';

export interface TurnLiveness {
  phase: TurnPhase;
  /** Epoch ms of the last liveness signal — the post itself, then each transient chunk. */
  lastSignalAt: number;
}

/**
 * The idle window: ≫ the max inter-chunk gap (a cold model's first token can lag tens
 * of seconds), well under the server's generation deadline. A too-short window is
 * self-healing — the durable reply clears a spurious `failed` — while a too-long one
 * is the old "thinking… forever" hang, so err short.
 */
export const TURN_IDLE_MS = 90_000;

/**
 * How often the server beats through a running turn (`turn-heartbeat.ts`): four beats per idle
 * window, so a turn survives three consecutive dropped chunks — chunks are best-effort and a WS
 * reconnect or a slept tab loses them — before the window can elapse on a turn that is alive.
 * Derived, not chosen independently: it is a property of the window, and moving one without the
 * other is the mistake this line prevents.
 */
export const TURN_HEARTBEAT_MS = TURN_IDLE_MS / 4;

export function startTurn(now: number): TurnLiveness {
  return { phase: 'awaiting', lastSignalAt: now };
}

/** A transient chunk arrived — generation is alive. Re-arms a `failed` turn too (a late
 *  chunk after a spurious failure means the turn is still running); never unsettles. */
export function signalTurn(t: TurnLiveness, now: number): TurnLiveness {
  return t.phase === 'settled' ? t : { phase: 'awaiting', lastSignalAt: now };
}

/** The durable reply landed on the subscription — truth. Clears `failed` (reconciliation). */
export function settleTurn(t: TurnLiveness): TurnLiveness {
  return { ...t, phase: 'settled' };
}

/** Periodic check: an awaiting turn with no signal inside `idleMs` is `failed`. */
export function evaluateTurn(t: TurnLiveness, now: number, idleMs: number = TURN_IDLE_MS): TurnLiveness {
  return t.phase === 'awaiting' && now - t.lastSignalAt > idleMs ? { ...t, phase: 'failed' } : t;
}

/** Which single status bubble the thread shows beneath the durable messages. */
export type TurnDisplay = 'streaming' | 'failed' | 'thinking' | 'none';

/**
 * The rendered status, derived — so PRECEDENCE lives here rather than in a template's
 * `v-if`/`v-else-if` order, where it is invisible to a test.
 *
 * ⚠️ **`failed` outranks `streaming`, and that ordering is the whole point.** A transient
 * stream clears only when its own message lands durably, so a generation that emits
 * chunks and then dies uncommitted leaves a frozen partial reply with nothing to clear
 * it — and if that outranked `failed`, it would hide the banner forever. That is the
 * "thinking… forever" hang this module exists to kill, wearing a half-written answer
 * instead of a spinner. A late chunk re-arms the turn to `awaiting` ({@link signalTurn}),
 * so a turn that is merely slow goes back to showing its stream.
 */
export function deriveTurnDisplay(o: {
  /** A transient stream is in flight whose message has not yet landed durably. */
  streaming: boolean;
  /** The liveness phase of my in-flight turn, if I have one. */
  phase?: TurnPhase;
  /** My message is posted and no durable reply links back to it yet. */
  awaitingReply: boolean;
}): TurnDisplay {
  if (o.phase === 'failed') return 'failed';
  if (o.streaming) return 'streaming';
  return o.awaitingReply ? 'thinking' : 'none';
}
