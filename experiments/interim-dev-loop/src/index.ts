import { LumenizeDO, mesh } from '@lumenize/mesh';
import { LumenizeContainer } from '@lumenize/mesh/container';
import { Workspace, WorkspaceFileSystem } from '@cloudflare/shell';
import { createGit } from '@cloudflare/shell/git';
import { preprocess } from '@lumenize/structured-clone';

// Stage 3 — the interim dev loop, MESH-COMPLIANT (fixes the Stage-1/2 rule-breaks):
//  - DevStudio is a real mesh node (LumenizeDO) with @mesh methods + shell Workspace + local git.
//  - DevContainer.pull() reaches DevStudio over MESH (this.lmz.callRaw), not raw Workers RPC.
//  - callRaw for the single getSourceTree hop (needs the value inline); pull() RETURNS its result,
//    so the caller gets completion as the response — NO polling (test or prod).
// All source ops sit behind the shell FileSystem + createGit seam; the git remote (Artifacts) is an
// optional later swap. The only accepted rule-break is a future Artifacts `git pull` (HTTPS egress).

const INSTANCE = 'demo.app.dev';
const CMD_PORT = 8080;
const AUTHOR = { name: 'DevStudio', email: 'dev@nebula.studio' };

export class DevStudio extends LumenizeDO {
  #ws: Workspace;
  #fs: WorkspaceFileSystem;
  #git: ReturnType<typeof createGit>;
  #ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.#ws = new Workspace({ sql: ctx.storage.sql, namespace: 'src' });
    this.#fs = new WorkspaceFileSystem(this.#ws);
    this.#git = createGit(this.#fs, '/');
    this.#ready = this.#init();
  }

  async #init(): Promise<void> {
    if (this.ctx.storage.kv.get('inited')) return;
    await this.#git.init({ defaultBranch: 'main' });
    this.ctx.storage.kv.put('inited', '1');
  }
  #paths(): Set<string> {
    return new Set<string>(JSON.parse((this.ctx.storage.kv.get('paths') as string) ?? '[]'));
  }
  #savePaths(s: Set<string>): void {
    this.ctx.storage.kv.put('paths', JSON.stringify([...s]));
  }

  /** Apply one AI edit: write working copy + git commit (local, isomorphic-git). */
  @mesh()
  async writeSource(path: string, content: string): Promise<{ oid: string; path: string }> {
    await this.#ready;
    const rel = path.replace(/^\/+/, '');
    await this.#fs.writeFile('/' + rel, content);
    await this.#git.add({ filepath: rel });
    const { oid } = await this.#git.commit({ message: `edit ${rel}`, author: AUTHOR });
    const s = this.#paths(); s.add(rel); this.#savePaths(s);
    return { oid, path: rel };
  }

  /** Full source tree + HEAD — what DevContainer.pull() fetches over mesh (full-tree by design). */
  @mesh()
  async getSourceTree(): Promise<{ head: string | null; files: { path: string; content: string }[] }> {
    await this.#ready;
    const files: { path: string; content: string }[] = [];
    for (const p of this.#paths()) files.push({ path: p, content: await this.#fs.readFile('/' + p) });
    const log = await this.#git.log({ depth: 1 });
    return { head: log[0]?.oid ?? null, files };
  }
}

export class DevContainer extends LumenizeContainer {
  defaultPort = CMD_PORT;
  sleepAfter = '10m';

  // Self-retries the cold container (first containerFetch races boot) so the loop never polls.
  async #cmd(path: string, body?: unknown): Promise<any> {
    const init = body !== undefined
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : undefined;
    for (let i = 0; i < 12; i++) {
      const res = await this.containerFetch(new Request(`http://cmd.local${path}`, init), CMD_PORT);
      const text = await res.text();
      if (res.ok) { try { return JSON.parse(text); } catch { /* non-JSON → cold, retry */ } }
      await new Promise((r) => setTimeout(r, 1200));
    }
    throw new Error('container unavailable after retries');
  }

  @mesh()
  async healthz(): Promise<{ ok: boolean }> { return this.#cmd('/healthz'); }

  /**
   * pull() — reconcile the checkout to DevStudio's HEAD. Fetches the tree over MESH
   * (callRaw, single hop — needs the value inline) and writes it. RETURNS {written, head}
   * so the caller gets completion as the response (no polling). The Artifacts swap replaces
   * the callRaw body with a real `git pull`; the @mesh signature + callers are unchanged.
   */
  @mesh()
  async pull(): Promise<{ written: number; head: string | null }> {
    const tree = await this.lmz.callRaw('DEV_STUDIO', INSTANCE, this.ctn<DevStudio>().getSourceTree());
    for (const f of tree.files) await this.#cmd('/write', { path: f.path, content: f.content });
    return { written: tree.files.length, head: tree.head };
  }

  @mesh()
  async readFileInContainer(path: string): Promise<{ content: string }> { return this.#cmd('/read', { path }); }
}

// --- worker: drive everything over the mesh receive seam (no raw method RPC) ----------------
type Callee = { type: string; bindingName: string; instanceName: string };
const STUDIO: Callee = { type: 'LumenizeDO', bindingName: 'DEV_STUDIO', instanceName: INSTANCE };
const CONTAINER: Callee = { type: 'LumenizeContainer', bindingName: 'DEV_CONTAINER', instanceName: INSTANCE };

function envelope(callee: Callee, method: string, args: unknown[] = []) {
  return {
    version: 1,
    chain: preprocess([{ type: 'get', key: method }, { type: 'apply', args }]),
    callContext: { callChain: [], state: {} },
    metadata: { callee },
  };
}
const unwrap = (r: any) => (r && typeof r === 'object' && '$result' in r ? r.$result : r);

export default {
  async fetch(
    request: Request,
    env: { DEV_STUDIO: DurableObjectNamespace<DevStudio>; DEV_CONTAINER: DurableObjectNamespace<DevContainer> },
  ): Promise<Response> {
    const url = new URL(request.url);
    const studio = (env.DEV_STUDIO as any).getByName(INSTANCE);
    const dc = (env.DEV_CONTAINER as any).getByName(INSTANCE);
    const callStudio = async (m: string, a: unknown[] = []) => unwrap(await studio.__executeOperation(envelope(STUDIO, m, a)));
    const callDC = async (m: string, a: unknown[] = []) => unwrap(await dc.__executeOperation(envelope(CONTAINER, m, a)));

    try {
      if (url.pathname === '/loop') {
        const before = await callStudio('writeSource', ['src/App.vue', '<template>warm</template>\n']);
        const marker = `MARKER-${before.oid.slice(0, 8)}`;
        const edit = await callStudio('writeSource', ['src/App.vue', `<template>${marker}</template>\n`]);
        const pulled = await callDC('pull');                          // mesh → callRaw → write; returns result
        const landed = await callDC('readFileInContainer', ['src/App.vue']);
        return Response.json({
          stage: 3,
          marker,
          edit,
          pulled,
          landedContent: landed.content,
          ok: landed.content.includes(marker),
          headsMatch: pulled.head === edit.oid,
        });
      }
      return new Response('routes: /loop (stage 3 — mesh-compliant)');
    } catch (e) {
      return Response.json(
        { stage: 3, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stack: e instanceof Error ? e.stack?.split('\n').slice(0, 10) : undefined },
        { status: 500 },
      );
    }
  },
};
