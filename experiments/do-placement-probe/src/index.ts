/**
 * Where does a named Durable Object land, given where the code that first touches it runs?
 *
 * Every object and every Worker invocation reports its own colo from Cloudflare's trace endpoint,
 * so nothing here trusts a clock or a guess. Three first-touch paths:
 *
 * - `/local/{name}`: the Worker at the caller's PoP touches `name` (a browser arriving at a host).
 * - `/from-anchor/{anchor}/{target}?via=binding`: an anchor object calls the `Toucher` entrypoint
 *   over a service binding, which touches `target` (a host node relaying to the facade).
 * - `/from-anchor/{anchor}/{target}?via=fetch`: the anchor fetches `/local/{target}` over the public
 *   URL (a browser in the anchor's region).
 *
 * Anchors are placed with `locationHint` (`/anchor/{name}?hint=apac`). `/wipe/{name}` empties an
 * object's storage, optionally resetting it, to see whether its next touch can place it anew.
 * Every route is gated by the `x-bench-token` header.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

async function myColo(): Promise<string> {
  const text = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
  return /colo=(\w+)/.exec(text)?.[1] ?? '?';
}

export class ProbeDO extends DurableObject<Env> {
  #bootId = crypto.randomUUID().slice(0, 8);

  async whereAmI() {
    return { colo: await myColo(), bootId: this.#bootId, mark: (this.ctx.storage.kv.get('mark') as string | undefined) ?? null };
  }

  mark(value: string): void {
    this.ctx.storage.kv.put('mark', value);
  }

  async wipe(reset: boolean): Promise<string> {
    await this.ctx.storage.deleteAll();
    // Persist before abort: let the delete reach storage before the reset discards the object
    // (.claude/rules/durable-objects.md). Without this yield the first run's reset kept its data.
    if (reset) {
      await new Promise((r) => setTimeout(r, 200));
      this.ctx.abort('wiped');
    }
    return 'wiped';
  }

  async touchViaBinding(target: string) {
    return await (this.env as unknown as { SELF: { touch(t: string): Promise<unknown> } }).SELF.touch(target);
  }

  async touchViaFetch(target: string, base: string, token: string) {
    const res = await fetch(`${base}/local/${target}`, { headers: { 'x-bench-token': token } });
    return await res.json();
  }
}

/** The facade's stand-in: an entrypoint another object calls, which then touches a fresh name. */
export class Toucher extends WorkerEntrypoint<Env> {
  async touch(target: string) {
    const workerColo = await myColo();
    const d = await this.env.PROBE.getByName(target).whereAmI();
    return { workerColo, targetColo: d.colo };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const secret = (env as unknown as Record<string, string | undefined>).BENCH_TOKEN;
    const token = request.headers.get('x-bench-token');
    if (!secret || token !== secret) return new Response('Unauthorized', { status: 401 });

    const [, route, a, b] = url.pathname.split('/');
    const workerColo = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? '?';
    const json = (v: unknown) => Response.json(v);

    if (route === 'local' && a) {
      const d = await env.PROBE.getByName(a).whereAmI();
      return json({ workerColo, targetColo: d.colo, bootId: d.bootId, mark: d.mark });
    }
    if (route === 'anchor' && a) {
      const hint = url.searchParams.get('hint') as DurableObjectLocationHint | null;
      const stub = env.PROBE.get(env.PROBE.idFromName(a), hint ? { locationHint: hint } : undefined);
      return json({ workerColo, hint, ...(await stub.whereAmI()) });
    }
    if (route === 'from-anchor' && a && b) {
      const anchor = env.PROBE.getByName(a);
      const via = url.searchParams.get('via');
      const result = via === 'fetch'
        ? await anchor.touchViaFetch(b, url.origin, secret)
        : await anchor.touchViaBinding(b);
      return json({ anchorColo: (await anchor.whereAmI()).colo, via, result });
    }
    if (route === 'mark' && a) {
      await env.PROBE.getByName(a).mark(url.searchParams.get('v') ?? 'x');
      return json({ ok: true });
    }
    if (route === 'wipe' && a) {
      try {
        await env.PROBE.getByName(a).wipe(url.searchParams.get('reset') === '1');
        return json({ wiped: true, reset: false });
      } catch (e) {
        return json({ wiped: true, reset: true, error: String((e as Error).message) });
      }
    }
    return new Response('Not Found', { status: 404 });
  },
};
