import { LumenizeContainer } from '@lumenize/mesh/container';
import { mesh } from '@lumenize/mesh';
import { preprocess } from '@lumenize/structured-clone';

// The command-server's port — distinct from vite's defaultPort (5173). Reachable
// ONLY via the DO's internal containerFetch(req, CMD_PORT); the public fetch()
// proxy can never target it (LumenizeContainer.fetch() strips cf-container-target-port).
const CMD_PORT = 9000;

type ExecResult = { stdout: string; stderr: string; code: number; durationMs: number };
type WriteResult = { ok: boolean; path: string };
type ViteResult = { ok: boolean; action: string };

/**
 * m3 (the node-type review finding): container-unavailability surfaced as a
 * recognizable typed error over the mesh — NOT a 200 carrying a 503 body. The
 * cold-start makes this concrete (the first containerFetch returns a "Failed
 * to…" TEXT body). Detect via `err.name === 'ContainerUnavailableError'` + the
 * `retryable` flag (mesh.md).
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
 * Inject the server-derived scope into the shell HTML as a `<meta>` tag (a
 * `<script>` would need a CSP nonce; a meta tag is strict-CSP-friendly). The app
 * reads it via `JSON.parse(document.querySelector('meta[name=nebula-scope]').content)`.
 * Slugs are `[a-z0-9-]` so the JSON has no single quotes to break the attribute.
 */
function injectScopeMeta(html: string, scope: { activeScope: string; authScope: string; appVersion: string }): string {
  const meta = `<meta name="nebula-scope" content='${JSON.stringify(scope)}'>`;
  return html.includes('<head>') ? html.replace('<head>', `<head>\n    ${meta}`) : `${meta}\n${html}`;
}

/**
 * Phase-1 command channel + Phase-2 scope-injection smoke. A real
 * `LumenizeContainer` node with the spike's vite app + command-server, driven
 * over the mesh. Class name stays `SmokeContainer` so redeploy overwrites the
 * deploy with no DO-rename migration. See tasks/nebula-container-dev-loop.md.
 */
export class SmokeContainer extends LumenizeContainer {
  defaultPort = 5173; // public vite preview surface
  sleepAfter = '5m';  // warm-while-focused (spike Q1/Q4)

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

  @mesh()
  async noop(): Promise<{ ok: boolean }> {
    return this.#cmdJson('/healthz');
  }

