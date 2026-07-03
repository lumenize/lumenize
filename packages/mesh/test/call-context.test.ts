import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * CallContext propagation through the continuation-only call model.
 *
 * `callRaw`'s awaited result is gone, so instead of reading the callee's observed context off a
 * return value, we drive the REAL `call()`+fire-back path and read it two ways:
 *  - callee-side capture: fire a 3-arg `call` to a method that stores `this.lmz.callContext` in
 *    its own KV (`captureContext`/`captureAndForward`/`setStateAndForward`); read the callee's KV.
 *  - fire-back outcome: fire a 4-arg `call` whose handler stores the delivered value OR Error
 *    (`callForOutcome` → `getLastCallResult`/`getLastCallError`); used for @mesh + guard gating,
 *    whose failures are post-ack chain throws that ride the fire-back.
 * Callers that receive a fire-back init to their REAL binding+instance (the fire-back routes to
 * `env[bindingName].getByName(instanceName)`).
 */
describe('@lumenize/mesh - CallContext Propagation', () => {
  describe('Basic callContext structure', () => {
    it('callChain[0] is the origin when a DO calls another DO', async () => {
      const caller = env.TEST_DO.getByName('caller-do-1');
      const callee = env.TEST_DO.getByName('callee-do-1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller-do-1' });

      caller.fireCall('TEST_DO', 'callee-do-1', 'captureContext');

      const ctx = await vi.waitFor(async () => {
        const c = await callee.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      expect(ctx.callChain[0]).toMatchObject({ type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'caller-do-1' });
    });

    it('callee gets its own identity from this.lmz', async () => {
      const caller = env.TEST_DO.getByName('caller-callee-test-1');
      const callee = env.TEST_DO.getByName('callee-callee-test-1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller-callee-test-1' });

      caller.fireCall('TEST_DO', 'callee-callee-test-1', 'captureContext');

      const identity = await vi.waitFor(async () => {
        const i = await callee.getObservedIdentity();
        expect(i).toBeDefined();
        return i;
      });
      expect(identity).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'callee-callee-test-1' });
    });

    it('callChain has one element (origin) when origin calls directly', async () => {
      const caller = env.TEST_DO.getByName('chain-empty-1');
      const callee = env.TEST_DO.getByName('chain-empty-2');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'chain-empty-1' });

      caller.fireCall('TEST_DO', 'chain-empty-2', 'captureContext');

      const ctx = await vi.waitFor(async () => {
        const c = await callee.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      expect(ctx.callChain).toHaveLength(1);
      expect(ctx.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'chain-empty-1' });
    });
  });

  describe('Multi-hop call chains (DO → DO → DO)', () => {
    it('callChain accumulates through hops', async () => {
      const doA = env.TEST_DO.getByName('chain-a');
      const doB = env.TEST_DO.getByName('chain-b');
      const doC = env.TEST_DO.getByName('chain-c');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'chain-a' });

      // A → B(capture + forward) → C(capture)
      doA.fireCall('TEST_DO', 'chain-b', 'captureAndForward', ['TEST_DO', 'chain-c']);

      const cCtx = await vi.waitFor(async () => {
        const c = await doC.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      const bCtx = await doB.getObservedContext();

      // B saw just the origin [A]; C saw [A, B].
      expect(bCtx.callChain).toHaveLength(1);
      expect(bCtx.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'chain-a' });
      expect(cCtx.callChain).toHaveLength(2);
      expect(cCtx.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'chain-a' });
      expect(cCtx.callChain[1]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'chain-b' });
    });
  });

  describe('DO → Worker → DO call chains', () => {
    it('Worker propagates callContext to the downstream DO', async () => {
      const doA = env.TEST_DO.getByName('do-worker-do-1');
      const target = env.TEST_DO.getByName('do-worker-do-target');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'do-worker-do-1' });

      // A → Worker(forwardCapture) → target DO(capture)
      doA.fireCall('TEST_WORKER', undefined, 'forwardCapture', ['TEST_DO', 'do-worker-do-target']);

      const ctx = await vi.waitFor(async () => {
        const c = await target.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      // Final DO sees [do-worker-do-1 (origin), worker (caller)].
      expect(ctx.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'do-worker-do-1' });
      expect(ctx.callChain).toHaveLength(2);
      expect(ctx.callChain[1].type).toBe('LumenizeWorker');
    });
  });

  describe('Caller accessor pattern (callChain.at(-1))', () => {
    it('at(-1) is the origin when origin calls directly', async () => {
      const doA = env.TEST_DO.getByName('caller-getter-1');
      const doB = env.TEST_DO.getByName('caller-getter-2');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller-getter-1' });

      doA.fireCall('TEST_DO', 'caller-getter-2', 'captureContext');

      const ctx = await vi.waitFor(async () => {
        const c = await doB.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      expect(ctx.callChain.at(-1)).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'caller-getter-1' });
    });

    it('at(-1) is the last hop in a multi-hop chain', async () => {
      const doA = env.TEST_DO.getByName('caller-chain-1');
      const doC = env.TEST_DO.getByName('caller-chain-3');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller-chain-1' });

      doA.fireCall('TEST_DO', 'caller-chain-2', 'captureAndForward', ['TEST_DO', 'caller-chain-3']);

      const ctx = await vi.waitFor(async () => {
        const c = await doC.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      // C's callChain = [A, B]; at(-1) = B.
      expect(ctx.callChain).toHaveLength(2);
      expect(ctx.callChain.at(-1)).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'caller-chain-2' });
    });
  });

  describe('State propagation', () => {
    it('state modifications propagate to downstream calls', async () => {
      const doA = env.TEST_DO.getByName('state-prop-1');
      const doC = env.TEST_DO.getByName('state-prop-3');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'state-prop-1' });

      // B sets state.traceId then forwards to C, which captures it.
      doA.fireCall('TEST_DO', 'state-prop-2', 'setStateAndForward', ['TEST_DO', 'state-prop-3', 'traceId', 'trace-12345']);

      const ctx = await vi.waitFor(async () => {
        const c = await doC.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      expect(ctx.state).toHaveProperty('traceId', 'trace-12345');
    });

    it('state starts empty for fresh call chains', async () => {
      const doA = env.TEST_DO.getByName('state-empty-1');
      const doB = env.TEST_DO.getByName('state-empty-2');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'state-empty-1' });

      doA.fireCall('TEST_DO', 'state-empty-2', 'captureContext');

      const ctx = await vi.waitFor(async () => {
        const c = await doB.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      expect(ctx.state).toEqual({});
    });
  });

  describe('@mesh decorator security', () => {
    it('blocks calls to methods without @mesh (error delivered to handler)', async () => {
      const caller = env.TEST_DO.getByName('mesh-security-1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'mesh-security-1' });

      caller.callForOutcome('TEST_DO', 'mesh-security-2', 'nonMeshMethod');

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toMatch(/not mesh-callable/);
    });

    it('allows calls to @mesh methods', async () => {
      const caller = env.TEST_DO.getByName('mesh-allowed-1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'mesh-allowed-1' });

      caller.callForOutcome('TEST_DO', 'mesh-allowed-2', 'remoteEcho', ['hello']);

      await vi.waitFor(async () => {
        expect(await caller.getLastCallResult()).toBe('echo: hello');
      });
    });
  });

  describe('@mesh(guard) security', () => {
    it('guard blocks the call when the condition is not met', async () => {
      const caller = env.TEST_DO.getByName('guard-block-caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard-block-caller' });

      caller.callForOutcome('TEST_DO', 'guard-block-callee', 'guardedAdminMethod'); // no role in state

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Guard: admin role required');
    });

    it('guard allows the call when the condition is met', async () => {
      const caller = env.TEST_DO.getByName('guard-allow-caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard-allow-caller' });

      caller.callForOutcome('TEST_DO', 'guard-allow-callee', 'guardedAdminMethod', [], { role: 'admin' });

      await vi.waitFor(async () => {
        expect(await caller.getLastCallResult()).toBe('admin-only-result');
      });
    });

    it('guard checks authentication (userId in state)', async () => {
      const caller = env.TEST_DO.getByName('guard-auth-caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard-auth-caller' });

      caller.callForOutcome('TEST_DO', 'guard-auth-callee', 'guardedAuthMethod'); // no userId

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Guard: authentication required');
    });

    it('async guard works correctly', async () => {
      const caller = env.TEST_DO.getByName('guard-async-caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard-async-caller' });

      caller.callForOutcome('TEST_DO', 'guard-async-callee', 'guardedMethod'); // no valid token

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Guard: valid token required');
    });

    it('Worker: guard blocks call when condition not met', async () => {
      const caller = env.TEST_DO.getByName('worker-guard-block-caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker-guard-block-caller' });

      caller.callForOutcome('TEST_WORKER', undefined, 'guardedWorkerAdminMethod');

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Worker Guard: admin role required');
    });

    it('Worker: guard checks authentication (userId in state)', async () => {
      const caller = env.TEST_DO.getByName('worker-guard-auth-caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker-guard-auth-caller' });

      caller.callForOutcome('TEST_WORKER', undefined, 'guardedWorkerAuthMethod');

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Worker Guard: authentication required');
    });

    it('Worker: async guard works correctly', async () => {
      const caller = env.TEST_DO.getByName('worker-guard-async-caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker-guard-async-caller' });

      caller.callForOutcome('TEST_WORKER', undefined, 'guardedWorkerMethod');

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Worker Guard: valid token required');
    });
  });

  describe('onBeforeCall hook', () => {
    it('onBeforeCall runs before method execution (call still succeeds)', async () => {
      const caller = env.TEST_DO.getByName('before-call-1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'before-call-1' });

      caller.callForOutcome('TEST_DO', 'before-call-2', 'remoteEcho', ['test']);

      await vi.waitFor(async () => {
        expect(await caller.getLastCallResult()).toBe('echo: test');
      });
    });
  });

  describe('ALS isolation for concurrent calls', () => {
    it('concurrent calls have isolated callContext (no cross-contamination)', async () => {
      const callerA = env.TEST_DO.getByName('als-isolation-caller-a');
      const callerB = env.TEST_DO.getByName('als-isolation-caller-b');
      const calleeA = env.TEST_DO.getByName('als-isolation-callee-a');
      const calleeB = env.TEST_DO.getByName('als-isolation-callee-b');
      await callerA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'als-isolation-caller-a' });
      await callerB.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'als-isolation-caller-b' });

      // Concurrent calls from different origins to distinct callees.
      callerA.fireCall('TEST_DO', 'als-isolation-callee-a', 'captureContext');
      callerB.fireCall('TEST_DO', 'als-isolation-callee-b', 'captureContext');

      const [ctxA, ctxB] = await vi.waitFor(async () => {
        const a = await calleeA.getObservedContext();
        const b = await calleeB.getObservedContext();
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        return [a, b];
      });
      expect(ctxA.callChain[0].instanceName).toBe('als-isolation-caller-a');
      expect(ctxB.callChain[0].instanceName).toBe('als-isolation-caller-b');
    });
  });

  describe('Two-one-way calls (callback pattern)', () => {
    it('callback call PRESERVES original callContext (origin stays the same)', async () => {
      const origin = env.TEST_DO.getByName('two-one-way-origin');
      const target = env.TEST_DO.getByName('two-one-way-target');
      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two-one-way-origin' });
      await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two-one-way-target' });
      await origin.clearTwoOneWayResult();

      origin.initiateTwoOneWayCall('TEST_DO', 'two-one-way-target', 'test-marker-123');

      const result = await vi.waitFor(async () => {
        const r = await origin.getTwoOneWayResult();
        expect(r).toBeTruthy();
        return r;
      });

      expect(result.marker).toBe('test-marker-123');
      // Target's incoming context shows origin as callChain[0].
      expect(result.targetIncomingContext.callChain[0]).toMatchObject({
        type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'two-one-way-origin',
      });
      // The callback's context preserves the ORIGINAL origin, with target appended.
      expect(result.callbackContext.callChain[0]).toMatchObject({ instanceName: 'two-one-way-origin' });
      expect(result.callbackContext.callChain).toHaveLength(2);
      expect(result.callbackContext.callChain[1]).toMatchObject({ instanceName: 'two-one-way-target' });
    });

    it('callChain.at(-1) gives the immediate caller (the callback maker)', async () => {
      const origin = env.TEST_DO.getByName('two-one-way-caller-origin');
      const target = env.TEST_DO.getByName('two-one-way-caller-target');
      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two-one-way-caller-origin' });
      await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two-one-way-caller-target' });
      await origin.clearTwoOneWayResult();

      origin.initiateTwoOneWayCall('TEST_DO', 'two-one-way-caller-target', 'caller-test');

      const result = await vi.waitFor(async () => {
        const r = await origin.getTwoOneWayResult();
        expect(r).toBeTruthy();
        return r;
      });

      expect(result.callbackContext.callChain.at(-1)).toMatchObject({ instanceName: 'two-one-way-caller-target' });
      expect(result.callbackContext.callChain[0].instanceName).toBe('two-one-way-caller-origin');
    });
  });

  describe('CallContext in continuation handlers', () => {
    it('callContext.state is visible to the fire-back handler', async () => {
      const origin = env.TEST_DO.getByName('context-capture-origin');
      const caller = env.TEST_DO.getByName('context-capture-caller');
      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'context-capture-origin' });
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'context-capture-caller' });

      // origin → caller.testContextCaptureInHandler → (4-arg) callee → handler on caller.
      origin.fireCall('TEST_DO', 'context-capture-caller', 'testContextCaptureInHandler',
        ['TEST_DO', 'context-capture-callee', 'unique-marker-123']);

      const verification = await vi.waitFor(async () => {
        const v = await caller.getContextCaptureVerification();
        expect(v).toBeDefined();
        return v as any;
      });
      expect(verification.matches).toBe(true);
      expect(verification.actualMarker).toBe('unique-marker-123');
    });

    it('interleaved fire-back handlers each see their own captured state', async () => {
      const origin = env.TEST_DO.getByName('interleave-capture-origin');
      const caller = env.TEST_DO.getByName('interleave-capture-caller');
      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'interleave-capture-origin' });
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'interleave-capture-caller' });
      await caller.clearInterleavedResults();

      const markers = ['alpha', 'beta', 'gamma', 'delta'];
      origin.fireCall('TEST_DO', 'interleave-capture-caller', 'testInterleavedContextCapture',
        ['TEST_DO', 'interleave-capture-callee', markers]);

      const results = await vi.waitFor(async () => {
        const r = await caller.getInterleavedResults() as any[];
        expect(r?.length).toBe(markers.length);
        return r;
      });
      for (const result of results) expect(result.matches).toBe(true);
      expect(results.map((r: any) => r.expectedMarker).sort()).toEqual([...markers].sort());
    });
  });
});
