import { describe, it, expect } from 'vitest';
import { StorageMock } from '../../src/storage-mock';

describe('StorageMock', () => {
  describe('getItem / setItem', () => {
    it('should store and retrieve values', () => {
      const storage = new StorageMock();
      storage.setItem('key', 'value');
      expect(storage.getItem('key')).toBe('value');
    });

    it('should return null for missing keys', () => {
      const storage = new StorageMock();
      expect(storage.getItem('missing')).toBeNull();
    });

    it('should coerce values to strings', () => {
      const storage = new StorageMock();
      storage.setItem('num', 42 as unknown as string);
      expect(storage.getItem('num')).toBe('42');
    });

    it('should overwrite existing values', () => {
      const storage = new StorageMock();
      storage.setItem('key', 'first');
      storage.setItem('key', 'second');
      expect(storage.getItem('key')).toBe('second');
    });
  });

  describe('removeItem', () => {
    it('should remove a stored item', () => {
      const storage = new StorageMock();
      storage.setItem('key', 'value');
      storage.removeItem('key');
      expect(storage.getItem('key')).toBeNull();
    });

    it('should not throw for missing keys', () => {
      const storage = new StorageMock();
      expect(() => storage.removeItem('missing')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('should remove all items', () => {
      const storage = new StorageMock();
      storage.setItem('a', '1');
      storage.setItem('b', '2');
      storage.clear();
      expect(storage.length).toBe(0);
      expect(storage.getItem('a')).toBeNull();
    });
  });

  describe('length', () => {
    it('should reflect the number of stored items', () => {
      const storage = new StorageMock();
      expect(storage.length).toBe(0);
      storage.setItem('a', '1');
      expect(storage.length).toBe(1);
      storage.setItem('b', '2');
      expect(storage.length).toBe(2);
      storage.removeItem('a');
      expect(storage.length).toBe(1);
    });
  });

  describe('key()', () => {
    it('should return the key at the given index', () => {
      const storage = new StorageMock();
      storage.setItem('alpha', '1');
      storage.setItem('beta', '2');
      expect(storage.key(0)).toBe('alpha');
      expect(storage.key(1)).toBe('beta');
    });

    it('should return null for out-of-range index', () => {
      const storage = new StorageMock();
      storage.setItem('a', '1');
      expect(storage.key(5)).toBeNull();
      expect(storage.key(-1)).toBeNull();
    });
  });

  describe('clone', () => {
    it('should create an independent copy', () => {
      const original = new StorageMock();
      original.setItem('lmz_tab', 'abc12345');
      original.setItem('other', 'data');

      const cloned = original.clone();

      // Cloned has same data
      expect(cloned.getItem('lmz_tab')).toBe('abc12345');
      expect(cloned.getItem('other')).toBe('data');

      // Mutations are independent
      cloned.setItem('lmz_tab', 'new-value');
      expect(original.getItem('lmz_tab')).toBe('abc12345');
      expect(cloned.getItem('lmz_tab')).toBe('new-value');
    });
  });
});
