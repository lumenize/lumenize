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
 * non-Container harnesses + the pure helpers below. The assembled-container e2e is an
 * `it.skip` run with `wrangler dev` + Docker Desktop (the Container runs locally there;
 * it just can't construct under pool-workers — testing.md § "What a skipped test needs").
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

/** KV key for the app-version the public `fetch()` injects into the shell. Pushed by
 *  DevStudio (`setAppVersion`) as the content hash of the ontology source. Persists in
 *  the DO across container cold-boots (only the container disk reverts, not the DO). */
const VERSION_KEY = 'devcontainer:appVersion';

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

/**
 * A non-OK proxy response that signals the container is cold/slept/provisioning — NOT a genuine app
 * error. When a container idle-sleeps, the `@cloudflare/containers` base proxy can hit a momentarily
 * stale `running` flag, skip its own auto-restart, and return a 5xx whose body carries one of these
 * runtime/base phrases (the monitor corrects the flag within ~a second, so a retry succeeds). 429/503
 * are always container-infra (capacity / no-instance — never an app's doing for a navigation); the
 * ambiguous 500/502 is matched by BODY signature so a genuine vite/app 500 is NOT masked.
 * Pure + synchronous so it's unit-testable without a live container.
 */
export function isContainerColdResponse(status: number, body: string): boolean {
  if (status === 429 || status === 503) return true; // rate-limited / no-instance — always container-infra, never an app's doing for a navigation
  if (status !== 500 && status !== 502) return false;
  return /not running|proxying request to container|Failed to start container|suddenly disconnected|provisioning/i.test(
    body,
  );
}

/** True for a top-level preview navigation (vs a sub-asset request). Only the navigation gets the
 *  self-healing waking page; assets pass through and are re-fetched by the page's own reload. Pure. */
export function isDocumentRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-dest') === 'document') return true;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * Friendly interstitial served when the container proxy fails (idle-slept with a stale `running`
 * flag, or a start that failed / hit capacity). It carries a **manual** Reload button and deliberately
 * does **NOT** auto-reload. Two reasons (the 2026-06-27 regression that proved both): (1) these are
 * *failure* states, not a normal cold boot — the base proxy already *waits* for a healthy cold start,
 * so a retry doesn't speed a genuine failure, it just hammers it; (2) every proxy attempt calls the
 * base's `renewActivityTimeout`, so a tight reload loop keeps the DO from idle-evicting — and that
 * eviction is precisely what clears a stale `running` flag. Auto-reload therefore *prevents* recovery.
 * Pure (no container round-trip). A proper instant force-restart (stop+start, bypassing the stale-flag
 * fast-path) is the follow-up; until then a stuck container self-recovers once traffic stops (≤sleepAfter).
 */
