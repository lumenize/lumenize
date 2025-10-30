/**
 * Pedagogical examples for Error serialization documentation
 * Teaching-focused with clear error handling patterns
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../../src/index.js';

describe('Error Serialization', () => {
  it('preserves Error objects with stack traces', async () => {
    const error = new Error('Database connection failed');
    
    const restored = await parse(await stringify(error));
    
    expect(restored).toBeInstanceOf(Error);
    expect(restored.message).toBe('Database connection failed');
    expect(restored.stack).toBeDefined();
  });

  it('preserves Error subclasses', async () => {
    const error = new TypeError('Invalid user ID');
    
    const restored = await parse(await stringify(error));
    
    expect(restored).toBeInstanceOf(TypeError);
    expect(restored.message).toBe('Invalid user ID');
  });

  it('preserves Error chains with cause', async () => {
    const networkError = new Error('Connection timeout');
    const appError = new Error('Failed to fetch user data', { 
      cause: networkError 
    });
    
    const restored = await parse(await stringify(appError));
    
    expect(restored.message).toBe('Failed to fetch user data');
    expect(restored.cause).toBeInstanceOf(Error);
    expect(restored.cause.message).toBe('Connection timeout');
  });

  it('preserves custom Error properties', async () => {
    const apiError: any = new Error('API request failed');
    apiError.statusCode = 500;
    apiError.endpoint = '/api/users';
    
    const restored: any = await parse(await stringify(apiError));
    
    expect(restored.message).toBe('API request failed');
    expect(restored.statusCode).toBe(500);
    expect(restored.endpoint).toBe('/api/users');
  });
});

describe('Error in Data Structures', () => {
  it('handles Errors in response objects', async () => {
    const response = {
      success: false,
      error: new Error('Validation failed'),
      timestamp: Date.now()
    };
    
    const restored = await parse(await stringify(response));
    
    expect(restored.success).toBe(false);
    expect(restored.error).toBeInstanceOf(Error);
    expect(restored.error.message).toBe('Validation failed');
  });
});

