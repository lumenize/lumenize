import { describe, it, expect } from 'vitest';
import { getDONamespaceFromPathSegment, MultipleBindingsFoundError } from '../src/get-do-namespace-from-path-segment';

describe('getDONamespaceFromPathSegment', () => {
  // Mock Durable Object Namespace
  const mockDONamespace = {
    getByName: () => ({}),
    idFromName: () => ({}),
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

  it('should return undefined for empty segment', () => {
    const env = { MY_DO: mockDONamespace };
    const result = getDONamespaceFromPathSegment('', env);
    expect(result).toBeUndefined();
  });

  it('should return undefined when no match found', () => {
    const env = { OTHER_DO: mockDONamespace };
    const result = getDONamespaceFromPathSegment('my-do', env);
    expect(result).toBeUndefined();
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

  it('should match if it is exact', () => {
    const env = { 
      MY_DO: mockDONamespace,
      MyDo: "just a string",
    };
    let result = getDONamespaceFromPathSegment('MY_DO', env);
    expect(result).toBe(mockDONamespace);

    const multiEnv = { 
      MyDo: mockDONamespace,
      MY_DO: "just a string",
    };
    result = getDONamespaceFromPathSegment('MyDo', multiEnv);
    expect(result).toBe(mockDONamespace);
  });

  it('should provide helpful error messages for multiple bindings', () => {
    const multiEnv = { 
      MY_DO: mockDONamespace,
      MyDo: mockDONamespace
    };
    try {
      getDONamespaceFromPathSegment('my-do', multiEnv);
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.code).toBe('MULTIPLE_BINDINGS_FOUND');
      expect(error.httpErrorCode).toBe(400);
      expect(error.matchedBindings).toEqual(['MY_DO', 'MyDo']);
      expect(error.availableBindings).toEqual(['MY_DO', 'MyDo']);
    }
  });

  it('should have correct HTTP error code for MultipleBindingsFoundError', () => {
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
