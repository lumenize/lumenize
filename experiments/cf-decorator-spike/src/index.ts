/**
 * Do `@mesh()` and `@rawRpc()` survive `cf`'s build, deployed?
 *
 * `cf` builds a Worker with Vite, whose bundler (Rolldown) emits TC39 decorators verbatim and still
 * exits 0. `vite.config.ts` puts `unplugin-swc` in front of it. This Worker exercises every shape of
 * decorator the mesh relies on, end to end on the real runtime:
 *
 * - `@rawRpc()` on `Caller.start` / `Caller.results`, reached from the Worker through `rawRpcStub`.
 * - `@mesh()` on a METHOD (`Callee.hello`), reached by a real `lmz.call` from `Caller`.
 * - `@mesh()` on a GETTER gate (`Callee.gate`), chained into a plain surface (`gate.double`).
 * - An UNDECORATED method (`Callee.secret`), which the mesh must refuse. If decorators were dropped
 *   silently, this is the case that would tell: either everything is refused, or nothing is.
 *
 * `/meta` also reads the decorator metadata directly off the prototypes, with no call at all.
 */
import { UnscopedMeshDO, mesh, isMeshCallable } from '@lumenize/mesh';
import { rawRpc, rawRpcStub } from '@lumenize/mesh/raw-rpc';

class Doubler {
  double(n: number): number {
    return n * 2;
  }
}

export class Callee extends UnscopedMeshDO<Env> {
  @mesh()
  hello(who: string): string {
    return `hello, ${who}`;
  }

  @mesh()
  get gate(): Doubler {
    return new Doubler();
  }

  secret(): string {
    return 'should never be reachable over the mesh';
  }
}

type Outcome = { value?: unknown; error?: string };

export class Caller extends UnscopedMeshDO<Env> {
  /** Fires three mesh calls at the `Callee` of the same name; each answer lands in `record`. */
  @rawRpc()
  start(): string {
    const target = this.lmz.instanceName!;
    this.lmz.call('CALLEE', target, this.ctn<Callee>().hello('spike'),
      this.ctn().record('method', this.ctn<Callee>().hello('spike')));
    this.lmz.call('CALLEE', target, this.ctn<Callee>().gate.double(21),
      this.ctn().record('getter', this.ctn<Callee>().gate.double(21)));
    this.lmz.call('CALLEE', target, this.ctn<Callee>().secret(),
      this.ctn().record('undecorated', this.ctn<Callee>().secret()));
    return 'started';
  }

  /** A result handler: no `@mesh()`, reached at the fire-back door. */
  record(label: string, result: unknown): void {
    const outcome: Outcome = result instanceof Error ? { error: result.message } : { value: result };
    this.ctx.storage.kv.put(`r:${label}`, outcome);
  }

  @rawRpc()
  results(): Record<string, Outcome> {
    const out: Record<string, Outcome> = {};
    for (const [k, v] of this.ctx.storage.kv.list<Outcome>({ prefix: 'r:' })) out[k.slice(2)] = v;
    return out;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') ?? crypto.randomUUID();
    if (url.pathname === '/meta') {
      const getter = Object.getOwnPropertyDescriptor(Callee.prototype, 'gate')?.get;
      return Response.json({
        hello: isMeshCallable(Callee.prototype.hello),
        gate: isMeshCallable(getter),
        secret: isMeshCallable(Callee.prototype.secret),
      });
    }
    if (url.pathname === '/start') return Response.json({ id, started: await rawRpcStub('CALLER', id).start() });
    if (url.pathname === '/results') return Response.json(await rawRpcStub('CALLER', id).results());
    return new Response('GET /meta, /start?id=, /results?id=', { status: 404 });
  },
};
