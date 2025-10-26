import type { 
  RpcTransport, 
  RpcBatchRequest,
  RpcBatchResponse,
  RpcWebSocketMessage,
  RpcWebSocketMessageResponse
} from './types';
import { deserializeError } from './error-serialization';
import { stringify, parse } from '@ungap/structured-clone/json';

/**
 * Pending batch tracking - maps batch ID to resolve/reject functions
 */
interface PendingBatch {
  resolve: (value: RpcBatchResponse) => void;
  reject: (error: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * WebSocket-based RPC transport with lazy connection and auto-reconnect.
 * Wraps/unwraps RpcBatchRequest with WebSocket message envelope (adds 'type' field).
 * Used internally by RpcClient - not intended for direct use.
 * @internal
 */
export class WebSocketRpcTransport implements RpcTransport {
  #config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceNameOrId: string;
    timeout: number;
    WebSocketClass?: typeof WebSocket;
  };
  #ws: WebSocket | null = null;
  #connectionPromise: Promise<void> | null = null;
  #pendingBatches: Map<string, PendingBatch> = new Map();
  #messageType: string; // e.g., '__rpc' (prefix with slashes removed)

  constructor(config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceNameOrId: string;
    timeout: number;
    WebSocketClass?: typeof WebSocket;
  }) {
    this.#config = config;
    // Extract message type from prefix (remove leading/trailing slashes)
    this.#messageType = config.prefix.replace(/^\/+|\/+$/g, '');
  }

  /**
   * Check if WebSocket is currently connected and ready
   */
  isConnected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Establish WebSocket connection (called lazily on first execute)
   */
  async connect(): Promise<void> {
    // If already connected, do nothing
    if (this.isConnected()) {
      return;
    }

    // If connection in progress, wait for it
    if (this.#connectionPromise) {
      return this.#connectionPromise;
    }

    // Start new connection
    this.#connectionPromise = this.#connectInternal();
    
    try {
      await this.#connectionPromise;
    } finally {
      this.#connectionPromise = null;
    }
  }

  /**
   * Internal connection logic
   */
  async #connectInternal(): Promise<void> {
    // Build WebSocket URL
    const wsUrl = this.#buildWebSocketUrl();

    // Get WebSocket class (injected or global)
    const WebSocketClass = this.#config.WebSocketClass || globalThis.WebSocket;
    if (!WebSocketClass) {
      throw new Error('WebSocket is not available. Please provide WebSocketClass in config.');
    }

    // Create WebSocket connection
    const ws = new WebSocketClass(wsUrl);
    this.#ws = ws;

    // Setup event handlers
    this.#setupEventHandlers(ws);

    // Wait for connection to open
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        resolve();
      };

      const onError = (event: Event) => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        reject(new Error('WebSocket connection failed'));
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  /**
   * Build WebSocket URL from config
   */
  #buildWebSocketUrl(): string {
    // Clean segments to avoid double slashes
    const cleanSegment = (segment: string): string => segment.replace(/^\/+|\/+$/g, '');
    
    const baseUrl = cleanSegment(this.#config.baseUrl);
    const prefix = cleanSegment(this.#config.prefix);
    const doBindingName = cleanSegment(this.#config.doBindingName);
    const doInstanceNameOrId = cleanSegment(this.#config.doInstanceNameOrId);
    
    const url = `${baseUrl}/${prefix}/${doBindingName}/${doInstanceNameOrId}/call`;
    return url;
  }

  /**
   * Setup WebSocket event handlers
   */
  #setupEventHandlers(ws: WebSocket): void {
    ws.addEventListener('message', (event) => {
      this.#handleMessage(event.data);
    });

    ws.addEventListener('error', (event) => {
      console.error('%o', {
        type: 'error',
        where: 'WebSocketRpcTransport',
        message: 'WebSocket error',
        event
      });
    });

    ws.addEventListener('close', (event) => {
      console.debug('%o', {
        type: 'debug',
        where: 'WebSocketRpcTransport',
        message: 'WebSocket closed',
        code: event.code,
        reason: event.reason
      });

      // Reject all pending batches
      for (const [batchId, pending] of this.#pendingBatches.entries()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('WebSocket connection closed'));
      }
      this.#pendingBatches.clear();
    });
  }

  /**
   * Handle incoming WebSocket message (always expects batch format wrapped in type envelope)
   */
  #handleMessage(data: string): void {
    try {
      // Parse the response using @ungap/structured-clone/json
      const messageResponse: RpcWebSocketMessageResponse = parse(data);

      // Verify type
      if (messageResponse.type !== this.#messageType) {
        console.warn('%o', {
          type: 'warn',
          where: 'WebSocketRpcTransport.handleMessage',
          message: 'Received message with unexpected type',
          expected: this.#messageType,
          actual: messageResponse.type
        });
        return;
      }

      // Find the pending batch using first response ID
      const firstResponseId = messageResponse.batch[0]?.id;
      if (!firstResponseId) {
        console.warn('Received empty batch response');
        return;
      }

      const pending = this.#pendingBatches.get(firstResponseId);
      
      if (!pending) {
        console.warn('Received response for unknown operation ID:', firstResponseId);
        return;
      }

      // Clear timeout and remove from pending
      clearTimeout(pending.timeoutId);
      this.#pendingBatches.delete(firstResponseId);

      // Resolve with the batch response (unwrapped from message envelope)
      pending.resolve({
        batch: messageResponse.batch
      });

    } catch (error) {
      console.error('%o', {
        type: 'error',
        where: 'WebSocketRpcTransport.handleMessage',
        message: 'Failed to parse WebSocket message',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Execute a batch of RPC operations.
   * Wraps the batch in a WebSocket message envelope with type field.
   */
  async execute(batch: RpcBatchRequest): Promise<RpcBatchResponse> {
    // Lazy connect (or reconnect if connection dropped)
    if (!this.isConnected()) {
      await this.connect();
    }

    // Extract first ID to use as batch tracking ID
    const firstId = batch.batch[0]?.id;
    if (!firstId) {
      throw new Error('Cannot execute empty batch');
    }

    // Create promise for response
    return new Promise<RpcBatchResponse>((resolve, reject) => {
      // Setup timeout
      const timeoutId = setTimeout(() => {
        this.#pendingBatches.delete(firstId);
        reject(new Error(`RPC batch timed out after ${this.#config.timeout}ms`));
      }, this.#config.timeout);

      // Track this pending batch using first ID
      this.#pendingBatches.set(firstId, { resolve, reject, timeoutId });

      try {
        // Wrap batch in WebSocket message envelope with type field
        // Preserve client-generated IDs
        const message: RpcWebSocketMessage = {
          type: this.#messageType,
          batch: batch.batch
        };

        const messageBody = stringify(message);
        this.#ws!.send(messageBody);

      } catch (error) {
        clearTimeout(timeoutId);
        this.#pendingBatches.delete(firstId);
        reject(error);
      }
    });
  }

  /**
   * Disconnect WebSocket and clean up (synchronous)
   */
  disconnect(): void {
    if (!this.#ws) {
      return;
    }

    // Close WebSocket
    const ws = this.#ws;
    this.#ws = null;

    // Close connection (if not already closing/closed)
    // Note: ws.close() is synchronous - just sends close frame
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'Normal closure');
    }

    // Reject all pending batches
    for (const [batchId, pending] of this.#pendingBatches.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('WebSocket disconnected'));
    }
    this.#pendingBatches.clear();
  }
}
