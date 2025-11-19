/**
 * Pedagogical examples for API tier documentation
 * Teaching-focused examples showing different API levels
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, postprocess, encodeRequest, decodeRequest, encodeResponse, decodeResponse } from '../../src/index.js';

describe('Tier 1: stringify/parse', () => {
  it('demonstrates basic JSON string I/O', async () => {
    const complexObject = { name: 'John', items: [1, 2, 3] };
    
    const jsonString = await stringify(complexObject);  // Returns JSON string
    const restored = await parse(jsonString);           // Reconstructs from JSON string
    
    expect(restored).toEqual(complexObject);
  });
});

describe('Tier 2: preprocess/postprocess', () => {
  it('demonstrates intermediate format without JSON', async () => {
    const complexObject = { name: 'John', items: [1, 2, 3] };
    
    const intermediate = preprocess(complexObject);  // Returns { root, objects }
    const restored = await postprocess(intermediate);      // Reconstructs from object
    
    expect(restored).toEqual(complexObject);
    expect(intermediate).toHaveProperty('root');
    expect(intermediate).toHaveProperty('objects');
  });
});

describe('Tier 3: encode/decode Request/Response', () => {
  it('demonstrates Request encoding', async () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'test' })
    });
    
    const encoded = await encodeRequest(request);  // Plain object
    const decoded = decodeRequest(encoded);        // Reconstructed Request
    
    expect(decoded).toBeInstanceOf(Request);
    expect(decoded.url).toBe('https://example.com/');
    expect(decoded.method).toBe('POST');
  });

  it('demonstrates Response encoding', async () => {
    const response = new Response('Hello', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
    
    const encoded = await encodeResponse(response);  // Plain object
    const decoded = decodeResponse(encoded);         // Reconstructed Response
    
    expect(decoded).toBeInstanceOf(Response);
    expect(decoded.status).toBe(200);
  });
});


