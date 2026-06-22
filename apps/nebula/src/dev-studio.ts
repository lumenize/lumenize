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
import {
  generateParseModule,
  getParserValidatorFacet,
  type ParserValidator,
} from '@lumenize/ts-runtime-parser-validator';
import { NebulaDO, requireAdmin } from './nebula-do';
import { compileOntologyVersion } from './galaxy';
import type { Galaxy, TurnRecord } from './galaxy';
import type { Star } from './star';
import type { DevContainer, SourceFile } from './dev-container';
import {
  runCodegenLoop,
  assembleCodegenPrompt,
  CODEGEN_TOOLS,
  TOOL_ARGS_TYPES,
  TOOL_ARGS_BUNDLE_ID,
  TOOL_ARG_TYPE,
  DEFAULT_LOOP_CONFIG,
  type CodegenLoopConfig,
  type CodegenLoopDeps,
  type ChatMessage,
  type ModelParams,
  type LoopResult,
} from './codegen-loop';

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

/** Minimal, *structural* system bundle for the tool-calling loop — the seed of the
 *  composable cascade (D7). The make-it-data-bound *content* is the engine file's
 *  exploratory concern; this only establishes the tool protocol + output constraints.
 *  Model-agnostic (`studio-model-agnostic-naming`) — no vendor name appears. */
const STUDIO_LOOP_SYSTEM_PROMPT = `You are Studio, an assistant that builds a small web app as a Vue 3 Single-File Component (src/App.vue).
Use the provided tools — do not output code in your reply:
- Call write_file with the COMPLETE new contents of a file. The file is compiled immediately and the result is returned; if it does not compile, read the error, fix it, and call write_file again.
- When every file compiles cleanly and the app is done, call mark_complete.
Rules:
- Vue 3 with <script setup lang="ts"> and a <template>.
- Style ONLY with Tailwind utility classes and DaisyUI component classes (both are already available).
- You may import icons from "lucide-vue-next". Do not import any other package.`;

