/**
 * Live integration tests for @lumenize/proxy-fetch
 * 
 * These tests run against a real wrangler dev server to test actual queue processing.
 * 
 * To run:
 * 1. In one terminal: npm run dev
 * 2. In another terminal: npm run test:live
 */

import { describe, test, expect, beforeAll } from 'vitest';

const BASE_URL = 'http://localhost:8787';

describe('Proxy Fetch Live Integration', () => {
  beforeAll(async () => {
    // Wait for wrangler dev to be ready
    let retries = 10;
    while (retries > 0) {
      try {
        const response = await fetch(`${BASE_URL}/health`);
        if (response.ok) {
          console.log('✓ Wrangler dev server is ready');
          return;
        }
      } catch (e) {
        // Server not ready yet
      }
      retries--;
      if (retries === 0) {
        throw new Error('Wrangler dev server failed to start. Run `npm run dev` first.');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });

  test('full flow: DO triggers proxy fetch via HTTP, queue processes, response delivered', async () => {
    const testId = `live-test-${Date.now()}`;
    
    // Trigger a proxy fetch via HTTP endpoint
    const triggerResponse = await fetch(`${BASE_URL}/trigger-proxy-fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doName: testId,
        url: 'https://httpbin.org/json',
        handlerName: 'handleSuccess',
      }),
    });
    
    expect(triggerResponse.ok).toBe(true);
    const data = await triggerResponse.json() as { reqId: string };
    expect(data.reqId).toBeDefined();
    
    // Poll for the result (queue processing happens asynchronously)
    let response: any = null;
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const checkResponse = await fetch(`${BASE_URL}/check-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doName: testId }),
      });
      
      if (checkResponse.ok) {
        const checkData = await checkResponse.json() as { response: any };
        if (checkData.response) {
          response = checkData.response;
          break;
        }
      }
    }
    
    expect(response).toBeDefined();
    expect(response).toHaveProperty('slideshow');
  });

  test('POST request with custom headers', async () => {
    const testId = `live-post-test-${Date.now()}`;
    
    // Trigger a POST request with custom headers
    const triggerResponse = await fetch(`${BASE_URL}/trigger-proxy-fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doName: testId,
        url: 'https://httpbin.org/post',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'test-value',
        },
        body: JSON.stringify({ test: 'data' }),
        handlerName: 'handleSuccess',
      }),
    });
    
    expect(triggerResponse.ok).toBe(true);
    
    // Poll for the result
    let response: any = null;
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const checkResponse = await fetch(`${BASE_URL}/check-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doName: testId }),
      });
      
      if (checkResponse.ok) {
        const checkData = await checkResponse.json() as { response: any };
        if (checkData.response) {
          response = checkData.response;
          break;
        }
      }
    }
    
    expect(response).toBeDefined();
    expect(response.headers).toHaveProperty('X-Custom-Header');
    expect(response.headers['X-Custom-Header']).toBe('test-value');
    expect(response.json).toHaveProperty('test');
    expect(response.json.test).toBe('data');
  });

  test('error handling with invalid URL', async () => {
    const testId = `live-error-test-${Date.now()}`;
    
    // Trigger a fetch with invalid URL
    const triggerResponse = await fetch(`${BASE_URL}/trigger-proxy-fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doName: testId,
        url: 'https://this-is-not-a-valid-url-that-will-fail.invalid',
        handlerName: 'handleError',
      }),
    });
    
    expect(triggerResponse.ok).toBe(true);
    
    // Poll for the error
    let error: string | null = null;
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const checkResponse = await fetch(`${BASE_URL}/check-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doName: testId }),
      });
      
      if (checkResponse.ok) {
        const checkData = await checkResponse.json() as { error: string };
        if (checkData.error) {
          error = checkData.error;
          break;
        }
      }
    }
    
    expect(error).toBeDefined();
    expect(error).toContain('internal error');
  });
});
