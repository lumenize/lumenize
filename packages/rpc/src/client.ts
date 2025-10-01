import type { OperationChain, RpcClientFactoryConfig, RemoteFunctionMarker} from './types';
import { isRemoteFunctionMarker } from './types';
import { HttpPostRpcTransport } from './http-post-transport';

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

  async execute(operations: OperationChain, doBindingName: string, doInstanceName: string): Promise<any> {
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
    const result = await transport.execute(operations);
    
    // Process the result to convert remote function markers to proxies
    return this.processRemoteFunctions(result, [], doBindingName, doInstanceName);
  }

  processRemoteFunctions(obj: any, baseOperations: any[], doBindingName: string, doInstanceName: string): any {
    // Base case: if it's a remote function marker, create a proxy for it
    if (obj && typeof obj === 'object' && isRemoteFunctionMarker(obj)) {
      const remoteFn = obj as RemoteFunctionMarker;
      return new Proxy(() => {}, {
        apply: (target, thisArg, args) => {
          const operations: OperationChain = [...baseOperations, ...remoteFn.__operationChain, { type: 'apply', args }];
          return this.execute(operations, doBindingName, doInstanceName);
        }
      });
    }

    if (obj === null || typeof obj !== 'object') {
      return obj; // Primitive values pass through unchanged
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.processRemoteFunctions(item, baseOperations, doBindingName, doInstanceName));
    }

    // Process object properties recursively
    const processed: any = {};
    for (const [key, value] of Object.entries(obj)) {
      processed[key] = this.processRemoteFunctions(value, baseOperations, doBindingName, doInstanceName);
    }
    return processed;
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

    // Execute the operation chain and wrap result in thenable proxy
    const resultPromise = this.#rpcClient.execute([...this.#operationChain], this.#doBindingName, this.#doInstanceNameOrId);
    return this.createThenableProxy(resultPromise);
  }

  private createThenableProxy(promise: Promise<any>): any {
    const self = this;
    
    // Use a function as the proxy target so it can be called
    const callableTarget = function() {};
    
    return new Proxy(callableTarget, {
      get(target: any, key: string | symbol, receiver: any) {
        // Allow standard Promise methods by delegating to the promise
        if (key === 'then' || key === 'catch' || key === 'finally') {
          const method = (promise as any)[key];
          return typeof method === 'function' ? method.bind(promise) : method;
        }
        
        if (key === Symbol.toStringTag) {
          return (promise as any)[key];
        }
        
        // For other properties, create a new thenable proxy that accesses the property after resolution
        // AND processes it through processRemoteFunctions
        const nestedPromise = promise.then((resolved: any) => {
          const propertyValue = resolved?.[key];
          // Process the property value to convert any remote function markers
          return self.#rpcClient.processRemoteFunctions(propertyValue, [], self.#doBindingName, self.#doInstanceNameOrId);
        });
        
        // Important: Don't wrap the result in a thenable proxy if it's already a proxy (from processRemoteFunctions)
        // Instead, return a proxy that will behave correctly whether the result is a function/proxy or a value
        const nestedCallableTarget = function() {};
        return new Proxy(nestedCallableTarget, {
          get(t: any, k: string | symbol) {
            if (k === 'then' || k === 'catch' || k === 'finally') {
              const method = (nestedPromise as any)[k];
              return typeof method === 'function' ? method.bind(nestedPromise) : method;
            }
            if (k === Symbol.toStringTag) {
              return (nestedPromise as any)[k];
            }
            // Further property access - chain another thenable proxy
            const furtherPromise = nestedPromise.then((r: any) => {
              const furtherValue = r?.[k];
              return self.#rpcClient.processRemoteFunctions(furtherValue, [], self.#doBindingName, self.#doInstanceNameOrId);
            });
            return self.createThenableProxy(furtherPromise);
          },
          apply(t: any, thisArg: any, args: any[]) {
            // Call as function - the promise resolves to a callable (proxy or function)
            return nestedPromise.then((fnOrProxy: any) => {
              // Try to call it - if it's a proxy with apply trap or a function, this will work
              try {
                return fnOrProxy.apply(thisArg, args);
              } catch (e) {
                throw new Error(`Attempted to call a non-function value: ${e}`);
              }
            });
          }
        });
      },
      apply(target: any, thisArg: any, args: any[]) {
        // The promise itself is being called as a function
        // This means the previous property access resolved to a function
        return promise.then((fn: any) => {
          // Try to call it - if it's a proxy with apply trap or a function, this will work
          try {
            return fn.apply(thisArg, args);
          } catch (e) {
            throw new Error(`Attempted to call a non-function value: ${e}`);
          }
        });
      }
    });
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
        const resultPromise = this.#rpcClient.execute(currentChain, this.#doBindingName, this.#doInstanceNameOrId);
        return this.createThenableProxy(resultPromise);
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
        const resultPromise = this.#rpcClient.execute(finalChain, this.#doBindingName, this.#doInstanceNameOrId);
        return this.createThenableProxy(resultPromise);
      }
    });
  }
}