/**
 * Error serialization tests with full fidelity
 * Tests: name, message, stack, cause, custom properties
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../src/index.js';

describe('Error Serialization - Basic', () => {
  it('handles basic Error', async () => {
    const error = new Error('Something went wrong');
    const result = await parse(await stringify(error));
    
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('Something went wrong');
    expect(result.name).toBe('Error');
  });

  it('preserves stack trace', async () => {
    const error = new Error('With stack');
    const originalStack = error.stack;
    
    const result = await parse(await stringify(error));
    
    expect(result.stack).toBeDefined();
    expect(result.stack).toBe(originalStack);
  });

  it('handles Error without stack', async () => {
    const error = new Error('No stack');
    delete (error as any).stack;
    
    const result = await parse(await stringify(error));
    
    expect(result.message).toBe('No stack');
    expect(result.stack).toBeUndefined();
  });

  it('handles empty Error', async () => {
    const error = new Error();
    const result = await parse(await stringify(error));
    
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('');
  });
});

describe('Error Serialization - Subclasses', () => {
  it('handles TypeError', async () => {
    const error = new TypeError('Type error occurred');
    const result = await parse(await stringify(error));
    
    expect(result).toBeInstanceOf(TypeError);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('Type error occurred');
    expect(result.name).toBe('TypeError');
  });

  it('handles RangeError', async () => {
    const error = new RangeError('Out of range');
    const result = await parse(await stringify(error));
    
    expect(result).toBeInstanceOf(RangeError);
    expect(result.message).toBe('Out of range');
    expect(result.name).toBe('RangeError');
  });

  it('handles ReferenceError', async () => {
    const error = new ReferenceError('Reference not found');
    const result = await parse(await stringify(error));
    
    expect(result).toBeInstanceOf(ReferenceError);
    expect(result.message).toBe('Reference not found');
  });

  it('handles SyntaxError', async () => {
    const error = new SyntaxError('Syntax invalid');
    const result = await parse(await stringify(error));
    
    expect(result).toBeInstanceOf(SyntaxError);
    expect(result.message).toBe('Syntax invalid');
  });

  it('handles URIError', async () => {
    const error = new URIError('Invalid URI');
    const result = await parse(await stringify(error));
    
    expect(result).toBeInstanceOf(URIError);
    expect(result.message).toBe('Invalid URI');
  });

  it('handles EvalError', async () => {
    const error = new EvalError('Eval failed');
    const result = await parse(await stringify(error));
    
    expect(result).toBeInstanceOf(EvalError);
    expect(result.message).toBe('Eval failed');
  });
});

describe('Error Serialization - Error Chaining (cause)', () => {
  it('handles Error with cause', async () => {
    const rootCause = new Error('Root cause');
    const error = new Error('Wrapper error', { cause: rootCause });
    
    const result = await parse(await stringify(error));
    
    expect(result.message).toBe('Wrapper error');
    expect(result.cause).toBeInstanceOf(Error);
    expect(result.cause.message).toBe('Root cause');
  });

  it('handles Error with TypeError cause', async () => {
    const cause = new TypeError('Type mismatch');
    const error = new Error('Failed operation', { cause });
    
    const result = await parse(await stringify(error));
    
    expect(result.cause).toBeInstanceOf(TypeError);
    expect(result.cause.message).toBe('Type mismatch');
  });

  it('handles nested Error causes (3 levels)', async () => {
    const level3 = new Error('Level 3');
    const level2 = new Error('Level 2', { cause: level3 });
    const level1 = new Error('Level 1', { cause: level2 });
    
    const result = await parse(await stringify(level1));
    
    expect(result.message).toBe('Level 1');
    expect(result.cause.message).toBe('Level 2');
    expect(result.cause.cause.message).toBe('Level 3');
    expect(result.cause.cause.cause).toBeUndefined();
  });

  it('handles Error with non-Error cause', async () => {
    const error = new Error('With string cause', { cause: 'just a string' });
    
    const result = await parse(await stringify(error));
    
    expect(result.cause).toBe('just a string');
  });

  it('handles Error with object cause', async () => {
    const cause = { code: 'ERR_NETWORK', details: 'Timeout' };
    const error = new Error('Network error', { cause });
    
    const result = await parse(await stringify(error));
    
    expect(result.cause).toEqual({ code: 'ERR_NETWORK', details: 'Timeout' });
  });

  it('preserves stack trace through error chain', async () => {
    const cause = new Error('Cause with stack');
    const error = new Error('Wrapper with stack', { cause });
    
    const result = await parse(await stringify(error));
    
    expect(result.stack).toBeDefined();
    expect(result.cause.stack).toBeDefined();
  });
});

describe('Error Serialization - Custom Properties', () => {
  it('handles Error with custom code property', async () => {
    const error: any = new Error('Custom error');
    error.code = 'ERR_CUSTOM';
    error.statusCode = 500;
    
    const result: any = await parse(await stringify(error));
    
    expect(result.message).toBe('Custom error');
    expect(result.code).toBe('ERR_CUSTOM');
    expect(result.statusCode).toBe(500);
  });

  it('handles Error with complex custom properties', async () => {
    const error: any = new Error('Rich error');
    error.metadata = { timestamp: Date.now(), user: 'test' };
    error.tags = ['network', 'timeout'];
    
    const result: any = await parse(await stringify(error));
    
    expect(result.metadata).toEqual(error.metadata);
    expect(result.tags).toEqual(['network', 'timeout']);
  });

  it('handles Error with nested object properties', async () => {
    const error: any = new Error('Nested props');
    error.context = {
      request: { url: '/api/test', method: 'POST' },
      response: { status: 500, body: null }
    };
    
    const result: any = await parse(await stringify(error));
    
    expect(result.context.request.url).toBe('/api/test');
    expect(result.context.response.status).toBe(500);
  });

  it('preserves custom name property on standard Error', async () => {
    const error: any = new Error('Standard');
    error.name = 'CustomName'; // Custom name should be preserved
    error.message = 'Standard message';
    error.stack = 'Custom stack';
    
    const result: any = await parse(await stringify(error));
    
    // Standard properties should be preserved with their custom values
    expect(result.name).toBe('CustomName'); // Custom name is preserved
    expect(result.message).toBe('Standard message');
    expect(result.stack).toBe('Custom stack');
    
    // name, message, stack should NOT be in customProps (they're standard properties)
    expect(result.customProps).toBeUndefined();
  });
});

describe('Error Serialization - In Data Structures', () => {
  it('handles Error in object', async () => {
    const obj = {
      status: 'failed',
      error: new Error('Operation failed'),
      timestamp: Date.now()
    };
    
    const result = await parse(await stringify(obj));
    
    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('Operation failed');
  });

  it('handles Error in array', async () => {
    const arr = [
      new Error('First'),
      'normal value',
      new TypeError('Second')
    ];
    
    const result = await parse(await stringify(arr));
    
    expect(result[0]).toBeInstanceOf(Error);
    expect(result[0].message).toBe('First');
    expect(result[1]).toBe('normal value');
    expect(result[2]).toBeInstanceOf(TypeError);
    expect(result[2].message).toBe('Second');
  });

  it('handles Error in nested structures', async () => {
    const nested = {
      results: [
        { success: true, data: 'ok' },
        { success: false, error: new Error('Failed') }
      ]
    };
    
    const result = await parse(await stringify(nested));
    
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].error).toBeInstanceOf(Error);
    expect(result.results[1].error.message).toBe('Failed');
  });

  it('handles Error as Map value', async () => {
    const map = new Map([
      ['success', { status: 'ok' }],
      ['error', new Error('Map error')]
    ]);
    
    const result = await parse(await stringify(map));
    
    expect(result).toBeInstanceOf(Map);
    expect(result.get('error')).toBeInstanceOf(Error);
    expect(result.get('error').message).toBe('Map error');
  });

  it('handles Error in Set', async () => {
    const error1 = new Error('Error 1');
    const error2 = new Error('Error 2');
    const set = new Set([error1, 'value', error2]);
    
    const result = await parse(await stringify(set));
    
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(3);
    
    const errors = Array.from(result).filter(v => v instanceof Error);
    expect(errors).toHaveLength(2);
  });
});

describe('Error Serialization - Edge Cases', () => {
  it('handles circular reference in error cause', async () => {
    const error1: any = new Error('Error 1');
    const error2 = new Error('Error 2', { cause: error1 });
    error1.cause = error2; // Circular!
    
    const result: any = await parse(await stringify(error1));
    
    expect(result.message).toBe('Error 1');
    expect(result.cause.message).toBe('Error 2');
    expect(result.cause.cause).toBe(result); // Circular preserved
  });

  it('handles Error with function in custom property', async () => {
    const error: any = new Error('With function');
    error.handler = () => 'test';
    
    const result: any = await parse(await stringify(error));
    
    expect(result.message).toBe('With function');
    expect(result.handler.__lmz_Function).toBe(true);
  });

  it('handles Error with special numbers', async () => {
    const error: any = new Error('With special numbers');
    error.notANumber = NaN;
    error.infinite = Infinity;
    
    const result: any = await parse(await stringify(error));
    
    expect(result.notANumber).toBeNaN();
    expect(result.infinite).toBe(Infinity);
  });

  it('handles multiple Errors with same message', async () => {
    const errors = [
      new Error('Same message'),
      new Error('Same message'),
      new TypeError('Same message')
    ];
    
    const result = await parse(await stringify(errors));
    
    expect(result[0]).toBeInstanceOf(Error);
    expect(result[1]).toBeInstanceOf(Error);
    expect(result[2]).toBeInstanceOf(TypeError);
    expect(result[0]).not.toBe(result[1]); // Different instances
  });
});

