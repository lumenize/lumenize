/**
 * @mesh decorator for marking methods as mesh-callable
 *
 * Methods decorated with `@mesh()` can be called from remote mesh nodes.
 * Without this decorator, methods cannot be invoked via `this.lmz.call()` or `callRaw()`.
 *
 * This provides an explicit security boundary - only methods you explicitly
 * mark as mesh-callable can be invoked remotely.
 *
 * Uses TC39 Stage 3 decorator format (TypeScript 5.0+, ES2022).
 */

/**
 * Symbol used to mark methods as mesh-callable
 * @internal
 */
export const MESH_CALLABLE = Symbol.for('lumenize.mesh.callable');

/**
 * Symbol used to store the guard function on a method
 * @internal
 */
export const MESH_GUARD = Symbol.for('lumenize.mesh.guard');

/**
 * Guard function type for `@mesh()` decorator
 *
 * The guard is called with the instance before the method executes.
 * Throw an error to reject the call, or return void to allow it.
 *
 * Access `this.lmz.callContext` in the guard to check authentication/authorization.
 */
export type MeshGuard<T = any> = (instance: T) => void | Promise<void>;

/**
 * Check if a method is mesh-callable
 *
 * @param method - The method to check
 * @returns true if the method is decorated with `@mesh`
 * @internal
 */
export function isMeshCallable(method: any): boolean {
  return typeof method === 'function' && (method as any)[MESH_CALLABLE] === true;
}

/**
 * Get the guard function for a mesh-callable method
 *
 * @param method - The method to get the guard for
 * @returns The guard function, or undefined if no guard is set
 * @internal
 */
export function getMeshGuard<T>(method: any): MeshGuard<T> | undefined {
  if (typeof method === 'function') {
    return (method as any)[MESH_GUARD];
  }
  return undefined;
}

/**
 * Mark a standalone function as mesh-callable.
 *
 * Use this for functions that aren't class methods but need to be mesh-callable,
 * such as functions stored in object properties.
 *
 * @example
 * ```typescript
 * const nested = {
 *   deep: {
 *     method: meshFn((x: number) => x * 3)
 *   }
 * };
 * ```
 *
 * @param fn - The function to mark as mesh-callable
 * @returns The same function, marked as mesh-callable
 */
export function meshFn<F extends (...args: any[]) => any>(fn: F): F {
  (fn as any)[MESH_CALLABLE] = true;
  return fn;
}

/**
 * `@mesh()` decorator for marking methods as mesh-callable
 *
 * Use this decorator on methods that should be callable from remote mesh nodes.
 * Methods without this decorator cannot be invoked via `this.lmz.call()` or `callRaw()`.
 *
 * Uses TC39 Stage 3 decorator format (TypeScript 5.0+, ES2022).
 *
 * @example
 * Basic usage - mark a method as mesh-callable:
 * ```typescript
 * class DocumentDO extends LumenizeDO<Env> {
 *   @mesh()
 *   getContent(): string {
 *     return this.svc.sql`SELECT content FROM documents LIMIT 1`[0]?.content ?? '';
 *   }
 *
 *   // This method CANNOT be called remotely - not decorated
 *   internalHelper(): void {
 *     // ...
 *   }
 * }
 * ```
 *
 * @example
 * With guard function - add per-method authorization:
 * ```typescript
 * class SecureDocumentDO extends LumenizeDO<Env> {
 *   @mesh((instance: SecureDocumentDO) => {
 *     // Guard runs before the method executes
 *     const { originAuth } = instance.lmz.callContext;
 *     if (!originAuth?.userId) {
 *       throw new Error('Authentication required');
 *     }
 *   })
 *   updateContent(content: string): void {
 *     this.svc.sql`UPDATE documents SET content = ${content}`;
 *   }
 *
 *   @mesh() // No guard - anyone can read
 *   getContent(): string {
 *     return this.svc.sql`SELECT content FROM documents LIMIT 1`[0]?.content ?? '';
 *   }
 * }
 * ```
 *
 * @param guard - Optional guard function called before method execution.
 *                Throw an error to reject the call, or return void to allow it.
 * @returns A decorator that marks the method as mesh-callable
 */
export function mesh<T = any>(
  guard?: MeshGuard<T>
): <This, Args extends any[], Return>(
  target: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
) => (this: This, ...args: Args) => Return {
  return function <This, Args extends any[], Return>(
    target: (this: This, ...args: Args) => Return,
    _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
  ): (this: This, ...args: Args) => Return {
    // Mark the method as mesh-callable
    (target as any)[MESH_CALLABLE] = true;
    // Store the guard if provided
    if (guard) {
      (target as any)[MESH_GUARD] = guard;
    }
    return target;
  };
}
