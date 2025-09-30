// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

import type {
  OperationChain,
  WireOperationChain,
  RPCRequest,
  RPCResponse,
  RPCConfig,
  RemoteFunctionMarker
} from './types';

/**
 * Configuration for browser RPC client
 */
export interface BrowserRPCConfig extends RPCConfig {
  /**
   * Base URL for the RPC server
   * @default "http://localhost:8787"
   */
  baseUrl?: string;

  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeout?: number;

  /**
   * Number of retries for failed requests
   * @default 3
   */
  retries?: number;

  /**
   * Custom fetch function (for testing or custom HTTP clients)
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Default configuration for browser RPC client
 */
const DEFAULT_BROWSER_CONFIG: Required<BrowserRPCConfig> = {
  basePath: '/__rpc',
  maxDepth: 50,
  maxArgs: 100,
  baseUrl: 'http://localhost:8787',
  timeout: 30000,
  retries: 3,
  fetch: globalThis.fetch.bind(globalThis)
};

/**
 * Browser-side RPC client that creates proxies for Durable Objects
 */
export class BrowserRPCClient {
  private config: Required<BrowserRPCConfig>;

  constructor(config: BrowserRPCConfig = {}) {
    this.config = { ...DEFAULT_BROWSER_CONFIG, ...config };
  }

  /**
   * Create a proxy for a Durable Object instance
   * @param doName - Name or ID of the Durable Object instance
   * @returns Proxy object that intercepts property access and function calls
   */
  createDOProxy(doName: string): any {
    const operationChain: OperationChain = [];

    const proxy = new Proxy(() => {}, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') {
          return undefined;
        }

        // Special property to get the actual object (for debugging)
        if (prop === '__asObject') {
          return async () => {
            return await this.executeOperationChain([...operationChain]);
          };
        }

        // Handle 'then' property for Promise compatibility
        if (prop === 'then') {
          const getValue = this.executeOperationChain([...operationChain]);
          return getValue.then.bind(getValue);
        }

        // Chain deeper into the property path
        operationChain.push({ type: 'get', key: prop });
        return proxy;
      },

      apply(target, thisArg, args) {
        // Add the function call operation
        operationChain.push({ type: 'apply', args });

        // Execute the operation chain
        const result = this.executeOperationChain([...operationChain]);

        // Reset the operation chain for next use
        operationChain.length = 0;

        return result;
      }
    });

    return proxy;
  }

  /**
   * Execute an operation chain by making HTTP request to the server
   */
  private async executeOperationChain(operations: OperationChain): Promise<any> {
    if (operations.length === 0) {
      throw new Error('Empty operation chain');
    }

    if (operations.length > this.config.maxDepth) {
      throw new Error(`Operation chain too deep: ${operations.length} > ${this.config.maxDepth}`);
    }

    // Validate apply operations
    for (const operation of operations) {
      if (operation.type === 'apply' && operation.args.length > this.config.maxArgs) {
        throw new Error(`Too many arguments: ${operation.args.length} > ${this.config.maxArgs}`);
      }
    }

    // Serialize operations for transport
    const wireOperations: WireOperationChain = serialize(operations);

    const request: RPCRequest = {
      operations: wireOperations
    };

    const url = `${this.config.baseUrl}${this.config.basePath}/call`;
    const body = JSON.stringify(request);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const response = await this.config.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body,
          signal: AbortSignal.timeout(this.config.timeout)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const rpcResponse: RPCResponse = await response.json();

        if (!rpcResponse.success) {
          throw new Error(rpcResponse.error?.message || 'RPC call failed');
        }

        // Deserialize the result
        const result = deserialize(rpcResponse.result);

        // Convert remote function markers back to proxies
        return this.reconstructRemoteFunctions(result, operations);

      } catch (error) {
        lastError = error as Error;

        // Don't retry on the last attempt
        if (attempt === this.config.retries) {
          break;
        }

        // Wait before retrying (exponential backoff)
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error('RPC call failed after all retries');
  }

  /**
   * Convert remote function markers back to proxy functions
   */
  private reconstructRemoteFunctions(obj: any, baseChain: OperationChain, seen = new WeakSet()): any {
    // Handle primitive types and null/undefined - return as-is
    if (obj === null || obj === undefined || typeof obj !== 'object') {
      return obj;
    }

    // Handle circular references
    if (seen.has(obj)) {
      return obj;
    }
    seen.add(obj);

    // Handle built-in types - return as-is
    if (obj instanceof Date || obj instanceof RegExp || obj instanceof Map ||
        obj instanceof Set || obj instanceof ArrayBuffer ||
        ArrayBuffer.isView(obj) || obj instanceof Error) {
      return obj;
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map((item, index) => {
        const currentChain: OperationChain = [...baseChain, { type: 'get', key: index }];
        return this.reconstructRemoteFunctions(item, currentChain, seen);
      });
    }

    // Check if this is a remote function marker
    if (obj && typeof obj === 'object' && obj.__isRemoteFunction && obj.__operationChain) {
      return this.createRemoteFunctionProxy(obj.__operationChain, obj.__functionName);
    }

    // Handle plain objects - recursively process but preserve structure
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const currentChain: OperationChain = [...baseChain, { type: 'get', key }];
      result[key] = this.reconstructRemoteFunctions(value, currentChain, seen);
    }

    return result;
  }

  /**
   * Create a proxy for a remote function that will execute the operation chain when called
   */
  private createRemoteFunctionProxy(operationChain: OperationChain, functionName?: string): any {
    const proxyFunction = async function(...args: any[]) {
      // Add the function call operation
      const fullChain: OperationChain = [
        ...operationChain,
        { type: 'apply', args }
      ];

      // Execute the operation chain
      return await this.executeOperationChain(fullChain);
    };

    // Set the function name for better debugging
    Object.defineProperty(proxyFunction, 'name', {
      value: functionName || 'remoteFunction',
      configurable: true
    });

    return proxyFunction;
  }
}

/**
 * Convenience function to create a browser RPC client
 */
export function createBrowserRPCClient(config?: BrowserRPCConfig): BrowserRPCClient {
  return new BrowserRPCClient(config);
}

/**
 * Convenience function to create a DO proxy
 */
export function createDOProxy(doName: string, config?: BrowserRPCConfig): any {
  const client = new BrowserRPCClient(config);
  return client.createDOProxy(doName);
}