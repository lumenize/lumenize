/**
 * Type definitions for @lumenize/proxy-fetch
 */

/**
 * Metadata stored in DO storage for each proxy fetch request
 */
export interface ProxyFetchMetadata {
  /** Name of the handler method to call on the DO */
  handlerName: string;
  /** DO binding name for return routing */
  doBindingName: string;
  /** DO instance ID for return routing */
  instanceId: string;
  /** Timestamp when request was initiated */
  timestamp: number;
}

/**
 * Message sent to queue from DO
 */
export interface ProxyFetchQueueMessage {
  /** Unique request ID */
  reqId: string;
  /** Serialized Request object (not a Request instance) */
  request: any; // Serialized form from serializeWebApiObject()
  /** DO binding name for return routing */
  doBindingName: string;
  /** DO instance ID for return routing */
  instanceId: string;
}

/**
 * Item passed to user's handler method and proxyFetchHandler
 */
export interface ProxyFetchHandlerItem {
  /** Unique request ID */
  reqId: string;
  /** Response from external API (if successful) */
  response?: Response;
  /** Error from fetch or processing (if failed) */
  error?: Error;
}

/**
 * Interface for DOs that can receive proxy fetch responses.
 * Any DO that uses proxyFetch() must implement this method.
 */
export interface ProxyFetchCapable {
  /**
   * Receives responses/errors from the proxy fetch queue consumer.
   * This is called via Workers RPC after the external fetch completes.
   */
  proxyFetchHandler(item: ProxyFetchHandlerItem): Promise<void>;
}
