import { Container, getContainer } from "@cloudflare/containers";

// The command-server's port — distinct from vite's defaultPort (5173). Reachable ONLY via the
// DO's `containerFetch(req, CMD_PORT)`; the public `fetch()` proxy never targets it (Q5 boundary).
const CMD_PORT = 9000;

type ExecResult = { stdout: string; stderr: string; code: number; durationMs: number };
type WriteResult = { ok: boolean; path: string };
type ViteResult = { ok: boolean; action: string };

/**
 * Lifecycle DO fronting one dev container. It does TWO things, on two ports:
 *  - public `fetch()` -> vite (defaultPort 5173): the browser preview proxy (HTTP + HMR-WS).
 *  - command methods (`exec`/`writeFile`/`execStream`/`viteRestart`/`noop`) -> the command-server
 *    on port 9000, via `containerFetch(req, 9000)`. These stand in for the `@mesh` methods the
 *    server-side Studio agent calls over `lmz.call` (onBeforeCall-gated) in production — here they
 *    are plain DO RPC methods (raw RPC is fine in a throwaway spike; mesh hop latency is known +
 *    additive). The command port is reachable ONLY through these methods, never via `fetch()`.
 */
export class DevContainer extends Container {
  defaultPort = 5173; // public vite proxy surface
  sleepAfter = "5m";  // warm-while-focused knob (Q1/Q4 from the container-vite spike)

  override onStart() { console.log(`[container] START @ ${Date.now()}`); }
  override onStop() { console.log(`[container] STOP @ ${Date.now()}`); }
  override onError(err: unknown) { console.log(`[container] ERROR`, err); }

  #cmd(path: string, init?: RequestInit): Promise<Response> {
    return this.containerFetch(new Request(`http://cmd.local${path}`, init), CMD_PORT);
  }

  /** No-op channel probe (no child spawn) — pure DO->container->back latency (Q2). */
  async noop(): Promise<{ ok: boolean }> {
    const res = await this.#cmd("/healthz");
    return res.json();
  }

  /** Run a command in the container working tree, buffered (Q1/Q2). */
  async exec(payload: { cmd: string; args?: string[]; shell?: boolean; cwd?: string }): Promise<ExecResult> {
    const res = await this.#cmd("/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json() as Promise<ExecResult>;
  }

  /** Write a source file into the working tree (Q4 — vite HMR should fire). */
  async writeFile(payload: { path: string; content: string }): Promise<WriteResult> {
    const res = await this.#cmd("/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json() as Promise<WriteResult>;
  }

  /** Restart the vite dev server (Q1). */
  async viteRestart(): Promise<ViteResult> {
    const res = await this.#cmd("/vite/restart", { method: "POST" });
    return res.json() as Promise<ViteResult>;
  }

  /** Stream a long command's output back as it arrives (Q3). Returns the NDJSON body stream. */
  async execStream(payload: { cmd: string; args?: string[]; shell?: boolean; cwd?: string }): Promise<ReadableStream | null> {
    const res = await this.#cmd("/exec-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.body;
  }
}

// Parse a JSON request body, tolerating empty bodies.
async function body<T>(request: Request): Promise<T> {
  const raw = await request.text();
  return (raw ? JSON.parse(raw) : {}) as T;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = getContainer(env.DEV_CONTAINER, "spike-sandbox");

    // === Command channel — TEST DRIVER standing in for the server-side agent's mesh call. ===
    // In production the agent reaches these as @mesh methods over lmz.call (onBeforeCall-gated,
    // server-side only). They are exposed as HTTP routes HERE PURELY so the spike can drive +
    // time them; this `/__cmd/*` surface is NOT part of the production design. The wall-clock the
    // agent actually sees is `doRoundTripMs` (Worker@edge -> DO -> container -> back), which
    // EXCLUDES the measuring client's WAN; the client-observed total over-counts by that WAN.
    if (url.pathname.startsWith("/__cmd/")) {
      const op = url.pathname.slice("/__cmd/".length);
      const t0 = Date.now();
      try {
        if (op === "noop") {
          const r = await stub.noop();
          return json({ ...r, doRoundTripMs: Date.now() - t0 });
        }
        if (op === "exec") {
          const r = await stub.exec(await body(request));
          return json({ ...r, doRoundTripMs: Date.now() - t0 });
        }
        if (op === "write") {
          const r = await stub.writeFile(await body(request));
          return json({ ...r, doRoundTripMs: Date.now() - t0 });
        }
        if (op === "vite-restart") {
          const r = await stub.viteRestart();
          return json({ ...r, doRoundTripMs: Date.now() - t0 });
        }
        if (op === "exec-stream") {
          const stream = await stub.execStream(await body(request));
          return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
        }
        return json({ error: `unknown op: ${op}` }, 404);
      } catch (e) {
        return json({ error: String((e as Error)?.stack || e) }, 500);
      }
    }

    // === Public preview proxy: vite (5173) ONLY. Never reaches the command-server (9000). ===
    // This is the only browser-routable surface; it cannot reach the command port (Q5).
    const t0 = Date.now();
    const res = await stub.fetch(request);
    const kind = request.headers.get("upgrade") === "websocket" ? "WS" : "HTTP";
    console.log(`[proxy] ${kind} ${request.method} ${url.pathname} -> ${res.status} in ${Date.now() - t0}ms`);
    return res;
  },
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
