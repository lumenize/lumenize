/**
 * Pedagogical examples for API tier documentation
 * Teaching-focused examples showing different API levels
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, postprocess, RequestSync, ResponseSync } from '../../src/index.js';
import { encodeRequestSync, decodeRequestSync, encodeResponseSync, decodeResponseSync } from '../../src/web-api-encoding.js';

describe('Tier 1: stringify/parse', () => {
  it('demonstrates basic JSON string I/O', async () => {
    const complexObject = { name: 'John', items: [1, 2, 3] };
    
    const jsonString = stringify(complexObject);  // Returns JSON string
    const restored = parse(jsonString);           // Reconstructs from JSON string
    
    expect(restored).toEqual(complexObject);
  });
});

describe('Tier 2: preprocess/postprocess', () => {
  it('demonstrates intermediate format without JSON', () => {
    const complexObject = { name: 'John', items: [1, 2, 3] };
    
    const intermediate = preprocess(complexObject);  // Returns { root, objects }
    const restored = postprocess(intermediate);      // Reconstructs from object
    
    expect(restored).toEqual(complexObject);
    expect(intermediate).toHaveProperty('root');
    expect(intermediate).toHaveProperty('objects');
  });
});

describe('Tier 3: encode/decode RequestSync/ResponseSync', () => {
  it('demonstrates RequestSync encoding', () => {
    const requestSync = new RequestSync('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { data: 'test' }
    });
    
    const encoded = encodeRequestSync(requestSync);  // Plain object
    const decoded = decodeRequestSync(encoded);      // Reconstructed RequestSync
    
    expect(decoded).toBeInstanceOf(RequestSync);
    expect(decoded.url).toBe('https://example.com/');
    expect(decoded.method).toBe('POST');
  });

  it('demonstrates ResponseSync encoding', () => {
    const responseSync = new ResponseSync('Hello', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
    
    const encoded = encodeResponseSync(responseSync);  // Plain object
    const decoded = decodeResponseSync(encoded);       // Reconstructed ResponseSync
    
    expect(decoded).toBeInstanceOf(ResponseSync);
    expect(decoded.status).toBe(200);
  });
});


