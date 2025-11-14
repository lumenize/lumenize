/**
 * Base Experiment Controller DO
 * 
 * Handles WebSocket connection and batch test execution.
 * Experiments should extend this and implement runBatchOperation().
 */

import { DurableObject } from 'cloudflare:workers';

/**
 * Variation metadata and handler
 */
export interface VariationDefinition {
  name: string;
  description: string;
  handler: (index: number) => Promise<void>;
}

export class ExperimentController<Env = any> extends DurableObject<Env> {
  /**
   * Create a standard fetch handler for experiments
   * 
   * @param controllerBinding - Name of the controller DO binding (e.g., 'CONTROLLER')
   * @returns ExportedHandler for the Worker
   */
  static createFetchHandler(controllerBinding: string): ExportedHandler {
    return {
      fetch: async (request: Request, env: any): Promise<Response> => {
        const url = new URL(request.url);
        
        // REST: Version info
        if (url.pathname === '/version') {
          return new Response(JSON.stringify({ 
            version: 1, 
            timestamp: Date.now() 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        // REST: Available variations (query controller)
        if (url.pathname === '/patterns') {
          const id = env[controllerBinding].idFromName('controller');
          const stub = env[controllerBinding].get(id);
          const patterns = await stub.listVariations();
          
          return new Response(JSON.stringify({ 
            patterns 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // REST: Check completion (for client-side polling)
        if (url.pathname === '/rpc/checkCompletion' && request.method === 'POST') {
          const body = await request.json() as { mode: string; index: number };
          const id = env[controllerBinding].idFromName('controller');
          const stub = env[controllerBinding].get(id) as any;
          const isComplete = await stub.checkCompletion(body.mode, body.index);

          return new Response(JSON.stringify(isComplete), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        // WebSocket: Batch execution with streaming
        if (request.headers.get('Upgrade') === 'websocket') {
          const id = env[controllerBinding].idFromName('controller');
          const stub = env[controllerBinding].get(id);
          return stub.fetch(request);
        }
        
        return new Response('Experiment - Use /patterns to discover available tests', { status: 200 });
      }
    };
  }
  /**
   * Handle fetch requests - upgrade to WebSocket
   */
  async fetch(request: Request): Promise<Response> {
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

    return new Response('Experiment Controller - Use WebSocket', { status: 400 });
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
        error: error instanceof Error ? error.message : String(error)
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

    const results = {
      completed: 0,
      errors: 0,
      errorMessages: [] as string[]
    };

    // Check if this is an async pattern (fire-and-forget)
    const variations = this.getVariations();
    const definition = variations.get(mode);
    const isAsync = definition?.handler.constructor.name !== 'AsyncFunction';
    
    if (isAsync) {
      // Fire-and-forget patterns (V4, V5): fire all operations without awaiting
      // They use blockConcurrencyWhile internally, so awaiting them would timeout
      for (let i = 0; i < count; i++) {
        try {
          this.runBatchOperation(mode, i); // Don't await
          results.completed++;
          // Send progress update every 5 operations
          if (results.completed % 5 === 0) {
            this.#sendProgress(mode, count, results.completed);
          }
        } catch (error) {
          results.errors++;
          results.errorMessages.push(`Op ${i}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      // Sequential patterns (V1-V3): execute sequentially to measure per-call latency
      for (let i = 0; i < count; i++) {
        try {
          await this.runBatchOperation(mode, i);
          results.completed++;
          // Send progress update every 5 operations
          if (results.completed % 5 === 0) {
            this.#sendProgress(mode, count, results.completed);
          }
        } catch (error) {
          results.errors++;
          results.errorMessages.push(`Op ${i}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    
    // Send final results immediately (client will poll for completion)
    // For async patterns, all operations fired but may still be processing
    // For sequential patterns, all operations completed
    this.#sendMessage({
      type: 'batch-complete',
      mode,
      completed: results.completed,
      errors: results.errors,
      errorMessages: results.errorMessages
    });
  }

  /**
   * Send progress update
   */
  #sendProgress(mode: string, total: number, completed: number): void {
    this.#sendMessage({
      type: 'progress',
      mode,
      completed,
      total
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
   * Override this to register experiment variations
   * 
   * @returns Map of mode string to variation definition
   */
  protected getVariations(): Map<string, VariationDefinition> {
    return new Map();
  }

  /**
   * Get available variations for discovery endpoint (RPC method)
   *
   * Automatically extracts metadata from registered variations
   */
  async listVariations() {
    const variations = this.getVariations();
    return Array.from(variations.entries()).map(([mode, def]) => ({
      mode,
      name: def.name,
      description: def.description
    }));
  }

  /**
   * Check if a specific completion marker exists (RPC method for client polling)
   */
  async checkCompletion(mode: string, index: number): Promise<boolean> {
    const completionKey = `__lmz_exp_completed_${mode}_${index}`;
    return this.ctx.storage.kv.get(completionKey) !== undefined;
  }

  /**
   * Route to appropriate variation handler based on mode
   * 
   * Subclasses should override getVariations() instead of this method
   * 
   * Convention: Handlers should write `true` to storage at key 
   * `__lmz_exp_completed_${mode}_${index}` when work is complete.
   * This allows non-awaitable handlers (e.g., using blockConcurrencyWhile) 
   * to signal completion. The framework polls for the LAST operation
   * after all handlers have been called.
   * 
   * @param mode - Test mode (e.g., 'v1-pure-rpc', 'v2-operation-chains')
   * @param index - Operation index in batch
   */
  async runBatchOperation(mode: string, index: number): Promise<void> {
    const variations = this.getVariations();
    const definition = variations.get(mode);

    if (!definition) {
      const available = Array.from(variations.keys()).join(', ');
      throw new Error(`Unknown mode: ${mode}. Available: ${available || 'none'}`);
    }

    // Call the handler (may return immediately for fire-and-forget patterns)
    // No polling here - we poll at batch level for the last operation
    await definition.handler(index);
  }
}

