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
 * The doors JavaScript opens on EVERY object, which no amount of careful authoring removes.
 *
 * `Object.getOwnPropertyNames(Object.prototype)` returns twelve names in workerd and in Node; six
 * are benign and stay reachable (`hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`,
 * `toString`, `toLocaleString`, `valueOf`). These are the other six, and they matter for two
 * different reasons. `constructor` and `__proto__` reach a facade's own class and prototype, which
 * is enough to pollute every instance of that facade. The four Annex-B accessors are worse than
 * they look: `__lookupGetter__('__proto__')` hands back the `__proto__` getter, a third named route
 * to the same place without naming either of the first two keys — and `__defineGetter__` /
 * `__defineSetter__` are the only property WRITES a chain can name, since a chain expresses `get`
 * and `apply` only but a write reached as a method call is still a write.
 *
 * ⚠️ **Naming keys is not a deny-list of the kind that rots** — the language spec fixes what every
 * object carries, so the list is closed. Refusing every `__`-prefixed key instead is NOT available:
 * `__executeOperation`, `__handleResponse` and `__handleProxyFetchResult` are all real mesh
 * members.
 *
 * @internal
 */
const FENCED_KEYS: ReadonlySet<string> = new Set([
  'constructor',
  '__proto__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__defineGetter__',
  '__defineSetter__',
]);

/**
 * Whether reading `key` off `owner` resolves on `Function.prototype`.
 *
 * The design encourages a gate to hand back methods, which is exactly what makes `call`, `bind` and
 * `apply` reachable from whatever it returns — so this clause is the price of that recommendation.
 * Walks own-property by own-property rather than reading the member, so a getter anywhere on the
 * chain is never invoked to answer the question.
 *
 * @internal
 */
function resolvesOnFunctionPrototype(owner: any, key: string | number | symbol): boolean {
  if (owner === null || owner === undefined) return false;
  let o: any = owner;
  while (o !== null && o !== undefined) {
    if (Object.prototype.hasOwnProperty.call(o, key)) return o === Function.prototype;
    o = Object.getPrototypeOf(o);
  }
  return false;
}

/**
 * Find the member `key` names on `target`, by DESCRIPTOR rather than by reading it.
 *
 * ⚠️ **Reading the member is what this exists to avoid.** `parent[key]` on a getter without
 * `@mesh()` RUNS the getter — the very code the entry rule is deciding whether to admit — so the
 * lookup walks the prototypes with `Object.getOwnPropertyDescriptor` instead. A method and a getter
 * both live there, and `@mesh()` sets its flag on either one's function value; an own data property
 * (a DO's `ctx` and `env` are constructor-assigned ones) is found too, and never carries the flag.
 *
 * @returns the first owner that has the key, or `undefined` if nothing does.
 * @internal
 */
function findMember(
  target: any,
  key: string | number | symbol
): { owner: any; descriptor: PropertyDescriptor } | undefined {
  let o: any = target;
  while (o !== null && o !== undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(o, key);
    if (descriptor) return { owner: o, descriptor };
    o = Object.getPrototypeOf(o);
  }
  return undefined;
}

