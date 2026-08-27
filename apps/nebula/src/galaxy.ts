/**
 * Galaxy — the app-level brain, one DO per galaxy (instanceName = `{u}.{g}`, e.g. "acme.app").
 *
 * The collapse of three former nodes (Galaxy + DevStudio + DevContainer) into one class
 * (tasks/nebula-galaxy-collapse-and-chat.md). It owns:
 *  - the per-galaxy **ontology registry**: `appendOntologyVersion()` compiles a
 *    `validatorBundle` via @lumenize/ts-runtime-parser-validator and stores it as an
 *    immutable per-version row; Stars fetch rows on cache miss.
 *  - the **git Workspace** (source of truth for the user-developer's app source) — a
 *    `@cloudflare/computer` SQLite-backed VFS in this DO's own storage, with host-side git
 *    (no container involved in fs or git work).
 *  - the **codegen engine**: the sole writer of source, driving the bounded self-correcting
 *    tool-calling loop (`runCodegenLoop`) against `env.AI` / the Workers-AI REST lane.
 *  - the **chat Session/Message Resources** via the composed {@link ResourceDataPlane}.
 *  - (Phase 3) the co-located **ephemeral build container** via raw `ctx.container` — a
 *    stateless build-box, never `extends Container` (containers.md).
 *
 * `extends NebulaDO` for the structural tenant-isolation `onBeforeCall` (passage into
 * `{u}.{g}`); codegen/source methods carry `@mesh(requireDominionHere)` on top, while the
 * chat data-plane surface is bare `@mesh()` — participants are non-admin but DAG-granted.
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { Workspace } from '@cloudflare/computer';
import type { DurableObjectStorageLike } from '@cloudflare/computer';
import { createGitClient } from '@cloudflare/computer/git';
import git from 'isomorphic-git';
import {
  generateParseModule,
  getParserValidatorFacet,
  type ParserValidator,
} from '@lumenize/ts-runtime-parser-validator';
import { NebulaDO, requireDominionHere } from './nebula-do';
// The pure compile half lives in the Node-safe leaf `./ontology-compile` (the /live harness
// compiles rows to install via `setOntology`); re-exported here so import sites are unchanged.
import { compileOntologyVersion } from './ontology-compile';
import type { OntologyVersionConfig, OntologyVersionRow } from './ontology-compile';
import { ResourceDataPlane } from './resource-data-plane';
import type { BroadcastTarget, NodeInvitee, NodeInviteAck } from './resource-data-plane';
import type { PermissionTier } from './dag-ops';
import type { QueryDescriptor, SubscriberEntry } from './query-hash';
import { createResourceOntologyProvider } from './devstudio-resource-ontology';
import { DEFAULT_SESSION_ID, SESSION_NODE_ID } from './chat-constants';
import type { DagTree } from './dag-tree';
import type { Star } from './star';
import type { NebulaClient } from './nebula-client';
// Type-only: types the facade continuation without pulling a second mesh entry into this
// module's value graph.
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
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

export { compileOntologyVersion, PLATFORM_RESOURCE_TYPES } from './ontology-compile';
export type { OntologyVersionConfig, OntologyVersionRow } from './ontology-compile';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Reply shape for `getLatestOntologyVersion()`. Bundles the latest row with
 * the full ordered version history (oldest → newest, latest = last entry) so
 * Star fetches both atomically on a cache miss. Star caches `history` locally
 * to drive 5.5's lazy migration ordering without a follow-up Galaxy round-trip.
 *
 * `history` is computed at fetch time from `ontology:_index` — it's not stored
 * on any row, since the row is immutable but the index keeps growing.
 */
export interface OntologyState {
  row: OntologyVersionRow;
  history: string[];
}

// ─── Constants ───────────────────────────────────────────────────────

const VERSION_LABEL_RE = /^[A-Za-z0-9-]+$/;
const INDEX_KEY = 'ontology:_index';
const rowKey = (version: string) => `ontology:${version}`;

/** The `.dev` data-Star binding (the star is the `{u}.{g}.dev` *instance* on it). */
const STAR_BINDING = 'STAR';
/** The per-client Gateway DO — codegen results and stream chunks are delivered back to
 *  the originating client through it (direct delivery, addressed by the client's stable
 *  instanceName, so it survives a WS drop+reconnect during a long turn). */
const CLIENT_GATEWAY_BINDING = 'NEBULA_CLIENT_GATEWAY';