export class DevStudio extends NebulaDO {
  // Caches over `ctx.storage.sql` (the durable Workspace) — reconstructed in onStart,
  // never the source of truth. `!`-asserted: onStart runs (inside the base
  // blockConcurrencyWhile) before any @mesh method.
  #ws!: Workspace;
  #fs!: WorkspaceFileSystem;
  #git!: ReturnType<typeof createGit>;
  // Re-derivable cache (loss acceptable) — the tool-args typia validator facet
  // (durable-objects.md "ephemeral caches", same pattern as Star.#facet).
  #toolArgsFacet?: ParserValidator;

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
   * ⚠️ Run with `wrangler dev` — the container calls (`setAppVersion`/`syncToDevContainer`) need
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
   * `ensureUp`), then push the full source tree. ⚠️ Run with `wrangler dev` — `DevContainer`
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
   * Default = the full tracked tree; pass `paths` to push a subset. ⚠️ Run with `wrangler dev`
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
   * The codegen turn (Flow 1): ensure the container is up + source pushed, drive the
   * bounded self-correcting loop ({@link runCodegenTurn} — which writes source to the
   * Workspace, runs the Rung-1 compile on each write, self-corrects on the error-tail,
   * and records the turn), then on a clean finish PUSH the written source to the
   * DevContainer so vite HMR updates the preview.
   *
   * Install/wipe is deliberately NOT here: a changed ontology is applied to the `.dev`
   * Star via the SEPARATE, human-gated apply step ({@link applyOntologyChange}, Flow 1b)
   * fired after the loop — the loop's `write_file` tool only compiles, never installs or
   * wipes (D2 secure-by-default). Returns `reply` + `thought` for the Studio UI's
   * waiting → thought-process view; the model id is never surfaced (model-agnostic).
   *
   * ⚠️ Run with `wrangler dev` — `ensureUp`/`syncToDevContainer` need a live container and the loop
   * calls `env.AI.run`; runs under `wrangler dev` + Docker Desktop, not vitest-pool-workers.
   */
  @mesh(requireAdmin)
  async chat(message: string): Promise<{ reply: string; thought: string }> {
    await this.ensureUp(); // Flow 1c: container up + source pushed
    const result = await this.runCodegenTurn(message);
    // On a clean finish, push the written source so the live preview updates (source-of-
    // truth is already committed in the Workspace regardless). A non-clean finish leaves
    // the preview on the last good push rather than landing unconverged code.
    if (result.stop === 'complete' && result.appliedPaths.length > 0) {
      await this.syncToDevContainer(result.appliedPaths);
    }
    debug('nebula.DevStudio.chat').debug('loop', {
      instanceName: this.lmz.instanceName, stop: result.stop,
      rounds: result.rounds, applied: result.appliedPaths.length,
    });

    let reply: string;
    if (result.stop === 'complete') {
      reply = result.appliedPaths.length > 0 ? 'Updated the preview.' : 'Done — no changes.';
    } else if (result.stop === 'no-tool-calls') {
      reply = result.output || 'See the thought process.';
    } else {
      reply = "I couldn't finish cleanly — see the thought process.";
    }

    // A useful thought-process view even when the model emitted only tool calls (no text):
    // reasoning + final output + a short trace of what the loop did.
    const files = [...new Set(result.appliedPaths)];
    const compile = result.lastGate
      ? (result.lastGate.ok ? 'compiled ✓' : `compile error:\n${result.lastGate.errorTail}`)
      : 'no files written';
    const parts: string[] = [];
    if (result.reasoning) parts.push(`🧠 Reasoning\n\n${result.reasoning}`);
    if (result.output) parts.push(`📄 ${result.output}`);
    parts.push(`🔧 ${result.detail ?? result.stop}\nFiles: ${files.join(', ') || '(none)'} — ${compile}`);
    return { reply, thought: parts.join('\n\n— — —\n\n') };
  }

  // ─── Self-correcting codegen loop (tasks/archive/nebula-codegen-loop.md) ─────────

  /** Mount (or reuse) the tool-args typia validator facet — derived from
   *  {@link TOOL_ARGS_TYPES} via `generateParseModule` (ADR-001: TS types are the
   *  schema). Shared bundle id across tenants (the tool surface is not tenant data). */
  #ensureToolArgsFacet(): ParserValidator {
    if (!this.#toolArgsFacet) {
      this.#toolArgsFacet = getParserValidatorFacet(
        this.ctx,
        this.env.LOADER,
        TOOL_ARGS_BUNDLE_ID,
        () => generateParseModule(TOOL_ARGS_TYPES),
      );
    }
    return this.#toolArgsFacet;
  }

  /** D5 trust boundary: typia-validate the untrusted model's tool-call args (shape
   *  only — path *safety* is `assertSafeRelPath`, enforced in the loop). */
  async #validateToolArgs(
    toolName: string,
    args: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const typeName = TOOL_ARG_TYPE[toolName];
    if (!typeName) return { ok: false, error: `unknown tool '${toolName}'` };
    const res = await this.#ensureToolArgsFacet().parse(args, typeName);
    if (res.valid) return { ok: true };
    const detail = res.errors.map((e) => `${e.path}: expected ${e.expected}`).join('; ');
    return { ok: false, error: `invalid ${toolName} args — ${detail}` };
  }

  /**
   * One model inference for the loop. **Overridable seam** (`protected`, no `@mesh`)
   * so the Phase-2/3 test harness replays a synthetic script with no AI binding; the
   * shipping path calls `env.AI.run` with the codegen tools + per-call params (D6).
   * The model id stays isolated to `STUDIO_MODEL` and is never surfaced.
   */
  protected async callModel(messages: ChatMessage[], params: ModelParams): Promise<unknown> {
    // The model-catalog types don't cover every @cf id; run() is treated loosely.
    return (this.env.AI as any).run(STUDIO_MODEL, {
      messages,
      tools: CODEGEN_TOOLS,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    });
  }

  /**
   * Drive one bounded, self-correcting codegen turn: assemble the layered prompt
   * (ontology pinned in the system block, request + current source in the user
   * layer — D7), run {@link runCodegenLoop}, and record the turn (the loop is the
   * first populator of `TurnRecord.toolCalls` / `.error` / `.validate`). Returns the
   * loop result. `chat()` will call this (Phase 4); install/wipe stays the separate,
   * human-gated apply step fired AFTER a clean finish (Flow 1b) — never reachable
   * from the loop's `write_file` tool (D2).
   *
   * `protected` (not `@mesh`): an internal capability, not a remote API. The test
   * harness reaches it through a test-only `@mesh` entry on a subclass.
   */
  protected async runCodegenTurn(
    userRequest: string,
    config: CodegenLoopConfig = DEFAULT_LOOP_CONFIG,
  ): Promise<LoopResult> {
    let currentSource = '';
    try { currentSource = await this.#fs.readFile('/src/App.vue'); } catch { /* none yet */ }
    let ontologyDts: string | undefined;
    try { ontologyDts = await this.#fs.readFile('/' + ONTOLOGY_PATH); } catch { /* none yet */ }

    const initial = assembleCodegenPrompt({
      systemBundles: [STUDIO_LOOP_SYSTEM_PROMPT],
      ontologyDts,
      userRequest,
      currentSource,
    });
    const deps: CodegenLoopDeps = {
      callModel: (m, p) => this.callModel(m, p),
      writeFile: (path, content) => this.writeSource(path, content),
      validateToolArgs: (n, a) => this.#validateToolArgs(n, a),
    };
    const result = await runCodegenLoop(initial, deps, config);

    this.#recordTurn({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      instance: this.lmz.instanceName!,
      model: STUDIO_MODEL,
      systemPrompt: initial.system.content,
      userMessage: userRequest,
      currentSource,
      output: result.output,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      applied: result.appliedPaths.length > 0,
      appliedPath: result.appliedPaths.at(-1),
      error: result.lastGate && !result.lastGate.ok ? result.lastGate.errorTail : undefined,
      validate: result.lastGate,
    });
    return result;
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
