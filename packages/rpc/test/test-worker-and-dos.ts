import { lumenizeRpcDo, handleRpcRequest, handleRpcMessage } from '../src/lumenize-rpc-do';
import type { RpcConfig } from '../src/types';
import { routeDORequest } from '@lumenize/utils';
import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import { sharedDOMethods, createComplexData, DataModel } from './shared/do-methods';

/**
 * Example Durable Object for testing RPC functionality
 * Implements shared methods directly to avoid 'this' typing issues
 */
// Base class that will have sharedDOMethods mixed in
class _ExampleDO extends DurableObject<Env> {
  public readonly complexData: any;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create complex data structure with circular references
    this.complexData = createComplexData(this, 'ExampleDO');
  }

  // Original fetch method
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname.endsWith('/increment')) {
      const count = await (this as any).increment();
      return new Response(count.toString());
    }
    
    return new Response('original');
  }
}

// Mix in shared DO methods
Object.assign(_ExampleDO.prototype, sharedDOMethods);

// Type assertion to tell TypeScript that _ExampleDO has the mixed-in methods
interface _ExampleDO extends Omit<typeof sharedDOMethods, 'increment' | 'add' | 'throwError' | 'throwString' | 'slowIncrement' | 'getCounter'> {
  increment(): Promise<number>;
  add(a: number, b: number): number;
  throwError(message: string): void;
  throwString(message: string): void;
  slowIncrement(delayMs?: number): Promise<number>;
  getCounter(): Promise<number>;
}

// Export the lumenized version
const ExampleDO = lumenizeRpcDo(_ExampleDO);
export { ExampleDO };

/**
 * Subclass of ExampleDO for testing inheritance through RPC
 */
class _SubclassDO extends _ExampleDO {
  // New property only in subclass
  private readonly subclassProperty = 'I am a subclass';

  // New method only in subclass
  multiply(a: number, b: number): number {
    return a * b;
  }

  // New method that uses inherited functionality
  async doubleIncrement(): Promise<number> {
    await this.increment();
    return this.increment();
  }

  // Override existing method - can't use 'override' keyword with mixed-in methods
  async increment(): Promise<number> {
    // Get the base implementation from prototype
    const baseIncrement = _ExampleDO.prototype.increment;
    const count = await baseIncrement.call(this);
    // Add 1000 bonus for subclass increments
    const bonusCount = count + 1000;
    await this.ctx.storage.kv.put('count', bonusCount);
    return bonusCount;
  }

  // Override method that returns different value
  add(a: number, b: number): number {
    // Get the base implementation from prototype
    const baseAdd = _ExampleDO.prototype.add;
    // Add 100 bonus to subclass additions
    return baseAdd.call(this, a, b) + 100;
  }

  // Getter to test getter support in subclass
  get subclassName(): string {
    return 'SubclassDO';
  }

  // Method that returns subclass property
  getSubclassProperty(): string {
    return this.subclassProperty;
  }
}

// Export the lumenized version
const SubclassDO = lumenizeRpcDo(_SubclassDO);
export { SubclassDO };

/**
 * Example Durable Object that uses manual routing instead of the factory
 * This demonstrates how to use handleRpcRequest directly for custom routing
 * Has same methods as ExampleDO for consistent testing
 */
