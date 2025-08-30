import { PartySocket, PartySocketOptions } from "partysocket";
import { Validator } from '@cfworker/json-schema';
import {
  type InitializeResult,
  type ClientCapabilities,
  type Implementation,
  type ListToolsResult,
  type Tool,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type JSONRPCError,
  type JSONRPCNotification,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
} from "./schema/draft/schema";
import {
  type WebSocketRequestEnvelope,
  type WebSocketResponseEnvelope,
} from "./lumenize-server";

import { debugOn, debugOff } from "@transformation-dev/debug";  // NOSAR
// debugOn();  // NOSAR

interface LumenizeClientOptions extends Omit<PartySocketOptions, 'prefix' | 'url' | 'party' | 'room'> {
  galaxy?: string;  // The DO namespace (tied to Class name). Is converted to kebab-case to be URL-friendly, defaults to "lumenize"  // TODO: Set default and auto-kebab-case
  star: string;  // as in DO_NAMESPACE.idFromName(star)
  timeout?: number; // ms, default 5000
  route?: string; // envelope type, default "mcp"
  // Cloudflare's agents has onStateUpdate but Lumenize has a bigger concept of state, namely for each entity
  onEntityUpdate?: (updateMessage: any) => void; // TODO: Implement this. Define the updateMessage type when we do
  // MCP initialization options
  mcpVersion?: string; // Client's protocol version (default: "draft")
  capabilities?: ClientCapabilities;
  clientInfo?: Implementation;
}

export class LumenizeClient {
  readonly #partySocket: PartySocket;
  readonly #pending: Map<any, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>;
  readonly #timeout: number;
  readonly #route: string;
  readonly #mcpInitRequest: JSONRPCRequest;
  readonly #availableTools: Map<string, Tool> = new Map(); // Store tools with their schemas

  readonly #connectionReady: Promise<void>;
  #connectionReadyResolve: (() => void) | null = null;
  #connectionReadyReject: ((error: Error) => void) | null = null;
  
  #negotiatedVersion: string | undefined;
  #isInitialized: boolean = false; // Track if MCP initialization has completed

