/**
 * `rawRpcStub` — the caller half of the bridge by which our own code reaches a mesh node for an
 * operation no client may call (ADR-023), and the subpath `@lumenize/mesh/raw-rpc` that carries it.
 *
 * ```ts
 * await rawRpcStub('GALAXY', 'acme.crm').teardown('deletion', operationId);
 * ```
 *
 * The stub turns each method into one Workers RPC call to the node's `__rawRpc` entry, passing the
 * binding and instance name so the entry can stamp the node's identity as the mesh path does. Its
 * type comes from the generated `Env`, which types `GALAXY` as `DurableObjectNamespace<Galaxy>`, so a
 * misspelled binding, method or argument fails to compile. It reads `env` from `cloudflare:workers`,
 * so only code running in our Worker can call it: a user-developer's code never runs there.
 *
 * A light subpath: its graph holds no node class, so a package's light index can import it.
 */
import { env } from 'cloudflare:workers';

export { rawRpc } from './raw-rpc-decorator.js';

/** The bindings in the generated `Env` that name a Durable Object namespace. */
type DurableObjectBindings = {
  [K in keyof Cloudflare.Env]: Cloudflare.Env[K] extends DurableObjectNamespace<any> ? K : never
}[keyof Cloudflare.Env];

/** The node class a binding names — distributed, so a union of bindings yields the union of their
 *  classes, whose shared methods (a base class's, say) the stub then offers. */
type NodeOf<B extends DurableObjectBindings> =
  B extends unknown ? (Cloudflare.Env[B] extends DurableObjectNamespace<infer T> ? T : never) : never;

/** Every method of the node, made async as Workers RPC makes it. The entry admits only the
 *  `@rawRpc()`-decorated ones, which a type cannot see. */
export type RawRpcSurface<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? K : never]:
    T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never
};

/** A stub for the node `binding` names at `instanceName`, whose methods reach its `__rawRpc` entry. */
export function rawRpcStub<B extends DurableObjectBindings>(binding: B, instanceName: string): RawRpcSurface<NodeOf<B>> {
  const namespace = (env as unknown as Record<string, unknown>)[binding as string] as DurableObjectNamespace | undefined;
  if (!namespace) throw new Error(`rawRpcStub: this Worker binds no "${String(binding)}"`);
  const stub = namespace.getByName(instanceName) as unknown as {
    __rawRpc(binding: string, instanceName: string, method: string, args: unknown[]): Promise<unknown>;
  };
  return new Proxy({}, {
    get: (_target, method) => {
      // Never a thenable: `await rawRpcStub(...)` must not call a remote method named `then`.
      if (typeof method !== 'string' || method === 'then') return undefined;
      return (...args: unknown[]) => stub.__rawRpc(binding as string, instanceName, method, args);
    },
  }) as RawRpcSurface<NodeOf<B>>;
}
