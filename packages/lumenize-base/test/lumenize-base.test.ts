import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types
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
});