  constructor(opts: LumenizeClientOptions) {
    const clientVersion = opts.mcpVersion ?? LATEST_PROTOCOL_VERSION;
    
    // Generate a unique subscriber ID for this connection
    const subscriberId = crypto.randomUUID();
    
    // Create MCP initialization request as per MCP specification
    const mcpInitRequest: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: "init-" + crypto.randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: clientVersion,
        capabilities: opts.capabilities || {},
        clientInfo: opts.clientInfo || {
          name: "lumenize-client",
          version: "2.0.0"
        }
      }
    };

    let { mcpVersion, capabilities, clientInfo, timeout, route, onEntityUpdate, star, galaxy, ...remainingOpts } = opts;
    const socketOpts = { 
      ...remainingOpts, 
      prefix: 'universe', 
      party: galaxy ?? "milky-way", 
      room: star,
      query: { subscriberId }
    };

    this.#partySocket = new PartySocket(socketOpts as PartySocketOptions);
    
    // Store the initialization request to send immediately upon connection
    this.#mcpInitRequest = mcpInitRequest;
    
    this.#pending = new Map();
    this.#timeout = timeout ?? 5000;
    this.#route = route ?? "mcp";

    // Create a promise that resolves when MCP initialization completes
    this.#connectionReady = new Promise<void>((resolve, reject) => {
      this.#connectionReadyResolve = resolve;
      this.#connectionReadyReject = reject;
      
      // Add a timeout for connection handshake
      setTimeout(() => {
        if (this.#connectionReadyResolve) {
          this.#connectionReadyResolve = null;
          this.#connectionReadyReject = null;
          reject(new Error(`MCP initialization timed out after ${this.#timeout}ms`));
        }
      }, this.#timeout);
    });

    // Send MCP initialization immediately when connection opens
    this.#partySocket.onopen = () => {
      // Only send initialization if we haven't already completed it
      if (this.#isInitialized) {
        console.debug('%o', {
          type: 'debug',
          where: 'LumenizeClient.#client.onopen',
          message: 'WebSocket reconnected, but MCP already initialized - skipping init',
          route: this.#route,
          isInitialized: this.#isInitialized
        });
        return;
      }

      console.debug('%o', {
        type: 'debug',
        where: 'LumenizeClient.#client.onopen',
        message: 'WebSocket connection opened, sending MCP initialization',
        route: this.#route,
        isInitialized: this.#isInitialized,
        initId: this.#mcpInitRequest.id
      });
      const envelope: WebSocketRequestEnvelope = {
        type: this.#route,
        payload: this.#mcpInitRequest
      };
      this.#partySocket.send(JSON.stringify(envelope));
    };

    this.#partySocket.onmessage = (event: MessageEvent) => {
      this.#handleWebSocketMessage(event);
    };

    this.#partySocket.onclose = (event: CloseEvent) => {
      this.#handleWebSocketClose(event);
    };

    this.#partySocket.onerror = (event: Event) => {
      this.#handleWebSocketError(event);
    };

  }

  // Private method to handle incoming WebSocket messages
  #handleWebSocketMessage(event: MessageEvent): void {
    const msg = this.#parseWebSocketMessage(event);
    if (!msg) return;

    if (msg.type === this.#route && msg.payload && typeof msg.payload === "object") {
      const resp = msg.payload;
      
      // Handle MCP initialization response
      if (this.#isMcpInitializationResponse(resp)) {
        this.#handleMcpInitializationResponse(resp);
        return;
      }
      
      // Handle regular JSON-RPC responses
      this.#handleJsonRpcResponse(resp);
    }
  }

  // Parse and validate WebSocket message
  #parseWebSocketMessage(event: MessageEvent): WebSocketResponseEnvelope | null {
    try {
      return typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return null;
    }
  }

  // Handle WebSocket close events to fail fast
  #handleWebSocketClose(event: CloseEvent): void {
    console.debug('%o', {
      type: 'debug',
      where: 'LumenizeClient.#handleWebSocketClose',
      message: 'WebSocket connection closed',
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      isInitialized: this.#isInitialized
    });

    // If we haven't completed initialization yet, reject the connection promise to fail fast
    if (!this.#isInitialized) {
      const error = new Error(`WebSocket connection closed during initialization (code: ${event.code}, reason: ${event.reason || 'No reason provided'})`);
      this.#rejectConnectionReady(error, 'WebSocket closed during MCP initialization');
    }

    // Clear any pending requests since connection is closed
    for (const [id, { reject, timer }] of this.#pending) {
      clearTimeout(timer);
      reject(new Error(`Connection closed (code: ${event.code})`));
    }
    this.#pending.clear();
  }

  // Handle WebSocket error events to fail fast
  #handleWebSocketError(event: Event): void {
    console.error('%o', {
      type: 'error',
      where: 'LumenizeClient.#handleWebSocketError',
      message: 'WebSocket error occurred',
      isInitialized: this.#isInitialized
    });

    // If we haven't completed initialization yet, reject the connection promise to fail fast
    if (!this.#isInitialized) {
      const error = new Error('WebSocket error occurred during initialization');
      this.#rejectConnectionReady(error, 'WebSocket error during MCP initialization');
    }
  }

  // Check if response is an MCP initialization response
  #isMcpInitializationResponse(resp: JSONRPCResponse | JSONRPCError): boolean {
    const isInitResponse = resp.id === this.#mcpInitRequest.id && this.#connectionReadyResolve !== null;
    console.debug('%o', {
      type: 'debug',
      where: 'LumenizeClient.#isMcpInitializationResponse',
      message: 'Checking if response is MCP init response',
      responseId: resp.id,
      expectedId: this.#mcpInitRequest.id,
      hasConnectionResolver: this.#connectionReadyResolve !== null,
      isInitResponse
    });
    return isInitResponse;
  }

  // Handle MCP initialization response
  #handleMcpInitializationResponse(resp: JSONRPCResponse | JSONRPCError): void {
    // If already initialized, ignore duplicate responses
    if (this.#isInitialized) {
      console.debug('%o', {
        type: 'debug',
        where: 'LumenizeClient.#handleMcpInitializationResponse',
        message: 'Ignoring duplicate MCP initialization response - already initialized',
        responseId: resp.id,
        isInitialized: this.#isInitialized
      });
      return;
    }
    
    if ('result' in resp) {
      this.#handleSuccessfulMcpInitialization(resp);
    } else if ('error' in resp) {
      this.#handleFailedMcpInitialization(resp);
    }
  }

  // Handle successful MCP initialization
  #handleSuccessfulMcpInitialization(resp: JSONRPCResponse): void {
    const initResult = resp.result as InitializeResult;
    const clientVersion = this.#mcpInitRequest.params?.protocolVersion as string;
    const serverVersion = initResult.protocolVersion;
    
    console.debug('%o', {
      type: 'debug',
      where: 'LumenizeClient.#handleSuccessfulMcpInitialization',
      message: 'MCP initialization response received',
      clientVersion,
      serverVersion,
      result: resp.result
    });

    // Protocol version handling as per MCP specification
    if (clientVersion === serverVersion) {
      this.#completeSuccessfulInitialization(serverVersion);
    } else {
      this.#handleVersionMismatch(clientVersion, serverVersion);
    }
  }

  // Complete successful initialization process
  #completeSuccessfulInitialization(serverVersion: string): void {
    // Mark as initialized immediately to prevent duplicate initialization attempts
    this.#isInitialized = true;
    
    // Version match - proceed with initialization
    this.#negotiatedVersion = serverVersion;
    
    // Send notifications/initialized as required by MCP
    const notification: JSONRPCNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: "notifications/initialized"
    };
    const envelope: WebSocketRequestEnvelope = {
      type: this.#route,
      payload: notification
    };
    this.#partySocket.send(JSON.stringify(envelope));

    // Now fetch tools/list to get available tools and their schemas
    this.#fetchToolsList()
      .then(() => {
        this.#resolveConnectionReady();
      })
      .catch((error: Error) => this.#rejectConnectionReady(error, 'Failed to fetch tools list'));
  }

  // Handle version mismatch during initialization
  #handleVersionMismatch(clientVersion: string, serverVersion: string): void {
    const error = new Error(`Protocol version mismatch: client requested '${clientVersion}', server provided '${serverVersion}'`);
    console.error('%o', {
      type: 'error',
      where: 'LumenizeClient.#handleVersionMismatch',
      message: 'Protocol version negotiation failed - disconnecting',
      clientRequested: clientVersion,
      serverProvided: serverVersion,
      error: error.message
    });
    
    this.#rejectConnectionReady(error);
    // Disconnect as recommended by MCP spec
    this.#partySocket.close();
  }

  // Handle failed MCP initialization
  #handleFailedMcpInitialization(resp: JSONRPCError): void {
    const error = new Error(`MCP initialization failed: ${resp.error.message}`);
    console.error('%o', {
      type: 'error',
      where: 'LumenizeClient.#handleFailedMcpInitialization',
      message: 'MCP initialization failed with server error',
      error: resp.error
    });
    
    this.#rejectConnectionReady(error);
  }

  // Handle regular JSON-RPC responses for pending requests
  #handleJsonRpcResponse(resp: JSONRPCResponse | JSONRPCError): void {
    if (resp.id !== undefined && this.#pending.has(resp.id)) {
      const { resolve, reject, timer } = this.#pending.get(resp.id)!;
      clearTimeout(timer); // Always clear the timeout immediately
      this.#pending.delete(resp.id);
      
      if ("error" in resp) {
        reject(Object.assign(new Error(resp.error.message), { 
          code: resp.error.code, 
          data: resp.error.data 
        }));
      } else if ("result" in resp) {
        resolve(resp.result);
      } else {
        reject(Object.assign(new Error("Malformed JSON-RPC response"), { 
          code: "EMALFORMED" 
        }));
      }
    }
  }

  // Helper to resolve connection ready promise
  #resolveConnectionReady(): void {
    if (this.#connectionReadyResolve) {
      this.#connectionReadyResolve();
      this.#connectionReadyResolve = null;
      this.#connectionReadyReject = null;
    }
  }

  // Helper to reject connection ready promise
  #rejectConnectionReady(error: Error, context?: string): void {
    if (context) {
      console.error('%o', {
        type: 'error',
        where: 'LumenizeClient.#rejectConnectionReady',
        message: context,
        error: error.message
      });
    }
    
    if (this.#connectionReadyReject) {
      this.#connectionReadyReject(error);
      this.#connectionReadyResolve = null;
      this.#connectionReadyReject = null;
    }
  }

  async callMethod(method: string, params?: { [key: string]: unknown }): Promise<any> {
    // Wait for connection to be ready before sending any messages
    await this.#connectionReady;
    
    const id = crypto.randomUUID();
    const timeout = this.#timeout;
    const req: JSONRPCRequest = {
      jsonrpc: JSONRPC_VERSION,
      method,
      ...(params !== undefined ? { params } : {}),
      id
    };
    const envelope: WebSocketRequestEnvelope = {
      type: this.#route,
      payload: req
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(Object.assign(new Error(`JSON-RPC call to '${method}' timed out after ${timeout}ms`), { code: "ETIMEDOUT" }));
      }, timeout);

      this.#pending.set(id, { resolve, reject, timer });

      // Send as JSON string for compatibility
      this.#partySocket.send(JSON.stringify(envelope));
    });
  }

  async callTool(toolName: string, arguments_?: { [key: string]: unknown }): Promise<any> {
    console.debug('%o', {
      type: 'debug',
      where: 'LumenizeClient.callTool',
      message: `Calling tool: ${toolName} with arguments`,
      arguments: arguments_
    });
    const mcpResult = await this.callMethod("tools/call", {
      name: toolName,
      arguments: arguments_
    });

    // Only handle MCP CallToolResult format with structured content
    if (!mcpResult || typeof mcpResult !== 'object') {
      throw new Error('Invalid response format: must be MCP CallToolResult');
    }

    if (mcpResult.isError) {
      // Error should have structured content with error information
      if (!mcpResult.structuredContent) {
        throw new Error('Error response must include structuredContent field');
      }
      const errorMessage = mcpResult.structuredContent.message ?? 'Tool execution failed';
      throw new Error(errorMessage);
    }
    
    // Expect structured content in the structuredContent field (draft protocol)
    if (!mcpResult.structuredContent) {
      throw new Error('Tool response must include structuredContent field in draft protocol');
    }

    // Return the structured data exactly as specified by the tool's outputSchema
    const result = mcpResult.structuredContent;
    
    // Return the result exactly as specified by the tool's outputSchema (no transformation)
    return this.#validateToolResult(toolName, result);
  }

  // TODO: remove this once we figure out how to expose additional PartySocket functionality like fetch
  get partySocket() {
    return this.#partySocket;
  }

  // Wait for connection to be ready
  waitForConnection(): Promise<void> {
    return this.#connectionReady;
  }

  // Check if connection is ready (non-blocking)
  get isConnectionReady(): boolean {
    return this.#isInitialized && this.#connectionReadyResolve === null;
  }

  // Get the negotiated protocol version after successful initialization
  get protocolVersion(): string | undefined {
    return this.#negotiatedVersion;
  }

  // Optionally expose close method
  close() {
    // Reset initialization state to allow reconnection
    this.#isInitialized = false;
    this.#negotiatedVersion = undefined;
    this.#availableTools.clear();
    
    // Reject any pending connection promise
    if (this.#connectionReadyReject) {
      this.#connectionReadyReject(new Error('Connection closed'));
      this.#connectionReadyResolve = null;
      this.#connectionReadyReject = null;
    }
    
    // Clear any pending requests
    for (const [id, { reject, timer }] of this.#pending) {
      clearTimeout(timer);
      reject(new Error('Connection closed'));
    }
    this.#pending.clear();
    
    this.#partySocket.close();
  }

  // Private method to fetch tools list after initialization
  async #fetchToolsList(): Promise<void> {
    try {
      // Manually create a request to avoid the connection check in callMethod
      const id = crypto.randomUUID();
      const req: JSONRPCRequest = {
        jsonrpc: JSONRPC_VERSION,
        method: "tools/list",
        id
      };
      const envelope = {
        type: this.#route,
        payload: req
      };

      const response = await new Promise<ListToolsResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`tools/list call timed out after ${this.#timeout}ms`));
        }, this.#timeout);

        this.#pending.set(id, { 
          resolve: (result: any) => resolve(result as ListToolsResult), 
          reject, 
          timer 
        });

        this.#partySocket.send(JSON.stringify(envelope));
      });

      // Store the tools with their schemas
      this.#availableTools.clear();
      if (response.tools) {
        for (const tool of response.tools) {
          this.#availableTools.set(tool.name, tool);
        }
      }

      console.debug('%o', {
        type: 'debug',
        where: 'LumenizeClient.#fetchToolsList',
        message: 'Successfully fetched tools list',
        toolCount: this.#availableTools.size,
        tools: Array.from(this.#availableTools.keys())
      });
    } catch (error) {
      console.error('%o', {
        type: 'error',
        where: 'LumenizeClient.#fetchToolsList',
        message: 'Failed to fetch tools list',
        error: error instanceof Error ? error.message : error
      });
      throw error;
    }
  }

  // Validate tool result against outputSchema using @cfworker/json-schema
  #validateToolResult(toolName: string, result: any): any {
    const tool = this.#availableTools.get(toolName);
    if (!tool?.outputSchema) {
      // If no schema available, return result as-is
      console.debug('%o', {
        type: 'debug',
        where: 'LumenizeClient.#validateToolResult',
        message: 'No output schema available - returning result unchanged',
        toolName,
        hasSchema: false
      });
      return result;
    }

    // Validate result against outputSchema using @cfworker/json-schema
    try {
      const validator = new Validator(tool.outputSchema, '2020-12', false);
      const validationResult = validator.validate(result);
      
      if (!validationResult.valid) {
        // Collect all validation errors into a readable message
        const errors = validationResult.errors.map(error => {
          return error.error ?? 'Validation failed';
        }).join('; ');
        
        throw new Error(`Tool "${toolName}" response does not match the tool's output schema: ${errors}`);
      }

      console.debug('%o', {
        type: 'debug',
        where: 'LumenizeClient.#validateToolResult',
        message: 'Tool result validation passed - returning validated result',
        toolName,
        hasSchema: true
      });

      return result;
    } catch (error) {
      console.warn('%o', {
        type: 'warning',
        where: 'LumenizeClient.#validateToolResult',
        message: 'Tool result validation failed',
        toolName,
        error: error instanceof Error ? error.message : error
      });
      // Re-throw validation errors to preserve error type
      throw error;
    }
  }
}