export function wakingPreviewPage(): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Waking your preview…</title>` +
    `<style>body{font-family:system-ui,sans-serif;margin:0;height:100vh;display:grid;place-items:center;` +
    `background:#1d232a;color:#a6adbb}.box{text-align:center}.s{font-size:1.4rem;animation:p 1.5s ease-in-out infinite}` +
    `@keyframes p{50%{opacity:.4}}p{opacity:.6;font-size:.85rem}button{font:inherit;margin-top:1rem;padding:.5rem 1rem;` +
    `border-radius:.5rem;border:1px solid #3b4451;background:#2a323c;color:#a6adbb;cursor:pointer}</style></head>` +
    `<body><div class="box"><div class="s">⏳ Waking your preview…</div>` +
    `<p>It idle-slept to save resources. Give it a moment, then reload.</p>` +
    `<button onclick="location.reload()">Reload</button></div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export class DevContainer extends NebulaContainer {
  /** Public vite preview surface. The base `fetch()` pins the public proxy here and
   *  strips `cf-container-target-port`, so a browser can only reach vite. */
  override defaultPort = 5173;
  /** Warm-while-focused; idle sleep discards the disposable checkout (DevStudio is
   *  the durable source — re-pushed on next cold boot, Flow 1c). */
  override sleepAfter = '5m';

  /**
   * Inject the per-instance preview prefix as a container env var so vite serves under
   * the matching `base` (Decision 12 / Flow 1d): the preview is served at
   * `/dev-container/{instance}/`, so vite must emit prefixed asset URLs or they 404 at
   * the origin root. MUST be set before the container starts — `@cloudflare/containers`
   * reads `envVars` at start — so we set it from the routed instance name on every entry
   * path before the first `containerFetch`/proxy triggers start. Re-setting on a warm
   * container is a harmless no-op (only re-read on a (re)start).
   */
  #setPreviewBaseEnv(instance: string | undefined | null): void {
    if (!instance) return;
    this.envVars = { ...this.envVars, PREVIEW_BASE: `/dev-container/${instance}/` };
  }

  /** Reach the host-DO-only command-server (`:9000`), self-retrying the cold
   *  container (the first containerFetch races boot, Flow 1c). Non-2xx / non-JSON
   *  surfaces as a typed retryable `ContainerUnavailableError`. */
  async #cmdJson<T>(path: string, init?: RequestInit): Promise<T> {
    this.#setPreviewBaseEnv(this.lmz.instanceName); // before start: vite base (Flow 1d)
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

  /**
   * Liveness probe + STUCK-container recovery. DevStudio's `ensureUp` (and so `chat` + the Studio's
   * open/refresh) awaits this before pushing source, so the recovery rides those existing paths.
   *
   * A healthz probe normally also cold-starts the container (its `containerFetch` waits for the port).
   * But a slept container can leave a **stale `this.container.running` flag** the base proxy can't
   * restart past — `start()`/`startAndWaitForPorts()` both fast-path on that flag — so the probe just
   * gets "not running" forever (the 2026-06-27 stuck state; recovers in the cloud only via idle-evict).
   * On a failed probe we **force a clean restart**: `destroy()` SIGKILLs unconditionally (unlike
   * `stop()`, which guards on `if (running)`), resetting the flag to false; the re-probe's
   * `containerFetch` then sees `running=false` and auto-starts a fresh container. ONE retry only — no
   * loop; if it still fails, surface it (a state only eviction clears, or genuine capacity).
   *
   * ⚠️ Verified live (`extends Container` can't construct under pool-workers) — see
   * [[feedback_test_container_changes_with_wrangler_dev]].
   */
  @mesh(requireAdmin)
  async ensureUp(): Promise<{ ok: boolean }> {
    try {
      return await this.#cmdJson('/healthz');
    } catch {
      this.#setPreviewBaseEnv(this.lmz.instanceName); // envVars are read at (re)start
      try {
        await this.destroy(); // SIGKILL → resets the stale `running` flag (stop() would no-op on it)
      } catch {
        /* already gone / destroy raced — the re-probe below still boots from a clean flag */
      }
      return await this.#cmdJson('/healthz'); // running=false now → containerFetch auto-starts clean
    }
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
   * Set the app-version the public `fetch()` injects into the shell's `nebula-scope`
   * meta. DevStudio pushes it (the server-derived `hashBlob` of the ontology source)
   * whenever the version changes, so the preview's client sends the SAME version the
   * `.dev` Star installed — Handler-1 matches instead of `OntologyStaleError` on every
   * op (Decision 12 / Flow 1d). Stored in the DO's `kv` (the DO persists across
   * container cold-boots — only the disk reverts), never request-supplied. Sync
   * (a single `kv.put`, no container round-trip).
   */
  @mesh(requireAdmin)
  setAppVersion(version: string): void {
    this.ctx.storage.kv.put(VERSION_KEY, version);
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
    // Set the preview base BEFORE super.fetch() triggers the container start (envVars are
    // read at start). On a cold direct GET the instance isn't stamped yet, so read it from
    // the routing header; warm DOs have `this.lmz.instanceName` (Decision 12 / Flow 1d).
    this.#setPreviewBaseEnv(
      request.headers.get('x-lumenize-do-instance-name-or-id') ?? this.lmz.instanceName,
    );
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return super.fetch(request); // HMR WebSocket — forward verbatim, never buffer
    }
    const res = await super.fetch(request);

    // Cold-container recovery (idle-sleep → stale `running` flag → base proxy 5xx it can't restart
    // past; see isContainerColdResponse). On the top-level preview navigation, serve a friendly
    // waking page with a MANUAL reload — NOT an auto-reload loop: retrying a failure state just
    // hammers it, and each attempt renews the activity timeout, blocking the idle-eviction that
    // clears the stale flag (the 2026-06-27 regression). A genuine app error (non-cold body) passes
    // through untouched — never masked.
    if (isDocumentRequest(request) && !res.ok) {
      const body = await res.text();
      if (isContainerColdResponse(res.status, body)) return wakingPreviewPage();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

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
    // The version DevStudio installed on the `.dev` Star (server-derived hashBlob of
    // the ontology source), pushed here via setAppVersion. Empty until the first
    // ontology is applied — the preview can't do data ops before then anyway, and
    // injecting '' (not 'dev') keeps the contract honest (Decision 12 / Flow 1d).
    const appVersion = this.ctx.storage.kv.get<string>(VERSION_KEY) ?? '';
    const html = await res.text();
    const injected = injectScopeMeta(html, { activeScope, authScope, appVersion });
    const headers = new Headers(res.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.delete('content-length'); // body length changed
    return new Response(injected, { status: res.status, statusText: res.statusText, headers });
  }
}
