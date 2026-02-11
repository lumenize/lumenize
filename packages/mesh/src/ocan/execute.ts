import type { Operation, OperationChain, OcanConfig, NestedOperationMarker } from './types.js';
import { isNestedOperationMarker } from './types.js';
import { isMeshCallable, getMeshGuard } from '../mesh-decorator.js';

/**
 * Default OCAN configuration
 */
const DEFAULT_CONFIG: Required<OcanConfig> = {
  maxDepth: 50,
  maxArgs: 100,
  requireMeshDecorator: true,  // Secure by default - only @mesh decorated methods are callable
};

/**
 * Validate an operation chain against security limits.
 * Throws if validation fails.
 * 
 * @param operations - The operation chain to validate
 * @param config - Configuration with security limits
 * @throws {Error} If chain is too deep or has too many arguments
 * 
 * @internal
 */
export function validateOperationChain(
  operations: OperationChain,
  config: OcanConfig = {}
): void {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  
  if (!Array.isArray(operations)) {
    throw new Error('Invalid operation chain: operations must be an array');
  }
  
  if (operations.length > finalConfig.maxDepth) {
    throw new Error(`Operation chain too deep: ${operations.length} > ${finalConfig.maxDepth}`);
  }
  
  for (const operation of operations) {
    if (operation.type === 'apply' && operation.args.length > finalConfig.maxArgs) {
      throw new Error(`Too many arguments: ${operation.args.length} > ${finalConfig.maxArgs}`);
    }
  }
}

/**
 * Execute an operation chain on a target object.
 * 
 * Operations are executed sequentially, with each operation acting on
 * the result of the previous operation. The chain starts with the target object.
 * 
 * Supports nested operations - when a NestedOperationMarker is encountered
 * in arguments, it is recursively executed and its result is substituted.
 * 
 * @param operations - The operation chain to execute
 * @param target - The target object to execute operations on
 * @param config - Optional configuration for validation
 * @returns The result of executing the operation chain
 * @throws {Error} If execution fails or validation fails
 * 
 * @example
 * ```typescript
 * const operations: OperationChain = [
 *   { type: 'get', key: 'someMethod' },
 *   { type: 'apply', args: [1, 2, 3] }
 * ];
 * 
 * const result = await executeOperationChain(operations, myObject);
 * // Equivalent to: await myObject.someMethod(1, 2, 3)
 * ```
 */
export async function executeOperationChain(
  operations: OperationChain,
  target: any,
  config?: OcanConfig
): Promise<any> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Validate before execution
  validateOperationChain(operations, config);

  let current: any = target; // Start from the target object
  let entryPointChecked = false; // Track if we've checked the entry point

  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];

    if (operation.type === 'get') {
      // Property/element access
      current = current[operation.key];
    } else if (operation.type === 'apply') {
      // Function call
      if (typeof current !== 'function') {
        throw new Error(`TypeError: ${String(current)} is not a function`);
      }

      // Check @mesh decorator on entry point method (first apply operation)
      if (finalConfig.requireMeshDecorator && !entryPointChecked) {
        entryPointChecked = true;
        const prevOp = i > 0 ? operations[i - 1] : null;

        // Skip @mesh check for service methods (svc.*)
        // Service methods are trusted internal framework methods
        const isServiceCall = operations[0]?.type === 'get' && operations[0]?.key === 'svc';

        if (prevOp?.type === 'get' && !isServiceCall) {
          const methodName = prevOp.key;
          // Find the parent object that contains this method
          const parent = findParentObject(operations.slice(0, i), target);
          const method = parent[methodName];

          // Check if method has @mesh decorator
          if (!isMeshCallable(method)) {
            throw new Error(
              `Method '${String(methodName)}' is not mesh-callable. ` +
              `Add the @mesh decorator to allow remote calls.`
            );
          }

          // Execute guard if present
          const guard = getMeshGuard(method);
          if (guard) {
            await guard(target);
          }
        }
      }

      // Process arguments to resolve any nested operation markers
      const resolvedArgs = await resolveNestedOperations(operation.args, target, config);

      // Call the method on its parent object to preserve 'this' context.
      // This works for both regular methods and Workers RPC stub methods.
      const parent = findParentObject(operations.slice(0, i), target);
      const prevOp = i > 0 ? operations[i - 1] : null;

      if (prevOp?.type === 'get') {
        // Previous operation was property access, call as method
        const methodName = prevOp.key;
        current = await parent[methodName](...resolvedArgs);
      } else {
        // Direct function call (no property access), use apply
        current = await current.apply(parent, resolvedArgs);
      }
    }
  }

  return current;
}

/**
 * Resolve nested operation markers in arguments.
 * Recursively executes any nested operations and substitutes their results.
 * 
 * IMPORTANT: This function preserves object/array identity when there are no
 * nested markers to resolve. This is crucial for Map/Set key/value identity.
 * 
 * @internal
 */
