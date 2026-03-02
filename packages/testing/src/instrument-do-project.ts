import { lumenizeRpcDO } from '@lumenize/rpc';
import { routeDORequest } from '@lumenize/routing';

// Import DurableObject base class for prototype chain walking.
// Resolves in vitest-pool-workers; null in Node.js/Bun/browser.
let DurableObjectBase: (abstract new (...args: any[]) => any) | null = null;
try {
  // @ts-ignore — cloudflare:workers resolves in Workers-typed packages but not in testing's own tsconfig
  const mod = await import('cloudflare:workers');
  DurableObjectBase = mod.DurableObject ?? null;
} catch {
  // Not in Cloudflare Workers runtime — fallback to class-count heuristic
}

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
   * Optional - if not provided, will auto-detect using prototype chain walking
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
 * Classify module exports into DO classes and non-DO classes.
 *
 * When `DurableObjectBase` is available (Workers environment), uses `instanceof`
 * to reliably distinguish DOs from WorkerEntrypoints and other classes.
 * Falls back to treating all classes as potential DOs when unavailable.
 */
function classifyExports(sourceModule: any): { doClasses: string[], nonDOClasses: string[] } {
  const doClasses: string[] = [];
  const nonDOClasses: string[] = [];

  for (const [name, value] of Object.entries(sourceModule)) {
    if (name === 'default') continue;
    if (typeof value !== 'function' || !(value as any).prototype) continue;

    if (DurableObjectBase) {
      // Prototype chain walking — reliably distinguishes DOs from other classes
      if ((value as any).prototype instanceof DurableObjectBase) {
        doClasses.push(name);
      } else {
        nonDOClasses.push(name);
      }
    } else {
      // No DurableObject base available — treat all classes as potential DOs
      doClasses.push(name);
    }
  }

  return { doClasses, nonDOClasses };
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

  // Also add DOs and non-DO classes as direct properties for easy access
  [key: string]: any;
}

/**
 * Instruments a DO project for testing by wrapping DO classes with lumenizeRpcDO
 * and creating a worker that routes RPC requests.
 *
 * This eliminates the need for boilerplate test-harness.ts files - the function
 * handles all the instrumentation automatically.
 *
 * **Auto-detection** uses prototype chain walking (`instanceof DurableObject`) to
 * reliably distinguish DOs from WorkerEntrypoints and other class exports. Non-DO
 * classes are automatically passed through (unwrapped) on the result object.
 *
 * **Zero-config (most projects):**
 * ```typescript
 * // test/test-harness.ts — works even with mixed DO + WorkerEntrypoint exports
 * import * as sourceModule from '../src';
 * import { instrumentDOProject } from '@lumenize/testing';
 *
 * export default instrumentDOProject(sourceModule);
 * ```
 *
 * **Explicit configuration (when auto-detection can't determine what to do):**
 * ```typescript
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

  // Classify all exports
  const { doClasses, nonDOClasses } = classifyExports(sourceModule);
  let nonDOClassNames: string[];

  if (!doClassNames || doClassNames.length === 0) {
    // Auto-detect mode
    if (doClasses.length === 0) {
      if (nonDOClasses.length > 0 && DurableObjectBase) {
        throw new Error(
          `No Durable Object classes found in sourceModule.\n` +
          `Found non-DO class exports: ${nonDOClasses.join(', ')}\n` +
          `Make sure your DO classes extend DurableObject from 'cloudflare:workers'.\n\n` +
          `Available exports: ${Object.keys(sourceModule).join(', ')}`
        );
      }
      throw new Error(
        `No class exports found in sourceModule.\n` +
        `Make sure your src/index.ts exports at least one Durable Object class.\n\n` +
        `Available exports: ${Object.keys(sourceModule).join(', ')}`
      );
    }

    if (!DurableObjectBase && doClasses.length > 1) {
      // Without prototype walking, can't distinguish — require explicit config
      throw new Error(
        `Found multiple class exports: ${doClasses.join(', ')}\n\n` +
        `Please specify which are Durable Objects by using explicit configuration:\n\n` +
        `const { worker, dos } = instrumentDOProject({\n` +
        `  sourceModule,\n` +
        `  doClassNames: [${doClasses.map(c => `'${c}'`).join(', ')}]  // <-- Keep only the DO classes\n` +
        `});\n\n` +
        `export const { ${doClasses.join(', ')} } = dos;\n` +
        `export default worker;\n`
      );
    }

    // Auto-detected: all DO classes get wrapped, non-DO classes pass through
    doClassNames = doClasses;
    nonDOClassNames = nonDOClasses;
  } else {
    // Explicit mode — anything not in doClassNames passes through
    const doSet = new Set(doClassNames);
    nonDOClassNames = [...doClasses, ...nonDOClasses].filter(n => !doSet.has(n));
  }

  // Wrap each DO class with lumenizeRpcDO for RPC support
  const dos: Record<string, any> = {};
  for (const className of doClassNames) {
    const OriginalClass = sourceModule[className];
    if (!OriginalClass) {
      throw new Error(`DO class '${className}' not found in source module. Available exports: ${Object.keys(sourceModule).join(', ')}`);
    }

    // Wrap with RPC support
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

  // Add each DO as a direct property for convenience
  for (const [name, doClass] of Object.entries(dos)) {
    result[name] = doClass;
  }

  // Pass through non-DO class exports unwrapped (e.g., WorkerEntrypoints)
  for (const className of nonDOClassNames) {
    result[className] = sourceModule[className];
  }

  return result as InstrumentedDOProject;
}
