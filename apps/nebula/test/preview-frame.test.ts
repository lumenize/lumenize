/**
 * Studio's choice among asking its preview frame to reload, asking again, and setting the frame's
 * address (`decidePreviewFrame`). In-lane: the decision is a pure function by design (calibration
 * §12), so a table pins every arm. `build-reaches-every-studio` drives the same arms in a running
 * Studio, where each limb names the arm it reds on.
 */
import { describe, it, expect } from 'vitest';
import {
  decidePreviewFrame, LOAD_SILENCE_MS, type PreviewFrameEvent, type PreviewFrameState,
} from '../src/preview-frame';

/** Run `events` from `state`, returning every action's kind and the final state. */
function run(state: PreviewFrameState, events: PreviewFrameEvent[]): { actions: string[]; state: PreviewFrameState } {
  const actions: string[] = [];
  for (const e of events) {
    const out = decidePreviewFrame(state, e);
    state = out.state;
    actions.push(out.action.kind === 'ask' ? `ask:${out.action.request.id}:${out.action.request.build ?? '-'}` : out.action.kind);
  }
  return { actions, state };
}

describe('decidePreviewFrame', () => {
  it('asks on a first value and on a changed one, and not on a repeat', () => {
    // Mutation: drop the repeat check → the third value asks again → red.
    const { actions } = run({}, [
      { type: 'value', build: 'b1', id: 'r1' },
      { type: 'value', build: 'b2', id: 'r2' },
      { type: 'value', build: 'b2', id: 'r3' },
    ]);
    expect(actions).toEqual(['ask:r1:b1', 'ask:r2:b2', 'none']);
  });

  it('on an unsolicited loaded, whatever build it names, sends the current request once more, then stops', () => {
    // Mutation: resend on every unsolicited loaded → the second one asks again → red.
    const { actions } = run({}, [
      { type: 'value', build: 'b1', id: 'r1' },
      { type: 'loaded', id: 'r1', at: 1, resendId: 'x' },
      { type: 'loaded', at: 2, resendId: 'r2' },
      { type: 'loaded', at: 3, resendId: 'r3' },
    ]);
    expect(actions).toEqual(['ask:r1:b1', 'none', 'ask:r2:b1', 'none']);
  });

  it('resends a request sent before the load\'s loaded when that loaded comes', () => {
    const { actions, state } = run({}, [
      { type: 'value', build: 'b1', id: 'r1' },
      { type: 'loaded', at: 5, resendId: 'r2' },
      { type: 'no-echo', id: 'r1' },
      { type: 'loaded', id: 'r2', at: 6, resendId: 'x' },
    ]);
    // The first request's window running out sets nothing: its resend is the one pending.
    expect(actions).toEqual(['ask:r1:b1', 'ask:r2:b1', 'none', 'none']);
    expect(state.pending).toBeUndefined();
  });

  it('a new value after a resend is asked, and resent once on the next unsolicited loaded', () => {
    const { actions } = run({}, [
      { type: 'value', build: 'b1', id: 'r1' },
      { type: 'loaded', at: 1, resendId: 'r2' },
      { type: 'value', build: 'b2', id: 'r3' },
      { type: 'loaded', at: 2, resendId: 'r4' },
    ]);
    expect(actions).toEqual(['ask:r1:b1', 'ask:r2:b1', 'ask:r3:b2', 'ask:r4:b2']);
  });

  it('sets the address after a load with no loaded from that load', () => {
    // Mutation: ignore `load-settled` → the frame with no client is never moved → red.
    const { actions } = run({}, [
      { type: 'value', build: 'b1', id: 'r1' },
      { type: 'load-settled', loadAt: 10_000 },
    ]);
    expect(actions).toEqual(['ask:r1:b1', 'set-address']);
  });

  it('a loaded just before the load event counts as that load\'s', () => {
    const { actions } = run({}, [
      { type: 'value', build: 'b1', id: 'r1' },
      { type: 'loaded', at: 10_000 - LOAD_SILENCE_MS + 1, resendId: 'r2' },
      { type: 'load-settled', loadAt: 10_000 },
    ]);
    expect(actions).toEqual(['ask:r1:b1', 'ask:r2:b1', 'none']);
  });

  it('a silent load with nothing pending sets nothing', () => {
    // Mutation: set the address on every silent load → a no-client app reloads forever → red.
    expect(run({}, [{ type: 'load-settled', loadAt: 1_000 }]).actions).toEqual(['none']);
  });

  it('sets the address after a request with no echo, once', () => {
    const { actions } = run({}, [
      { type: 'value', build: 'b1', id: 'r1' },
      { type: 'no-echo', id: 'r1' },
      { type: 'no-echo', id: 'r1' },
    ]);
    expect(actions).toEqual(['ask:r1:b1', 'set-address', 'none']);
  });

  it('never forces a frame that echoed, whatever build its echo names', () => {
    // Mutation: fall back on an echo naming another build (a frame showing a banner) → red.
    const { actions } = run({}, [
      { type: 'value', build: 'b2', id: 'r1' },
      { type: 'loaded', id: 'r1', at: 1, resendId: 'x' },
      { type: 'no-echo', id: 'r1' },
      { type: 'load-settled', loadAt: 2 },
    ]);
    expect(actions).toEqual(['ask:r1:b2', 'none', 'none', 'none']);
  });

  it('the Reload button asks naming no build, and its own load answers it', () => {
    // Mutation: resend a pending button request on the load it caused → the frame reloads again → red.
    const { actions, state } = run({ build: 'b1', resentFor: 'b1' }, [
      { type: 'button', id: 'k1' },
      { type: 'loaded', at: 1, resendId: 'x' },
    ]);
    expect(actions).toEqual(['ask:k1:-', 'none']);
    expect(state.pending).toBeUndefined();
  });

  it('the Reload button on a frame with no client sets the address when its echo window runs out', () => {
    expect(run({}, [{ type: 'button', id: 'k1' }, { type: 'no-echo', id: 'k1' }]).actions)
      .toEqual(['ask:k1:-', 'set-address']);
  });
});
