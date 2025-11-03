import type { 
  RpcTransport, 
  RpcBatchRequest,
  RpcBatchResponse,
  RpcWebSocketMessage,
  RpcWebSocketMessageResponse
} from './types';
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
    additionalProtocols?: string[];
    onClose?: (code: number, reason: string) => void | Promise<void>;
    onConnectionChange?: (connected: boolean) => void | Promise<void>;
  };
  #ws: WebSocket | null = null;
  #connectionPromise: Promise<void> | null = null;
  #pendingBatches: Map<string, PendingBatch> = new Map();
  #messageType: string; // e.g., '__rpc' (prefix with slashes removed)
  #downstreamHandler?: (payload: any) => void | Promise<void>;
  #keepAliveEnabled: boolean = false;
  #reconnectTimeoutId?: ReturnType<typeof setTimeout>;
  #reconnectAttempts: number = 0;

  constructor(config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceNameOrId: string;
    timeout: number;
    WebSocketClass?: typeof WebSocket;
    clientId?: string;
    additionalProtocols?: string[];
    onDownstream?: (payload: any) => void | Promise<void>;
    onClose?: (code: number, reason: string) => void | Promise<void>;
    onConnectionChange?: (connected: boolean) => void | Promise<void>;
  }) {
    this.#config = config;
    // Extract message type from prefix (remove leading/trailing slashes)
    this.#messageType = config.prefix.replace(/^\/+|\/+$/g, '');
    
    // If onDownstream handler provided, register it
    if (config.onDownstream) {
      this.setDownstreamHandler(config.onDownstream);
    }
  }

  /**
   * Check if WebSocket is currently connected and ready
   */
  isConnected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Register a handler for downstream messages.
   * Handler is called with the deserialized payload for messages with type '__downstream'.
   */
  setDownstreamHandler(handler: (payload: any) => void | Promise<void>): void {
    this.#downstreamHandler = handler;
  }

  /**
   * Enable/disable keep-alive mode with auto-reconnect.
   * When enabled:
   * - Automatically reconnects when connection drops
   * - Can reconnect hours/days later (browser tab sleep/wake)
   * 
   * Note: Does NOT send periodic pings to allow DO hibernation.
   * If the connection is idle, the DO can hibernate to save resources.
   */
  setKeepAlive(enabled: boolean): void {
    this.#keepAliveEnabled = enabled;
    
    if (!enabled) {
      // Disable keep-alive: clear reconnect timer
      if (this.#reconnectTimeoutId) {
        clearTimeout(this.#reconnectTimeoutId);
        this.#reconnectTimeoutId = undefined;
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

    // Create WebSocket connection with protocols for clientId smuggling
    // Use protocols array to securely pass clientId without logging it in URLs
    // Format: ['lumenize.rpc', 'lumenize.rpc.clientId.${clientId}']
    // Server will respond with 'lumenize.rpc' and pluck out the clientId for tagging
    const protocols = this.#config.clientId
      ? ['lumenize.rpc', `lumenize.rpc.clientId.${this.#config.clientId}`]
      : ['lumenize.rpc'];
    
    // Append additional protocols if provided (e.g., for authentication tokens)
    if (this.#config.additionalProtocols) {
      protocols.push(...this.#config.additionalProtocols);
    }
    
    const ws = new WebSocketClass(wsUrl, protocols);
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
        
        // Notify connection change
        if (this.#config.onConnectionChange) {
          try {
            this.#config.onConnectionChange(true);
          } catch (error) {
            console.error('%o', {
              type: 'error',
              where: 'WebSocketRpcTransport.onOpen',
              message: 'Error in onConnectionChange handler',
              error: error instanceof Error ? error.message : String(error)
            });
          }
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

      // Call user's onClose handler if provided
      if (this.#config.onClose) {
        try {
          this.#config.onClose(event.code, event.reason);
        } catch (error) {
          console.error('%o', {
            type: 'error',
            where: 'WebSocketRpcTransport.closeHandler',
            message: 'Error in onClose handler',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Notify connection change
      if (this.#config.onConnectionChange) {
        try {
          this.#config.onConnectionChange(false);
        } catch (error) {
          console.error('%o', {
            type: 'error',
            where: 'WebSocketRpcTransport.closeHandler',
            message: 'Error in onConnectionChange handler',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Schedule reconnect if keep-alive is enabled
      if (this.#keepAliveEnabled) {
        this.#scheduleReconnect();
      }
    });
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
      // Parse the message using @lumenize/structured-clone
      const message = await parse(data);

      // Route based on message type
      if (message.type === '__downstream') {
        // Downstream message - call user's handler if registered
        if (this.#downstreamHandler) {
          await this.#downstreamHandler(message.payload);
        } else {
          console.warn('%o', {
            type: 'warn',
            where: 'WebSocketRpcTransport.handleMessage',
            message: 'Received downstream message but no handler registered'
          });
        }
        return;
      }

      if (message.type === this.#messageType) {
        // RPC response - handle normally
        const messageResponse = message as RpcWebSocketMessageResponse;

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
        return;
      }

      // Unknown message type - throw error
      throw new Error(`Unknown message type: ${message.type}. Expected '${this.#messageType}' or '__downstream'`);

    } catch (error) {
      console.error('%o', {
        type: 'error',
        where: 'WebSocketRpcTransport.handleMessage',
        message: 'Failed to parse or handle WebSocket message',
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
