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
import { startTurn, signalTurn, settleTurn, evaluateTurn, deriveTurnDisplay, TURN_IDLE_MS } from '../src/turn-liveness';
import { ACCESS_TOKEN_TTL } from '@lumenize/nebula-auth';
import { GENERATION_DEADLINE_MS } from '../src/galaxy';

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

/**
 * The generation deadline is an AUTHORIZATION bound, not just a timeout — asserted here
 * because nothing else would catch it being raised. A triggered turn runs detached under
 * the poster's `callContext`, whose claims are verified at post time and never
 * re-verified at the write, so a turn allowed to outrun `ACCESS_TOKEN_TTL` would commit
 * under claims that had already expired. Keeping it strictly under the TTL is what holds
 * the write inside the revocation exposure `security.md` already accepts.
 */
describe('generation deadline vs the access-token lifetime', () => {
  it('a turn cannot outlive the token whose claims it commits under', () => {
    // The SHIPPED constant, imported — not a copy. A copy would keep passing after
    // someone raised the real deadline, which is the whole failure this guards.
    expect(GENERATION_DEADLINE_MS).toBeLessThan(ACCESS_TOKEN_TTL * 1000);
  });
});
