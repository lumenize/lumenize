import type { OperationChain, RPCRequest, RPCResponse } from './types';
import { deserializeError } from './error-serialization';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

/**
 * HTTP transport layer for RPC communication using POST requests
 */
export class RPCTransport {
  #config: {
    baseUrl: string;
    prefix: string;
    timeout: number;
    fetch: typeof fetch;
    headers: Record<string, string>;
  };

  constructor(config: {
    baseUrl: string;
    prefix: string;
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
    const url = `${this.#config.baseUrl}${this.#config.prefix}/call`;

    // const request: RPCRequest = {
    //   operations: operations.map(op => {
    //     if (op.type === 'get') {
    //       return { type: 'get', key: op.key };
    //     } else {
    //       return { type: 'apply', args: op.args };
    //     }
    //   })
    // };

    const serializedOperations = serialize(operations);
    console.debug('%o', {
      type: 'debug',
      where: 'HttpPostTransport.execute',
      operations,
      serializedOperations
    });

    const request = { operations: serializedOperations };

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

    const rpcResponse: RPCResponse = await response.json();

    if (!rpcResponse.success) {
      // Handle error response
      throw deserializeError(rpcResponse.error);
    }

    // Deserialize the result using @ungap/structured-clone
    return deserialize(rpcResponse.result);
  }

}