import type { RpcTransport, OperationChain, RpcResponse } from './types';
import { deserializeError } from './error-serialization';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stringify, parse } = require('@ungap/structured-clone/json');

/**
 * RPC message envelope sent from client to server.
 * The entire request object (including the operations array) is encoded using
 * @ungap/structured-clone/json stringify() before transmission.
 */
interface RpcWebSocketRequest {
  id: string;
  type: string; // Derived from prefix, e.g., '__rpc'
  operations: OperationChain;
}

/**
 * RPC response envelope sent from server to client.
 * The entire response object (including result) will be encoded using
 * @ungap/structured-clone/json stringify() before transmission.
 */
interface RpcWebSocketResponse {
  id: string;
  type: string; // Derived from prefix, e.g., '__rpc'
  success: boolean;
  result?: any;
  error?: any;
}

/**
 * Pending operation tracking
 */
interface PendingOperation {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
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
    WebSocketClass?: typeof WebSocket;
  };
  #ws: WebSocket | null = null;
  #connectionPromise: Promise<void> | null = null;
  #pendingOperations: Map<string, PendingOperation> = new Map();
  #messageType: string; // e.g., '__rpc' (prefix with slashes removed)
  #nextId = 0;

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

      // Reject all pending operations
      for (const [id, pending] of this.#pendingOperations.entries()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('WebSocket connection closed'));
      }
      this.#pendingOperations.clear();
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  #handleMessage(data: string | ArrayBuffer | Blob): void {
    // Only handle string messages for now
    if (typeof data !== 'string') {
      console.warn('%o', {
        type: 'warn',
        where: 'WebSocketRpcTransport.handleMessage',
        message: 'Received non-string message, ignoring',
        dataType: typeof data
      });
      return;
    }

    try {
      console.log('Client received raw data:', data);
      
      // Parse the entire response using @ungap/structured-clone/json
      const response: RpcWebSocketResponse = parse(data);

      console.log('Client parsed response:', response);
      console.log('Client response.result:', response.result);
      console.log('Client response.result instanceof Date:', response.result instanceof Date);

      // Verify this is an RPC response
      if (response.type !== this.#messageType) {
        console.warn('%o', {
          type: 'warn',
          where: 'WebSocketRpcTransport.handleMessage',
          message: 'Received message with unexpected type',
          expected: this.#messageType,
          actual: response.type
        });
        return;
      }

      // Find pending operation
      const pending = this.#pendingOperations.get(response.id);
      if (!pending) {
        console.warn('%o', {
          type: 'warn',
          where: 'WebSocketRpcTransport.handleMessage',
          message: 'Received response for unknown operation',
          id: response.id
        });
        return;
      }

      // Remove from pending
      this.#pendingOperations.delete(response.id);
      clearTimeout(pending.timeoutId);

      // Handle response
      if (response.success) {
        // Result is already deserialized by parse()
        pending.resolve(response.result);
      } else {
        // Reconstruct error
        const error = deserializeError(response.error);
        pending.reject(error);
      }
    } catch (error) {
      console.error('%o', {
        type: 'error',
        where: 'WebSocketRpcTransport.handleMessage',
        message: 'Failed to handle message',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Execute RPC operation chain
   */
  async execute(operations: OperationChain): Promise<any> {
    // Lazy connect (or reconnect if connection dropped)
    if (!this.isConnected()) {
      await this.connect();
    }

    // Generate unique message ID
    const id = `${Date.now()}-${this.#nextId++}`;

    // Create request message
    const request: RpcWebSocketRequest = {
      id,
      type: this.#messageType,
      operations
    };

    // Create promise for response
    const resultPromise = new Promise<any>((resolve, reject) => {
      // Setup timeout
      const timeoutId = setTimeout(() => {
        this.#pendingOperations.delete(id);
        reject(new Error(`RPC operation timed out after ${this.#config.timeout}ms`));
      }, this.#config.timeout);

      // Track pending operation
      this.#pendingOperations.set(id, {
        resolve,
        reject,
        timeoutId
      });
    });

    // Send request - use stringify on the entire request
    try {
      this.#ws!.send(stringify(request));
    } catch (error) {
      // Remove pending operation and reject
      const pending = this.#pendingOperations.get(id);
      if (pending) {
        this.#pendingOperations.delete(id);
        clearTimeout(pending.timeoutId);
      }
      throw error;
    }

    return resultPromise;
  }

  /**
   * Disconnect WebSocket and clean up
   */
  async disconnect(): Promise<void> {
    if (!this.#ws) {
      return;
    }

    // Close WebSocket
    const ws = this.#ws;
    this.#ws = null;

    // Close connection (if not already closing/closed)
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
