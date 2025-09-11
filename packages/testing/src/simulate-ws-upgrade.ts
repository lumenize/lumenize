import {
  SELF,
  env,
  createExecutionContext,
// @ts-expect-error - cloudflare:test module types are not consistently exported
} from 'cloudflare:test';

import { WSUpgradeOptions } from './types.js';

/**
 * Gets a Cloudflare server-side ws object by simulating a WebSocket upgrade request thru a Worker
 * 
 * @param url - The full WebSocket URL (e.g., 'https://example.com/path')
 * @param options - Optional WebSocket upgrade options including sub-protocols, origin, and custom headers
 * @returns Promise with WebSocket instance and upgrade response
 */
export async function simulateWSUpgrade(url: string, options?: WSUpgradeOptions) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { 
    Upgrade: "websocket",
    Connection: "upgrade"
  };
  
  if (options?.protocols && options.protocols.length > 0) {
    headers['Sec-WebSocket-Protocol'] = options.protocols.join(', ');
  }

  // Set origin - use explicit option if provided, otherwise derive from URL
  if (options?.origin) {
    headers['Origin'] = options.origin;
  } else {
    // For testing convenience, derive default origin from URL
    // This would be a security risk in production but is fine for testing
    const urlObj = new URL(url);
    headers['Origin'] = urlObj.origin;
  }

  // Merge custom headers, allowing them to override shorthand options
  if (options?.headers) {
    Object.assign(headers, options.headers);
  }

  const req = new Request(url, { headers });
  const res = await SELF.fetch(req, env, ctx);
  const ws = res.webSocket as any;

  // Only accept the WebSocket if the upgrade was successful (status 101)
  if (ws && res.status === 101) {
    ws.accept(); // This works because we're running inside of workerd
  }

  return { ws, response: res };
}

/**
 * Runs a test function on a Cloudflare server-side ws object acquired by simulating
 * a WebSocket upgrade request. This is a higher-level API than simulateWSUpgrade 
 * that has conveniences for testing like automatic timeouts, automatic cleanup, and
 * interpreting sub-protocol headers.
 * 
 * @param url - The full WebSocket URL
 * @param options - Optional WebSocket upgrade options including sub-protocols and origin
 * @param testFn - Function that receives WebSocket and upgrade details
 * @param timeoutMs - Timeout in milliseconds (default: 5000)  
 * @returns Promise that resolves when test completes or rejects on timeout/error
 */
export function runWithSimulatedWSUpgrade(
  url: string, 
  testFn: (ws: any) => Promise<void> | void, 
  timeoutMs?: number
): Promise<void>;
export function runWithSimulatedWSUpgrade(
  url: string,
  optionsOrTestFn: WSUpgradeOptions | ((ws: any) => Promise<void> | void),
  testFnOrTimeoutMs?: ((ws: any) => Promise<void> | void) | number,
  timeoutMs?: number
): Promise<void>;
export function runWithSimulatedWSUpgrade(
  url: string,
  optionsOrTestFn: WSUpgradeOptions | ((ws: any) => Promise<void> | void),
  testFnOrTimeoutMs?: ((ws: any) => Promise<void> | void) | number,
  timeoutMs?: number
): Promise<void> {
  let options: WSUpgradeOptions;
  let testFn: (ws: any) => Promise<void> | void;
  let actualTimeoutMs = timeoutMs || 100;

  if (typeof optionsOrTestFn === 'function') {
    // First signature: url, testFn, timeoutMs?
    options = {};
    testFn = optionsOrTestFn;
    actualTimeoutMs = (testFnOrTimeoutMs as number) || 100;
  } else {
    // Second parameter is options, third is test function
    options = optionsOrTestFn || {};
    testFn = testFnOrTimeoutMs as (ws: any) => Promise<void> | void;
    actualTimeoutMs = timeoutMs || 100;
  }

  return new Promise<void>(async (resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`WebSocket test timed out after ${actualTimeoutMs}ms`));
      }, actualTimeoutMs);
    });
    
    const testPromise = async () => {
      const { ws, response } = await simulateWSUpgrade(url, options);
      
      // Check if WebSocket upgrade failed - throw with actual status code and response message
      if (!ws || response.status !== 101) {
        const errorText = await response.text();
        throw new Error(`WebSocket upgrade failed with status ${response.status}: ${errorText}`);
      }
      
      // Extract selected protocol from response and set it on the WebSocket
      const selectedProtocol = response.headers.get('Sec-WebSocket-Protocol') || '';
      
      // Set protocol property on the WebSocket object if possible
      try {
        Object.defineProperty(ws, 'protocol', {
          value: selectedProtocol,
          writable: false,
          enumerable: true,
          configurable: true
        });
      } catch (error) {
        // If we can't set the protocol property, that's okay
      }
        
      // Run the test function
      const result = testFn(ws);
      if (result instanceof Promise) {
        await result;
      }
      
      // Small delay to allow any pending WebSocket operations to complete
      // This helps when users set up async operations (like onmessage) without awaiting them
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Clean up the WebSocket connection
      if (ws && typeof ws.close === 'function' && ws.readyState !== ws.CLOSED) {
        ws.close();
      }
    };
    
    try {
      await Promise.race([testPromise(), timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve();
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(error);
    }
  });
}