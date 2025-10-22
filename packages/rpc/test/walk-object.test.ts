import { describe, it, expect } from 'vitest';
import { walkObject } from '../src/walk-object';

describe('walkObject', () => {
  describe('primitives and null handling', () => {
    it('should return primitives unchanged', async () => {
      const transformer = (value: any) => value;
      
      expect(await walkObject(null, transformer)).toBe(null);
      expect(await walkObject(undefined, transformer)).toBe(undefined);
      expect(await walkObject(42, transformer)).toBe(42);
      expect(await walkObject('hello', transformer)).toBe('hello');
      expect(await walkObject(true, transformer)).toBe(true);
      expect(await walkObject(false, transformer)).toBe(false);
    });
  });

  describe('array handling', () => {
    it('should walk array items and apply transformer', async () => {
      const arr = [1, 2, 3];
      const transformer = (value: any) => typeof value === 'number' ? value * 2 : value;
      
      const result = await walkObject(arr, transformer);
      
      expect(result).toEqual([2, 4, 6]);
      expect(result).not.toBe(arr); // new array created
    });

    it('should recursively walk nested objects in arrays', async () => {
      const arr = [{ a: 1 }, { b: 2 }];
      const transformer = (value: any) => typeof value === 'number' ? value * 10 : value;
      
      const result = await walkObject(arr, transformer);
      
      expect(result).toEqual([{ a: 10 }, { b: 20 }]);
    });

    it('should pass correct parameters to transformer for array items', async () => {
      const arr = ['a', 'b', 'c'];
      const calls: Array<{ value: any; key: number; parent: any }> = [];
      
      const transformer = (value: any, key: string | number, parent: any) => {
        calls.push({ value, key: key as number, parent });
        return value;
      };
      
      await walkObject(arr, transformer);
      
      expect(calls).toHaveLength(3);
      expect(calls[0]).toEqual({ value: 'a', key: 0, parent: arr });
      expect(calls[1]).toEqual({ value: 'b', key: 1, parent: arr });
      expect(calls[2]).toEqual({ value: 'c', key: 2, parent: arr });
    });
  });

  describe('object handling', () => {
    it('should walk object properties and apply transformer', async () => {
      const obj = { a: 1, b: 2, c: 3 };
      const transformer = (value: any) => typeof value === 'number' ? value * 2 : value;
      
      const result = await walkObject(obj, transformer);
      
      expect(result).toEqual({ a: 2, b: 4, c: 6 });
      expect(result).not.toBe(obj); // new object created
    });

    it('should recursively walk nested objects', async () => {
      const obj = {
        outer: {
          inner: {
            value: 5
          }
        }
      };
      const transformer = (value: any) => typeof value === 'number' ? value * 10 : value;
      
      const result = await walkObject(obj, transformer);
      
      expect(result).toEqual({
        outer: {
          inner: {
            value: 50
          }
        }
      });
    });

    it('should pass correct parameters to transformer for object properties', async () => {
      const obj = { x: 10, y: 20 };
      const calls: Array<{ value: any; key: string; parent: any }> = [];
      
      const transformer = (value: any, key: string | number, parent: any) => {
        calls.push({ value, key: key as string, parent });
        return value;
      };
      
      await walkObject(obj, transformer);
      
      expect(calls).toHaveLength(2);
      expect(calls.some(c => c.key === 'x' && c.value === 10 && c.parent === obj)).toBe(true);
      expect(calls.some(c => c.key === 'y' && c.value === 20 && c.parent === obj)).toBe(true);
    });
  });

  describe('circular reference handling', () => {
    it('should handle circular references in objects', async () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      
      const transformer = (value: any) => value;
      const result = await walkObject(obj, transformer);
      
      expect(result.a).toBe(1);
      expect(result.self).toBe(result); // circular reference preserved
    });

    it('should handle circular references in arrays', async () => {
      const arr: any[] = [1, 2];
      arr.push(arr);
      
      const transformer = (value: any) => value;
      const result = await walkObject(arr, transformer);
      
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(2);
      expect(result[2]).toBe(result); // circular reference preserved
    });

    it('should handle complex circular references', async () => {
      const obj1: any = { name: 'obj1' };
      const obj2: any = { name: 'obj2' };
      obj1.ref = obj2;
      obj2.ref = obj1;
      
      const transformer = (value: any) => value;
      const result = await walkObject(obj1, transformer);
      
      expect(result.name).toBe('obj1');
      expect(result.ref.name).toBe('obj2');
      expect(result.ref.ref).toBe(result); // circular reference back to obj1
    });
  });

  describe('prototype chain handling', () => {
    it('should walk prototype chain properties', async () => {
      class Parent {
        parentProp = 'parent';
        parentMethod() {
          return 'parent method';
        }
      }
      
      class Child extends Parent {
        childProp = 'child';
      }
      
      const instance = new Child();
      const transformer = (value: any) => value;
      
      const result = await walkObject(instance, transformer);
      
      expect(result.childProp).toBe('child');
      expect(result.parentProp).toBe('parent');
      expect(typeof result.parentMethod).toBe('function');
    });

    it('should not overwrite instance properties with prototype properties', async () => {
      class Parent {
        prop = 'parent';
      }
      
      class Child extends Parent {
        prop = 'child'; // overrides parent
      }
      
      const instance = new Child();
      const transformer = (value: any) => value;
      
      const result = await walkObject(instance, transformer);
      
      expect(result.prop).toBe('child'); // instance property, not prototype
    });

    it('should not include constructor in result', async () => {
      class MyClass {
        prop = 'value';
      }
      
      const instance = new MyClass();
      const transformer = (value: any) => value;
      
      const result = await walkObject(instance, transformer);
      
      expect(result.prop).toBe('value');
      expect(result.hasOwnProperty('constructor')).toBe(false);
    });

    it('should apply transformer to prototype properties', async () => {
      class MyClass {
        value = 5;
        protoValue = 10;
      }
      
      const instance = new MyClass();
      const transformer = (value: any) => typeof value === 'number' ? value * 2 : value;
      
      const result = await walkObject(instance, transformer);
      
      expect(result.value).toBe(10); // instance property transformed
      expect(result.protoValue).toBe(20); // prototype property transformed
    });
  });

  describe('transformer behavior', () => {
    it('should only recursively walk when transformer returns unchanged object', async () => {
      const inner = { value: 5 };
      const outer = { inner };
      
      let transformerCalls = 0;
      const transformer = (value: any) => {
        transformerCalls++;
        // Transform the inner object, preventing recursive walk
        if (value === inner) {
          return { replaced: true };
        }
        return value;
      };
      
      const result = await walkObject(outer, transformer);
      
      expect(result.inner).toEqual({ replaced: true });
      expect(result.inner.value).toBeUndefined(); // wasn't walked because transformer changed it
    });

    it('should support async transformers', async () => {
      const obj = { a: 1, b: 2 };
      
      const transformer = async (value: any) => {
        if (typeof value === 'number') {
          // Simulate async operation
          await new Promise(resolve => setTimeout(resolve, 1));
          return value * 2;
        }
        return value;
      };
      
      const result = await walkObject(obj, transformer);
      
      expect(result).toEqual({ a: 2, b: 4 });
    });

    it('should handle transformers that change types', async () => {
      const obj = {
        num: 42,
        str: 'hello',
        bool: true,
        obj: { nested: 'value' }
      };
      
      const transformer = (value: any) => {
        if (typeof value === 'number') return `num:${value}`;
        if (typeof value === 'boolean') return value ? 'YES' : 'NO';
        return value;
      };
      
      const result = await walkObject(obj, transformer);
      
      expect(result).toEqual({
        num: 'num:42',
        str: 'hello',
        bool: 'YES',
        obj: { nested: 'value' }
      });
    });
  });

  describe('complex scenarios', () => {
    it('should handle mixed arrays and objects', async () => {
      const data = {
        users: [
          { name: 'Alice', age: 30 },
          { name: 'Bob', age: 25 }
        ],
        config: {
          enabled: true,
          settings: [1, 2, 3]
        }
      };
      
      const transformer = (value: any) => typeof value === 'number' ? value * 2 : value;
      const result = await walkObject(data, transformer);
      
      expect(result).toEqual({
        users: [
          { name: 'Alice', age: 60 },
          { name: 'Bob', age: 50 }
        ],
        config: {
          enabled: true,
          settings: [2, 4, 6]
        }
      });
    });

    it('should handle empty arrays and objects', async () => {
      const data = {
        emptyArray: [],
        emptyObject: {},
        nested: {
          alsoEmpty: []
        }
      };
      
      const transformer = (value: any) => value;
      const result = await walkObject(data, transformer);
      
      expect(result).toEqual({
        emptyArray: [],
        emptyObject: {},
        nested: {
          alsoEmpty: []
        }
      });
    });

    it('should handle built-in types when transformer decides what to do', async () => {
      const date = new Date('2024-01-01');
      const regex = /test/;
      const map = new Map([['key', 'value']]);
      const set = new Set([1, 2, 3]);
      
      const obj = { date, regex, map, set };
      
      // Transformer serializes built-in types
      const transformer = (value: any) => {
        if (value instanceof Date) return { __type: 'Date', value: value.toISOString() };
        if (value instanceof RegExp) return { __type: 'RegExp', source: value.source };
        if (value instanceof Map) return { __type: 'Map', entries: Array.from(value.entries()) };
        if (value instanceof Set) return { __type: 'Set', values: Array.from(value.values()) };
        return value;
      };
      
      const result = await walkObject(obj, transformer);
      
      expect(result.date).toEqual({ __type: 'Date', value: '2024-01-01T00:00:00.000Z' });
      expect(result.regex).toEqual({ __type: 'RegExp', source: 'test' });
      expect(result.map).toEqual({ __type: 'Map', entries: [['key', 'value']] });
      expect(result.set).toEqual({ __type: 'Set', values: [1, 2, 3] });
    });
  });

  describe('seen WeakMap persistence', () => {
    it('should use the provided seen WeakMap across recursive calls', async () => {
      const shared = { value: 'shared' };
      const obj1 = { shared };
      const obj2 = { shared };
      const container = { obj1, obj2 };
      
      const seen = new WeakMap();
      const transformer = (value: any) => value;
      
      const result = await walkObject(container, transformer);
      
      // Both obj1.shared and obj2.shared should reference the same processed object
      expect(result.obj1.shared).toBe(result.obj2.shared);
    });
  });
});
