import { describe, test, expect, vi } from 'vitest';
import { createTestingClient } from '@lumenize/testing';
import { createTestEndpoints } from '@lumenize/test-endpoints';
import { ResponseSync, parse } from '@lumenize/structured-clone';
import { env } from 'cloudflare:test';
import type { TestDO, FetchOrchestrator } from './test-harness';

describe('Happy Path', () => {
  it('a simple fetch of an "external" API', async () => {
    await using originClient = createTestingClient<typeof TestDO>(
      'TEST_DO',
      'external-fetch-test',
      { transport: 'websocket' }
    );

    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'external-fetch-test');
    const url = testEndpoints.buildUrl('/uuid');
    
    const reqId = await originClient.fetchData(url);

    const serialized = await vi.waitFor(async () => {
      const r = await originClient.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 1000, interval: 50 });

    const result = await parse(serialized);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json()).toHaveProperty('uuid');
  });

  it('fetches with Request object including headers and body', async () => {
    await using originClient = createTestingClient<typeof TestDO>(
      'TEST_DO',
      'request-object-test',
      { transport: 'websocket' }
    );

    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'request-object-test');
    const url = testEndpoints.buildUrl('/echo');
    
    const request = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Header': 'test-value'
      },
      body: JSON.stringify({ message: 'Hello from Request object' })
    });

    await originClient.fetchDataWithRequest(request);

    const serialized = await vi.waitFor(async () => {
      const r = await originClient.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 1000, interval: 50 });

    const result = await parse(serialized);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    
    const body = result.json();
    expect(body.json).toEqual({ message: 'Hello from Request object' });
    expect(body.headers['x-custom-header']).toBe('test-value');
    expect(body.headers['content-type']).toBe('application/json');
  });
});

describe('HTTP Error Scenarios', () => {
  it('receives ResponseSync (not Error) for HTTP 404', async () => {
    await using originClient = createTestingClient<typeof TestDO>(
      'TEST_DO',
      'http-404-test',
      { transport: 'websocket'}
    );

    const testEndpoints = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'http-404-test');
    const url = testEndpoints.buildUrl('/status/404');
    
    await originClient.fetchData(url);

    const serialized = await vi.waitFor(async () => {
      const r = await originClient.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 1000, interval: 50 });

    const result = await parse(serialized);
    expect(result).toBeInstanceOf(ResponseSync);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('Not Found');
  });
});

describe('Errors throw in the Executor', () => {
  it('receives Error (not ResponseSync) when external API is unreachable', async () => {
    await using originClient = createTestingClient<typeof TestDO>(
      'TEST_DO',
      'network-error-test',
      { transport: 'websocket'}
    );

    // Use an invalid domain that will fail DNS resolution
    const url = 'http://definitely-does-not-exist-12345.invalid/';
    
    await originClient.fetchData(url);

    const serialized = await vi.waitFor(async () => {
      const r = await originClient.getResult(url);
      expect(r).toBeDefined();
      return r;
    }, { timeout: 2000, interval: 50 });

    const result = await parse(serialized);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).not.toContain('delivery timeout'); // Not from Orchestrator
    // Cloudflare wraps network errors as "internal error"
    expect(result.message).toContain('internal error');
  });
});

describe('Validating Test Infrastructure', () => {
  it('validates native alarms work in vitest-pool-workers', async () => {
    await using orchestratorClient = createTestingClient<typeof FetchOrchestrator>(
      'FETCH_ORCHESTRATOR',
      'native-alarm-test',
    );

    // Clear any existing alarm from previous test runs
    await orchestratorClient.ctx.storage.deleteAlarm();

    // 1. Check no alarm is scheduled initially
    const alarmBefore = await orchestratorClient.ctx.storage.getAlarm();
    expect(alarmBefore).toBeNull();

    // 2. Schedule alarm for 2 seconds from now
    await orchestratorClient.ctx.storage.setAlarm(Date.now() + 2000);
    
    const alarmAfterSchedule = await orchestratorClient.ctx.storage.getAlarm();
    expect(alarmAfterSchedule).toBeTruthy();
    expect(alarmAfterSchedule).toBeGreaterThan(Date.now());
    
    // 3. Wait for alarm to fire and verify it cleared (native alarms auto-clear)
    const alarmAfterFiring = await vi.waitFor(async () => {
      const alarm = await orchestratorClient.ctx.storage.getAlarm();
      expect(alarm).toBeNull(); // Will retry until null
      return alarm;
    }, { 
      timeout: 4000, // 4 seconds (2s alarm + 2s buffer)
      // interval: 100  // Check every 100ms
      interval: 10  // With alarm simulation
    });
    
    expect(alarmAfterFiring).toBeNull();
  });

  it('validates alarm simulation with 100x speedup', async () => {
    await using orchestratorClient = createTestingClient<typeof FetchOrchestrator>(
      'FETCH_ORCHESTRATOR',
      'alarm-simulation-test',
      { transport: 'websocket' } // Required for alarm simulation
    );

    // Clear any existing alarm from previous test runs
    await orchestratorClient.ctx.storage.deleteAlarm();

    // 1. Check no alarm is scheduled initially
    const alarmBefore = await orchestratorClient.ctx.storage.getAlarm();
    expect(alarmBefore).toBeNull();

    // 2. Schedule alarm for 5 seconds (should fire in ~50ms with 100x speedup)
    await orchestratorClient.ctx.storage.setAlarm(Date.now() + 5000);
    
    const alarmAfterSchedule = await orchestratorClient.ctx.storage.getAlarm();
    expect(alarmAfterSchedule).toBeTruthy();
    expect(alarmAfterSchedule).toBeGreaterThan(Date.now());
    
    // 3. Wait for alarm to fire (should be quick with 100x speedup)
    const alarmAfterFiring = await vi.waitFor(async () => {
      const alarm = await orchestratorClient.ctx.storage.getAlarm();
      expect(alarm).toBeNull(); // Will retry until null
      return alarm;
    }, { 
      timeout: 200,  // 200ms should be plenty (5s / 100 = 50ms + buffer)
      interval: 10   // Check every 10ms
    });
    
    expect(alarmAfterFiring).toBeNull();
  });

});

