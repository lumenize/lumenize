/**
 * A reply the far side authored is re-read as a nested marker and executed.
 *
 * **Why this tier and not `/live`** (`.claude/rules/live.md` puts that reason on the test file,
 * which outlives the task file): these are properties of the framework's own substitution sites —
 * `dispatchEnvelope`'s local handler, `fireResponse`'s node-to-node fire-back, and the appended
 * branch a reaper uses. Each needs a node that RECORDS an injected call, and in `/live` that would
 * mean shipping a recorder into `apps/nebula`'s production Star or Galaxy — the same argument
 * § *Criteria* already accepts for the member-kind limbs. This lane drives a real Worker-to-DO and
 * DO-to-DO hop in workerd, so it is a venue swap, not a drop to a cheaper tier; the fire-back leg
 * in particular is structurally unreachable from a browser, which can only ever address
 * `__executeOperation` through the Gateway.
 *
 * Every payload is harmless: the injected chain names a recorder, never a destructive call.
 *
 * Written RED-first: each limb below ran the injected chain before the fix — on the fire-back, on
 * the appended branch and on the local-handler path alike — which is what shows the hole was real.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';

/** The chain an injected value carries. It names a recorder, so a red run destroys nothing. */
const INJECTED_CHAIN = (tag: string) => [
  { type: 'get', key: 'recordInjected' },
  { type: 'apply', args: [tag] },
];

/** A value shaped like a nested marker, as JSON — a string crosses the request leg unresolved. */
const markerShapedJson = (tag: string) => JSON.stringify({
  __isNestedOperation: true,
  __operationChain: INJECTED_CHAIN(tag),
  payload: `reply-${tag}`,
});

/**
 * A caller with its identity set, its probe storage cleared, ready to fire.
 * `lmz.call` sync-throws without a binding name, and a direct stub RPC never sets one — identity
 * normally arrives from `routeDORequest` headers or an inbound envelope.
 */
async function freshCaller(name: string) {
  const caller = env.TEST_DO.getByName(name);
  await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
  await caller.clearMarkerProbe();
  return caller;
}

/** The fire-back is one-way and lands post-ack, so every readback waits for the handler to run. */
async function awaitHandler(caller: { getHandlerReceived: () => Promise<unknown> }): Promise<unknown> {
  await vi.waitFor(async () => {
    expect(await caller.getHandlerReceived()).toBeDefined();
  });
  return await caller.getHandlerReceived();
}

describe('a filled chain is data — the executor never resolves it', () => {
  it('does not run an injected chain on the node-to-node FIRE-BACK', async () => {
    const caller = await freshCaller('r1-fireback-caller');
    caller.testCallForMarkerReply('TEST_DO', 'r1-fireback-callee', markerShapedJson('fire-back'));

    const received = await awaitHandler(caller) as Record<string, unknown>;
    expect(await caller.getInjectedRan(), 'the injected chain must not have run').toEqual([]);
    expect(received.payload, 'the handler must receive the reply itself').toBe('reply-fire-back');
  });

  it('does not run an injected chain when the result is APPENDED (the reaper shape)', async () => {
    const caller = await freshCaller('r1-appended-caller');
    caller.testCallForMarkerReplyAppended(
      'TEST_DO', 'r1-appended-callee', markerShapedJson('appended'), 'query-hash-1',
    );

    const received = await awaitHandler(caller) as Record<string, unknown>;
    expect(await caller.getInjectedRan(), 'the injected chain must not have run').toEqual([]);
    expect(received.payload, 'the reaper-shaped handler must receive the reply itself')
      .toBe('reply-appended');
  });

  it('does not run an injected chain on the LOCAL handler path (an admission reject)', async () => {
    const caller = await freshCaller('r1-local-caller');
    caller.testCallToMarkerRejecter('MARKER_REJECTING_DO', 'r1-local-rejecter');

    const received = await awaitHandler(caller);
    expect(await caller.getInjectedRan(), 'the injected chain must not have run').toEqual([]);
    expect(String((received as { message?: string })?.message),
      'the handler must receive the Error itself')
      .toMatch(/admission rejected with a marker-shaped error/);
  });

  it('delivers a result carrying BOTH marker keys intact and unexecuted (ADR-002)', async () => {
    // What rules out closing R1 by neutralising the value — stripping or renaming the two keys
    // would satisfy every limb above and contradict ADR-002's full structured-clone round trip.
    const caller = await freshCaller('r1-fidelity-caller');
    caller.testCallForMarkerReply('TEST_DO', 'r1-fidelity-callee', markerShapedJson('fidelity'));

    const received = await awaitHandler(caller) as Record<string, unknown>;
    expect(await caller.getInjectedRan()).toEqual([]);
    expect(received.__isNestedOperation, 'the key must arrive INTACT, not stripped').toBe(true);
    expect(received.__operationChain, 'the chain must arrive intact too')
      .toEqual(INJECTED_CHAIN('fidelity'));
  });

  /**
   * GREEN before and after: a wire-borne chain cannot turn into a stored continuation.
   *
   * § *Gotchas*, item 2 of `tasks/mesh-entry-and-walk-gaps.md` answers this from source —
   * `Alarms.schedule` recovers a chain only through a module-scoped WeakMap of proxies registered
   * in THIS isolate, and a hand-shaped nested marker resolves to its RESULT before it reaches the
   * argument list. ⚠️ The closing mechanism is a HANG, not a refusal: the executor awaits every
   * apply and a continuation proxy is a never-settling thenable. So the limb is a BOUNDED WAIT
   * over the schedule count, never a message match.
   */
  it('cannot turn a wire-borne chain into a stored continuation', async () => {
    const node = env.TEST_DO.getByName('alarm-wire-chain');
    const before = await node.countSchedules();
    const outcome = await node.testBoundedChain([
      { type: 'get', key: 'svc' },
      { type: 'get', key: 'alarms' },
      { type: 'get', key: 'schedule' },
      { type: 'apply', args: [
        Date.now() + 60_000,
        // ⚠️ A MARKED member, deliberately. An undecorated one is refused by the member-level
        // check before the argument list is ever built, so the limb would go green without
        // reaching the alarm mechanism at all — vacuous, and green on any tree.
        { __isNestedOperation: true, __operationChain: [
          { type: 'get', key: 'double' }, { type: 'apply', args: [21] },
        ] },
      ] },
    ], 1_000);
    expect(await node.countSchedules(), 'no stored continuation may appear').toBe(before);
    // The marker arrives as its RESULT (`42`), and a number is not a continuation — so `schedule`
    // refuses it. That refusal IS the mechanism, and it is what a raw-chain-accepting `schedule`
    // would turn into a stored row.
    expect(outcome, 'the resolved value must not be storable as a continuation').toMatch(/^REFUSED/);
  });

  // ── positive control: a TEMPLATE's final apply still resolves legitimate nesting, which is what
  //    pins the two entry points apart. An executor that simply stopped resolving would satisfy
  //    every limb above and break this one. (`test/for-docs/calls/calculator-client.ts` is the
  //    published browser-client version of the same control.)
  it('still resolves a genuine nested marker in a TEMPLATE chain', async () => {
    const caller = env.TEST_DO.getByName('r1-template-control');
    const result = await caller.testNestedTemplate();
    expect(result).toBe(30);
  });
});
