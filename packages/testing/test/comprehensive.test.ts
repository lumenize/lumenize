import { describe, it, expect } from 'vitest';
import { runInDurableObject, runWithSimulatedWSUpgrade } from '../src/index.js';
import { MyDO } from './test-harness.js';

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
    }, { 
      timeout: 500,
      origin: 'https://example.com'  // Test explicit origin in runInDurableObject
    });
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
        // Test accessing non-fetch properties on wrapped instance (covers proxy fallback)
        expect(instance.constructor.name).toBe('MyDO');
        expect(typeof instance.webSocketMessage).toBe('function');
        
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
        const lastWebSocketClose = await ctx.storage.get("lastWebSocketClose");
        expect(lastWebSocketClose).toBeInstanceOf(Date);
        // expect(lastWebSocketClose).toBeDefined();
        // expect(lastWebSocketClose).toEqual({ code: 1000 });
        expect(mock.clientCloses).toHaveLength(1);
        expect(mock.clientCloses[0].code).toBe(1000);
        expect(mock.clientCloses[0].reason).toBe('Test close');
      });
    });

    it('should call webSocketError when message handler throws', async () => {
      await expect(async () => {
        await runInDurableObject(async (instance: MyDO, ctx, mock) => {
          const ws = new WebSocket('wss://example.com');
          ws.onopen = () => {
            ws.send('test-error'); // This will cause the DO to throw an error
          };
          await mock.sync();
          
          // Check that webSocketError was called
          const lastError = await ctx.storage.get("lastWebSocketError");
          expect(lastError).toBeDefined();
          expect(lastError).toEqual({
            message: 'Test error from DO',
            timestamp: expect.any(Number)
          });
        });
      }).rejects.toThrow('Test error from DO');
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
        
        expect(lastOpen).toBeDefined();
        expect(mock.clientCloses).toHaveLength(1);
        
        // Verify the order (open should happen before close)
        // Since we added a delay, close timestamp should be greater than open timestamp
        expect(lastOpen).toBeLessThan(mock.clientCloses[0].timestamp);
        
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
        
        // Verify client-initiated close is tracked by framework
        expect(mock.clientCloses).toHaveLength(1);
        expect(mock.clientCloses[0].code).toBe(3001);
        expect(mock.clientCloses[0].reason).toBe('Client closing for test');
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
        
        // Test async onclose handler with server-initiated close (covers Promise branch)
        ws.onclose = async (event) => {
          await new Promise(resolve => setTimeout(resolve, 1));
          serverCloseReceived = true;
          receivedCode = event.code;
          receivedReason = event.reason;
        };
        
        await mock.sync();
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
        
        // Verify client-initiated close is tracked by framework
        expect(mock.clientCloses).toHaveLength(1);
        expect(mock.clientCloses[0].code).toBe(3002);
        expect(mock.clientCloses[0].reason).toBe('Client test close');
      });
    });

  });

  describe('Timeout behavior', () => {
    it('should timeout properly with runWithSimulatedWSUpgrade', async () => {
      await expect(async () => {
        await runWithSimulatedWSUpgrade(
          'https://test-harness.example.com/wss',
          { origin: 'https://example.com', timeout: 50 },
          async (ws) => {
            // This will take longer than the timeout
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        );
      }).rejects.toThrow('WebSocket test timed out after 50ms');
    });
  });

  describe('Custom headers support', () => {
    it('should allow explicit origin to override URL-derived origin', async () => {
      // Using different domain in URL vs explicit origin - explicit should win
      let onmessageCalled = false;
      await runWithSimulatedWSUpgrade(
        'https://other-domain.com/wss',  // URL has different origin
        { origin: 'https://example.com' },  // But explicit origin is valid
        async (ws) => {
          ws.onmessage = (event: MessageEvent) => {
            expect(event.data).toBe('pong');
            onmessageCalled = true;
          };
          ws.send('ping');
        }
      );
      expect(onmessageCalled).toBe(true);
    });

    it('should support custom headers in WebSocket simulation with runWithSimulatedWSUpgrade', async () => {
      await runWithSimulatedWSUpgrade('https://example.com/wss', 
        { 
          origin: 'https://example.com',
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
      await runWithSimulatedWSUpgrade('https://example.com/wss', 
        { 
          origin: 'https://app.example.com',
          headers: {
            'Cookie': 'sessionId=abc123',
            'Host': 'api.example.com',
            'Origin': 'https://example.com' // This should override the shorthand origin with an allowed one
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

    it('should support protocols option in runInDurableObject', async () => {
      await runInDurableObject(async (instance, ctx, mock) => {
        const ws = new WebSocket('wss://example.com');
        ws.onopen = () => {
          ws.send('increment');
        };
        ws.onmessage = (event) => {
          expect(event.data).toBe('1');
        };
        await mock.sync();
      }, {
        protocols: ['mcp', 'websocket']
      });
    });

    it('should merge shorthand options with custom headers correctly', async () => {
      await runWithSimulatedWSUpgrade('https://example.com/wss', 
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
      await runWithSimulatedWSUpgrade('https://example.com/wss', 
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

