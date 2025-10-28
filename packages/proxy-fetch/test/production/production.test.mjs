/**
 * Production integration tests for @lumenize/proxy-fetch
 * 
 * These tests hit the deployed Worker in production to validate
 * real-world behavior.
 * 
 * Run with: node test/production/production.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert';

// Get Worker URL from environment or use default
const WORKER_URL = process.env.WORKER_URL || 'https://proxy-fetch-live-test.transformation.workers.dev';

console.log(`Testing Worker at: ${WORKER_URL}\n`);

/**
 * Helper to wait for callback to be processed
 */
async function waitForCallback(reqId, maxAttempts = 20, delayMs = 200) {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`${WORKER_URL}/result/${reqId}`);
    const result = await response.json();
    
    if (result.type !== 'pending') {
      return result;
    }
    
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  
  throw new Error(`Callback not processed after ${maxAttempts} attempts`);
}

test('Health check', async () => {
  const response = await fetch(WORKER_URL);
  assert.strictEqual(response.status, 200);
  
  const data = await response.json();
  assert.strictEqual(data.status, 'ok');
  assert.strictEqual(data.service, 'proxy-fetch-production-test');
  
  console.log('✓ Health check passed');
});

test('Fetch UUID with callback', async () => {
  // Clear previous results
  await fetch(`${WORKER_URL}/clear`, { method: 'POST' });
  
  // Trigger fetch
  const response = await fetch(`${WORKER_URL}/uuid`);
  assert.strictEqual(response.status, 200);
  
  const data = await response.json();
  assert.ok(data.reqId);
  console.log(`  Request ID: ${data.reqId}`);
  
  // Wait for callback
  const result = await waitForCallback(data.reqId);
  assert.strictEqual(result.type, 'success');
  assert.strictEqual(result.response.status, 200);
  assert.ok(result.body.uuid);
  
  console.log(`✓ Fetch UUID with callback - UUID: ${result.body.uuid}`);
});

test('Fetch UUID with retry logic', async () => {
  // Clear previous results
  await fetch(`${WORKER_URL}/clear`, { method: 'POST' });
  
  // Trigger fetch with retry
  const response = await fetch(`${WORKER_URL}/uuid-retry`);
  assert.strictEqual(response.status, 200);
  
  const data = await response.json();
  assert.ok(data.reqId);
  console.log(`  Request ID: ${data.reqId}`);
  
  // Wait for callback
  const result = await waitForCallback(data.reqId);
  assert.strictEqual(result.type, 'success');
  assert.strictEqual(result.response.status, 200);
  assert.ok(result.body.uuid);
  
  console.log(`✓ Fetch with retry - UUID: ${result.body.uuid}`);
});

test('Fire-and-forget request', async () => {
  // Clear previous results
  await fetch(`${WORKER_URL}/clear`, { method: 'POST' });
  
  // Trigger fire-and-forget
  const response = await fetch(`${WORKER_URL}/fire-and-forget`);
  assert.strictEqual(response.status, 200);
  
  const data = await response.json();
  assert.ok(data.reqId);
  console.log(`  Request ID: ${data.reqId}`);
  
  // Fire-and-forget should still be pending (no callback)
  const result = await fetch(`${WORKER_URL}/result/${data.reqId}`);
  const resultData = await result.json();
  assert.strictEqual(resultData.type, 'pending');
  
  console.log('✓ Fire-and-forget request queued (no callback expected)');
});

console.log('\n✨ All production tests passed!');
