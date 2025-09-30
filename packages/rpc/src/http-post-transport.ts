import type { OperationChain, RPCRequest, RPCResponse } from './types';
import { deserializeError } from './error-serialization';

/**
 * HTTP transport layer for RPC communication using POST requests
 */
export class RPCTransport {
  private config: {
    baseUrl: string;
    basePath: string;
    timeout: number;
    fetch: typeof fetch;
    headers: Record<string, string>;
  };

  constructor(config: {
    baseUrl: string;
    basePath: string;
    timeout: number;
    fetch: typeof fetch;
    headers: Record<string, string>;
  }) {
    this.config = config;
  }

  /**
   * Execute an operation chain via HTTP POST
   */
  async execute(operations: OperationChain): Promise<any> {
    const url = `${this.config.baseUrl}${this.config.basePath}/call`;

    const request: RPCRequest = {
      operations: operations.map(op => {
        if (op.type === 'get') {
          return { type: 'get', key: op.key };
        } else {
          return { type: 'apply', args: op.args };
        }
      })
    };

    const headers = {
      'Content-Type': 'application/json',
      ...this.config.headers
    };

    try {
      const response = await this.config.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeout)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rpcResponse: RPCResponse = await response.json();

      if (!rpcResponse.success) {
        // Handle error response
        throw deserializeError(rpcResponse.error);
      }

      // Deserialize the result using structured clone
      return this.deserializeResult(rpcResponse.result);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`RPC transport error: ${String(error)}`);
    }
  }

  

  /**
   * Deserialize result using structured clone for full type support
   */
  private deserializeResult(result: any): any {
    if (result === undefined) {
      return undefined;
    }

    try {
      // Use structured clone to properly deserialize Cloudflare types
      // Note: In browser environment, we need to use a polyfill or alternative
      if (typeof structuredClone !== 'undefined') {
        return structuredClone(result);
      }

      // Fallback for environments without structuredClone
      return JSON.parse(JSON.stringify(result));
    } catch (error) {
      // If deserialization fails, return as-is
      console.warn('Failed to deserialize RPC result:', error);
      return result;
    }
  }
}