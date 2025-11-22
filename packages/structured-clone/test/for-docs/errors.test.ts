/**
 * Pedagogical examples for Error serialization documentation
 * Teaching-focused with clear error handling patterns
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../../src/index.js';

describe('Error Serialization', () => {
  it('preserves Error objects with stack traces', async () => {
    const error = new Error('Database connection failed');
    
    const restored = parse(stringify(error));
    
    expect(restored).toBeInstanceOf(Error);
    expect(restored.message).toBe('Database connection failed');
    expect(restored.stack).toBeDefined();
  });

  it('preserves Error subclasses', async () => {
    const error = new TypeError('Invalid user ID');
    
    const restored = parse(stringify(error));
    
    expect(restored).toBeInstanceOf(TypeError);
    expect(restored.message).toBe('Invalid user ID');
  });

  it('preserves Error chains with cause', async () => {
    const networkError = new Error('Connection timeout');
    const appError = new Error('Failed to fetch user data', { 
      cause: networkError 
    });
    
    const restored = parse(stringify(appError));
    
    expect(restored.message).toBe('Failed to fetch user data');
    expect(restored.cause).toBeInstanceOf(Error);
    expect(restored.cause.message).toBe('Connection timeout');
  });

  it('preserves custom Error properties', async () => {
    const apiError: any = new Error('API request failed');
    apiError.statusCode = 500;
    apiError.endpoint = '/api/users';
    
    const restored: any = parse(stringify(apiError));
    
    expect(restored.message).toBe('API request failed');
    expect(restored.statusCode).toBe(500);
    expect(restored.endpoint).toBe('/api/users');
  });

  it('preserves TypeError with instanceof behavior', async () => {
    const typeError = new TypeError('Expected string, got number');
    const restored = parse(stringify(typeError));
    
    expect(restored).toBeInstanceOf(TypeError); // ✅ Type preserved!
    expect(restored).toBeInstanceOf(Error);     // ✅ Also an Error
    expect(restored.name).toBe('TypeError');
    expect(restored.message).toBe('Expected string, got number');
  });
});

describe('Error in Data Structures', () => {
  it('handles Errors in response objects', async () => {
    const response = {
      success: false,
      error: new Error('Validation failed'),
      timestamp: Date.now()
    };
    
    const restored = parse(stringify(response));
    
    expect(restored.success).toBe(false);
    expect(restored.error).toBeInstanceOf(Error);
    expect(restored.error.message).toBe('Validation failed');
  });
});

// Your custom Error class (in a module)
export class ValidationError extends Error {
  name = 'ValidationError';
  constructor(message: string, public field: string) {
    super(message);
  }
}

describe('Custom Error Classes', () => {
  it('registers custom Error globally and preserves type', async () => {
    // In your app initialization (before deserialization)
    // ...
    
    // Register on globalThis so deserializer can find it
    (globalThis as any).ValidationError = ValidationError;

    const error = new ValidationError('Invalid email', 'email');
    const restored = parse(stringify(error));
    
    expect(restored instanceof ValidationError).toBe(true); // ✅ true!
    expect((restored as any).field).toBe('email'); // ✅ 'email' (custom property preserved)
    expect(restored.name).toBe('ValidationError'); // ✅ 'ValidationError'
    
    // Cleanup
    delete (globalThis as any).ValidationError;
  });

  it('falls back gracefully without global registration', async () => {
    // No global registration
    const error = new ValidationError('Invalid email', 'email');
    const restored = parse(stringify(error));
    
    expect(restored instanceof ValidationError).toBe(false); // ❌ false (no type)
    expect(restored instanceof Error).toBe(true); // ✅ true (fallback)
    expect((restored as any).field).toBe('email'); // ✅ 'email' (property still preserved!)
    expect(restored.name).toBe('ValidationError'); // ✅ 'ValidationError' (name preserved)
  });
});

