import type { OperationChain, RpcRequest, RpcResponse, RpcTransport } from './types';
import { deserializeError } from './error-serialization';
import { stringify, parse } from '@ungap/structured-clone/json';

/**
 * Utility function to remove leading and trailing slashes from a URL segment
 */
function cleanSegment(segment: string): string {
  return segment.replace(/^\/+|\/+$/g, '');
}

/**
 * HTTP transport layer for RPC communication using POST requests.
 * Implements the RpcTransport interface.
 */
export class HttpPostRpcTransport implements RpcTransport {
  #config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceNameOrId: string;
    timeout: number;
    fetch: typeof fetch;
    headers: Record<string, string>;
  };

  constructor(config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceNameOrId: string;
    timeout: number;
    fetch: typeof fetch;
    headers: Record<string, string>;
  }) {
    this.#config = config;
  }

  /**
   * Execute an operation chain via HTTP POST
   */
  async execute(operations: OperationChain): Promise<any> {
    // Build URL with four segments: ${baseUrl}/${prefix}/${doBindingName}/${doInstanceNameOrId}/call
    const baseUrl = cleanSegment(this.#config.baseUrl);
    const prefix = cleanSegment(this.#config.prefix);
    const doBindingName = cleanSegment(this.#config.doBindingName);
    const doInstanceNameOrId = cleanSegment(this.#config.doInstanceNameOrId);

    const url = `${baseUrl}/${prefix}/${doBindingName}/${doInstanceNameOrId}/call`;

    const request: RpcRequest = { operations };

    console.debug('%o', {
      type: 'debug',
      where: 'HttpPostTransport.execute',
      operations,
      request
    });

    const headers = {
      'Content-Type': 'application/json',
      ...this.#config.headers
    };

    // Use stringify on the entire request object
    const requestBody = stringify(request);

    const response = await this.#config.fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(this.#config.timeout)
    });

    // Parse the entire response using @ungap/structured-clone/json
    const responseText = await response.text();
    const rpcResponse: RpcResponse = parse(responseText);

    if (!response.ok) {
      // Handle error response
      if (!rpcResponse.success && rpcResponse.error) {
        // This is an RPC error response, deserialize and throw the actual error
        throw deserializeError(rpcResponse.error);
      }
      
      // Fallback to generic HTTP error
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // At this point, response.ok is true, so rpcResponse.success should always be true
    // Return the result directly (already deserialized by parse)
    return rpcResponse.result;
  }

  isConnected(): boolean {
    // HTTP transport is stateless and always "connected"
    return true;
  }

}