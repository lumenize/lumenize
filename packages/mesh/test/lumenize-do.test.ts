import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess, postprocess } from '@lumenize/structured-clone';

describe('@lumenize/mesh - onRequest() Lifecycle Hook', () => {
  describe('Subclass without onRequest', () => {
    it('returns 501 Not Implemented', async () => {
      const stub = env.TEST_DO.getByName('onrequest-no-impl-1');
      const response = await stub.testFetch({});
      expect(response.status).toBe(501);
      expect(await response.text()).toBe('Not Implemented: override onRequest() to handle HTTP requests');
    });
  });

  describe('Subclass with onRequest', () => {
    it('calls onRequest and returns its response', async () => {
      const stub = env.ON_REQUEST_TEST_DO.getByName('onrequest-basic-1');
      const request = new Request('https://example.com/echo', {
        headers: {
          'x-lumenize-do-binding-name': 'ON_REQUEST_TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'onrequest-basic-1',
        },
      });
      const response = await stub.fetch(request);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('method=GET');
    });

    it('has identity available inside onRequest (proves __initFromHeaders ran first)', async () => {
      const stub = env.ON_REQUEST_TEST_DO.getByName('onrequest-identity-1');
      const request = new Request('https://example.com/status', {
        headers: {
          'x-lumenize-do-binding-name': 'ON_REQUEST_TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'onrequest-identity-1',
        },
      });
      const response = await stub.fetch(request);
      expect(response.status).toBe(200);
      const body = await response.json() as { instanceName: string; bindingName: string };
      expect(body.instanceName).toBe('onrequest-identity-1');
      expect(body.bindingName).toBe('ON_REQUEST_TEST_DO');
    });

    it('returns 404 for unmatched routes (subclass controls routing)', async () => {
      const stub = env.ON_REQUEST_TEST_DO.getByName('onrequest-404-1');
      const request = new Request('https://example.com/unknown', {
        headers: {
          'x-lumenize-do-binding-name': 'ON_REQUEST_TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'onrequest-404-1',
        },
      });
      const response = await stub.fetch(request);
      expect(response.status).toBe(404);
    });

    it('__initFromHeaders errors still take priority over onRequest', async () => {
      const stub = env.ON_REQUEST_TEST_DO.getByName('onrequest-init-error-1');
      // First request sets identity
      const req1 = new Request('https://example.com/status', {
        headers: {
          'x-lumenize-do-binding-name': 'ON_REQUEST_TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'onrequest-init-error-1',
        },
      });
      await stub.fetch(req1);

      // Second request with mismatched binding — should get error, not onRequest
      const req2 = new Request('https://example.com/status', {
        headers: {
          'x-lumenize-do-binding-name': 'WRONG_BINDING',
          'x-lumenize-do-instance-name-or-id': 'onrequest-init-error-1',
        },
      });
      const response = await stub.fetch(req2);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain('DO binding name mismatch');
    });
  });
});

describe('@lumenize/mesh - onStart() Lifecycle Hook', () => {
  it('calls onStart() when DO is first instantiated', async () => {
    const stub = env.ONSTART_TEST_DO.getByName('onstart-basic-1');

    // onStart should have been called
    const flag = await stub.getOnStartFlag();
    expect(flag).toBe(true);
  });

  it('propagates errors from onStart()', async () => {
    const stub = env.ONSTART_ERROR_DO.getByName('onstart-error-1');
    await expect(stub.getValue()).rejects.toThrow('Intentional onStart error for testing');
  });

  it('runs onStart() before any other operations', async () => {
    const stub = env.ONSTART_TEST_DO.getByName('onstart-before-ops-1');

    // The table should exist (created in onStart) before we try to use it
    await stub.insertValue('test-1', 'hello');
    const result = await stub.getValue('test-1');

    expect(result).toEqual({ id: 'test-1', value: 'hello' });
  });

  it('onStart() is wrapped in blockConcurrencyWhile', async () => {
    // Multiple concurrent calls should all see the table created by onStart
    const stub = env.ONSTART_TEST_DO.getByName('onstart-concurrent-1');

    // Fire multiple operations concurrently
    const results = await Promise.all([
      stub.insertValue('a', '1').then(() => stub.getValue('a')),
      stub.insertValue('b', '2').then(() => stub.getValue('b')),
      stub.insertValue('c', '3').then(() => stub.getValue('c')),
    ]);

    // All should succeed (table was created before any could run)
    expect(results[0]).toEqual({ id: 'a', value: '1' });
    expect(results[1]).toEqual({ id: 'b', value: '2' });
    expect(results[2]).toEqual({ id: 'c', value: '3' });
  });

  it('does not call onStart() if not overridden (TestDO)', async () => {
    // TestDO does NOT override onStart(), so the default no-op should be used
    // This is tested implicitly - TestDO works fine without onStart
    const stub = env.TEST_DO.getByName('onstart-noop-1');

    // TestDO uses #initTable() in constructor instead
    await stub.insertUser('user-1', 'Alice', 30);
    const user = await stub.getUserById('user-1');

    expect(user).toMatchObject({ id: 'user-1', name: 'Alice', age: 30 });
  });
});

