/**
 * The `@rawRpc()` decorator — the callee half of the bridge by which our own code reaches a mesh
 * node for an operation no client may call (ADR-023).
 *
 * A method carries `@mesh()` or `@rawRpc()`, never both: `@mesh()` opens a method to every caller
 * its guard admits, and `@rawRpc()` opens it only to code holding the node's binding, which exists
 * only in our Worker's `env`. The entry that serves it is `__rawRpc` on `ComposedMeshDO`; the caller
 * half is `rawRpcStub`, from `@lumenize/mesh/raw-rpc`.
 *
 * Pure: no `cloudflare:workers`, so the module graph a client bundle pulls through `lmz-api` stays
 * clean.
 */

/**
 * Symbol `@rawRpc()` sets on a method's function.
 * @internal
 */
export const RAW_RPC_CALLABLE = Symbol.for('lumenize.mesh.rawRpc');

/**
 * `@rawRpc()` — make a method reachable through `rawRpcStub`, and through nothing else.
 *
 * Methods only: a getter would run on lookup, before the entry could decide anything.
 */
export function rawRpc() {
  return function <This, Args extends any[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ): (this: This, ...args: Args) => Return {
    if (context.kind !== 'method') throw new Error('@rawRpc() decorates a method');
    (target as any)[RAW_RPC_CALLABLE] = true;
    return target;
  };
}

/**
 * The `@rawRpc()`-decorated method `name` names on `instance`, found on its prototype chain without
 * invoking a getter, or `undefined`. One name, never a path: `a.b` is looked up as a property named
 * `a.b`, which no class declares.
 * @internal
 */
export function findRawRpcMethod(instance: object, name: unknown): ((...args: any[]) => unknown) | undefined {
  if (typeof name !== 'string') return undefined;
  for (let proto = Object.getPrototypeOf(instance); proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor) continue;
    const fn = descriptor.value;
    return typeof fn === 'function' && fn[RAW_RPC_CALLABLE] === true ? fn : undefined;
  }
  return undefined;
}
