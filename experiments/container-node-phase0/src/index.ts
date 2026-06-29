import { LumenizeContainer } from '@lumenize/mesh/container';
import { mesh } from '@lumenize/mesh';
import { preprocess } from '@lumenize/structured-clone';

// Phase-3 finding: using `allowedHosts` (host-specific outbound interception)
// requires the Worker to export `ContainerProxy` (`ctx.exports.ContainerProxy`)
// or the container fails to start. Deployed, plain `enableInternet=false` (block-all)
// does NOT need it — only the selective allow-list does (Phase 1 deployed cleanly
// without this export). The real DevContainer (and the node type's docs) must carry
// this re-export when it allow-lists egress.
export { ContainerProxy } from '@cloudflare/containers';

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

  // Phase 3 egress: LumenizeContainer pins enableInternet=false (no open outbound);
  // allowedHosts opens ONLY the npm registry (agent runtime `npm install`), so a
  // fetch to any other host is blocked. The agent-authored-code EgressBroker path
  // (project_nebula_outside_world D2) is a separate, later task.
  override allowedHosts = ['registry.npmjs.org'];

  // Phase-3 finding: allowedHosts only opens an HTTPS host when interceptHttps is
  // ON (container.js applyOutboundInterception: HTTPS interception is gated on this
  // flag). The npm registry is HTTPS, so without this the allow-list is a no-op for
  // it (first probe: npm BLOCKED TimeoutError despite being allow-listed). Turning it
  // on DID activate interception (the block changed from a silent TimeoutError to an
  // immediate TypeError) — but the allow-listed host STILL fails: HTTPS interception
  // is a MITM, so the in-container TLS client must trust the interceptor's CA, which
  // node does not by default → cert-validation TypeError. Fully opening an HTTPS
  // allow-listed host therefore also needs CA-trust provisioning in the image
  // (NODE_EXTRA_CA_CERTS / install the CF interception CA) — DEFERRED (see the task
  // file Phase 3). Not on the dev-loop critical path: deps are baked at image build,
  // so runtime npm egress isn't needed yet. The block-all default is what secures the
  // container today, and that holds. The interception is applied at boot + "kept
  // there until the instance restarts."
  override interceptHttps = true;

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
      if (url.pathname === '/egress') {
        // Phase-3 egress: enableInternet=false + allowedHosts=[npm]. A fetch to a
        // non-allow-listed host must be BLOCKED; npm (allow-listed) must REACH.
        const probe = (host: string) =>
          `fetch('${host}',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('REACHED '+r.status)).catch(e=>console.log('BLOCKED '+(e.name||e.message)))`;
        const nonAllowlisted = await cmdStub.__executeOperation(
          meshEnvelope('exec', [{ cmd: 'node', args: ['-e', probe('https://example.com')] }]),
        );
        const allowlisted = await cmdStub.__executeOperation(
          meshEnvelope('exec', [{ cmd: 'node', args: ['-e', probe('https://registry.npmjs.org/npm')] }]),
        );
        return Response.json({
          probe: 'egress',
          nonAllowlisted: nonAllowlisted?.$result?.stdout ?? nonAllowlisted,
          allowlisted: allowlisted?.$result?.stdout ?? allowlisted,
          expect: 'example.com BLOCKED, registry.npmjs.org REACHED',
        });
      }
      if (url.pathname === '/starvation') {
        // Phase-3 sizing: does a `vite build` burst starve the command channel?
        // Fire the build (DON'T await), then time trivial /healthz round-trips
        // DURING it. The spike's ¼-vCPU starvation signature = a healthz that
        // returns 000 / >1 s. Latency is the DO→containerFetch round-trip (Date.now()
        // deltas advance across the awaited I/O — same way the spike measured); we
        // also report the build's own in-container durationMs.
        await cmdStub.__executeOperation(meshEnvelope('noop')); // warm the channel
        let buildDone = false;
        const buildP = cmdStub
          .__executeOperation(meshEnvelope('exec', [{ cmd: 'npm', args: ['run', 'build'] }]))
          .then((r: any) => { buildDone = true; return r; });
        const probes: { ms: number; ok: boolean; errName?: string; duringBuild: boolean }[] = [];
        for (let i = 0; i < 12; i++) {
          const t0 = Date.now();
          let ok = false;
          let errName: string | undefined;
          try {
            const r = await cmdStub.__executeOperation(meshEnvelope('noop'));
            ok = r?.$result?.ok === true;
          } catch (e) {
            errName = e instanceof Error ? e.name : String(e);
          }
          probes.push({ ms: Date.now() - t0, ok, errName, duringBuild: !buildDone });
        }
        const build = await buildP;
        const lat = probes.map((p) => p.ms);
        return Response.json({
          probe: 'starvation',
          healthzProbes: probes.length,
          probesDuringBuild: probes.filter((p) => p.duringBuild).length,
          maxHealthzMs: Math.max(...lat),
          minHealthzMs: Math.min(...lat),
          failures: probes.filter((p) => !p.ok).length,
          // spike's 000/>1s starvation signature
          starved: probes.some((p) => !p.ok || p.ms > 1000),
          buildDurationMs: build?.$result?.durationMs,
          buildCode: build?.$result?.code,
          expect: 'starved=false on >=standard-1 (no 000/>1s healthz during vite build)',
        });
      }
      if (url.pathname === '/touch') {
        // HMR trigger (Phase-2 browser half): rewrite App.vue's `marker` ref to a new
        // value via the command channel. A browser watching the live preview shows
        // "marker <v>" land over HMR — file-save → vite recompile → WS push → patch.
        // Pass ?v=<token> ([a-z0-9_-], <=24). Each distinct value = one visible save.
        const raw = url.searchParams.get('v') ?? 'x';
        const v = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'x';
        const sed = `sed -i 's/const marker = ref("[^"]*")/const marker = ref("${v}")/' src/App.vue`;
        const result = await cmdStub.__executeOperation(meshEnvelope('exec', [{ cmd: sed, shell: true }]));
        return Response.json({
          probe: 'touch',
          wroteMarker: v,
          code: result?.$result?.code,
          expect: `browser shows "marker ${v}" via HMR (no full page reload)`,
        });
      }
      if (url.pathname === '/coexistence') {
        // Phase-0 coexistence smoke (was the default route before the preview passthrough).
        const meshResult = await cmdStub.__executeOperation(meshEnvelope('ping'));
        const coexistence = await cmdStub.coexistence();
        return Response.json({ probe: 'coexistence', meshResult, coexistence });
      }
      // Default: TRANSPARENT preview passthrough so a real browser can MOUNT the app
      // and get HMR (the Phase-2 browser half). The DO fetch() does its 3-way branch
      // (WS verbatim / shell HTML + injected scope / asset stream). A WS upgrade (vite
      // HMR) forwards the original request — identity is already stamped in the DO's kv
      // from the HTML GET, so initIdentityFromHeaders no-ops harmlessly; other requests
      // carry the routed headers so the shell's scope derives server-side.
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return previewStub.fetch(request);
      }
      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.set('x-lumenize-do-binding-name', 'SMOKE');
      fwdHeaders.set('x-lumenize-do-instance-name-or-id', PREVIEW_SCOPE);
      return previewStub.fetch(new Request(request, { headers: fwdHeaders }));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, { status: 500 });
    }
  },
};
