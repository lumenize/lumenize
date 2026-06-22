/**
 * DevStudio — the Studio code-generation engine, the **sole writer of source**, and
 * the **source-of-truth** (a shell `Workspace` (SQLite + R2) + local git via
 * isomorphic-git). A Nebula server DO addressed at the `{u}.{g}.dev` instance,
 * per-sandbox. Studio UI talks ONLY to DevStudio; DevStudio orchestrates the loop:
 * it commits source locally, applies the compiled ontology to the `.dev` Star, and
 * **pushes** changed source to the DevContainer (`applyChanges`) — Flow 1 / 1b / 1c.
 *
 * `extends NebulaDO` for the structural tenant-isolation `onBeforeCall` (the
 * `{u}.{g}.dev` scope guard); every method carries `@mesh(requireAdmin)` on top
 * (onBeforeCall proves *scope*, never `access.admin`, and `<id>.*` widening admits
 * descendant non-admins). Node↔node calls are mesh only (`lmz.callRaw`, ADR-003 —
 * never raw Workers RPC).
 *
 * The codegen *loop / system prompt* that drives `writeSource` is the engine file's
 * concern (`nebula-agentic-development-engine.md`); this node provides only the
 * primitives it runs on. Mechanism proven in `experiments/interim-dev-loop`
 * (shell + isomorphic-git in a DO + the mesh transport, Stages 1–3).
 *
 * **Source-of-truth lives in `ctx.storage.sql`** (the shell Workspace); `#ws`/`#fs`/
 * `#git` are caches over it, reconstructed in `onStart` (the Star pattern — no
 * mutable durable state in instance fields). The optional Artifacts git remote is a
 * later swap behind the same `createGit` seam (Decision 6) — not in the shipping path.
 *
 * @see tasks/nebula-studio.md § DevStudio node
 * @see tasks/nebula-dev-flows.md — Flow 1 / 1b / 1c + § Source abstraction
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { Workspace, WorkspaceFileSystem } from '@cloudflare/shell';
import { createGit } from '@cloudflare/shell/git';
import git from 'isomorphic-git';
import { NebulaDO, requireAdmin } from './nebula-do';
import { compileOntologyVersion } from './galaxy';
import type { Star } from './star';
import type { DevContainer, SourceFile } from './dev-container';

/** The `.dev` data-Star binding. Post-collapse (Decision 2) there is one `STAR`
 *  binding; the dev Star is the `{u}.{g}.dev` *instance* on it. */
const STAR_BINDING = 'STAR';
/** The dev preview container binding (per-sandbox, same `{u}.{g}.dev` instance). */
const DEV_CONTAINER_BINDING = 'DEV_CONTAINER';

/** The ontology source file — compiled to the runtime validator (Decision 9: the
 *  ontology is just another source file). */
const ONTOLOGY_PATH = 'src/ontology.d.ts';

const AUTHOR = { name: 'DevStudio', email: 'dev@nebula.studio' };
const PATHS_KEY = 'devstudio:paths';
const INITED_KEY = 'devstudio:inited';

/** Minimal HTML escape for embedding the chat message into the stub App.vue. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** The placeholder `App.vue` the STUB codegen writes (step 2) — replaced by the Kimi
 *  engine's real generation later (nebula-agentic-development-engine.md). */
function stubAppVue(message: string): string {
  return `<template>
  <main class="mx-auto max-w-xl p-8 flex flex-col gap-4">
    <h1 class="text-2xl font-bold">${escapeHtml(message)}</h1>
    <p class="text-base-content/70">(stub codegen — the Kimi engine will generate the real app here)</p>
  </main>
</template>
`;
}

export class DevStudio extends NebulaDO {
  // Caches over `ctx.storage.sql` (the durable Workspace) — reconstructed in onStart,
  // never the source of truth. `!`-asserted: onStart runs (inside the base
  // blockConcurrencyWhile) before any @mesh method.
  #ws!: Workspace;
  #fs!: WorkspaceFileSystem;
  #git!: ReturnType<typeof createGit>;

  /** Reconstruct the shell Workspace + git over `ctx.storage.sql`, and `git init`
   *  once (latched in kv). Async — runs inside the base `blockConcurrencyWhile`, so
   *  requests block until it completes (durable-objects.md § Initialization). */
  override async onStart(): Promise<void> {
    this.#ws = new Workspace({ sql: this.ctx.storage.sql, namespace: 'src' });
    this.#fs = new WorkspaceFileSystem(this.#ws);
    this.#git = createGit(this.#fs, '/');
    if (!this.ctx.storage.kv.get(INITED_KEY)) {
      await this.#git.init({ defaultBranch: 'main' });
      this.ctx.storage.kv.put(INITED_KEY, true);
    }
  }

