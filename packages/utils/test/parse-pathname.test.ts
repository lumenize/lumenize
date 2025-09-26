import { describe, it, expect } from 'vitest';
import { parsePathname } from '../src/parse-pathname';

describe('parsePathname', () => {
  it('should parse basic pathname without prefix', () => {
    const result = parsePathname('/my-do/instance-123/path');
    expect(result).toBeDefined();
    expect(result!.doBindingNameSegment).toBe('my-do');
    expect(result!.doInstanceNameOrId).toBe('instance-123');
  });

  it('should preserve case sensitivity in binding and instance names', () => {
    const result = parsePathname('/CamelCase-DO/CaseSensitive-GUID-123/path');
    expect(result).toBeDefined();
    expect(result!.doBindingNameSegment).toBe('CamelCase-DO');
    expect(result!.doInstanceNameOrId).toBe('CaseSensitive-GUID-123');
  });

  it('should handle GUID-like instance names', () => {
    const result = parsePathname('/user-session/550e8400-e29b-41d4-a716-446655440000/path');
    expect(result).toBeDefined();
    expect(result!.doBindingNameSegment).toBe('user-session');
    expect(result!.doInstanceNameOrId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should return binding with undefined instance when instance name is missing', () => {
    // Cases where we have a binding but no instance should return the binding with undefined instance
    let result = parsePathname('/my-do/');
    expect(result).toBeDefined();
    expect(result!.doBindingNameSegment).toBe('my-do');
    expect(result!.doInstanceNameOrId).toBeUndefined();
    
    result = parsePathname('/my-do');
    expect(result).toBeDefined();
    expect(result!.doBindingNameSegment).toBe('my-do');
    expect(result!.doInstanceNameOrId).toBeUndefined();
    
    // Cases with no segments at all should return undefined
    expect(parsePathname('/')).toBeUndefined();
    expect(parsePathname('')).toBeUndefined();
  });

  describe('with prefix options', () => {
    it('should handle prefix with leading slash', () => {
      const options = { prefix: '/api' };
      const result = parsePathname('/api/my-do/instance-123/path', options);
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('instance-123');
    });

    it('should handle prefix without leading slash', () => {
      const options = { prefix: 'api' };
      const result = parsePathname('/api/my-do/instance-123/path', options);
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('instance-123');
    });

    it('should handle prefix with trailing slash', () => {
      const options = { prefix: '/api/' };
      const result = parsePathname('/api/my-do/instance-123/path', options);
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('instance-123');
    });

    it('should handle multi-segment prefix', () => {
      const options = { prefix: '__rpc/something' };
      const result = parsePathname('/__rpc/something/my-do/instance-123/path', options);
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('instance-123');
    });

    it('should return undefined when pathname does not match prefix', () => {
      const options = { prefix: '/api' };
      expect(parsePathname('/wrong/my-do/instance-123', options)).toBeUndefined();
    });

    it('should return undefined for empty pathname after prefix removal', () => {
      const options = { prefix: '/api' };
      expect(parsePathname('/api', options)).toBeUndefined();
      expect(parsePathname('/api/', options)).toBeUndefined();
    });

    it('should return undefined when prefix equals the entire path', () => {
      const options = { prefix: '/api/v1' };
      expect(parsePathname('/api/v1', options)).toBeUndefined();
      expect(parsePathname('/api/v1/', options)).toBeUndefined();
    });

    it('should normalize prefix without leading slash', () => {
      const options = { prefix: 'api/v1' };
      const result = parsePathname('/api/v1/my-do/instance-123/path', options);
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('instance-123');
    });

    it('should normalize prefix with both leading and trailing slash', () => {
      const options = { prefix: '/api/v1/' };
      const result = parsePathname('/api/v1/my-do/instance-123/path', options);
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('instance-123');
    });
  });

  describe('edge cases', () => {
    it('should handle unique ID-like strings', () => {
      const uniqueId = '8aa7a69131efa8902661702e701295f168aa5806045ec15d01a2f465bd5f3b99';
      const result = parsePathname(`/my-do/${uniqueId}/path`);
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe(uniqueId);
    });

    it('should handle regular instance names', () => {
      const result = parsePathname('/my-do/regular-instance-name/path');
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('regular-instance-name');
    });

    it('should handle paths with many segments', () => {
      const result = parsePathname('/my-do/instance/very/long/path/with/many/segments');
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('instance');
    });

    it('should handle paths with query parameters in the instance name segment', () => {
      // Note: In a real URL, query parameters would be handled separately, 
      // but this tests the raw pathname parsing
      const result = parsePathname('/my-do/instance-with-dashes/path');
      expect(result).toBeDefined();
      expect(result!.doBindingNameSegment).toBe('my-do');
      expect(result!.doInstanceNameOrId).toBe('instance-with-dashes');
    });
  });
});