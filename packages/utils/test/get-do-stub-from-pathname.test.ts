import { describe, it, expect } from 'vitest';
import { getDOStubFromPathname, InvalidStubPathError, DOBindingNotFoundError, MultipleBindingsFoundError } from '../src/index';

describe('getDOStubFromPathname', () => {
  // Mock Durable Object Namespace
  const mockDONamespace = {
    getByName: (name: string) => ({ name, fetch: () => ({}) }),
    idFromName: () => ({}),
    getById: () => ({}),
  };

  it('should preserve case sensitivity in instance names', () => {
    const env = { MY_DO: mockDONamespace };
    const result = getDOStubFromPathname('/my-do/CaseSensitive-GUID-123/path', env);
    expect(result.name).toBe('CaseSensitive-GUID-123');
  });

  it('should handle GUID-like instance names', () => {
    const env = { USER_SESSION: mockDONamespace };
    const result = getDOStubFromPathname('/user-session/550e8400-e29b-41d4-a716-446655440000/path', env);
    expect(result.name).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should throw InvalidStubPathError for missing instance name', () => {
    const env = { MY_DO: mockDONamespace };
    expect(() => getDOStubFromPathname('/my-do/', env)).toThrow(InvalidStubPathError);
    expect(() => getDOStubFromPathname('/my-do', env)).toThrow(InvalidStubPathError);
  });

  it('should propagate errors from getDONamespaceFromPathname', () => {
    const env = { OTHER_DO: mockDONamespace };
    
    // Should throw InvalidPathError for empty path
    expect(() => getDOStubFromPathname('/', env)).toThrow(InvalidStubPathError);
    
    // Should throw DOBindingNotFoundError for unknown binding
    expect(() => getDOStubFromPathname('/unknown-binding/instance/path', env)).toThrow(DOBindingNotFoundError);
    
    // Should throw MultipleBindingsFoundError for ambiguous bindings
    const multiEnv = { MY_DO: mockDONamespace, MyDo: mockDONamespace };
    expect(() => getDOStubFromPathname('/my-do/instance/path', multiEnv)).toThrow(MultipleBindingsFoundError);
  });

  it('should have correct HTTP error code for InvalidStubPathError', () => {
    const env = { MY_DO: mockDONamespace };
    try {
      getDOStubFromPathname('/my-do/', env);
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.code).toBe('INVALID_STUB_PATH');
      expect(error.httpErrorCode).toBe(400);
      expect(error.message).toContain('Expected format: [/prefix]/binding-name/instance-name/...');
    }
  });
});
