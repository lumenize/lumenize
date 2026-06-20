// Local-dev matrix experiment — isolates wrangler-dev container networking from the
// full Lumenize/mesh stack. The ONE variable under test is `enableInternet` (which
// gates miniflare's `proxy-everything` egress sidecar locally). Toggle it + swap the
// docker context (Colima vs Docker Desktop) between runs.
import { Container, ContainerProxy } from '@cloudflare/containers';

export class TestContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '5m';
  // TOGGLE between runs. `false` mirrors LumenizeContainer's secure pin (engages the
  // local proxy-everything sidecar); `true` is the no-sidecar lever.
  override enableInternet = false;
}

// Local wrangler dev demands this re-export for any egress config (memory note).
export { ContainerProxy };

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/hit') {
      const stub = env.TC.get(env.TC.idFromName('singleton'));
      const started = Date.now();
      try {
        const res = await stub.fetch(new Request('http://container/'));
        const body = await res.text();
        return Response.json({ ok: true, ms: Date.now() - started, status: res.status, body });
      } catch (e: any) {
        return Response.json(
          { ok: false, ms: Date.now() - started, name: e?.name, error: String(e?.message ?? e) },
          { status: 500 },
        );
      }
    }
    return new Response('hit /hit to reach the container');
  },
};
