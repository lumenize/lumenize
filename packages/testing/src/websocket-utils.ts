/**
 * Simple WebSocket proxy that directly communicates with server instance
 * without the complexity of runInDurableObject within the proxy.
 * Useful for integration testing between LumenizeClient and Lumenize server.
 */
export function createDirectWebSocketProxy(serverInstance: any, mockConnection: any): () => void {
  const globalScope = typeof window !== 'undefined' ? window : globalThis;
  const OriginalWebSocket = globalScope.WebSocket;
  
  if (!OriginalWebSocket) {
    console.warn('WebSocket not available for monkey patching');
    return () => {};
  }

  // Mock WebSocket class that routes messages directly to server
  function MockWebSocket(this: any, url: string | URL, protocols?: string | string[]) {
    const eventTarget = new EventTarget();
    
    // WebSocket-like interface
    this.readyState = 1; // OPEN
    this.url = url.toString();
    this.protocol = '';
    this.extensions = '';
    this.bufferedAmount = 0;
    
    // Event handlers
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    
    // Event listener methods
    this.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    this.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    this.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
    
    // Send method - routes directly to server
    this.send = async (data: string) => {
      try {
        // Parse the envelope from client
        const envelope = JSON.parse(data);
        
        // Extract the MCP message from the envelope
        const mcpMessage = JSON.stringify(envelope.payload);
        
        // Send directly to server's onMessage method
        await serverInstance.onMessage(mockConnection.connection, mcpMessage);
        
        // Get the response from mock connection
        const response = mockConnection.getLastMessage();
        if (response) {
          // Parse server response and wrap in envelope
          const serverPayload = JSON.parse(response);
          const responseEnvelope = {
            type: envelope.type || 'mcp',
            payload: serverPayload
          };
          
          // Send response back to client
          setTimeout(() => {
            const messageEvent = new MessageEvent('message', {
              data: JSON.stringify(responseEnvelope)
            });
            
            if (this.onmessage) {
              this.onmessage(messageEvent);
            }
            this.dispatchEvent(messageEvent);
          }, 0);
          
          // Clear the message from mock for next call
          mockConnection.clearMessages();
        }
      } catch (error) {
        console.error('Error in WebSocket proxy send:', error);
        
        // Send error to client
        setTimeout(() => {
          const errorEvent = new Event('error');
          if (this.onerror) {
            this.onerror(errorEvent);
          }
          this.dispatchEvent(errorEvent);
        }, 0);
      }
    };
    
    this.close = () => {
      this.readyState = 3; // CLOSED
      setTimeout(() => {
        const closeEvent = new CloseEvent('close', { code: 1000, reason: 'Normal closure' });
        if (this.onclose) {
          this.onclose(closeEvent);
        }
        this.dispatchEvent(closeEvent);
      }, 0);
    };
    
    // Simulate connection opening
    setTimeout(() => {
      const openEvent = new Event('open');
      if (this.onopen) {
        this.onopen(openEvent);
      }
      this.dispatchEvent(openEvent);
    }, 0);
  }
  
  // Add WebSocket constants
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  
  // Replace global WebSocket
  globalScope.WebSocket = MockWebSocket as any;
  
  // Return cleanup function
  return () => {
    globalScope.WebSocket = OriginalWebSocket;
  };
}

/**
 * Monkey patch WebSocket to inject cookies into URL search parameters for testing
 * This is needed because our test environment doesn't have proper cookie support
 * but the server expects sessionId in cookies for authentication.
 */
export function monkeyPatchWebSocketForTesting() {
  // Check if we're in a browser environment with window object
  const globalScope = typeof window !== 'undefined' ? window : globalThis;
  
  // Save the original WebSocket constructor
  const OriginalWebSocket = globalScope.WebSocket;
  
  if (!OriginalWebSocket) {
    console.warn('WebSocket not available for monkey patching');
    return () => {}; // Return no-op cleanup function
  }
  
  // Monkey patch the WebSocket constructor
  globalScope.WebSocket = function(url: string | URL, protocols?: string | string[]) {
    // Parse the URL to inject cookies
    const parsedUrl = new URL(url);
    
    // Get cookies from document if available, or use a test sessionId
    let cookies = '';
    if (typeof document !== 'undefined' && document.cookie) {
      cookies = document.cookie;
    } else {
      // In testing environment, create a test sessionId cookie
      cookies = 'sessionId=test-session-' + Math.random().toString(36).substring(7);
    }

    // Add cookies to the query string for the server to parse in test/dev environments
    parsedUrl.searchParams.append('cookies', encodeURIComponent(cookies));

    // Call the original WebSocket constructor with the modified URL
    return new OriginalWebSocket(parsedUrl.toString(), protocols);
  } as any;

  // Copy static properties if they exist
  Object.setPrototypeOf(globalScope.WebSocket, OriginalWebSocket);
  
  // Return cleanup function to restore original WebSocket
  return () => {
    globalScope.WebSocket = OriginalWebSocket;
  };
}