describe('@lumenize/mesh - NADIS Auto-injection', () => {
  describe('SQL Injectable', () => {
    it('auto-injects sql service', async () => {
      const stub = env.TEST_DO.getByName('sql-inject-test');

      await stub.insertUser('user1', 'Alice', 30);

      const user = await stub.getUserById('user1');
      expect(user).toMatchObject({
        id: 'user1',
        name: 'Alice',
        age: 30
      });
    });

    it('caches sql service instance', async () => {
      const stub = env.TEST_DO.getByName('sql-cache-test');
      
      // Access sql multiple times - should return same instance
      await stub.insertUser('user1', 'Alice', 30);
      await stub.insertUser('user2', 'Bob', 25);

      const user1 = await stub.getUserById('user1');
      const user2 = await stub.getUserById('user2');
      
      expect(user1.name).toBe('Alice');
      expect(user2.name).toBe('Bob');
    });
  });

  describe('Alarms Injectable', () => {
    it('auto-injects alarms service', async () => {
      const stub = env.TEST_DO.getByName('alarms-inject-test');
      
      // Just verify we can access the alarms service (it auto-injects)
      // Detailed alarm functionality is tested in alarms.test.ts
      const futureDate = new Date(Date.now() + 5000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'test-task' });
      
      expect(schedule).toBeDefined();
      expect(schedule.type).toBe('scheduled');
      expect(schedule.id).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('throws helpful error when service not found', async () => {
      const stub = env.TEST_DO.getByName('service-not-found-test');
      
      // Try to access a service that doesn't exist
      await expect(
        stub.accessNonExistentService()
      ).rejects.toThrow(/Service 'nonExistent' not found.*import '@lumenize\/nonExistent'/);
    });
  });

  describe('fetch() - Auto-init from Headers', () => {
    describe('Successful Initialization', () => {
      it('initializes from x-lumenize-do-binding-name header', async () => {
        const stub = env.TEST_DO.getByName('fetch-init-binding-1');
        await stub.clearStoredMetadata();
        
        const response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO'
        });
        
        expect(response.status).toBe(501); // Default "Not Implemented"
        expect(await stub.getStoredBindingName()).toBe('TEST_DO');
      });

      it('initializes from x-lumenize-do-instance-name-or-id header', async () => {
        const stub = env.TEST_DO.getByName('fetch-init-instance-1');
        await stub.clearStoredMetadata();
        
        const response = await stub.testFetch({
          'x-lumenize-do-instance-name-or-id': 'my-instance'
        });
        
        expect(response.status).toBe(501);
        expect(await stub.getStoredInstanceName()).toBe('my-instance');
      });

      it('initializes from both headers', async () => {
        const stub = env.TEST_DO.getByName('fetch-init-both-1');
        await stub.clearStoredMetadata();
        
        const response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'my-instance'
        });
        
        expect(response.status).toBe(501);
        expect(await stub.getStoredBindingName()).toBe('TEST_DO');
        expect(await stub.getStoredInstanceName()).toBe('my-instance');
      });

      it('does nothing when headers are missing', async () => {
        const stub = env.TEST_DO.getByName('fetch-no-headers-1');
        await stub.clearStoredMetadata();
        
        const response = await stub.testFetch({});
        
        expect(response.status).toBe(501);
        expect(await stub.getStoredBindingName()).toBeUndefined();
        expect(await stub.getStoredInstanceName()).toBeUndefined();
      });

      it('accepts same values on subsequent requests', async () => {
        const stub = env.TEST_DO.getByName('fetch-same-values-1');
        await stub.clearStoredMetadata();
        
        // First request
        let response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'my-instance'
        });
        expect(response.status).toBe(501);
        
        // Second request with same values
        response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'my-instance'
        });
        expect(response.status).toBe(501);
        
        expect(await stub.getStoredBindingName()).toBe('TEST_DO');
        expect(await stub.getStoredInstanceName()).toBe('my-instance');
      });
    });

    describe('Error Handling', () => {
      it('returns 500 on binding name mismatch', async () => {
        const stub = env.TEST_DO.getByName('fetch-binding-mismatch-1');
        await stub.clearStoredMetadata();
        
        // First request
        await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO'
        });
        
        // Second request with different binding name
        const response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'OTHER_DO'
        });
        
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).toContain('DO binding name mismatch');
        expect(body).toContain('TEST_DO');
        expect(body).toContain('OTHER_DO');
      });

      it('returns 500 on instance name mismatch', async () => {
        const stub = env.TEST_DO.getByName('fetch-instance-mismatch-1');
        await stub.clearStoredMetadata();
        
        // First request
        await stub.testFetch({
          'x-lumenize-do-instance-name-or-id': 'instance-1'
        });
        
        // Second request with different instance
        const response = await stub.testFetch({
          'x-lumenize-do-instance-name-or-id': 'instance-2'
        });
        
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).toContain('DO instance name mismatch');
        expect(body).toContain('instance-1');
        expect(body).toContain('instance-2');
      });
    });
  });

  describe('this.lmz.* - Identity Abstraction API', () => {
    describe('Type Property', () => {
      it('returns "LumenizeDO" for type', async () => {
        const stub = env.TEST_DO.getByName('lmz-type-test');
        const type = await stub.testLmzType();
        expect(type).toBe('LumenizeDO');
      });
    });

    describe('Binding Name Property', () => {
      it('returns undefined when not set', async () => {
        const stub = env.TEST_DO.getByName('lmz-binding-empty-1');
        await stub.clearStoredMetadata();

        const bindingName = await stub.testLmzGetBindingName();
        expect(bindingName).toBeUndefined();
      });

      it('sets and gets binding name via __init', async () => {
        const stub = env.TEST_DO.getByName('lmz-binding-set-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ bindingName: 'USER_DO' });

        const bindingName = await stub.testLmzGetBindingName();
        expect(bindingName).toBe('USER_DO');
      });

      it('allows setting same binding name multiple times', async () => {
        const stub = env.TEST_DO.getByName('lmz-binding-same-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ bindingName: 'USER_DO' });
        await stub.testLmzApiInit({ bindingName: 'USER_DO' });

        const bindingName = await stub.testLmzGetBindingName();
        expect(bindingName).toBe('USER_DO');
      });

      it('throws on binding name mismatch', async () => {
        const stub = env.TEST_DO.getByName('lmz-binding-mismatch-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ bindingName: 'USER_DO' });

        await expect(
          stub.testLmzApiInit({ bindingName: 'OTHER_DO' })
        ).rejects.toThrow(/DO binding name mismatch: stored 'USER_DO' but received 'OTHER_DO'/);
      });
    });

    describe('Instance Name Property', () => {
      it('returns undefined when not set', async () => {
        const stub = env.TEST_DO.getByName('lmz-instance-empty-1');
        await stub.clearStoredMetadata();

        const instanceName = await stub.testLmzGetInstanceName();
        expect(instanceName).toBeUndefined();
      });

      it('sets and gets instance name via __init', async () => {
        const stub = env.TEST_DO.getByName('lmz-instance-set-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ instanceName: 'user-123' });

        const instanceName = await stub.testLmzGetInstanceName();
        expect(instanceName).toBe('user-123');
      });

      it('throws on instance name mismatch', async () => {
        const stub = env.TEST_DO.getByName('lmz-instance-mismatch-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ instanceName: 'user-123' });

        await expect(
          stub.testLmzApiInit({ instanceName: 'user-456' })
        ).rejects.toThrow(/DO instance name mismatch: stored 'user-123' but received 'user-456'/);
      });
    });

    // NOTE: id property removed - use instanceName instead

    describe('__init() Internal Method', () => {
      it('initializes binding name', async () => {
        const stub = env.TEST_DO.getByName('lmz-init-binding-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ bindingName: 'USER_DO' });

        expect(await stub.testLmzGetBindingName()).toBe('USER_DO');
      });

      it('initializes instance name', async () => {
        const stub = env.TEST_DO.getByName('lmz-init-instance-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ instanceName: 'user-123' });

        expect(await stub.testLmzGetInstanceName()).toBe('user-123');
      });

      it('initializes both binding name and instance name', async () => {
        const stub = env.TEST_DO.getByName('lmz-init-both-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({
          bindingName: 'USER_DO',
          instanceName: 'user-456'
        });

        expect(await stub.testLmzGetBindingName()).toBe('USER_DO');
        expect(await stub.testLmzGetInstanceName()).toBe('user-456');
      });

      it('allows calling with empty options (no-op)', async () => {
        const stub = env.TEST_DO.getByName('lmz-init-empty-1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({});

        expect(await stub.testLmzGetBindingName()).toBeUndefined();
        expect(await stub.testLmzGetInstanceName()).toBeUndefined();
      });

      // NOTE: ID validation is now done at the routeDORequest header boundary
      // LmzApi no longer handles DO IDs - only instance names are accepted
    });
  });

  describe('this.lmz.call() - DO→DO request envelope + result', () => {
    describe('Result delivery (4-arg → fire-back)', () => {
      it('delivers the remote result to the handler', async () => {
        const caller = env.TEST_DO.getByName('callraw-caller-1');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'callraw-caller-1' });

        caller.callForOutcome('TEST_DO', 'callraw-callee-1', 'remoteEcho', ['hello']);

        await vi.waitFor(async () => {
          expect(await caller.getLastCallResult()).toBe('echo: hello');
        });
      });

      it('extracts the OperationChain from the continuation internally', async () => {
        const caller = env.TEST_DO.getByName('input-caller-2');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'input-caller-2' });

        caller.callForOutcome('TEST_DO', 'input-callee-2', 'remoteEcho', ['verified']);

        await vi.waitFor(async () => {
          expect(await caller.getLastCallResult()).toBe('echo: verified');
        });
      });
    });

    describe('Request envelope structure (via 3-arg call, read on the callee)', () => {
      it('propagates caller metadata to the callee', async () => {
        const caller = env.TEST_DO.getByName('callraw-caller-2');
        const callee = env.TEST_DO.getByName('callraw-callee-2');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceName: 'caller-2' });

        caller.fireCall('TEST_DO', 'callraw-callee-2', 'remoteEcho', ['test']);

        const envelope = await vi.waitFor(async () => {
          const e = await callee.getLastEnvelope();
          expect(e).toBeTruthy();
          return e;
        });
        expect(envelope.version).toBe(1);
        expect(envelope.metadata.caller.type).toBe('LumenizeDO');
        expect(envelope.metadata.caller.bindingName).toBe('CALLER_DO');
        expect(envelope.metadata.caller.instanceName).toBe('caller-2');
      });

      it('propagates callee metadata for auto-initialization', async () => {
        const caller = env.TEST_DO.getByName('callraw-caller-3');
        const callee = env.TEST_DO.getByName('callraw-callee-3');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });

        caller.fireCall('TEST_DO', 'callraw-callee-3', 'remoteEcho', ['test']);

        const envelope = await vi.waitFor(async () => {
          const e = await callee.getLastEnvelope();
          expect(e).toBeTruthy();
          return e;
        });
        expect(envelope.metadata.callee.type).toBe('LumenizeDO');
        expect(envelope.metadata.callee.bindingName).toBe('TEST_DO');
        expect(envelope.metadata.callee.instanceName).toBe('callraw-callee-3');
      });

      it('auto-initializes callee identity from envelope metadata', async () => {
        const caller = env.TEST_DO.getByName('callraw-caller-4');
        const callee = env.TEST_DO.getByName('callraw-callee-4');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });

        const identityBefore = await callee.getCalleeIdentity();
        expect(identityBefore.bindingName).toBeUndefined();
        expect(identityBefore.instanceName).toBeUndefined();

        caller.fireCall('TEST_DO', 'callraw-callee-4', 'remoteEcho', ['test']);

        await vi.waitFor(async () => {
          const identityAfter = await callee.getCalleeIdentity();
          expect(identityAfter.bindingName).toBe('TEST_DO');
          expect(identityAfter.instanceName).toBe('callraw-callee-4');
        });
      });

      it('creates a valid v1 envelope with a preprocessed chain + complete metadata', async () => {
        const caller = env.TEST_DO.getByName('envelope-caller-3');
        const callee = env.TEST_DO.getByName('envelope-callee-3');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceName: 'caller-3' });

        caller.fireCall('TEST_DO', 'envelope-callee-3', 'remoteEcho', ['test']);

        const envelope = await vi.waitFor(async () => {
          const e = await callee.getLastEnvelope();
          expect(e).toBeTruthy();
          return e;
        });
        expect(envelope).toHaveProperty('version', 1);
        expect(typeof envelope.chain).toBe('object');
        expect(envelope.metadata).toMatchObject({
          caller: { type: 'LumenizeDO', bindingName: 'CALLER_DO', instanceName: 'caller-3' },
          callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'envelope-callee-3' },
        });
      });
    });

    describe('Envelope Validation', () => {
      it('rejects envelopes with no version', async () => {
        const callee = env.TEST_DO.getByName('validation-callee-1');

        // __executeOperation expects envelope with only chain preprocessed
        const invalidEnvelope = {
          chain: preprocess({}),
          metadata: {}
        };

        // Envelope errors (incl. version) are returned wrapped as { $error }
        // (callRaw unwraps + rethrows); they no longer reject __executeOperation.
        const { $error } = await callee.__executeOperation(invalidEnvelope);
        expect(postprocess($error).message).toMatch(/Unsupported RPC envelope version/);
      });

      it('rejects envelopes with unsupported version', async () => {
        const callee = env.TEST_DO.getByName('validation-callee-2');

        // __executeOperation expects envelope with only chain preprocessed
        const invalidEnvelope = {
          version: 2,
          chain: preprocess({}),
          metadata: {}
        };

        const { $error } = await callee.__executeOperation(invalidEnvelope);
        expect(postprocess($error).message).toMatch(/Unsupported RPC envelope version: 2/);
      });

      it('rejects envelopes with version 0', async () => {
        const callee = env.TEST_DO.getByName('validation-callee-3');

        // __executeOperation expects envelope with only chain preprocessed
        const invalidEnvelope = {
          version: 0,
          chain: preprocess({}),
          metadata: {}
        };

        const { $error } = await callee.__executeOperation(invalidEnvelope);
        expect(postprocess($error).message).toMatch(/Unsupported RPC envelope version: 0/);
      });

      it('admits a valid v1 envelope with an early {$ack}', async () => {
        const callee = env.TEST_DO.getByName('validation-callee-4');

        const validEnvelope = {
          version: 1,
          chain: preprocess([{ type: 'get', key: 'remoteEcho' }, { type: 'apply', args: ['validated'] }]),
          callContext: { callChain: [{ type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'validation-origin' }], state: {} },
          metadata: { callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'validation-callee-4' } },
        };

        // Admitted → early ack (never {$result}); the chain runs post-ack.
        const ack = await callee.__executeOperation(validEnvelope as any);
        expect(ack).toEqual({ $ack: true });
      });
    });
  });

  describe('this.lmz.call() - Continuation Pattern', () => {
    describe('Basic DO→DO Calls', () => {
      it('executes remote call and handles result in continuation', async () => {
        const caller = env.TEST_DO.getByName('call-caller-1');
        // Real identity so the callee can fire the handler back to this caller.
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call-caller-1' });

        caller.testCallWithContinuations('TEST_DO', 'call-callee-1', 'hello-call');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallResult()).toBe('echo: hello-call');
        });
      });

      it('returns immediately (synchronous call signature)', async () => {
        const caller = env.TEST_DO.getByName('call-caller-2');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call-caller-2' });

        // call() returns void (never awaits the remote work) — over RPC that resolves to undefined.
        expect(await caller.testCallWithContinuations('TEST_DO', 'call-callee-2', 'test')).toBeUndefined();
      });

      it('propagates caller metadata to the remote DO', async () => {
        const caller = env.TEST_DO.getByName('call-caller-3');
        const callee = env.TEST_DO.getByName('call-callee-3');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceName: 'caller-3' });

        // 3-arg — the callee's captured request envelope carries the caller metadata.
        caller.fireCall('TEST_DO', 'call-callee-3', 'remoteEcho', ['metadata-test']);

        const envelope = await vi.waitFor(async () => {
          const e = await callee.getLastEnvelope();
          expect(e).toBeTruthy();
          return e;
        });
        expect(envelope.metadata.caller.bindingName).toBe('CALLER_DO');
        expect(envelope.metadata.caller.instanceName).toBe('caller-3');
      });
    });

    describe('Error Handling', () => {
      it('handles remote errors in continuation', async () => {
        const caller = env.TEST_DO.getByName('call-error-caller-1');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call-error-caller-1' });

        caller.testCallWithError('TEST_DO', 'call-error-callee-1');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallError()).toBe('Remote error for testing');
        });
      });

      it('converts non-Error to Error in handler', async () => {
        const caller = env.TEST_DO.getByName('call-error-caller-2');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call-error-caller-2' });

        caller.testCallWithError('TEST_DO', 'call-error-callee-2');

        await vi.waitFor(async () => {
          const error = await caller.getLastCallError();
          expect(error).toBeTruthy();
          expect(typeof error).toBe('string');
        });
      });
    });

    describe('onErrorOnly', () => {
      it('skips the success-path handler when result is not an Error', async () => {
        const caller = env.TEST_DO.getByName('call-onerroronly-success-caller');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call-onerroronly-success-caller' });

        // Successful call with onErrorOnly:true — the callee skips the success fire-back (N6),
        // so the handler never writes to KV. Assert it stays unwritten after the callee has run.
        caller.testCallOnErrorOnlySuccess('TEST_DO', 'call-onerroronly-success-callee', 'hi');
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(await caller.getLastCallResult()).toBeUndefined();
      });

      it('still fires the error-path handler on remote rejection', async () => {
        const caller = env.TEST_DO.getByName('call-onerroronly-error-caller');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call-onerroronly-error-caller' });

        caller.testCallOnErrorOnlyError('TEST_DO', 'call-onerroronly-error-callee');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallError()).toBe('Remote error for testing');
        });
      });
    });

    describe('Validation', () => {
      it('throws if caller has no bindingName', async () => {
        const caller = env.TEST_DO.getByName('call-validation-1');
        
        // Add a test method that tries to call without bindingName
        await expect(caller.testLmzCallWithoutBinding()).rejects.toThrow(
          /Cannot use call\(\) from a DO that doesn't know its own binding name/
        );
      });

      it('throws if remoteContinuation is invalid', async () => {
        const caller = env.TEST_DO.getByName('call-validation-2');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        
        // Test method that passes invalid remote continuation
        await expect(caller.testLmzCallWithInvalidRemote()).rejects.toThrow(
          /Invalid remoteContinuation/
        );
      });

      it('throws if handlerContinuation is invalid', async () => {
        const caller = env.TEST_DO.getByName('call-validation-3');

        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });

        // Test method that passes invalid handler continuation
        await expect(caller.testLmzCallWithInvalidHandler()).rejects.toThrow(
          /Invalid handlerContinuation/
        );
      });
    });

    describe('DO ID validation in __initFromHeaders', () => {
      it('returns 400 when instance header contains a DO ID', async () => {
        const stub = env.TEST_DO.getByName('fetch-do-id-reject');
        await stub.clearStoredMetadata();

        // DO IDs are 64-char hex strings
        const doId = 'a'.repeat(64);
        const response = await stub.testFetch({
          'x-lumenize-do-instance-name-or-id': doId,
        });

        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain('LumenizeDO requires instanceName, not a DO id string');
      });
    });

    describe('Continuation Markers', () => {
      it('substitutes result into handler continuation', async () => {
        const caller = env.TEST_DO.getByName('call-marker-1');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call-marker-1' });

        caller.testCallWithContinuations('TEST_DO', 'call-marker-callee-1', 'marker-test');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallResult()).toBe('echo: marker-test');
        });
      });

      it('substitutes error into handler continuation', async () => {
        const caller = env.TEST_DO.getByName('call-marker-2');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call-marker-2' });

        caller.testCallWithError('TEST_DO', 'call-marker-callee-2');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallError()).toContain('Remote error for testing');
        });
      });
    });
  });

});

