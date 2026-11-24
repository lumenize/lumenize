/**
 * A galaxy's certificate pack — the decisions, asserted as pure functions.
 *
 * In-lane on purpose (`live.md` § *`/live` is the DEFAULT tier*): the ordering machine, the teardown
 * steps and the pack predicate are pure functions of stored state and the last API answer, and the
 * local stack's `http` origin orders nothing, so no running system reaches them before a deployment.
 * `galaxy-certificate.test.ts` drives the Galaxy that executes them against a fake API.
 */
import { describe, it, expect } from 'vitest';
import {
  afterCall, nextCall, onWake, packHosts, packNamesGalaxy, teardownSteps, POLL_SECONDS,
  type CertificateCall, type CertificateResult, type CertificateState,
} from '../src/certificate';

/** Drive the machine through wakes and alarms against a scripted API, counting orders. */
function drive(events: Array<'wake' | 'alarm'>, answers: CertificateResult[]): { orders: number; state: CertificateState; armed: boolean } {
  let state: CertificateState = { wanted: false };
  let armed = false;
  let orders = 0;
  for (const event of events) {
    if (event === 'wake') {
      const woke = onWake(state, false);
      state = woke.state;
      armed ||= woke.arm;
      continue;
    }
    if (!armed) continue;
    armed = false;
    const call: CertificateCall = nextCall(state, false, false);
    if (call.kind === 'none') continue;
    if (call.kind === 'order') orders++;
    const next = afterCall(state, answers.shift()!);
    state = next.state;
    armed = next.rearmSeconds !== undefined;
  }
  return { orders, state, armed };
}

const pending: CertificateResult = { ok: true, packId: 'p1', status: 'pending_validation' };
const active: CertificateResult = { ok: true, packId: 'p1', status: 'active' };

describe('the ordering machine', () => {
  it('two wakes order once: the wake only arms, and the alarm is the one caller', () => {
    expect(drive(['wake', 'wake', 'alarm'], [pending]).orders).toBe(1);
  });

  it('a stored pack is polled, never ordered again', () => {
    expect(nextCall({ wanted: true, packId: 'p1', status: 'pending_validation' }, false, false))
      .toEqual({ kind: 'poll', packId: 'p1' });
    expect(drive(['wake', 'alarm', 'wake', 'alarm'], [pending, pending]).orders).toBe(1);
  });

  it('a wake while an order is in flight orders nothing', () => {
    expect(nextCall({ wanted: true }, true, false)).toEqual({ kind: 'none' });
  });

  it('a transient failure schedules a retry with a growing backoff; a lasting one stops', () => {
    const once = afterCall({ wanted: true }, { ok: false, transient: true });
    expect(once.rearmSeconds).toBe(POLL_SECONDS);
    expect(afterCall(once.state, { ok: false, transient: true }).rearmSeconds).toBe(POLL_SECONDS * 2);
    expect(afterCall({ wanted: true }, { ok: false, transient: false }).rearmSeconds).toBeUndefined();
  });

  it('a pending pack re-arms, and an active one stops the alarm', () => {
    expect(afterCall({ wanted: true }, pending).rearmSeconds).toBe(POLL_SECONDS);
    expect(afterCall({ wanted: true }, active).rearmSeconds).toBeUndefined();
    const run = drive(['wake', 'alarm', 'alarm', 'alarm'], [pending, active]);
    expect(run.state.status).toBe('active');
    expect(run.armed).toBe(false);
  });

  it('a final status that is not active stops the alarm, and a later wake neither polls nor orders', () => {
    const timedOut: CertificateResult = { ok: true, packId: 'p1', status: 'validation_timed_out' };
    const after = afterCall({ wanted: true }, timedOut);
    expect(after.rearmSeconds).toBeUndefined();
    expect(onWake(after.state, false).arm).toBe(false);
    expect(nextCall(after.state, false, false)).toEqual({ kind: 'none' });
    // Still in progress on the way to active: polled again.
    expect(afterCall({ wanted: true }, { ok: true, packId: 'p1', status: 'pending_deployment' }).rearmSeconds).toBe(POLL_SECONDS);
  });

  it('nothing is ordered during a teardown, and a wake then arms nothing', () => {
    expect(nextCall({ wanted: true }, false, true)).toEqual({ kind: 'none' });
    expect(onWake({ wanted: false }, true).arm).toBe(false);
  });
});

describe('teardown is a state of the same machine', () => {
  it('disarm is always first; the in-flight order is awaited before the list; http wipes alone', () => {
    expect(teardownSteps(true, false)).toEqual(['disarm', 'deletePacksNamingHost', 'wipe']);
    expect(teardownSteps(true, true)).toEqual(['disarm', 'awaitOrder', 'deletePacksNamingHost', 'wipe']);
    expect(teardownSteps(false, true)).toEqual(['disarm', 'wipe']);
  });
});

describe("a pack belongs to its galaxy by the galaxy's own names", () => {
  const host = 'crm.acme.lumenize.dev';
  it("the galaxy's host or its wildcard matches", () => {
    expect(packNamesGalaxy(packHosts('lumenize.dev', host), host)).toBe(true);
    expect(packNamesGalaxy(['lumenize.dev', `*.${host}`], host)).toBe(true);
  });

  it('an apex-only pack, a neighbour sharing a suffix, and another universe do not', () => {
    expect(packNamesGalaxy(['lumenize.dev'], host)).toBe(false);
    expect(packNamesGalaxy(packHosts('lumenize.dev', 'xcrm.acme.lumenize.dev'), host)).toBe(false);
    expect(packNamesGalaxy(packHosts('lumenize.dev', 'crm.acme2.lumenize.dev'), host)).toBe(false);
  });
});
