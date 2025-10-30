import type { 
  RpcTransport, 
  RpcBatchRequest,
  RpcBatchResponse,
  RpcWebSocketMessage,
  RpcWebSocketMessageResponse
} from './types';
import { deserializeError } from './error-serialization';
import { stringify, parse } from '@lumenize/structured-clone';

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
    clientId?: string;
  };
  #ws: WebSocket | null = null;
  #connectionPromise: Promise<void> | null = null;
  #pendingBatches: Map<string, PendingBatch> = new Map();
  #messageType: string; // e.g., '__rpc' (prefix with slashes removed)
  #messageHandler?: (data: string) => boolean | Promise<boolean>;
  #keepAliveEnabled: boolean = false;
  #reconnectTimeoutId?: ReturnType<typeof setTimeout>;
  #reconnectAttempts: number = 0;
  #heartbeatIntervalId?: ReturnType<typeof setInterval>;

  constructor(config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceNameOrId: string;
    timeout: number;
    WebSocketClass?: typeof WebSocket;
    clientId?: string;
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
   * Register a message handler to intercept incoming messages.
   * Handler returns true if message was handled, false to use default RPC logic.
   */
  setMessageHandler(handler: (data: string) => boolean | Promise<boolean>): void {
    this.#messageHandler = handler;
  }

  /**
   * Enable/disable keep-alive mode with auto-reconnect.
   * When enabled:
   * - Sends periodic ping messages to keep connection alive
   * - Automatically reconnects when connection drops
   * - Can reconnect hours/days later (browser tab sleep/wake)
   */
  setKeepAlive(enabled: boolean): void {
    this.#keepAliveEnabled = enabled;
    
    if (!enabled) {
      // Disable keep-alive: clear timers
      if (this.#reconnectTimeoutId) {
        clearTimeout(this.#reconnectTimeoutId);
        this.#reconnectTimeoutId = undefined;
      }
      if (this.#heartbeatIntervalId) {
        clearInterval(this.#heartbeatIntervalId);
        this.#heartbeatIntervalId = undefined;
      }
      this.#reconnectAttempts = 0;
    }
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
    // For Node.js 'ws' library, pass headers in options (second parameter can be options)
    // For browser WebSocket, second parameter is protocols (array), so this will be ignored
    const wsOptions = this.#config.clientId ? {
      headers: {
        'X-Client-Id': this.#config.clientId
      }
    } : undefined;
    
    const ws = wsOptions 
      ? new WebSocketClass(wsUrl, wsOptions as any)
      : new WebSocketClass(wsUrl);
    this.#ws = ws;

    // Setup event handlers
    this.#setupEventHandlers(ws);

    // Wait for connection to open
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        // Reset reconnect attempts on successful connection
        this.#reconnectAttempts = 0;
        
        // Start heartbeat if keep-alive is enabled
        if (this.#keepAliveEnabled) {
          this.#startHeartbeat();
        }
        
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
    
    let url = `${baseUrl}/${prefix}/${doBindingName}/${doInstanceNameOrId}/call`;
    
    // Add clientId as query parameter for browser WebSocket (which doesn't support custom headers)
    if (this.#config.clientId) {
      url += `?clientId=${encodeURIComponent(this.#config.clientId)}`;
    }
    
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

      // Stop heartbeat
      if (this.#heartbeatIntervalId) {
        clearInterval(this.#heartbeatIntervalId);
        this.#heartbeatIntervalId = undefined;
      }

      // Reject all pending batches
      for (const [batchId, pending] of this.#pendingBatches.entries()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('WebSocket connection closed'));
      }
      this.#pendingBatches.clear();

      // Schedule reconnect if keep-alive is enabled
      if (this.#keepAliveEnabled) {
        this.#scheduleReconnect();
      }
    });
  }

  /**
   * Start heartbeat interval to keep connection alive
   */
  #startHeartbeat(): void {
    // Clear any existing heartbeat
    if (this.#heartbeatIntervalId) {
      clearInterval(this.#heartbeatIntervalId);
    }

    // Send ping every 30 seconds
    this.#heartbeatIntervalId = setInterval(() => {
      if (this.isConnected()) {
        try {
          this.#ws?.send('ping');
        } catch (error) {
          console.error('%o', {
            type: 'error',
            where: 'WebSocketRpcTransport.startHeartbeat',
            message: 'Failed to send ping',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }, 30000); // 30 seconds
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  #scheduleReconnect(): void {
    // Clear any existing reconnect timeout
    if (this.#reconnectTimeoutId) {
      clearTimeout(this.#reconnectTimeoutId);
    }

    // Calculate delay with exponential backoff (max 30 seconds)
    const delay = Math.min(1000 * Math.pow(2, this.#reconnectAttempts), 30000);
    this.#reconnectAttempts++;

    console.debug('%o', {
      type: 'debug',
      where: 'WebSocketRpcTransport',
      message: 'Scheduling reconnect',
      delay,
      attempt: this.#reconnectAttempts
    });

    this.#reconnectTimeoutId = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('%o', {
          type: 'error',
          where: 'WebSocketRpcTransport.scheduleReconnect',
          message: 'Reconnection failed',
          error: error instanceof Error ? error.message : String(error)
        });
        // Will trigger another reconnect via close handler
      });
    }, delay);
  }

  /**
   * Handle incoming WebSocket message (RPC responses or downstream messages)
   */
  async #handleMessage(data: string): Promise<void> {
    try {
      // If message handler is registered, let it try to handle the message first
      if (this.#messageHandler) {
        const handled = await this.#messageHandler(data);
        if (handled) {
          return; // Message was handled by custom handler
        }
      }

      // Default RPC handling: Parse the response using @lumenize/structured-clone
      const messageResponse: RpcWebSocketMessageResponse = await parse(data);

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
    return new Promise<RpcBatchResponse>(async (resolve, reject) => {
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

        const messageBody = await stringify(message);
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