async function resolveNestedOperations(
  args: any[],
  target: any,
  config?: OcanConfig
): Promise<any[]> {
  // First pass: check if there are any nested markers at all
  let hasNestedMarkers = false;
  
  function checkForMarkers(value: any, seen = new WeakSet()): boolean {
    if (isNestedOperationMarker(value)) {
      return true;
    }
    
    // Handle circular references - if we've seen this object, skip it
    if (value && typeof value === 'object') {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
    }
    
    if (Array.isArray(value)) {
      return value.some(v => checkForMarkers(v, seen));
    }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.values(value).some(v => checkForMarkers(v, seen));
    }
    return false;
  }
  
  hasNestedMarkers = args.some(v => checkForMarkers(v));
  
  // If no nested markers, return args as-is to preserve identity
  if (!hasNestedMarkers) {
    return args;
  }
  
  // Second pass: resolve nested markers
  const resolved: any[] = [];
  
  for (const arg of args) {
    if (isNestedOperationMarker(arg)) {
      // Execute the nested operation chain and use its result
      if (!arg.__operationChain) {
        throw new Error('Invalid nested operation marker: missing __operationChain');
      }
      const nestedResult = await executeOperationChain(
        arg.__operationChain,
        target,
        config
      );
      resolved.push(nestedResult);
    } else if (Array.isArray(arg)) {
      // Recursively process arrays
      const resolvedArray = await resolveNestedOperations(arg, target, config);
      // If the array wasn't modified (same reference), use original
      resolved.push(resolvedArray === arg ? arg : resolvedArray);
    } else if (arg && typeof arg === 'object' && Object.getPrototypeOf(arg) === Object.prototype) {
      // Recursively process plain objects
      let hasChanges = false;
      const resolvedObj: any = {};
      for (const [key, value] of Object.entries(arg)) {
        if (isNestedOperationMarker(value)) {
          if (!value.__operationChain) {
            throw new Error('Invalid nested operation marker: missing __operationChain');
          }
          resolvedObj[key] = await executeOperationChain(
            value.__operationChain,
            target,
            config
          );
          hasChanges = true;
        } else if (Array.isArray(value)) {
          const resolvedValue = await resolveNestedOperations(value, target, config);
          resolvedObj[key] = resolvedValue;
          if (resolvedValue !== value) hasChanges = true;
        } else {
          resolvedObj[key] = value;
        }
      }
      // If nothing changed, use original object to preserve identity
      resolved.push(hasChanges ? resolvedObj : arg);
    } else {
      // Primitive or built-in type, pass through
      resolved.push(arg);
    }
  }
  
  return resolved;
}

/**
 * Find the parent object for a method call by executing all operations
 * up to (but not including) the last operation.
 * 
 * @internal
 */
function findParentObject(operations: OperationChain, target: any): any {
  if (operations.length === 0) return target;
  
  let parent: any = target;
  // Execute all operations except the last one to find the parent
  for (const operation of operations.slice(0, -1)) {
    if (operation.type === 'get') {
      parent = parent[operation.key];
    } else if (operation.type === 'apply') {
      // For apply operations, we need to execute them to get the result
      // Note: This is synchronous execution for parent lookup
      const grandParent = findParentObject(operations.slice(0, operations.indexOf(operation)), target);
      parent = parent.apply(grandParent, operation.args);
    }
  }
  return parent;
}

/**
 * Replace nested operation markers in a continuation chain with an actual result value.
 * 
 * This is used by actor-model systems (this.lmz.call(), @lumenize/fetch) where
 * a continuation handler needs to receive the result of an async operation.
 * 
 * Supports two patterns:
 * 1. **Nested markers**: Explicit nested operation as argument (explicit `$result` placement)
 * 2. **Last-argument convention**: Result injected as last argument if no markers (implicit)
 * 
 * @param chain - The continuation operation chain (typically stored in pending state)
 * @param resultValue - The actual result value to inject
 * @returns A new operation chain with markers replaced by the result
 * 
 * @example
 * Explicit marker pattern:
 * ```typescript
 * const remote = this.ctn<RemoteDO>().getData();
 * const handler = this.ctn().ctx.storage.kv.put('cache', remote);
 * this.lmz.call('REMOTE_DO', 'id', remote, handler);
 * 
 * // Handler chain: [get:ctx, get:storage, get:kv, apply:['cache', NestedMarker]]
 * const finalChain = replaceNestedOperationMarkers(handler, actualData);
 * // Result: [get:ctx, get:storage, get:kv, apply:['cache', actualData]]
 * ```
 * 
 * @example
 * Implicit last-argument convention:
 * ```typescript
 * const handler = this.ctn().handleResponse({ userId: '123' });
 * await proxyFetch(this, url, handler);
 * 
 * // Handler chain: [get:handleResponse, apply:[{ userId: '123' }]]
 * const finalChain = replaceNestedOperationMarkers(handler, response);
 * // Result: [get:handleResponse, apply:[{ userId: '123' }, response]]
 * ```
 */
export function replaceNestedOperationMarkers(
  chain: OperationChain,
  resultValue: any
): OperationChain {
  return chain.map((op, i) => {
    if (op.type === 'apply' && i === chain.length - 1) {
      // Only process the last apply operation (the actual handler call)
      
      // Check if any arguments contain nested operation markers
      let hasNestedMarker = false;
      const args = op.args.map((arg: any) => {
        if (isNestedOperationMarker(arg)) {
          hasNestedMarker = true;
          // Replace this marker with the actual result
          return resultValue;
        }
        return arg;
      });
      
      // If no nested markers found, use last-argument convention
      // (result is injected as last argument)
      if (!hasNestedMarker) {
        return {
          ...op,
          args: [...op.args, resultValue]
        };
      }
      
      // Nested markers were replaced
      return {
        ...op,
        args
      };
    }
    return op;
  });
}

