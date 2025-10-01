import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { ManualRoutingDO } from './example-do';
import { createRpcClient, type RpcClientConfig } from '../src/client';

describe('Manual RPC routing', () => {
  // Base configuration for RPC client
  const baseConfig: Omit<RpcClientConfig, 'doInstanceName'> = {
    doBindingName: 'manual-routing-do',
    baseUrl: 'https://fake-host.com',
    prefix: '/__rpc',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      // Route through /manual prefix to hit ManualRoutingDO
      const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
      const manualUrl = url.replace('fake-host.com', 'fake-host.com/manual');
      return SELF.fetch(manualUrl, init);
    }
  };

  describe('RPC functionality', () => {
    it('should handle RPC calls through manual routing', async () => {
      const client = createRpcClient<ManualRoutingDO>({
        ...baseConfig,
        doInstanceName: `rpc-test-${Date.now()}`
      });

      await client.$rpc.connect();
      
      const result1 = await client.increment();
      expect(result1).toBeGreaterThan(0);
      
      client.$rpc.disconnect();
    });
  });

  describe('Custom routes', () => {
    it('should handle custom /health endpoint', async () => {
      const response = await SELF.fetch('https://fake-host.com/manual/health?instance=health-test');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('OK');
    });

    it('should handle custom /counter endpoint', async () => {
      const instanceName = `counter-rest-test-${Date.now()}`;
      
      // First increment via RPC
      const client = createRpcClient<ManualRoutingDO>({
        ...baseConfig,
        doInstanceName: instanceName
      });

      await client.$rpc.connect();
      const r1 = await client.increment();
      expect(r1).toBeGreaterThan(0);
      client.$rpc.disconnect();

      // Then check via custom REST endpoint
      const response = await SELF.fetch(`https://fake-host.com/manual/counter?instance=${instanceName}`);
      expect(response.status).toBe(200);
      
      const data = await response.json() as { counter: number };
      expect(data.counter).toBeGreaterThan(0);
    });

    it('should handle custom /reset endpoint', async () => {
      const instanceName = `reset-test-${Date.now()}`;
      
      // Increment via RPC
      const client = createRpcClient<ManualRoutingDO>({
        ...baseConfig,
        doInstanceName: instanceName
      });

      await client.$rpc.connect();
      const r1 = await client.increment();
      expect(r1).toBeGreaterThan(0);
      client.$rpc.disconnect();

      // Reset via custom endpoint
      const response = await SELF.fetch(`https://fake-host.com/manual/reset?instance=${instanceName}`, {
        method: 'POST'
      });
      expect(response.status).toBe(200);
      
      const resetData = await response.json() as { message: string };
      expect(resetData).toEqual({ message: 'Counter reset' });

      // Verify counter is now 0
      const counterResponse = await SELF.fetch(`https://fake-host.com/manual/counter?instance=${instanceName}`);
      const data = await counterResponse.json() as { counter: number };
      expect(data.counter).toBe(0);
    });

    it('should return 404 for unknown routes', async () => {
      const response = await SELF.fetch('https://fake-host.com/manual/unknown-route?instance=404-test');
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
    });
  });

  describe('Mixed usage', () => {
    it('should allow mixing RPC and REST endpoints', async () => {
      const instanceName = `mixed-test-${Date.now()}`;
      
      const client = createRpcClient<ManualRoutingDO>({
        ...baseConfig,
        doInstanceName: instanceName
      });

      await client.$rpc.connect();
      
      // Use RPC to increment
      const r1 = await client.increment();
      expect(r1).toBeGreaterThan(0);
      
      client.$rpc.disconnect();

      // Use REST to check counter
      const response = await SELF.fetch(`https://fake-host.com/manual/counter?instance=${instanceName}`);
      const data = await response.json() as { counter: number };
      expect(data.counter).toBeGreaterThan(0);
    });
  });
});
