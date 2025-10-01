import type { OperationChain, RpcClientFactoryConfig} from './types';
import { HttpPostRpcTransport } from './http-post-transport';

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

export class RpcClientFactory {
  #config: Required<RpcClientFactoryConfig>;

  constructor(config: RpcClientFactoryConfig) {
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

  execute(operations: OperationChain, doBindingName: string, doInstanceName: string): Promise<any> {
    // Create transport instance with current config
    const transport = new HttpPostRpcTransport({
      baseUrl: this.#config.baseUrl,
      prefix: this.#config.prefix,
      doBindingName,
      doInstanceName,
      timeout: this.#config.timeout,
      fetch: this.#config.fetch,
      headers: this.#config.headers
    });

    // Execute the operation chain via HTTP transport
    return transport.execute(operations);
  }

  createRpcProxy<T>(doBindingName: string, doInstanceNameOrId: string): T {
    // Create initial proxy with empty operation chain
    const handler = new ProxyHandler(this, doBindingName, doInstanceNameOrId);
    return new Proxy(() => {}, handler) as T;
  }
}

class ProxyHandler {
  #operationChain: import('./types').OperationChain = [];
  #rpcClient: RpcClientFactory;
  #doBindingName: string;
  #doInstanceNameOrId: string;

  constructor(rpcClient: RpcClientFactory, doBindingName: string, doInstanceNameOrId: string) {
    this.#rpcClient = rpcClient;
    this.#doBindingName = doBindingName;
    this.#doInstanceNameOrId = doInstanceNameOrId;
  }

  get(target: any, key: string | symbol): any {
    // Add 'get' operation to chain
    this.#operationChain.push({ type: 'get', key });

    // Return a new proxy that will handle the next operation
    return this.createProxyWithCurrentChain();
  }

  apply(target: any, thisArg: any, args: any[]): any {
    // Add 'apply' operation to chain and execute
    this.#operationChain.push({ type: 'apply', args });

    // Execute the operation chain
    return this.#rpcClient.execute([...this.#operationChain], this.#doBindingName, this.#doInstanceNameOrId);
  }

  private createProxyWithCurrentChain(): any {
    const currentChain = [...this.#operationChain];

    return new Proxy(() => {}, {
      get: (target: any, key: string | symbol) => {
        currentChain.push({ type: 'get', key });
        return this.createProxyWithCurrentChainForChain(currentChain);
      },
      apply: (target: any, thisArg: any, args: any[]) => {
        currentChain.push({ type: 'apply', args });
        return this.#rpcClient.execute(currentChain, this.#doBindingName, this.#doInstanceNameOrId);
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
        return this.#rpcClient.execute(finalChain, this.#doBindingName, this.#doInstanceNameOrId);
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