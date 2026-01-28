import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('@lumenize/mesh - CallContext Propagation', () => {
  describe('Basic callContext structure', () => {
    it('callContext.callChain[0] has correct origin when DO calls another DO', async () => {
      const caller = env.TEST_DO.getByName('caller-do-1');
      const callee = env.TEST_DO.getByName('callee-do-1');

      // Initialize caller so it knows its identity
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller-do-1' });

      // Make a call and get the callee's view of callContext
      const result = await caller.testCallRawWithContinuation(
        'TEST_DO',
        'callee-do-1',
        'hello'
      );

      // Now get the callee's last envelope to inspect callContext
      const envelope = await callee.getLastEnvelope();
      expect(envelope.callContext).toBeDefined();
      // Origin is now callChain[0]
      expect(envelope.callContext.callChain[0]).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'caller-do-1'
      });
    });

    it('callee can get its own identity from this.lmz (no longer in callContext)', async () => {
      const caller = env.TEST_DO.getByName('caller-callee-test-1');
      const callee = env.TEST_DO.getByName('callee-callee-test-1');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller-callee-test-1' });

      // getCalleeIdentity returns { bindingName, instanceName } from this.lmz
      const calleeIdentity = await caller.testCallRawWithOperationChain(
        'TEST_DO',
        'callee-callee-test-1',
        [{ type: 'get', key: 'getCalleeIdentity' }, { type: 'apply', args: [] }]
      );

      expect(calleeIdentity).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'callee-callee-test-1'
      });
    });

    it('callChain has one element (origin) when origin calls directly', async () => {
      const caller = env.TEST_DO.getByName('chain-empty-1');
      const callee = env.TEST_DO.getByName('chain-empty-2');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'chain-empty-1' });

      const calleeContext = await caller.testCallRawWithOperationChain(
        'TEST_DO',
        'chain-empty-2',
        [{ type: 'get', key: 'getCallContext' }, { type: 'apply', args: [] }]
      );

      // When origin calls directly, callChain has just the origin
      expect(calleeContext.callChain).toHaveLength(1);
      expect(calleeContext.callChain[0]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'chain-empty-1'
      });
    });
  });

  describe('Multi-hop call chains (DO → DO → DO)', () => {
    it('callChain accumulates through hops', async () => {
      const doA = env.TEST_DO.getByName('chain-a');

      // Initialize A
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'chain-a' });

      // A calls B via mesh, B then calls C and returns both contexts
      // We use testCallRawWithOperationChain to ensure we're going through mesh
      const result = await doA.testCallRawWithOperationChain(
        'TEST_DO',
        'chain-b',
        [
          { type: 'get', key: 'callAndReturnContext' },
          { type: 'apply', args: ['TEST_DO', 'chain-c'] }
        ]
      );

      // B's context when receiving from A (myContext)
      // callChain[0] is origin (A)
      expect(result.myContext.callChain[0]).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'chain-a'
      });
      expect(result.myContext.callChain).toHaveLength(1); // Just origin

      // C's context shows the full chain: [A, B]
      expect(result.remoteContext.callChain[0]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'chain-a'
      });
      // C should see: [A, B] - A is origin, B is caller
      expect(result.remoteContext.callChain).toHaveLength(2);
      expect(result.remoteContext.callChain[1]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'chain-b'
      });
    });

    it('callChain includes all intermediate hops', async () => {
      const doA = env.TEST_DO.getByName('multi-hop-a');

      // Initialize A
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'multi-hop-a' });

      // A calls B's callAndReturnContext via mesh, which calls another DO
      const result = await doA.testCallRawWithOperationChain(
        'TEST_DO',
        'multi-hop-b',
        [
          { type: 'get', key: 'callAndReturnContext' },
          { type: 'apply', args: ['TEST_DO', 'multi-hop-c'] }
        ]
      );

      // B's myContext: callChain = [A] (just origin)
      expect(result.myContext.callChain[0]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'multi-hop-a'
      });
      expect(result.myContext.callChain).toHaveLength(1);

      // B called C, so C should see:
      // - callChain[0]: multi-hop-a (origin)
      // - callChain[1]: multi-hop-b (caller)
      expect(result.remoteContext.callChain[0]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'multi-hop-a'
      });
      expect(result.remoteContext.callChain).toHaveLength(2);
      expect(result.remoteContext.callChain[1]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'multi-hop-b'
      });
    });
  });

  describe('DO → Worker → DO call chains', () => {
    it('Worker correctly propagates callContext to downstream DO', async () => {
      const doA = env.TEST_DO.getByName('do-worker-do-1');
      const worker = env.TEST_WORKER;

      // Initialize doA
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'do-worker-do-1' });

      // doA calls Worker, Worker calls another DO
      const result = await doA.testCallRawWithOperationChain(
        'TEST_WORKER',
        undefined, // Workers don't have instance names
        [
          { type: 'get', key: 'forwardToDO' },
          { type: 'apply', args: ['TEST_DO', 'do-worker-do-target'] }
        ]
      );

      // Worker's context should show doA as origin (callChain[0])
      expect(result.workerContext.callChain[0]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'do-worker-do-1'
      });

      // The final DO should see:
      // - callChain[0]: do-worker-do-1 (origin)
      // - callChain[1]: worker (caller)
      expect(result.doContext.callChain[0]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'do-worker-do-1'
      });
      expect(result.doContext.callChain).toHaveLength(2);
      expect(result.doContext.callChain[1].type).toBe('LumenizeWorker');
    });
  });

  describe('Caller accessor pattern', () => {
    it('callChain.at(-1) returns origin when origin calls directly', async () => {
      const doA = env.TEST_DO.getByName('caller-getter-1');
      const doB = env.TEST_DO.getByName('caller-getter-2');

      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller-getter-1' });

      const caller = await doA.testCallRawWithOperationChain(
        'TEST_DO',
        'caller-getter-2',
        [{ type: 'get', key: 'getCaller' }, { type: 'apply', args: [] }]
      );

      // When origin calls directly, caller = callChain.at(-1) = origin
      expect(caller).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'caller-getter-1'
      });
    });

    it('callChain.at(-1) returns last hop in multi-hop chain', async () => {
      const doA = env.TEST_DO.getByName('caller-chain-1');

      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'caller-chain-1' });

      // A → B → C: C's caller should be B
      // Call through mesh
      const result = await doA.testCallRawWithOperationChain(
        'TEST_DO',
        'caller-chain-2',
        [
          { type: 'get', key: 'callAndReturnContext' },
          { type: 'apply', args: ['TEST_DO', 'caller-chain-3'] }
        ]
      );

      // The remoteContext is from C (the DO that B called)
      // C's callChain = [A, B], so callChain.at(-1) = B
      expect(result.remoteContext.callChain).toHaveLength(2);
      expect(result.remoteContext.callChain.at(-1)).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'caller-chain-2'
      });
    });
  });

  describe('State propagation', () => {
    it('state modifications propagate to downstream calls', async () => {
      const doA = env.TEST_DO.getByName('state-prop-1');

      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'state-prop-1' });

      // Call through mesh
      const result = await doA.testCallRawWithOperationChain(
        'TEST_DO',
        'state-prop-2',
        [
          { type: 'get', key: 'testStatePropagation' },
          { type: 'apply', args: ['TEST_DO', 'state-prop-3', 'traceId', 'trace-12345'] }
        ]
      );

      // The remote DO (state-prop-3) should have received the state modification
      expect(result.remoteState).toHaveProperty('traceId', 'trace-12345');
    });

    it('state starts empty for fresh call chains', async () => {
      const doA = env.TEST_DO.getByName('state-empty-1');
      const doB = env.TEST_DO.getByName('state-empty-2');

      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'state-empty-1' });

      const context = await doA.testCallRawWithOperationChain(
        'TEST_DO',
        'state-empty-2',
        [{ type: 'get', key: 'getCallContext' }, { type: 'apply', args: [] }]
      );

      // Fresh call should have empty state
      expect(context.state).toEqual({});
    });
  });

  describe('@mesh decorator security', () => {
    it('blocks calls to methods without @mesh decorator', async () => {
      const caller = env.TEST_DO.getByName('mesh-security-1');
      const callee = env.TEST_DO.getByName('mesh-security-2');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'mesh-security-1' });

      // Try to call nonMeshMethod which lacks @mesh decorator
      await expect(
        caller.testCallRawWithOperationChain(
          'TEST_DO',
          'mesh-security-2',
          [{ type: 'get', key: 'nonMeshMethod' }, { type: 'apply', args: [] }]
        )
      ).rejects.toThrow();
    });

    it('allows calls to methods with @mesh decorator', async () => {
      const caller = env.TEST_DO.getByName('mesh-allowed-1');
      const callee = env.TEST_DO.getByName('mesh-allowed-2');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'mesh-allowed-1' });

      // remoteEcho has @mesh decorator
      const result = await caller.testCallRawWithContinuation(
        'TEST_DO',
        'mesh-allowed-2',
        'hello'
      );

      expect(result).toBe('echo: hello');
    });
  });

  describe('@mesh(guard) security', () => {
    it('guard blocks call when condition not met', async () => {
      const caller = env.TEST_DO.getByName('guard-block-caller');
      const callee = env.TEST_DO.getByName('guard-block-callee');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard-block-caller' });

      // Call guarded method without setting 'admin' role in state
      await expect(
        caller.testCallRawWithOperationChain(
          'TEST_DO',
          'guard-block-callee',
          [{ type: 'get', key: 'guardedAdminMethod' }, { type: 'apply', args: [] }]
        )
      ).rejects.toThrow('Guard: admin role required');
    });

    it('guard allows call when condition is met', async () => {
      const caller = env.TEST_DO.getByName('guard-allow-caller');
      const callee = env.TEST_DO.getByName('guard-allow-callee');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard-allow-caller' });

      // Call method that sets admin role in state before calling guarded method
      const result = await caller.testCallRawWithOperationChain(
        'TEST_DO',
        'guard-allow-callee',
        [
          { type: 'get', key: 'callGuardedWithState' },
          { type: 'apply', args: ['TEST_DO', 'guard-allow-target', { role: 'admin' }] }
        ]
      );

      expect(result).toBe('admin-only-result');
    });

    it('guard checks authentication (userId in state)', async () => {
      const caller = env.TEST_DO.getByName('guard-auth-caller');
      const callee = env.TEST_DO.getByName('guard-auth-callee');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard-auth-caller' });

      // Without userId - should fail
      await expect(
        caller.testCallRawWithOperationChain(
          'TEST_DO',
          'guard-auth-callee',
          [{ type: 'get', key: 'guardedAuthMethod' }, { type: 'apply', args: [] }]
        )
      ).rejects.toThrow('Guard: authentication required');
    });

    it('async guard works correctly', async () => {
      const caller = env.TEST_DO.getByName('guard-async-caller');
      const callee = env.TEST_DO.getByName('guard-async-callee');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'guard-async-caller' });

      // Without valid token - should fail
      await expect(
        caller.testCallRawWithOperationChain(
          'TEST_DO',
          'guard-async-callee',
          [{ type: 'get', key: 'guardedAsyncMethod' }, { type: 'apply', args: [] }]
        )
      ).rejects.toThrow('Guard: valid token required');
    });

    // Worker guard tests
    it('Worker: guard blocks call when condition not met', async () => {
      const caller = env.TEST_DO.getByName('worker-guard-block-caller');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker-guard-block-caller' });

      // Call guarded Worker method without setting 'admin' role in state
      await expect(
        caller.testCallRawWithOperationChain(
          'TEST_WORKER',
          undefined,
          [{ type: 'get', key: 'guardedWorkerAdminMethod' }, { type: 'apply', args: [] }]
        )
      ).rejects.toThrow('Worker Guard: admin role required');
    });

    it('Worker: guard checks authentication (userId in state)', async () => {
      const caller = env.TEST_DO.getByName('worker-guard-auth-caller');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker-guard-auth-caller' });

      // Without userId - should fail
      await expect(
        caller.testCallRawWithOperationChain(
          'TEST_WORKER',
          undefined,
          [{ type: 'get', key: 'guardedWorkerAuthMethod' }, { type: 'apply', args: [] }]
        )
      ).rejects.toThrow('Worker Guard: authentication required');
    });

    it('Worker: async guard works correctly', async () => {
      const caller = env.TEST_DO.getByName('worker-guard-async-caller');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'worker-guard-async-caller' });

      // Without valid token - should fail
      await expect(
        caller.testCallRawWithOperationChain(
          'TEST_WORKER',
          undefined,
          [{ type: 'get', key: 'guardedWorkerAsyncMethod' }, { type: 'apply', args: [] }]
        )
      ).rejects.toThrow('Worker Guard: valid token required');
    });
  });

  describe('onBeforeCall hook', () => {
    // Note: onBeforeCall is called but default implementation is no-op
    // Testing that calls still work means onBeforeCall didn't throw
    it('onBeforeCall is called before method execution', async () => {
      const caller = env.TEST_DO.getByName('before-call-1');
      const callee = env.TEST_DO.getByName('before-call-2');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'before-call-1' });

      // If onBeforeCall threw, this would fail
      const result = await caller.testCallRawWithContinuation(
        'TEST_DO',
        'before-call-2',
        'test'
      );

      expect(result).toBe('echo: test');
    });
  });

  describe('ALS isolation for concurrent calls', () => {
    it('concurrent calls have isolated callContext (no cross-contamination)', async () => {
      const callerA = env.TEST_DO.getByName('als-isolation-caller-a');
      const callerB = env.TEST_DO.getByName('als-isolation-caller-b');
      const callee = env.TEST_DO.getByName('als-isolation-callee');

      await callerA.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'als-isolation-caller-a' });
      await callerB.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'als-isolation-caller-b' });

      // Make concurrent calls from different origins
      const [contextA, contextB] = await Promise.all([
        callerA.testCallRawWithOperationChain(
          'TEST_DO',
          'als-isolation-callee',
          [{ type: 'get', key: 'getCallContext' }, { type: 'apply', args: [] }]
        ),
        callerB.testCallRawWithOperationChain(
          'TEST_DO',
          'als-isolation-callee',
          [{ type: 'get', key: 'getCallContext' }, { type: 'apply', args: [] }]
        )
      ]);

      // Each should have its own origin (callChain[0])
      expect(contextA.callChain[0].instanceName).toBe('als-isolation-caller-a');
      expect(contextB.callChain[0].instanceName).toBe('als-isolation-caller-b');
    });

    it('callContext remains stable through concurrent callRaw() operations', async () => {
      // This test verifies ALS isolation for the callRaw() path (used internally
      // by @lumenize/fetch and in tests). It checks that:
      // 1. Multiple concurrent outgoing calls each get correct context in envelope
      // 2. Context remains stable across await points
      // 3. Each remote DO sees the correct origin in callChain
      //
      // Note: This tests callRaw() which awaits. For the synchronous lmz.call()
      // pattern with result handlers, see Phase 1.5.6 continuation capture tests.
      const origin = env.TEST_DO.getByName('deep-interleave-origin');
      const intermediary = env.TEST_DO.getByName('deep-interleave-intermediary');

      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'deep-interleave-origin' });
      await intermediary.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'deep-interleave-intermediary' });

      // Origin calls intermediary, which then makes multiple concurrent calls
      // while checking its callContext at various points
      const result = await origin.testCallRawWithOperationChain(
        'TEST_DO',
        'deep-interleave-intermediary',
        [
          { type: 'get', key: 'testDeepInterleavingContext' },
          { type: 'apply', args: ['TEST_DO', 'deep-interleave'] }
        ]
      );

      // All context checks should match
      expect(result.allContextsMatch).toBe(true);

      // Verify specific positions
      const positions = result.results.reduce((acc: Record<string, string>, r: any) => {
        acc[r.position] = r.origin;
        return acc;
      }, {});

      // The intermediary sees origin as its caller throughout execution
      expect(positions['start']).toBe('deep-interleave-origin');
      expect(positions['mid-execution']).toBe('deep-interleave-origin');
      expect(positions['post-await']).toBe('deep-interleave-origin');
      expect(positions['final']).toBe('deep-interleave-origin');

      // Remote DOs also see the original origin (preserved through callChain)
      expect(positions['remote-1-saw-origin']).toBe('deep-interleave-origin');
      expect(positions['remote-2-saw-origin']).toBe('deep-interleave-origin');
      expect(positions['remote-3-saw-origin']).toBe('deep-interleave-origin');
    });

  });

  describe('Two-one-way calls (callback pattern)', () => {
    it('callback call PRESERVES original callContext (origin stays the same)', async () => {
      // This tests the "two-one-way calls" pattern where:
      // 1. Origin calls Target
      // 2. Target processes, then independently calls back to Origin
      //
      // VERIFIED BEHAVIOR: The callback preserves the original callContext.
      // When Target calls back using this.lmz.callRaw(), it serializes its
      // CURRENT callContext (which shows Origin as origin) and sends it.
      // This allows the full call chain to be traced back to the original requester.
      const origin = env.TEST_DO.getByName('two-one-way-origin');
      const target = env.TEST_DO.getByName('two-one-way-target');

      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two-one-way-origin' });
      await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two-one-way-target' });

      // Clear any previous results
      await origin.clearTwoOneWayResult();

      // Origin initiates the two-one-way call
      await origin.initiateTwoOneWayCall('TEST_DO', 'two-one-way-target', 'test-marker-123');

      // Wait for the callback to complete
      await vi.waitFor(async () => {
        const result = await origin.getTwoOneWayResult();
        expect(result).toBeDefined();
      });

      const result = await origin.getTwoOneWayResult();

      // Verify the marker was passed through
      expect(result.marker).toBe('test-marker-123');

      // Verify Target's incoming context shows Origin as origin (callChain[0])
      expect(result.targetIncomingContext.callChain[0]).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'two-one-way-origin'
      });

      // VERIFIED: The callback's callContext preserves the ORIGINAL origin
      // This allows tracing the full request chain back to who started it
      // callChain[0] is origin, callChain[1] is target (who made callback)
      expect(result.callbackContext.callChain[0]).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'two-one-way-origin'  // Original origin is preserved!
      });

      // The callback's callChain should include Target (who made the callback)
      expect(result.callbackContext.callChain).toHaveLength(2);
      expect(result.callbackContext.callChain[1]).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'two-one-way-target'
      });
    });

    it('callChain.at(-1) gives the immediate caller', async () => {
      // The immediate caller is always the last entry in callChain
      const origin = env.TEST_DO.getByName('two-one-way-caller-origin');
      const target = env.TEST_DO.getByName('two-one-way-caller-target');

      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two-one-way-caller-origin' });
      await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'two-one-way-caller-target' });

      await origin.clearTwoOneWayResult();
      await origin.initiateTwoOneWayCall('TEST_DO', 'two-one-way-caller-target', 'caller-test');

      await vi.waitFor(async () => {
        const result = await origin.getTwoOneWayResult();
        expect(result).toBeDefined();
      });

      const result = await origin.getTwoOneWayResult();

      // callChain.at(-1) is always the immediate caller
      const callChain = result.callbackContext.callChain;
      const computedCaller = callChain.at(-1);

      // The immediate caller should be Target (who made the callback)
      expect(computedCaller).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'two-one-way-caller-target'
      });

      // While callChain[0] remains the original requester
      expect(result.callbackContext.callChain[0].instanceName).toBe('two-one-way-caller-origin');
    });
  });

  describe('CallContext capture in continuation handlers (Phase 1.5.6)', () => {
    it('callContext.state is captured and restored in lmz.call() handlers', async () => {
      // This test verifies that when using fire-and-forget lmz.call(),
      // the callContext at the time of the call is captured and restored
      // when the handler executes later.
      const origin = env.TEST_DO.getByName('context-capture-origin');
      const caller = env.TEST_DO.getByName('context-capture-caller');
      const callee = env.TEST_DO.getByName('context-capture-callee');

      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'context-capture-origin' });
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'context-capture-caller' });

      // Origin calls caller via mesh, caller then uses lmz.call() with a handler
      await origin.testCallRawWithOperationChain(
        'TEST_DO',
        'context-capture-caller',
        [
          { type: 'get', key: 'testContextCaptureInHandler' },
          { type: 'apply', args: ['TEST_DO', 'context-capture-callee', 'unique-marker-123'] }
        ]
      );

      // Wait for the async handler to complete
      await vi.waitFor(async () => {
        const verification = await caller.getContextCaptureVerification();
        expect(verification).toBeDefined();
      });

      const verification = await caller.getContextCaptureVerification() as any;
      expect(verification.matches).toBe(true);
      expect(verification.expectedMarker).toBe('unique-marker-123');
      expect(verification.actualMarker).toBe('unique-marker-123');
    });

    it('interleaved lmz.call() handlers each get their own captured context', async () => {
      // This is the critical test: multiple fire-and-forget calls made in sequence,
      // each with a different state marker. When handlers execute later (potentially
      // in different order), each must see its own captured context, not a shared one.
      const origin = env.TEST_DO.getByName('interleave-capture-origin');
      const caller = env.TEST_DO.getByName('interleave-capture-caller');
      const callee = env.TEST_DO.getByName('interleave-capture-callee');

      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'interleave-capture-origin' });
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'interleave-capture-caller' });

      // Clear any previous results
      await caller.clearInterleavedResults();

      // Origin calls caller via mesh, caller makes multiple interleaved lmz.call()s
      const markers = ['alpha', 'beta', 'gamma', 'delta'];
      await origin.testCallRawWithOperationChain(
        'TEST_DO',
        'interleave-capture-caller',
        [
          { type: 'get', key: 'testInterleavedContextCapture' },
          { type: 'apply', args: ['TEST_DO', 'interleave-capture-callee', markers] }
        ]
      );

      // Wait for all handlers to complete
      await vi.waitFor(async () => {
        const results = await caller.getInterleavedResults() as any[];
        expect(results?.length).toBe(markers.length);
      });

      const results = await caller.getInterleavedResults() as any[];

      // Every handler should have received its own captured context
      for (const result of results) {
        expect(result.matches).toBe(true);
      }

      // Verify all markers are represented
      const seenMarkers = results.map((r: any) => r.expectedMarker).sort();
      expect(seenMarkers).toEqual(markers.sort());
    });
  });
});
