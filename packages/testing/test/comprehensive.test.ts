import { describe, test, it, expect } from 'vitest';
import {
  DurableObjectState,
  SELF,
  env,
  runInDurableObject,
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
} from 'cloudflare:test';
import { runWithWebSocketMock } from '../src/websocket-utils.js';
import { MyDO } from './test-harness';

describe('Comprehensive WebSocket testing framework tests', () => {

  it('should support addEventListener for libraries that use EventTarget API', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    await runWithWebSocketMock(stub, async (mock, instance, ctx) => {
      const ws = new WebSocket('wss://example.com');
      let messageReceived = false;
      let openReceived = false;
      
      // Use addEventListener instead of onmessage - this should work
      ws.addEventListener('message', (event: any) => {
        messageReceived = true;
        expect(event.data).toBe('1');
        ws.close();
      });
      
      ws.addEventListener('open', () => {
        openReceived = true;
        ws.send('increment');
      });
      
      await mock.sync();
      
      // These should all be true if EventTarget is working
      expect(openReceived).toBe(true);
      expect(messageReceived).toBe(true);
      expect(mock.messagesSent).toEqual(['increment']);
      expect(mock.messagesReceived).toEqual(['1']);
    }, 500);
  });

  // Test that assertions in event handlers properly fail tests
  it('should properly propagate assertion failures from WebSocket event handlers', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    
    // This test should fail - demonstrating that event handler assertions work
    try {
      await runWithWebSocketMock(stub, async (mock, instance: MyDO, ctx) => {
        const ws = new WebSocket('wss://example.com');
        ws.onopen = () => {
          ws.send('increment');
        };
        ws.onmessage = async (event) => {
          // This should fail and propagate the error properly
          expect(event.data).toBe('wrong-value');
        };
        await mock.sync();
      });
      
      // If we get here, the test didn't fail as expected
      expect(true).toBe(false); // Force failure if assertion wasn't propagated
    } catch (error) {
      // This is expected - the assertion in onmessage should have failed
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('expected \'1\' to be \'wrong-value\'');
    }
  });

  // Test WebSocket lifecycle hooks
  describe('WebSocket lifecycle hooks', () => {
    it('should call webSocketOpen when connection opens', async () => {
      const id = env.MY_DO.newUniqueId();
      const stub = env.MY_DO.get(id);
      await runWithWebSocketMock(stub, async (mock, instance: MyDO, ctx) => {
        const ws = new WebSocket('wss://example.com');
        await mock.sync();
        
        // Check that webSocketOpen was called by verifying storage was updated
        const lastOpen = await ctx.storage.get("lastWebSocketOpen");
        expect(lastOpen).toBeDefined();
        expect(typeof lastOpen).toBe('number');
      });
    });

    it('should call webSocketClose when connection closes', async () => {
      const id = env.MY_DO.newUniqueId();
      const stub = env.MY_DO.get(id);
      await runWithWebSocketMock(stub, async (mock, instance: MyDO, ctx) => {
        const ws = new WebSocket('wss://example.com');
        ws.onopen = () => {
          ws.close(1000, 'Test close');
        };
        await mock.sync();
        
        // Check that webSocketClose was called by verifying storage was updated
        const lastClose = await ctx.storage.get("lastWebSocketClose");
        expect(lastClose).toBeDefined();
        expect(lastClose).toEqual({
          code: 1000,
          reason: 'Test close',
          wasClean: true,
          timestamp: expect.any(Number)
        });
      });
    });

    it('should call webSocketError when message handler throws', async () => {
      const id = env.MY_DO.newUniqueId();
      const stub = env.MY_DO.get(id);
      
      // We expect this to have an error, so we catch it
      try {
        await runWithWebSocketMock(stub, async (mock, instance: MyDO, ctx) => {
          const ws = new WebSocket('wss://example.com');
          ws.onopen = () => {
            ws.send('test-error'); // This will cause the DO to throw an error
          };
          await mock.sync();
        });
      } catch (error) {
        // The error should be propagated, but we also want to check that webSocketError was called
      }
      
      // Check that webSocketError was called by verifying storage was updated
      const id2 = env.MY_DO.newUniqueId();
      const stub2 = env.MY_DO.get(id2);
      await runWithWebSocketMock(stub2, async (mock, instance: MyDO, ctx) => {
        // Trigger the same error but check if the previous instance recorded it
        // Actually, let's check on the same instance by using a different approach
        const ws = new WebSocket('wss://example.com');
        ws.onerror = () => {
          // Error occurred, this is expected
        };
        ws.onopen = () => {
          ws.send('test-error');
        };
        
        try {
          await mock.sync();
        } catch (e) {
          // Expected error
        }
        
        // Check that webSocketError was called
        const lastError = await ctx.storage.get("lastWebSocketError");
        expect(lastError).toBeDefined();
        expect(lastError).toEqual({
          message: 'Test error from DO',
          timestamp: expect.any(Number)
        });
      });
    });

    it('should track all lifecycle events in order', async () => {
      const id = env.MY_DO.newUniqueId();
      const stub = env.MY_DO.get(id);
      await runWithWebSocketMock(stub, async (mock, instance: MyDO, ctx) => {
        const ws = new WebSocket('wss://example.com');
        ws.onopen = async () => {
          ws.send('increment'); // This should work
          // Add a small delay to ensure different timestamps
          await new Promise(resolve => setTimeout(resolve, 10));
          ws.close(1000, 'Normal close');
        };
        await mock.sync();
        
        // Verify all lifecycle events occurred
        const lastOpen = await ctx.storage.get("lastWebSocketOpen");
        const lastClose = await ctx.storage.get("lastWebSocketClose");
        
        expect(lastOpen).toBeDefined();
        expect(lastClose).toBeDefined();
        
        // Verify the order (open should happen before close)
        // Since we added a delay, close timestamp should be greater than open
        expect(lastOpen).toBeLessThan((lastClose as any).timestamp);
        
        // Verify we got the expected message response
        expect(mock.messagesSent).toEqual(['increment']);
        expect(mock.messagesReceived).toEqual(['1']);
      });
    });
  });

});
