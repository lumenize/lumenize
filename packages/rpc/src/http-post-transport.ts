import type { RpcBatchRequest, RpcBatchResponse, RpcTransport } from './types';
import { stringify, parse } from '@lumenize/structured-clone';

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
   * Execute a batch of operation chains via HTTP POST
   */
  async execute(batch: RpcBatchRequest): Promise<RpcBatchResponse> {
    // Build URL with four segments: ${baseUrl}/${prefix}/${doBindingName}/${doInstanceNameOrId}/call
    const baseUrl = cleanSegment(this.#config.baseUrl);
    const prefix = cleanSegment(this.#config.prefix);
    const doBindingName = cleanSegment(this.#config.doBindingName);
    const doInstanceNameOrId = cleanSegment(this.#config.doInstanceNameOrId);

    const url = `${baseUrl}/${prefix}/${doBindingName}/${doInstanceNameOrId}/call`;

    console.debug('%o', {
      type: 'debug',
      where: 'HttpPostTransport.execute',
      batch
    });

    const headers = {
      'Content-Type': 'application/json',
      ...this.#config.headers
    };

    // Use stringify on the entire batch request
    const requestBody = await stringify(batch);

    const response = await this.#config.fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(this.#config.timeout)
    });

    // Parse the entire response using @lumenize/structured-clone
    const responseText = await response.text();
    const batchResponse: RpcBatchResponse = await parse(responseText);

    if (!response.ok) {
      // Handle error response - if any operation failed, the server returns HTTP 500
      // But the batch response still contains individual operation results
      // We just return it and let the client handle per-operation errors
      if (batchResponse.batch && batchResponse.batch.length > 0) {
        return batchResponse;
      }
      
      // Fallback to generic HTTP error if we can't parse the batch response
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Return the batch response directly
    return batchResponse;
  }

  isConnected(): boolean {
    // HTTP transport is stateless and always "connected"
    return true;
  }

}