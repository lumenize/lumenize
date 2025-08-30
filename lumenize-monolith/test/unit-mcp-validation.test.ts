import { describe, it, expect } from 'vitest';
import {
  isRequest,
  isNotification,
  isValidJSONRPCMessage,
  createSuccessResponse,
  createErrorResponse,
  validateRequest,
  validateNotification,
  JSONRPCValidationError,
  ErrorCode
} from '../src/mcp-validation';

describe('mcp-validation', () => {
  describe('ErrorCode constants', () => {
    it('should export correct error codes', () => {
      expect(ErrorCode.ParseError).toBe(-32700);
      expect(ErrorCode.InvalidRequest).toBe(-32600);
      expect(ErrorCode.MethodNotFound).toBe(-32601);
      expect(ErrorCode.InvalidParams).toBe(-32602);
      expect(ErrorCode.InternalError).toBe(-32603);
    });
  });

  describe('JSONRPCValidationError', () => {
    it('should create error with code and message', () => {
      const error = new JSONRPCValidationError(ErrorCode.InvalidRequest, 'Test error');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('JSONRPCValidationError');
      expect(error.code).toBe(ErrorCode.InvalidRequest);
      expect(error.message).toBe('Test error');
      expect(error.data).toBeUndefined();
    });

    it('should create error with optional data', () => {
      const data = { extra: 'info' };
      const error = new JSONRPCValidationError(ErrorCode.InvalidParams, 'Test error', data);
      expect(error.data).toEqual(data);
    });
  });

  describe('isRequest', () => {
    it('should validate correct requests', () => {
      const validRequests = [
        { jsonrpc: '2.0', method: 'test', id: 1 },
        { jsonrpc: '2.0', method: 'test', id: 'string-id' },
        { jsonrpc: '2.0', method: 'test', id: 1, params: {} },
        { jsonrpc: '2.0', method: 'test', id: 1, params: { key: 'value' } }
      ];

      validRequests.forEach(req => {
        expect(isRequest(req)).toBe(true);
      });
    });

    it('should reject invalid requests', () => {
      const invalidRequests = [
        null,
        undefined,
        'string',
        {},
        { jsonrpc: '1.0', method: 'test', id: 1 },
        { jsonrpc: '2.0', id: 1 }, // missing method
        { jsonrpc: '2.0', method: 'test' }, // missing id
        { jsonrpc: '2.0', method: 'test', id: null },
        { jsonrpc: '2.0', method: 'test', id: true },
        { jsonrpc: '2.0', method: 123, id: 1 }
      ];

      invalidRequests.forEach(req => {
        expect(isRequest(req)).toBe(false);
      });
    });
  });

  describe('isNotification', () => {
    it('should validate correct notifications', () => {
      const validNotifications = [
        { jsonrpc: '2.0', method: 'notify' },
        { jsonrpc: '2.0', method: 'notify', params: {} },
        { jsonrpc: '2.0', method: 'notify', params: { key: 'value' } }
      ];

      validNotifications.forEach(notif => {
        expect(isNotification(notif)).toBe(true);
      });
    });

    it('should reject invalid notifications', () => {
      const invalidNotifications = [
        null,
        undefined,
        'string',
        {},
        { jsonrpc: '1.0', method: 'notify' },
        { jsonrpc: '2.0' }, // missing method
        { jsonrpc: '2.0', method: 'notify', id: 1 }, // has id
        { jsonrpc: '2.0', method: 123 }
      ];

      invalidNotifications.forEach(notif => {
        expect(isNotification(notif)).toBe(false);
      });
    });
  });

  describe('isValidJSONRPCMessage', () => {
    it('should validate requests and notifications', () => {
      const validMessages = [
        { jsonrpc: '2.0', method: 'test', id: 1 },
        { jsonrpc: '2.0', method: 'notify' }
      ];

      validMessages.forEach(msg => {
        expect(isValidJSONRPCMessage(msg)).toBe(true);
      });
    });

    it('should reject invalid messages', () => {
      const invalidMessages = [
        null,
        undefined,
        'string',
        {},
        { jsonrpc: '1.0', method: 'test' }
      ];

      invalidMessages.forEach(msg => {
        expect(isValidJSONRPCMessage(msg)).toBe(false);
      });
    });
  });

  describe('createSuccessResponse', () => {
    it('should create valid success response', () => {
      const response = createSuccessResponse(1, { data: 'result' });
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { data: 'result' }
      });
    });

    it('should handle string IDs', () => {
      const response = createSuccessResponse('string-id', 'simple result');
      expect(response.id).toBe('string-id');
      expect(response.result).toBe('simple result');
    });
  });

  describe('createErrorResponse', () => {
    it('should create error response with valid ID', () => {
      const response = createErrorResponse(1, ErrorCode.InvalidParams, 'Invalid parameters');
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: ErrorCode.InvalidParams,
          message: 'Invalid parameters'
        }
      });
    });

    it('should create error response with null ID', () => {
      const response = createErrorResponse(null, ErrorCode.ParseError, 'Parse error');
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 0, // fallback for null
        error: {
          code: ErrorCode.ParseError,
          message: 'Parse error'
        }
      });
    });

    it('should include data when provided', () => {
      const data = { details: 'extra info' };
      const response = createErrorResponse(1, ErrorCode.InternalError, 'Internal error', data);
      expect(response.error.data).toEqual(data);
    });

    it('should not include data property when undefined', () => {
      const response = createErrorResponse(1, ErrorCode.InternalError, 'Internal error');
      expect('data' in response.error).toBe(false);
    });
  });

  describe('validateRequest', () => {
    it('should validate and return correct requests', () => {
      const validRequest = { jsonrpc: '2.0', method: 'test', id: 1 };
      const result = validateRequest(validRequest);
      expect(result).toEqual(validRequest);
    });

    it('should throw for invalid requests', () => {
      const invalidRequests = [
        null,
        undefined,
        'string',
        {},
        { jsonrpc: '1.0', method: 'test', id: 1 },
        { jsonrpc: '2.0', id: 1 }, // missing method
        { jsonrpc: '2.0', method: 'test' } // missing id
      ];

      invalidRequests.forEach(req => {
        expect(() => validateRequest(req)).toThrow(JSONRPCValidationError);
        expect(() => validateRequest(req)).toThrow(/Invalid Request/);
      });
    });

    it('should throw with InvalidRequest error code', () => {
      try {
        validateRequest({});
      } catch (error) {
        expect(error).toBeInstanceOf(JSONRPCValidationError);
        expect((error as JSONRPCValidationError).code).toBe(ErrorCode.InvalidRequest);
      }
    });
  });

  describe('validateNotification', () => {
    it('should validate and return correct notifications', () => {
      const validNotification = { jsonrpc: '2.0', method: 'notify' };
      const result = validateNotification(validNotification);
      expect(result).toEqual(validNotification);
    });

    it('should throw for invalid notifications', () => {
      const invalidNotifications = [
        null,
        undefined,
        'string',
        {},
        { jsonrpc: '1.0', method: 'notify' },
        { jsonrpc: '2.0' }, // missing method
        { jsonrpc: '2.0', method: 'notify', id: 1 } // has id
      ];

      invalidNotifications.forEach(notif => {
        expect(() => validateNotification(notif)).toThrow(JSONRPCValidationError);
        expect(() => validateNotification(notif)).toThrow(/Invalid (Request|Notification)/);
      });
    });

    it('should throw with InvalidRequest error code', () => {
      try {
        validateNotification({});
      } catch (error) {
        expect(error).toBeInstanceOf(JSONRPCValidationError);
        expect((error as JSONRPCValidationError).code).toBe(ErrorCode.InvalidRequest);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle complex nested params', () => {
      const complexRequest = {
        jsonrpc: '2.0',
        method: 'complex',
        id: 'test',
        params: {
          nested: {
            array: [1, 2, 3],
            object: { key: 'value' }
          },
          _meta: {
            progressToken: 'token123'
          }
        }
      };

      expect(isRequest(complexRequest)).toBe(true);
      expect(() => validateRequest(complexRequest)).not.toThrow();
    });

    it('should handle empty params object', () => {
      const requestWithEmptyParams = {
        jsonrpc: '2.0',
        method: 'test',
        id: 1,
        params: {}
      };

      expect(isRequest(requestWithEmptyParams)).toBe(true);
      expect(() => validateRequest(requestWithEmptyParams)).not.toThrow();
    });

    it('should handle very large ID numbers', () => {
      const requestWithLargeId = {
        jsonrpc: '2.0',
        method: 'test',
        id: Number.MAX_SAFE_INTEGER
      };

      expect(isRequest(requestWithLargeId)).toBe(true);
      expect(() => validateRequest(requestWithLargeId)).not.toThrow();
    });
  });
});
