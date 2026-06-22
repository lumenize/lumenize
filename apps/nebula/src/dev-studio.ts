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
import type { Galaxy, TurnRecord } from './galaxy';
import type { Star } from './star';
import type { DevContainer, SourceFile } from './dev-container';

/** The `.dev` data-Star binding. Post-collapse (Decision 2) there is one `STAR`
 *  binding; the dev Star is the `{u}.{g}.dev` *instance* on it. */
const STAR_BINDING = 'STAR';
/** The dev preview container binding (per-sandbox, same `{u}.{g}.dev` instance). */
const DEV_CONTAINER_BINDING = 'DEV_CONTAINER';
/** This sandbox's Galaxy ({u}.{g}) — the turn-recorder store for the codegen corpus. */
const GALAXY_BINDING = 'GALAXY';

/** The ontology source file — compiled to the runtime validator (Decision 9: the
 *  ontology is just another source file). */
const ONTOLOGY_PATH = 'src/ontology.d.ts';

const AUTHOR = { name: 'DevStudio', email: 'dev@nebula.studio' };
const PATHS_KEY = 'devstudio:paths';
const INITED_KEY = 'devstudio:inited';

/** The codegen model id — the ONE place a vendor id appears. Swappable: Studio is
 *  model-agnostic, and the model name is never surfaced in the UI or elsewhere. */
const STUDIO_MODEL = '@cf/moonshotai/kimi-k2.7-code';

/** Minimal, *unevaluated* system prompt — the make-it-better + eval work is the engine
 *  file's concern (nebula-agentic-development-engine.md). Constrains the output to one
 *  self-contained Vue SFC using only the baked libs so the generated app actually runs. */
const STUDIO_SYSTEM_PROMPT = `You are Studio, an assistant that builds a small web app as a single Vue 3 Single-File Component.
When the user describes an app or a change, output the COMPLETE new contents of src/App.vue.
Rules:
- Vue 3 with <script setup lang="ts"> and a <template>.
- Hold all data in LOCAL reactive state (ref/reactive). Do NOT use any server, database, or external data layer.
- Style ONLY with Tailwind utility classes and DaisyUI component classes (both are already available).
- You may import icons from "lucide-vue-next". Do not import any other package.
- Output ONLY the file, in a single \`\`\`vue fenced code block, with no prose before or after.`;

/** Pull the first fenced code block out of the model output — the generated src/App.vue.
 *  Returns null when the output has no code block (the UI shows the raw output instead). */
function extractVueBlock(text: string): string | null {
  const m = text.match(/```(?:vue|html|ts|typescript)?\s*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
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
   * The codegen turn: send the user's request (with the current `App.vue` for context) to
   * the model, extract the generated `src/App.vue`, write + push it so the preview updates.
   * Returns the model's raw output as `thought` so the Studio UI can show the
   * waiting → thought-process view — visibility for iterating the (deliberately minimal,
   * unevaluated) prompt; the make-it-better/eval work is the engine file's concern
   * (nebula-agentic-development-engine.md).
   *
   * First cut: a single self-contained Vue SFC (local state, no data layer); data-bound
   * apps (ontology + client/store) come later. The Studio UI reloads the preview iframe on
   * the reply (HMR-under-prefix is deferred). ⚠️ Deploy-gated — container calls + the AI
   * binding; runs under `wrangler dev` (AI proxies to Workers AI), not vitest-pool-workers.
   */
  @mesh(requireAdmin)
  async chat(message: string): Promise<{ reply: string; thought: string }> {
    await this.ensureUp(); // Flow 1c: container up + source pushed
    let current = '';
    try { current = await this.#fs.readFile('/src/App.vue'); } catch { /* nothing generated yet */ }
    const userContent = current
      ? `Current src/App.vue:\n\`\`\`vue\n${current}\n\`\`\`\n\nUser request: ${message}`
      : `User request: ${message}`;
    // The model-catalog types don't cover every @cf model id; run() is treated loosely
    // (the model is a swappable string anyway).
    const out = (await (this.env.AI as any).run(STUDIO_MODEL, {
      messages: [
        { role: 'system', content: STUDIO_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    })) as any;
    // Workers AI returns either the OpenAI-style shape
    // ({ choices: [{ message: { content, reasoning_content } }] }) or { response } —
    // handle both so the model stays swappable. `reasoning_content` is the model's
    // chain-of-thought; `content` carries the fenced src/App.vue.
    const msg = out?.choices?.[0]?.message ?? {};
    const content: string =
      msg.content ?? out?.response ?? (typeof out === 'string' ? out : JSON.stringify(out));
    const reasoning: string = msg.reasoning_content ?? '';
    const appVue = extractVueBlock(content);
    if (appVue) {
      await this.writeSource('src/App.vue', appVue);
      await this.syncToDevContainer(['src/App.vue']);
    }
    const thought = reasoning
      ? `🧠 Reasoning\n\n${reasoning}\n\n— — —\n\n📄 Output\n\n${content}`
      : content;
    debug('nebula.DevStudio.chat').debug('generated', {
      instanceName: this.lmz.instanceName, applied: !!appVue, contentLen: content.length,
    });
    // Best-effort: record the turn to this sandbox's Galaxy for prompt iteration + eval.
    this.#recordTurn({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      instance: this.lmz.instanceName!,
      model: STUDIO_MODEL,
      systemPrompt: STUDIO_SYSTEM_PROMPT,
      userMessage: message,
      currentSource: current,
      output: content,
      reasoning,
      toolCalls: [],
      applied: !!appVue,
      appliedPath: appVue ? 'src/App.vue' : undefined,
    });
    return {
      reply: appVue ? 'Updated the preview.' : 'I could not extract a file — see the thought process.',
      thought,
    };
  }

  /**
   * Fire-and-forget: persist one codegen turn to this sandbox's Galaxy (`{u}.{g}`
   * derived from the `{u}.{g}.dev` instance). Best-effort telemetry — a recording
   * failure must never break the dev loop, so it's a 3-arg fire-and-forget mesh
   * call wrapped in try/catch. The Galaxy's scope pattern `{u}.{g}.*` covers this
   * dev star's `aud` and the origin user is a galaxy admin, so `recordTurn`'s
   * onBeforeCall + requireAdmin both pass. The corpus seeds the eval suite —
   * see tasks/nebula-agentic-development-engine.md Part 2.
   */
  #recordTurn(record: TurnRecord): void {
    try {
      const galaxy = this.lmz.instanceName!.split('.').slice(0, 2).join('.'); // {u}.{g}
      this.lmz.call(GALAXY_BINDING, galaxy, this.ctn<Galaxy>().recordTurn(record));
    } catch (e) {
      debug('nebula.DevStudio.recordTurn').warn('record failed (non-fatal)', { error: e });
    }
  }
}
