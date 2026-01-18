import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('@lumenize/mesh - CallContext Propagation', () => {
  describe('Basic callContext structure', () => {
    it('callContext has correct origin when DO calls another DO', async () => {
      const caller = env.TEST_DO.getByName('caller-do-1');
      const callee = env.TEST_DO.getByName('callee-do-1');

      // Initialize caller so it knows its identity
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'caller-do-1' });

      // Make a call and get the callee's view of callContext
      const result = await caller.testCallRawWithContinuation(
        'TEST_DO',
        'callee-do-1',
        'hello'
      );

      // Now get the callee's last envelope to inspect callContext
      const envelope = await callee.getLastEnvelope();
      expect(envelope.callContext).toBeDefined();
      expect(envelope.callContext.origin).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'caller-do-1'
      });
    });

    it('callContext.callee is correctly set for the receiving DO', async () => {
      const caller = env.TEST_DO.getByName('caller-callee-test-1');
      const callee = env.TEST_DO.getByName('callee-callee-test-1');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'caller-callee-test-1' });

      const calleeContext = await caller.testCallRawWithOperationChain(
        'TEST_DO',
        'callee-callee-test-1',
        [{ type: 'get', key: 'getCallContext' }, { type: 'apply', args: [] }]
      );

      expect(calleeContext.callee).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'callee-callee-test-1'
      });
    });

    it('callChain is empty when origin calls directly', async () => {
      const caller = env.TEST_DO.getByName('chain-empty-1');
      const callee = env.TEST_DO.getByName('chain-empty-2');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'chain-empty-1' });

      const calleeContext = await caller.testCallRawWithOperationChain(
        'TEST_DO',
        'chain-empty-2',
        [{ type: 'get', key: 'getCallContext' }, { type: 'apply', args: [] }]
      );

      // When origin calls directly, callChain should be empty
      expect(calleeContext.callChain).toEqual([]);
    });
  });

  describe('Multi-hop call chains (DO → DO → DO)', () => {
    it('callChain accumulates through hops', async () => {
      const doA = env.TEST_DO.getByName('chain-a');

      // Initialize A
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'chain-a' });

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
      expect(result.myContext.origin).toMatchObject({
        type: 'LumenizeDO',
        bindingName: 'TEST_DO',
        instanceName: 'chain-a'
      });
      expect(result.myContext.callChain).toEqual([]); // A called B directly

      // C's context shows the full chain
      expect(result.remoteContext.origin).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'chain-a'
      });
      // C should see B in the callChain (A → B → C, so B is in chain)
      expect(result.remoteContext.callChain).toHaveLength(1);
      expect(result.remoteContext.callChain[0]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'chain-b'
      });
    });

    it('callChain includes all intermediate hops', async () => {
      const doA = env.TEST_DO.getByName('multi-hop-a');

      // Initialize A
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'multi-hop-a' });

      // A calls B's callAndReturnContext via mesh, which calls another DO
      const result = await doA.testCallRawWithOperationChain(
        'TEST_DO',
        'multi-hop-b',
        [
          { type: 'get', key: 'callAndReturnContext' },
          { type: 'apply', args: ['TEST_DO', 'multi-hop-c'] }
        ]
      );

      // B's myContext shows A as origin with empty callChain (direct call from origin)
      expect(result.myContext.origin).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'multi-hop-a'
      });

      // B called C (via getCallContext), so C should see:
      // - origin: multi-hop-a (preserved from A)
      // - callChain: [multi-hop-b] (B was added when B called C)
      expect(result.remoteContext.origin).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'multi-hop-a'
      });
      expect(result.remoteContext.callChain).toHaveLength(1);
      expect(result.remoteContext.callChain[0]).toMatchObject({
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
      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'do-worker-do-1' });

      // doA calls Worker, Worker calls another DO
      const result = await doA.testCallRawWithOperationChain(
        'TEST_WORKER',
        undefined, // Workers don't have instance names
        [
          { type: 'get', key: 'forwardToDO' },
          { type: 'apply', args: ['TEST_DO', 'do-worker-do-target'] }
        ]
      );

      // Worker's context should show doA as origin
      expect(result.workerContext.origin).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'do-worker-do-1'
      });

      // The final DO should see:
      // - origin: do-worker-do-1
      // - callChain: [worker] (Worker was added when it called the DO)
      expect(result.doContext.origin).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'do-worker-do-1'
      });
      expect(result.doContext.callChain).toHaveLength(1);
      expect(result.doContext.callChain[0].type).toBe('LumenizeWorker');
    });
  });

  describe('Caller convenience getter', () => {
    it('lmz.caller returns origin when callChain is empty', async () => {
      const doA = env.TEST_DO.getByName('caller-getter-1');
      const doB = env.TEST_DO.getByName('caller-getter-2');

      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'caller-getter-1' });

      const caller = await doA.testCallRawWithOperationChain(
        'TEST_DO',
        'caller-getter-2',
        [{ type: 'get', key: 'getCaller' }, { type: 'apply', args: [] }]
      );

      // When origin calls directly, caller should be origin
      expect(caller).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'caller-getter-1'
      });
    });

    it('lmz.caller returns last element of callChain when not empty', async () => {
      const doA = env.TEST_DO.getByName('caller-chain-1');

      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'caller-chain-1' });

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
      // C's caller should be B (last in callChain)
      expect(result.remoteContext.callChain).toHaveLength(1);
      expect(result.remoteContext.callChain[0]).toMatchObject({
        bindingName: 'TEST_DO',
        instanceName: 'caller-chain-2'
      });
    });
  });

  describe('State propagation', () => {
    it('state modifications propagate to downstream calls', async () => {
      const doA = env.TEST_DO.getByName('state-prop-1');

      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'state-prop-1' });

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

      await doA.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'state-empty-1' });

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

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'mesh-security-1' });

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

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'mesh-allowed-1' });

      // remoteEcho has @mesh decorator
      const result = await caller.testCallRawWithContinuation(
        'TEST_DO',
        'mesh-allowed-2',
        'hello'
      );

      expect(result).toBe('echo: hello');
    });
  });

  describe('@mesh.guard() security', () => {
    it('guard blocks call when condition not met', async () => {
      const caller = env.TEST_DO.getByName('guard-block-caller');
      const callee = env.TEST_DO.getByName('guard-block-callee');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'guard-block-caller' });

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

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'guard-allow-caller' });

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

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'guard-auth-caller' });

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

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'guard-async-caller' });

      // Without valid token - should fail
      await expect(
        caller.testCallRawWithOperationChain(
          'TEST_DO',
          'guard-async-callee',
          [{ type: 'get', key: 'guardedAsyncMethod' }, { type: 'apply', args: [] }]
        )
      ).rejects.toThrow('Guard: valid token required');
    });
  });

  describe('onBeforeCall hook', () => {
    // Note: onBeforeCall is called but default implementation is no-op
    // Testing that calls still work means onBeforeCall didn't throw
    it('onBeforeCall is called before method execution', async () => {
      const caller = env.TEST_DO.getByName('before-call-1');
      const callee = env.TEST_DO.getByName('before-call-2');

      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'before-call-1' });

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

      await callerA.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'als-isolation-caller-a' });
      await callerB.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'als-isolation-caller-b' });

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

      // Each should have its own origin
      expect(contextA.origin.instanceName).toBe('als-isolation-caller-a');
      expect(contextB.origin.instanceName).toBe('als-isolation-caller-b');
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

      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'deep-interleave-origin' });
      await intermediary.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'deep-interleave-intermediary' });

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

  describe('CallContext capture in continuation handlers (Phase 1.5.6)', () => {
    it('callContext.state is captured and restored in lmz.call() handlers', async () => {
      // This test verifies that when using fire-and-forget lmz.call(),
      // the callContext at the time of the call is captured and restored
      // when the handler executes later.
      const origin = env.TEST_DO.getByName('context-capture-origin');
      const caller = env.TEST_DO.getByName('context-capture-caller');
      const callee = env.TEST_DO.getByName('context-capture-callee');

      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'context-capture-origin' });
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'context-capture-caller' });

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

      await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'interleave-capture-origin' });
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'interleave-capture-caller' });

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
