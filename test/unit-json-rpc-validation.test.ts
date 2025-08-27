import { describe, it, expect } from 'vitest';
import { 
  validateRequest, 
  validateNotification,
  createErrorResponse, 
  ErrorCode,
  JSONRPCValidationError
} from '../src/mcp-validation';

describe('JSON-RPC Validation', () => {
  it('should validate requests correctly', () => {
    const validRequest = {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: '1'
    };

    const result = validateRequest(validRequest);
    expect(result.jsonrpc).toBe('2.0');
    expect(result.method).toBe('tools/list');
    expect(result.id).toBe('1');
  });

  it('should create appropriate error response for validation errors', () => {
    const error = createErrorResponse(
      '123', 
      ErrorCode.InvalidRequest, 
      'Test error message',
      { detail: 'Additional error data' }
    );

    expect(error.jsonrpc).toBe('2.0');
    expect(error.id).toBe('123');
    expect(error.error.code).toBe(ErrorCode.InvalidRequest);
    expect(error.error.message).toBe('Test error message');
    expect(error.error.data).toEqual({ detail: 'Additional error data' });
  });

  it('should validate notifications correctly', () => {
    const validNotification = {
      jsonrpc: '2.0',
      method: 'notifications/progress'
    };

    const result = validateNotification(validNotification);
    expect(result.jsonrpc).toBe('2.0');
    expect(result.method).toBe('notifications/progress');
    expect('id' in result).toBe(false);
  });

  it('should reject invalid requests', () => {
    const invalidRequest = {
      jsonrpc: '2.0',
      method: 'test'
      // Missing id field
    };

    expect(() => validateRequest(invalidRequest)).toThrow(JSONRPCValidationError);
  });
});
