/**
 * JSON-RPC validation using MCP (Model Context Protocol) schema.
 */

import { Validator } from '@cfworker/json-schema';
import {
  JSONRPCRequest as Request,
  JSONRPCResponse as Response,
  JSONRPCNotification as Notification,
  JSONRPCError,
  RequestId,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  JSONRPCMessage as Message,
  Result
} from './schema/draft/schema';

// Import the JSON schema
import mcpSchema from './schema/draft/schema.json';

// Use MCP error codes directly
export const ErrorCode = {
  ParseError: PARSE_ERROR,
  InvalidRequest: INVALID_REQUEST,
  MethodNotFound: METHOD_NOT_FOUND,
  InvalidParams: INVALID_PARAMS,
  InternalError: INTERNAL_ERROR,
} as const;

// Re-export MCP types directly
export type {
  Request,
  Response,
  Notification,
  RequestId,
  Message,
  JSONRPCError
};

// Custom error class for JSON-RPC validation errors
export class JSONRPCValidationError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JSONRPCValidationError';
    this.code = code;
    this.data = data;
  }
}

// Create validators for each JSON-RPC type
const createValidator = (schemaRef: string) => {
  return new Validator({
    ...mcpSchema,
    $ref: schemaRef
  });
};

const requestValidator = createValidator('#/definitions/JSONRPCRequest');
const notificationValidator = createValidator('#/definitions/JSONRPCNotification');
const messageValidator = createValidator('#/definitions/JSONRPCMessage');

export function isRequest(obj: any): obj is Request {
  // Handle null/undefined gracefully
  if (obj == null) return false;
  
  try {
    const result = requestValidator.validate(obj);
    return result.valid;
  } catch {
    return false;
  }
}

export function isNotification(obj: any): obj is Notification {
  // Handle null/undefined gracefully
  if (obj == null) return false;
  
  try {
    const result = notificationValidator.validate(obj);
    if (!result.valid) return false;
    
    // Additional check: notifications should NOT have an id field
    if ('id' in obj) return false;
    
    return true;
  } catch {
    return false;
  }
}

export function isValidJSONRPCMessage(obj: any): obj is Message {
  // Handle null/undefined gracefully
  if (obj == null) return false;
  
  try {
    const result = messageValidator.validate(obj);
    return result.valid;
  } catch {
    return false;
  }
}

// Helper functions to create responses using MCP types
export function createSuccessResponse(id: RequestId, result: unknown): Response {
  return {
    jsonrpc: '2.0',
    id,
    result: result as Result
  };
}

export function createErrorResponse(
  id: RequestId | null, 
  code: number, 
  message: string, 
  data?: unknown
): JSONRPCError {
  return {
    jsonrpc: '2.0',
    id: id ?? 0, // Use 0 as fallback for null id
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  };
}

// Simple validation functions
export function validateRequest(obj: any): Request {
  // Handle null/undefined gracefully
  if (obj == null) {
    throw new JSONRPCValidationError(
      ErrorCode.InvalidRequest, 
      'Invalid Request: object is null or undefined'
    );
  }
  
  try {
    const result = requestValidator.validate(obj);
    if (!result.valid) {
      const error = result.errors[0];
      throw new JSONRPCValidationError(
        ErrorCode.InvalidRequest, 
        `Invalid Request: ${error?.error ?? 'validation failed'}`
      );
    }
    return obj as Request;
  } catch (error) {
    if (error instanceof JSONRPCValidationError) {
      throw error;
    }
    throw new JSONRPCValidationError(
      ErrorCode.InvalidRequest, 
      `Invalid Request: ${error instanceof Error ? error.message : 'validation failed'}`
    );
  }
}

export function validateNotification(obj: any): Notification {
  // Handle null/undefined gracefully
  if (obj == null) {
    throw new JSONRPCValidationError(
      ErrorCode.InvalidRequest, 
      'Invalid Notification: object is null or undefined'
    );
  }
  
  try {
    const result = notificationValidator.validate(obj);
    if (!result.valid) {
      const error = result.errors[0];
      throw new JSONRPCValidationError(
        ErrorCode.InvalidRequest, 
        `Invalid Notification: ${error?.error ?? 'validation failed'}`
      );
    }
    
    // Additional check: notifications should NOT have an id field
    if ('id' in obj) {
      throw new JSONRPCValidationError(
        ErrorCode.InvalidRequest, 
        'Invalid Notification: notifications must not have an id field'
      );
    }
    
    return obj as Notification;
  } catch (error) {
    if (error instanceof JSONRPCValidationError) {
      throw error;
    }
    throw new JSONRPCValidationError(
      ErrorCode.InvalidRequest, 
      `Invalid Notification: ${error instanceof Error ? error.message : 'validation failed'}`
    );
  }
}
