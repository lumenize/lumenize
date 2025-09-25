import { describe, it, expect } from 'vitest';
import {
  getDOStubFromPathname,
  InvalidStubPathError,
  PrefixNotFoundError,
  DOBindingNotFoundError,
  MultipleBindingsFoundError
} from '../src/index';

describe('getDOStubFromPathname', () => {
  // Mock Durable Object Namespace
  const mockDONamespace = {
    getByName: (name: string) => ({ name, fetch: () => ({}) }),
    idFromName: () => ({}),
    idFromString: (id: string) => ({ id }),
    get: (id: any) => ({ id, fetch: () => ({}) }),
    getById: () => ({}),
  };

  it('should preserve case sensitivity in instance names', () => {
    const env = { MY_DO: mockDONamespace };
    const result = getDOStubFromPathname('/my-do/CaseSensitive-GUID-123/path', env);
    expect(result.stub.name).toBe('CaseSensitive-GUID-123');
    expect(result.doBindingName).toBe('my-do');
    expect(result.instanceNameOrId).toBe('CaseSensitive-GUID-123');
    expect(result.namespace).toBe(mockDONamespace);
  });

  it('should handle GUID-like instance names', () => {
    const env = { USER_SESSION: mockDONamespace };
    const result = getDOStubFromPathname('/user-session/550e8400-e29b-41d4-a716-446655440000/path', env);
    expect(result.stub.name).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.doBindingName).toBe('user-session');
    expect(result.instanceNameOrId).toBe('550e8400-e29b-41d4-a716-446655440000');
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

  describe('with prefix options', () => {
    it('should handle prefix with leading slash', () => {
      const env = { MY_DO: mockDONamespace };
      const options = { prefix: '/api' };
      const result = getDOStubFromPathname('/api/my-do/instance-123/path', env, options);
      expect(result.stub.name).toBe('instance-123');
      expect(result.doBindingName).toBe('my-do');
      expect(result.instanceNameOrId).toBe('instance-123');
    });

    it('should handle prefix without leading slash', () => {
      const env = { MY_DO: mockDONamespace };
      const options = { prefix: 'api' };
      const result = getDOStubFromPathname('/api/my-do/instance-123/path', env, options);
      expect(result.stub.name).toBe('instance-123');
      expect(result.doBindingName).toBe('my-do');
      expect(result.instanceNameOrId).toBe('instance-123');
    });

    it('should handle prefix with trailing slash', () => {
      const env = { MY_DO: mockDONamespace };
      const options = { prefix: '/api/' };
      const result = getDOStubFromPathname('/api/my-do/instance-123/path', env, options);
      expect(result.stub.name).toBe('instance-123');
      expect(result.doBindingName).toBe('my-do');
      expect(result.instanceNameOrId).toBe('instance-123');
    });

    it('should handle multi-segment prefix', () => {
      const env = { MY_DO: mockDONamespace };
      const options = { prefix: '__rpc/something' };
      const result = getDOStubFromPathname('/__rpc/something/my-do/instance-123/path', env, options);
      expect(result.stub.name).toBe('instance-123');
      expect(result.doBindingName).toBe('my-do');
      expect(result.instanceNameOrId).toBe('instance-123');
    });

    it('should throw PrefixNotFoundError when pathname does not match prefix', () => {
      const env = { MY_DO: mockDONamespace };
      const options = { prefix: '/api' };
      expect(() => getDOStubFromPathname('/wrong/my-do/instance-123', env, options)).toThrow(PrefixNotFoundError);
    });

    it('should handle empty pathname after prefix removal', () => {
      const env = { MY_DO: mockDONamespace };
      const options = { prefix: '/api' };
      expect(() => getDOStubFromPathname('/api', env, options)).toThrow(InvalidStubPathError);
      expect(() => getDOStubFromPathname('/api/', env, options)).toThrow(InvalidStubPathError);
    });
  });

  describe('unique ID handling', () => {
    it('should use idFromString for 64-char hex strings', () => {
      const env = { MY_DO: mockDONamespace };
      const uniqueId = '8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99';
      const result = getDOStubFromPathname(`/my-do/${uniqueId}/path`, env);
      expect(result.stub.id).toEqual({ id: uniqueId });
      expect(result.instanceNameOrId).toBe(uniqueId);
    });

    it('should use getByName for non-unique ID strings', () => {
      const env = { MY_DO: mockDONamespace };
      const result = getDOStubFromPathname('/my-do/regular-instance-name/path', env);
      expect(result.stub.name).toBe('regular-instance-name');
      expect(result.instanceNameOrId).toBe('regular-instance-name');
    });

    it('should use getByName for 63-char strings (not 64)', () => {
      const env = { MY_DO: mockDONamespace };
      const shortId = '8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b9'; // 63 chars
      const result = getDOStubFromPathname(`/my-do/${shortId}/path`, env);
      expect(result.stub.name).toBe(shortId);
      expect(result.instanceNameOrId).toBe(shortId);
    });

    it('should use getByName for 65-char strings (not 64)', () => {
      const env = { MY_DO: mockDONamespace };
      const longId = '8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b999'; // 65 chars
      const result = getDOStubFromPathname(`/my-do/${longId}/path`, env);
      expect(result.stub.name).toBe(longId);
      expect(result.instanceNameOrId).toBe(longId);
    });

    it('should use getByName for 64-char strings with non-hex characters', () => {
      const env = { MY_DO: mockDONamespace };
      const nonHexId = '8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3bgg'; // contains 'g'
      const result = getDOStubFromPathname(`/my-do/${nonHexId}/path`, env);
      expect(result.stub.name).toBe(nonHexId);
      expect(result.instanceNameOrId).toBe(nonHexId);
    });
  });
});
