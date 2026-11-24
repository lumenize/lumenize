/**
 * Turn liveness (src/turn-liveness.ts) — pure reducer over (posted, chunk, durable
 * reply, clock), so this needs no running system (live.md's stated-reason carve-out):
 * time is a parameter, and the composite paths around it are covered elsewhere — the
 * durable-reply truth by the trigger e2e (`chat-trigger.test.ts`) and the reconnect
 * re-derive by its subscription-walk test, with the rendered wiring driven live by
 * `studio-chat-reload`.
 *
 * The three limbs are the failure story's own: a silent turn FAILS within one idle
 * window (never hangs), a slow-but-streaming turn NEVER fails (the window is
 * per-signal, not total-elapsed), and a committing reply settles — clearing even an
 * already-shown `failed` (reconciliation), with recovery otherwise manual-only.
 */
import { describe, it, expect } from 'vitest';
import { startTurn, signalTurn, signalOtherTurn, settleTurn, evaluateTurn, deriveTurnDisplay, TURN_IDLE_MS } from '../src/turn-liveness';

describe('turn liveness', () => {
  it('a genuinely silent turn fails within one idle window — not a hang', () => {
    let t = startTurn(0);
    // Inside the window: still awaiting (no premature failure) …
    t = evaluateTurn(t, TURN_IDLE_MS - 1);
    expect(t.phase).toBe('awaiting');
    // … one tick past it with zero signals: failed. This is the loud conversion of the
    // old "thinking… forever" silence.
    t = evaluateTurn(t, TURN_IDLE_MS + 1);
    expect(t.phase).toBe('failed');
  });

  it('a slow-but-streaming turn never fails — the window is per-signal, not total-elapsed', () => {
    let t = startTurn(0);
    // 10× the idle window in total, but every inter-chunk gap stays inside it.
    const gap = TURN_IDLE_MS / 2;
    for (let now = gap; now <= TURN_IDLE_MS * 10; now += gap) {
      t = evaluateTurn(t, now);
      t = signalTurn(t, now);
    }
    expect(t.phase).toBe('awaiting');
  });

  it('the durable reply settles the turn — clearing even an already-shown failed', () => {
    // The chunks-dropped-during-a-reconnect shape: no signals ever arrive, failed
    // shows, then the committed reply lands late on the re-derived subscription.
    let t = startTurn(0);
    t = evaluateTurn(t, TURN_IDLE_MS * 2);
    expect(t.phase).toBe('failed');
    t = settleTurn(t);
    expect(t.phase).toBe('settled');
    // Settled is terminal: a straggler chunk or another sweep cannot resurrect it.
    expect(signalTurn(t, TURN_IDLE_MS * 3).phase).toBe('settled');
    expect(evaluateTurn(t, TURN_IDLE_MS * 9).phase).toBe('settled');
  });

  it('a late chunk re-arms a failed turn back to awaiting — generation is alive after all', () => {
    let t = startTurn(0);
    t = evaluateTurn(t, TURN_IDLE_MS * 2);
    expect(t.phase).toBe('failed');
    t = signalTurn(t, TURN_IDLE_MS * 2 + 1);
    expect(t.phase).toBe('awaiting');
    // And the window restarts from that signal, not from the post.
    expect(evaluateTurn(t, TURN_IDLE_MS * 2 + 10).phase).toBe('awaiting');
  });
});

/**
 * Which status bubble renders. This lives in the reducer rather than in App.vue's
 * `v-if`/`v-else-if` order because template order is a decision no test can see — and
 * it decided wrongly once: the first cut put the transient stream first, so a
 * chunks-then-dies turn showed a frozen partial reply that `v-else`'d the failed banner
 * away forever (caught by the /build-task verifier panel, 2026-08-28). Every limb below
 * would have stayed green against that template, which is the argument for deriving it.
 */
