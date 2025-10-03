import { lumenizeRpcDo, handleRPCRequest, handleWebSocketRPCMessage } from '../src/lumenize-rpc-do';
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
class _ExampleDO extends DurableObject<Env> {
  public readonly complexData: any;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create complex data structure with circular references
    this.complexData = createComplexData(this, 'ExampleDO');
  }

  // Simple method
  async increment(): Promise<number> {
    const count = (await this.ctx.storage.get('count') as number | undefined) || 0;
    const newCount = count + 1;
    this.ctx.storage.kv.put('count', newCount);
    return newCount;
  }

  // Method with arguments  
  add(a: number, b: number): number {
    return a + b;
  }

  // Method that throws an error
  throwError(message: string): void {
    const error = new Error(message) as any;
    error.code = 'TEST_ERROR';
    error.statusCode = 400;
    error.metadata = { timestamp: Date.now(), source: 'ExampleDO' };
    throw error;
  }

  // Method that throws a string
  throwString(message: string): void {
    throw message;
  }

  // Method that returns object with remote functions
  getObject() {
    const nested = {
      value: 42,
      getValue(): number {
        return this.value;
      }
    };
    return {
      value: 42,
      nested
    };
  }

  // Method that returns array
  getArray(): number[] {
    return [1, 2, 3, 4, 5];
  }

  // Method that returns array with functions
  getArrayWithFunctions(): any[] {
    return [
      1,
      2,
      () => 'hello',
      { value: 42, getValue: function() { return this.value; } },
      5
    ];
  }

  // Method that returns an object with throwing getter
  getProblematicObject(): any {
    const obj: any = { value: 42 };
    Object.defineProperty(obj, 'badGetter', {
      get() {
        throw new Error('Getter throws error');
      },
      enumerable: true
    });
    return obj;
  }

  // Method that returns a class instance
  getClassInstance(): DataModel {
    return new DataModel(42, 'TestModel');
  }

  // Method that returns deeply nested object
  getDeeplyNested() {
    return {
      level1: {
        level2: {
          level3: {
            value: 'deep',
            getValue: () => 'deeply nested value'
          }
        }
      }
    };
  }

  // Method with non-function property
  getObjectWithNonFunction() {
    return {
      notAFunction: 42,
      data: { value: 'test' }
    };
  }

  // Method with delay
  async slowIncrement(delayMs: number = 100): Promise<number> {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return this.increment();
  }

  // Built-in types
  getDate(): Date {
    return new Date('2025-01-01T00:00:00Z');
  }

  getRegExp(): RegExp {
    return /[0-9]+/g;
  }

  getMap(): Map<string, string> {
    return new Map([['key', 'value']]);
  }

  getSet(): Set<number> {
    return new Set([1, 2, 3]);
  }

  getArrayBuffer(): ArrayBuffer {
    return new ArrayBuffer(8);
  }

  getTypedArray(): Uint8Array {
    return new Uint8Array([1, 2, 3, 4]);
  }

  getError(): Error {
    return new Error('Test error');
  }

  async getCounter(): Promise<number> {
    return (await this.ctx.storage.get('count') as number | undefined) || 0;
  }

  // Original fetch method
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname.endsWith('/increment')) {
      const count = await this.increment();
      return new Response(count.toString());
    }
    
    return new Response('original');
  }
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

  // Override existing method
  override async increment(): Promise<number> {
    // Call super, then add bonus
    const count = await super.increment();
    // Add 1000 bonus for subclass increments
    const bonusCount = count + 1000;
    await this.ctx.storage.put('count', bonusCount);
    return bonusCount;
  }

  // Override method that returns different value
  override add(a: number, b: number): number {
    // Add 100 bonus to subclass additions
    return super.add(a, b) + 100;
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
 * This demonstrates how to use handleRPCRequest directly for custom routing
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
  }

  // Same methods as ExampleDO
  async increment(): Promise<number> {
    const count = (await this.ctx.storage.get('count') as number | undefined) || 0;
    const newCount = count + 1;
    await this.ctx.storage.put('count', newCount);
    return newCount;
  }

  add(a: number, b: number): number {
    return a + b;
  }

  throwError(message: string): void {
    const error = new Error(message) as any;
    error.code = 'TEST_ERROR';
    error.statusCode = 400;
    error.metadata = { timestamp: Date.now(), source: 'ManualRoutingDO' };
    throw error;
  }

  throwString(message: string): void {
    throw message;
  }

  getObject() {
    const nested = {
      value: 42,
      getValue(): number {
        return this.value;
      }
    };
    return {
      value: 42,
      nested
    };
  }

  getArray(): number[] {
    return [1, 2, 3, 4, 5];
  }

  getArrayWithFunctions(): any[] {
    return [
      1,
      2,
      () => 'hello',
      { value: 42, getValue: function() { return this.value; } },
      5
    ];
  }

  getProblematicObject(): any {
    const obj: any = { value: 42 };
    Object.defineProperty(obj, 'badGetter', {
      get() {
        throw new Error('Getter throws error');
      },
      enumerable: true
    });
    return obj;
  }

  getClassInstance(): DataModel {
    return new DataModel(42, 'TestModel');
  }

  getDeeplyNested() {
    return {
      level1: {
        level2: {
          level3: {
            value: 'deep',
            getValue: () => 'deeply nested value'
          }
        }
      }
    };
  }

  getObjectWithNonFunction() {
    return {
      notAFunction: 42,
      data: { value: 'test' }
    };
  }

  async slowIncrement(delayMs: number = 100): Promise<number> {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return this.increment();
  }

  getDate(): Date {
    return new Date('2025-01-01T00:00:00Z');
  }

  getRegExp(): RegExp {
    return /[0-9]+/g;
  }

  getMap(): Map<string, string> {
    return new Map([['key', 'value']]);
  }

  getSet(): Set<number> {
    return new Set([1, 2, 3]);
  }

  getArrayBuffer(): ArrayBuffer {
    return new ArrayBuffer(8);
  }

  getTypedArray(): Uint8Array {
    return new Uint8Array([1, 2, 3, 4]);
  }

  getError(): Error {
    return new Error('Test error');
  }

  async getCounter(): Promise<number> {
    return (await this.ctx.storage.get('count') as number | undefined) || 0;
  }

  // Custom routing implementation
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Check for WebSocket upgrade request
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // Handle custom WebSocket endpoint (completely separate from RPC)
      if (url.pathname.endsWith('/custom-ws')) {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        
        // Accept the WebSocket connection
        this.ctx.acceptWebSocket(server);
        
        return new Response(null, {
          status: 101,
          webSocket: client,
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
    
    // RPC handling - user manually calls handleRPCRequest
    const rpcResponse = await handleRPCRequest(request, this, this.#rpcConfig);
    if (rpcResponse) {
      return rpcResponse;
    }
    
    // Fallback
    return new Response('Not found', { status: 404 });
  }

  // WebSocket message handler
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Try to handle as RPC message first
    const wasRpcMessage = await handleWebSocketRPCMessage(ws, message, this, this.#rpcConfig);
    if (wasRpcMessage) {
      return; // RPC message handled
    }
    
    // Not an RPC message, handle custom WebSocket messages for /custom-ws endpoint
    if (typeof message === 'string' && message === 'PING') {
      ws.send('PONG');
      return;
    }
    
    // Unrecognized message - ignore it
    // (In a real app, you might want to log or handle other custom messages here)
  }
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
