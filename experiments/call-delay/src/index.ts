/**
 * Call Delay Experiment
 * 
 * Compares latency of @lumenize/call vs Workers RPC for DO-to-DO communication
 * Uses batch-based testing for realistic measurements
 */

// Import order matters! LumenizeBase must load before @lumenize/call
import { LumenizeBase } from '@lumenize/lumenize-base';
import { RpcTarget } from 'cloudflare:workers';
import '@lumenize/core';
import '@lumenize/call';

/**
 * Experiment Controller - Runs batches of operations
 * 
 * Extends LumenizeBase for @lumenize/call support
 * Implements batch testing for realistic measurements
 */
export class CallDelayController extends LumenizeBase<Env> {
  /**
   * Handle fetch requests - upgrade to WebSocket
   */
  async fetch(request: Request): Promise<Response> {
    // Initialize binding name for call package
    await this.__lmzInit({ doBindingName: 'CONTROLLER' });
    
    // Check for WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response('Call Delay Experiment', { status: 400 });
  }

  /**
   * Handle WebSocket messages from Node.js test client
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    
    try {
      const msg = JSON.parse(message);
      
      if (msg.action === 'run-batch') {
        await this.#handleBatchRequest(msg);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      this.#sendMessage({
        type: 'error',
        error: (error as Error).message
      });
    }
  }

  /**
   * Handle batch test request
   */
  async #handleBatchRequest(msg: { mode: string; count: number }): Promise<void> {
    const { mode, count } = msg;
    
    this.#sendMessage({
      type: 'batch-started',
      mode,
      count
    });

    const startTime = Date.now();
    const results = {
      completed: 0,
      errors: 0,
      errorMessages: [] as string[]
    };

    // Execute batch - fire all operations
    const promises = [];
    for (let i = 0; i < count; i++) {
      const promise = this.runBatchOperation(mode, i)
        .then(() => {
          results.completed++;
          // Send progress update every 5 operations
          if (results.completed % 5 === 0) {
            this.#sendProgress(mode, count, results.completed, startTime);
          }
        })
        .catch((error: Error) => {
          results.errors++;
          results.errorMessages.push(`Op ${i}: ${error.message}`);
        });
      
      promises.push(promise);
    }

    // Wait for all to complete
    await Promise.all(promises);

    const totalTime = Date.now() - startTime;

    // Send final results
    this.#sendMessage({
      type: 'batch-complete',
      mode,
      totalTime,
      completed: results.completed,
      errors: results.errors,
      errorMessages: results.errorMessages
    });
  }

  /**
   * Send progress update
   */
  #sendProgress(mode: string, total: number, completed: number, startTime: number): void {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.#sendMessage({
      type: 'progress',
      mode,
      completed,
      total,
      elapsed: parseFloat(elapsed)
    });
  }

  /**
   * Send message via WebSocket
   */
  #sendMessage(data: any): void {
    const websockets = this.ctx.getWebSockets();
    if (websockets.length === 0) {
      console.error('No WebSocket available to send message');
      return;
    }
    
    const ws = websockets[0];
    ws.send(JSON.stringify(data));
  }
  /**
   * Run a single operation in the batch
   * 
   * @param mode - 'lumenize-call' or 'workers-rpc'
   * @param index - Operation index
   */
  async runBatchOperation(mode: string, index: number): Promise<any> {
    if (mode === 'lumenize-call') {
      return await this.#testLumenizeCall(index);
    } else if (mode === 'workers-rpc') {
      return await this.#testWorkersRPC(index);
    }
    
    throw new Error(`Unknown mode: ${mode}`);
  }

  /**
   * Test @lumenize/call (fire-and-forget with continuations)
   */
  async #testLumenizeCall(index: number): Promise<any> {
    // Store resolve/reject in instance variables to access from handler
    // This is a workaround since continuations can't capture closure variables
    const callId = `call-${index}-${Date.now()}`;
    this.ctx.storage.kv.put(`__test_promise_${callId}`, { resolve: 'pending', reject: 'pending' });
    
    // Store actual promise handlers in a Map (can't serialize functions to KV)
    if (!this.#pendingCalls.has(callId)) {
      this.#pendingCalls.set(callId, { resolve: null, reject: null });
    }
    
    return new Promise((resolve, reject) => {
      try {
        // Store promise handlers
        const handlers = this.#pendingCalls.get(callId)!;
        handlers.resolve = resolve;
        handlers.reject = reject;
        
        // Create remote operation
        const remoteOp = this.ctn<RemoteDO>().echo(`test-${index}`);
        
        // Create continuation that resolves promise
        const continuation = this.ctn().handleCallResult(callId, remoteOp);
        
        // Fire call (non-blocking)
        this.svc.call(
          'REMOTE_DO',
          'test-instance',
          remoteOp,
          continuation
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  #pendingCalls = new Map<string, { resolve: Function | null; reject: Function | null }>();

  /**
   * Handle lumenize call result
   * PUBLIC method (must be public for continuations)
   */
  handleCallResult(callId: string, result: any) {
    const handlers = this.#pendingCalls.get(callId);
    if (!handlers) {
      console.error(`No handlers found for call ${callId}`);
      return;
    }
    
    if (result instanceof Error) {
      handlers.reject?.(result);
    } else {
      // Validate result format
      if (typeof result === 'string' && result.startsWith('echo: test-')) {
        handlers.resolve?.(result);
      } else {
        handlers.reject?.(new Error(`@lumenize/call validation failed: got "${result}"`));
      }
    }
    
    // Cleanup
    this.#pendingCalls.delete(callId);
    this.ctx.storage.kv.delete(`__test_promise_${callId}`);
  }

  /**
   * Test Workers RPC (awaited call)
   */
  async #testWorkersRPC(index: number): Promise<any> {
    const id = this.env.REMOTE_DO.idFromName('test-instance');
    const stub = this.env.REMOTE_DO.get(id);
    const result = await stub.echo(`test-${index}`);
    
    // Validate we got the correct result
    const expected = `echo: test-${index}`;
    if (result !== expected) {
      throw new Error(`Workers RPC validation failed: expected "${expected}", got "${result}"`);
    }
    
    return result;
  }
}

/**
 * Remote DO - Simple echo target for both call systems
 */
export class RemoteDO extends LumenizeBase<Env> implements RpcTarget {
  echo(value: string): string {
    return `echo: ${value}`;
  }
}

/**
 * Worker - Routes requests to controller
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // WebSocket upgrade for Controller
    if (request.headers.get('Upgrade') === 'websocket') {
      const id = env.CONTROLLER.idFromName('test-controller');
      const stub = env.CONTROLLER.get(id);
      return stub.fetch(request);
    }
    
    return new Response('Call Delay Experiment', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