describe('deriveTurnDisplay', () => {
  it('a failed turn OUTRANKS a frozen partial stream — the masking bug', () => {
    // The shape that bit: chunks arrived (so `streaming` is set and nothing will ever
    // clear it — its message never lands durably), then generation died.
    expect(deriveTurnDisplay({ streaming: true, phase: 'failed', awaitingReply: true }))
      .toBe('failed');
  });

  it('a live stream outranks thinking, and a settled turn shows neither', () => {
    expect(deriveTurnDisplay({ streaming: true, phase: 'awaiting', awaitingReply: true }))
      .toBe('streaming');
    // Settled: the durable reply landed, so `awaitingReply` is false and nothing shows.
    expect(deriveTurnDisplay({ streaming: false, phase: 'settled', awaitingReply: false }))
      .toBe('none');
  });

  it('thinking covers the pre-first-chunk window, and nothing shows with no turn', () => {
    expect(deriveTurnDisplay({ streaming: false, phase: 'awaiting', awaitingReply: true }))
      .toBe('thinking');
    expect(deriveTurnDisplay({ streaming: false, awaitingReply: false })).toBe('none');
  });
});

describe('a post waiting behind another post\'s turn', () => {
  // Mutation: let another turn's chunk leave my turn as it was → nothing re-arms the window, and
  // my post reads `failed` while the agent is plainly alive.
  it('stays out of failed, however long the other turn streams, and shows as waiting', () => {
    let t = startTurn(0);
    const gap = TURN_IDLE_MS / 2;
    for (let now = gap; now <= TURN_IDLE_MS * 4; now += gap) {
      t = evaluateTurn(t, now);
      t = signalOtherTurn(t, now);
    }
    expect(t.phase).toBe('waiting');
    // Between that turn's chunks nothing streams: the bubble says waiting, not thinking.
    expect(deriveTurnDisplay({ streaming: false, phase: t.phase, awaitingReply: true })).toBe('waiting');
    // While it streams, the shared stream shows, as it does for everyone.
    expect(deriveTurnDisplay({ streaming: true, phase: t.phase, awaitingReply: true })).toBe('streaming');
  });

  // Mutation: exempt a waiting post from the idle check → it waits for ever in silence.
  it('fails like any other once a whole idle window passes with no signal at all', () => {
    let t = signalOtherTurn(startTurn(0), 1000);
    t = evaluateTurn(t, 1000 + TURN_IDLE_MS + 1);
    expect(t.phase).toBe('failed');
  });

  it('becomes my own turn when its chunks arrive, and settles when the answer lands', () => {
    let t = signalOtherTurn(startTurn(0), 1000);
    t = signalTurn(t, 2000);
    expect(t.phase).toBe('awaiting');
    t = settleTurn(t);
    expect(signalOtherTurn(t, 3000).phase).toBe('settled');
  });
});

describe('what a running turn\'s stream says it is doing', () => {
  it('counts the loop\'s steps and names the latest line, a call being prepared included', async () => {
    const { streamSteps, stepLine, pendingLine } = await import('../src/turn-liveness');
    const text = 'I will write the view.' + pendingLine('write_file') + stepLine('wrote src/App.vue')
      + 'Now the build.' + stepLine('building…');
    expect(streamSteps(text)).toEqual({ count: 2, latest: 'building…' });
    // A call the model has begun is the latest thing happening, and is not yet a step.
    expect(streamSteps(text + pendingLine('edit_file'))).toEqual({ count: 2, latest: 'preparing edit_file…' });
    // Thinking that merely contains the glyph mid-line is not a step.
    expect(streamSteps('use ▸ as a bullet')).toEqual({ count: 0, latest: undefined });
  });

  it('a step lands on its own line whatever text came before it', async () => {
    const { streamSteps, stepLine } = await import('../src/turn-liveness');
    expect(streamSteps('thinking with no newline' + stepLine('read src/App.vue')).count).toBe(1);
    expect(streamSteps(stepLine('read a') + stepLine('read b')).count).toBe(2);
  });

  it('formats elapsed seconds as a clock', async () => {
    const { formatElapsed } = await import('../src/turn-liveness');
    expect([0, 7, 60, 134.9, 725].map(formatElapsed)).toEqual(['0:00', '0:07', '1:00', '2:14', '12:05']);
  });
});

describe('previewLocked', () => {
  it('locks while a turn runs or waits its turn, and never on a failed or settled one', async () => {
    const { previewLocked } = await import('../src/turn-liveness');
    expect((['streaming', 'thinking', 'waiting'] as const).map(previewLocked)).toEqual([true, true, true]);
    // A lost turn must not leave the preview locked: `failed` is what the idle window turns a hang into.
    expect((['failed', 'none'] as const).map(previewLocked)).toEqual([false, false]);
  });
});
