/**
 * @mesh decorator for marking members as mesh-callable
 *
 * Members decorated with `@mesh()` can be reached from remote mesh nodes.
 * Without this decorator, methods cannot be invoked via `this.lmz.call()`.
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
export type MeshGuard<T = any> = (instance: T) => void;

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

export interface MeshDecorator<T> {
  /** A METHOD entry — the default, and right for any entry that takes arguments. */
  <This extends T, Args extends any[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
  ): (this: This, ...args: Args) => Return;
  /** A GETTER entry — the form for a GATE, which returns a capability surface and does nothing else. */
  <This extends T, Return>(
    target: (this: This) => Return,
    context: ClassGetterDecoratorContext<This, Return>
  ): (this: This) => Return;
}

/**
 * `@mesh()` decorator for marking a member as mesh-callable
 *
 * Use this decorator on methods that should be callable from remote mesh nodes.
 * Methods without this decorator cannot be invoked via `this.lmz.call()`.
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
 *     if (!originAuth?.sub) {
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
 * @param guard - Optional guard function called at the chain's ENTRY op, before the member runs.
 *                Throw an error to reject the call, or return void to allow it.
 * @returns A decorator that marks the member as mesh-callable
 */
export function mesh<T = any>(guard?: MeshGuard<T>): MeshDecorator<T> {
  return function (target: any, _context: any): any {
    // Mark the member as mesh-callable. A method and a getter both carry the mark on their
    // FUNCTION value, which is what lets one decorator serve both.
    //
    // ⚠️ The guard is deliberate: an `accessor` hands the decorator `{ get, set }` and a field hands
    // it `undefined`, and neither kind ships. Marking the wrapper would make `isMeshCallable` answer
    // false anyway, but silently — so nothing is marked, and the entry rule refuses the chain at
    // runtime. The signature above is what refuses them at COMPILE time, which is the primary net;
    // this is what stops a compile-only check from being the only one.
    if (typeof target !== 'function') return target;
    (target as any)[MESH_CALLABLE] = true;
    if (guard) {
      (target as any)[MESH_GUARD] = guard;
    }
    return target;
  } as MeshDecorator<T>;
}
