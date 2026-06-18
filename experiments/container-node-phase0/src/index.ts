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
 * m3 (the node-type review finding): container-unavailability is surfaced as a
 * recognizable typed error over the mesh — NOT a 200 carrying a 503 body.
 * `containerFetch` returns 503 (no instance) / 429 (rate-limit) as Responses, not
 * throws, so the channel checks status and throws this instead. Detect via
 * `err.name === 'ContainerUnavailableError'` + the `retryable` flag (mesh.md).
 */
export class ContainerUnavailableError extends Error {
  status: number;
  retryable = true;
  constructor(status: number) {
    super(`Container unavailable (HTTP ${status}): starting, evicted, or at capacity`);
    this.name = 'ContainerUnavailableError';
    this.status = status;
  }
}

/**
 * Phase-1 DevContainer command-channel smoke. A real `LumenizeContainer` node
 * with the spike's proven vite app + command-server, now driven over the **mesh**
 * (`@mesh` methods) instead of the spike's raw RPC:
 *  - public `fetch()` proxies vite (`defaultPort = 5173`) — incl. the M1
 *    `cf-container-target-port` strip + the B1 fetch()-path identity stamp
 *    (both inherited from `LumenizeContainer`).
 *  - the agent command channel is the `@mesh` methods below, each
 *    `containerFetch(CMD_PORT)` → the command-server on 9000 (reachable ONLY here,
 *    never the public surface — the Q5 trust boundary).
 *
 * Class name stays `SmokeContainer` so redeploy overwrites the Phase-0 deploy
 * with no DO-rename migration. Throwaway (pruned when the real `DevContainer`
 * lands in `apps/nebula`). See tasks/nebula-container-dev-loop.md Phase 1.
 */
export class SmokeContainer extends LumenizeContainer {
  defaultPort = 5173; // public vite preview surface
  sleepAfter = '5m';  // warm-while-focused (spike Q1/Q4)

  /** Send a command to the in-container command-server (9000). Surfaces a
   *  503/429 as a typed error rather than a successful 200 with an error body. */
  async #cmd(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.containerFetch(new Request(`http://cmd.local${path}`, init), CMD_PORT);
    if (res.status === 503 || res.status === 429) throw new ContainerUnavailableError(res.status);
    return res;
  }

  /** Channel-latency probe (no child spawn) — pure DO→container→back. */
  @mesh()
  async noop(): Promise<{ ok: boolean }> {
    return (await this.#cmd('/healthz')).json();
  }

  /** Run a buffered command in the container working tree. */
  @mesh()
  async exec(payload: { cmd: string; args?: string[]; shell?: boolean; cwd?: string }): Promise<ExecResult> {
    const res = await this.#cmd('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json() as Promise<ExecResult>;
  }

  /** Write a source file into the working tree (vite HMR picks it up). */
  @mesh()
  async writeFile(payload: { path: string; content: string }): Promise<WriteResult> {
    const res = await this.#cmd('/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json() as Promise<WriteResult>;
  }

  /** Manage the vite dev server (the command-server is its supervisor). */
  @mesh()
  async viteControl(action: 'restart' | 'stop' | 'start'): Promise<ViteResult> {
    const res = await this.#cmd(`/vite/${action}`, { method: 'POST' });
    return res.json() as Promise<ViteResult>;
  }

  /** @mesh receive-path probe — returns this node's composed identity. */
  @mesh()
  ping(): string {
    return `pong from ${this.lmz.instanceName ?? '(no instance name)'}`;
  }

  /** Direct-RPC probe: Container's own lifecycle state coexisting with the
   *  composed Lumenize identity (Phase-0 m2 coexistence, kept). */
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
}

const INSTANCE_NAME = 'phase0-smoke';

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
    metadata: { callee: { type: 'LumenizeDO', bindingName: 'SMOKE', instanceName: INSTANCE_NAME } },
  };
}

export default {
  async fetch(request: Request, env: { SMOKE: DurableObjectNamespace }): Promise<Response> {
    const url = new URL(request.url);
    const stub = (env.SMOKE as any).getByName(INSTANCE_NAME);
    const drive = (method: string, args: unknown[] = []) => stub.__executeOperation(meshEnvelope(method, args));

    try {
      if (url.pathname === '/cmd') {
        // Command channel over the mesh: cold-starts the container, runs git in it.
        const result = await drive('exec', [{ cmd: 'git', args: ['--version'] }]);
        return Response.json({ probe: 'cmd/exec(git --version)', result });
      }
      if (url.pathname === '/preview') {
        // Public preview: the DO's fetch() proxies vite (defaultPort 5173).
        const res = await stub.fetch(new Request('https://preview.local/'));
        return Response.json({ probe: 'preview', status: res.status, snippet: (await res.text()).slice(0, 200) });
      }
      if (url.pathname === '/boundary') {
        // Trust boundary: a public request carrying cf-container-target-port:9000
        // must be STRIPPED → reaches vite (5173), NOT the command-server (9000).
        const res = await stub.fetch(
          new Request('https://preview.local/', { headers: { 'cf-container-target-port': String(CMD_PORT) } }),
        );
        return Response.json({
          probe: 'boundary(header-strip)',
          status: res.status,
          snippet: (await res.text()).slice(0, 200),
          expect: 'vite shell, not the command-server',
        });
      }
      // default: Phase-0 coexistence smoke (kept).
      const meshResult = await drive('ping');
      const coexistence = await stub.coexistence();
      return Response.json({ probe: 'coexistence', meshResult, coexistence });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, { status: 500 });
    }
  },
};
