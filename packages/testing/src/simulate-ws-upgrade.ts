import {
  SELF,
  env,
  createExecutionContext,
// @ts-expect-error - cloudflare:test module types are not consistently exported
} from 'cloudflare:test';

import { WSUpgradeOptions } from './types.js';
import { createWSUpgradeRequest } from './create-ws-upgrade-request.js';

/**
 * Gets a Cloudflare server-side ws object by simulating a WebSocket upgrade request thru a Worker
 * 
 * @param url - The full WebSocket URL (e.g., 'https://example.com/path')
 * @param options - Optional WebSocket upgrade options including sub-protocols, origin, and custom headers
 * @returns Promise with WebSocket instance and upgrade response
 */
export async function simulateWSUpgrade(url: string, options?: WSUpgradeOptions) {
  const ctx = createExecutionContext();
  const req = createWSUpgradeRequest(url, options);
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
 * @param testFn - Function that receives WebSocket and upgrade details
 * @returns Promise that resolves when test completes or rejects on timeout/error (default timeout: 100ms)
 * 
 * @overload
 * @param url - The full WebSocket URL
 * @param options - Optional WebSocket upgrade options including sub-protocols, origin, and timeout
 * @param testFn - Function that receives WebSocket and upgrade details
 * @returns Promise that resolves when test completes or rejects on timeout/error
 */
export function runWithSimulatedWSUpgrade(
  url: string, 
  testFn: (ws: WebSocket) => Promise<void> | void
): Promise<void>;
export function runWithSimulatedWSUpgrade(
  url: string,
  options: WSUpgradeOptions,
  testFn: (ws: WebSocket) => Promise<void> | void
): Promise<void>;
export function runWithSimulatedWSUpgrade(
  url: string,
  optionsOrTestFn: WSUpgradeOptions | ((ws: WebSocket) => Promise<void> | void),
  testFn?: (ws: WebSocket) => Promise<void> | void
): Promise<void> {
  let options: WSUpgradeOptions;
  let actualTestFn: (ws: WebSocket) => Promise<void> | void;

  if (typeof optionsOrTestFn === 'function') {
    // First signature: url, testFn
    options = {};
    actualTestFn = optionsOrTestFn;
  } else {
    // Second signature: url, options, testFn
    options = optionsOrTestFn || {};
    actualTestFn = testFn!;
  }

  const actualTimeoutMs = options.timeout || 100;

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
      const result = actualTestFn(ws);
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