/** The ontology source file — compiled to the runtime validator (the ontology is just
 *  another source file in the Workspace). */
const ONTOLOGY_PATH = 'src/ontology.d.ts';

const GIT_AUTHOR = { name: 'Nebula', email: 'dev@nebula.studio' };
const GIT_INITED_KEY = 'galaxy:gitInited';

/** The codegen model id — the ONE place a vendor id appears. Swappable: Studio is
 *  model-agnostic, and the model name is never surfaced in the UI or elsewhere. */
const STUDIO_MODEL = '@cf/moonshotai/kimi-k2.7-code';

/**
 * Unwrap a Workers AI `/ai/run` REST envelope to the same value `env.AI.run` returns.
 *
 * The REST endpoint wraps the result in `{ result, success, errors }` (verified live) and
 * keeps doing so when the call is gateway-routed, since that is the same endpoint plus
 * a header. The bare-value branch is kept anyway: it costs one `in` check and it is what
 * absorbs a response shape changing under us rather than letting it reach
 * `parseModelTurn`. Throws on `success: false`. Exported so the cheap shape probe can
 * assert the unwrap feeds `parseModelTurn` unchanged (the binding path needs no unwrap,
 * so only REST exercises this).
 */
export function unwrapWorkersAiRest(json: unknown): unknown {
  if (json && typeof json === 'object' && 'success' in json) {
    const j = json as { result?: unknown; success?: boolean; errors?: unknown };
    if (!j.success) throw new Error(`Workers AI REST returned success=false: ${JSON.stringify(j.errors ?? [])}`);
    return j.result;
  }
  return json;
}

/**
 * The cloud-only STUCK signature: a `500` whose body carries a runtime proxy phrase that a
 * stale `running=true` container flag produces. The ephemeral build-box model designs the
 * stuck state away (a container never outlives its build), so nothing acts on this — it is
 * kept purely as EVIDENCE: the build drive logs any match via `@lumenize/debug` and expects
 * zero, and only real occurrences would reopen the `ctx.abort()` recovery question
 * (bar: "a lot of convincing"). Pure. [[cf-container-stuck-flag-cloud]]
 */
export function isStuckFlagResponse(status: number, body: string): boolean {
  if (status !== 500) return false;
  return /not running|suddenly disconnected|proxying request to container/i.test(body);
}

/** {@link isStuckFlagResponse} over a thrown error carrying `(status, body)` — defensive
 *  against a plain Error (no `status`/`body` → not stuck). Pure. */
export function isStuckFlagError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; body?: unknown };
  if (typeof e.status !== 'number' || typeof e.body !== 'string') return false;
  return isStuckFlagResponse(e.status, e.body);
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

// ─── Galaxy DO ───────────────────────────────────────────────────────

export class Galaxy extends NebulaDO {
  // Cache over `ctx.storage` (the durable Workspace VFS) — reconstructed in onStart,
  // never the source of truth. `!`-asserted: onStart runs (inside the base
  // blockConcurrencyWhile) before any @mesh method.
  #ws!: Workspace;
  // Re-derivable cache (loss acceptable) — the tool-args typia validator facet
  // (durable-objects.md "ephemeral caches").
  #toolArgsFacet?: ParserValidator;
  // The composed resource data-plane — hosts the chat Session/Message Resources.
  #dataPlane!: ResourceDataPlane;

