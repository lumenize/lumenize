/**
 * Does a Worker Preview's service binding to its OWN worker name resolve to the Preview,
 * or to the production deployment?
 *
 * The Previews docs answer the A→B case ("The Preview of Worker A can only bind to the
 * production Worker B") but never the A=B case, which is the shape apps/nebula actually
 * uses for AUTH_EMAIL_SENDER and NEBULA_AUTH_FACADE. If a self-binding crosses to
 * production, a Preview's invites and auth mail run against production's Registry DO
 * while its OWN Durable Object namespace sits unused — silently.
 *
 * `/`         → the local deployment's marker + a bump of the DO it can reach directly.
 * `/via-self` → the same two values fetched THROUGH the self service binding.
 *
 * Read the result as a pair: on a Preview URL, `localMarker` is always "preview"; if
 * `viaSelf.marker` is "production" the binding crossed, and `viaSelf.counter` tells you
 * whose Durable Object namespace took the write.
 */
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';

export class Counter extends DurableObject {
  bump(): number {
    const n = ((this.ctx.storage.kv.get('n') as number | undefined) ?? 0) + 1;
    this.ctx.storage.kv.put('n', n);
    return n;
  }
}

/** The named entrypoint the SELF binding targets. */
export class Probe extends WorkerEntrypoint<Env> {
  async whoami(): Promise<{ marker: string; counter: number }> {
    const stub = this.env.COUNTER.get(this.env.COUNTER.idFromName('probe'));
    return { marker: this.env.MARKER, counter: await stub.bump() };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const out: Record<string, unknown> = {
      route: url.pathname,
      localMarker: (env as Record<string, unknown>).MARKER ?? null,
      bindingTypes: {
        COUNTER: typeof (env as Record<string, unknown>).COUNTER,
        SELF: typeof (env as Record<string, unknown>).SELF,
      },
    };
    try {
      const stub = env.COUNTER.get(env.COUNTER.idFromName('probe'));
      out.localCounter = await stub.bump();
    } catch (e) {
      out.localCounterError = String(e);
    }
    try {
      out.viaSelf = await env.SELF.whoami();
    } catch (e) {
      out.viaSelfError = String(e);
    }
    return Response.json(out);
  },
};
