/**
 * DevStudio — the Studio code-generation engine, the **sole writer of source**, and
 * the **source-of-truth** (a shell `Workspace` (SQLite + R2) + local git via
 * isomorphic-git). A Nebula server DO addressed at the `{u}.{g}.dev` instance,
 * per-sandbox. Studio UI talks ONLY to DevStudio; DevStudio orchestrates the loop:
 * it commits source locally, applies the compiled ontology to the `.dev` Star, and
 * **pushes** changed source to the DevContainer (`applyChanges`) — Flow 1 / 1b / 1c.
 *
 * `extends NebulaDO` for the structural tenant-isolation `onBeforeCall` (the
 * `{u}.{g}.dev` scope guard); every method carries `@mesh(requireDominionHere)` on top
 * (onBeforeCall proves *scope*, never `access.scopeAdmin`, and `<id>.*` widening admits
 * descendant non-admins). Node↔node calls are mesh only (one-way `lmz.call()`
 * continuations, ADR-003 — never raw Workers RPC, never an awaited result).
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
import { NebulaDO, requireDominionHere } from './nebula-do';
import { compileOntologyVersion } from './galaxy';
import type { Galaxy, TurnRecord } from './galaxy';
import type { Star } from './star';
import type { NebulaClient } from './nebula-client';
import type { DevContainer, SourceFile } from './dev-container';
import { ResourceDataPlane } from './resource-data-plane';
import type { BroadcastTarget } from './resource-data-plane';
import type { QueryDescriptor, SubscriberEntry } from './query-hash';
import { createResourceOntologyProvider } from './devstudio-resource-ontology';
import { DEFAULT_SESSION_ID, SESSION_NODE_ID } from './chat-constants';
import type { DagTree } from './dag-tree';
import type { OperationDescriptor, Snapshot, TransactionResult } from './resources';
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
/** The per-client Gateway DO — DevStudio delivers a finished turn's result back to
 *  the originating client through it (direct delivery, addressed by the client's
 *  stable instanceName, so it survives a WS drop+reconnect during a long turn). */
const CLIENT_GATEWAY_BINDING = 'NEBULA_CLIENT_GATEWAY';

/** The ontology source file — compiled to the runtime validator (Decision 9: the
 *  ontology is just another source file). */
const ONTOLOGY_PATH = 'src/ontology.d.ts';

const AUTHOR = { name: 'DevStudio', email: 'dev@nebula.studio' };
const PATHS_KEY = 'devstudio:paths';
const INITED_KEY = 'devstudio:inited';

/** The codegen model id — the ONE place a vendor id appears. Swappable: Studio is
 *  model-agnostic, and the model name is never surfaced in the UI or elsewhere. */
const STUDIO_MODEL = '@cf/moonshotai/kimi-k2.7-code';

/**
 * Unwrap a Workers AI `/ai/run` REST envelope to the same value `env.AI.run` returns.
 *
 * The REST endpoint wraps the result in `{ result, success, errors }` (verified live) and
 * keeps doing so when the call is gateway-routed, since that is now the same endpoint plus
 * a header. The bare-value branch is kept anyway: it costs one `in` check and it is what
 * absorbs a response shape changing under us rather than letting it reach
 * {@link parseModelTurn}. Throws on `success: false`. Exported so the cheap `dev-studio`
 * shape probe can assert the unwrap feeds {@link parseModelTurn} unchanged (the binding
 * path needs no unwrap, so only REST exercises this).
 */
export function unwrapWorkersAiRest(json: unknown): unknown {
  if (json && typeof json === 'object' && 'success' in json) {
    const j = json as { result?: unknown; success?: boolean; errors?: unknown };
    if (!j.success) throw new Error(`Workers AI REST returned success=false: ${JSON.stringify(j.errors ?? [])}`);
    return j.result;
  }
  return json;
}

/** Minimal, *structural* system bundle for the tool-calling loop — the seed of the
 *  composable cascade. The make-it-data-bound *content* is the engine file's
 *  exploratory concern; this only establishes the tool protocol + output constraints.
 *  Model-agnostic (`studio-model-agnostic-naming`) — no vendor name appears. */