/** The function a descriptor carries the `@mesh()` flag on: a getter's getter, or a method's value. */
function decoratedFunctionOf(descriptor: PropertyDescriptor): any {
  return descriptor.get ?? descriptor.value;
}

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

  // Two shapes the executor cannot mean, and which used to FALL THROUGH rather than refuse: an
  // empty chain handed back the target object itself, and an apply-first chain CALLED a function
  // target. Both are refusals now, each on its own message.
  if (operations.length === 0) {
    throw new Error('Invalid operation chain: a chain must have at least one operation');
  }
  if (operations[0]?.type !== 'get') {
    throw new Error('Invalid operation chain: the first operation must be a get, not an apply');
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
  // walk rather than recomputed, which is what stops an earlier op being RE-EXECUTED to find it:
  // a gate body runs once per chain rather than once per later apply.
  //
  // ⚠️ Precisely: no op is re-EXECUTED. An `apply` still READS its method off the parent a second
  // time (`parent[prevOp.key]`), which is free for a method and would invoke a getter twice — a
  // chain that applies a getter's value directly. Kept because the property-call form is what
  // works for a Workers RPC stub method, where extracting the function first does not.
  let parent: any = target;
  // THE ENTRY RULE. Op 0 of a wire-borne chain must name a method or getter the host class
  // decorated with `@mesh()`, and that op is where the guard runs. `requireMeshDecorator: false`
  // is the carve-out for a chain the NODE authored itself — a `$result` handler, a stored alarm
  // continuation — which may root anywhere, including `ctx` and `svc`.
  if (finalConfig.requireMeshDecorator) {
    const entry = operations[0];
    // validateOperationChain has already refused an apply-first chain, so op 0 is a get.
    const key = (entry as { key: string | number | symbol }).key;
    const found = findMember(target, key);
    const fn = found ? decoratedFunctionOf(found.descriptor) : undefined;

    if (!isMeshCallable(fn)) {
      // THREE causes, three messages, because each has a DIFFERENT fix and only the author can
      // apply it. Collapsing them is what made the middle one's advice — "add the decorator" —
      // arrive for a member that does not exist, which is advice nobody can follow.
      //
      // ⚠️ This deliberately discloses whether a member exists. The alternative was one uniform
      // refusal, and it buys almost nothing: mesh is published MIT, so a node's member names are
      // readable by anyone who cares, and a caller can already probe by calling. What it costs is
      // real — the commonest authoring mistake becomes undiagnosable from the message.
      if (!found) {
        throw new Error(
          `No member named '${String(key)}' exists on this node. ` +
          `Check the spelling, and the type argument to ctn<T>().`
        );
      }
      // An OVERRIDE is the case worth naming apart. `@mesh()` sets its flag on the function value,
      // so a subclass method that shadows a decorated one is a new function carrying nothing — and
      // the failure is otherwise silent all the way down: the refusal is caught, shipped over the wire,
      // and dropped by a name-guard that does not match, while whatever awaited the handler hangs.
      const shadowed = findMember(Object.getPrototypeOf(found.owner), key);
      if (shadowed && isMeshCallable(decoratedFunctionOf(shadowed.descriptor))) {
        throw new Error(
          `Member '${String(key)}' overrides a mesh-callable member but is not itself decorated with @mesh(). ` +
          `Add the @mesh decorator to the override.`
        );
      }
      throw new Error(
        `Member '${String(key)}' is not mesh-callable. ` +
        `Add the @mesh decorator to allow remote calls.`
      );
    }

    const entryGuard = getMeshGuard(fn);
    if (entryGuard) {
      entryGuard(target);
    }
  }

  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    const previous = current;

    if (operation.type === 'get') {
      // THE WALK RULES. Unconditional by design: they are not the member-level check, so the flag
      // that turns that off must not turn these off — what they refuse is never legitimate, whoever
      // authored the chain, and nothing legitimate roots at these keys (a node's own continuation
      // roots at `ctx`, `svc`, or a method name). They run from op 0, because on the response,
      // alarm and local-handler legs the entry rule is switched off and a chain whose FIRST op
      // names `constructor` would otherwise meet no rule at all.
      if (FENCED_KEYS.has(String(operation.key))) {
        throw new Error(
          `Operation '${String(operation.key)}' is refused: it is a door JavaScript opens on every ` +
          `object, and a continuation may not name one.`
        );
      }
      if (resolvesOnFunctionPrototype(current, operation.key)) {
        throw new Error(
          `Operation '${String(operation.key)}' is refused: it resolves on Function.prototype, ` +
          `which a continuation may not reach.`
        );
      }
      // Property/element access
      current = current[operation.key];
    } else if (operation.type === 'apply') {
      // Function call
      if (typeof current !== 'function') {
        throw new Error(`TypeError: ${String(current)} is not a function`);
      }

      const prevOp = i > 0 ? operations[i - 1] : null;

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

