import { Schema as JSONSchema } from '@cfworker/json-schema';

/**
 * JSON Schema for the changedBy field used across entity operations
 * 
 * The changedBy field should always be an array of objects indicating who made the change.
 * Each object can be in one of two forms:
 * 1) { "userId": "1234" }
 * 2) { "userId": "1234", "impersonatedBy": "6789" }
 */

export interface ChangedByEntry {
  userId: string;
  impersonatedBy?: string;
}

export type ChangedBy = ChangedByEntry[];

export const CHANGED_BY_SCHEMA: JSONSchema = {
  type: 'array',
  description: 'Array of identifiers indicating who made the change',
  items: {
    type: 'object',
    properties: {
      userId: { 
        type: 'string', 
        description: 'The user ID who made the change' 
      },
      impersonatedBy: { 
        type: 'string', 
        description: 'Optional user ID of who is impersonating the user' 
      }
    },
    required: ['userId'],
    additionalProperties: false
  },
  minItems: 1
};
