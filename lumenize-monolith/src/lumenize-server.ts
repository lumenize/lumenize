import { Server, WSMessage, ConnectionContext, Connection } from 'partyserver';
import { randomUUID } from 'crypto';
import {
  type Request as JSONRPCRequest,
  type Response as JSONRPCResponse,
  type Notification as JSONRPCNotification,
  JSONRPCError,
  JSONRPCValidationError,
  createSuccessResponse,
  createErrorResponse,
  ErrorCode,
  validateRequest,
  validateNotification,
} from './mcp-validation';
import { Entities } from './entities';
import { ToolRegistry, Tool } from './tool-registry';
import { WebSocketNotificationService } from './notification-service';
import { EntityUriRouter, UriTemplateType } from './entity-uri-router';
import { 
  EntityTypeAlreadyExistsError, 
  ParameterValidationError, 
  ToolNotFoundError, 
  ToolExecutionError,
  EntityNotFoundError,
  EntityDeletedError
} from './errors';
import { 
  ListToolsRequest,
  ListToolsResult,
  CallToolRequest,
  CallToolResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ReadResourceRequest,
  ServerCapabilities,
  Implementation,
  LATEST_PROTOCOL_VERSION,
} from './schema/draft/schema';

import { debugOff, debugOn } from "@transformation-dev/debug";  // NOSAR
debugOff();

/**
 * WebSocket request envelope for wrapping MCP requests/notifications
 * Note: Batch processing is not supported, only single requests/notifications
 */
export interface WebSocketRequestEnvelope {
  /** Envelope type, typically 'mcp' for MCP protocol messages */
  type: string;
  /** The MCP request or notification (no batch support) */
  payload: JSONRPCRequest | JSONRPCNotification;
  /** Allow additional envelope properties */
  [key: string]: any;
}

/**
 * WebSocket response envelope for wrapping MCP responses
 * Note: Batch processing is not supported, only single responses
 */
export interface WebSocketResponseEnvelope {
  /** Envelope type, typically 'mcp' for MCP protocol messages */
  type: string;
  /** The MCP response or error (no batch support) */
  payload: JSONRPCResponse | JSONRPCError;
  /** Allow additional envelope properties */
  [key: string]: any;
}

/**
 * Type guard to check if a message is a WebSocket request envelope
 */
export function isWebSocketRequestEnvelope(obj: any): obj is WebSocketRequestEnvelope {
  return typeof obj === 'object' && 
         obj !== null && 
         typeof obj.type === 'string' && 
         obj.payload !== undefined;
}
  
export class Lumenize extends Server<Env> {
  static readonly options = {
    hibernate: true
  };
  
  readonly #uriRouter = new EntityUriRouter();
  readonly #notificationService = new WebSocketNotificationService(this, this.ctx.storage, this.#uriRouter);
  readonly #entities = new Entities(this.ctx.storage, this.#notificationService, this.#uriRouter);
  readonly #tools = new ToolRegistry();
  readonly #protocolVersion = LATEST_PROTOCOL_VERSION;

  // Timeout constants
  private static readonly INITIALIZATION_TIMEOUT_MS = 10000; // 10 seconds