  #trackedPaths(): Set<string> {
    return new Set<string>(this.ctx.storage.kv.get<string[]>(PATHS_KEY) ?? []);
  }
  #recordPath(rel: string): void {
    const s = this.#trackedPaths();
    if (!s.has(rel)) {
      s.add(rel);
      this.ctx.storage.kv.put(PATHS_KEY, [...s]);
    }
  }

  /**
   * The engine's core write: persist one edit to the working copy + `git commit`
   * (local, durable — the source-of-truth write). Returns the commit oid. Pushing
   * the change to the DevContainer (`syncToDevContainer`) and applying a changed
   * ontology (`compileAndInstallOntology`) are SEPARATE steps the engine composes after — kept
   * separable so the durable write is independently testable (success criterion:
   * "writeSource persists to the Workspace + git commit") and the container push
   * stays deploy-isolated.
   */
  @mesh(requireAdmin)
  async writeSource(path: string, content: string): Promise<{ oid: string; path: string }> {
    const rel = path.replace(/^\/+/, '');
    await this.#fs.writeFile('/' + rel, content);
    await this.#git.add({ filepath: rel });
    const { oid } = await this.#git.commit({ message: `edit ${rel}`, author: AUTHOR });
    this.#recordPath(rel);
    debug('nebula.DevStudio.writeSource').debug('commit', {
      instanceName: this.lmz.instanceName,
      path: rel,
      oid,
    });
    return { oid, path: rel };
  }

  /** Local read — the LLM hot path (read relevant files into context). */
  @mesh(requireAdmin)
  async readSource(path: string): Promise<string> {
    return this.#fs.readFile('/' + path.replace(/^\/+/, ''));
  }

  /** Full source tree + HEAD — what DevStudio re-pushes to a cold-booted DevContainer
   *  (Flow 1c). Full-tree by design (dev apps are small; the Artifacts swap would make
   *  it incremental — Decision 6). */
  @mesh(requireAdmin)
  async getSourceTree(): Promise<{ head: string | null; files: SourceFile[] }> {
    const files: SourceFile[] = [];
    for (const p of this.#trackedPaths()) files.push({ path: p, content: await this.#fs.readFile('/' + p) });
    let head: string | null = null;
    try {
      const log = await this.#git.log({ depth: 1 });
      head = log[0]?.oid ?? null;
    } catch {
      // Fresh repo: `git init` created the branch pointer but no commit resolves
      // `refs/heads/main` yet (NotFoundError). A brand-new sandbox re-pushed before
      // its first writeSource (Flow 1c) has an empty tree — head: null, files: [].
      head = null;
    }
    return { head, files };
  }

  /** Read the ontology source + its content-addressed version (`hashBlob` of the
   *  `.d.ts`). The SINGLE source of the version label — used to install on the Star
   *  AND (via {@link applyOntologyChange}) to inject into the DevContainer shell, so
   *  the two always agree by construction (Decision 12 / Flow 1d). */
  async #readOntology(): Promise<{ types: string; version: string }> {
    const types = await this.#fs.readFile('/' + ONTOLOGY_PATH);
    const { oid: version } = await git.hashBlob({ object: types });
    return { types, version };
  }

  /**
   * Compile the ontology `.d.ts` to a validator and install it on the `.dev` Star
   * (Decision 9 — the Star never compiles; it receives the compiled validator).
   * REPLACES `DevStar.deployToDev`'s Galaxy round-trip (Phase 4 deleted that) — do
   * NOT route dev compile through the Galaxy DO.
   *
   * `version` is content-addressed (`git.hashBlob` of the ontology source — via
   * `#readOntology`) so the Star's Worker Loader cache (`bundleId = galaxyId/version`)
   * never serves a stale validator for changed ontology (durable-objects.md § Worker
   * Loader cache), and the same source pins the same version dev↔prod (Decision 12).
   *
   * **Star-only — independently testable.** This installs on the Star (and, on a new
   * version, the Star fires `broadcastReload`). The DevContainer side (inject the same
   * version + push source) is the SEPARATE {@link applyOntologyChange} wrapper, which
   * orders the container push BEFORE this install — keep them separate so this stays
   * testable without a live container.
   *
   * **Flow 1b wipe gating** (Decision 11): on an ontology change the user decides
   * whether to wipe `.dev` data (breaking edits invalidate stored snapshots). The
   * decision arrives via the server→client prompt round-trip (`promptWipe` →
   * `wipeDecision`, deploy/integration-gated — it reaches the browser client over
   * mesh); here it is the `wipe` argument. When `wipe`, `resetDevData` runs BEFORE
   * `setOntology` so the new validator applies to a clean Star. The engine gates the
   * source-push on this completing (so the preview never lands new code on stale data).
   */
  @mesh(requireAdmin)
  async compileAndInstallOntology({ wipe = false }: { wipe?: boolean } = {}): Promise<{ version: string }> {
    const { types, version } = await this.#readOntology();
    const row = compileOntologyVersion({ version, types });
    const instance = this.lmz.instanceName!;
    if (wipe) {
      await this.lmz.callRaw(STAR_BINDING, instance, this.ctn<Star>().resetDevData());
    }
    await this.lmz.callRaw(STAR_BINDING, instance, this.ctn<Star>().setOntology(row));
    debug('nebula.DevStudio.compileAndInstallOntology').debug('applied', { instanceName: instance, version, wiped: wipe });
    return { version };
  }

  /**
   * Propagate an ontology change to the live preview in the order the version
   * contract requires (Decision 12 / Flow 1d-ii): push the new version + source to
   * the DevContainer FIRST, THEN install on the `.dev` Star — whose `setOntology`
   * fires `broadcastReload`, so the reloaded preview re-fetches the shell at the NEW
   * injected version. Reversing the order would reload the preview onto the OLD
   * injected version (a transient extra reload until it heals). The Flow-1b wipe
   * decision is the `wipe` arg.
   *
   * ⚠️ Deploy-gated — the container calls (`setAppVersion`/`syncToDevContainer`) need
   * a live container (same constraint as `ensureUp`/`syncToDevContainer`); the Star
   * half (`compileAndInstallOntology`) is independently testable.
   */
  @mesh(requireAdmin)
  async applyOntologyChange({ wipe = false }: { wipe?: boolean } = {}): Promise<{ version: string }> {
    const { version } = await this.#readOntology();
    const instance = this.lmz.instanceName!;
    await this.lmz.callRaw(DEV_CONTAINER_BINDING, instance, this.ctn<DevContainer>().setAppVersion(version));
    await this.syncToDevContainer([ONTOLOGY_PATH]);
    return this.compileAndInstallOntology({ wipe });
  }

  /**
   * Cold-boot population (Flow 1c): wait for the container (boot-race retry inside
   * `ensureUp`), then push the full source tree. ⚠️ Deploy-gated — `DevContainer`
   * `extends Container` can't construct under vitest-pool-workers; exercised on a
   * deployed Worker (the assembled e2e `it.skip`).
   */
  @mesh(requireAdmin)
  async ensureUp(): Promise<{ written: number }> {
    const instance = this.lmz.instanceName!;
    await this.lmz.callRaw(DEV_CONTAINER_BINDING, instance, this.ctn<DevContainer>().ensureUp());
    const tree = await this.getSourceTree();
    const res = await this.lmz.callRaw(
      DEV_CONTAINER_BINDING, instance, this.ctn<DevContainer>().applyChanges(tree.files),
    );
    return { written: res.written };
  }

  /**
   * Push changed source files to the DevContainer (`applyChanges` → vite HMR, Flow 1).
   * Default = the full tracked tree; pass `paths` to push a subset. ⚠️ Deploy-gated
   * (same reason as `ensureUp`).
   */
  @mesh(requireAdmin)
  async syncToDevContainer(paths?: string[]): Promise<{ written: number }> {
    const want = paths ? new Set(paths.map((p) => p.replace(/^\/+/, ''))) : this.#trackedPaths();
    const files: SourceFile[] = [];
    for (const p of want) files.push({ path: p, content: await this.#fs.readFile('/' + p) });
    const res = await this.lmz.callRaw(
      DEV_CONTAINER_BINDING, this.lmz.instanceName!, this.ctn<DevContainer>().applyChanges(files),
    );
    return { written: res.written };
  }

  /**
   * STUB codegen (step 2 — the visible loop *without* AI yet). Turns the chat message
   * into a trivial `App.vue` placeholder + seeds a starter ontology on first run, so the
   * full loop (chat → write source → push → preview updates) is exercisable before the
   * Kimi engine is wired — that swaps this body (nebula-agentic-development-engine.md).
   * The Studio UI reloads the preview iframe on the reply (HMR-under-prefix is deferred).
   *
   * ⚠️ Deploy-gated — calls the container methods (`ensureUp`/`syncToDevContainer`); runs
   * under `wrangler dev` + Docker Desktop, not vitest-pool-workers.
   */
  @mesh(requireAdmin)
  async chat(message: string): Promise<{ reply: string; version: string | null }> {
    await this.ensureUp(); // Flow 1c: container up + source pushed
    // Seed a starter ontology on first run so the data path has a version.
    let hasOntology = true;
    try { await this.#fs.readFile('/' + ONTOLOGY_PATH); } catch { hasOntology = false; }
    if (!hasOntology) {
      await this.writeSource(ONTOLOGY_PATH, 'export interface Note {\n  title: string;\n  body: string;\n}\n');
    }
    await this.writeSource('src/App.vue', stubAppVue(message));
    await this.syncToDevContainer();
    let version: string | null = null;
    try {
      ({ version } = await this.applyOntologyChange({}));
    } catch {
      // best-effort in the stub — the placeholder renders without a live ontology
    }
    debug('nebula.DevStudio.chat').debug('stub-generated', { instanceName: this.lmz.instanceName, version });
    return { reply: `Stub codegen wrote a placeholder app for: "${message}"`, version };
  }
}
