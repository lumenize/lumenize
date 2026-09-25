// ============================================
// Continuation Types
// ============================================

/**
 * Brand marker for continuation types. All continuations have this marker,
 * enabling type-safe assignability checks.
 *
 * @internal - Use AnyContinuation or Continuation<T> instead
 */
declare const ContinuationBrand: unique symbol;

/** @internal */
export type ContinuationBrandType = typeof ContinuationBrand;

/**
 * Base type that any continuation can be assigned to.
 * Use this in function signatures that accept any continuation.
 */
export type AnyContinuation = { readonly [ContinuationBrand]: unknown };

/**
 * Helper type that allows either a value or a continuation that resolves to that value.
 * This enables nesting continuations as arguments to continuation methods.
 *
 * @example
 * ```typescript
 * // Both of these are valid:
 * this.ctn<Calculator>().add(1, 2)              // literal numbers
 * this.ctn<Calculator>().add(
 *   this.ctn<Calculator>().getValue(),          // Continuation<number> also accepted
 *   this.ctn<Calculator>().getValue()
 * )
 * ```
 */
type AllowContinuation<T> = T | Continuation<T>;

/**
 * Maps a tuple of argument types to allow continuations for each argument.
 * Handles rest parameters by checking for array types at the end.
 */
type AllowContinuationArgs<Args extends any[]> = {
  [K in keyof Args]: AllowContinuation<Args[K]>;
};

/**
 * Helper type that maps methods to return Continuation<ReturnType>.
 * Method arguments accept either the original type or a Continuation<T> that
 * resolves to that type, enabling nested continuation operations.
 * Only applied to object types (not primitives).
 */
type ContinuationMethods<T> = T extends object
  ? {
      [K in keyof T]: T[K] extends (...args: infer A) => infer R
        ? (...args: AllowContinuationArgs<A>) => Continuation<R>
        : never;
    }
  : unknown;

/**
 * Continuation type that wraps an object type so that all method calls
 * return `Continuation<ReturnType>` for type-safe chaining.
 *
 * The `$result` property is a placeholder for nested operations - use it
 * when you need to pass the result of an async operation as an argument
 * to a continuation method.
 *
 * @example
 * ```typescript
 * // this.ctn<RemoteDO>().getData(id) returns Continuation<DataType>
 * const remote = this.ctn<RemoteDO>().getData(id);
 * this.lmz.call('REMOTE_DO', instanceId, remote);
 *
 * // Using $result placeholder for async results:
 * this.svc.fetch.proxy(url, this.ctn().handleResult(this.ctn().$result));
 * ```
 */
export type Continuation<T> = {
  readonly [ContinuationBrand]: T;
  /**
   * Placeholder for the result of a nested async operation.
   * Used when passing the result of an operation (like fetch) as an argument
   * to a continuation method. The placeholder is replaced with the actual
   * result at execution time via `replaceNestedOperationMarkers`.
   *
   * Typed as `any` because the actual type depends on what operation fills it.
   */
  readonly $result: any;
} & ContinuationMethods<T>;

// ============================================
// Operation Chain Types
// ============================================

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
 * For RPC deduplication, markers can include a `__refId` to reference
 * previously transmitted operation chains (avoiding duplication).
 * 
 * @internal
 */
export interface NestedOperationMarker {
  __isNestedOperation: true;
  __operationChain?: OperationChain;
  __refId?: string;
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

  /**
   * Require the chain's ENTRY OP to name a mesh-callable member.
   *
   * When true, `operations[0]` must name a member — a method or a getter — the host class marked
   * with `@mesh()`, looked up by descriptor so an unmarked getter is refused without running.
   * That op is also where the member's guard runs.
   *
   * Set false only for a chain the NODE authored itself (a `$result` handler, a stored alarm
   * continuation); those may root anywhere, including `ctx` and `svc`.
   *
   * ⚠️ It does NOT turn off the walk rules. `constructor`, `__proto__`, the four Annex-B accessors
   * and anything resolving on `Function.prototype` are refused at every setting, on every leg.
   *
   * @default true (secure by default)
   */
  requireMeshDecorator?: boolean;
}