  // Server capabilities - can be configured as needed
  readonly #serverCapabilities: ServerCapabilities = {
    tools: {
      // listChanged: true
    },
    resources: {
      subscribe: true,
      // listChanged: true
    },
    logging: {}
  };

  // Server information
  readonly #serverInfo: Implementation = {
    name: "lumenize",
    version: "2.0.0"
  };

  // Protected method to allow subclasses to access tools registry
  protected get tools(): ToolRegistry {
    return this.#tools;
  }

  // onStart is called when Lumenize is instantiated. Think of this as the constructor.
  onStart() {
    // debugOn();
    
    // Add entity type management tool
    this.#tools.add(this.#entities.getAddEntityTypeTool());
    
    // Add entity upsert tool
    this.#tools.add(this.#entities.getUpsertEntityTool());
    
    // Add entity delete tools
    this.#tools.add(this.#entities.getDeleteEntityTool());
    this.#tools.add(this.#entities.getUndeleteEntityTool());
    
    console.debug('%o', {
      type: 'debug',
      where: 'Lumenize.onStart',
      message: 'Lumenize MCP server started',
      protocolVersion: this.#protocolVersion,
      serverInfo: this.#serverInfo,
      capabilities: this.#serverCapabilities
    });

  }

  /**
   * Handle MCP initialization requests
   */
  #handleInitialize(request: JSONRPCRequest, connection?: Connection): any {
    const params = request.params as any;
    const requestedVersion = params?.protocolVersion;
    
    // Protocol version is required per MCP specification
    if (!requestedVersion) {
      throw new JSONRPCValidationError(
        ErrorCode.InvalidParams,
        'protocolVersion parameter is required for initialize method',
        {
          supported: [LATEST_PROTOCOL_VERSION]
        }
      );
    }
    
    // Only support the draft version
    if (requestedVersion !== LATEST_PROTOCOL_VERSION) {
      console.warn('%o', {
        type: 'warning',
        where: 'Lumenize.#handleInitialize',
        message: 'Version mismatch - will close connection after response',
        requested: requestedVersion,
        supported: [LATEST_PROTOCOL_VERSION]
      });
      
      // Schedule connection close after response is sent
      if (connection) {
        setTimeout(() => {  // TODO: This feels like a hack to me
          connection.close(1002, `Protocol version mismatch: ${requestedVersion}`);
        }, 100); // Small delay to ensure response is sent first
      }
      
      throw new JSONRPCValidationError(
        ErrorCode.InvalidParams,
        `Unsupported protocol version: ${requestedVersion}. Only ${LATEST_PROTOCOL_VERSION} is supported.`,
        {
          supported: [LATEST_PROTOCOL_VERSION],
          requested: requestedVersion
        }
      );
    }
    
    // Store client capabilities and info
    console.debug('%o', {
      type: 'debug',
      where: 'Lumenize.#handleInitialize',
      message: 'MCP initialize request received',
      protocolVersion: params?.protocolVersion,
      clientInfo: params?.clientInfo,
      capabilities: params?.capabilities
    });
    
    // Mark initialization received but NOT completed yet (waiting for notifications/initialized)
    if (connection) {
      const attachment = connection.deserializeAttachment();
      if (attachment?.initializationState) {
        attachment.initializationState.initializeReceivedAt = new Date().toISOString();
        connection.serializeAttachment(attachment);
      }
    }
    
    return {
      protocolVersion: LATEST_PROTOCOL_VERSION, // Always return the draft version
      capabilities: this.#serverCapabilities,
      serverInfo: this.#serverInfo
    };
  }

  /**
   * Schedule a timeout to close connections that don't complete MCP initialization
   */
  #scheduleInitializationTimeout(connection: Connection): void {
    const timeoutId = setTimeout(() => {
      const attachment = connection.deserializeAttachment();
      
      // Check if still not initialized
      if (attachment?.initializationState && !attachment.initializationState.mcpInitialized) {
        console.warn('%o', {
          type: 'warning',
          where: 'Lumenize.#scheduleInitializationTimeout',
          message: 'Closing connection due to initialization timeout',
          sessionId: attachment.sessionData?.sessionId,
          timeoutMs: Lumenize.INITIALIZATION_TIMEOUT_MS
        });

        // Send error before closing
        const errorResponse = {
          type: 'mcp',
          payload: {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: 1008,
              message: `MCP initialization timeout after ${Lumenize.INITIALIZATION_TIMEOUT_MS}ms`
            }
          }
        };
        
        connection.send(JSON.stringify(errorResponse));
        connection.close(1008, 'MCP initialization timeout');
      }
    }, Lumenize.INITIALIZATION_TIMEOUT_MS);

    // Store timeout ID in attachment so we can clear it if needed
    const attachment = connection.deserializeAttachment();
    if (attachment?.initializationState) {
      attachment.initializationState.initializationTimeoutId = timeoutId;
      connection.serializeAttachment(attachment);
    }
  }

  /**
   * Clear the initialization timeout when initialization completes
   */
  #clearInitializationTimeout(connection: Connection): void {
    const attachment = connection.deserializeAttachment();
    if (attachment?.initializationState?.initializationTimeoutId) {
      clearTimeout(attachment.initializationState.initializationTimeoutId);
      attachment.initializationState.initializationTimeoutId = null;
      connection.serializeAttachment(attachment);
    }
  }

  /**
   * Check if a connection is fully initialized
   */
  #isConnectionInitialized(connection: Connection): boolean {
    const attachment = connection.deserializeAttachment();
    return attachment?.initializationState?.mcpInitialized === true;
  }

  /**
   * Validate that a connection is initialized before processing requests
   */
  #validateConnectionInitialized(connection: Connection, request: JSONRPCRequest): void {
    // Skip validation for initialize method
    if (request.method === 'initialize') {
      return;
    }

    if (!this.#isConnectionInitialized(connection)) {
      throw new JSONRPCValidationError(
        ErrorCode.InvalidRequest,
        'Connection not initialized. Call initialize method first.'
      );
    }
  }

  /**
   * Handle listing tools
   */
  #handleListTools(request: JSONRPCRequest): ListToolsResult {
    // Validate request parameters if present (ListToolsRequest supports pagination)
    const params = request.params as ListToolsRequest['params'] | undefined;
    
    // For now, we don't implement pagination, but we could validate cursor if provided
    if (params?.cursor) {
      console.warn('%o', {
        type: 'debug',
        where: 'Lumenize.#handleListTools',
        message: 'Pagination cursor provided but not implemented',
        cursor: params.cursor
      });
    }
    
    const result = this.#tools.listToolsForMCP();
    
    return result;
  }

  /**
   * Handle calling a tool
   */
  #handleCallTool(request: JSONRPCRequest, connection?: Connection): CallToolResult {
    // Use proper typing for CallToolRequest params
    const params = request.params as CallToolRequest['params'];
    const { name, arguments: args } = params;

    // Validate required name parameter
    if (!name || typeof name !== 'string') {
      throw new ParameterValidationError('Tool name is required and must be a string');
    }

    // Let all tool execution errors bubble up to be handled centrally
    const result = this.#tools.execute(name, args);
    
    // Return structured content directly in the structuredContent field
    return {
      content: [], // Empty content array since we're using structuredContent
      structuredContent: result // The actual structured data matching outputSchema
    };
  }

  #handleListResourceTemplates(request: JSONRPCRequest): ListResourceTemplatesResult {
    const params = request.params as ListResourceTemplatesRequest['params'] | undefined;
    return this.#entities.getResourceTemplates(params?.cursor);
  }

  /**
   * Extract session ID from connection attachment
   */
  #getSessionIdFromConnection(connection: Connection): string | null {
    const attachment = connection.deserializeAttachment();
    return attachment?.sessionData?.sessionId || null;
  }

  /**
   * Extract subscriber ID from connection attachment
   */
  #getSubscriberIdFromConnection(connection: Connection): string | null {
    const attachment = connection.deserializeAttachment();
    return attachment?.subscriberId || null;
  }

  /**
   * Centralized error mapping to JSON-RPC error responses
   */
  #mapErrorToResponse(requestId: any, error: unknown): JSONRPCError {
    // Handle JSON-RPC validation errors (already properly formatted)
    if (error instanceof JSONRPCValidationError) {
      return createErrorResponse(requestId, error.code, error.message, error.data);
    }
    
    // Map domain-specific errors to appropriate JSON-RPC error codes
    if (error instanceof ParameterValidationError) {
      return createErrorResponse(requestId, ErrorCode.InvalidParams, error.message);
    }
    
    if (error instanceof EntityNotFoundError || error instanceof EntityDeletedError) {
      return createErrorResponse(requestId, ErrorCode.InvalidParams, error.message);
    }
    
    if (error instanceof ToolNotFoundError) {
      return createErrorResponse(requestId, ErrorCode.MethodNotFound, error.message);
    }
    
    if (error instanceof EntityTypeAlreadyExistsError || error instanceof ToolExecutionError) {
      return createErrorResponse(requestId, ErrorCode.InternalError, error.message);
    }
    
    // Fallback for unknown errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createErrorResponse(requestId, ErrorCode.InternalError, errorMessage);
  }

  /**
   * Handle resources/subscribe requests
   */
  #handleResourceSubscribe(request: JSONRPCRequest, connection?: Connection): any {
    const params = request.params as { uri: string; initialBaseline?: string } | undefined;
    if (!params?.uri) {
      throw new ParameterValidationError('uri parameter is required');
    }

    if (!connection) {
      throw new Error('Connection required for subscription');
    }

    const subscriberId = this.#getSubscriberIdFromConnection(connection);
    if (!subscriberId) {
      throw new Error('Subscriber ID not found for connection');
    }

    // Parse the URI to determine subscription type
    const parsedUri = this.#uriRouter.parseEntityUri(params.uri);
    
    // For patch subscriptions, initialBaseline is required
    if (parsedUri.type === UriTemplateType.PATCH_SUBSCRIPTION && !params.initialBaseline) {
      throw new ParameterValidationError('initialBaseline parameter is required for patch subscriptions');
    }

    // Use subscriberId instead of sessionId for subscriptions
    this.#entities.subscribeToResource(subscriberId, params.uri, request.id, params.initialBaseline);

    // Return empty result per MCP spec - actual subscription result will be sent via notification
    return {};
  }

  /**
   * Handle resources/unsubscribe requests
   */
  #handleResourceUnsubscribe(request: JSONRPCRequest, connection?: Connection): any {
    const params = request.params as { uri: string } | undefined;
    if (!params?.uri) {
      throw new ParameterValidationError('uri parameter is required');
    }

    if (!connection) {
      throw new Error('Connection required for unsubscription');
    }

    const subscriberId = this.#getSubscriberIdFromConnection(connection);
    if (!subscriberId) {
      throw new Error('Subscriber ID not found for connection');
    }

    return this.#entities.unsubscribeFromResource(subscriberId, params.uri, request.id);
  }

  #processMCPRequest(request: JSONRPCRequest, connection?: Connection): JSONRPCResponse | JSONRPCError {
    try {
      // Validate that connection is initialized (except for initialize method)
      if (connection) {
        this.#validateConnectionInitialized(connection, request);
      }

      let result: any;

      switch (request.method) {
        case "initialize":
          result = this.#handleInitialize(request, connection);
          break;
        case "tools/list":
          result = this.#handleListTools(request);
          break;
        case "tools/call":
          result = this.#handleCallTool(request, connection);
          break;
        case "resources/templates/list":
          result = this.#handleListResourceTemplates(request);
          break;
        case "resources/read":
          result = this.#entities.getReadEntity().handleReadResource((request.params as ReadResourceRequest['params']).uri);
          break;
        case "resources/subscribe":
          result = this.#handleResourceSubscribe(request, connection);
          break;
        case "resources/unsubscribe":
          result = this.#handleResourceUnsubscribe(request, connection);
          break;
        default:
          throw new JSONRPCValidationError(
            ErrorCode.MethodNotFound, 
            `Method ${request.method} not found`
          );
      }
      return createSuccessResponse(request.id, result);
    } catch (error) {
      return this.#mapErrorToResponse(request.id, error);
    }
  }

  /**
   * Process incoming WebSocket message and handle MCP protocol
   */
  #processIncomingMessage(connection: Connection, message: string): void {
    let parsedMessage: any;
    try {
      parsedMessage = JSON.parse(message);
    } catch (parseError) {
      // Handle JSON parse error
      const errorResponse = createErrorResponse(
        null,
        ErrorCode.ParseError,
        'Parse error'
      );
      connection.send(JSON.stringify(errorResponse));
      return;
    }

    const { mcpMessage, isEnvelopeFormat } = this.#extractMCPMessage(parsedMessage);
    
    const { request, notification } = this.#validateMCPMessage(mcpMessage);
    
    if (!request && !notification) {
      this.#sendValidationError(connection, parsedMessage, mcpMessage, isEnvelopeFormat);
      return;
    }
    
    if (request) {
      this.#handleMCPRequest(connection, request, parsedMessage, isEnvelopeFormat);
    } else if (notification) {
      this.#handleMCPNotification(connection, notification);
    }
  }

  /**
   * Extract MCP message from envelope or direct format
   */
  #extractMCPMessage(parsedMessage: any): { 
    mcpMessage: JSONRPCRequest | JSONRPCRequest[] | JSONRPCNotification; 
    isEnvelopeFormat: boolean 
  } {
    let mcpMessage: JSONRPCRequest | JSONRPCRequest[] | JSONRPCNotification;
    let isEnvelopeFormat = false;
    
    if (isWebSocketRequestEnvelope(parsedMessage)) {
      // Extract the payload from the envelope
      mcpMessage = parsedMessage.payload;
      isEnvelopeFormat = true;
    } else {
      // Direct MCP message (no envelope)
      mcpMessage = parsedMessage;
    }
    
    return { mcpMessage, isEnvelopeFormat };
  }

  /**
   * Validate MCP message as request or notification
   */
  #validateMCPMessage(mcpMessage: any): { 
    request: JSONRPCRequest | null; 
    notification: JSONRPCNotification | null 
  } {
    let request: JSONRPCRequest | null = null;
    let notification: JSONRPCNotification | null = null;
    
    try {
      // Try to validate as a request first
      request = validateRequest(mcpMessage);
    } catch (requestError) {
      try {
        // If not a request, try to validate as a notification
        notification = validateNotification(mcpMessage);
      } catch (notificationError) {
        // Neither valid request nor notification
        return { request: null, notification: null };
      }
    }
    
    return { request, notification };
  }

  /**
   * Send validation error response
   */
  #sendValidationError(
    connection: Connection, 
    parsedMessage: any, 
    mcpMessage: any, 
    isEnvelopeFormat: boolean
  ): void {
    const id = (mcpMessage && typeof mcpMessage === 'object' && 'id' in mcpMessage) ? mcpMessage.id : null;
    const errorResponse = createErrorResponse(
      id,
      ErrorCode.InvalidRequest,
      'Message is not a valid JSON-RPC request or notification'
    );
    
    const responseMessage = this.#wrapResponse(errorResponse, parsedMessage, isEnvelopeFormat);
    connection.send(responseMessage);
  }

  /**
   * Handle MCP request and send response
   */
  #handleMCPRequest(
    connection: Connection, 
    request: JSONRPCRequest, 
    parsedMessage: any, 
    isEnvelopeFormat: boolean
  ): void {
    const response = this.#processMCPRequest(request, connection);
    
    if (response) {
      const responseMessage = this.#wrapResponse(response, parsedMessage, isEnvelopeFormat);
      connection.send(responseMessage);
    }
  }

  /**
   * Handle MCP notification (no response expected)
   */
  #handleMCPNotification(connection: Connection, notification: JSONRPCNotification): void {
    if (notification.method === "notifications/initialized") {
      const attachment = connection.deserializeAttachment();
      if (attachment?.initializationState) {
        attachment.initializationState.mcpInitialized = true;
        connection.serializeAttachment(attachment);
        
        // Clear the initialization timeout since we're now fully initialized
        this.#clearInitializationTimeout(connection);
        
        console.debug('%o', {
          type: 'debug',
          where: 'Lumenize.#handleMCPNotification',
          message: 'MCP initialization completed successfully',
          sessionId: attachment.sessionData?.sessionId
        });
      }
    }
  }

  /**
   * Wrap response in envelope format if needed
   */
  #wrapResponse(
    response: JSONRPCResponse | JSONRPCError, 
    parsedMessage: any, 
    isEnvelopeFormat: boolean
  ): string {
    if (isEnvelopeFormat && isWebSocketRequestEnvelope(parsedMessage)) {
      const responseEnvelope: WebSocketResponseEnvelope = {
        type: parsedMessage.type,
        payload: response
      };
      return JSON.stringify(responseEnvelope);
    } else {
      return JSON.stringify(response);
    }
  }

  /**
   * Handle processing errors and send appropriate error response
   */
  #handleProcessingError(connection: Connection, message: string, error: unknown): void {
    try {
      // For JSON parse errors, we can't parse the message, so send a simple error response
      const errorResponse = createErrorResponse(
        null, // No id available for parse errors
        ErrorCode.ParseError,
        'Parse error'
      );
      
      connection.send(JSON.stringify(errorResponse));
    } catch (responseError) {
      // Failed to send error response - log but don't throw
      console.error('%o', {
        type: 'error',
        where: 'Lumenize.#handleProcessingError',
        message: 'Failed to send error response',
        originalError: error instanceof Error ? error.message : error,
        responseError: responseError instanceof Error ? responseError.message : responseError
      });
    }
  }

  /**
   * Called before onConnect to determine tags for the connection
   * Tags allow efficient retrieval of specific connections
   */
  getConnectionTags(connection: Connection, ctx: ConnectionContext): string[] {
    // Extract subscriberId from URL search parameters (client-generated unique ID)
    const url = new URL(ctx.request.url);
    const subscriberId = url.searchParams.get('subscriberId');
    
    // Extract sessionId from cookies for authentication context
    const cookies = ctx.request.headers.get('cookie');
    const sessionId = this.#extractSessionId(cookies, ctx.request.url);
    
    if (!subscriberId) {
      console.error('%o', {
        type: 'error',
        where: 'Lumenize.getConnectionTags',
        message: 'Required subscriberId parameter is missing from URL',
        url: ctx.request.url,
        searchParams: Object.fromEntries(url.searchParams),
      });
      
      // Return unauthenticated tag - connection will be rejected in onConnect
      return ['unauthenticated'];
    }
    
    if (!sessionId) {
      console.error('%o', {
        type: 'error',
        where: 'Lumenize.getConnectionTags',
        message: 'The required sessionId cookie is missing',
        subscriberId,
        url: ctx.request.url,
        cookies: cookies || 'none',
        headers: Object.fromEntries(ctx.request.headers),
      });
      
      // Return unauthenticated tag - authentication will be handled in onConnect
      return ['unauthenticated'];
    }
    
    console.debug('%o', {
      type: 'debug',
      where: 'Lumenize.getConnectionTags',
      message: 'Connection tags determined successfully',
      subscriberId,
      sessionId,
      url: ctx.request.url,
    });
    
    // Return subscriberId as the primary tag for connection identification and notification delivery
    return [subscriberId];
  }

  /**
   * Handle HTTP requests using handler pattern
   * Each handler checks if it should handle the request and returns Response or undefined
   */
  onRequest(request: Request): Response {
    // Try each handler in turn
    const readEntityResult = this.#entities.getReadEntity().handleRequest(request);
    if (readEntityResult) {
      return readEntityResult;
    }
    
    // No handler matched - return 404
    return Response.json(
      { error: 'Not found' },
      { status: 404 }
    );
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    // Do not manually call connection.accept() - PartyServer is configured to do this automatically

    // debugOn();

    console.debug('%o', {
      type: 'debug',
      where: 'Lumenize.onConnect',
      message: 'WebSocket connection starting, extracting authentication from context',
      headers: Object.fromEntries(ctx.request.headers),
      url: ctx.request.url,
      request: ctx.request,
    });

    // TODO: Extract galaxyId and starId from the URL and store them in as this.#galaxyId and this.#starId

    // Extract subscriberId from URL search parameters (client-generated unique ID)
    const url = new URL(ctx.request.url);
    const subscriberId = url.searchParams.get('subscriberId');

    if (!subscriberId) {
      console.error('%o', {
        type: 'error',
        where: 'Lumenize.onConnect',
        message: 'Required subscriberId parameter is missing from URL',
        url: ctx.request.url,
        searchParams: Object.fromEntries(url.searchParams),
      });

      // Send error message via WebSocket before closing
      const errorResponse = {
        type: 'mcp', // Use the expected route type
        payload: {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: 1011, // Custom error code for missing subscriberId
            message: 'Required subscriberId parameter is missing from URL'
          }
        }
      };
      
      // Send the error message
      connection.send(JSON.stringify(errorResponse));
      
      connection.close(1011, 'Required subscriberId parameter is missing from URL');
      return;
    }

    // Extract authentication info from ConnectionContext (cookies, headers, etc.)
    // This is the crucial work that ONLY onConnect can do
    const cookies = ctx.request.headers.get('cookie');
    const sessionId = this.#extractSessionId(cookies, ctx.request.url);
    const userAgent = ctx.request.headers.get('user-agent');
    const origin = ctx.request.headers.get('origin');

    // Check if authentication failed
    if (!sessionId) {
      const errorMessage = 'The required sessionId cookie is missing';
      
      console.error('%o', {
        type: 'error',
        where: 'Lumenize.onConnect',
        message: 'Authentication failed - sending error and closing connection',
        errorMessage,
        subscriberId,
        url: ctx.request.url,
        cookies: cookies || 'none'
      });

      // Send error message via WebSocket before closing
      const errorResponse = {
        type: 'mcp', // Use the expected route type
        payload: {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: 1008, // Custom error code for authentication failure
            message: errorMessage
          }
        }
      };
      
      // Send the error message
      connection.send(JSON.stringify(errorResponse));
      
      connection.close(1008, errorMessage);
      
      return; // Don't proceed with normal connection setup
    }

    const attachment = {
      subscriberId, // Store the client-generated subscriber ID
      sessionData: {
        sessionId,
        userAgent,
        origin,
        connectedAt: new Date().toISOString(),
        authenticated: !!sessionId // Will be set to true if sessionId exists
      },
      initializationState: {
        protocolVersion: this.#protocolVersion,
        serverInfo: this.#serverInfo,
        serverCapabilities: this.#serverCapabilities,
        mcpInitialized: false, // Will be set to true when notifications/initialized is received
        initializeReceivedAt: null as string | null,
        initializationTimeoutId: null as any
      }
    };
    
    connection.serializeAttachment(attachment);

    // Set up initialization timeout
    this.#scheduleInitializationTimeout(connection);
    
    console.debug('%o', {
      type: 'debug',
      where: 'Lumenize.onConnect',
      message: 'WebSocket connection established with initialization timeout',
      subscriberId,
      sessionId,
      origin,
      protocolVersion: this.#protocolVersion,
      timeoutMs: Lumenize.INITIALIZATION_TIMEOUT_MS
    });
  }

  /**
   * Extract session ID from cookie header, and in test/development environments,
   * also check URL search parameters as fallback
   */
  #extractSessionId(cookieHeader: string | null, requestUrl?: string): string | null {
    // First try to extract from cookies (production method)
    if (cookieHeader) {
      // Example: Extract sessionId from "sessionId=abc123; other=value"
      const match = cookieHeader.match(/sessionId=([^;]+)/);
      if (match) {
        return match[1];
      }
    }
    
    // In test/development environments, also check URL search parameters
    const isTestOrDev = this.env.ENVIRONMENT === 'test' || this.env.ENVIRONMENT === 'development';
    if (isTestOrDev && requestUrl) {
      try {
        const url = new URL(requestUrl);
        
        // Check direct sessionId parameter
        const sessionIdParam = url.searchParams.get('sessionId');
        if (sessionIdParam) {
          console.debug('%o', {
            type: 'debug',
            where: 'Lumenize.#extractSessionId',
            message: 'Found sessionId in URL parameters (test/dev environment)',
            sessionId: sessionIdParam
          });
          return sessionIdParam;
        }
        
        // Check cookies parameter (from monkey-patched WebSocket)
        const cookiesParam = url.searchParams.get('cookies');
        if (cookiesParam) {
          const decodedCookies = decodeURIComponent(cookiesParam);
          const match = decodedCookies.match(/sessionId=([^;]+)/);
          if (match) {
            console.debug('%o', {
              type: 'debug',
              where: 'Lumenize.#extractSessionId',
              message: 'Found sessionId in URL cookies parameter (test/dev environment)',
              sessionId: match[1],
              decodedCookies
            });
            return match[1];
          }
        }
      } catch (error) {
        console.warn('%o', {
          type: 'warn',
          where: 'Lumenize.#extractSessionId',
          message: 'Failed to parse URL for sessionId extraction',
          error: error instanceof Error ? error.message : error,
          url: requestUrl
        });
      }
    }
    
    return null;
  }
  
  // Called for each message received on a WebSocket connection
  onMessage(connection: Connection, message: WSMessage) {
    // debugOn();

    if (typeof message !== 'string') {
      return;
    }

    // Process the message directly
    const attachment = connection.deserializeAttachment();
    console.debug('%o', {
      type: 'debug',
      where: 'Lumenize.onMessage',
      message: 'Processing MCP message',
      attachment,
      payload: message
    });

    try {
      this.#processIncomingMessage(connection, message);
    } catch (error) {
      this.#handleProcessingError(connection, message, error);
    }
  }

  // Called when a WebSocket connection is closed
  onClose(connection: Connection, code: number, reason: string, wasClean: boolean): void {
    // debugOn();

    // Clear any pending timeouts
    this.#clearInitializationTimeout(connection);

    // Get subscriber ID from attachment and clean up subscriptions
    const subscriberId = this.#getSubscriberIdFromConnection(connection);
    const sessionId = this.#getSessionIdFromConnection(connection);
    
    if (subscriberId) {
      // Use subscriberId for subscription cleanup instead of sessionId
      this.#entities.removeAllSubscriptionsForSubscriber(subscriberId);
    }

    console.debug('%o', {
      type: 'debug',
      where: 'Lumenize.onClose',
      message: 'WebSocket connection closed',
      code,
      reason,
      wasClean,
      subscriberId,
      sessionId
    });
  }

};
