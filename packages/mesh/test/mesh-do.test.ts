import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import type { TestDO, TestWorker } from './test-worker-and-dos';

describe('@lumenize/mesh - onRequest() Lifecycle Hook', () => {
  describe('Subclass without onRequest', () => {
    it('returns 501 Not Implemented', async () => {
      const stub = env.TEST_DO.getByName('onrequest_no_impl_1');
      const response = await stub.testFetch({});
      expect(response.status).toBe(501);
      expect(await response.text()).toBe('Not Implemented: override onRequest() to handle HTTP requests');
    });
  });

  describe('Subclass with onRequest', () => {
    it('calls onRequest and returns its response', async () => {
      const stub = env.ON_REQUEST_TEST_DO.getByName('onrequest_basic_1');
      const request = new Request('https://example.com/echo', {
        headers: {
          'x-lumenize-do-binding-name': 'ON_REQUEST_TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'onrequest_basic_1',
        },
      });
      const response = await stub.fetch(request);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('method=GET');
    });

    it('has identity available inside onRequest (proves __initFromHeaders ran first)', async () => {
      const stub = env.ON_REQUEST_TEST_DO.getByName('onrequest_identity_1');
      const request = new Request('https://example.com/status', {
        headers: {
          'x-lumenize-do-binding-name': 'ON_REQUEST_TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'onrequest_identity_1',
        },
      });
      const response = await stub.fetch(request);
      expect(response.status).toBe(200);
      const body = await response.json() as { instanceName: string; bindingName: string };
      expect(body.instanceName).toBe('onrequest_identity_1');
      expect(body.bindingName).toBe('ON_REQUEST_TEST_DO');
    });

    it('returns 404 for unmatched routes (subclass controls routing)', async () => {
      const stub = env.ON_REQUEST_TEST_DO.getByName('onrequest_404_1');
      const request = new Request('https://example.com/unknown', {
        headers: {
          'x-lumenize-do-binding-name': 'ON_REQUEST_TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'onrequest_404_1',
        },
      });
      const response = await stub.fetch(request);
      expect(response.status).toBe(404);
    });

    it('__initFromHeaders errors still take priority over onRequest', async () => {
      const stub = env.ON_REQUEST_TEST_DO.getByName('onrequest_init_error_1');
      // First request sets identity
      const req1 = new Request('https://example.com/status', {
        headers: {
          'x-lumenize-do-binding-name': 'ON_REQUEST_TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'onrequest_init_error_1',
        },
      });
      await stub.fetch(req1);

      // Second request with mismatched binding — should get error, not onRequest
      const req2 = new Request('https://example.com/status', {
        headers: {
          'x-lumenize-do-binding-name': 'WRONG_BINDING',
          'x-lumenize-do-instance-name-or-id': 'onrequest_init_error_1',
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
    const stub = env.ONSTART_TEST_DO.getByName('onstart_basic_1');

    // onStart should have been called
    const flag = await stub.getOnStartFlag();
    expect(flag).toBe(true);
  });

  it('propagates errors from onStart()', async () => {
    const stub = env.ONSTART_ERROR_DO.getByName('onstart_error_1');
    await expect(stub.getValue()).rejects.toThrow('Intentional onStart error for testing');
  });

  it('runs onStart() before any other operations', async () => {
    const stub = env.ONSTART_TEST_DO.getByName('onstart_before_ops_1');

    // The table should exist (created in onStart) before we try to use it
    await stub.insertValue('test-1', 'hello');
    const result = await stub.getValue('test-1');

    expect(result).toEqual({ id: 'test-1', value: 'hello' });
  });

  it('onStart() is wrapped in blockConcurrencyWhile', async () => {
    // Multiple concurrent calls should all see the table created by onStart
    const stub = env.ONSTART_TEST_DO.getByName('onstart_concurrent_1');

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
    const stub = env.TEST_DO.getByName('onstart_noop_1');

    // TestDO uses #initTable() in constructor instead
    await stub.insertUser('user-1', 'Alice', 30);
    const user = await stub.getUserById('user-1');

    expect(user).toMatchObject({ id: 'user-1', name: 'Alice', age: 30 });
  });
});

describe('@lumenize/mesh - NADIS Auto-injection', () => {
  describe('SQL Injectable', () => {
    it('auto-injects sql service', async () => {
      const stub = env.TEST_DO.getByName('sql_inject_test');

      await stub.insertUser('user1', 'Alice', 30);

      const user = await stub.getUserById('user1');
      expect(user).toMatchObject({
        id: 'user1',
        name: 'Alice',
        age: 30
      });
    });

    it('caches sql service instance', async () => {
      const stub = env.TEST_DO.getByName('sql_cache_test');
      
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
      const stub = env.TEST_DO.getByName('alarms_inject_test');
      
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
      const stub = env.TEST_DO.getByName('service_not_found_test');
      
      // Try to access a service that doesn't exist
      await expect(
        stub.accessNonExistentService()
      ).rejects.toThrow(/Service 'nonExistent' not found.*import '@lumenize\/nonExistent'/);
    });
  });

  describe('fetch() - Auto-init from Headers', () => {
    describe('Successful Initialization', () => {
      it('initializes from x-lumenize-do-binding-name header', async () => {
        const stub = env.TEST_DO.getByName('fetch_init_binding_1');
        await stub.clearStoredMetadata();
        
        const response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO'
        });
        
        expect(response.status).toBe(501); // Default "Not Implemented"
        expect(await stub.getStoredBindingName()).toBe('TEST_DO');
      });

      it('initializes from x-lumenize-do-instance-name-or-id header', async () => {
        const stub = env.TEST_DO.getByName('fetch_init_instance_1');
        await stub.clearStoredMetadata();
        
        const response = await stub.testFetch({
          'x-lumenize-do-instance-name-or-id': 'my_instance'
        });
        
        expect(response.status).toBe(501);
        expect(await stub.getStoredInstanceName()).toBe('my_instance');
      });

      it('initializes from both headers', async () => {
        const stub = env.TEST_DO.getByName('fetch_init_both_1');
        await stub.clearStoredMetadata();
        
        const response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'my_instance'
        });
        
        expect(response.status).toBe(501);
        expect(await stub.getStoredBindingName()).toBe('TEST_DO');
        expect(await stub.getStoredInstanceName()).toBe('my_instance');
      });

      it('does nothing when headers are missing', async () => {
        const stub = env.TEST_DO.getByName('fetch_no_headers_1');
        await stub.clearStoredMetadata();
        
        const response = await stub.testFetch({});
        
        expect(response.status).toBe(501);
        expect(await stub.getStoredBindingName()).toBeUndefined();
        expect(await stub.getStoredInstanceName()).toBeUndefined();
      });

      it('accepts same values on subsequent requests', async () => {
        const stub = env.TEST_DO.getByName('fetch_same_values_1');
        await stub.clearStoredMetadata();
        
        // First request
        let response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'my_instance'
        });
        expect(response.status).toBe(501);
        
        // Second request with same values
        response = await stub.testFetch({
          'x-lumenize-do-binding-name': 'TEST_DO',
          'x-lumenize-do-instance-name-or-id': 'my_instance'
        });
        expect(response.status).toBe(501);
        
        expect(await stub.getStoredBindingName()).toBe('TEST_DO');
        expect(await stub.getStoredInstanceName()).toBe('my_instance');
      });
    });

    describe('Error Handling', () => {
      it('returns 500 on binding name mismatch', async () => {
        const stub = env.TEST_DO.getByName('fetch_binding_mismatch_1');
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
        const stub = env.TEST_DO.getByName('fetch_instance_mismatch_1');
        await stub.clearStoredMetadata();
        
        // First request
        await stub.testFetch({
          'x-lumenize-do-instance-name-or-id': 'instance_1'
        });
        
        // Second request with different instance
        const response = await stub.testFetch({
          'x-lumenize-do-instance-name-or-id': 'instance_2'
        });
        
        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).toContain('DO instance name mismatch');
        expect(body).toContain('instance_1');
        expect(body).toContain('instance_2');
      });
    });
  });

  describe('this.lmz.* - Identity Abstraction API', () => {
    describe('Type Property', () => {
      it('returns "LumenizeDO" for type', async () => {
        const stub = env.TEST_DO.getByName('lmz_type_test');
        const type = await stub.testLmzType();
        expect(type).toBe('LumenizeDO');
      });
    });

    describe('Binding Name Property', () => {
      it('returns undefined when not set', async () => {
        const stub = env.TEST_DO.getByName('lmz_binding_empty_1');
        await stub.clearStoredMetadata();

        const bindingName = await stub.testLmzGetBindingName();
        expect(bindingName).toBeUndefined();
      });

      it('sets and gets binding name via __init', async () => {
        const stub = env.TEST_DO.getByName('lmz_binding_set_1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ bindingName: 'USER_DO' });

        const bindingName = await stub.testLmzGetBindingName();
        expect(bindingName).toBe('USER_DO');
      });

      it('allows setting same binding name multiple times', async () => {
        const stub = env.TEST_DO.getByName('lmz_binding_same_1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ bindingName: 'USER_DO' });
        await stub.testLmzApiInit({ bindingName: 'USER_DO' });

        const bindingName = await stub.testLmzGetBindingName();
        expect(bindingName).toBe('USER_DO');
      });

      it('throws on binding name mismatch', async () => {
        const stub = env.TEST_DO.getByName('lmz_binding_mismatch_1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ bindingName: 'USER_DO' });

        await expect(
          stub.testLmzApiInit({ bindingName: 'OTHER_DO' })
        ).rejects.toThrow(/DO binding name mismatch: stored 'USER_DO' but received 'OTHER_DO'/);
      });
    });

    describe('Instance Name Property', () => {
      it('returns undefined when not set', async () => {
        const stub = env.TEST_DO.getByName('lmz_instance_empty_1');
        await stub.clearStoredMetadata();

        const instanceName = await stub.testLmzGetInstanceName();
        expect(instanceName).toBeUndefined();
      });

      it('sets and gets instance name via __init', async () => {
        const stub = env.TEST_DO.getByName('lmz_instance_set_1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ instanceName: 'user_123' });

        const instanceName = await stub.testLmzGetInstanceName();
        expect(instanceName).toBe('user_123');
      });

      it('throws on instance name mismatch', async () => {
        const stub = env.TEST_DO.getByName('lmz_instance_mismatch_1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ instanceName: 'user_123' });

        await expect(
          stub.testLmzApiInit({ instanceName: 'user_456' })
        ).rejects.toThrow(/DO instance name mismatch: stored 'user_123' but received 'user_456'/);
      });
    });

    // NOTE: id property removed - use instanceName instead

    describe('__init() Internal Method', () => {
      it('initializes binding name', async () => {
        const stub = env.TEST_DO.getByName('lmz_init_binding_1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ bindingName: 'USER_DO' });

        expect(await stub.testLmzGetBindingName()).toBe('USER_DO');
      });

      it('initializes instance name', async () => {
        const stub = env.TEST_DO.getByName('lmz_init_instance_1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({ instanceName: 'user_123' });

        expect(await stub.testLmzGetInstanceName()).toBe('user_123');
      });

      it('initializes both binding name and instance name', async () => {
        const stub = env.TEST_DO.getByName('lmz_init_both_1');
        await stub.clearStoredMetadata();

        await stub.testLmzApiInit({
          bindingName: 'USER_DO',
          instanceName: 'user_456'
        });

        expect(await stub.testLmzGetBindingName()).toBe('USER_DO');
        expect(await stub.testLmzGetInstanceName()).toBe('user_456');
      });

      it('allows calling with empty options (no-op)', async () => {
        const stub = env.TEST_DO.getByName('lmz_init_empty_1');
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
        const caller = env.TEST_DO.getByName('callraw_caller_1');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'callraw_caller_1' });

        caller.callForOutcome('TEST_DO', 'callraw_callee_1', 'remoteEcho', ['hello']);

        await vi.waitFor(async () => {
          expect(await caller.getLastCallResult()).toBe('echo: hello');
        });
      });

      // A result the wire refuses must reach the handler as an error. Before, the encode threw
      // inside the callee's detached tail, so the handler never ran and the caller waited forever.
      it.each([
        ['weakmap', 'Could not serialize object of type "WeakMap". Convert it to a plain value first.'],
        ['response', 'Cannot serialize native Response object. Use ResponseSync instead.'],
      ])('delivers an unencodable %s result to the handler as a DataCloneError', async (kind, detail) => {
        const caller = env.TEST_DO.getByName(`unencodable_caller_${kind}`);
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: `unencodable_caller_${kind}` });

        caller.callForOutcome('TEST_DO', `unencodable_callee_${kind}`, 'returnUnencodable', [kind]);

        await vi.waitFor(async () => {
          expect(await caller.getLastCallErrorName()).toBe('DataCloneError');
        });
        expect(await caller.getLastCallError()).toBe(
          `The result of TEST_DO.returnUnencodable() cannot cross the mesh. ${detail}`,
        );
      });

      it('extracts the OperationChain from the continuation internally', async () => {
        const caller = env.TEST_DO.getByName('input_caller_2');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'input_caller_2' });

        caller.callForOutcome('TEST_DO', 'input_callee_2', 'remoteEcho', ['verified']);

        await vi.waitFor(async () => {
          expect(await caller.getLastCallResult()).toBe('echo: verified');
        });
      });
    });

    describe('Request envelope structure (via a one-way call, read on the callee)', () => {
      it('propagates caller metadata to the callee', async () => {
        const caller = env.TEST_DO.getByName('callraw_caller_2');
        const callee = env.TEST_DO.getByName('callraw_callee_2');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceName: 'caller_2' });

        caller.fireCall('TEST_DO', 'callraw_callee_2', 'remoteEcho', ['test']);

        const envelope = await vi.waitFor(async () => {
          const e = await callee.getLastEnvelope();
          expect(e).toBeTruthy();
          return e;
        });
        expect(envelope.version).toBe(1);
        expect(envelope.metadata.caller.type).toBe('LumenizeDO');
        expect(envelope.metadata.caller.bindingName).toBe('CALLER_DO');
        expect(envelope.metadata.caller.instanceName).toBe('caller_2');
      });

      it('propagates callee metadata for auto-initialization', async () => {
        const caller = env.TEST_DO.getByName('callraw_caller_3');
        const callee = env.TEST_DO.getByName('callraw_callee_3');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });

        caller.fireCall('TEST_DO', 'callraw_callee_3', 'remoteEcho', ['test']);

        const envelope = await vi.waitFor(async () => {
          const e = await callee.getLastEnvelope();
          expect(e).toBeTruthy();
          return e;
        });
        expect(envelope.metadata.callee.type).toBe('LumenizeDO');
        expect(envelope.metadata.callee.bindingName).toBe('TEST_DO');
        expect(envelope.metadata.callee.instanceName).toBe('callraw_callee_3');
      });

      it('auto-initializes callee identity from envelope metadata', async () => {
        const caller = env.TEST_DO.getByName('callraw_caller_4');
        const callee = env.TEST_DO.getByName('callraw_callee_4');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });

        const identityBefore = await callee.getCalleeIdentity();
        expect(identityBefore.bindingName).toBeUndefined();
        expect(identityBefore.instanceName).toBeUndefined();

        caller.fireCall('TEST_DO', 'callraw_callee_4', 'remoteEcho', ['test']);

        await vi.waitFor(async () => {
          const identityAfter = await callee.getCalleeIdentity();
          expect(identityAfter.bindingName).toBe('TEST_DO');
          expect(identityAfter.instanceName).toBe('callraw_callee_4');
        });
      });

      it('creates a valid v1 envelope with a preprocessed chain + complete metadata', async () => {
        const caller = env.TEST_DO.getByName('envelope_caller_3');
        const callee = env.TEST_DO.getByName('envelope_callee_3');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceName: 'caller_3' });

        caller.fireCall('TEST_DO', 'envelope_callee_3', 'remoteEcho', ['test']);

        const envelope = await vi.waitFor(async () => {
          const e = await callee.getLastEnvelope();
          expect(e).toBeTruthy();
          return e;
        });
        expect(envelope).toHaveProperty('version', 1);
        expect(typeof envelope.chain).toBe('object');
        expect(envelope.metadata).toMatchObject({
          caller: { type: 'LumenizeDO', bindingName: 'CALLER_DO', instanceName: 'caller_3' },
          callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'envelope_callee_3' },
        });
      });
    });

    describe('Envelope Validation', () => {
      it('rejects envelopes with no version', async () => {
        const callee = env.TEST_DO.getByName('validation_callee_1');

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
        const callee = env.TEST_DO.getByName('validation_callee_2');

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
        const callee = env.TEST_DO.getByName('validation_callee_3');

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
        const callee = env.TEST_DO.getByName('validation_callee_4');

        const validEnvelope = {
          version: 1,
          chain: preprocess([{ type: 'get', key: 'remoteEcho' }, { type: 'apply', args: ['validated'] }]),
          callContext: { callChain: [{ type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'validation_origin' }] },
          metadata: { callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'validation_callee_4' } },
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
        const caller = env.TEST_DO.getByName('call_caller_1');
        // Real identity so the callee can fire the handler back to this caller.
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call_caller_1' });

        caller.testCallWithContinuations('TEST_DO', 'call_callee_1', 'hello-call');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallResult()).toBe('echo: hello-call');
        });
      });

      it('returns immediately (synchronous call signature)', async () => {
        const caller = env.TEST_DO.getByName('call_caller_2');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call_caller_2' });

        // call() returns void (never awaits the remote work) — over RPC that resolves to undefined.
        expect(await caller.testCallWithContinuations('TEST_DO', 'call_callee_2', 'test')).toBeUndefined();
      });

      it('propagates caller metadata to the remote DO', async () => {
        const caller = env.TEST_DO.getByName('call_caller_3');
        const callee = env.TEST_DO.getByName('call_callee_3');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceName: 'caller_3' });

        // The callee's captured request envelope carries the caller metadata.
        caller.fireCall('TEST_DO', 'call_callee_3', 'remoteEcho', ['metadata-test']);

        const envelope = await vi.waitFor(async () => {
          const e = await callee.getLastEnvelope();
          expect(e).toBeTruthy();
          return e;
        });
        expect(envelope.metadata.caller.bindingName).toBe('CALLER_DO');
        expect(envelope.metadata.caller.instanceName).toBe('caller_3');
      });
    });

    describe('Error Handling', () => {
      it('handles remote errors in continuation', async () => {
        const caller = env.TEST_DO.getByName('call_error_caller_1');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call_error_caller_1' });

        caller.testCallWithError('TEST_DO', 'call_error_callee_1');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallError()).toBe('Remote error for testing');
        });
      });

      it('converts non-Error to Error in handler', async () => {
        const caller = env.TEST_DO.getByName('call_error_caller_2');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call_error_caller_2' });

        caller.testCallWithError('TEST_DO', 'call_error_callee_2');

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
        const caller = env.TEST_DO.getByName('call_onerroronly_error_caller');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call_onerroronly_error_caller' });

        caller.testCallOnErrorOnlyError('TEST_DO', 'call_onerroronly_error_callee');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallError()).toBe('Remote error for testing');
        });
      });
    });

    describe('Validation', () => {
      it('throws if caller has no bindingName', async () => {
        const caller = env.TEST_DO.getByName('call_validation_1');
        
        // Add a test method that tries to call without bindingName
        await expect(caller.testLmzCallWithoutBinding()).rejects.toThrow(
          /Cannot use call\(\) from a DO that doesn't know its own binding name/
        );
      });

      it('throws if remoteContinuation is invalid', async () => {
        const caller = env.TEST_DO.getByName('call_validation_2');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        
        // Test method that passes invalid remote continuation
        await expect(caller.testLmzCallWithInvalidRemote()).rejects.toThrow(
          /Invalid remoteContinuation/
        );
      });

      it('throws if handlerContinuation is invalid', async () => {
        const caller = env.TEST_DO.getByName('call_validation_3');

        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });

        // Test method that passes invalid handler continuation
        await expect(caller.testLmzCallWithInvalidHandler()).rejects.toThrow(
          /Invalid handlerContinuation/
        );
      });

      it('throws if handlerContinuation does not end in a call', async () => {
        const caller = env.TEST_DO.getByName('call_validation_4');
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        await expect(caller.testLmzCallWithPropertyHandler()).rejects.toThrow(
          /it must end in a call, which its answer is filled into/
        );
      });
    });

    describe('DO ID validation in __initFromHeaders', () => {
      it('returns 400 when instance header contains a DO ID', async () => {
        const stub = env.TEST_DO.getByName('fetch_do_id_reject');
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
        const caller = env.TEST_DO.getByName('call_marker_1');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call_marker_1' });

        caller.testCallWithContinuations('TEST_DO', 'call_marker_callee_1', 'marker-test');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallResult()).toBe('echo: marker-test');
        });
      });

      it('substitutes error into handler continuation', async () => {
        const caller = env.TEST_DO.getByName('call_marker_2');
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'call_marker_2' });

        caller.testCallWithError('TEST_DO', 'call_marker_callee_2');

        await vi.waitFor(async () => {
          expect(await caller.getLastCallError()).toContain('Remote error for testing');
        });
      });
    });
  });

});


describe('@lumenize/mesh - every call names a result handler', () => {
  it('offers no call without a handler on a DO or a Worker, and no broadcast without onResult', () => {
    // The assertions are the three directives, which `npm run type-check` enforces: each reports
    // itself unused, failing the check, if the handler becomes optional again.
    const typeChecksOnly = (node: TestDO, worker: TestWorker) => {
      // @ts-expect-error a DO's call names a result handler
      node.lmz.call('TEST_DO', 'i', node.ctn<TestDO>().ping());
      // @ts-expect-error a Worker's call names a result handler
      worker.lmz.call('TEST_DO', 'i', worker.ctn<TestDO>().ping());
      // @ts-expect-error a broadcast names onResult
      node.lmz.broadcast([], node.ctn<TestDO>().ping(), {});
    };
    expect(typeof typeChecksOnly).toBe('function');
  });
});
