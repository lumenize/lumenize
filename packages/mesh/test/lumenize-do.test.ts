import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';

describe('@lumenize/mesh - onStart() Lifecycle Hook', () => {
  it('calls onStart() when DO is first instantiated', async () => {
    const stub = env.ONSTART_TEST_DO.getByName('onstart-basic-1');

    // onStart should have been called
    const flag = await stub.getOnStartFlag();
    expect(flag).toBe(true);
  });

  // SKIP: This test causes vitest to hang during cleanup due to broken.inputGateBroken
  // The test passes, but the broken DO leaves workerd in a bad state
  it.skip('propagates errors from onStart()', async () => {
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
    stub.insertUser('user-1', 'Alice', 30);
    const user = await stub.getUserById('user-1');

    expect(user).toMatchObject({ id: 'user-1', name: 'Alice', age: 30 });
  });
});

describe('@lumenize/mesh - NADIS Auto-injection', () => {
  describe('SQL Injectable', () => {
    it('auto-injects sql service', async () => {
      const stub = env.TEST_DO.getByName('sql-inject-test');
      
      stub.insertUser('user1', 'Alice', 30);
      
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
      stub.insertUser('user1', 'Alice', 30);
      stub.insertUser('user2', 'Bob', 25);
      
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
      // Detailed alarm functionality is tested in @lumenize/alarms package
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
      it('returns "LumenizeBase" for type', async () => {
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

      it('sets and gets binding name', async () => {
        const stub = env.TEST_DO.getByName('lmz-binding-set-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzSetBindingName('USER_DO');
        
        const bindingName = await stub.testLmzGetBindingName();
        expect(bindingName).toBe('USER_DO');
      });

      it('allows setting same binding name multiple times', async () => {
        const stub = env.TEST_DO.getByName('lmz-binding-same-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzSetBindingName('USER_DO');
        await stub.testLmzSetBindingName('USER_DO');
        
        const bindingName = await stub.testLmzGetBindingName();
        expect(bindingName).toBe('USER_DO');
      });

      it('throws on binding name mismatch', async () => {
        const stub = env.TEST_DO.getByName('lmz-binding-mismatch-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzSetBindingName('USER_DO');
        
        await expect(
          stub.testLmzSetBindingName('OTHER_DO')
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

      it('sets and gets instance name', async () => {
        const stub = env.TEST_DO.getByName('lmz-instance-set-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzSetInstanceName('user-123');
        
        const instanceName = await stub.testLmzGetInstanceName();
        expect(instanceName).toBe('user-123');
      });

      it('throws on instance name mismatch', async () => {
        const stub = env.TEST_DO.getByName('lmz-instance-mismatch-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzSetInstanceName('user-123');
        
        await expect(
          stub.testLmzSetInstanceName('user-456')
        ).rejects.toThrow(/DO instance name mismatch: stored 'user-123' but received 'user-456'/);
      });
    });

    describe('ID Property', () => {
      it('returns ctx.id as string', async () => {
        const doId = env.TEST_DO.idFromName('lmz-id-get-1');
        const stub = env.TEST_DO.get(doId);
        
        const id = await stub.testLmzGetId();
        expect(id).toBe(doId.toString());
      });

      it('throws when attempting to set id', async () => {
        const stub = env.TEST_DO.getByName('lmz-id-set-error-1');
        
        await expect(
          stub.testLmzSetId('fake-id')
        ).rejects.toThrow(/Cannot set DO id - it's read-only from ctx.id/);
      });
    });

    describe('Instance Name Or ID Property', () => {
      it('returns undefined when neither name nor id is set', async () => {
        const stub = env.TEST_DO.getByName('lmz-name-or-id-empty-1');
        await stub.clearStoredMetadata();
        
        const result = await stub.testLmzGetInstanceNameOrId();
        // Will return ctx.id since id is always available
        expect(result).toBeDefined();
        expect(result).toMatch(/^[0-9a-f]{64}$/);
      });

      it('returns instance name when set (prefers name over id)', async () => {
        const stub = env.TEST_DO.getByName('lmz-name-or-id-name-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzSetInstanceName('user-123');
        
        const result = await stub.testLmzGetInstanceNameOrId();
        expect(result).toBe('user-123');
      });

      it('sets instance name when given a name (not hex ID)', async () => {
        const stub = env.TEST_DO.getByName('lmz-name-or-id-set-name-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzSetInstanceNameOrId('user-456');
        
        const instanceName = await stub.testLmzGetInstanceName();
        expect(instanceName).toBe('user-456');
      });

      it('validates ID without storing when given hex ID', async () => {
        const doId = env.TEST_DO.idFromName('lmz-name-or-id-set-id-1');
        const stub = env.TEST_DO.get(doId);
        await stub.clearStoredMetadata();
        
        // Set with actual DO ID - should validate but not store
        await stub.testLmzSetInstanceNameOrId(doId.toString());
        
        // Instance name should still be undefined (IDs not stored)
        const instanceName = await stub.testLmzGetInstanceName();
        expect(instanceName).toBeUndefined();
      });

      it('throws when ID does not match ctx.id', async () => {
        const stub = env.TEST_DO.getByName('lmz-name-or-id-id-mismatch-1');
        
        await expect(
          stub.testLmzSetInstanceNameOrId('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
        ).rejects.toThrow(/DO instance ID mismatch: ctx.id is/);
      });
    });

    describe('init() Convenience Method', () => {
      it('initializes binding name', async () => {
        const stub = env.TEST_DO.getByName('lmz-init-binding-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzApiInit({ bindingName: 'USER_DO' });
        
        expect(await stub.testLmzGetBindingName()).toBe('USER_DO');
      });

      it('initializes instance name', async () => {
        const stub = env.TEST_DO.getByName('lmz-init-instance-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzApiInit({ instanceNameOrId: 'user-123' });
        
        expect(await stub.testLmzGetInstanceName()).toBe('user-123');
      });

      it('initializes both binding name and instance name', async () => {
        const stub = env.TEST_DO.getByName('lmz-init-both-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzApiInit({ 
          bindingName: 'USER_DO',
          instanceNameOrId: 'user-456'
        });
        
        expect(await stub.testLmzGetBindingName()).toBe('USER_DO');
        expect(await stub.testLmzGetInstanceName()).toBe('user-456');
      });

      it('allows calling with no options (no-op)', async () => {
        const stub = env.TEST_DO.getByName('lmz-init-empty-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzApiInit();
        
        expect(await stub.testLmzGetBindingName()).toBeUndefined();
        expect(await stub.testLmzGetInstanceName()).toBeUndefined();
      });

      it('validates ID via instanceNameOrId', async () => {
        const doId = env.TEST_DO.idFromName('lmz-init-id-1');
        const stub = env.TEST_DO.get(doId);
        await stub.clearStoredMetadata();
        
        // Should succeed - ID matches ctx.id
        await stub.testLmzApiInit({ instanceNameOrId: doId.toString() });
        
        // IDs are not stored
        expect(await stub.testLmzGetInstanceName()).toBeUndefined();
      });
    });
  });

  describe('this.lmz.callRaw() - RPC Infrastructure', () => {
    describe('DO→DO Calls with Continuation', () => {
      it('successfully calls remote DO and returns result', async () => {
        const caller = env.TEST_DO.getByName('callraw-caller-1');
        const callee = env.TEST_DO.getByName('callraw-callee-1');
        
        // Initialize caller identity
        await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceNameOrId: 'caller-1' });
        
        // Make RPC call
        const result = await caller.testCallRawWithContinuation('TEST_DO', 'callraw-callee-1', 'hello');
        
        expect(result).toBe('echo: hello');
      });

      it('propagates caller metadata to callee', async () => {
        const caller = env.TEST_DO.getByName('callraw-caller-2');
        const callee = env.TEST_DO.getByName('callraw-callee-2');
        
        // Initialize caller identity
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceNameOrId: 'caller-2' });
        
        // Make call and get envelope from callee
        await caller.testCallRawWithContinuation('TEST_DO', 'callraw-callee-2', 'test');
        const envelope = await callee.getLastEnvelope();
        
        expect(envelope.version).toBe(1);
        expect(envelope.metadata.caller.type).toBe('LumenizeDO');
        expect(envelope.metadata.caller.bindingName).toBe('CALLER_DO');
        expect(envelope.metadata.caller.instanceNameOrId).toBe('caller-2');
      });

      it('propagates callee metadata for auto-initialization', async () => {
        const caller = env.TEST_DO.getByName('callraw-caller-3');
        const callee = env.TEST_DO.getByName('callraw-callee-3');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        
        // Make call
        await caller.testCallRawWithContinuation('TEST_DO', 'callraw-callee-3', 'test');
        const envelope = await callee.getLastEnvelope();
        
        expect(envelope.metadata.callee.type).toBe('LumenizeDO');
        expect(envelope.metadata.callee.bindingName).toBe('TEST_DO');
        expect(envelope.metadata.callee.instanceNameOrId).toBe('callraw-callee-3');
      });

      it('auto-initializes callee identity from envelope metadata', async () => {
        const caller = env.TEST_DO.getByName('callraw-caller-4');
        const callee = env.TEST_DO.getByName('callraw-callee-4');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        
        // Verify callee has no identity before the call
        const identityBefore = await callee.getCallerIdentity();
        expect(identityBefore.bindingName).toBeUndefined();
        expect(identityBefore.instanceNameOrId).toMatch(/^[0-9a-f]{64}$/); // Just the ID
        
        // Make call - should auto-initialize callee from envelope metadata
        await caller.testCallRawWithContinuation('TEST_DO', 'callraw-callee-4', 'test');
        
        // Verify callee now knows its full identity
        const identityAfter = await callee.getCallerIdentity();
        expect(identityAfter.bindingName).toBe('TEST_DO');
        expect(identityAfter.instanceNameOrId).toBe('callraw-callee-4');
      });
    });

    describe('Envelope Structure', () => {
      it('creates valid v1 envelope', async () => {
        const caller = env.TEST_DO.getByName('envelope-caller-1');
        const callee = env.TEST_DO.getByName('envelope-callee-1');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceNameOrId: 'caller-1' });
        await caller.testCallRawWithContinuation('TEST_DO', 'envelope-callee-1', 'test');
        
        const envelope = await callee.getLastEnvelope();
        
        expect(envelope).toHaveProperty('version', 1);
        expect(envelope).toHaveProperty('chain');
        expect(envelope).toHaveProperty('metadata');
      });

      it('includes preprocessed operation chain', async () => {
        const caller = env.TEST_DO.getByName('envelope-caller-2');
        const callee = env.TEST_DO.getByName('envelope-callee-2');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        await caller.testCallRawWithContinuation('TEST_DO', 'envelope-callee-2', 'test');
        
        const envelope = await callee.getLastEnvelope();
        
        // Chain should be preprocessed (not the original operation chain)
        expect(envelope.chain).toBeDefined();
        expect(typeof envelope.chain).toBe('object');
      });

      it('includes complete metadata structure', async () => {
        const caller = env.TEST_DO.getByName('envelope-caller-3');
        const callee = env.TEST_DO.getByName('envelope-callee-3');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceNameOrId: 'caller-3' });
        await caller.testCallRawWithContinuation('TEST_DO', 'envelope-callee-3', 'test');
        
        const envelope = await callee.getLastEnvelope();
        
        expect(envelope.metadata).toMatchObject({
          caller: {
            type: 'LumenizeDO',
            bindingName: 'CALLER_DO',
            instanceNameOrId: 'caller-3'
          },
          callee: {
            type: 'LumenizeDO',
            bindingName: 'TEST_DO',
            instanceNameOrId: 'envelope-callee-3'
          }
        });
      });
    });

    describe('Accepts Continuation Input', () => {
      it('works with Continuation from this.ctn()', async () => {
        const caller = env.TEST_DO.getByName('input-caller-1');
        const callee = env.TEST_DO.getByName('input-callee-1');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        
        const result = await caller.testCallRawWithContinuation('TEST_DO', 'input-callee-1', 'test-continuation');
        expect(result).toBe('echo: test-continuation');
      });

      it('extracts OperationChain from Continuation internally', async () => {
        const caller = env.TEST_DO.getByName('input-caller-2');
        const callee = env.TEST_DO.getByName('input-callee-2');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        
        // callRaw uses getOperationChain() to extract chain from continuation
        const result = await caller.testCallRawWithContinuation('TEST_DO', 'input-callee-2', 'verified');
        expect(result).toBe('echo: verified');
      });
    });

    describe('Caller Metadata Edge Cases', () => {
      it('handles caller with no bindingName set', async () => {
        const caller = env.TEST_DO.getByName('edge-caller-1');
        const callee = env.TEST_DO.getByName('edge-callee-1');
        
        // Don't initialize caller - bindingName will be undefined
        await caller.testCallRawWithContinuation('TEST_DO', 'edge-callee-1', 'test');
        
        const envelope = await callee.getLastEnvelope();
        expect(envelope.metadata.caller.bindingName).toBeUndefined();
        expect(envelope.metadata.caller.type).toBe('LumenizeDO');
      });

      it('handles caller with only bindingName (no instanceName)', async () => {
        const caller = env.TEST_DO.getByName('edge-caller-2');
        const callee = env.TEST_DO.getByName('edge-callee-2');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        await caller.testCallRawWithContinuation('TEST_DO', 'edge-callee-2', 'test');
        
        const envelope = await callee.getLastEnvelope();
        expect(envelope.metadata.caller.bindingName).toBe('CALLER_DO');
        // instanceNameOrId will be the ctx.id
        expect(envelope.metadata.caller.instanceNameOrId).toMatch(/^[0-9a-f]{64}$/);
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

        await expect(callee.__executeOperation(invalidEnvelope)).rejects.toThrow(
          /Unsupported RPC envelope version/
        );
      });

      it('rejects envelopes with unsupported version', async () => {
        const callee = env.TEST_DO.getByName('validation-callee-2');

        // __executeOperation expects envelope with only chain preprocessed
        const invalidEnvelope = {
          version: 2,
          chain: preprocess({}),
          metadata: {}
        };

        await expect(callee.__executeOperation(invalidEnvelope)).rejects.toThrow(
          /Unsupported RPC envelope version: 2/
        );
      });

      it('rejects envelopes with version 0', async () => {
        const callee = env.TEST_DO.getByName('validation-callee-3');

        // __executeOperation expects envelope with only chain preprocessed
        const invalidEnvelope = {
          version: 0,
          chain: preprocess({}),
          metadata: {}
        };

        await expect(callee.__executeOperation(invalidEnvelope)).rejects.toThrow(
          /Unsupported RPC envelope version: 0/
        );
      });

      it('accepts valid v1 envelopes', async () => {
        const caller = env.TEST_DO.getByName('validation-caller-4');
        const callee = env.TEST_DO.getByName('validation-callee-4');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        
        // Should not throw
        const result = await caller.testCallRawWithContinuation('TEST_DO', 'validation-callee-4', 'validated');
        expect(result).toBe('echo: validated');
      });
    });
  });

  describe('this.lmz.call() - Continuation Pattern', () => {
    describe('Basic DO→DO Calls', () => {
      it('executes remote call and handles result in continuation', async () => {
        const caller = env.TEST_DO.getByName('call-caller-1');
        const callee = env.TEST_DO.getByName('call-callee-1');
        
        // Initialize caller identity
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceNameOrId: 'caller-1' });
        
        // Make call - returns immediately
        caller.testCallWithContinuations('TEST_DO', 'call-callee-1', 'hello-call');
        
        // Wait a bit for async handler to complete
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify handler executed and stored result
        const result = await caller.getLastCallResult();
        expect(result).toBe('echo: hello-call');
      });

      it('returns immediately (synchronous call signature)', async () => {
        const caller = env.TEST_DO.getByName('call-caller-2');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO' });
        
        const startTime = Date.now();
        
        // This should return immediately, not block
        caller.testCallWithContinuations('TEST_DO', 'call-callee-2', 'test');
        
        const endTime = Date.now();
        
        // Should take < 10ms to return (not wait for remote call)
        expect(endTime - startTime).toBeLessThan(10);
      });

      it('propagates metadata to remote DO', async () => {
        const caller = env.TEST_DO.getByName('call-caller-3');
        const callee = env.TEST_DO.getByName('call-callee-3');
        
        await caller.testLmzApiInit({ bindingName: 'CALLER_DO', instanceNameOrId: 'caller-3' });
        
        caller.testCallWithContinuations('TEST_DO', 'call-callee-3', 'metadata-test');
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify callee received envelope with metadata
        const envelope = await callee.getLastEnvelope();
        expect(envelope.metadata.caller.bindingName).toBe('CALLER_DO');
        expect(envelope.metadata.caller.instanceNameOrId).toBe('caller-3');
      });
    });

    describe('Error Handling', () => {
      it('handles remote errors in continuation', async () => {
        const caller = env.TEST_DO.getByName('call-error-caller-1');
        const callee = env.TEST_DO.getByName('call-error-callee-1');
        
        await caller.testLmzApiInit({ bindingName: 'ERROR_CALLER_DO' });
        
        // Make call that will throw error
        caller.testCallWithError('TEST_DO', 'call-error-callee-1');
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Verify error was handled
        const error = await caller.getLastCallError();
        expect(error).toBe('Remote error for testing');
      });

      it('converts non-Error to Error in handler', async () => {
        const caller = env.TEST_DO.getByName('call-error-caller-2');
        
        await caller.testLmzApiInit({ bindingName: 'ERROR_CALLER_DO' });
        
        caller.testCallWithError('TEST_DO', 'call-error-callee-2');
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const error = await caller.getLastCallError();
        expect(error).toBeTruthy();
        expect(typeof error).toBe('string');
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

    describe('Continuation Markers', () => {
      it('substitutes result into handler continuation', async () => {
        const caller = env.TEST_DO.getByName('call-marker-1');
        
        await caller.testLmzApiInit({ bindingName: 'MARKER_DO' });
        
        caller.testCallWithContinuations('TEST_DO', 'call-marker-callee-1', 'marker-test');
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Result should be substituted into handler
        const result = await caller.getLastCallResult();
        expect(result).toBe('echo: marker-test');
      });

      it('substitutes error into handler continuation', async () => {
        const caller = env.TEST_DO.getByName('call-marker-2');
        
        await caller.testLmzApiInit({ bindingName: 'MARKER_DO' });
        
        caller.testCallWithError('TEST_DO', 'call-marker-callee-2');
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Error should be substituted into handler
        const error = await caller.getLastCallError();
        expect(error).toContain('Remote error for testing');
      });
    });
  });
});

