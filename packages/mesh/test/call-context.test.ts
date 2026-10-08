import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * CallContext propagation through the continuation-only call model.
 *
 * `callRaw`'s awaited result is gone, so instead of reading the callee's observed context off a
 * return value, we drive the REAL `call()`+fire-back path and read it two ways:
 *  - callee-side capture: fire a `call` to a method that stores `this.lmz.callContext` in
 *    its own KV (`captureContext`/`captureAndForward`); read the callee's KV.
 *  - fire-back outcome: fire a `call` whose handler stores the delivered value OR Error
 *    (`callForOutcome` → `getLastCallResult`/`getLastCallError`); used for @mesh + guard gating,
 *    whose failures are post-ack chain throws that ride the fire-back.
 * Callers that receive a fire-back init to their REAL binding+instance (the fire-back routes to
 * `env[bindingName].getByName(instanceName)`).
 */
describe('@lumenize/mesh - CallContext Propagation', () => {
  describe('Basic callContext structure', () => {
    it('callChain[0] is the origin when a DO calls another DO', async () => {
      const caller = env.TEST_DO.getByName('caller_do_1');
      const callee = env.TEST_DO.getByName('callee_do_1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller_do_1' });

      caller.fireCall('TEST_DO', 'callee_do_1', 'captureContext');

      const ctx = await vi.waitFor(async () => {
        const c = await callee.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      expect(ctx.callChain[0]).toMatchObject({ type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'caller_do_1' });
    });

    it('callee gets its own identity from this.lmz', async () => {
      const caller = env.TEST_DO.getByName('caller_callee_test_1');
      const callee = env.TEST_DO.getByName('callee_callee_test_1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller_callee_test_1' });

      caller.fireCall('TEST_DO', 'callee_callee_test_1', 'captureContext');

      const identity = await vi.waitFor(async () => {
        const i = await callee.getObservedIdentity();
        expect(i).toBeDefined();
        return i;
      });
      expect(identity).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'callee_callee_test_1' });
    });

    it('callChain has one element (origin) when origin calls directly', async () => {
      const caller = env.TEST_DO.getByName('chain_empty_1');
      const callee = env.TEST_DO.getByName('chain_empty_2');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'chain_empty_1' });

      caller.fireCall('TEST_DO', 'chain_empty_2', 'captureContext');

      const ctx = await vi.waitFor(async () => {
        const c = await callee.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      expect(ctx.callChain).toHaveLength(1);
      expect(ctx.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'chain_empty_1' });
    });
  });

  describe('Multi-hop call chains (DO → DO → DO)', () => {
    it('callChain accumulates through hops', async () => {
      const doA = env.TEST_DO.getByName('chain_a');
      const doB = env.TEST_DO.getByName('chain_b');
      const doC = env.TEST_DO.getByName('chain_c');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'chain_a' });

      // A → B(capture + forward) → C(capture)
      doA.fireCall('TEST_DO', 'chain_b', 'captureAndForward', ['TEST_DO', 'chain_c']);

      const cCtx = await vi.waitFor(async () => {
        const c = await doC.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      const bCtx = await doB.getObservedContext();

      // B saw just the origin [A]; C saw [A, B].
      expect(bCtx.callChain).toHaveLength(1);
      expect(bCtx.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'chain_a' });
      expect(cCtx.callChain).toHaveLength(2);
      expect(cCtx.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'chain_a' });
      expect(cCtx.callChain[1]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'chain_b' });
    });
  });

  describe('DO → Worker → DO call chains', () => {
    it('Worker propagates callContext to the downstream DO', async () => {
      const doA = env.TEST_DO.getByName('do_worker_do_1');
      const target = env.TEST_DO.getByName('do_worker_do_target');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'do_worker_do_1' });

      // A → Worker(forwardCapture) → target DO(capture)
      doA.fireCall('TEST_WORKER', undefined, 'forwardCapture', ['TEST_DO', 'do_worker_do_target']);

      const ctx = await vi.waitFor(async () => {
        const c = await target.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      // Final DO sees [do-worker-do-1 (origin), worker (caller)].
      expect(ctx.callChain[0]).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'do_worker_do_1' });
      expect(ctx.callChain).toHaveLength(2);
      expect(ctx.callChain[1].type).toBe('LumenizeWorker');
    });
  });

  describe('Caller accessor pattern (callChain.at(-1))', () => {
    it('at(-1) is the origin when origin calls directly', async () => {
      const doA = env.TEST_DO.getByName('caller_getter_1');
      const doB = env.TEST_DO.getByName('caller_getter_2');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller_getter_1' });

      doA.fireCall('TEST_DO', 'caller_getter_2', 'captureContext');

      const ctx = await vi.waitFor(async () => {
        const c = await doB.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      expect(ctx.callChain.at(-1)).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'caller_getter_1' });
    });

    it('at(-1) is the last hop in a multi-hop chain', async () => {
      const doA = env.TEST_DO.getByName('caller_chain_1');
      const doC = env.TEST_DO.getByName('caller_chain_3');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller_chain_1' });

      doA.fireCall('TEST_DO', 'caller_chain_2', 'captureAndForward', ['TEST_DO', 'caller_chain_3']);

      const ctx = await vi.waitFor(async () => {
        const c = await doC.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      // C's callChain = [A, B]; at(-1) = B.
      expect(ctx.callChain).toHaveLength(2);
      expect(ctx.callChain.at(-1)).toMatchObject({ bindingName: 'TEST_DO', instanceName: 'caller_chain_2' });
    });
  });

  describe('No state in a call context', () => {
    it('a node\'s call carries no state field in its context', async () => {
      const doA = env.TEST_DO.getByName('state_empty_1');
      const doB = env.TEST_DO.getByName('state_empty_2');
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'state_empty_1' });

      doA.fireCall('TEST_DO', 'state_empty_2', 'captureContext');

      const ctx = await vi.waitFor(async () => {
        const c = await doB.getObservedContext();
        expect(c).toBeDefined();
        return c;
      });
      // A value a later hop needs travels as a continuation argument; there is no side channel.
      expect(ctx).not.toHaveProperty('state');
    });
  });

  describe('@mesh decorator security', () => {
    it('blocks calls to methods without @mesh (error delivered to handler)', async () => {
      const caller = env.TEST_DO.getByName('mesh_security_1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'mesh_security_1' });

      caller.callForOutcome('TEST_DO', 'mesh_security_2', 'nonMeshMethod');

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toMatch(/not mesh-callable/);
    });

    it('allows calls to @mesh methods', async () => {
      const caller = env.TEST_DO.getByName('mesh_allowed_1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'mesh_allowed_1' });

      caller.callForOutcome('TEST_DO', 'mesh_allowed_2', 'remoteEcho', ['hello']);

      await vi.waitFor(async () => {
        expect(await caller.getLastCallResult()).toBe('echo: hello');
      });
    });
  });

  describe('@mesh(guard) security', () => {
    it('guard blocks the call when the condition is not met', async () => {
      const caller = env.TEST_DO.getByName('guard_block_caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard_block_caller' });

      caller.callForOutcome('TEST_DO', 'guard_block_callee', 'guardedAdminMethod'); // origin is no "admin-" node

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Guard: admin role required');
    });

    it('guard allows the call when the condition is met', async () => {
      const caller = env.TEST_DO.getByName('admin_guard_allow_caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'admin_guard_allow_caller' });

      caller.callForOutcome('TEST_DO', 'guard_allow_callee', 'guardedAdminMethod');

      await vi.waitFor(async () => {
        expect(await caller.getLastCallResult()).toBe('admin-only-result');
      });
    });

    it('guard checks authentication (a sub in originAuth)', async () => {
      const caller = env.TEST_DO.getByName('guard_auth_caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard_auth_caller' });

      caller.callForOutcome('TEST_DO', 'guard_auth_callee', 'guardedAuthMethod'); // a direct call carries no originAuth

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Guard: authentication required');
    });

    it('async guard works correctly', async () => {
      const caller = env.TEST_DO.getByName('guard_async_caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard_async_caller' });

      caller.callForOutcome('TEST_DO', 'guard_async_callee', 'guardedMethod'); // no originAuth, so no token claim

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Guard: valid token required');
    });

    it('Worker: guard blocks call when condition not met', async () => {
      const caller = env.TEST_DO.getByName('worker_guard_block_caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker_guard_block_caller' });

      caller.callForOutcome('TEST_WORKER', undefined, 'guardedWorkerAdminMethod');

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Worker Guard: admin role required');
    });

    it('Worker: guard checks authentication (a sub in originAuth)', async () => {
      const caller = env.TEST_DO.getByName('worker_guard_auth_caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker_guard_auth_caller' });

      caller.callForOutcome('TEST_WORKER', undefined, 'guardedWorkerAuthMethod');

      const err = await vi.waitFor(async () => {
        const e = await caller.getLastCallError();
        expect(e).toBeTruthy();
        return e as string;
      });
      expect(err).toContain('Worker Guard: authentication required');
    });

    it('Worker: async guard works correctly', async () => {
      const caller = env.TEST_DO.getByName('worker_guard_async_caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker_guard_async_caller' });

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
      const caller = env.TEST_DO.getByName('before_call_1');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'before_call_1' });

      caller.callForOutcome('TEST_DO', 'before_call_2', 'remoteEcho', ['test']);

      await vi.waitFor(async () => {
        expect(await caller.getLastCallResult()).toBe('echo: test');
      });
    });
  });

  describe('ALS stability within a post-ack invocation', () => {
    it('callContext survives sequential + concurrent awaits inside the detached post-ack chain', async () => {
      const caller = env.TEST_DO.getByName('als_stability_caller');
      const callee = env.TEST_DO.getByName('als_stability_callee');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'als_stability_caller' });

      caller.fireCall('TEST_DO', 'als_stability_callee', 'testAlsStability');

      const seen = await vi.waitFor(async () => {
        const s = await callee.getAlsStability();
        expect(s?.length).toBe(3);
        return s!;
      });
      // The callee saw the same origin (callChain[0]) at start, after one await, and after
      // concurrent awaits — ALS held across the detached post-ack task's await boundaries.
      expect(seen).toEqual(['als_stability_caller', 'als_stability_caller', 'als_stability_caller']);
    });
  });

  describe('ALS isolation for concurrent calls', () => {
    it('concurrent calls have isolated callContext (no cross-contamination)', async () => {
      const callerA = env.TEST_DO.getByName('als_isolation_caller_a');
      const callerB = env.TEST_DO.getByName('als_isolation_caller_b');
      const calleeA = env.TEST_DO.getByName('als_isolation_callee_a');
      const calleeB = env.TEST_DO.getByName('als_isolation_callee_b');
      await callerA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'als_isolation_caller_a' });
      await callerB.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'als_isolation_caller_b' });

      // Concurrent calls from different origins to distinct callees.
      callerA.fireCall('TEST_DO', 'als_isolation_callee_a', 'captureContext');
      callerB.fireCall('TEST_DO', 'als_isolation_callee_b', 'captureContext');

      const [ctxA, ctxB] = await vi.waitFor(async () => {
        const a = await calleeA.getObservedContext();
        const b = await calleeB.getObservedContext();
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        return [a, b];
      });
      expect(ctxA.callChain[0].instanceName).toBe('als_isolation_caller_a');
      expect(ctxB.callChain[0].instanceName).toBe('als_isolation_caller_b');
    });
  });

  describe('Two-one-way calls (callback pattern)', () => {
    it('callback call PRESERVES original callContext (origin stays the same)', async () => {
      const origin = env.TEST_DO.getByName('two_one_way_origin');
      const target = env.TEST_DO.getByName('two_one_way_target');
      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two_one_way_origin' });
      await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two_one_way_target' });
      await origin.clearTwoOneWayResult();

      origin.initiateTwoOneWayCall('TEST_DO', 'two_one_way_target', 'test-marker-123');

      const result = await vi.waitFor(async () => {
        const r = await origin.getTwoOneWayResult();
        expect(r).toBeTruthy();
        return r;
      });

      expect(result.marker).toBe('test-marker-123');
      // Target's incoming context shows origin as callChain[0].
      expect(result.targetIncomingContext.callChain[0]).toMatchObject({
        type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'two_one_way_origin',
      });
      // The callback's context preserves the ORIGINAL origin, with target appended.
      expect(result.callbackContext.callChain[0]).toMatchObject({ instanceName: 'two_one_way_origin' });
      expect(result.callbackContext.callChain).toHaveLength(2);
      expect(result.callbackContext.callChain[1]).toMatchObject({ instanceName: 'two_one_way_target' });
    });

    it('callChain.at(-1) gives the immediate caller (the callback maker)', async () => {
      const origin = env.TEST_DO.getByName('two_one_way_caller_origin');
      const target = env.TEST_DO.getByName('two_one_way_caller_target');
      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two_one_way_caller_origin' });
      await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two_one_way_caller_target' });
      await origin.clearTwoOneWayResult();

      origin.initiateTwoOneWayCall('TEST_DO', 'two_one_way_caller_target', 'caller-test');

      const result = await vi.waitFor(async () => {
        const r = await origin.getTwoOneWayResult();
        expect(r).toBeTruthy();
        return r;
      });

      expect(result.callbackContext.callChain.at(-1)).toMatchObject({ instanceName: 'two_one_way_caller_target' });
      expect(result.callbackContext.callChain[0].instanceName).toBe('two_one_way_caller_origin');
    });
  });
});
