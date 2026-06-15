/**
 * Probe: does request.cf survive into a Durable Object's fetch()?
 *
 * Three forwarding variants, each reporting what the DO sees:
 *   /raw             — stub.fetch(request) with the original eyeball Request
 *   /rebuilt         — stub.fetch(new Request(request, { headers }))  ← routeDORequest's pattern
 *   /rebuilt-with-cf — stub.fetch(new Request(request, { headers, cf: request.cf }))
 *
 * Response includes workerCf (ground truth at the edge) and doCf (what the DO received).
 */
import { DurableObject } from 'cloudflare:workers';

function summarize(cf: unknown): unknown {
  if (cf === undefined) return 'UNDEFINED';
  if (cf === null) return 'NULL';
  const c = cf as Record<string, unknown>;
  return {
    colo: c.colo,
    country: c.country,
    continent: c.continent,
    city: c.city,
    longitude: c.longitude,
    keyCount: Object.keys(c).length,
  };
}

export class Probe extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    return Response.json({ doCf: summarize((request as { cf?: unknown }).cf) });
  }
}

export default {
  async fetch(request: Request, env: { PROBE: DurableObjectNamespace }): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.PROBE.getByName('probe');
    const workerCf = summarize((request as { cf?: unknown }).cf);

    let doResult: unknown;
    if (url.pathname === '/raw') {
      doResult = await (await stub.fetch(request)).json();
    } else if (url.pathname === '/rebuilt') {
      const headers = new Headers(request.headers);
      headers.set('X-Probe', '1');
      doResult = await (await stub.fetch(new Request(request, { headers }))).json();
    } else if (url.pathname === '/rebuilt-with-cf') {
      const headers = new Headers(request.headers);
      headers.set('X-Probe', '1');
      const init = { headers, cf: (request as { cf?: unknown }).cf } as RequestInit;
      doResult = await (await stub.fetch(new Request(request, init))).json();
    } else {
      return new Response('paths: /raw /rebuilt /rebuilt-with-cf');
    }
    return Response.json({ path: url.pathname, workerCf, ...(doResult as object) });
  },
};
