/**
 * Operation types that align with JavaScript Proxy traps.
 * These form the building blocks of operation chains.
 */
export type Operation = 
  | { type: 'get', key: string | number | symbol }     // Property/element access
  | { type: 'apply', args: any[] };                    // Function calls

/**
 * Chain of operations to execute on a target object.
 * Operations are executed sequentially, with each operation
 * acting on the result of the previous operation.
 * 
 * @example
 * ```typescript
 * const chain: OperationChain = [
 *   { type: 'get', key: 'someMethod' },
 *   { type: 'apply', args: [1, 2, 3] }
 * ];
 * // Executes: target.someMethod(1, 2, 3)
 * ```
 */
export type OperationChain = Operation[];

/**
 * Internal marker for nested operations during serialization.
 * When a continuation is used as an argument to another continuation,
 * this marker carries the operation chain that needs to be executed first.
 * The executor recursively resolves nested operations before execution.
 * 
 * @internal
 */
export interface NestedOperationMarker {
  __isNestedOperation: true;
  __operationChain: OperationChain;
}

/**
 * Type guard to check if an object is a nested operation marker.
 * Used internally by executors to identify arguments that need recursive execution.
 * 
 * @internal
 */
export function isNestedOperationMarker(obj: any): obj is NestedOperationMarker {
  return obj && typeof obj === 'object' && obj.__isNestedOperation === true;
}

/**
 * Configuration for OCAN execution validation.
 */
export interface OcanConfig {
  /**
   * Maximum depth for operation chains (security limit)
   * @default 50
   */
  maxDepth?: number;
  
  /**
   * Maximum arguments per apply operation (security limit)
   * @default 100
   */
  maxArgs?: number;
}

/**
 * Unwraps protected members (ctx, env) for use with continuation proxies.
 * 
 * When calling remote DOs or accessing protected members via `this.ctn<T>()`,
 * TypeScript complains about accessing protected ctx/env from a different class.
 * The continuation proxy system allows this at runtime, so use this type to
 * satisfy TypeScript.
 * 
 * @example
 * ```typescript
 * import type { Unprotected } from '@lumenize/core';
 * 
 * // Instead of @ts-expect-error:
 * const op = this.ctn<RemoteDO>().ctx.storage.kv.get('key');
 * 
 * // Use Unprotected:
 * const op = this.ctn<Unprotected<RemoteDO>>().ctx.storage.kv.get('key');
 * ```
 * 
 * @typeParam T - The DO class type that extends a base class with protected ctx/env
 */
export type Unprotected<T> = T & {
  readonly ctx: DurableObjectState;
  readonly env: any;
};

