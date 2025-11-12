import { describe, it, expect } from 'vitest';
import { newContinuation, executeOperationChain, getOperationChain, validateOperationChain, isNestedOperationMarker } from '../index.js';
import type { OperationChain } from '../index.js';

// Test target object with various methods
class TestObject {
  value = 42;
  
  getValue() {
    return this.value;
  }
  
  setValue(newValue: number) {
    this.value = newValue;
    return this;
  }
  
  add(a: number, b: number) {
    return a + b;
  }
  
  multiply(a: number, b: number) {
    return a * b;
  }
  
  combine(x: number, y: number) {
    return x + y;
  }
  
  async asyncMethod(value: number) {
    return value * 2;
  }
  
  nested = {
    deep: {
      method: (x: number) => x * 3
    }
  };
}

describe('OCAN - Operation Chaining And Nesting', () => {
  describe('newContinuation', () => {
    it('should create a proxy that builds operation chains', () => {
      const c = newContinuation<TestObject>();
      const chain = c.getValue();
      
      const operations = getOperationChain(chain);
      expect(operations).toEqual([
        { type: 'get', key: 'getValue' },
        { type: 'apply', args: [] }
      ]);
    });
    
    it('should support method chaining', () => {
      const c = newContinuation<TestObject>();
      const chain = c.setValue(100).getValue();
      
      const operations = getOperationChain(chain);
      expect(operations).toEqual([
        { type: 'get', key: 'setValue' },
        { type: 'apply', args: [100] },
        { type: 'get', key: 'getValue' },
        { type: 'apply', args: [] }
      ]);
    });
    
    it('should support property access chaining', () => {
      const c = newContinuation<TestObject>();
      const chain = c.nested.deep.method(5);
      
      const operations = getOperationChain(chain);
      expect(operations).toEqual([
        { type: 'get', key: 'nested' },
        { type: 'get', key: 'deep' },
        { type: 'get', key: 'method' },
        { type: 'apply', args: [5] }
      ]);
    });
    
    it('should support methods with multiple arguments', () => {
      const c = newContinuation<TestObject>();
      const chain = c.add(10, 20);
      
      const operations = getOperationChain(chain);
      expect(operations).toEqual([
        { type: 'get', key: 'add' },
        { type: 'apply', args: [10, 20] }
      ]);
    });
  });
  
  describe('Nesting', () => {
    it('should detect nested continuations and convert to markers', () => {
      const c = newContinuation<TestObject>();
      const nested1 = c.add(1, 2);
      const nested2 = c.multiply(3, 4);
      const chain = c.combine(nested1, nested2);
      
      const operations = getOperationChain(chain);
      expect(operations).toHaveLength(2);
      expect(operations![0]).toEqual({ type: 'get', key: 'combine' });
      expect(operations![1].type).toBe('apply');
      
      const applyOp = operations![1];
      if (applyOp.type !== 'apply') throw new Error('Expected apply operation');
      const args = applyOp.args;
      expect(args).toHaveLength(2);
      
      // Both arguments should be nested operation markers
      expect(isNestedOperationMarker(args[0])).toBe(true);
      expect(isNestedOperationMarker(args[1])).toBe(true);
      
      // Check the nested operation chains
      expect(args[0].__operationChain).toEqual([
        { type: 'get', key: 'add' },
        { type: 'apply', args: [1, 2] }
      ]);
      expect(args[1].__operationChain).toEqual([
        { type: 'get', key: 'multiply' },
        { type: 'apply', args: [3, 4] }
      ]);
    });
    
    it('should support deeply nested continuations', () => {
      const c = newContinuation<TestObject>();
      const innerNested = c.multiply(2, 3);
      const middleNested = c.add(innerNested, 5);
      const chain = c.combine(middleNested, 10);
      
      const operations = getOperationChain(chain);
      const applyOp = operations![1];
      if (applyOp.type !== 'apply') throw new Error('Expected apply operation');
      const args = applyOp.args;
      
      // First arg is a nested marker with another nested marker inside
      expect(isNestedOperationMarker(args[0])).toBe(true);
      const middleChain = args[0].__operationChain;
      const middleApplyOp = middleChain[1];
      if (middleApplyOp.type !== 'apply') throw new Error('Expected apply operation');
      expect(middleApplyOp.args[0]).toMatchObject({
        __isNestedOperation: true,
        __operationChain: [
          { type: 'get', key: 'multiply' },
          { type: 'apply', args: [2, 3] }
        ]
      });
    });
  });
  
  describe('executeOperationChain', () => {
    it('should execute simple method calls', async () => {
      const target = new TestObject();
      const operations: OperationChain = [
        { type: 'get', key: 'getValue' },
        { type: 'apply', args: [] }
      ];
      
      const result = await executeOperationChain(operations, target);
      expect(result).toBe(42);
    });
    
    it('should execute method chains', async () => {
      const target = new TestObject();
      const operations: OperationChain = [
        { type: 'get', key: 'setValue' },
        { type: 'apply', args: [100] },
        { type: 'get', key: 'getValue' },
        { type: 'apply', args: [] }
      ];
      
      const result = await executeOperationChain(operations, target);
      expect(result).toBe(100);
    });
    
    it('should execute property access chains', async () => {
      const target = new TestObject();
      const operations: OperationChain = [
        { type: 'get', key: 'nested' },
        { type: 'get', key: 'deep' },
        { type: 'get', key: 'method' },
        { type: 'apply', args: [5] }
      ];
      
      const result = await executeOperationChain(operations, target);
      expect(result).toBe(15);
    });
    
    it('should handle async methods', async () => {
      const target = new TestObject();
      const operations: OperationChain = [
        { type: 'get', key: 'asyncMethod' },
        { type: 'apply', args: [21] }
      ];
      
      const result = await executeOperationChain(operations, target);
      expect(result).toBe(42);
    });
    
    it('should resolve nested operation markers', async () => {
      const target = new TestObject();
      
      // Build operations with nested markers
      const c = newContinuation<TestObject>();
      const nested1 = c.add(10, 20);
      const nested2 = c.multiply(3, 4);
      const chain = c.combine(nested1, nested2);
      
      const operations = getOperationChain(chain)!;
      const result = await executeOperationChain(operations, target);
      
      // combine(add(10, 20), multiply(3, 4)) = combine(30, 12) = 42
      expect(result).toBe(42);
    });
    
    it('should resolve deeply nested operation markers', async () => {
      const target = new TestObject();
      
      const c = newContinuation<TestObject>();
      const innerNested = c.multiply(2, 3);
      const middleNested = c.add(innerNested, 5);
      const chain = c.combine(middleNested, 10);
      
      const operations = getOperationChain(chain)!;
      const result = await executeOperationChain(operations, target);
      
      // combine(add(multiply(2, 3), 5), 10) = combine(add(6, 5), 10) = combine(11, 10) = 21
      expect(result).toBe(21);
    });
    
    it('should preserve this context for method calls', async () => {
      const target = new TestObject();
      target.value = 99;
      
      const operations: OperationChain = [
        { type: 'get', key: 'setValue' },
        { type: 'apply', args: [50] },
        { type: 'get', key: 'value' }
      ];
      
      const result = await executeOperationChain(operations, target);
      expect(result).toBe(50);
      expect(target.value).toBe(50);
    });
  });
  
  describe('validateOperationChain', () => {
    it('should accept valid operation chains', () => {
      const operations: OperationChain = [
        { type: 'get', key: 'method' },
        { type: 'apply', args: [1, 2, 3] }
      ];
      
      expect(() => validateOperationChain(operations)).not.toThrow();
    });
    
    it('should reject chains that are too deep', () => {
      const operations: OperationChain = Array(51).fill({ type: 'get', key: 'prop' });
      
      expect(() => validateOperationChain(operations)).toThrow('Operation chain too deep');
    });
    
    it('should reject operations with too many arguments', () => {
      const operations: OperationChain = [
        { type: 'get', key: 'method' },
        { type: 'apply', args: Array(101).fill(1) }
      ];
      
      expect(() => validateOperationChain(operations)).toThrow('Too many arguments');
    });
    
    it('should accept custom limits', () => {
      const operations: OperationChain = Array(10).fill({ type: 'get', key: 'prop' });
      
      expect(() => validateOperationChain(operations, { maxDepth: 5 })).toThrow();
      expect(() => validateOperationChain(operations, { maxDepth: 20 })).not.toThrow();
    });
    
    it('should reject non-array operation chains', () => {
      expect(() => validateOperationChain({} as any)).toThrow('operations must be an array');
    });
  });
  
  describe('Integration - Full OCAN workflow', () => {
    it('should handle complex chaining and nesting', async () => {
      const target = new TestObject();
      
      // Build: combine(add(5, multiply(2, 3)), add(10, 5))
      const c = newContinuation<TestObject>();
      const innerMult = c.multiply(2, 3);
      const leftAdd = c.add(5, innerMult);
      const rightAdd = c.add(10, 5);
      const final = c.combine(leftAdd, rightAdd);
      
      const operations = getOperationChain(final)!;
      const result = await executeOperationChain(operations, target);
      
      // combine(add(5, 6), add(10, 5)) = combine(11, 15) = 26
      expect(result).toBe(26);
    });
  });

  describe('Error Handling', () => {
    it('should throw when maxArgs is exceeded', () => {
      const operations: OperationChain = [
        { type: 'get', key: 'add' },
        { type: 'apply', args: new Array(150).fill(1) } // 150 args > default 100
      ];
      
      expect(() => validateOperationChain(operations)).toThrow('Too many arguments');
    });

    it('should respect custom maxArgs config', () => {
      const operations: OperationChain = [
        { type: 'get', key: 'add' },
        { type: 'apply', args: [1, 2, 3] }
      ];
      
      expect(() => validateOperationChain(operations, { maxArgs: 2 })).toThrow('Too many arguments');
      expect(() => validateOperationChain(operations, { maxArgs: 5 })).not.toThrow();
    });

    it('should throw when trying to call non-function', async () => {
      const target = new TestObject();
      const operations: OperationChain = [
        { type: 'get', key: 'value' }, // value is a number, not a function
        { type: 'apply', args: [] }
      ];
      
      await expect(executeOperationChain(operations, target)).rejects.toThrow('is not a function');
    });

    it('should handle circular references in nested operations', async () => {
      const target = new TestObject();
      
      // Create a circular reference in arguments
      const circularObj: any = { prop: 'value' };
      circularObj.self = circularObj;
      
      const operations: OperationChain = [
        { type: 'get', key: 'add' },
        { type: 'apply', args: [5, 10, circularObj] }
      ];
      
      // Should not throw, circular refs should be handled gracefully
      const result = await executeOperationChain(operations, target);
      expect(result).toBe(15); // add ignores extra args
    });

    it('should handle nested operations with arrays', async () => {
      const target = new TestObject();
      const c = newContinuation<TestObject>();
      
      const nested1 = c.add(1, 2);
      const nested2 = c.add(3, 4);
      
      // Array containing nested operations
      const chain = c.combine(nested1, nested2);
      const operations = getOperationChain(chain)!;
      const result = await executeOperationChain(operations, target);
      
      // combine(3, 7) = 10
      expect(result).toBe(10);
    });

    it('should handle direct function calls without property access', async () => {
      const target = (x: number) => x * 2;
      
      const operations: OperationChain = [
        { type: 'apply', args: [5] }
      ];
      
      const result = await executeOperationChain(operations, target);
      expect(result).toBe(10);
    });

    it('should preserve identity when no nested markers exist', async () => {
      const target = {
        checkIdentity: (obj: object, arr: any[]) => ({ sameObj: obj, sameArr: arr })
      };
      
      const testObj = { prop: 'value' };
      const testArr = [1, 2, 3];
      
      const operations: OperationChain = [
        { type: 'get', key: 'checkIdentity' },
        { type: 'apply', args: [testObj, testArr] }
      ];
      
      const result = await executeOperationChain(operations, target);
      // Identity should be preserved when no markers are present
      expect(result.sameObj).toBe(testObj);
      expect(result.sameArr).toBe(testArr);
    });
  });
});

