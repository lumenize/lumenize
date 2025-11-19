/**
 * LumenizeExperimentDO - Base class for experiments using LumenizeBase
 * 
 * Provides experiment framework features (WebSocket, pattern registration, etc.)
 * while allowing full LumenizeBase functionality (NADIS services, lmzInit, etc.)
 * 
 * Usage:
 * ```typescript
 * export class MyExperiment extends LumenizeExperimentDO<Env> {
 *   protected getVariations(): Map<string, VariationDefinition> {
 *     return new Map([
 *       ['v1', { name: 'Baseline', description: '...', handler: this.#runV1.bind(this) }],
 *     ]);
 *   }
 * }
 * ```
 */

import { LumenizeBase } from '@lumenize/lumenize-base';
import type { VariationDefinition } from './controller.js';

export abstract class LumenizeExperimentDO<Env = any> extends LumenizeBase<Env> {
  // Note: WebSockets accessed via this.ctx.getWebSockets('experiment')

  /**
   * Override fetch to handle experiment routes before delegating to LumenizeBase
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Experiment: version endpoint
    if (url.pathname === '/version') {
      return new Response(JSON.stringify({
        version: 1,
        timestamp: Date.now()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Experiment: pattern discovery endpoint
    if (url.pathname === '/patterns') {
      const patterns = this.#getPatternsList();
      return new Response(JSON.stringify({ patterns }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Experiment: completion check endpoint (for client polling)
    if (url.pathname === '/rpc/checkCompletion' && request.method === 'POST') {
      const body = await request.json() as { mode: string; index: number };
      const isComplete = this.#checkCompletion(body.mode, body.index);
      return new Response(JSON.stringify(isComplete), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Experiment: WebSocket for batch execution
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.#handleWebSocket(request);
    }

    // Not an experiment route - delegate to LumenizeBase
    return super.fetch(request);
  }

  /**
   * Subclasses override this to register their test variations
   */
  protected abstract getVariations(): Map<string, VariationDefinition>;

  /**
   * Public RPC method for listing variations (called by worker)
   */
  async __listVariations() {
    return this.#getPatternsList();
  }

  /**
   * Public RPC method for checking completion (called by worker)
   */
  async __checkCompletion(mode: string, index: number): Promise<boolean> {
    return this.#checkCompletion(mode, index);
  }

