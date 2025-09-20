/**
 * Instruments a Worker export object to track DO access during execution
 * @param workerExport - The original Worker export object
 * @returns Instrumented Worker export with DO access tracking
 */
export function instrumentWorker<TEnv extends Record<string, unknown> | undefined>(
  workerExport: { fetch: (request: Request, env: TEnv, ctx: ExecutionContext) => Response | Promise<Response> }
): { fetch: (request: Request, env: TEnv, ctx: ExecutionContext) => Response | Promise<Response> } {
  return {
    fetch(request: Request, env: TEnv, ctx: ExecutionContext) {
      const instrumentedEnv = instrumentEnvironment(env) as TEnv;
      return workerExport.fetch(request, instrumentedEnv, ctx);
    }
  };
}

/**
 * Instruments an environment object to track DO access during execution.
 * This registers accessed DOs in the test context registry for tracking purposes.
 */
export function instrumentEnvironment(env: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!env) {
    return {};
  }
  
  const instrumentedEnv: Record<string, unknown> = {};
  
  // Instrument each DO binding in the environment
  for (const [bindingName, binding] of Object.entries(env)) {
    if (binding && typeof binding === 'object' && 'get' in binding && 'getByName' in binding) {
      instrumentedEnv[bindingName] = instrumentDOBinding(binding, bindingName);
    } else {
      instrumentedEnv[bindingName] = binding;
    }
  }
  
  return instrumentedEnv;
}

/**
 * Instruments a DO binding to track access
 */
function instrumentDOBinding(originalBinding: any, bindingName: string): any {
  return {
    ...originalBinding,
    
    get: (...args: any[]) => {
      const doStub = originalBinding.get(...args);
      const id = args[0];
      let instanceName: string;
      
      // Try to extract the name from the ID object if it has one
      if (id && typeof id === 'object') {
        // Check if the ID object has a name property (from idFromName)
        instanceName = id.name || id.toString();
      } else {
        // Fallback to string representation
        instanceName = id?.toString() || 'anonymous';
      }
      
      // Register in testDOProject context registry if available
      const registerContext = (globalThis as any).__testingContextRegistry;
      if (registerContext && typeof registerContext === 'function') {
        registerContext(bindingName, instanceName);
      }
      
      return doStub;
    },
    
    getByName: (...args: any[]) => {
      const doStub = originalBinding.getByName(...args);
      const instanceName = args[0];
      
      // Register in testDOProject context registry if available
      const registerContext = (globalThis as any).__testingContextRegistry;
      if (registerContext && typeof registerContext === 'function') {
        registerContext(bindingName, instanceName);
      }
      
      return doStub;
    },
    
    // Preserve other methods without extra tracking since we don't need the mapping approach
    idFromName: originalBinding.idFromName?.bind(originalBinding),
    idFromString: originalBinding.idFromString?.bind(originalBinding),
    newUniqueId: originalBinding.newUniqueId?.bind(originalBinding),
  };
}