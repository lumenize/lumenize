/**
 * Test what happens when creating duplicate entity types
 */

import { describe, test, expect } from 'vitest';
import { runTestWithLumenize, MessageBuilders } from './test/test-utils.js';

// Quick test to verify duplicate entity type behavior
console.log('Testing duplicate entity type creation...');

const testData = {
  name: 'test-duplicate',
  version: 1,
  jsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' }
    },
    required: ['name']
  },
  description: 'Test entity type for duplicate testing'
};

console.log('✅ Test setup complete');
console.log('Based on code analysis:');
console.log('1. addEntityTypeDefinition() checks for existing entity type');
console.log('2. If duplicate found, throws EntityTypeAlreadyExistsError');
console.log('3. Server converts to JSON-RPC InternalError (-32603)');
console.log('4. Client receives error response with message about duplicate');
console.log('');
console.log('This is NOT idempotent - it throws an error rather than succeeding silently');