  /**
   * Get patterns list for discovery endpoint
   */
  #getPatternsList() {
    const variations = this.getVariations();
    return Array.from(variations.entries()).map(([mode, def]) => ({
      mode,
      name: def.name,
      description: def.description
    }));
  }

  /**
   * Check if a completion marker exists
   */
  #checkCompletion(mode: string, index: number): boolean {
    const completionKey = `__lmz_exp_completed_${mode}_${index}`;
    return this.ctx.storage.kv.get(completionKey) !== undefined;
  }

  /**
   * Handle WebSocket connection for batch execution
   */
  #handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Tag WebSocket for retrieval via this.ctx.getWebSockets('experiment')
    this.ctx.acceptWebSocket(server, ['experiment']);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle incoming WebSocket messages (Cloudflare DO lifecycle method)
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const msg = JSON.parse(message as string);

      if (msg.action === 'run-batch') {
        await this.#handleBatchRequest(ws, msg);
      }
    } catch (error) {
      this.#sendMessage(ws, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Handle WebSocket close (Cloudflare DO lifecycle method)
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // WebSocket cleanup handled automatically by runtime
  }

  /**
   * Handle WebSocket error (Cloudflare DO lifecycle method)
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // WebSocket cleanup handled automatically by runtime
  }

  /**
   * Handle batch execution request
   */
  async #handleBatchRequest(ws: WebSocket, msg: { mode: string; count: number }): Promise<void> {
    const { mode, count } = msg;

    // Clean up any stale completion markers from previous runs
    const prefix = `__lmz_exp_completed_${mode}_`;
    for (const [key] of this.ctx.storage.kv.list({ prefix })) {
      this.ctx.storage.kv.delete(key);
    }

    this.#sendMessage(ws, {
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

    // Check if this is an async pattern (returns void, not Promise)
    const variations = this.getVariations();
    const definition = variations.get(mode);
    
    if (!definition) {
      const available = Array.from(variations.keys()).join(', ');
      throw new Error(`Unknown mode: ${mode}. Available: ${available || 'none'}`);
    }

    const strategy = definition.strategy || 'sequential';

    // Signal timing start (client-side timing begins)
    this.#sendMessage(ws, {
      type: 'timing-start',
      mode
    });

    if (strategy === 'chained') {
      // Chained execution: call handler ONCE, it manages internal chaining
      // Handler is responsible for calling signalChainedComplete() or signalChainedError()
      try {
        await definition.handler(0, count);
        // Handler manages completion signaling
      } catch (error) {
        // Handler threw error during setup - send error immediately
        this.#sendMessage(ws, {
          type: 'error',
          error: `${mode}: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      // Note: batch-complete is sent by signalChainedComplete()
    } else {
      // Sequential: execute each operation sequentially
      for (let i = 0; i < count; i++) {
        try {
          await definition.handler(i);
          results.completed++;
          if (results.completed % 5 === 0) {
            this.#sendProgress(ws, mode, count, results.completed);
          }
        } catch (error) {
          results.errors++;
          results.errorMessages.push(`Op ${i}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // Signal timing end (client-side timing ends)
      this.#sendMessage(ws, {
        type: 'timing-end',
        mode
      });
      
      // Send batch complete (timing calculated client-side)
      this.#sendMessage(ws, {
        type: 'batch-complete',
        mode,
        completed: results.completed,
        errors: results.errors,
        errorMessages: results.errorMessages
      });
    }
  }

  /**
   * Send progress update
   */
  #sendProgress(ws: WebSocket, mode: string, total: number, completed: number): void {
    this.#sendMessage(ws, {
      type: 'progress',
      mode,
      total,
      completed
    });
  }

  /**
   * Signal error for chained execution
   * Called by chained handlers when an error occurs
   * Sends error message immediately to client
   * PUBLIC: Can be called via RPC from other DOs
   */
  signalChainedError(mode: string, errorMessage: string): void {
    console.log('[LumenizeExperimentDO] signalChainedError called:', { mode, errorMessage });
    
    // Get the WebSocket (assume single active batch)
    const ws = this.ctx.getWebSockets('experiment')[0];
    
    if (!ws) {
      console.warn('[LumenizeExperimentDO] No WebSocket to signal error');
      return;
    }
    
    // Send error immediately
    this.#sendMessage(ws, {
      type: 'error',
      error: `${mode}: ${errorMessage}`
    });
    
    console.log('[LumenizeExperimentDO] Error signaled');
  }

  /**
   * Signal completion for chained execution
   * Called by chained handlers when all operations complete
   * Sends timing-end and batch-complete messages
   * PUBLIC: Can be called via RPC from other DOs
   * 
   * @param mode - Pattern mode identifier
   * @param count - Number of operations completed
   */
  signalChainedComplete(mode: string, count: number): void {
    console.log('[LumenizeExperimentDO] signalChainedComplete called:', { mode, count });
    
    // Get the WebSocket (assume single active batch)
    const ws = this.ctx.getWebSockets('experiment')[0];
    
    console.log('[LumenizeExperimentDO] WebSocket check:', { 
      hasWebSocket: !!ws
    });
    
    if (!ws) {
      console.warn('[LumenizeExperimentDO] No WebSocket to signal chained completion');
      return;
    }
    
    console.log('[LumenizeExperimentDO] Sending timing-end');
    // Signal timing end
    this.#sendMessage(ws, {
      type: 'timing-end',
      mode
    });
    
    console.log('[LumenizeExperimentDO] Sending batch-complete');
    // Send batch complete
    this.#sendMessage(ws, {
      type: 'batch-complete',
      mode,
      completed: count, // All operations completed successfully
      errors: 0,
      errorMessages: []
    });
    
    console.log('[LumenizeExperimentDO] signalChainedComplete completed successfully');
  }

  /**
   * Send progress update for chained execution
   * Called by chained handlers to report progress
   * PUBLIC: Can be called via RPC from other DOs
   */
  signalChainedProgress(mode: string, total: number, completed: number): void {
    // Get the WebSocket (assume single active batch)
    const ws = this.ctx.getWebSockets('experiment')[0];
    
    if (!ws) {
      console.warn('No WebSocket to signal progress');
      return;
    }
    
    this.#sendProgress(ws, mode, total, completed);
  }

  /**
   * Send message over WebSocket
   */
  #sendMessage(ws: WebSocket, message: any): void {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending WebSocket message:', error);
    }
  }
}

