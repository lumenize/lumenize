// Global storage for stubs created during Worker execution
const workerCreatedStubs = new Map<string, any>();

/**
 * Instruments a Worker export object to capture DO stubs created during execution
 * @param workerExport - The original Worker export object
 * @returns Instrumented Worker export with stub capture
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
 * Instruments an environment object to capture DO stubs created during execution.
 * This allows accessing stubs that were created within the Worker context without
 * triggering I/O isolation errors.
 */
function instrumentEnvironment(env: Record<string, unknown> | undefined): Record<string, unknown> {
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
 * Instruments a DO binding to capture stub creation
 */
function instrumentDOBinding(originalBinding: any, bindingName: string): any {
  return {
    ...originalBinding,
    
    get: (...args: any[]) => {
      const stub = originalBinding.get(...args);
      const key = `${bindingName}:${args[0]?.toString() || 'anonymous'}`;
      workerCreatedStubs.set(key, stub);
      return stub;
    },
    
    getByName: (...args: any[]) => {
      const stub = originalBinding.getByName(...args);
      const key = `${bindingName}:${args[0]}`;
      workerCreatedStubs.set(key, stub);
      return stub;
    },
    
    // Preserve other methods like idFromName, etc.
    idFromName: originalBinding.idFromName?.bind(originalBinding),
    idFromString: originalBinding.idFromString?.bind(originalBinding),
    newUniqueId: originalBinding.newUniqueId?.bind(originalBinding),
  };
}

/**
 * Get a stub that was created during Worker execution
 */
export function getWorkerCreatedStub(bindingName: string, instanceName: string) {
  return workerCreatedStubs.get(`${bindingName}:${instanceName}`);
}

/**
 * Check if a stub was created during Worker execution
 */
export function hasWorkerCreatedStub(bindingName: string, instanceName: string): boolean {
  return workerCreatedStubs.has(`${bindingName}:${instanceName}`);
}