const STUDIO_LOOP_SYSTEM_PROMPT = `You are Studio, an assistant that builds a small web app as a Vue 3 Single-File Component (src/App.vue).
Use the provided tools — do not output code in your reply:
- Call write_file with the COMPLETE new contents of a file. The file is compiled immediately and the result is returned; if it does not compile, read the error, fix it, and call write_file again.
- When every file compiles cleanly and the app is done, call mark_complete.
Rules:
- Vue 3 with <script setup lang="ts"> and a <template>.
- Style ONLY with Tailwind utility classes and DaisyUI component classes (both are already available).
- For COLOR, use DaisyUI semantic classes (bg-primary, text-base-content, bg-base-200, border-base-300),
  not raw Tailwind palette utilities (bg-blue-500, text-slate-700) — semantic classes resolve through the
  active theme.
- When the user wants a particular look ("warmer", "our brand blue is #1e40af", "match our logo"), change
  the THEME, not the markup: add an @plugin "daisyui/theme" block to src/style.css setting --color-primary,
  --color-base-100, etc. (OKLCH preferred), or switch to a different built-in theme. Same result on screen,
  and it restyles the whole app at once.
- If the user still wants colors hard-coded into the markup, DO IT — but first say once, briefly, what it
  costs: those colors stop following the theme, so restyling later means editing every component and they
  will not adapt to light/dark. State it once, then follow their decision without repeating it.
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
  // The composable resource data-plane (Child 1) — hosts the chat Session/Message
  // Resources. Constructed in onStart with the platform-fixed Session/Message
  // ontology provider; reconstructed on every (re)init like Star's.
  #dataPlane!: ResourceDataPlane;

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
    // Compose the resource data-plane (Child 1) — the chat Session/Message host. The
    // ontology provider compiles the platform-fixed Session/Message types ON this DO
    // (re-derived from source on every (re)init, so it survives eviction/restart —
    // there is no Galaxy registry for it). No org-tree subscribe channel here
    // (Out-of-scope), so onDagChanged is a no-op.
    this.#dataPlane = new ResourceDataPlane(
      this.ctx,
      () => this.lmz.callContext,
      createResourceOntologyProvider(this.ctx, this.env.LOADER),
      {
        deliverResourceUpdate: (clientId, resourceType, resourceId, result) =>
          this.lmz.call(CLIENT_GATEWAY_BINDING, clientId,
            this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId, result)),
        broadcastResourceUpdate: (resourceId, snapshot, targets) =>
          this.#broadcastResourceUpdate(resourceId, snapshot, targets),
        broadcastQueryUpdate: (queryHash, resourceIds, targets) =>
          this.#broadcastQueryUpdate(queryHash, resourceIds, targets),
        deliverQueryUpdate: (clientId, queryHash, result) =>
          this.lmz.call(CLIENT_GATEWAY_BINDING, clientId,
            this.ctn<NebulaClient>().handleQueryUpdate(queryHash, result),
            this.ctn<DevStudio>().onQueryBroadcastResult(queryHash), { onErrorOnly: true }),
        broadcastRosterUpdate: (queryHash, roster, targets) =>
          this.#broadcastRosterUpdate(queryHash, roster, targets),
        deliverRosterUpdate: (clientId, queryHash, result) =>
          this.lmz.call(CLIENT_GATEWAY_BINDING, clientId,
            this.ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, result),
            this.ctn<DevStudio>().onQuerySubscriberListBroadcastResult(queryHash), { onErrorOnly: true }),
      },
      () => { /* no org-tree subscribe channel on DevStudio */ },
      // Host name as a THUNK — `this.lmz.instanceName` is not stamped yet inside `onStart()`.
      // It is the scope the `access.scopeAdmin` bypass is confined to at both confinement points.
      () => this.lmz.instanceName,
    );
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
  @mesh(requireDominionHere)
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
  @mesh(requireDominionHere)
  async readSource(path: string): Promise<string> {
    return this.#fs.readFile('/' + path.replace(/^\/+/, ''));
  }

  /** Full source tree + HEAD — what DevStudio re-pushes to a cold-booted DevContainer
   *  (Flow 1c). Full-tree by design (dev apps are small; the Artifacts swap would make
   *  it incremental — Decision 6). */
  @mesh(requireDominionHere)
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
  @mesh(requireDominionHere)
  async compileAndInstallOntology({ wipe = false }: { wipe?: boolean } = {}): Promise<{ version: string }> {
    const { types, version } = await this.#readOntology();
    const row = compileOntologyVersion({ version, types });
    const instance = this.lmz.instanceName!;
    // Atomic wipe+install on the .dev Star (ADR-006), fired one-way (continuation-only —
    // no awaited callRaw). `version` is derived locally; the install's effect reaches the
    // live preview reactively via Star's broadcastReload.
    this.lmz.call(STAR_BINDING, instance, this.ctn<Star>().installOntology(row, { wipe }));
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
  @mesh(requireDominionHere)
  async applyOntologyChange({ wipe = false }: { wipe?: boolean } = {}): Promise<{ version: string }> {
    const { version } = await this.#readOntology();
    const instance = this.lmz.instanceName!;
    // Push the injected app-version + ontology source to the container (fire-and-forget),
    // then install on the .dev Star. Under continuation-only these no longer await, so the
    // container-before-Star ordering is relaxed — a reversal causes only a transient extra
    // preview reload that self-heals (Decision 12 / Flow 1d). ⚠️ Verify under `wrangler dev`.
    this.lmz.call(DEV_CONTAINER_BINDING, instance, this.ctn<DevContainer>().setAppVersion(version));
    await this.syncToDevContainer([ONTOLOGY_PATH]);
    return this.compileAndInstallOntology({ wipe });
  }

  /**
   * Cold-boot population (Flow 1c): wait for the container (boot-race retry inside
   * `ensureUp`), then push the full source tree. ⚠️ Run with `wrangler dev` — `DevContainer`
   * `extends Container` can't construct under vitest-pool-workers; exercised on a
   * deployed Worker (the assembled e2e `it.skip`).
   */
  @mesh(requireDominionHere)
  async ensureUp(): Promise<void> {
    const instance = this.lmz.instanceName!;
    const tree = await this.getSourceTree(); // local (shell Workspace)
    // Boot + push source atomically container-side (ADR-006), fired one-way (continuation-
    // only — no awaited callRaw). The written count is no longer surfaced (callers discarded
    // it); the boot-race retry lives inside the container method. ⚠️ Verify under `wrangler dev`.
    this.lmz.call(DEV_CONTAINER_BINDING, instance, this.ctn<DevContainer>().bootAndApply(tree.files));
  }

  /**
   * Push changed source files to the DevContainer (`applyChanges` → vite HMR, Flow 1).
   * Default = the full tracked tree; pass `paths` to push a subset. ⚠️ Run with `wrangler dev`
   * (same reason as `ensureUp`).
   */
  @mesh(requireDominionHere)
  async syncToDevContainer(paths?: string[]): Promise<void> {
    const want = paths ? new Set(paths.map((p) => p.replace(/^\/+/, ''))) : this.#trackedPaths();
    const files: SourceFile[] = [];
    for (const p of want) files.push({ path: p, content: await this.#fs.readFile('/' + p) });
    // Fire-and-forget the source push (continuation-only — no awaited callRaw). The written
    // count is no longer surfaced (callers discarded it). ⚠️ Verify under `wrangler dev`.
    this.lmz.call(DEV_CONTAINER_BINDING, this.lmz.instanceName!, this.ctn<DevContainer>().applyChanges(files));
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
   * wipes (D2 secure-by-default).
   *
   * **Fired one-way** (`client.chat` uses a `lmz.call()` continuation — the only mesh
   * call surface): a turn can run for minutes, during which the client WS may drop and
   * reconnect. The
   * result is delivered back via {@link deliverTurnResult} as a SEPARATE direct-delivery
   * call addressed to the client's stable `instanceName` (`clientId`, passed explicitly
   * by the client — see [[client-calls-use-direct-delivery]]), so it lands on whatever
   * socket is current rather than the dead originating one. `turnId` (client-generated)
   * is carried out and mirrored back so the client correlates the result to its pending
   * turn. The `{ reply, thought }` return is retained for the test harness; production
   * delivery is via `onChatResult`. The model id is never surfaced (model-agnostic).
   *
   * ⚠️ Run with `wrangler dev` — `ensureUp`/`syncToDevContainer` need a live container and the loop
   * calls `env.AI.run`; runs under `wrangler dev` + Docker Desktop, not vitest-pool-workers.
   */
  @mesh(requireDominionHere)
  async chat(turnId: string, clientId: string, message: string): Promise<{ reply: string; thought: string }> {
    await this.ensureUp(); // Flow 1c: container up + source pushed
    await this.ensureSession(); // D-session: the default Session exists before turns FK to it
    // Phase 3 option (b): mint the assistant Message id up front; stream the loop's
    // progress transiently to session subscribers; commit ONE durable Message at the end.
    const assistantMessageId = crypto.randomUUID();
    const result = await this.runCodegenTurn(
      message, DEFAULT_LOOP_CONFIG,
      (step) => this.streamProgress(DEFAULT_SESSION_ID, assistantMessageId, step, SESSION_NODE_ID),
    );
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

    // The tool-calling loop carries the generated code in `write_file` *args*, not the
    // model's reply text — so surface the final content of each written file here, else the
    // thought panel loses the code (the one-shot path used to show it inline). Last write
    // wins per path (self-correction rounds rewrite the same file).
    const written = new Map<string, string>();
    for (const tc of result.toolCalls) {
      const a = tc.args as { path?: string; content?: string } | undefined;
      if (tc.name === 'write_file' && a?.path && typeof a.content === 'string') {
        written.set(a.path, a.content);
      }
    }
    const files = [...new Set(result.appliedPaths)];
    const compile = result.lastGate
      ? (result.lastGate.ok ? 'compiled ✓' : `compile error:\n${result.lastGate.errorTail}`)
      : 'no files written';
    const parts: string[] = [];
    if (result.reasoning) parts.push(`🧠 Reasoning\n\n${result.reasoning}`);
    if (result.output) parts.push(`📄 ${result.output}`);
    for (const [path, content] of written) parts.push(`📝 ${path}\n\`\`\`\n${content}\n\`\`\``);
    parts.push(`🔧 ${result.detail ?? result.stop}\nFiles: ${files.join(', ') || '(none)'} — ${compile}`);
    const payload = { reply, thought: parts.join('\n\n— — —\n\n') };
    // Phase 3 option (b): the DURABLE assistant Message — the source of truth, fanned to
    // every session subscriber via the query rerun (history-restore + multi-participant +
    // disconnect-recovery). The client reconciles its ephemeral stream against it by id.
    await this.commitAssistantMessage(DEFAULT_SESSION_ID, assistantMessageId, reply, SESSION_NODE_ID, payload.thought);
    // The ephemeral onChatResult push stays for now (retired/demoted in Phase 6).
    this.deliverTurnResult(turnId, clientId, payload);
    return payload;
  }

  /**
   * Deliver a finished turn's result back to the originating client by **direct
   * delivery** — a NEW one-way mesh call to the client's Gateway, addressed by the
   * client's stable `instanceName` (`clientId`), so a WS drop+reconnect during the
   * turn doesn't strand the reply (the Gateway routes to whatever socket is current).
   * NO `newChain`: the originating client's `originAuth` must ride through so the
   * Gateway's aud check passes — exactly as Star's result callbacks do. Fire-and-forget
   * + try/catch: a delivery failure must never break the dev loop (the turn is already
   * committed to the Workspace + recorded to Galaxy). `protected` so the test harness
   * can exercise it without the AI/container-bound `chat`. See
   * [[client-calls-use-direct-delivery]].
   */
  protected deliverTurnResult(
    turnId: string,
    clientId: string,
    payload: { reply: string; thought: string },
  ): void {
    try {
      this.lmz.call(CLIENT_GATEWAY_BINDING, clientId,
        this.ctn<NebulaClient>().onChatResult(turnId, payload.reply, payload.thought));
    } catch (e) {
      debug('nebula.DevStudio.chat').warn('turn-result delivery failed (non-fatal)', { error: e });
    }
  }

  /**
   * Bring the dev preview up and tell the client when vite is actually serving, so the
   * Studio auto-refreshes the iframe (no manual Reload). Fired **one-way** by the client
   * (a `lmz.call()` continuation, never an awaited result): the container boot can take
   * tens of seconds, during which the client WS may drop+reconnect — readiness is
   * delivered back via
   * {@link deliverPreviewReady} (direct delivery by the client's stable `instanceName`),
   * so it lands on whatever socket is current. `ensureUp` brings the container up +
   * (re)pushes source (Flow 1c); `awaitPreviewReady` then blocks on vite's stdout ready
   * event (no polling). Unconfirmed readiness (timeout/throw) still signals — the iframe
   * load + manual Reload fallback cover it.
   *
   * ⚠️ Run with `wrangler dev` — needs a live container (same constraint as `ensureUp`).
   */
  @mesh(requireDominionHere)
  async warmPreview(clientId: string): Promise<void> {
    const instance = this.lmz.instanceName!;
    const tree = await this.getSourceTree(); // local (shell Workspace)
    // Boot + push source + await vite-ready atomically container-side (ADR-006), fired 4-arg
    // (continuation-only — no awaited callRaw). The handler signals the client on the result
    // (ready OR unconfirmed/Error — we signal either way, as before). Long-running is fine now
    // (early-ack, no held Promise). ⚠️ Verify under `wrangler dev` + Docker.
    const remote = this.ctn<DevContainer>().warmAndAwaitReady(tree.files);
    this.lmz.call(
      DEV_CONTAINER_BINDING, instance, remote,
      (this.ctn() as any).handleWarmPreviewResult(clientId, remote),
    );
  }

  /**
   * 4-arg result handler for {@link warmPreview}'s `warmAndAwaitReady` fire-back. Signals the
   * client the preview is ready regardless of the result — a `ready:false`/Error still signals
   * (the iframe load + manual Reload fallback cover an unconfirmed boot, matching the pre-
   * continuation behavior). Public (surfaced on `this.ctn()`) but NOT `@mesh`: it runs only as
   * this DO's own traveling continuation on the fire-back, never dispatched remotely.
   */
  handleWarmPreviewResult(clientId: string, result: unknown): void {
    if (result instanceof Error) {
      debug('nebula.DevStudio.warmPreview').warn('preview-readiness unconfirmed (signalling anyway)', { error: result });
    }
    this.deliverPreviewReady(this.lmz.instanceName!, clientId);
  }

  /**
   * Tell the originating client the preview is ready, by direct delivery — a one-way
   * mesh call to the client's Gateway addressed by its stable `instanceName` (`clientId`),
   * so a WS reconnect during the boot doesn't strand it. Same shape + rationale (no
   * `newChain`) as {@link deliverTurnResult}; fire-and-forget + try/catch.
   */
  protected deliverPreviewReady(scope: string, clientId: string): void {
    try {
      this.lmz.call(CLIENT_GATEWAY_BINDING, clientId, this.ctn<NebulaClient>().handlePreviewReady(scope));
    } catch (e) {
      debug('nebula.DevStudio.warmPreview').warn('preview-ready delivery failed (non-fatal)', { error: e });
    }
  }

  // ─── Resource data-plane surface (chat Session/Message Resources, Child 1) ─────────
  //
  // `@mesh()` — **NOT** `@mesh(requireDominionHere)` (unlike every codegen/source method
  // above): chat participants are non-admin but DAG-granted. `onBeforeCall`
  // (NebulaDO base) still aud-locks `{u}.{g}.dev`; the per-op DAG read/write check
  // lives inside the data-plane (Resources/DagTree), exactly as on Star. These are
  // **Handler 1** wrappers; Handler 2 lives in the capability. The ontology-version
  // gate is a no-op here (one fixed code-defined version, D8): the wrapper accepts
  // the client's `appVersion` but ignores it — Handler 2 stamps the version solely
  // from `getOntology()`.

  /**
   * Idempotently seed the pre-alpha default `Session` at the fixed {@link DEFAULT_SESSION_ID}
   * under {@link SESSION_NODE_ID} (D-session / Child 3 Phase 1). Called at the start of
   * {@link chat} (an authed admin context, so the create's `write` check passes via the scope-admin
   * bypass — ✅ **confined**: `requirePermission` grants it only to an admin whose
   * `authScope` covers THIS DevStudio host, not to any bearer of the bare `access.scopeAdmin`
   * bit; see tasks/nebula-confine-admin-bypass.md) and exposed as an admin-gated entry so a client
   * can guarantee the session exists before subscribing `Message where session == DEFAULT_SESSION_ID`.
   * A second call is a no-op (the capability's create-if-absent). `@mesh(requireDominionHere)`
   * — a platform seed on the session node, distinct from the non-admin data-plane surface
   * below. Internal `this.ensureSession()` calls bypass the decorator (direct method call).
   */
  @mesh(requireDominionHere)
  async ensureSession(): Promise<void> {
    await this.#dataPlane.ensureResource(DEFAULT_SESSION_ID, 'Session', SESSION_NODE_ID, { title: 'Studio chat' });
  }

  /**
   * Permission-filtered fanout targets for a query at `nodeId` — the transient-stream
   * audience (Child 3, D-fanout-accessor). `protected`: the Phase-3 progress push uses
   * it internally; a test subclass exposes it for the M4 per-operand accessor test.
   */
  protected queryTargets(query: QueryDescriptor, nodeId: string): BroadcastTarget[] {
    return this.#dataPlane.targetsForQuery(query, nodeId);
  }

  /**
   * Push ONE transient assistant-progress chunk to the session query's subscribers
   * that may read `nodeId` (Child 3 option (b), Flow A). Fire-and-forget `svc.broadcast`
   * of `handleStreamChunk` — no Resource write, no fanout/rerun. Permission-filtered via
   * {@link queryTargets} (the transient path's point-of-action recheck, symmetric with the
   * durable path — a subscriber denied on `nodeId` gets NO chunk, M1). No `onResult`: a
   * missed chunk just drops the animation (the durable Message still lands via the query sub).
   */
  protected streamProgress(sessionId: string, messageId: string, progress: string, nodeId: string): void {
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'session', value: sessionId };
    const targets = this.queryTargets(query, nodeId);
    // Log identifiers/counts only — never the progress body (Stage-2 security nit).
    debug('nebula.DevStudio.stream').debug('chunk', { messageId, targets: targets.length, len: progress.length });
    if (targets.length === 0) return;
    this.svc.broadcast(targets, this.ctn<NebulaClient>().handleStreamChunk(messageId, progress));
  }

  /**
   * Commit the DURABLE assistant `Message` at completion (Child 3 option (b), Flow A) —
   * ONE create at `messageId`, which the query rerun fans to every session subscriber
   * (and the client reconciles against its ephemeral stream by id). Create-if-absent via
   * the capability (a fresh assistant id → a create); server-internal, no client delivery.
   */
  protected async commitAssistantMessage(
    sessionId: string, messageId: string, content: string, nodeId: string, thought?: string,
  ): Promise<void> {
    const value: Record<string, unknown> = { session: sessionId, role: 'assistant', content, status: 'complete' };
    if (thought !== undefined) value.thought = thought;
    debug('nebula.DevStudio.stream').debug('commit', { messageId, len: content.length });
    await this.#dataPlane.ensureResource(messageId, 'Message', nodeId, value);
  }

  /** Handler 1: RETURN the transaction result — the framework fires it back to the caller's `callAsync`
   *  (D5 pattern (a), B1 lockstep with Star). No version-gate on DevStudio (one fixed ontology, D8). */
  @mesh()
  transaction(appVersion: string, newETag: string, ops: Record<string, OperationDescriptor>): Promise<TransactionResult> {
    void appVersion; // version-gate is a no-op on DevStudio (one fixed ontology, D8)
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('transaction requires a client origin with instanceName in callChain[0]');
    }
    return this.#dataPlane.doTransaction(newETag, ops, clientId);
  }

  /** Handler 1: RETURN the read value — the framework fires it back to the caller's `callAsync`
   *  (D5 pattern (a), B1 lockstep with Star). No version-gate on DevStudio (one fixed ontology, D8). */
  @mesh()
  read(appVersion: string, resourceId: string): Snapshot | null {
    void appVersion;
    return this.#dataPlane.doRead(resourceId);
  }

  /** Handler 1: dispatch a single-resource subscribe into the capability. */
  @mesh()
  subscribe(appVersion: string, resourceType: string, resourceId: string): void {
    void appVersion;
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribe requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribe requires a gateway in callChain.at(-1)');
    }
    this.#dataPlane.doSubscribe(resourceType, resourceId, clientId, subscriberBinding);
  }

  /** Drop the caller's subscriber row for `(resourceType, resourceId)`. */
  @mesh()
  unsubscribe(resourceType: string, resourceId: string): void {
    void resourceType;
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('unsubscribe requires a client origin with instanceName in callChain[0]');
    }
    this.#dataPlane.removeSubscriber(resourceId, clientId);
  }

  /** Handler 1: register a query subscription + push the initial membership (void,
   *  D7). Non-admin + DAG-gated (authorization is per-push at delivery). `clientId`/
   *  `subscriberBinding` from `callChain` (m2/m3). See `Star.subscribeQuery`. */
  @mesh()
  subscribeQuery(query: QueryDescriptor): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribeQuery requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribeQuery requires a gateway in callChain.at(-1)');
    }
    this.#dataPlane.doSubscribeQuery(query, clientId, subscriberBinding);
  }

  /** Drop the caller's query-sub row for `queryHash` (clientId from callChain, m3). */
  @mesh()
  unsubscribeQuery(queryHash: string): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('unsubscribeQuery requires a client origin with instanceName in callChain[0]');
    }
    this.#dataPlane.removeQuerySubscriber(queryHash, clientId);
  }

  /** Watch `query`'s live subscriber-LIST roster (the STANDALONE watcher sub — NOT a data-subscriber).
   *  Void; initial roster arrives via `handleQuerySubscribersUpdate`. See `Star.subscribeQuerySubscribers`. */
  @mesh()
  subscribeQuerySubscribers(query: QueryDescriptor): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribeQuerySubscribers requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribeQuerySubscribers requires a gateway in callChain.at(-1)');
    }
    this.#dataPlane.doSubscribeQuerySubscribers(query, clientId, subscriberBinding);
  }

  /** Drop the caller's subscriber-list WATCHER row for `queryHash` (clientId from callChain, m3). */
  @mesh()
  unsubscribeQuerySubscribers(queryHash: string): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('unsubscribeQuerySubscribers requires a client origin with instanceName in callChain[0]');
    }
    this.#dataPlane.removeQuerySubscriberListWatcher(queryHash, clientId);
  }

  /** Single `@mesh()` entry for the DagTree API (per-op auth inside DagTree). */
  @mesh()
  dagTree(): DagTree {
    return this.#dataPlane.dagTree;
  }

  /** Host-side fanout for one mutated resource — the {@link ResourceHostBridge}
   *  `broadcastResourceUpdate` impl. No bench knobs (Star-only); plain `svc.broadcast`
   *  with drop-on-failed-fanout cleanup via {@link onBroadcastResult}. */
  #broadcastResourceUpdate(resourceId: string, snapshot: Snapshot, targets: BroadcastTarget[]): void {
    const remote = this.ctn<NebulaClient>().handleResourceUpdate(
      snapshot.meta.typeName, resourceId, snapshot);
    this.svc.broadcast(targets, remote, { onResult: this.ctn<DevStudio>().onBroadcastResult(resourceId) });
  }

  /** Per-target broadcast result handler — drop a subscriber whose Gateway reported
   *  it disconnected (`ClientDisconnectedError`). `@mesh()` for the tier-worker path. */
  @mesh()
  onBroadcastResult(resourceId: string, result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#dataPlane.removeSubscriber(resourceId, clientId);
    }
  }

  /** Host-side fanout for a query membership push to the no-denial group. One
   *  shared payload via `svc.broadcast`; dead-client cleanup rides
   *  {@link onQueryBroadcastResult} keyed by `queryHash` (m6). */
  #broadcastQueryUpdate(queryHash: string, resourceIds: string[], targets: BroadcastTarget[]): void {
    const remote = this.ctn<NebulaClient>().handleQueryUpdate(queryHash, { resourceIds });
    this.svc.broadcast(targets, remote, { onResult: this.ctn<DevStudio>().onQueryBroadcastResult(queryHash) });
  }

  /** Host-side fanout for a subscriber-list roster push (the `broadcastRosterUpdate` bridge impl) — the
   *  distinct-by-`sub` roster to a query's WATCHERS. Dead-WATCHER cleanup uses the DEDICATED
   *  {@link onQuerySubscriberListBroadcastResult} (watcher table, NOT `QuerySubscribers`). NO `onErrorOnly`
   *  — `svc.broadcast` applies it internally for any `onResult`. */
  #broadcastRosterUpdate(queryHash: string, roster: SubscriberEntry[], targets: BroadcastTarget[]): void {
    const remote = this.ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, roster);
    this.svc.broadcast(targets, remote, { onResult: this.ctn<DevStudio>().onQuerySubscriberListBroadcastResult(queryHash) });
  }

  /** Per-target query-push result handler (no-denial broadcast + has-denial
   *  deliveries — m6); drops the dead client's query-sub row on disconnect. */
  @mesh()
  onQueryBroadcastResult(queryHash: string, result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#dataPlane.removeQuerySubscriber(queryHash, clientId);
    }
  }

  /** Per-target roster-push result handler — drops the dead WATCHER's row from the WATCHER table ONLY
   *  (NOT `QuerySubscribers`), so a dual-role client keeps its data sub. `@mesh()` for the tier-worker path. */
  @mesh()
  onQuerySubscriberListBroadcastResult(queryHash: string, result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#dataPlane.removeQuerySubscriberListWatcher(queryHash, clientId);
    }
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
   * so the Phase-2/3 test harness replays a synthetic script with no AI binding.
   *
   * Two shipping transports, selected by `WORKERS_AI_TOKEN` presence:
   * - **token present → Workers-AI REST** ({@link callModelRest}). The hosted lane has
   *   no CF account creds, so the `env.AI` binding can't authenticate there; a scoped
   *   plaintext token + REST works in every lane (and powers the nightly replay loop).
   * - **token absent → the `env.AI` binding** — GHA/local, where account creds are
   *   present. So a token-less hosted lane fails (the binding can't auth without creds),
   *   which is the point: a green hosted turn proves it went through REST.
   *
   * The model id stays isolated to `STUDIO_MODEL` and is never surfaced.
   */
  protected async callModel(messages: ChatMessage[], params: ModelParams): Promise<unknown> {
    const body = {
      messages,
      tools: CODEGEN_TOOLS,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    };
    // WORKERS_AI_TOKEN / CLOUDFLARE_ACCOUNT_ID / CF_AI_GATEWAY are runtime env (`.dev.vars`
    // / `wrangler secret`), not committed wrangler vars, so they're absent from the
    // generated `Env` — widen at the read (packaging.md).
    const env = this.env as Env & { WORKERS_AI_TOKEN?: string; CLOUDFLARE_ACCOUNT_ID?: string; CF_AI_GATEWAY?: string };
    if (env.WORKERS_AI_TOKEN) return this.#callModelRest(env, env.WORKERS_AI_TOKEN, body);
    // The model-catalog types don't cover every @cf id; run() is treated loosely.
    return (this.env.AI as any).run(STUDIO_MODEL, body);
  }

  /**
   * Workers AI over REST — the hosted-lane AI path (no `env.AI` binding there). **One URL,
   * always**: gateway routing is a `cf-aig-gateway-id` header on the ordinary `/ai/run`
   * endpoint, not a different origin. `CF_AI_GATEWAY` therefore selects *observability*,
   * never the transport — so a gateway typo can no longer change which API answers.
   * The `/ai/run` response wraps the binding's result in `{ result, success, errors }`
   * (verified against the live API) — {@link unwrapWorkersAiRest} unwraps `.result` so
   * {@link parseModelTurn} reads the same shape the binding returns.
   *
   * ⚠️ **An unset `CF_AI_GATEWAY` is a deliberate default, not an oversight.** Naming a
   * gateway turns on full request+response payload logging account-side (prompts and
   * generated source); what Studio *wants* recorded lives in its own Session/Message
   * objects instead. Adding a gateway id here is a data-handling decision — make it
   * on purpose, and see `tasks/on-hold/nebula-tenant-ai-billing.md` first.
   *
   * **Never log the token or the `Authorization` header** (security.md); errors carry the
   * URL `pathname` + status only (the token rides the header, never the URL).
   */
  async #callModelRest(
    env: { CLOUDFLARE_ACCOUNT_ID?: string; CF_AI_GATEWAY?: string },
    token: string,
    body: unknown,
  ): Promise<unknown> {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) throw new Error('Workers AI REST path needs CLOUDFLARE_ACCOUNT_ID');
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${STUDIO_MODEL}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (env.CF_AI_GATEWAY) headers['cf-aig-gateway-id'] = env.CF_AI_GATEWAY;
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`Workers AI REST ${resp.status} at ${new URL(url).pathname}`);
    return unwrapWorkersAiRest(await resp.json());
  }

  /**
   * Drive one bounded, self-correcting codegen turn: assemble the layered prompt
   * (ontology pinned in the system block, request + current source in the user
   * layer — D7), run {@link runCodegenLoop}, and record the turn (the loop is the
   * first populator of `TurnRecord.toolCalls` / `.error` / `.validate`). Returns the
   * loop result. `chat()` will call this (Phase 4); install/wipe stays the separate,
   * human-gated apply step fired AFTER a clean finish (Flow 1b) — never reachable
   * from the loop's `write_file` tool.
   *
   * `protected` (not `@mesh`): an internal capability, not a remote API. The test
   * harness reaches it through a test-only `@mesh` entry on a subclass.
   */
  protected async runCodegenTurn(
    userRequest: string,
    config: CodegenLoopConfig = DEFAULT_LOOP_CONFIG,
    onProgress?: (step: string) => void,
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
      onProgress,
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
   * onBeforeCall + requireDominionHere both pass. The corpus seeds the eval suite —
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
