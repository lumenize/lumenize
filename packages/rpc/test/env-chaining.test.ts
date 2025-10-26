/**
 * Tests for env-chaining functionality - accessing DOs via env bindings through RPC
 * 
 * This tests the OCAN (Operation Chaining and Nesting) capability where a client
 * can chain operations through env.DO_BINDING.idFromName(name).method() or
 * env.DO_BINDING.getByName(name).method() syntax.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { env, SELF } from 'cloudflare:test';
import { createRpcClient } from '../src/index';
import { getWebSocketShim } from '@lumenize/utils';
import { ManualRoutingDO } from './test-worker-and-dos';

describe('Env chaining functionality', () => {
  describe('Direct env chaining with getByName syntax', () => {
    it('should chain through env.EXAMPLE_DO.getByName().method()', async () => {
      // Create RPC client to ManualRoutingDO which has env bindings
      using client = createRpcClient<ManualRoutingDO>(
        'manual-routing-do',
        'env-chain-test',
        { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
      );
      
      // This syntax chains: env.EXAMPLE_DO -> getByName('test') -> add(2, 3)
      // All executed server-side in one operation chain
      const result = await (client as any).env.EXAMPLE_DO.getByName('test-example').add(2, 3);
      
      expect(result).toBe(5);
    });

    it('should chain through env.PIPELINING_DO.getByName().method()', async () => {
      using client = createRpcClient<ManualRoutingDO>(
        'manual-routing-do',
        'env-chain-pipe-test',
        { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
      );
      
      const result = await (client as any).env.PIPELINING_DO.getByName('test-pipe').increment(10);
      
      expect(result).toBe(10);
    });

    it('should support nested operation chains through env', async () => {
      using client = createRpcClient<ManualRoutingDO>(
        'manual-routing-do',
        'env-chain-nested-test',
        { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
      );
      
      // Chain multiple operations: getByName('test') -> increment() -> (wait) -> add(result, 5)
      const stub = (client as any).env.EXAMPLE_DO.getByName('test-nested');
      const count = await stub.increment(); // First call
      const result = await stub.add(count, 5); // Second call using result
      
      expect(count).toBe(1);
      expect(result).toBe(6);
    });
  });

  describe('Two-line env chaining syntax', () => {
    it('should work with stub variable stored across lines', async () => {
      using client = createRpcClient<ManualRoutingDO>(
        'manual-routing-do',
        'env-chain-two-line-test',
        { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
      );
      
      // Split into two lines - demonstrates "caching" the operation chain
      const exampleStub = (client as any).env.EXAMPLE_DO.getByName('test-two-line');
      const result = await exampleStub.add(7, 8);
      
      expect(result).toBe(15);
    });

    it('should allow multiple calls on same stub', async () => {
      using client = createRpcClient<ManualRoutingDO>(
        'manual-routing-do',
        'env-chain-multi-call-test',
        { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
      );
      
      const pipeStub = (client as any).env.PIPELINING_DO.getByName('test-multi-call');
      
      // Multiple calls on the same stub should work
      const result1 = await pipeStub.increment(5);
      const result2 = await pipeStub.increment(3);
      const result3 = await pipeStub.increment(2);
      
      expect(result1).toBe(5);
      expect(result2).toBe(8);
      expect(result3).toBe(10);
    });
  });

  describe('Prefix filtering', () => {
    it('should only send final operation chain, not intermediate chains', async () => {
      using client = createRpcClient<ManualRoutingDO>(
        'manual-routing-do',
        'env-chain-prefix-test',
        { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
      );
      
      // This test verifies that when we build:
      // env.EXAMPLE_DO -> getByName('test') -> add(2, 3)
      // We only send the full chain, not partial chains like env.EXAMPLE_DO or env.EXAMPLE_DO.getByName('test')
      
      const result = await (client as any).env.EXAMPLE_DO.getByName('test-prefix').add(10, 20);
      
      // If prefix filtering works, we should get the correct result
      // If it doesn't work, we'd get errors from trying to execute incomplete chains
      expect(result).toBe(30);
    });
  });

  describe('Subclass env chaining', () => {
    it('should work with subclass DO through env binding', async () => {
      using client = createRpcClient<ManualRoutingDO>(
        'manual-routing-do',
        'env-chain-subclass-test',
        { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
      );
      
      const result = await (client as any).env.SUBCLASS_DO.getByName('test-subclass').multiply(4, 5);
      
      expect(result).toBe(20);
    });

    it('should use subclass overridden methods through env', async () => {
      using client = createRpcClient<ManualRoutingDO>(
        'manual-routing-do',
        'env-chain-subclass-override-test',
        { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
      );
      
      // SubclassDO.add() adds 100 bonus
      const result = await (client as any).env.SUBCLASS_DO.getByName('test-subclass-override').add(2, 3);
      
      expect(result).toBe(105); // 2 + 3 + 100 bonus
    });
  });
});
