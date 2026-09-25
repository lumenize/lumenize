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
  return walkChain(operations, target, config, false);
}

/**
 * Execute a chain whose final `apply` has ALREADY been filled with a result — the second of the
 * two entry points, and the one that treats that argument list as DATA.
 *
 * A handler chain is populated by {@link replaceNestedOperationMarkers} before it runs: markers in
 * the last `apply` are replaced with the result, or the result is appended there when the handler
 * spells none. Running the template's fill step again over an ARRIVAL is what let a reply the far
 * side authored be re-read as a nested marker and executed — any chain at all, on the node, with
 * the member-level check off. So a filled chain does not resolve nesting in that one position.
 *
 * **Two named entries rather than a flag.** Which one a site wants is static at every call site, so
 * a named entry cannot be forgotten or inverted the way a defaulted boolean can. Both share one
 * walk, so the entry rule and the walk rules still live in one place.
 *
 * ⚠️ **Only the FINAL apply stops resolving.** An earlier apply may carry a marker the author
 * genuinely nested — `ctn().a(ctn().x()).b($result)` — and that one still resolves.
 *
 * @see docs/adr/002-structured-clone-everywhere.md — a result carrying those keys must arrive
 *      intact and unexecuted, which is why the cure is to stop resolving rather than to strip or
 *      rename them.
 * @internal
 */
export async function executeFilledChain(
  operations: OperationChain,
  target: any,
  config?: OcanConfig
): Promise<any> {
  return walkChain(operations, target, config, true);
}

/**
 * The one walk both entry points share.
 *
 * @param filled - true when the chain's final `apply` holds a substituted result rather than a
 *                 template's arguments, so that position is not scanned for nested markers.
 * @internal
 */
async function walkChain(
  operations: OperationChain,
  target: any,
  config: OcanConfig | undefined,
  filled: boolean
): Promise<any> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Validate before execution
  validateOperationChain(operations, config);

  let current: any = target;  // the value produced by the op just executed
  // The value one op BEHIND `current` — what a method call binds `this` to. Carried along the
  // walk rather than recomputed, which is what makes each op run exactly once. It starts at the
  // target so an apply-first chain calls the target with itself as `this`, as it always has.
  let parent: any = target;
  let entryPointChecked = false; // Track if we've checked the entry point

  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    const previous = current;

    if (operation.type === 'get') {
      // Property/element access
      current = current[operation.key];
    } else if (operation.type === 'apply') {
      // Function call
      if (typeof current !== 'function') {
        throw new Error(`TypeError: ${String(current)} is not a function`);
      }

      const prevOp = i > 0 ? operations[i - 1] : null;

      // Check @mesh decorator on entry point method (first apply operation)
      if (finalConfig.requireMeshDecorator && !entryPointChecked) {
        entryPointChecked = true;

        // Skip @mesh check for service methods (svc.*)
        // Service methods are trusted internal framework methods
        const isServiceCall = operations[0]?.type === 'get' && operations[0]?.key === 'svc';

        if (prevOp?.type === 'get' && !isServiceCall) {
          // `current` IS `parent[prevOp.key]` — the value the preceding get produced — so the
          // check reads the member the walk already holds instead of reading it a second time.
          if (!isMeshCallable(current)) {
            throw new Error(
              `Method '${String(prevOp.key)}' is not mesh-callable. ` +
              `Add the @mesh decorator to allow remote calls.`
            );
          }

          // Execute guard if present
          const guard = getMeshGuard(current);
          if (guard) {
            guard(target);
          }
        }
      }

      // Process arguments to resolve any nested operation markers. A FILLED chain's last apply is
      // where the substitution wrote, so its arguments are data and are passed through untouched.
      const isSubstitutedApply = filled && i === operations.length - 1;
      const resolvedArgs = isSubstitutedApply
        ? operation.args
        : await resolveNestedOperations(operation.args, target, config);

      // Call the method on its parent object to preserve 'this' context.
      // This works for both regular methods and Workers RPC stub methods.
      if (prevOp?.type === 'get') {
        // Previous operation was property access, call as method
        current = await parent[prevOp.key](...resolvedArgs);
      } else {
        // Direct function call (no property access), use apply
        current = await current.apply(parent, resolvedArgs);
      }
    }

    parent = previous;
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

