import type { OperationChain, RPCClientConfig} from './types';
import { RPCTransport } from './http-post-transport';

/**
 * Internal state for proxy objects (not exported - implementation detail)
 */
interface ProxyState {
  operationChain: OperationChain;
  rpcClient: any; // Will be the concrete RPCClient class instance
}

/**
 * Symbol used to identify proxy objects (not exported - implementation detail)
 */
const PROXY_STATE_SYMBOL = Symbol('lumenize-rpc-proxy-state');

/**
 * Type guard to check if an object is a proxy with state (internal use only)
 */
function isProxyObject(obj: any): obj is ProxyState & Record<string | symbol, any> {
  return obj && typeof obj === 'object' && obj[PROXY_STATE_SYMBOL] !== undefined;
}

export class RPCClient {
  #config: Required<RPCClientConfig>;

  constructor(config: RPCClientConfig) {
    // Set defaults and merge with user config
    this.#config = {
      prefix: '/__rpc',
      maxDepth: 50,
      maxArgs: 100,
      baseUrl: typeof location !== 'undefined' ? location.origin : 'http://localhost:8787',
      timeout: 30000,
      fetch: globalThis.fetch,
      headers: {},
      ...config
    };
  }

  execute(operations: OperationChain): Promise<any> {
    // Create transport instance with current config
    const transport = new RPCTransport({
      baseUrl: this.#config.baseUrl,
      prefix: this.#config.prefix,
      timeout: this.#config.timeout,
      fetch: this.#config.fetch,
      headers: this.#config.headers
    });

    // Execute the operation chain via HTTP transport
    return transport.execute(operations);
  }

  createProxy<T>(doNamespace: any, doId: any): T {
    // Create initial proxy with empty operation chain
    const handler = new ProxyHandler(this);
    return new Proxy(() => {}, handler) as T;
  }
}

/**
 * Proxy handler for building operation chains and executing RPC calls
 * (This will be implemented in the next step)
 */
class ProxyHandler {
  private operationChain: import('./types').OperationChain = [];
  private rpcClient: RPCClient;

  constructor(rpcClient: RPCClient) {
    this.rpcClient = rpcClient;
  }

  get(target: any, key: string | symbol): any {
    // Add 'get' operation to chain
    this.operationChain.push({ type: 'get', key });

    // Return a new proxy that will handle the next operation
    return this.createProxyWithCurrentChain();
  }

  apply(target: any, thisArg: any, args: any[]): any {
    // Add 'apply' operation to chain and execute
    this.operationChain.push({ type: 'apply', args });

    // Execute the operation chain
    return this.rpcClient.execute([...this.operationChain]);
  }

  private createProxyWithCurrentChain(): any {
    const currentChain = [...this.operationChain];

    return new Proxy(() => {}, {
      get: (target: any, key: string | symbol) => {
        currentChain.push({ type: 'get', key });
        return this.createProxyWithCurrentChainForChain(currentChain);
      },
      apply: (target: any, thisArg: any, args: any[]) => {
        currentChain.push({ type: 'apply', args });
        return this.rpcClient.execute(currentChain);
      }
    });
  }

  private createProxyWithCurrentChainForChain(chain: import('./types').OperationChain): any {
    return new Proxy(() => {}, {
      get: (target: any, key: string | symbol) => {
        const newChain: import('./types').OperationChain = [...chain, { type: 'get', key }];
        return this.createProxyWithCurrentChainForChain(newChain);
      },
      apply: (target: any, thisArg: any, args: any[]) => {
        const finalChain: import('./types').OperationChain = [...chain, { type: 'apply', args }];
        return this.rpcClient.execute(finalChain);
      }
    });
  }
}

/**
 * Export internal types only for use within this module
 * These are not part of the public API
 */
export type { ProxyState };
export { PROXY_STATE_SYMBOL, isProxyObject };