  /** Reconstruct the Workspace (fs + host-side git over this DO's own SQLite) and
   *  `git init` once (latched in kv). Async — runs inside the base
   *  `blockConcurrencyWhile`, so requests block until it completes
   *  (durable-objects.md § Initialization). The container backend is NOT constructed
   *  here — the build-box attaches per build (Phase 3), never at init. */
  override async onStart(): Promise<void> {
    this.#ws = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      git: createGitClient(),
      defaultGitIdentity: GIT_AUTHOR,
    });
    if (!this.ctx.storage.kv.get(GIT_INITED_KEY)) {
      await this.#ws.git.init({ defaultBranch: 'main' });
      this.ctx.storage.kv.put(GIT_INITED_KEY, true);
    }
    // Compose the resource data-plane — the chat Session/Message host. The ontology
    // provider compiles the platform-fixed Session/Message types ON this DO (re-derived
    // from source on every (re)init, so it survives eviction/restart). Phase 2 upgrades
    // this to a real INSTALLED version. No org-tree subscribe channel here, so
    // onDagChanged is a no-op.
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
            this.ctn<Galaxy>().onQueryBroadcastResult(queryHash), { onErrorOnly: true }),
        broadcastRosterUpdate: (queryHash, roster, targets) =>
          this.#broadcastRosterUpdate(queryHash, roster, targets),
        deliverRosterUpdate: (clientId, queryHash, result) =>
          this.lmz.call(CLIENT_GATEWAY_BINDING, clientId,
            this.ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, result),
            this.ctn<Galaxy>().onQuerySubscriberListBroadcastResult(queryHash), { onErrorOnly: true }),
      },
      () => { /* no org-tree subscribe channel on Galaxy */ },
      // Host name as a THUNK — `this.lmz.instanceName` is not stamped yet inside `onStart()`.
      // It is the scope the `access.scopeAdmin` bypass is confined to at both confinement points.
      () => this.lmz.instanceName,
    );
  }

  // ─── Config ─────────────────────────────────────────────────────────

  @mesh(requireDominionHere)
  setGalaxyConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh()
  getGalaxyConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }

  // ─── Ontology registry ───────────────────────────────────────────────

  /**
   * Append a new immutable version. Validates label, compiles eagerly so
   * malformed types reject at submit time, and writes the row + index in a
   * single sync transaction.
   */
  @mesh(requireDominionHere)
  appendOntologyVersion(versionConfig: OntologyVersionConfig) {
    if (!VERSION_LABEL_RE.test(versionConfig.version)) {
      throw new Error(
        `Invalid ontology version label '${versionConfig.version}': must match /^[A-Za-z0-9-]+$/ (alphanumerics and dashes only).`,
      );
    }

    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
    if (index.includes(versionConfig.version)) {
      throw new Error(
        `Ontology version '${versionConfig.version}' already exists — versions are append-only`,
      );
    }

    const row = compileOntologyVersion(versionConfig);

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(rowKey(row.version), row);
      this.ctx.storage.kv.put(INDEX_KEY, [...index, row.version]);
    });
  }

  /**
   * Latest row + full ordered version history, or `null` if no versions have
   * been appended yet. Single-call so Star captures a consistent snapshot of
   * (current, history) without an interleaved append racing between two RPCs.
   */
  @mesh()
  getLatestOntologyVersion(): OntologyState | null {
    const index = this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
    if (index.length === 0) return null;
    const latest = index[index.length - 1];
    const row = this.ctx.storage.kv.get<OntologyVersionRow>(rowKey(latest));
    if (!row) return null;
    return { row, history: index };
  }

  /** Specific row by label, or `null` if absent. Bare `@mesh()` on purpose: a Star's
   *  lazy-pull is an UPWARD call — every member of a descendant scope has passage here. */
  @mesh()
  getOntologyVersion(version: string): OntologyVersionRow | null {
    return this.ctx.storage.kv.get<OntologyVersionRow>(rowKey(version)) ?? null;
  }

  /** Ordered version labels (oldest → newest). */
  @mesh()
  listOntologyVersions(): string[] {
    return this.ctx.storage.kv.get<string[]>(INDEX_KEY) ?? [];
  }

  // ─── Source of truth: the git Workspace ─────────────────────────────

  /**
   * The engine's core write: persist one edit to the working copy + `git commit`
   * (local, durable — the source-of-truth write). Returns the commit oid. There is
   * NO push step: the container's `/workspace` IS this tree via the FUSE mount
   * (containers.md § There is NO source-push step), and the built `dist/` is served
   * from this same VFS (Phase 3).
   */
  @mesh(requireDominionHere)
  async writeSource(path: string, content: string): Promise<{ oid: string; path: string }> {
    const rel = path.replace(/^\/+/, '');
    const dir = rel.includes('/') ? '/' + rel.slice(0, rel.lastIndexOf('/')) : '/';
    if (dir !== '/') await this.#ws.fs.mkdir(dir, { recursive: true });
    await this.#ws.fs.writeFile('/' + rel, content);
    await this.#ws.git.add({ paths: [rel] });
    const { oid } = await this.#ws.git.commit({ message: `edit ${rel}` });
    debug('nebula.Galaxy.writeSource').debug('commit', {
      instanceName: this.lmz.instanceName,
      path: rel,
      oid,
    });
    return { oid, path: rel };
  }

  /** Local read — the LLM hot path (read relevant files into context). */
  @mesh(requireDominionHere)
  async readSource(path: string): Promise<string> {
    return this.#ws.fs.readFile('/' + path.replace(/^\/+/, ''), 'utf8');
  }

  /** Read the ontology source + its content-addressed version (`hashBlob` of the
   *  `.d.ts`). The SINGLE source of the version label for the dev apply path, so the
   *  Star install and the client's pinned version agree by construction. (Phase 2
   *  replaces the content hash with registry-installed labels.) */
  async #readOntology(): Promise<{ types: string; version: string }> {
    const types = await this.#ws.fs.readFile('/' + ONTOLOGY_PATH, 'utf8');
    const { oid: version } = await git.hashBlob({ object: types });
    return { types, version };
  }

  /**
   * Compile the ontology `.d.ts` to a validator and install it on the `.dev` Star
   * (the Star never compiles; it receives the compiled validator). The `.dev` star is
   * derived from THIS galaxy's name (`{u}.{g}` → `{u}.{g}.dev`) — post-collapse the
   * brain sits one level above the workspace Star it installs into.
   *
   * `version` is content-addressed (`git.hashBlob` of the ontology source) so the
   * Star's Worker Loader cache (`bundleId = galaxyId/version`) never serves a stale
   * validator for changed ontology (durable-objects.md § Worker Loader cache).
   *
   * TEMP → target=Phase 2's install-on-Galaxy + Star lazy-pull: this eager downward
   * push is deleted there (the wipe decision becomes the version row's `wipeOnInstall`).
   *
   * **Flow 1b wipe gating**: on an ontology change the user decides whether to wipe
   * `.dev` data (breaking edits invalidate stored snapshots). When `wipe`,
   * `resetDevData` runs BEFORE `setOntology` (inside `installOntology`) so the new
   * validator applies to a clean Star.
   */
  @mesh(requireDominionHere)
  async compileAndInstallOntology({ wipe = false }: { wipe?: boolean } = {}): Promise<{ version: string }> {
    const { types, version } = await this.#readOntology();
    const row = compileOntologyVersion({ version, types });
    const devStar = `${this.lmz.instanceName!}.dev`;
    // Atomic wipe+install on the .dev Star (ADR-006), fired one-way (continuation-only).
    // The install's effect reaches the live preview reactively via Star's broadcastReload.
    this.lmz.call(STAR_BINDING, devStar, this.ctn<Star>().installOntology(row, { wipe }));
    debug('nebula.Galaxy.compileAndInstallOntology').debug('applied', { devStar, version, wiped: wipe });
    return { version };
  }

  // ─── The codegen turn ───────────────────────────────────────────────

  /**
   * The codegen turn: drive the bounded self-correcting loop ({@link runCodegenTurn} —
   * which writes source to the Workspace, runs the Rung-1 compile on each write, and
   * self-corrects on the error-tail), streaming progress transiently to session
   * subscribers and committing ONE durable assistant `Message` at the end.
   *
   * There is no container in this path yet: the loop's `write_file` compiles in-DO,
   * and the `build` tool (one ephemeral container per build) lands in Phase 3.
   *
   * **Fired one-way** (`client.chat` uses a `lmz.call()` continuation): a turn can run
   * for minutes, during which the client WS may drop and reconnect. The result is
   * delivered back via {@link deliverTurnResult} as a SEPARATE direct-delivery call
   * addressed to the client's stable `instanceName` (`clientId`), so it lands on
   * whatever socket is current rather than the dead originating one. `turnId`
   * (client-generated) is carried out and mirrored back so the client correlates the
   * result to its pending turn. TEMP → target=Phase 4: the committed human `Message`
   * becomes the trigger and this method leaves the mesh surface.
   *
   * ⚠️ Run with `wrangler dev` — the loop calls `env.AI.run` (or the REST lane).
   */
  @mesh(requireDominionHere)
  async chat(turnId: string, clientId: string, message: string): Promise<{ reply: string; thought: string }> {
    await this.ensureSession(); // the default Session exists before Messages FK to it
    // Mint the assistant Message id up front; stream the loop's progress transiently to
    // session subscribers; commit ONE durable Message at the end.
    const assistantMessageId = crypto.randomUUID();
    const result = await this.runCodegenTurn(
      message, DEFAULT_LOOP_CONFIG,
      (step) => this.streamProgress(DEFAULT_SESSION_ID, assistantMessageId, step, SESSION_NODE_ID),
    );
    debug('nebula.Galaxy.chat').debug('loop', {
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
    // thought panel loses the code. Last write wins per path (self-correction rounds
    // rewrite the same file).
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
    // The DURABLE assistant Message — the source of truth, fanned to every session
    // subscriber via the query rerun (history-restore + multi-participant +
    // disconnect-recovery). The client reconciles its ephemeral stream against it by id.
    await this.commitAssistantMessage(DEFAULT_SESSION_ID, assistantMessageId, reply, SESSION_NODE_ID, payload.thought);
    // The ephemeral onChatResult push stays for now (retired in Phase 6).
    this.deliverTurnResult(turnId, clientId, payload);
    return payload;
  }

  /**
   * Deliver a finished turn's result back to the originating client by **direct
   * delivery** — a NEW one-way mesh call to the client's Gateway, addressed by the
   * client's stable `instanceName` (`clientId`), so a WS drop+reconnect during the
   * turn doesn't strand the reply. NO `newChain`: the originating client's `originAuth`
   * must ride through so the Gateway's aud check passes. Fire-and-forget + try/catch:
   * a delivery failure must never break the dev loop (the turn is already committed to
   * the Workspace + the durable Message). `protected` so the test harness can exercise
   * it without the AI-bound `chat`. TEMP → target=Phase 6: the Message subscription
   * carries completion and this push is deleted.
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
      debug('nebula.Galaxy.chat').warn('turn-result delivery failed (non-fatal)', { error: e });
    }
  }

  /**
   * Signal the client its preview can load. TEMP → target=Phase 3's serving: `dist/`
   * is served Galaxy-direct from this DO's VFS, so there is nothing to warm for
   * viewing (the container is engaged only on a build, at the codegen verdict) — the
   * ready signal fires immediately so Studio's auto-refresh path keeps working until
   * the `/app/*` route + App.vue rewiring land.
   */
  @mesh(requireDominionHere)
  warmPreview(clientId: string): void {
    this.deliverPreviewReady(this.lmz.instanceName!, clientId);
  }

  /**
   * Tell the originating client the preview is ready, by direct delivery — a one-way
   * mesh call to the client's Gateway addressed by its stable `instanceName`
   * (`clientId`), so a WS reconnect doesn't strand it. Same shape + rationale (no
   * `newChain`) as {@link deliverTurnResult}; fire-and-forget + try/catch.
   */
  protected deliverPreviewReady(scope: string, clientId: string): void {
    try {
      this.lmz.call(CLIENT_GATEWAY_BINDING, clientId, this.ctn<NebulaClient>().handlePreviewReady(scope));
    } catch (e) {
      debug('nebula.Galaxy.warmPreview').warn('preview-ready delivery failed (non-fatal)', { error: e });
    }
  }

  // ─── Resource data-plane surface (chat Session/Message Resources) ─────────
  //
  // `@mesh()` — **NOT** `@mesh(requireDominionHere)` (unlike the codegen/source methods
  // above): chat participants are non-admin but DAG-granted. `onBeforeCall` (NebulaDO
  // base) enforces passage into `{u}.{g}`; the per-op DAG read/write check lives inside
  // the data-plane (Resources/DagTree), exactly as on Star. The ontology-version gate is
  // a no-op here pre-Phase-2 (one fixed code-defined version): the wrapper accepts the
  // client's `appVersion` but ignores it.

  /**
   * Idempotently seed the pre-alpha default `Session` at the fixed {@link DEFAULT_SESSION_ID}
   * under {@link SESSION_NODE_ID}. Called at the start of {@link chat} (an authed admin
   * context, so the create's `write` check passes via the CONFINED scope-admin bypass —
   * `requirePermission` grants it only to an admin whose `authScope` covers THIS host)
   * and exposed as an admin-gated entry so a client can guarantee the session exists
   * before subscribing `Message where session == DEFAULT_SESSION_ID`. A second call is a
   * no-op (the capability's create-if-absent). Internal `this.ensureSession()` calls
   * bypass the decorator (direct method call).
   */
  @mesh(requireDominionHere)
  async ensureSession(): Promise<void> {
    await this.#dataPlane.ensureResource(DEFAULT_SESSION_ID, 'Session', SESSION_NODE_ID, { title: 'Studio chat' });
  }

  /**
   * Permission-filtered fanout targets for a query at `nodeId` — the transient-stream
   * audience. `protected`: the progress push uses it internally; a test subclass
   * exposes it for the per-operand accessor test.
   */
  protected queryTargets(query: QueryDescriptor, nodeId: string): BroadcastTarget[] {
    return this.#dataPlane.targetsForQuery(query, nodeId);
  }

  /**
   * Push ONE transient assistant-progress chunk to the session query's subscribers
   * that may read `nodeId`. Fire-and-forget `svc.broadcast` of `handleStreamChunk` —
   * no Resource write, no fanout/rerun. Permission-filtered via {@link queryTargets}
   * (the transient path's point-of-action recheck, symmetric with the durable path —
   * a subscriber denied on `nodeId` gets NO chunk). No `onResult`: a missed chunk just
   * drops the animation (the durable Message still lands via the query sub).
   */
  protected streamProgress(sessionId: string, messageId: string, progress: string, nodeId: string): void {
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'session', value: sessionId };
    const targets = this.queryTargets(query, nodeId);
    // Log identifiers/counts only — never the progress body.
    debug('nebula.Galaxy.stream').debug('chunk', { messageId, targets: targets.length, len: progress.length });
    if (targets.length === 0) return;
    this.svc.broadcast(targets, this.ctn<NebulaClient>().handleStreamChunk(messageId, progress));
  }

  /**
   * Commit the DURABLE assistant `Message` at completion — ONE create at `messageId`,
   * which the query rerun fans to every session subscriber (and the client reconciles
   * against its ephemeral stream by id). Create-if-absent via the capability (a fresh
   * assistant id → a create); server-internal, no client delivery.
   */
  protected async commitAssistantMessage(
    sessionId: string, messageId: string, content: string, nodeId: string, thought?: string,
  ): Promise<void> {
    const value: Record<string, unknown> = { session: sessionId, role: 'assistant', content, status: 'complete' };
    if (thought !== undefined) value.thought = thought;
    debug('nebula.Galaxy.stream').debug('commit', { messageId, len: content.length });
    await this.#dataPlane.ensureResource(messageId, 'Message', nodeId, value);
  }

  /** Handler 1: RETURN the transaction result — the framework fires it back to the caller's
   *  `callAsync`. No version-gate pre-Phase-2 (one fixed code-defined ontology). */
  @mesh()
  transaction(appVersion: string, newETag: string, ops: Record<string, OperationDescriptor>): Promise<TransactionResult> {
    void appVersion; // version-gate lands with Phase 2's installed ontology
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('transaction requires a client origin with instanceName in callChain[0]');
    }
    return this.#dataPlane.doTransaction(newETag, ops, clientId);
  }

  /** Handler 1: RETURN the read value — the framework fires it back to the caller's `callAsync`. */
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

  /** Handler 1: register a query subscription + push the initial membership (void).
   *  Non-admin + DAG-gated (authorization is per-push at delivery). `clientId`/
   *  `subscriberBinding` from `callChain`. See `Star.subscribeQuery`. */
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

  /** Drop the caller's query-sub row for `queryHash` (clientId from callChain). */
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

  /** Drop the caller's subscriber-list WATCHER row for `queryHash` (clientId from callChain). */
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

  // ─── Node invites (the security logic lives in the plane — written once) ────

  /**
   * Invite people onto a NODE of this Galaxy's orgTree — how a non-`scopeAdmin`
   * collaborator gets a DAG grant here. The whole two-plane operation (the DAG gate,
   * the `pending` `_InviteStatus` rows, the grants + flips on the result) lives in
   * {@link ResourceDataPlane.invite}; this host supplies only the facade fire (the one
   * mesh-typed line). TEMP → target=resources() gate
   * (tasks/nebula-data-plane-owns-its-guards.md deletes all four host forwards).
   */
  @mesh()
  async invite(nodeId: string, invitees: NodeInvitee[]): Promise<NodeInviteAck> {
    return this.#dataPlane.invite(nodeId, invitees, (valid) =>
      this.lmz.call(
        'NEBULA_AUTH_FACADE', undefined,
        this.ctn<NebulaAuthFacade>().invite(this.lmz.instanceName!, valid.map(({ email }) => ({ email }))),
        this.ctn<Galaxy>().onInviteResult(nodeId, Object.fromEntries(valid.map(v => [v.email, v.tier]))),
      ));
  }

  /**
   * The node invite's result handler — travels with the facade call (never awaited).
   * `public` and deliberately NOT `@mesh()` — the fire-back lands via `__handleResponse`
   * (allowlist off, scope-check on), and an `@mesh` here would let any in-scope caller
   * forge an invite outcome and write themselves grants. Body in the plane.
   * TEMP → target=resources() gate.
   */
  public onInviteResult(
    nodeId: string, tiers: Record<string, PermissionTier>, result?: unknown,
  ): Promise<void> {
    return this.#dataPlane.onInviteResult(nodeId, tiers, result);
  }

  // ─── Host-side fanout (the ResourceHostBridge impls) ────────────────

  /** Host-side fanout for one mutated resource — plain `svc.broadcast` with
   *  drop-on-failed-fanout cleanup via {@link onBroadcastResult}. */
  #broadcastResourceUpdate(resourceId: string, snapshot: Snapshot, targets: BroadcastTarget[]): void {
    const remote = this.ctn<NebulaClient>().handleResourceUpdate(
      snapshot.meta.typeName, resourceId, snapshot);
    this.svc.broadcast(targets, remote, { onResult: this.ctn<Galaxy>().onBroadcastResult(resourceId) });
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
   *  {@link onQueryBroadcastResult} keyed by `queryHash`. */
  #broadcastQueryUpdate(queryHash: string, resourceIds: string[], targets: BroadcastTarget[]): void {
    const remote = this.ctn<NebulaClient>().handleQueryUpdate(queryHash, { resourceIds });
    this.svc.broadcast(targets, remote, { onResult: this.ctn<Galaxy>().onQueryBroadcastResult(queryHash) });
  }

  /** Host-side fanout for a subscriber-list roster push — the distinct-by-`sub` roster to a
   *  query's WATCHERS. Dead-WATCHER cleanup uses the DEDICATED
   *  {@link onQuerySubscriberListBroadcastResult} (watcher table, NOT `QuerySubscribers`). */
  #broadcastRosterUpdate(queryHash: string, roster: SubscriberEntry[], targets: BroadcastTarget[]): void {
    const remote = this.ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, roster);
    this.svc.broadcast(targets, remote, { onResult: this.ctn<Galaxy>().onQuerySubscriberListBroadcastResult(queryHash) });
  }

  /** Per-target query-push result handler (no-denial broadcast + has-denial
   *  deliveries); drops the dead client's query-sub row on disconnect. */
  @mesh()
  onQueryBroadcastResult(queryHash: string, result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#dataPlane.removeQuerySubscriber(queryHash, clientId);
    }
  }

  /** Per-target roster-push result handler — drops the dead WATCHER's row from the WATCHER table
   *  ONLY (NOT `QuerySubscribers`), so a dual-role client keeps its data sub. */
  @mesh()
  onQuerySubscriberListBroadcastResult(queryHash: string, result?: unknown): void {
    if (result instanceof Error && result.name === 'ClientDisconnectedError') {
      const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
      if (clientId) this.#dataPlane.removeQuerySubscriberListWatcher(queryHash, clientId);
    }
  }

  // ─── The codegen loop (model call + tool validation) ─────────────────

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

  /** Trust boundary: typia-validate the untrusted model's tool-call args (shape
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
   * so the test harness replays a synthetic script with no AI binding.
   *
   * Two shipping transports, selected by `WORKERS_AI_TOKEN` presence:
   * - **token present → Workers-AI REST** ({@link Galaxy.#callModelRest}). The hosted lane
   *   has no CF account creds, so the `env.AI` binding can't authenticate there; a scoped
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
   * The `/ai/run` response wraps the binding's result in `{ result, success, errors }` —
   * {@link unwrapWorkersAiRest} unwraps `.result` so `parseModelTurn` reads the same
   * shape the binding returns.
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
   * layer), run {@link runCodegenLoop}, and return the loop result. The former
   * turn-recorder side table is DELETED — the corpus folds into the agent
   * `Message`'s `codegen` value object (Phase 2).
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
    try { currentSource = await this.#ws.fs.readFile('/src/App.vue', 'utf8'); } catch { /* none yet */ }
    let ontologyDts: string | undefined;
    try { ontologyDts = await this.#ws.fs.readFile('/' + ONTOLOGY_PATH, 'utf8'); } catch { /* none yet */ }

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
    return runCodegenLoop(initial, deps, config);
  }
}
