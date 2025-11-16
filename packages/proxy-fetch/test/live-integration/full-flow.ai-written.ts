/**
 * Full-flow live integration tests for @lumenize/proxy-fetch
 * 
 * Run while `wrangler dev` is running from test/live-integration folder.
 * 
 * Tests validate:
 * 1. Teleportation into DOs running in wrangler dev works
 * 2. Native Cloudflare alarms work in wrangler dev
 * 3. External fetches to production test-endpoints work
 * 4. The complete proxy-fetch flow works end-to-end
 * 
 * Environment variables (TEST_TOKEN, TEST_ENDPOINTS_URL) are loaded from
 * .dev.vars which is auto-symlinked by npm install.
 */

import { describe, test, expect, vi } from 'vitest';
import { createTestingClient } from '@lumenize/testing';
import { createTestEndpoints } from '@lumenize/test-endpoints';
import { env } from 'cloudflare:test';

// Type imports for DOs (these run in wrangler dev via test-harness.ts)
import type { TestDO, FetchOrchestrator } from './test-harness';

describe('ProxyFetch Full Flow (Live Integration)', () => {

  describe('Step 1: Validate Basic Teleport', () => {
    test('can teleport into TestDO and read ctx.id', async () => {
      const client = createTestingClient<typeof TestDO>(
        'TEST_DO',
        'teleport-test-1',
        { baseUrl: 'http://localhost:8787' }
      );

      try {
        // Simple property read to verify teleportation works
        const doIdString = await client.ctx.id.toString();
        console.log('✅ Successfully teleported into TestDO');
        console.log('📍 DO ID:', doIdString);
        expect(doIdString).toBeTruthy();
        expect(doIdString.length).toBeGreaterThan(0);
      } catch (error) {
        if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
          throw new Error('❌ wrangler dev not running. Start it with: cd test/live-integration && wrangler dev');
        }
        throw error;
      }

      client[Symbol.dispose]();
    });

    test('can teleport into FetchOrchestrator and read ctx.id', async () => {
      const client = createTestingClient<typeof FetchOrchestrator>(
        'FETCH_ORCHESTRATOR',
        'singleton',
        { baseUrl: 'http://localhost:8787' }
      );

      // Simple property read to verify teleportation works
      const doIdString = await client.ctx.id.toString();
      console.log('✅ Successfully teleported into FetchOrchestrator');
      console.log('📍 DO ID:', doIdString);
      expect(doIdString).toBeTruthy();
      expect(doIdString.length).toBeGreaterThan(0);

      client[Symbol.dispose]();
    });
  });

  describe('Step 2: Validate ProxyFetch Happy Path', () => {
    test('can fetch from production test-endpoints', async () => {
      await using originClient = createTestingClient<typeof TestDO>(
        'TEST_DO',
        'external-fetch-test',
        { 
          baseUrl: 'http://localhost:8787',
          transport: 'websocket'  // Required for complex flows!
        }
      );

      const TEST_ENDPOINTS = createTestEndpoints(env.TEST_TOKEN, env.TEST_ENDPOINTS_URL, 'external-fetch-test');
      const url = TEST_ENDPOINTS.buildUrl('/uuid');

      console.log('🔍 About to call fetchData with url:', url);
      console.log('🔍 Client type:', typeof originClient);
      console.log('🔍 fetchData type:', typeof originClient.fetchData);
      
      // Make a simple fetch request
      const reqId = await originClient.fetchData(url);
      console.log('🚀 Enqueued fetch request, reqId:', reqId, 'url:', url);

      // Wait for result to arrive via continuation
      const result = await vi.waitFor(async () => {
        const r = await originClient.getResult(url);
        expect(r).toBeDefined();
        return r;
      }, { timeout: 1000, interval: 50 });

      console.log('📥 Received result:', result);
      console.log(result);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty('uuid');
    });
  });

  describe('Step 3: Validate Native Alarms Work', () => {
    test.only('can schedule and detect alarm in wrangler dev', async () => {
      const orchestratorClient = createTestingClient<typeof FetchOrchestrator>(
        'FETCH_ORCHESTRATOR',
        'singleton',
        { baseUrl: 'http://localhost:8787' }
      );

      console.log('⏰ Step 1: Schedule an alarm for 2 seconds from now');
      await orchestratorClient.ctx.storage.setAlarm(Date.now() + 2000);
      
      console.log('⏰ Step 2: Verify alarm is scheduled');
      const scheduledTime = await orchestratorClient.ctx.storage.getAlarm();
      expect(scheduledTime).toBeTruthy();
      console.log('✅ Alarm scheduled for:', new Date(scheduledTime!).toISOString());
      
      console.log('⏰ Step 3: Wait for alarm to fire (3 seconds)...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      console.log('⏰ Step 4: Check if alarm cleared (fired)');
      const alarmAfterWait = await orchestratorClient.ctx.storage.getAlarm();
      console.log('📊 Alarm after wait:', alarmAfterWait);
      
      if (alarmAfterWait === null) {
        console.log('✅ SUCCESS: Alarm fired and cleared! Native alarms work in wrangler dev!');
      } else {
        console.log('❌ FAIL: Alarm did not fire. Native alarms may not work in wrangler dev.');
      }
      
      // This is the critical test
      expect(alarmAfterWait).toBeNull();

      orchestratorClient[Symbol.dispose]();
    });
  });

  describe('Step 4: Alarm Simulation with ProxyFetch', () => {
    test('alarm simulation with WebSocket transport', async () => {
      // CRITICAL: Use WebSocket transport for alarm simulation
      await using orchestratorClient = createTestingClient<typeof FetchOrchestrator>(
        'FETCH_ORCHESTRATOR',
        'singleton',
        { 
          baseUrl: 'http://localhost:8787',
          transport: 'websocket'  // Required for alarm simulation!
        }
      );

      console.log('🧪 Testing alarm simulation with proxy-fetch');
      
      // Get initial queue state
      const initialStats = await orchestratorClient.getQueueStats();
      console.log('📊 Initial queue:', initialStats);
      
      // Schedule an alarm directly to test simulation
      console.log('⏰ Scheduling alarm for 5 seconds (should fire in ~500ms with 10x speedup)');
      await orchestratorClient.ctx.storage.setAlarm(Date.now() + 5000);
      
      const scheduledTime = await orchestratorClient.ctx.storage.getAlarm();
      console.log('✅ Alarm scheduled for:', scheduledTime);
      
      // Wait for alarm to fire (with 10x speedup, 5s = 500ms)
      console.log('⏳ Waiting for alarm to fire (should be quick with simulation)...');
      await new Promise(resolve => setTimeout(resolve, 800)); // 800ms buffer
      
      const alarmAfter = await orchestratorClient.ctx.storage.getAlarm();
      console.log('📊 Alarm after wait:', alarmAfter);
      
      if (alarmAfter === null) {
        console.log('✅ SUCCESS: Alarm fired with simulation!');
      } else {
        console.log('⚠️  Alarm did not fire - simulation may not be working');
      }
      
      expect(alarmAfter).toBeNull();
    });

    test.skip('timeout with alarm simulation (if NADIS works)', async () => {
      // This would test the full timeout flow with alarm simulation
      // But requires NADIS registration to work first
    });
  });
});

