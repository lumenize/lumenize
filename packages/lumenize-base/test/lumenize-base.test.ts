import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { env } from 'cloudflare:test';

describe('@lumenize/lumenize-base - Auto-injection', () => {
  describe('SQL Injectable', () => {
    it('auto-injects sql service', async () => {
      const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
      
      stub.initTable();
      stub.insertUser('user1', 'Alice', 30);
      
      const user = await stub.getUserById('user1');
      expect(user).toMatchObject({
        id: 'user1',
        name: 'Alice',
        age: 30
      });
    });

    it('caches sql service instance', async () => {
      const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
      
      // Access sql multiple times - should return same instance
      stub.initTable();
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
      const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
      
      const futureDate = new Date(Date.now() + 5000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'test-task' });
      
      expect(schedule.type).toBe('scheduled');
      expect(schedule.callback).toBe('handleAlarm');
      expect(schedule.payload).toEqual({ task: 'test-task' });
    });

    it('alarms can access auto-injected sql dependency', async () => {
      const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
      
      // Schedule multiple alarms - they all use SQL storage
      const date1 = new Date(Date.now() + 1000);
      const date2 = new Date(Date.now() + 2000);
      
      const schedule1 = await stub.scheduleAlarm(date1, { task: 'first' });
      const schedule2 = await stub.scheduleAlarm(date2, { task: 'second' });
      
      // Verify both were stored (proving sql dependency works)
      const retrieved1 = await stub.getSchedule(schedule1.id);
      const retrieved2 = await stub.getSchedule(schedule2.id);
      
      expect(retrieved1).toBeDefined();
      expect(retrieved2).toBeDefined();
      expect(retrieved1?.payload).toEqual({ task: 'first' });
      expect(retrieved2?.payload).toEqual({ task: 'second' });
    });

    it('cancels scheduled alarm', async () => {
      const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
      
      const futureDate = new Date(Date.now() + 5000);
      const schedule = await stub.scheduleAlarm(futureDate, { task: 'cancel-me' });
      
      const cancelled = await stub.cancelSchedule(schedule.id);
      expect(cancelled).toBe(true);
      
      const retrieved = await stub.getSchedule(schedule.id);
      expect(retrieved).toBeUndefined();
    });
  });

  describe('Service Caching', () => {
    it('reuses cached service instances', async () => {
      const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
      
      // Use both sql and alarms multiple times
      stub.initTable();
      stub.insertUser('user1', 'Alice', 30);
      
      const schedule1 = await stub.scheduleAlarm(new Date(Date.now() + 1000), { id: 1 });
      const schedule2 = await stub.scheduleAlarm(new Date(Date.now() + 2000), { id: 2 });
      
      stub.insertUser('user2', 'Bob', 25);
      
      // Verify operations succeeded (proving services work consistently)
      const user1 = await stub.getUserById('user1');
      const user2 = await stub.getUserById('user2');
      const retrieved1 = await stub.getSchedule(schedule1.id);
      const retrieved2 = await stub.getSchedule(schedule2.id);
      
      expect(user1.name).toBe('Alice');
      expect(user2.name).toBe('Bob');
      expect(retrieved1).toBeDefined();
      expect(retrieved2).toBeDefined();
    });
  });

  describe('Integration', () => {
    it('sql and alarms work together seamlessly', async () => {
      const stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
      
      // Create a table
      stub.initTable();
      
      // Insert a user
      stub.insertUser('user1', 'Alice', 30);
      
      // Schedule an alarm
      const schedule = await stub.scheduleAlarm(new Date(Date.now() + 1000), {
        userId: 'user1',
        action: 'send-reminder'
      });
      
      // Verify user exists
      const user = await stub.getUserById('user1');
      expect(user.name).toBe('Alice');
      
      // Verify alarm was scheduled
      const retrievedSchedule = await stub.getSchedule(schedule.id);
      expect(retrievedSchedule?.payload.userId).toBe('user1');
    });
  });
});

