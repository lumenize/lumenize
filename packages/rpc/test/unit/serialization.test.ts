import { describe, it, expect } from 'vitest';
import { serializeError, deserializeError } from '../../src/serialization.js';

describe('Error Serialization', () => {
  it('should preserve basic Error with custom properties', () => {
    const original = new Error('Test message') as any;
    original.code = 'ERR_TEST';
    original.statusCode = 400;
    
    const roundTrip = deserializeError(serializeError(original)) as any;
    
    expect(roundTrip).toBeInstanceOf(Error);
    expect(roundTrip.message).toBe(original.message);
    expect(roundTrip.code).toBe(original.code);
    expect(roundTrip.statusCode).toBe(original.statusCode);
  });
  
  it('should preserve TypeError with custom properties', () => {
    const original = new TypeError('Invalid type') as any;
    original.field = 'username';
    original.details = { min: 3, max: 50 };
    
    const roundTrip = deserializeError(serializeError(original)) as any;
    
    expect(roundTrip).toBeInstanceOf(TypeError);
    expect(roundTrip.name).toBe('TypeError');
    expect(roundTrip.message).toBe(original.message);
    expect(roundTrip.field).toBe(original.field);
    expect(roundTrip.details).toEqual(original.details);
  });
  
  it('should preserve custom Error class with complex metadata', () => {
    class CustomError extends Error {
      public code: any;
      public metadata: any;
      
      constructor(message: string, code: any, metadata: any) {
        super(message);
        this.name = 'CustomError';
        this.code = code;
        this.metadata = metadata;
      }
    }
    
    const original = new CustomError('Custom error', 'ERR_CUSTOM', {
      userId: 123,
      timestamp: new Date('2025-01-01'),
      nested: { deep: 'value' }
    });
    
    const roundTrip = deserializeError(serializeError(original)) as any;
    
    expect(roundTrip).toBeInstanceOf(Error); // Note: Custom classes fall back to Error
    expect(roundTrip.message).toBe(original.message);
    expect(roundTrip.code).toBe(original.code);
    expect(roundTrip.metadata).toEqual(original.metadata);
  });
  
  it('should allow deserialized errors to be thrown properly', () => {
    const original = new Error('Throwable error') as any;
    original.code = 'ERR_THROW';
    
    const roundTrip = deserializeError(serializeError(original));
    
    expect(() => {
      throw roundTrip;
    }).toThrow('Throwable error');
    
    try {
      throw roundTrip;
    } catch (caught: any) {
      expect(caught).toBeInstanceOf(Error);
      expect(caught.code).toBe('ERR_THROW');
    }
  });
  
  it('should pass through non-Error objects unchanged', () => {
    const notAnError = { message: 'not an error', code: 500 };
    const result = deserializeError(serializeError(notAnError));
    expect(result).toBe(notAnError);
  });
  
  it('should handle null/undefined', () => {
    expect(deserializeError(serializeError(null))).toBe(null);
    expect(deserializeError(serializeError(undefined))).toBe(undefined);
  });
});