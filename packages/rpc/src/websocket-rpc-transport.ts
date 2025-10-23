import type { 
  RpcTransport, 
  OperationChain, 
  RpcWebSocketBatchRequest,
  RpcWebSocketBatchResponse
} from './types';
import { deserializeError } from './error-serialization';
import { stringify, parse } from '@ungap/structured-clone/json';

/**
 * Pending operation tracking
 */
interface PendingOperation {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Queued execution waiting to be batched
 */
interface QueuedExecution {
  id: string;
  operations: OperationChain;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

/**
 * WebSocket-based RPC transport with lazy connection and auto-reconnect.
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
    WebSocketClass?: new (url: string, protocols?: string | string[]) => WebSocket;
  };
  #ws: WebSocket | null = null;
  #connectionPromise: Promise<void> | null = null;
  #pendingOperations: Map<string, PendingOperation> = new Map();
  #messageType: string; // e.g., '__rpc' (prefix with slashes removed)
  #nextId = 0;
  
  // Batching support for promise pipelining
  #executionQueue: QueuedExecution[] = [];
  #batchScheduled = false;

  constructor(config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceNameOrId: string;
    timeout: number;
    WebSocketClass?: new (url: string, protocols?: string | string[]) => WebSocket;
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

      // Reject all pending operations
      for (const [id, pending] of this.#pendingOperations.entries()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('WebSocket connection closed'));
      }
      this.#pendingOperations.clear();
    });
  }

  /**
   * Handle incoming WebSocket message (always expects batch format)
   */
  #handleMessage(data: string): void {
    try {
      // Parse the response using @ungap/structured-clone/json
      const batchResponse: RpcWebSocketBatchResponse = parse(data);

      // Verify type
      if (batchResponse.type !== this.#messageType) {
        console.warn('%o', {
          type: 'warn',
          where: 'WebSocketRpcTransport.handleMessage',
          message: 'Received message with unexpected type',
          expected: this.#messageType,
          actual: batchResponse.type
        });
        return;
      }

      // Process each response in the batch
      for (const response of batchResponse.batch) {
        this.#processResponse(response.id, response.success, response.result, response.error);
      }
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
   * Process a single response from the batch
   */
  #processResponse(id: string, success: boolean, result?: any, error?: any): void {
    // Find pending operation
    const pending = this.#pendingOperations.get(id);
    if (!pending) {
      console.warn('%o', {
        type: 'warn',
        where: 'WebSocketRpcTransport.processResponse',
        message: 'Received response for unknown operation',
        id
      });
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeoutId);
    this.#pendingOperations.delete(id);

    // Resolve or reject the promise
    if (success) {
      // Success response
      pending.resolve(result);
    } else {
      // Error response
      const deserializedError = deserializeError(error);
      pending.reject(deserializedError);
    }
  }

  /**
   * Execute RPC operation chain
   * Queues the operation and schedules a batch send in the next microtask
   */
  async execute(operations: OperationChain): Promise<any> {
    // Lazy connect (or reconnect if connection dropped)
    if (!this.isConnected()) {
      await this.connect();
    }

    // Generate unique message ID
    const id = `${Date.now()}-${this.#nextId++}`;

    // Create promise for response
    const resultPromise = new Promise<any>((resolve, reject) => {
      // Queue this execution for batching
      this.#executionQueue.push({
        id,
        operations,
        resolve,
        reject
      });

      // Schedule batch send if not already scheduled
      if (!this.#batchScheduled) {
        this.#batchScheduled = true;
        queueMicrotask(() => {
          this.#sendBatch();
        });
      }
    });

    return resultPromise;
  }

  /**
   * Send all queued executions as a batch (always uses batch format, even for single operations)
   */
  #sendBatch(): void {
    // Reset batch flag
    this.#batchScheduled = false;

    // Get all queued executions
    const queue = this.#executionQueue;
    this.#executionQueue = [];

    if (queue.length === 0) {
      return; // Nothing to send
    }

    try {
      // Setup timeouts and track all pending operations
      for (const { id, resolve, reject } of queue) {
        const timeoutId = setTimeout(() => {
          this.#pendingOperations.delete(id);
          reject(new Error(`RPC operation timed out after ${this.#config.timeout}ms`));
        }, this.#config.timeout);

        this.#pendingOperations.set(id, { resolve, reject, timeoutId });
      }

      // Always send as batch (even for single operations - simpler and more consistent)
      const batchRequest: RpcWebSocketBatchRequest = {
        type: this.#messageType,
        batch: queue.map(({ id, operations }) => ({ id, operations }))
      };

      const requestBody = stringify(batchRequest);
      this.#ws!.send(requestBody);

    } catch (error) {
      // On error, reject all queued operations
      for (const { id, reject } of queue) {
        const pending = this.#pendingOperations.get(id);
        if (pending) {
          clearTimeout(pending.timeoutId);
          this.#pendingOperations.delete(id);
        }
        reject(error);
      }
    }
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

    // Reject all pending operations
    for (const [id, pending] of this.#pendingOperations.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('WebSocket disconnected'));
    }
    this.#pendingOperations.clear();
  }
}
