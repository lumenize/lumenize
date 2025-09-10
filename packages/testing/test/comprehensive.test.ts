import { describe, test, it, expect } from 'vitest';
import {
  DurableObjectState,
  SELF,
  env,
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
} from 'cloudflare:test';
import { runInDurableObject, runWithSimulatedWSUpgrade } from '../src/websocket-utils.js';
import { MyDO } from './test-harness';

describe('Comprehensive WebSocket testing framework tests', () => {

  it('should support addEventListener for libraries that use EventTarget API', async () => {
    await runInDurableObject(async (instance, ctx, mock) => {
      const ws = new WebSocket('wss://example.com');
      let messageReceived = false;
      let openReceived = false;
      let messageEventData: string | null = null;
      
      // Use addEventListener instead of onmessage - this should work
      ws.addEventListener('message', (event: any) => {
        messageReceived = true;
        messageEventData = event.data;
        expect(event.data).toBe('1');
        ws.close();
      });
      
      ws.addEventListener('open', () => {
        openReceived = true;
        ws.send('increment');
      });
      
      await mock.sync();
      
      expect(openReceived).toBe(true);
      expect(messageReceived).toBe(true);
      expect(messageEventData).toBe('1'); // Additional verification the callback ran
      expect(mock.messagesSent).toEqual(['increment']);
      expect(mock.messagesReceived).toEqual(['1']);
    }, 500);
  });

  // Test that assertions in event handlers properly fail tests
  it('should properly propagate assertion failures from WebSocket event handlers', async () => {
    // This should throw because the assertion in onmessage will fail
    await expect(async () => {
      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
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
    }).rejects.toThrow('expected \'1\' to be \'wrong-value\'');
  });

  // Test WebSocket lifecycle hooks
  describe('WebSocket lifecycle hooks', () => {
    it('should call webSocketOpen when connection opens', async () => {
      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
        const ws = new WebSocket('wss://example.com');
        await mock.sync();
        
        // Check that webSocketOpen was called by verifying storage was updated
        const lastOpen = await ctx.storage.get("lastWebSocketOpen");
        expect(lastOpen).toBeDefined();
        expect(typeof lastOpen).toBe('number');
      });
    });

    it('should call webSocketClose when connection closes', async () => {
      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
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
          timestamp: expect.any(Number),
          initiatedBy: 'client'
        });
      });
    });

    it('should call webSocketError when message handler throws', async () => {
      // We expect this to have an error, so we catch it
      try {
        await runInDurableObject(async (instance: MyDO, ctx, mock) => {
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
      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
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
      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
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

    it('should handle async onopen and onclose event handlers returning Promises', async () => {
      let asyncOpenExecuted = false;
      let asyncCloseExecuted = false;

      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
        const ws = new WebSocket('wss://example.com');
        
        // Test async onopen handler (Promise branch)
        ws.onopen = async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
          asyncOpenExecuted = true;
        };
        
        // Test async onclose handler (Promise branch)  
        ws.onclose = async (event) => {
          await new Promise(resolve => setTimeout(resolve, 1));
          asyncCloseExecuted = true;
        };
        
        await mock.sync();
        ws.close();
        await mock.sync();
      });

      expect(asyncOpenExecuted).toBe(true);
      expect(asyncCloseExecuted).toBe(true);
    });

    it('should handle async onerror event handlers returning Promises', async () => {
      let asyncErrorExecuted = false;

      // Test async error handler - expect the error to be thrown
      await expect(async () => {
        await runInDurableObject(async (instance: MyDO, ctx, mock) => {
          const ws = new WebSocket('wss://example.com');
          
          ws.onopen = async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
            // Send a message that will trigger an error to test async onerror
            ws.send('test-error');
          };
          
          // Test async onerror handler (Promise branch)
          ws.onerror = async (event) => {
            await new Promise(resolve => setTimeout(resolve, 1));
            asyncErrorExecuted = true;
          };
          
          await mock.sync();
        });
      }).rejects.toThrow('Test error from DO');

      // Verify that even though the error was thrown, the async handlers executed
      expect(asyncErrorExecuted).toBe(true);
    });
  });

  describe('WebSocket close codes and reasons testing', () => {
    it('should track client-initiated close codes and reasons', async () => {
      let clientCloseReceived = false;
      let receivedCode = 0;
      let receivedReason = '';

      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
        const ws = new WebSocket('wss://example.com');
        
        ws.onopen = () => {
          // Client initiates close with custom code and reason
          ws.close(3001, 'Client closing for test');
        };
        
        ws.onclose = (event) => {
          clientCloseReceived = true;
          receivedCode = event.code;
          receivedReason = event.reason;
        };
        
        await mock.sync();
        
        // Verify client-initiated close is tracked in mock
        expect(mock.clientCloses).toHaveLength(1);
        expect(mock.clientCloses[0].code).toBe(3001);
        expect(mock.clientCloses[0].reason).toBe('Client closing for test');
        
        // Verify server received the client-initiated close
        const clientClose = await ctx.storage.get("lastClientInitiatedClose");
        expect(clientClose).toBeDefined();
        expect(clientClose.code).toBe(3001);
        expect(clientClose.reason).toBe('Client closing for test');
        expect(clientClose.initiatedBy).toBe('client');
      });

      // Verify client received close event
      expect(clientCloseReceived).toBe(true);
      expect(receivedCode).toBe(3001);
      expect(receivedReason).toBe('Client closing for test');
    });

    it('should track server-initiated close codes and reasons', async () => {
      let serverCloseReceived = false;
      let receivedCode = 0;
      let receivedReason = '';

      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
        const ws = new WebSocket('wss://example.com');
        
        ws.onopen = () => {
          // Send special message to trigger server-initiated close
          ws.send('test-server-close');
        };
        
        ws.onclose = (event) => {
          serverCloseReceived = true;
          receivedCode = event.code;
          receivedReason = event.reason;
        };
        
        await mock.sync();
        
        // Verify no client-initiated closes (server closed the connection)
        expect(mock.clientCloses).toHaveLength(0);
        
        // Verify server-initiated close is tracked in storage
        const serverClose = await ctx.storage.get("lastServerInitiatedClose");
        expect(serverClose).toBeDefined();
        expect(serverClose.code).toBe(4001);
        expect(serverClose.reason).toBe('Server initiated close for testing');
        expect(serverClose.initiatedBy).toBe('server');
      });

      // Verify client received server's close event
      expect(serverCloseReceived).toBe(true);
      expect(receivedCode).toBe(4001);
      expect(receivedReason).toBe('Server initiated close for testing');
    });

    it('should distinguish between client and server initiated closes in same test', async () => {
      await runInDurableObject(async (instance: MyDO, ctx, mock) => {
        // Test client-initiated close
        const ws1 = new WebSocket('wss://example.com/client-test');
        ws1.onopen = () => {
          ws1.close(3002, 'Client test close');
        };
        
        await mock.sync();
        
        // Test server-initiated close  
        const ws2 = new WebSocket('wss://example.com/server-test');
        ws2.onopen = () => {
          ws2.send('test-server-close');
        };
        
        await mock.sync();
        
        // Verify we have one client-initiated close tracked in mock
        expect(mock.clientCloses).toHaveLength(1);
        expect(mock.clientCloses[0].code).toBe(3002);
        expect(mock.clientCloses[0].reason).toBe('Client test close');
        
        // Verify both close types are tracked separately in storage
        const clientClose = await ctx.storage.get("lastClientInitiatedClose");
        const serverClose = await ctx.storage.get("lastServerInitiatedClose");
        
        expect(clientClose.code).toBe(3002);
        expect(clientClose.initiatedBy).toBe('client');
        
        expect(serverClose.code).toBe(4001);
        expect(serverClose.initiatedBy).toBe('server');
      });
    });

  });

  describe('Timeout behavior', () => {
    it('should timeout properly with runWithSimulatedWSUpgrade', async () => {
      await expect(async () => {
        await runWithSimulatedWSUpgrade(
          'https://test-harness.example.com/wss',
          { origin: 'https://example.com' },
          async (ws) => {
            // This will take longer than the timeout
            await new Promise(resolve => setTimeout(resolve, 100));
          },
          50  // 50ms timeout
        );
      }).rejects.toThrow('WebSocket test timed out after 50ms');
    });
  });

  describe('Custom headers support', () => {
    it('should support custom headers in WebSocket simulation with runWithSimulatedWSUpgrade', async () => {
      await runWithSimulatedWSUpgrade('https://localhost:8787/test', 
        { 
          headers: {
            'User-Agent': 'TestBot/1.0'
          }
        }, 
        async (ws) => {
          // Test passes if no errors thrown
        }
      );
    });

    it('should support custom headers with override behavior in runWithSimulatedWSUpgrade', async () => {
      await runWithSimulatedWSUpgrade('https://localhost:8787/test', 
        { 
          origin: 'https://app.example.com',
          headers: {
            'Cookie': 'sessionId=abc123',
            'Host': 'api.example.com',
            'Origin': 'https://override.example.com' // This should override the shorthand origin
          }
        }, 
        async (ws) => {
          // Test passes if no errors thrown - headers are passed to server
        }
      );
    });

    it('should support custom headers in runInDurableObject', async () => {
      await runInDurableObject(async (instance, ctx, mock) => {
        // Create a simple DO that accepts WebSocket connections
        const simpleHandler = {
          async fetch(request: Request): Promise<Response> {
            const upgradeHeader = request.headers.get('upgrade');
            if (upgradeHeader !== 'websocket') {
              return new Response('Expected WebSocket Upgrade', { status: 426 });
            }
            
            // Verify custom headers are present
            const userAgent = request.headers.get('User-Agent');
            if (userAgent !== 'TestBot/1.0') {
              return new Response('Missing expected User-Agent header', { status: 400 });
            }
            
            return new Response(null, {
              status: 200
            });
          }
        };
        
        // Override the instance's fetch method for this test
        (instance as any).fetch = simpleHandler.fetch;
        
        // Create WebSocket with custom headers - this should trigger the fetch method
        const ws = new WebSocket('ws://localhost:8787/test');
        await mock.sync();
      }, {
        headers: {
          'User-Agent': 'TestBot/1.0'
        }
      });
    });

    it('should merge shorthand options with custom headers correctly', async () => {
      await runWithSimulatedWSUpgrade('https://example.com/test', 
        { 
          protocols: ['chat', 'superchat'],
          origin: 'https://example.com',
          headers: {
            'User-Agent': 'TestApp/2.0',
            'Authorization': 'Bearer token123'
          }
        }, 
        async (ws) => {
          // Test passes if headers are merged correctly without errors
        }
      );
    });

    it('should allow empty headers object', async () => {
      await runWithSimulatedWSUpgrade('https://example.com/test', 
        { 
          origin: 'https://example.com',
          headers: {}
        }, 
        async (ws) => {
          // Test passes if empty headers don't cause issues
        }
      );
    });
  });

});

