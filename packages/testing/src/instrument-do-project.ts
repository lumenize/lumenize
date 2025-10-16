import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/utils';

/**
 * Configuration for instrumenting a DO project
 */
export interface InstrumentDOProjectConfig {
  /**
   * The module imported from '../src' containing the DO classes and default worker export
   */
  sourceModule: any;
  
  /**
   * Names of DO classes to instrument (must match exports from sourceModule)
   * Optional - if not provided, will auto-detect class exports
   * @example ['MyDO', 'AnotherDO']
   */
  doClassNames?: string[];
  
  /**
   * RPC prefix for routing
   * @default '__rpc'
   */
  prefix?: string;
}

/**
 * Auto-detect DO class names from a source module by finding all class exports
 * (excluding the default export)
 */
function autoDetectDOClasses(sourceModule: any): string[] {
  const classExports = Object.entries(sourceModule)
    .filter(([name, value]) => {
      // Exclude default export
      if (name === 'default') return false;
      
      // Check if it's a class (constructor function)
      if (typeof value !== 'function') return false;
      if (!value.prototype) return false;
      
      return true;
    })
    .map(([name]) => name);
  
  return classExports;
}

/**
 * Result of instrumenting a DO project
 * This is both an ExportedHandler (for default export) and has DO classes as properties
 */
export interface InstrumentedDOProject extends ExportedHandler {
  /**
   * Instrumented worker with RPC routing
   */
  worker: ExportedHandler;
  
  /**
   * Instrumented DO classes keyed by their names
   * @example { MyDO: InstrumentedMyDO, AnotherDO: InstrumentedAnotherDO }
   */
  dos: Record<string, any>;
  
  // Also add DOs as direct properties for easy access
  [key: string]: any;
}

/**
 * Instruments a DO project for testing by wrapping DO classes with lumenizeRpcDO
 * and creating a worker that routes RPC requests.
 * 
 * This eliminates the need for boilerplate test-harness.ts files - the function
 * handles all the instrumentation automatically.
 * 
 * **Auto-detection (simple projects with 1 DO):**
 * ```typescript
 * // test/test-worker-and-dos.ts
 * import * as sourceModule from '../src';
 * import { instrumentDOProject } from '@lumenize/testing';
 * 
 * export default instrumentDOProject(sourceModule);
 * ```
 * 
 * **Explicit configuration (multiple DOs or complex projects):**
 * ```typescript
 * // test/test-worker-and-dos.ts
 * import * as sourceModule from '../src';
 * import { instrumentDOProject } from '@lumenize/testing';
 * 
 * const { worker, dos } = instrumentDOProject({
 *   sourceModule,
 *   doClassNames: ['MyDO', 'AnotherDO']
 * });
 * 
 * export const { MyDO, AnotherDO } = dos;
 * export default worker;
 * ```
 */
export function instrumentDOProject(
  configOrSourceModule: InstrumentDOProjectConfig | any
): InstrumentedDOProject {
  // Support both simple (sourceModule only) and explicit config
  const config: InstrumentDOProjectConfig = 
    configOrSourceModule.sourceModule 
      ? configOrSourceModule 
      : { sourceModule: configOrSourceModule };
  
  const { sourceModule, prefix = '__rpc' } = config;
  let { doClassNames } = config;
  
  // Auto-detect DO classes if not provided
  if (!doClassNames || doClassNames.length === 0) {
    const detectedClasses = autoDetectDOClasses(sourceModule);
    
    if (detectedClasses.length === 0) {
      throw new Error(
        `No class exports found in sourceModule.\n` +
        `Make sure your src/index.ts exports at least one Durable Object class.\n\n` +
        `Available exports: ${Object.keys(sourceModule).join(', ')}`
      );
    }
    
    if (detectedClasses.length === 1) {
      // Single class found - use it automatically
      doClassNames = detectedClasses;
    } else {
      // Multiple classes found - need explicit configuration
      throw new Error(
        `Found multiple class exports: ${detectedClasses.join(', ')}\n\n` +
        `Please specify which are Durable Objects by using explicit configuration:\n\n` +
        `const { worker, dos } = instrumentDOProject({\n` +
        `  sourceModule,\n` +
        `  doClassNames: [${detectedClasses.map(c => `'${c}'`).join(', ')}]  // <-- Keep only the DO classes\n` +
        `});\n\n` +
        `export const { ${detectedClasses.join(', ')} } = dos;\n` +
        `export default worker;\n`
      );
    }
  }
  
  // Wrap each DO class with lumenizeRpcDO
  const dos: Record<string, any> = {};
  for (const className of doClassNames) {
    const OriginalClass = sourceModule[className];
    if (!OriginalClass) {
      throw new Error(`DO class '${className}' not found in source module. Available exports: ${Object.keys(sourceModule).join(', ')}`);
    }
    dos[className] = lumenizeRpcDO(OriginalClass);
  }
  
  // Get the original worker (if it exists)
  const originalWorker = sourceModule.default;
  
  // Create instrumented worker
  const worker: ExportedHandler = {
    async fetch(request: Request, env: any, ctx: any): Promise<Response> {
      // Try to route RPC requests first
      const rpcResponse = await routeDORequest(request, env, { prefix });
      if (rpcResponse) return rpcResponse;
      
      // If there's an original worker, delegate to it
      if (originalWorker?.fetch) {
        return originalWorker.fetch(request, env, ctx);
      }
      
      // No original worker - return 404
      return new Response('Not found', { status: 404 });
    }
  };
  
  // If original worker has other handlers (scheduled, queue, email, etc.), copy them
  if (originalWorker) {
    if (originalWorker.scheduled) {
      worker.scheduled = originalWorker.scheduled;
    }
    if (originalWorker.queue) {
      worker.queue = originalWorker.queue;
    }
    if (originalWorker.email) {
      worker.email = originalWorker.email;
    }
    if (originalWorker.tail) {
      worker.tail = originalWorker.tail;
    }
    if (originalWorker.trace) {
      worker.trace = originalWorker.trace;
    }
  }
  
  // Create a result object that is both a worker AND has the DOs as properties
  // This allows: export default instrumentDOProject(sourceModule)
  // And wrangler can access the DOs via default.MyDO, default.AnotherDO, etc.
  const result = Object.assign(worker, { worker, dos }) as any;
  
  // Also add each DO as a direct property for convenience
  for (const [name, doClass] of Object.entries(dos)) {
    result[name] = doClass;
  }
  
  return result as InstrumentedDOProject;
}
