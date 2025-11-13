import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('@lumenize/lumenize-base - NADIS Auto-injection', () => {
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

  describe('__lmzInit() - DO Metadata Initialization', () => {
    describe('First Initialization', () => {
      it('stores binding name when provided', async () => {
        const stub = env.TEST_DO.getByName('init-binding-test-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzInit({ doBindingName: 'TEST_DO' });
        
        const stored = await stub.getStoredBindingName();
        expect(stored).toBe('TEST_DO');
      });

      it('stores instance name when provided', async () => {
        const stub = env.TEST_DO.getByName('init-instance-test-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzInit({ doInstanceNameOrId: 'my-instance' });
        
        const stored = await stub.getStoredInstanceName();
        expect(stored).toBe('my-instance');
      });

      it('stores both binding name and instance name', async () => {
        const stub = env.TEST_DO.getByName('init-both-test-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzInit({ 
          doBindingName: 'TEST_DO',
          doInstanceNameOrId: 'my-instance'
        });
        
        expect(await stub.getStoredBindingName()).toBe('TEST_DO');
        expect(await stub.getStoredInstanceName()).toBe('my-instance');
      });

      it('allows calling with no options (no-op)', async () => {
        const stub = env.TEST_DO.getByName('init-empty-test-1');
        await stub.clearStoredMetadata();
        
        await stub.testLmzInit();
        
        expect(await stub.getStoredBindingName()).toBeUndefined();
        expect(await stub.getStoredInstanceName()).toBeUndefined();
      });
    });

    describe('Re-initialization with Same Values', () => {
      it('accepts same binding name on subsequent calls', async () => {
        const stub = env.TEST_DO.getByName('init-same-binding-test');
        await stub.clearStoredMetadata();
        
        await stub.testLmzInit({ doBindingName: 'TEST_DO' });
        await stub.testLmzInit({ doBindingName: 'TEST_DO' });
        
        expect(await stub.getStoredBindingName()).toBe('TEST_DO');
      });

      it('accepts same instance name on subsequent calls', async () => {
        const stub = env.TEST_DO.getByName('init-same-instance-test');
        await stub.clearStoredMetadata();
        
        await stub.testLmzInit({ doInstanceNameOrId: 'my-instance' });
        await stub.testLmzInit({ doInstanceNameOrId: 'my-instance' });
        
        expect(await stub.getStoredInstanceName()).toBe('my-instance');
      });
    });

    describe('Error Cases', () => {
      it('throws on binding name mismatch', async () => {
        const stub = env.TEST_DO.getByName('init-binding-mismatch-test');
        await stub.clearStoredMetadata();
        
        await stub.testLmzInit({ doBindingName: 'TEST_DO' });
        
        await expect(
          stub.testLmzInit({ doBindingName: 'OTHER_DO' })
        ).rejects.toThrow(/DO binding name mismatch: stored 'TEST_DO' but received 'OTHER_DO'/);
      });

      it('throws on instance name mismatch', async () => {
        const stub = env.TEST_DO.getByName('init-instance-mismatch-test');
        await stub.clearStoredMetadata();
        
        await stub.testLmzInit({ doInstanceNameOrId: 'instance-1' });
        
        await expect(
          stub.testLmzInit({ doInstanceNameOrId: 'instance-2' })
        ).rejects.toThrow(/DO instance name mismatch: stored 'instance-1' but received 'instance-2'/);
      });
    });

    describe('ID Verification (64-char hex)', () => {
      it('verifies ID matches this.ctx.id but does not store it', async () => {
        // Use env.TEST_DO.get() to get a DO by a specific ID
        const doId = env.TEST_DO.idFromName('test-id-verify-1');
        const stub = env.TEST_DO.get(doId);
        await stub.clearStoredMetadata();
        
        // Get the ID string representation
        const idString = doId.toString();
        
        // This should succeed because it matches the actual DO ID
        await stub.testLmzInit({ 
          doInstanceNameOrId: idString
        });
        
        // IDs are not stored (always available via this.ctx.id)
        const stored = await stub.getStoredInstanceName();
        expect(stored).toBeUndefined();
      });

      it('throws when ID does not match this.ctx.id', async () => {
        const doId = env.TEST_DO.idFromName('test-id-mismatch-1');
        const stub = env.TEST_DO.get(doId);
        await stub.clearStoredMetadata();
        
        // Try to init with a different ID (all f's)
        await expect(
          stub.testLmzInit({ 
            doInstanceNameOrId: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' 
          })
        ).rejects.toThrow(/DO instance ID mismatch: this\.ctx\.id is/);
      });

      it('stores names but does not check against this.ctx.id', async () => {
        const stub = env.TEST_DO.getByName('init-name-not-id-test');
        await stub.clearStoredMetadata();
        
        // This is not a 64-char hex string, so it should not be validated against ctx.id
        await stub.testLmzInit({ doInstanceNameOrId: 'my-instance-name' });
        
        // Names are stored
        expect(await stub.getStoredInstanceName()).toBe('my-instance-name');
      });
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
});