export class ManualRoutingDO extends DurableObject<Env> {
  #rpcConfig: RpcConfig = {
    prefix: '/__rpc'
  };
  
  public readonly complexData: any;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create complex data structure (same as ExampleDO)
    this.complexData = createComplexData(this, 'ManualRoutingDO');

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("auto-response ping", "auto-response pong"),
    );
  }

  // Custom routing implementation
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Check for WebSocket upgrade request
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // Handle custom WebSocket endpoint (completely separate from RPC)
      if (url.pathname.endsWith('/custom-ws') || url.pathname.includes('/ws')) {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        
        // Handle sub-protocol selection
        const requestedProtocols = request.headers.get('Sec-WebSocket-Protocol');
        const responseHeaders = new Headers();
        if (requestedProtocols) {
          const protocols = requestedProtocols.split(',').map(p => p.trim());
          if (protocols.includes('correct.subprotocol')) {
            responseHeaders.set('Sec-WebSocket-Protocol', 'correct.subprotocol');
          }
        }
        
        // Accept the WebSocket connection
        this.ctx.acceptWebSocket(server);
        
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: responseHeaders,
        });
      }
      
      // Handle WebSocket upgrades for RPC endpoints
      if (url.pathname.startsWith(this.#rpcConfig.prefix!)) {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        
        // Accept the WebSocket connection
        this.ctx.acceptWebSocket(server);
        
        return new Response(null, {
          status: 101,
          webSocket: client,
        });
      }
    }
    
    // Custom route 1: Health check
    if (url.pathname.endsWith('/health')) {
      return new Response('OK', { status: 200 });
    }
    
    // Custom route 2: Direct counter access via REST
    if (url.pathname.endsWith('/counter')) {
      const counter = await this.getCounter();
      return Response.json({ counter });
    }
    
    // Custom route 3: Reset counter
    if (url.pathname.endsWith('/reset') && request.method === 'POST') {
      await this.ctx.storage.put('count', 0);
      return Response.json({ message: 'Counter reset' });
    }
    
    // RPC handling - user manually calls handleRpcRequest
    const rpcResponse = await handleRpcRequest(request, this, this.#rpcConfig);
    if (rpcResponse) {
      return rpcResponse;
    }
    
    // Fallback
    return new Response('Not found', { status: 404 });
  }

  // WebSocket message handler
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Try to handle as RPC message first
    const wasRpcMessage = await handleRpcMessage(ws, message, this, this.#rpcConfig);
    if (wasRpcMessage) {
      return; // RPC message handled
    }
    
    // Not an RPC message, echo it back for testing
    // Handle custom WebSocket messages for /custom-ws and /ws endpoints
    if (typeof message === 'string') {
      if (message === 'PING') {
        ws.send('PONG');
      } else {
        // Echo string messages back
        ws.send(message);
      }
      return;
    }
    
    // Echo binary messages back (ArrayBuffer from Cloudflare Workers)
    // Cloudflare Workers always provides binary as ArrayBuffer, not Uint8Array
    ws.send(message);
  }
}

// Mix in shared DO methods
Object.assign(ManualRoutingDO.prototype, sharedDOMethods);

// Type assertion to tell TypeScript that ManualRoutingDO has the mixed-in methods
export interface ManualRoutingDO extends Omit<typeof sharedDOMethods, 'increment' | 'add' | 'throwError' | 'throwString' | 'slowIncrement' | 'getCounter'> {
  increment(): Promise<number>;
  add(a: number, b: number): number;
  throwError(message: string): void;
  throwString(message: string): void;
  slowIncrement(delayMs?: number): Promise<number>;
  getCounter(): Promise<number>;
}

/**
 * Worker fetch handler that uses routeDORequest to handle RPC requests
 * and falls back to existing Worker handlers/responses for non-RPC requests
 */
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    console.debug('%o', {
      type: 'debug',
      where: 'test-worker-and-dos.ts Worker fetch handler',
      url: request.url,
    });
    
    // Try to route RPC requests first using routeDORequest
    const rpcResponse = await routeDORequest(request, env, { prefix: '/__rpc' });
    if (rpcResponse) return rpcResponse;

    // Try worker-level custom handlers
    const workerPingResponse = this.handleWorkerPing(request);
    if (workerPingResponse) return workerPingResponse;

    // Try to route non-RPC DO requests using routeDORequest (no prefix)
    const doResponse = await routeDORequest(request, env);
    if (doResponse) return doResponse;

    // Fall back for unhandled routes
    return new Response('Not Found', { status: 404 });
  },

  handleWorkerPing: (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ping')) {
      return new Response('pong from Worker');
    } else {
      return undefined;
    }
  }
}