  @mesh()
  async exec(payload: { cmd: string; args?: string[]; shell?: boolean; cwd?: string }): Promise<ExecResult> {
    return this.#cmdJson('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  @mesh()
  async writeFile(payload: { path: string; content: string }): Promise<WriteResult> {
    return this.#cmdJson('/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  @mesh()
  async viteControl(action: 'restart' | 'stop' | 'start'): Promise<ViteResult> {
    return this.#cmdJson(`/vite/${action}`, { method: 'POST' });
  }

  @mesh()
  ping(): string {
    return `pong from ${this.lmz.instanceName ?? '(no instance name)'}`;
  }

  async coexistence(): Promise<{
    type: string;
    bindingName?: string;
    instanceName?: string;
    hasContainerSchedulesTable: boolean;
    hasAlarm: boolean;
  }> {
    const row = this.ctx.storage.sql
      .exec(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='container_schedules'`)
      .one() as { c: number };
    const alarm = await this.ctx.storage.getAlarm();
    return {
      type: this.lmz.type,
      bindingName: this.ctx.storage.kv.get('__lmz_do_binding_name') as string | undefined,
      instanceName: this.ctx.storage.kv.get('__lmz_do_instance_name') as string | undefined,
      hasContainerSchedulesTable: row.c > 0,
      hasAlarm: alarm !== null,
    };
  }

  /**
   * Phase-2 public preview surface. Three-way branch (never blanket-buffer):
   *  - WS upgrade (vite HMR) → forward `super.fetch()` verbatim.
   *  - shell `index.html` → buffer + inject the SERVER-DERIVED scope, fresh Response.
   *  - other assets → stream `super.fetch()` unchanged.
   * `super.fetch()` = LumenizeContainer.fetch(): strips cf-container-target-port (M1)
   * + stamps identity from the routed headers (B1) + proxies vite. So `activeScope`
   * here is `this.lmz.instanceName` (server-derived from routing), NEVER request-
   * supplied — the wrong-Star footgun guard. (HMR-update + browser-mount validation
   * is Phase 2's browser half; here we curl-validate the injection + the decoy.)
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
      // No routed identity → can't derive scope. Fail loud rather than serve a
      // shell that would silently route data calls to the wrong Star.
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

// ONE instance for every probe (a parseId-valid {u}.{g}.dev) → one container, no
// two-container ¼-vCPU contention (the spike's sizing caveat). /cmd boots the
// command-server (which spawns vite), so a subsequent /preview finds vite up.
const CMD_INSTANCE = 'demo.app.dev';
const PREVIEW_SCOPE = 'demo.app.dev';

/** Drive an @mesh method through the real receive seam (executeEnvelope). */
function meshEnvelope(method: string, args: unknown[] = []) {
  const chain = [
    { type: 'get', key: method },
    { type: 'apply', args },
  ];
  return {
    version: 1,
    chain: preprocess(chain),
    callContext: { callChain: [], state: {} },
    metadata: { callee: { type: 'LumenizeDO', bindingName: 'SMOKE', instanceName: CMD_INSTANCE } },
  };
}

/** The headers routeDORequest sets before routing to the DO (the B1 stamp source). */
function routedHeaders(instanceName: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-lumenize-do-binding-name': 'SMOKE',
    'x-lumenize-do-instance-name-or-id': instanceName,
    ...extra,
  };
}

const SCOPE_META_RE = /<meta name="nebula-scope" content='([^']*)'>/;

export default {
  async fetch(request: Request, env: { SMOKE: DurableObjectNamespace }): Promise<Response> {
    const url = new URL(request.url);
    const cmdStub = (env.SMOKE as any).getByName(CMD_INSTANCE);
    const previewStub = (env.SMOKE as any).getByName(PREVIEW_SCOPE);

    try {
      if (url.pathname === '/cmd') {
        const result = await cmdStub.__executeOperation(meshEnvelope('exec', [{ cmd: 'git', args: ['--version'] }]));
        return Response.json({ probe: 'cmd/exec(git --version)', result });
      }
      if (url.pathname === '/preview') {
        // Public preview via the DO fetch() — scope injected, server-derived.
        const res = await previewStub.fetch(
          new Request('https://preview.local/', { headers: routedHeaders(PREVIEW_SCOPE) }),
        );
        const html = await res.text();
        return Response.json({
          probe: 'preview',
          status: res.status,
          injectedScope: html.match(SCOPE_META_RE)?.[1] ?? '(none)',
          hasViteClient: html.includes('/@vite/client'),
        });
      }
      if (url.pathname === '/preview-decoy') {
        // A request-supplied decoy (?activeScope=evil.g.dev) MUST be ignored — the
        // injected scope is derived from the routed instance identity, not the request.
        const res = await previewStub.fetch(
          new Request('https://preview.local/?activeScope=evil.g.dev', { headers: routedHeaders(PREVIEW_SCOPE) }),
        );
        const injectedScope = (await res.text()).match(SCOPE_META_RE)?.[1] ?? '(none)';
        return Response.json({
          probe: 'preview-decoy',
          injectedScope,
          expect: `activeScope=${PREVIEW_SCOPE} (routed), NOT evil.g.dev`,
          decoyIgnored: injectedScope.includes(PREVIEW_SCOPE) && !injectedScope.includes('evil.g.dev'),
        });
      }
      if (url.pathname === '/boundary') {
        // Trust boundary: cf-container-target-port:9000 must be STRIPPED → vite, not 9000.
        const res = await previewStub.fetch(
          new Request('https://preview.local/', { headers: routedHeaders(PREVIEW_SCOPE, { 'cf-container-target-port': String(CMD_PORT) }) }),
        );
        const html = await res.text();
        return Response.json({
          probe: 'boundary(header-strip)',
          status: res.status,
          hasViteClient: html.includes('/@vite/client'),
          expect: 'vite shell (stripped), not the command-server',
        });
      }
      // default: Phase-0 coexistence smoke.
      const meshResult = await cmdStub.__executeOperation(meshEnvelope('ping'));
      const coexistence = await cmdStub.coexistence();
      return Response.json({ probe: 'coexistence', meshResult, coexistence });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, { status: 500 });
    }
  },
};
