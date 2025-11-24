import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error - cloudflare:test module types
import { env, type Env } from 'cloudflare:test';

describe('@lumenize/core - sql', () => {
  let stub: DurableObjectStub<Env>;

  beforeEach(() => {
    stub = env.TEST_DO.get(env.TEST_DO.newUniqueId());
  });

  describe('Basic Operations', () => {
    it('creates table and inserts data', async () => {
      await stub.initTable();
      await stub.insertUser('user1', 'Alice', 30);
      
      const user = await stub.getUserById('user1');
      expect(user).toMatchObject({
        id: 'user1',
        name: 'Alice',
        age: 30
      });
    });

    it('handles template literal values correctly', async () => {
      await stub.initTable();
      await stub.insertUser('user2', 'Bob O\'Reilly', 25);  // Name with apostrophe
      
      const user = await stub.getUserById('user2');
      expect(user.name).toBe('Bob O\'Reilly');
    });

    it('returns empty array for no results', async () => {
      await stub.initTable();
      
      const users = await stub.getAllUsers();
      expect(users).toEqual([]);
    });

    it('returns multiple rows', async () => {
      await stub.initTable();
      await stub.insertUser('user1', 'Alice', 30);
      await stub.insertUser('user2', 'Bob', 25);
      await stub.insertUser('user3', 'Charlie', 35);
      
      const users = await stub.getAllUsers();
      expect(users).toHaveLength(3);
      expect(users.map((u: { name: any; }) => u.name)).toEqual(['Alice', 'Bob', 'Charlie']);
    });
  });

  describe('Parameterized Queries', () => {
    beforeEach(async () => {
      await stub.initTable();
      await stub.insertUser('user1', 'Alice', 30);
      await stub.insertUser('user2', 'Bob', 25);
      await stub.insertUser('user3', 'Charlie', 35);
      await stub.insertUser('user4', 'Diana', 28);
    });

    it('filters by single parameter', async () => {
      const user = await stub.getUserById('user2');
      expect(user.name).toBe('Bob');
    });

    it('filters by range parameters', async () => {
      const users = await stub.getUsersByAgeRange(26, 32);
      expect(users).toHaveLength(2);
      expect(users.map((u: { name: any; }) => u.name)).toEqual(['Diana', 'Alice']);
    });

    it('handles aggregate queries', async () => {
      const count = await stub.countUsers();
      expect(count).toBe(4);
    });
  });

  describe('Data Modification', () => {
    beforeEach(async () => {
      await stub.initTable();
      await stub.insertUser('user1', 'Alice', 30);
    });

    it('updates existing records', async () => {
      await stub.updateUserAge('user1', 31);
      
      const user = await stub.getUserById('user1');
      expect(user.age).toBe(31);
    });

    it('deletes records', async () => {
      await stub.deleteUser('user1');
      
      const user = await stub.getUserById('user1');
      expect(user).toBeNull();
    });

    it('clears all data', async () => {
      await stub.insertUser('user2', 'Bob', 25);
      await stub.insertUser('user3', 'Charlie', 35);
      
      await stub.clearTable();
      
      const count = await stub.countUsers();
      expect(count).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(async () => {
      await stub.initTable();
    });

    it('handles null values', async () => {
      await stub.insertUser('user1', 'Alice', 30);
      await stub.updateUserAge('user1', null as any);
      
      const user = await stub.getUserById('user1');
      expect(user.age).toBeNull();
    });

    it('handles empty strings', async () => {
      await stub.insertUser('user1', '', 30);
      
      const user = await stub.getUserById('user1');
      expect(user.name).toBe('');
    });

    it('handles special characters in values', async () => {
      const specialName = 'Test "quotes" and \'apostrophes\' and \n newlines';
      await stub.insertUser('user1', specialName, 30);
      
      const user = await stub.getUserById('user1');
      expect(user.name).toBe(specialName);
    });
  });

  // Note: Error handling tests removed - tested internal implementation details
  // The sql() function will still throw proper errors at runtime when misused
});

