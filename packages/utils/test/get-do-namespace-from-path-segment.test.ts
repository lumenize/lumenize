import { describe, it, expect } from 'vitest';
import { getDONamespaceFromPathSegment, DOBindingNotFoundError, MultipleBindingsFoundError } from '../src/get-do-namespace-from-path-segment';

describe('getDONamespaceFromPathSegment', () => {
  // Mock Durable Object Namespace
  const mockDONamespace = {
    getByName: () => ({}),
    idFromName: () => ({}),
    getById: () => ({}),
  };

  it('should find exact match', () => {
    const env = { MY_DO: mockDONamespace };
    const result = getDONamespaceFromPathSegment('MY_DO', env);
    expect(result).toBe(mockDONamespace);
  });

  it('should convert kebab-case to SNAKE_CASE', () => {
    const env = { MY_DO: mockDONamespace };
    const result = getDONamespaceFromPathSegment('my-do', env);
    expect(result).toBe(mockDONamespace);
  });

  it('should handle PascalCase binding', () => {
    const env = { MyDO: mockDONamespace };
    const result = getDONamespaceFromPathSegment('my-do', env);
    expect(result).toBe(mockDONamespace);
  });

  it('should handle camelCase binding', () => {
    const env = { myDo: mockDONamespace };
    const result = getDONamespaceFromPathSegment('my-do', env);
    expect(result).toBe(mockDONamespace);
  });

  it('should handle complex case like my-d-o → MyDO', () => {
    const env = { MyDO: mockDONamespace };
    const result = getDONamespaceFromPathSegment('my-d-o', env);
    expect(result).toBe(mockDONamespace);
  });

  it('should handle complex case like my-do → MyDO', () => {
    const env = { MyDO: mockDONamespace };
    const result = getDONamespaceFromPathSegment('my-do', env);
    expect(result).toBe(mockDONamespace);
  });

  it('should handle userSession → USER_SESSION', () => {
    const env = { USER_SESSION: mockDONamespace };
    const result = getDONamespaceFromPathSegment('user-session', env);
    expect(result).toBe(mockDONamespace);
  });

  it('should throw DOBindingNotFoundError for empty segment', () => {
    const env = { MY_DO: mockDONamespace };
    expect(() => getDONamespaceFromPathSegment('', env)).toThrow(DOBindingNotFoundError);
  });

  it('should throw DOBindingNotFoundError when no match found', () => {
    const env = { OTHER_DO: mockDONamespace };
    expect(() => getDONamespaceFromPathSegment('my-do', env)).toThrow(DOBindingNotFoundError);
  });

  it('should throw MultipleBindingsFoundError when multiple matches', () => {
    const env = { 
      MY_DO: mockDONamespace,
      MyDo: mockDONamespace  // Different objects that would both match my-do
    };
    expect(() => getDONamespaceFromPathSegment('my-do', env)).toThrow(MultipleBindingsFoundError);
  });

  it('should only consider actual DO bindings', () => {
    const env = { 
      MY_DO: mockDONamespace,
      NOT_A_DO: "just a string",
      ANOTHER_STRING: 42
    };
    const result = getDONamespaceFromPathSegment('my-do', env);
    expect(result).toBe(mockDONamespace);
  });

  it('should provide helpful error messages', () => {
    const env = { OTHER_DO: mockDONamespace };
    try {
      getDONamespaceFromPathSegment('my-do', env);
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.code).toBe('BINDING_NOT_FOUND');
      expect(error.httpErrorCode).toBe(404);
      expect(error.availableBindings).toEqual(['OTHER_DO']);
      expect(error.attemptedBindings).toContain('MY_DO');
      expect(error.attemptedBindings).toContain('MyDo');
    }
  });

  it('should have correct HTTP error codes for all error types', () => {
    const env = { OTHER_DO: mockDONamespace };
    
    // Test DOBindingNotFoundError (404)
    try {
      getDONamespaceFromPathSegment('nonexistent', env);
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.httpErrorCode).toBe(404);
    }
    
    // Test MultipleBindingsFoundError (400)
    const multiEnv = { 
      MY_DO: mockDONamespace,
      MyDo: mockDONamespace
    };
    try {
      getDONamespaceFromPathSegment('my-do', multiEnv);
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.httpErrorCode).toBe(400);
    }
  });
});
