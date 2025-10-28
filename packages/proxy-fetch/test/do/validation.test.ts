/**
 * Tests for proxyFetch validation errors
 */
import { it, expect } from 'vitest';
import { createTestingClient } from '@lumenize/testing';
import { _TestDO } from './test-worker';
import { proxyFetch } from '../../src/proxyFetch';

it('throws error when handler method does not exist on DO instance', async () => {
  using testDO = createTestingClient<typeof _TestDO>(
    'TEST_DO',
    'validation-test'
  );

  // proxyFetch is called inside the DO, but errors propagate over RPC
  await expect(async () => {
    await testDO.triggerInvalidHandler();
  }).rejects.toThrow("Handler method 'nonExistentHandler' not found on DO instance");
});

it('Queue variant: throws error when handler method does not exist', async () => {
  using testDO = createTestingClient<typeof _TestDO>(
    'TEST_DO',
    'validation-queue-test'
  );

  // Test the Queue variant specifically
  await expect(async () => {
    await testDO.triggerInvalidHandlerQueue();
  }).rejects.toThrow("Handler method 'anotherNonExistentHandler' not found on DO instance");
});
