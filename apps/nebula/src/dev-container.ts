/**
 * DevContainer — the Studio dev-loop preview container (Nebula's `DEV_CONTAINER`
 * binding), addressed at the `{u}.{g}.dev` instance. A disposable Cloudflare
 * Container running real **vite** (HMR) that DevStudio pushes source to
 * (`applyChanges`) and serves the Preview app from. Holds NO durable truth — the
 * source-of-truth is DevStudio (shell `Workspace` + local git); on cold boot the
 * disk reverts to the baked image and DevStudio re-pushes the tree (Flow 1c).
 *
 * `extends NebulaContainer` (NOT bare LumenizeContainer): it inherits the
 * structural tenant-isolation `onBeforeCall` (the `{u}.{g}.dev` scope guard) on the
 * mesh path. Two ports:
 *  - **`:5173` vite** — public, ungated (the preview shell + HMR), reached via the
 *    DO `fetch()` proxy. `cf-container-target-port` is stripped by
 *    `LumenizeContainer.fetch()` so the public path can NEVER reach `:9000`.
 *  - **`:9000` command-server** — host-DO-only, reached exclusively by this DO's
 *    internal `containerFetch`. The command `@mesh` methods carry
 *    `@mesh(requireAdmin)` (NebulaContainer.onBeforeCall proves tenant *scope* but
 *    never `access.admin`, and `<id>.*` widening admits descendant non-admins).
 *
 * DevStudio invokes the command methods as awaited `lmz.callRaw` (single-hop
 * result-bearing transport, ADR-003 — never raw Workers RPC). vite fully owns SFC
 * compile; the Star never compiles. Deps are baked into the image → zero
 * `npm install` on cold boot.
 *
 * ⚠️ `extends Container` does NOT construct under vitest-pool-workers
 * ([[container-no-construct-pool-workers]]); the composed seam is tested via
 * non-Container harnesses + the pure helpers below. Assembled-container e2e is a
 * deploy-gated `it.skip` (the first full `apps/nebula` Worker deploy).
 *
 * @see tasks/nebula-studio.md § DevContainer dev loop
 * @see tasks/nebula-dev-flows.md — Flow 1 / 1c + DevContainer internals
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { NebulaContainer } from './nebula-container';
import { requireAdmin } from './nebula-do';

/** The command-server's port — distinct from vite's `defaultPort` (5173).
 *  Reachable ONLY via the DO's internal `containerFetch(req, CMD_PORT)`; the public
 *  `fetch()` proxy can never target it (the port header is stripped). */
const CMD_PORT = 9000;

/** One pushed source file. */
export interface SourceFile {
  path: string;
  content: string;
}

/**
 * Container-unavailability surfaced as a recognizable typed retryable error over
 * the mesh — NOT a 200 carrying a 503 body. The cold-start makes this concrete: the
 * first `containerFetch` races boot and returns a "Failed to…" text body (not JSON).
 * DevStudio detects via `err.name === 'ContainerUnavailableError'` + the `retryable`
 * flag and retries (mesh.md / Flow 1c boot-race).
 */
export class ContainerUnavailableError extends Error {
  status: number;
  retryable = true;
  constructor(status: number, detail?: string) {
    super(
      `Container unavailable (HTTP ${status})${detail ? `: ${detail}` : ''} — ` +
        `provisioning/cold-starting, evicted, or at capacity. Retry.`,
    );
    this.name = 'ContainerUnavailableError';
    this.status = status;
  }
}

/**
 * DO-side path-traversal guard (defense-in-depth — the command-server re-checks at
 * the write boundary, security.md "receiver re-validates"). Rejects any absolute
 * path or `..` segment BEFORE forwarding — nothing is written on reject. Pure +
 * synchronous so it's unit-testable without a live container. Throws on reject.
 */
export function assertSafeRelPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`Invalid source path: ${String(path)}`);
  }
  if (path.startsWith('/')) {
    throw new Error(`Absolute source path rejected: ${path}`);
  }
  if (path.split(/[/\\]/).includes('..')) {
    throw new Error(`'..' segment rejected in source path: ${path}`);
  }
}

/**
 * Inject the server-derived scope into the shell HTML as a `<meta>` tag (a
 * `<script>` would need a CSP nonce; a meta tag is strict-CSP-friendly). The
 * bootstrap reads it via `JSON.parse(meta[name=nebula-scope].content)`. Slugs are
 * `[a-z0-9-]` so the JSON has no single quotes to break the attribute. Pure so the
 * injection is unit-testable. The scope passed in is ALWAYS server-derived
 * (`this.lmz.instanceName`), never request-supplied — the wrong-Star footgun guard.
 */
