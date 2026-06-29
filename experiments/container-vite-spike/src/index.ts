import { Container, getContainer } from "@cloudflare/containers";

/**
 * The lifecycle DO that fronts a single dev-vite container and proxies HTTP + the
 * HMR WebSocket through to it (the documented Container-binding pattern). This is the
 * "container fronted by its lifecycle DO" the spike's Q2 is testing.
 */
export class ViteDevContainer extends Container {
  // vite dev server inside the container.
  defaultPort = 5173;
  // Warm-while-focused mitigation knob (Q1/Q4): how long after the last request the
  // container idles before stopping. The browser tab keeps it alive by polling/holding WS.
  sleepAfter = "5m";

  override onStart() {
    console.log(`[container] vite container START @ ${Date.now()}`);
  }
  override onStop() {
    console.log(`[container] vite container STOP @ ${Date.now()}`);
  }
  override onError(err: unknown) {
    console.log(`[container] ERROR`, err);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // One shared sandbox container for the spike (a per-tenant name would shard them).
    const container = getContainer(env.VITE_DEV, "spike-sandbox");

    // Proxy everything — HTTP doc/asset loads AND the vite HMR WebSocket upgrade —
    // straight through to the container's vite dev server. The first request pays
    // cold start (container boot + wait-for-port); subsequent are warm (Q1).
    const t0 = Date.now();
    const res = await container.fetch(request);
    const dt = Date.now() - t0;
    const kind = request.headers.get("upgrade") === "websocket" ? "WS" : "HTTP";
    console.log(`[proxy] ${kind} ${request.method} ${url.pathname} -> ${res.status} in ${dt}ms`);
    return res;
  },
};
