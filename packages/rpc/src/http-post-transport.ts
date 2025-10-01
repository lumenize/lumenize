import type { OperationChain, RpcRequest, RpcResponse } from './types';
import { deserializeError } from './error-serialization';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

/**
 * Utility function to remove leading and trailing slashes from a URL segment
 */
function cleanSegment(segment: string): string {
  return segment.replace(/^\/+|\/+$/g, '');
}

/**
 * HTTP transport layer for RPC communication using POST requests
 */
export class HttpPostRpcTransport {
  #config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceName: string;
    timeout: number;
    fetch: typeof fetch;
    headers: Record<string, string>;
  };

  constructor(config: {
    baseUrl: string;
    prefix: string;
    doBindingName: string;
    doInstanceName: string;
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
    // Build URL with four segments: ${baseUrl}/${prefix}/${doBindingName}/${doInstanceName}/call
    const baseUrl = cleanSegment(this.#config.baseUrl);
    const prefix = cleanSegment(this.#config.prefix);
    const doBindingName = cleanSegment(this.#config.doBindingName);
    const doInstanceName = cleanSegment(this.#config.doInstanceName);

    const url = `${baseUrl}/${prefix}/${doBindingName}/${doInstanceName}/call`;

    const wireOperations = serialize(operations);
    console.debug('%o', {
      type: 'debug',
      where: 'HttpPostTransport.execute',
      operations,
      wireOperations
    });

    const request: RpcRequest = { wireOperations };

    const headers = {
      'Content-Type': 'application/json',
      ...this.#config.headers
    };

    const response = await this.#config.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.#config.timeout)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const rpcResponse: RpcResponse = await response.json();

    if (!rpcResponse.success) {
      // Handle error response
      throw deserializeError(rpcResponse.error);
    }

    // Deserialize the result using @ungap/structured-clone
    return deserialize(rpcResponse.result);
  }

}