export function injectScopeMeta(
  html: string,
  scope: { activeScope: string; authScope: string; appVersion: string },
): string {
  const meta = `<meta name="nebula-scope" content='${JSON.stringify(scope)}'>`;
  return html.includes('<head>') ? html.replace('<head>', `<head>\n    ${meta}`) : `${meta}\n${html}`;
}

export class DevContainer extends NebulaContainer {
  /** Public vite preview surface. The base `fetch()` pins the public proxy here and
   *  strips `cf-container-target-port`, so a browser can only reach vite. */
  override defaultPort = 5173;
  /** Warm-while-focused; idle sleep discards the disposable checkout (DevStudio is
   *  the durable source — re-pushed on next cold boot, Flow 1c). */
  override sleepAfter = '5m';

  /** Reach the host-DO-only command-server (`:9000`), self-retrying the cold
   *  container (the first containerFetch races boot, Flow 1c). Non-2xx / non-JSON
   *  surfaces as a typed retryable `ContainerUnavailableError`. */
  async #cmdJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.containerFetch(new Request(`http://cmd.local${path}`, init), CMD_PORT);
    const text = await res.text();
    if (!res.ok) throw new ContainerUnavailableError(res.status, text.slice(0, 120));
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ContainerUnavailableError(res.status, text.slice(0, 120));
    }
  }

  #postJson<T>(path: string, body?: unknown): Promise<T> {
    return this.#cmdJson<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  /** Liveness/cold-boot probe (no child spawn). DevStudio's `ensureUp` driver waits
   *  on this through the boot-race retry before pushing the source tree. */
  @mesh(requireAdmin)
  async ensureUp(): Promise<{ ok: boolean }> {
    return this.#cmdJson('/healthz');
  }

  /**
   * Write DevStudio's pushed source files into the working tree (the `applyChanges`
   * receiver — Flow 1 / 1c). Validates every path shape FIRST (defense-in-depth;
   * the command-server re-validates at the write boundary), then forwards the batch
   * so a single bad path writes nothing. vite picks up the writes → HMR.
   */
  @mesh(requireAdmin)
  async applyChanges(files: SourceFile[]): Promise<{ ok: boolean; written: number }> {
    for (const f of files) assertSafeRelPath(f.path);
    debug('nebula.DevContainer.applyChanges').debug('apply', {
      instanceName: this.lmz.instanceName,
      count: files.length,
    });
    return this.#postJson('/apply', { files });
  }

  /** Run a buffered command in the container (host-DO-only by construction — the
   *  public path can't reach `:9000`). Used for `vite build` at publish + tooling. */
  @mesh(requireAdmin)
  async exec(payload: { cmd: string; args?: string[]; shell?: boolean; cwd?: string }): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    durationMs: number;
  }> {
    return this.#postJson('/exec', payload);
  }

  /** Start/stop/restart the dev server (used at publish + recovery). */
  @mesh(requireAdmin)
  async viteControl(action: 'restart' | 'stop' | 'start'): Promise<{ ok: boolean; action: string }> {
    return this.#postJson(`/vite/${action}`);
  }

  /** Read a file back from the working tree (test/inspection of a landed push). */
  @mesh(requireAdmin)
  async readFileInContainer(path: string): Promise<{ content: string }> {
    assertSafeRelPath(path);
    return this.#postJson('/read', { path });
  }

  /**
   * Public preview surface — a three-way branch (never blanket-buffer):
   *  - WS upgrade (vite HMR) → forward `super.fetch()` verbatim (ungated).
   *  - shell `index.html` → buffer + inject the SERVER-DERIVED scope, fresh Response.
   *  - other assets → stream `super.fetch()` unchanged.
   * `super.fetch()` = `LumenizeContainer.fetch()`: strips `cf-container-target-port`
   * (M1), stamps identity from the routed headers (B1), proxies vite. So
   * `activeScope` here is `this.lmz.instanceName` (server-derived from routing),
   * NEVER request-supplied — the wrong-Star footgun guard.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return super.fetch(request); // HMR WebSocket — forward verbatim, never buffer
    }
    const res = await super.fetch(request);
    if (!(res.headers.get('content-type') ?? '').includes('text/html')) {
      return res; // assets stream through unchanged
    }
    const activeScope = this.lmz.instanceName; // server-derived (B1-stamped), never the request
    if (!activeScope) {
      // No routed identity → can't derive scope. Fail loud rather than serve a shell
      // that would silently route the Preview app's data calls to the wrong Star.
      return new Response('Cannot serve preview: missing instance scope', { status: 500 });
    }
    const authScope = activeScope.split('.').slice(0, 2).join('.'); // {u}.{g} from {u}.{g}.dev
    const html = await res.text();
    const injected = injectScopeMeta(html, { activeScope, authScope, appVersion: 'dev' });
    const headers = new Headers(res.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.delete('content-length'); // body length changed
    return new Response(injected, { status: res.status, statusText: res.statusText, headers });
  }
}
