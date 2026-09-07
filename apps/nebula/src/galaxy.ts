/**
 * Galaxy — the app-level brain, one DO per galaxy (instanceName = `{u}.{g}`, e.g. "acme.app").
 *
 * The collapse of three former nodes (Galaxy + DevStudio + DevContainer) into one class
 * (tasks/archive/nebula-galaxy-collapse-and-chat.md). It owns:
 *  - the per-galaxy **ontology registry**: `appendWorkspaceOntology()` (the dev Apply)
 *    compiles the Workspace's `.d.ts` to a `validatorBundle` row and stores it as an
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
 * `{u}.{g}`). Three guard tiers sit on top of it. The source entries — `readSource`,
 * `writeSource`, `buildNow`, `appendWorkspaceOntology` — carry `@mesh(requireChatWrite)`,
 * the chat floor: DAG `write` at the chat node, the same check a Message create passes
 * at the door, so a collaborator's direct call and the turn their message triggers agree.
 * Galaxy configuration (`setGalaxyConfig`, `ensureChat`) keeps `@mesh(requireDominionHere)`.
 * The chat data-plane surface is bare `@mesh()` — participants are non-admin but
 * DAG-granted, and the per-op check lives inside the plane.
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { Workspace } from '@cloudflare/computer';
import type { DurableObjectStorageLike } from '@cloudflare/computer';
import { CloudflareContainerBackend, WorkspaceContainerAPI } from '@cloudflare/computer/backends/container';
import { createGitClient } from '@cloudflare/computer/git';
import git from 'isomorphic-git';
import {
  getParserValidatorFacet,
  type ParserValidator,
} from '@lumenize/ts-runtime-parser-validator/runtime';
import { NEBULA_SUB, ACCESS_TOKEN_TTL, hasDominionOver, projectActingToken } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { NebulaDO, requireDominionHere } from './nebula-do';
// Types only — the COMPILE itself runs in the container build job
// (tasks/archive/nebula-move-compilers-out-of-the-worker.md: the Worker orchestrates and
// stores, and does not build). No value import of the compile half may return here;
// scripts/check-worker-graph.mjs is the tripwire.
import type { OntologyVersionRow } from './ontology-compile';
import { stepFailed, REPORT_MARKER, ROW_PATH, WS_ROOT, wsPath } from './build-report';
import { withHeartbeat } from './turn-heartbeat';
import { assembleStream } from './model-stream';
import { TURN_HEARTBEAT_MS } from './turn-liveness';
import type { BuildReport, StepResult } from './build-report';
import { ResourceDataPlane } from './resource-data-plane';
import type { BroadcastTarget, NodeInvitee, NodeInviteAck } from './resource-data-plane';
import type { PermissionTier } from './dag-ops';
import type { QueryDescriptor, SubscriberEntry } from './query-hash';
import { chatOntologySeedRow } from './chat-ontology';
import { DEFAULT_CHAT_ID, CHAT_NODE_ID } from './chat-constants';
import { OntologyStaleError } from './errors';
import { serveApp } from './serve';
import { deriveKind } from './participants';
import { SCAFFOLD_FILES } from './scaffold-seed';
import { PLATFORM_FILES, PLATFORM_AGENTS_MD } from './platform-embed';
import type { DagTree } from './dag-tree';
import type { NebulaClient } from './nebula-client';
// Type-only: types the facade continuation without pulling a second mesh entry into this
// module's value graph.
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
import type { OperationDescriptor, Snapshot, TransactionResult } from './resources';
import { TOOL_ARGS_BUNDLE_ID } from './tool-args-constants';
import { TOOL_ARGS_VALIDATOR_MODULE } from './validator-seeds';
import {
  runCodegenLoop,
  parseModelTurn,
  assembleCodegenPrompt,
  renderHistoryBundle,
  TOOL_CONTRACT,
  CODEGEN_TOOLS,
  TOOL_ARG_TYPE,
  unknownToolArgKeys,
  DEFAULT_LOOP_CONFIG,
  type HistoryEntry,
  type CodegenLoopConfig,
  type CodegenLoopDeps,
  type LoopToolDeps,
  type LoopToolName,
  type ChatMessage,
  type ModelParams,
  type LoopResult,
} from './codegen-loop';

// Type-only re-exports survive (erased — no value edge to the compile half); the old
// VALUE re-exports (`compileOntologyVersion`, `PLATFORM_RESOURCE_TYPES`) are the
// barrel edge that kept tsc in every consumer's bundle — import them from
// `./ontology-compile` directly where a test lane genuinely compiles.
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

/**
 * The workspace ontology REGISTRY is a DIRECTORY OF FILES, not keyed storage: the
 * compiled row is born as a file (the job writes it at {@link ROW_PATH}), and the
 * Apply moves it to `.nebula/ontology/<version>.json` — reading the registry means
 * reading those files, the same way reading the ontology means reading
 * `src/ontology.d.ts`. There is no index and no "latest" pointer to keep in sync;
 * the applied head is DERIVED per read ({@link #appliedHead}). Untracked, like
 * {@link ROW_PATH}: git tracks only what `git.add` is handed.
 */
const REGISTRY_DIR = '.nebula/ontology';
/** A version is a `git.hashBlob` oid — 40 hex — and it becomes a FILENAME, so every
 *  read-by-label door MUST refuse anything else (a remote caller's version string
 *  must never traverse the VFS). */
const VERSION_RE = /^[0-9a-f]{40}$/;
const registryPath = (version: string) => `${REGISTRY_DIR}/${version}.json`;
/** The stored file: the compiled row plus the append-time stamp that orders the
 *  registry (ISO 8601 UTC — ADR-011). `appliedAt` is an APPLY fact, so the Galaxy
 *  stamps it at append; the job never writes it. */
type RegistryFile = OntologyVersionRow & { appliedAt: string };

// The Galaxy's OWN chat plane installs its ontology into a PARALLEL keyspace — never the
// app-ontology registry above, whose latest row is what Stars pull (a chat version in that
// index would become some Star's app ontology). Distinct keyspaces per component in one DO
// (the sql-migrations markerKey rule, applied to KV).
const CHAT_INDEX_KEY = 'chatOntology:_index';
const chatRowKey = (version: string) => `chatOntology:${version}`;

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
 * The default generation deadline, at module scope so a test can assert the
 * shipped value rather than a copy of it (see `Galaxy.generationDeadlineMs`,
 * whose JSDoc carries why this is an authorization bound).
 */
export const GENERATION_DEADLINE_MS = 840_000;

/** A hung build job is killed here; the report's `container` tail then NAMES the
 *  timeout, so the model does not rebuild the same code until the turn deadline.
 *  Generous: a heavy-lib vite 8 build measured seconds, not minutes (§ Relationships
 *  in the collapse task; re-tune from evidence, not fear). */

const BUILD_TIMEOUT_MS = 180_000;

/** Per-cycle job options: the host-computed ontology work, when the `.d.ts` changed. */
type BuildJobOpts = { ontology?: { version: string; wipe: boolean } };

/** The seam's placeholder `preview` — {@link Galaxy.#buildAndAnnounce} overwrites it
 *  with the real decision, so a faked `build()` never decides the refresh either. */
const PREVIEW_UNDECIDED = { refreshed: false, why: 'not decided at the build layer' };

/**
 * The preview decision — default: refresh the `.dev` preview only on a clean build;
 * the MODEL may override to refresh alongside findings it judges harmless (the task's
 * refresh-is-the-model's-call decision). What it can never override is a failed (or
 * never-run) bundle: there is no `dist`, so nothing to refresh from — structural, not
 * policy. Pure and exported so every arm is unit-testable; the announce layer
 * (`#buildAndAnnounce`) is its only production caller.
 */
export function decidePreview(report: BuildReport, override?: boolean): BuildReport['preview'] {
  if (!(report.bundle.ran && report.bundle.ok === true)) {
    const why = report.bundle.ran
      ? 'bundle failed — there is no dist to refresh the preview from'
      : `bundle did not run (${(report.bundle as { why: string }).why}) — there is no new dist`;
    return { refreshed: false, why };
  }
  if (override === true) {
    return { refreshed: true, why: 'refreshed on the model\'s override' };
  }
  if (override === false) {
    return { refreshed: false, why: 'the model declined to refresh the preview' };
  }
  if (stepFailed(report.ontology)) {
    return { refreshed: false, why: 'ontology compile failed — preview refresh withheld by default' };
  }
  if (report.typeCheck.findings.length > 0) {
    return { refreshed: false, why: 'type findings — preview refresh withheld by default (the model may override)' };
  }
  return { refreshed: true, why: 'clean build' };
}

/** The env the in-container `vite build` runs under. Deps are baked at the image
 *  ROOT (never the FUSE mount — containers.md), so `vite` resolves from
 *  `/node_modules/.bin`; NODE_ENV pinned so rollup never takes a dev path. */
const BUILD_ENV = {
  PATH: '/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  NODE_ENV: 'production',
};



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
  return isStuckFlagText(body);
}

/**
 * The phrase set alone — the ONE place the signature is written. A thrown error carries
 * only a `message` (no `status`/`body`), so the drive needs the phrases without the
 * status guard; spelling them inline there instead made two copies of one answer, and
 * only the exported pair had tests, so the inline copy could drift silently — on the
 * very branch that decides whether the evidence marker fires at all.
 */
export function isStuckFlagText(text: string): boolean {
  return /not running|suddenly disconnected|proxying request to container/i.test(text);
}

/** The LAST `n` chars — build/exec output is bounded from the tail, where the error is. */
function tail(text: string, n: number): string {
  return text.length > n ? text.slice(-n) : text;
}

// ─── The chat floor + the path rule (the source entries' own guards) ────────

/**
 * Guard: the CHAT FLOOR — DAG `write` at the chat node, the check a Message create runs
 * at the door. Every source entry (`readSource`, `writeSource`, `buildNow`,
 * `appendWorkspaceOntology`) carries `@mesh(requireChatWrite)`, so a collaborator who can
 * post — and whose post therefore triggers a turn that writes and builds under their own
 * claims — can make the same calls directly. A Galaxy admin passes through the confined
 * scope-admin bypass inside `requirePermission`, so nothing changes for the owner.
 *
 * Distinct from {@link requireDominionHere}, which stays on the Galaxy's configuration
 * entries: this guard reads the DAG grant, so it inherits `DagTree.requirePermission`'s
 * obligations — the host-confined dominion bypass and the `PermissionDeniedError` message
 * a boundary refusal is told apart by (`security.md`).
 */
export function requireChatWrite(instance: Galaxy): void {
  instance.dagTree().requirePermission(CHAT_NODE_ID, 'write');
}

/**
 * The path rule for a model- or client-chosen Workspace path, enforced IN THE ENTRIES
 * (`readSource` / `writeSource`) so a direct call and a loop tool agree. Normalises a
 * leading `./`, then refuses an absolute path and any `..` segment; for a WRITE, also
 * refuses every path whose first segment starts with `.` other than `.agents` —
 * `.platform/` and `.universe/` are mounts, `.nebula/` is machine-owned (a write there
 * would plant a registry row `#registryRows()` parses), `.git/` is git's, `.env` is where
 * a secret would go. Reads of a dot path stay allowed (the build box reads `.git/index`
 * and the compiled row). Returns the normalised relative path. Pure; throws on reject.
 */
export function assertModelPath(path: string, opts: { write: boolean }): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`Invalid source path: ${String(path)}`);
  }
  const rel = path.replace(/^(\.\/)+/, '');
  if (rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error(`Absolute source path rejected: ${path}`);
  }
  const segments = rel.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new Error(`'..' segment rejected in source path: ${path}`);
  }
  if (opts.write && segments[0]!.startsWith('.') && segments[0] !== '.agents') {
    throw new Error(
      `Reserved path rejected for write: ${path} — a path whose first segment starts with a dot (a file like .env, or a directory like .git/ or .nebula/) is not writable, except under .agents/`,
    );
  }
  return rel;
}

/** A loop tool → the Galaxy entries it reaches. `runCodegenTurn` builds the tool deps from
 *  this table ({@link Galaxy.loopToolDeps}), so a tool cannot reach an entry the table does
 *  not name, and the resource-surface test reads it to assert every named entry sits at the
 *  chat floor. `mark_complete` reaches nothing and is not listed. */
export const LOOP_TOOL_ENTRIES = {
  read_file: ['readSource'],
  write_file: ['writeSource'],
  edit_file: ['readSource', 'writeSource'],
  build: ['buildNow'],
} as const satisfies { [K in LoopToolName]: readonly LoopEntry[] };

/** The reserved mounts a `read_file` path may name, and what answers each: `.platform/`
 *  is the embedded platform layer ({@link PLATFORM_FILES}); `.universe/` is reserved
 *  for a layer that does not exist yet and answers this error until it does. */
export const UNIVERSE_RESERVED_MESSAGE = '.universe/ is reserved — no Universe layer exists yet';

/** A Workspace read that found no file, as the model should see it: the path, not a
 *  VFS error code. Any other read failure passes through unchanged. */
function noSuchFile(path: string, e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return /ENOENT|no such file|not found|does not exist|NotFound/i.test(msg)
    ? new Error(`no such file: ${path}`)
    : (e instanceof Error ? e : new Error(msg));
}

/** The Galaxy entries a loop tool may reach — the domain of {@link LOOP_TOOL_ENTRIES}. */
type LoopEntry = 'readSource' | 'writeSource' | 'buildNow';

/** {@link isStuckFlagResponse} over a thrown error carrying `(status, body)` — defensive
 *  against a plain Error (no `status`/`body` → not stuck). Pure. */
export function isStuckFlagError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; body?: unknown };
  if (typeof e.status !== 'number' || typeof e.body !== 'string') return false;
  return isStuckFlagResponse(e.status, e.body);
}

/**
 * The Workers AI REST lane's header map — pure, so the affinity header's presence on
 * that lane is assertable without a token. `extra` is {@link Galaxy.modelCallHeaders}
 * (the session-affinity header both lanes send); the gateway id rides as a header on
 * the ordinary `/ai/run` endpoint rather than a second origin (see `#callModelRest`).
 */
export function workersAiRestHeaders(opts: { token: string; gateway?: string; extra: Record<string, string> }): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
    ...opts.extra,
    ...(opts.gateway ? { 'cf-aig-gateway-id': opts.gateway } : {}),
  };
}

// ─── Galaxy DO ───────────────────────────────────────────────────────

export class Galaxy extends NebulaDO {
  // Cache over `ctx.storage` (the durable Workspace VFS) — reconstructed in onStart,
  // never the source of truth. `!`-asserted: onStart runs (inside the base
  // blockConcurrencyWhile) before any @mesh method.
  #ws!: Workspace;
  // Re-derivable cache (loss acceptable) — the tool-args typia validator facet
  // (durable-objects.md "ephemeral caches").
  #toolArgsFacet?: ParserValidator;
  // The composed resource data-plane — hosts the chat Chat/Message Resources.
  #dataPlane!: ResourceDataPlane;
  // Caches over the INSTALLED chat-ontology row (the Star pattern — reconstructed lazily,
  // never the source of truth).
  #chatRow: OntologyVersionRow | null = null;
  #chatFacet: ParserValidator | null = null;
  // The container transport — the backend object is cheap coordination state (no
  // container starts until a build's exec connects); the API wrapper is constructed
  // LAZILY because its ctor throws where `ctx.container` is absent (pool-workers).
  #buildBackend!: CloudflareContainerBackend;
  #containerApi?: WorkspaceContainerAPI;
  // The promise-chain build latch — overlapping builds QUEUE on the one container
  // (never `blockConcurrencyWhile`, which would deafen the hub for the probe's
  // seconds — containers.md). In-memory coordination state, not business data.
  #buildChain: Promise<unknown> = Promise.resolve();
  // Turn single-flight (in-memory BY DESIGN: eviction clearing it is exactly the
  // post-deadline reset semantics — see `chat`).
  #turnInFlight = false;
  /** The generation deadline — a hung `env.AI` await past this releases the turn
   *  latch + ends the heartbeat so a fresh message can start a NEW generation.
   *  `protected` field so the test probe can shorten it.
   *
   *  A hung-call backstop and nothing else. It is NOT an authorization bound: a
   *  triggered turn runs detached under the POSTER's claims as verified at the post, and
   *  finishes under them whatever happens to the token or the grant meanwhile — the
   *  reply commits with the door's verdict pinned (`TransactionOpts.pinnedAtPost`). It
   *  went from 300 s to 840 s on 2026-09-06 when the round cap went to 32, and the same
   *  day Larry retired the older "must stay under the access TTL" coupling, which had
   *  tied a liveness knob to the token window for no property the design wants. */
  protected generationDeadlineMs = GENERATION_DEADLINE_MS;

  /** Reconstruct the Workspace (fs + host-side git over this DO's own SQLite), seed the
   *  framework scaffold + `git init` once (latched in kv), and register the container
   *  BACKEND (an inert object until a build's exec connects — no container is started
   *  here). Async — runs inside the base `blockConcurrencyWhile`, so requests block
   *  until it completes (durable-objects.md § Initialization). */
  override async onStart(): Promise<void> {
    this.#constructWorkspace();
    if (!this.ctx.storage.kv.get(GIT_INITED_KEY)) {
      // Seed the framework scaffold (container/app/, embedded at generation time) so the
      // tree is a COMPLETE vite project from birth — the build box mounts this very tree
      // at /workspace, so seeding the VFS is the whole delivery (no push step). Every
      // host-side path lives under WS_ROOT: the mount serves that SUBTREE of the VFS,
      // never its root (build-report.ts § WS_ROOT). The repo roots there too, so `.git`
      // rides the mount like a normal checkout.
      await this.#ws.fs.mkdir(WS_ROOT, { recursive: true });
      for (const [rel, content] of Object.entries(SCAFFOLD_FILES)) {
        if (rel.includes('/')) {
          await this.#ws.fs.mkdir(wsPath(rel.slice(0, rel.lastIndexOf('/'))), { recursive: true });
        }
        await this.#ws.fs.writeFile(wsPath(rel), content);
      }
      await this.#ws.git.init({ dir: WS_ROOT, defaultBranch: 'main' });
      await this.#ws.git.add({ dir: WS_ROOT, paths: Object.keys(SCAFFOLD_FILES) });
      await this.#ws.git.commit({ dir: WS_ROOT, message: 'scaffold' });
      this.ctx.storage.kv.put(GIT_INITED_KEY, true);
    }
    // Compose the resource data-plane — the chat Chat/Message host. The ontology
    // provider reads the INSTALLED chat-ontology row (self-seeded on first touch from the
    // platform constant — #ensureChatFacet), exactly the way Star reads its installed app
    // row. No org-tree subscribe channel here, so onDagChanged is a no-op.
    this.#dataPlane = new ResourceDataPlane(
      this.ctx,
      () => this.lmz.callContext,
      () => this.chatOntology(),
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
        // THE codegen trigger's seam — a committed human Message starts a turn
        // (#onChatCommitted's predicate owns what reacts).
        onCommitted: (mutations) => this.#onChatCommitted(mutations),
      },
      () => { /* no org-tree subscribe channel on Galaxy */ },
      // Host name as a THUNK — `this.lmz.instanceName` is not stamped yet inside `onStart()`.
      // It is the scope the `access.scopeAdmin` bypass is confined to at both confinement points.
      () => this.lmz.instanceName,
    );
    // Null the cached chat-ontology row + facet so `onStart` is a COMPLETE (re)init (a
    // stale facet after a teardown+reconstruct would keep authorizing a dropped install —
    // the same load-bearing nulling Star.onStart does).
    this.#chatRow = null;
    this.#chatFacet = null;
  }

  /**
   * The Galaxy's own chat-ontology install — populate `#chatRow`/`#chatFacet` from the
   * `chatOntology:` KV keyspace, SELF-SEEDING the platform version on first touch (never a
   * deploy step). This is the registry that DELETED the breaking-ontology ritual: the
   * loader `bundleId` derives from the installed label (labels are append-only +
   * duplicate-rejected), so a new version structurally cannot reuse a warm bundle — no
   * hand-bumped constant, nothing to remember.
   */
  #ensureChatFacet(): { row: OntologyVersionRow; facet: ParserValidator } {
    if (this.#chatRow && this.#chatFacet) return { row: this.#chatRow, facet: this.#chatFacet };

    let index = this.ctx.storage.kv.get<string[]>(CHAT_INDEX_KEY) ?? [];
    if (index.length === 0) {
      // First touch — install the platform seed (one compile per Galaxy, then durable).
      const seed = chatOntologySeedRow();
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.kv.put(chatRowKey(seed.version), seed);
        this.ctx.storage.kv.put(CHAT_INDEX_KEY, [seed.version]);
      });
      index = [seed.version];
    }
    const version = index[index.length - 1];
    const row = this.ctx.storage.kv.get<OntologyVersionRow>(chatRowKey(version));
    if (!row) {
      throw new Error(`Chat ontology row missing for version '${version}' — index/row drift`);
    }
    this.#chatRow = row;
    // Disjoint from every other Worker-Loader namespace: the app-ontology form is
    // `{u}.{g}/{label}` (one slash, label can't contain '/'), so `{u}.{g}/chat/{label}`
    // (two slashes) can never collide with it, nor with the slash-less tool-args id.
    const host = this.lmz.instanceName ?? this.ctx.id.name;
    const bundleId = `${host}/chat/${row.version}`;
    this.#chatFacet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => {
        debug('nebula.Galaxy.ensureChatFacet').info('facet cold load', { bundleId });
        return row.validatorBundle;
      },
    );
    return { row, facet: this.#chatFacet };
  }

  /** True iff `version` is the INSTALLED chat-ontology version (self-seeding on first
   *  touch, so a fresh Galaxy compares against the platform seed rather than nothing). */
  #isCurrentChatVersion(version: string): boolean {
    return this.#ensureChatFacet().row.version === version;
  }

  /** The installed chat-ontology surface — the data-plane's provider thunk reads through
   *  this, and `protected` lets a test subclass assert the installed facet directly. */
  protected chatOntology(): { version: string; facet: ParserValidator; relationships: OntologyVersionRow['relationships'] } {
    const { row, facet } = this.#ensureChatFacet();
    return { version: row.version, facet, relationships: row.relationships };
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
  // The one WRITE path is `appendWorkspaceOntology` (the dev Apply); the deleted
  // caller-supplied-types append was a test-install path with no production caller.

  /**
   * The row a star with NO installed ontology should run — the server-originated
   * first-touch arm of the lazy-pull (a client op always pins a version; a
   * server-originated write like `Star.invite` has no client to pin one, so it asks
   * for "current"). **The ontology IS the workspace file**: the version is derived
   * here by READING `src/ontology.d.ts` and hashing it, never by trusting a stored
   * pointer — storage holds only the immutable compiled row per version, keyed by
   * that hash. A row exists only for an APPLIED version, so when the file is
   * mid-draft (its hash has no row yet) the last APPLIED row answers instead —
   * tenants run applied versions; the draft is Studio's alone. Bare `@mesh()` like
   * {@link getOntologyVersion}: an upward call every descendant member has passage for.
   */
  @mesh()
  async getCurrentOntology(): Promise<OntologyVersionRow | null> {
    return this.#appliedHead();
  }

  /** One registry row file, parsed — `null` for an unapplied (or malformed) label.
   *  The sanitize is load-bearing: `version` becomes a FILENAME and arrives from
   *  remote callers via {@link getOntologyVersion}. */
  async #registryRow(version: string): Promise<RegistryFile | null> {
    if (!VERSION_RE.test(version)) return null;
    try {
      return JSON.parse(await this.#ws.fs.readFile(wsPath(registryPath(version)), 'utf8')) as RegistryFile;
    } catch {
      return null;
    }
  }

  /** Every registry row file, parsed, oldest applied first. */
  async #registryRows(): Promise<RegistryFile[]> {
    let names: string[];
    try {
      names = (await this.#ws.fs.readdir(wsPath(REGISTRY_DIR))).map((d) => d.name);
    } catch {
      return []; // no registry directory yet — nothing has been applied
    }
    const rows = await Promise.all(names
      .filter((n) => n.endsWith('.json'))
      .map((n) => this.#registryRow(n.slice(0, -'.json'.length))));
    return (rows.filter(Boolean) as RegistryFile[])
      .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.version.localeCompare(b.version));
  }

  /** The row tenants run NOW — file-first: the workspace ontology file's own hash
   *  answers when that version has been applied; while the file is a mid-draft whose
   *  hash has no row yet, the most recently APPLIED row answers instead. The serve's
   *  scope meta and {@link getCurrentOntology} both derive from here, so there is
   *  exactly one definition of "current". */
  async #appliedHead(): Promise<RegistryFile | null> {
    try {
      const { version } = await this.#readOntology();
      const fromFile = await this.#registryRow(version);
      if (fromFile) return fromFile;
    } catch { /* no ontology file yet — fall through to the applied rows */ }
    return (await this.#registryRows()).at(-1) ?? null;
  }

  /** Specific row by label, or `null` if absent. Bare `@mesh()` on purpose: a Star's
   *  lazy-pull is an UPWARD call — every member of a descendant scope has passage here. */
  @mesh()
  async getOntologyVersion(version: string): Promise<OntologyVersionRow | null> {
    return this.#registryRow(version);
  }

  /** Ordered version labels (oldest applied → newest). Registry introspection —
   *  deliberately NOT `@mesh` (nothing remote needs the history; the in-DO registry
   *  tests read it, and a future Studio admin surface would re-expose it as a
   *  decision, not a leftover). */
  async listOntologyVersions(): Promise<string[]> {
    return (await this.#registryRows()).map((r) => r.version);
  }

  // ─── Source of truth: the git Workspace ─────────────────────────────

  /**
   * The engine's core write: persist one edit to the working copy + `git commit`
   * (local, durable — the source-of-truth write). Returns the commit oid. There is
   * NO push step: the container's `/workspace` IS this tree via the FUSE mount
   * (containers.md § There is NO source-push step), and the built `dist/` is served
   * from this same VFS (Phase 3).
   *
   * Guarded at the chat floor ({@link requireChatWrite}), and the path rule runs FIRST
   * ({@link assertModelPath}): only the user-owned tree is writable. A call with a
   * client origin logs the acting principal's projection — the ADR-016 record for a
   * direct edit; a turn's writes carry it too, and the agent Message records the turn as a whole.
   */
  @mesh(requireChatWrite)
  async writeSource(path: string, content: string): Promise<{ oid: string; path: string }> {
    const rel = assertModelPath(path, { write: true });
    if (rel.includes('/')) {
      await this.#ws.fs.mkdir(wsPath(rel.slice(0, rel.lastIndexOf('/'))), { recursive: true });
    }
    await this.#ws.fs.writeFile(wsPath(rel), content);
    await this.#ws.git.add({ dir: WS_ROOT, paths: [rel] });
    const { oid } = await this.#ws.git.commit({ dir: WS_ROOT, message: `edit ${rel}` });
    const origin = this.#clientOrigin();
    debug('nebula.Galaxy.writeSource').debug('commit', {
      instanceName: this.lmz.instanceName,
      path: rel,
      oid,
      ...(origin ? { clientId: origin.clientId, actingToken: projectActingToken(origin.claims) } : {}),
    });
    return { oid, path: rel };
  }

  /** Local read — the LLM hot path (read relevant files into context). Chat floor;
   *  the path rule runs first (a read of a dot path is allowed — see
   *  {@link assertModelPath}). */
  @mesh(requireChatWrite)
  async readSource(path: string): Promise<string> {
    const rel = assertModelPath(path, { write: false });
    return this.#ws.fs.readFile(wsPath(rel), 'utf8');
  }

  /**
   * The client that made this call and the verified claims it rides, or `undefined` when
   * there is no client origin — a server-internal call, or a direct in-DO test call with
   * no mesh call context at all (reading `lmz.callContext` outside a call throws, and
   * that is the one case this tolerates).
   */
  #clientOrigin(): { clientId: string; claims: NebulaJwtPayload } | undefined {
    let cc: CallContextLike | undefined;
    try { cc = this.lmz.callContext; } catch { return undefined; }
    const clientId = cc?.callChain[0]?.instanceName;
    const claims = cc?.originAuth?.claims as NebulaJwtPayload | undefined;
    return clientId && claims ? { clientId, claims } : undefined;
  }

  /** Read the ontology source + its content-addressed version (`hashBlob` of the
   *  `.d.ts`). The SINGLE source of the version label for the dev apply path, so a
   *  Star's lazy-pull and the client's pinned version agree by construction. */
  async #readOntology(): Promise<{ types: string; version: string }> {
    const types = await this.#ws.fs.readFile(wsPath(ONTOLOGY_PATH), 'utf8');
    const { oid: version } = await git.hashBlob({ object: types });
    return { types, version };
  }

  /**
   * The dev apply step: compile the Workspace's ontology `.d.ts` and APPEND it to this
   * Galaxy's registry — there is NO downward push (deleted 2026-08-28, the second of the
   * two system hops the collapse removes). A Star acquires the version by LAZY-PULL: on
   * a data op whose expected version it doesn't hold, it pulls
   * `getOntologyVersion(version)` from this Galaxy inside that op's own call context —
   * upward passage is free for every member, so it works under any claims (the auth
   * story the eager push never had), and dev unifies with the prod (Flow 2b) design.
   *
   * The COMPILE runs in the container build job (one ephemeral cycle, shared with
   * `vite build` — the Worker never compiles); the row rides the mount at `ROW_PATH`
   * and is read back HOST-side here. `version` + `wipeOnInstall` are host-computed and
   * passed IN, never read back out of the container — `version` keys the Star's
   * Worker Loader cache, and the wipe bit is decided in this method's body. The Galaxy
   * keeps the append-only check, the write and the `transactionSync` unchanged — only
   * the compile moved.
   *
   * The entry sits at the chat floor ({@link requireChatWrite}) like every source
   * operation; the WIPE is the one destructive effect on that surface and is priced
   * where it lands: the body requires dominion over the `.dev` Star this row will wipe
   * before it writes `wipeOnInstall`, because the Star's install path wipes on the
   * row's say-so with no check of its own, and a caller with the chat floor and no bit
   * exists (a node inviter may hold none). The decision rides the row as
   * `wipeOnInstall` — written once, immutable, never consumed-and-cleared — and the
   * acting principal is logged with it (the ADR-016 record a wipe owes). A Star pulling
   * this version from an older one wipes first; one already on it never asks (install
   * idempotent).
   *
   * `version` is content-addressed (`git.hashBlob` of the ontology source) so a
   * re-apply of unchanged source is a no-op and the Star-side Worker Loader cache
   * (`bundleId = galaxyId/version`) never serves a stale validator.
   */
  @mesh(requireChatWrite)
  async appendWorkspaceOntology({ wipe = false }: { wipe?: boolean } = {}): Promise<{ version: string }> {
    const { version } = await this.#readOntology();
    if (await this.#registryRow(version)) return { version }; // unchanged source → already applied
    if (wipe) {
      const devStar = `${this.lmz.instanceName}.dev`;
      const origin = this.#clientOrigin();
      const claims = origin?.claims ?? this.#claimsIfAny();
      if (!hasDominionOver(claims?.access, devStar)) {
        throw new Error(`Wipe refused: dominion over ${devStar} is required to wipe its data on install`);
      }
      debug('nebula.Galaxy.appendWorkspaceOntology').info('wipe on install decided', {
        version, devStar, actingToken: projectActingToken(claims!),
      });
    }
    const report = await this.#buildAndAnnounce({ ontology: { version, wipe } });
    if (!(report.ontology.ran && report.ontology.ok === true)) {
      const detail = stepFailed(report.ontology)
        ? (report.ontology as { tail: string }).tail
        : stepFailed(report.container)
          ? `build job failed: ${(report.container as { tail: string }).tail}`
          : 'the ontology step did not run';
      throw new Error(`Ontology compile failed:\n${detail}`);
    }
    const rowJson = await this.#ws.fs.readFile(wsPath(ROW_PATH), 'utf8');
    const row = JSON.parse(rowJson) as OntologyVersionRow;
    if (row.version !== version) {
      // A stale row file from an earlier cycle — never append it under this label:
      // the Star's Worker Loader cache keys on the version, and a content-address
      // disagreeing with its source serves a STALE validator forever.
      throw new Error(`Ontology row/version drift: expected '${version}', mount holds '${row.version}'`);
    }
    // The registry write IS a file write — the row was born as one (ROW_PATH); the
    // Apply gives it its durable name and the append-time stamp that orders the
    // directory. One write, no index to keep consistent with it.
    await this.#ws.fs.mkdir(wsPath(REGISTRY_DIR), { recursive: true });
    const stored: RegistryFile = { ...row, appliedAt: new Date().toISOString() };
    await this.#ws.fs.writeFile(wsPath(registryPath(row.version)), JSON.stringify(stored));
    debug('nebula.Galaxy.appendWorkspaceOntology').debug('appended', { version, wipeOnInstall: wipe });
    return { version };
  }

  // ─── HTTP surface: the built app's serve + the build-box dial-back ──

  /**
   * The Galaxy's HTTP surface, reached by the entrypoint's `/app/*` forward (GET/HEAD,
   * deliberately ungated — the bounding is the route's security property) and by the
   * in-container `computerd` daemon dialing back over the workspace proxy (`/ws`).
   * Everything else is 404 — the data plane rides the mesh, never HTTP.
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || request.headers.get('upgrade') === 'websocket') {
      return this.#buildBackend.handleFetch(request);
    }
    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
      return this.#serveBuiltApp(request, url);
    }
    return new Response('Not Found', { status: 404 });
  }

  /**
   * Serve the built app from this DO's own VFS — `/app/{u}.{g}.{s}/*`, where the star
   * segment selects WHICH dist: `.dev` = the working tree's current build (`/dist`,
   * the only tier pre-alpha); any other star is the published `dist-prod/` tier
   * (deferred — 404 until it exists). `serve.ts` owns the match-first/SPA/caching/
   * containment contract; the scope meta is injected here because only this side
   * knows the routed identity (never request-supplied — the wrong-Star footgun guard).
   */
  async #serveBuiltApp(request: Request, url: URL): Promise<Response> {
    const star = url.pathname.split('/')[2] ?? '';
    const segs = star.split('.');
    if (segs.length !== 3 || segs.some((s) => s.length === 0)) {
      return new Response('Not Found', { status: 404 });
    }
    if (segs[2] !== 'dev') {
      // The published tier (dist-prod/, one copy for every tenant star) is the
      // fast-follow's; answering 404 rather than serving the dev tree is the pin
      // that keeps "same homogeneous path" from meaning one-dist-for-all.
      return new Response('Not Found', { status: 404 });
    }
    const res = await serveApp(
      request,
      { directory: '/dist', not_found_handling: 'single-page-application', base: `/app/${star}/` },
      async (path) => {
        try {
          const stream = await this.#ws.fs.readFile(wsPath(path));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        } catch {
          return null; // any read failure is a miss — the SPA fallback owns it
        }
      },
    );
    if (res === null) return new Response('Not Found', { status: 404 });
    // Server-derived scope meta for the app shell (activeScope = the star, authScope =
    // the owning galaxy, plus the installed ontology version the client's data ops must
    // ride). Injected only into HTML serves; asset serves pass through untouched.
    if ((res.headers.get('Content-Type') ?? '').includes('text/html')) {
      const scopeMeta = JSON.stringify({
        activeScope: star,
        authScope: `${segs[0]}.${segs[1]}`,
        // The SAME derivation getCurrentOntology serves — one definition of "current",
        // so the version a client pins here is always one a Star can pull.
        ontologyVersion: (await this.#appliedHead())?.version ?? '',
      }).replace(/'/g, '&#39;'); // the meta rides a single-quoted attribute
      return new HTMLRewriter()
        .on('head', {
          element(el) {
            el.prepend(`<meta name="nebula-scope" content='${scopeMeta}'>`, { html: true });
          },
        })
        .transform(res);
    }
    return res;
  }


  // ─── The build box (ephemeral — fresh container per build) ──────────

  /**
   * One serialized build cycle — the loop's `build` TOOL. The promise-chain latch
   * queues overlapping builds on the one `ctx.container` (each caller gets its own
   * report; a predecessor's failure never poisons the chain).
   *
   * This is the overridable SEAM (a test double fakes the container here), so it owns
   * the build and nothing else — {@link #buildAndAnnounce} owns the preview decision
   * and the reload push, one level up, where a faked success announces exactly like a
   * real one. The seam's report carries a placeholder `preview` the layer above
   * overwrites.
   */
  protected build(opts: BuildJobOpts = {}): Promise<BuildReport> {
    const run = this.#buildChain.then(() => this.#buildOnce(opts));
    this.#buildChain = run.catch(() => { /* the next cycle starts clean */ });
    return run;
  }

  /**
   * A build plus its preview decision + announcement — **the only way callers should
   * build.** A build that refreshes the preview tells whoever asked for it (see
   * {@link announceBuildToRequester}), and that belongs to the EVENT (new `dist` in
   * the VFS) rather than to whichever caller produced it: the codegen loop's `build`
   * tool (through the `buildNow` entry), a direct `buildNow()` and the dev Apply all
   * go through here.
   *
   * When the caller passes no explicit ontology job, the Workspace's own pending
   * ontology change rides along (compiled for FEEDBACK — the row is written to the
   * mount but NOT appended to the registry; only {@link appendWorkspaceOntology}, the
   * Apply — chat floor, with its wipe bit decided at dominion — appends; the loop
   * cannot reach it, which is the secure-by-default D2 line).
   *
   * ⚠️ Deliberately ABOVE {@link build}, which is the test seam. Putting the push inside
   * `build()` made every faked build silently stop announcing — the suite caught it.
   */
  async #buildAndAnnounce(opts: BuildJobOpts & { preview?: boolean } = {}): Promise<BuildReport> {
    const jobOpts: BuildJobOpts = {
      ontology: opts.ontology ?? await this.#pendingOntology(),
    };
    // Marker: the cycle's start — "the warm precedes the build" is asserted on the order
    // of this marker and the warm's, within one Galaxy (`instanceName` is the discriminator
    // `testing.md` asks every marker to carry).
    debug('nebula.Galaxy.build').debug('cycle start', { instanceName: this.lmz.instanceName, ontology: Boolean(jobOpts.ontology) });
    const report = await this.build(jobOpts);
    let preview = decidePreview(report, opts.preview);
    // A clean report does not prove the dist ARRIVED: the vendor's post-exec pull
    // swallows its own failure (outcome resolves `status: "pending"`, applied 0, no
    // throw), and local materialize-mode change detection can miss vite's last writes
    // on the bracket — either way the serve would 404 behind a "clean build". The
    // DELIVERY fix is upstream: the job never empties `dist` (job.ts says why the pull
    // lost the empty-then-rewrite), and {@link #buildOnce} verifies arrival by digest
    // before its teardown. This gate is the
    // backstop that keeps the residual loss loud instead of a silent 404. Only where a
    // container actually ran — pool-workers' faked builds have no dist.
    if (preview.refreshed && this.ctx.container && !(await this.#distArrived(report.bundle.indexSha256))) {
      preview = {
        refreshed: false,
        why: 'the built dist did not arrive back from the container (sync pull incomplete) — retry the build',
      };
    }
    if (preview.refreshed) this.announceBuildToRequester();
    return { ...report, preview };
  }

  /**
   * The Workspace's pending ontology change, if any — the content-addressed version
   * (`git.hashBlob` of `src/ontology.d.ts`) when it is not yet in the registry index.
   * Rides every default build so the model gets compile feedback on an ontology it
   * just wrote; the wipe bit is always false here (wipe is the Apply's
   * dominion-checked decision, never the loop's).
   */
  async #pendingOntology(): Promise<{ version: string; wipe: boolean } | undefined> {
    let version: string;
    try {
      ({ version } = await this.#readOntology());
    } catch {
      return undefined; // no ontology file yet
    }
    return (await this.#registryRow(version)) ? undefined : { version, wipe: false };
  }

  /**
   * One ephemeral container cycle running the BUILD JOB (`node /build/job.cjs` — the
   * image-bundled `container/compiler/job.ts`): ontology compile, SFC type check and
   * `vite build`, every step reported, no step gating another. Then destroy — a fresh
   * container per build, so the stuck state is designed away rather than recovered
   * from. The backend owns start + readiness (health-probed, never `.running`-gated)
   * + the `monitor()` attach on every start (`WorkspaceContainerAPI.start` installs
   * it — the homework `containers.md` demands, done by the vendor). Liveness is
   * bounded twice: the backend's health probe at connect, and `timeoutMs` on the exec
   * itself.
   *
   * The job prints its steps on one `REPORT_MARKER` stdout line and exits 0 even when
   * steps failed (step outcomes ride the report) — so the exec's own failure IS the
   * `container` step: exit 1–127 means the job itself crashed; a kill (>= 128,
   * `cancelled`, or no exit event) is the box or the {@link BUILD_TIMEOUT_MS} budget,
   * and the tail SAYS so, because a model that reads "timed out" must not rebuild
   * unchanged until the turn deadline kills it.
   *
   * Teardown ordering: `handle.result()` resolves the post-exec sync bracket (dist is
   * normally in this DO's VFS at that moment), then — because a failed pull resolves
   * SILENTLY as pending, and the data is only recoverable while this container lives —
   * arrival is verified by digest against the job's report before the container is
   * destroyed. Destroying earlier fails the request with a capnweb 1006; the destroy
   * itself tolerates that same 1006 shape on the way out (the session it tears is the
   * one being discarded).
   */
  async #buildOnce(opts: BuildJobOpts): Promise<BuildReport> {
    const skipped = (why: string): BuildReport => ({
      container: { ran: true, ok: false, tail: why },
      ontology: { ran: false, why: 'the build job did not run' },
      typeCheck: { ran: false, checked: [], findings: [] },
      bundle: { ran: false, why: 'the build job did not run' },
      preview: PREVIEW_UNDECIDED,
    });
    if (!this.ctx.container) {
      return skipped('no build container attached (local test config)');
    }
    try {
      // `cwd` is the mount root: the workspace IS the app project. `version` +
      // `wipeOnInstall` are HOST-computed and passed IN via env, never read back out.
      const handle = await this.#ws.runtime.exec('node /build/job.cjs', {
        cwd: '/workspace',
        encoding: 'utf8',
        env: {
          ...BUILD_ENV,
          ...(opts.ontology
            ? { ONTOLOGY_VERSION: opts.ontology.version, WIPE_ON_INSTALL: opts.ontology.wipe ? '1' : '0' }
            : {}),
        },
        timeoutMs: BUILD_TIMEOUT_MS,
      });
      const result = await handle.result();
      if (result.status === 'completed' && result.exitCode === 0) {
        const line = result.stdout.split('\n').find((l: string) => l.startsWith(REPORT_MARKER));
        if (!line) {
          this.#destroyBuildContainer();
          return skipped(`job printed no report: ${tail(`${result.stderr}\n${result.stdout}`, 1000)}`);
        }
        const steps = JSON.parse(line.slice(REPORT_MARKER.length)) as {
          ontology: BuildReport['ontology'];
          typeCheck: BuildReport['typeCheck'];
          bundle: BuildReport['bundle'];
        };
        // Arrival is verified by DIGEST, not presence: the job reports the sha256 of the
        // `index.html` it wrote and the VFS must hold those bytes — a stale dist from an
        // earlier build passed a presence check on 2026-09-06 while the pull applied 0.
        // There is deliberately NO re-pull. Every exec's sync bracket PUSHES the VFS to
        // the container before it runs, so a no-op exec on a miss overwrote the container's
        // dist with the dist-less VFS and then found nothing (measured that day: `ls` on
        // the miss showed an empty directory). The miss is designed away in the job
        // (`--emptyOutDir=false` — job.ts says why); what remains is this record and the
        // preview gate in {@link #buildAndAnnounce} reporting a loss loudly.
        if (steps.bundle.ran && steps.bundle.ok === true) {
          if (await this.#distArrived(steps.bundle.indexSha256)) {
            await this.#pruneDist(steps.bundle.files);
          } else {
            debug('nebula.Galaxy.build').warn('dist did not arrive in the VFS after the bracket', {
              instanceName: this.lmz.instanceName, expected: steps.bundle.indexSha256,
              pulled: result.pulled, skipped: result.skipped, sync: result.sync,
            });
          }
        }
        this.#destroyBuildContainer();
        debug('nebula.Galaxy.build').info('job report', {
          instanceName: this.lmz.instanceName,
          ontology: steps.ontology.ran, findings: steps.typeCheck.findings.length,
          bundleOk: steps.bundle.ran && steps.bundle.ok === true,
          pushed: result.pushed, pulled: result.pulled, skipped: result.skipped, sync: result.sync,
          // "pending" = the pull attempt THREW and is over (misleading name; retried
          // only under the opt-in retryScheduler). "complete" + pulled 0 is ambiguous:
          // nothing-to-sync AND detection-missed-everything both look like it — which
          // is why arrival is verified by reading the file, not by this field.
          syncStatus: (result as { sync?: { status?: string; error?: string } }).sync?.status,
          syncError: (result as { sync?: { status?: string; error?: string } }).sync?.error,
        });
        return { container: { ran: true, ok: true }, ...steps, preview: PREVIEW_UNDECIDED };
      }
      this.#destroyBuildContainer();
      // The job exits 0 by design, so any other exit is the CONTAINER step's failure.
      // A kill (>= 128 / cancelled / no exit event) is most likely the build-timeout
      // budget — say so, or the model blind-retries the same code until the turn dies.
      const killed = result.exitCode >= 128 || result.exitCode === -1 || result.status === 'cancelled';
      const why = killed
        ? `build job killed (${result.status}, exit ${result.exitCode}) — likely the ${BUILD_TIMEOUT_MS} ms build timeout; retrying the same code will time out again`
        : `build job crashed (exit ${result.exitCode})`;
      return skipped(`${why}: ${tail(`${result.stderr}\n${result.stdout}`, 1000)}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The cloud-only stuck signature — EVIDENCE only (expect zero); never a recovery
      // trigger (the ephemeral model designs the state away).
      if (isStuckFlagError(e) || isStuckFlagText(message)) {
        debug('nebula.Galaxy.build').error('stuck-flag signature observed', { message });
      }
      this.#destroyBuildContainer();
      return skipped(message);
    }
  }

  /** Did the built `dist` land in this DO's VFS? The delivery check behind the
   *  pre-teardown arrival check in {@link #buildOnce} and the preview gate in
   *  {@link #buildAndAnnounce}. With `expectedSha256` (the job's digest of the
   *  `index.html` it wrote) the check is for THAT dist: a stale one from an earlier
   *  build reads as not arrived, which a presence check let through on 2026-09-06
   *  (a pull that applied nothing, and the previous build's dist answering for it). */
  async #distArrived(expectedSha256?: string): Promise<boolean> {
    try {
      // Read as text, the way every other host-side read of this VFS is: vite's index.html
      // is UTF-8, so re-encoding is byte-exact and the digest matches the job's.
      const text = await this.#ws.fs.readFile(wsPath('dist/index.html'), 'utf8');
      if (!expectedSha256) return true;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
      return hex === expectedSha256;
    } catch {
      return false;
    }
  }

  /** Make the VFS's `dist/` exactly what the job built. The job no longer lets vite empty
   *  the directory (job.ts says why), so a rebuild leaves the previous build's stale hashed
   *  assets behind; they are deleted HERE, host-side, after arrival is verified — where a
   *  deletion cannot be lost. No `files` in the report → nothing is pruned. */
  async #pruneDist(files: string[] | undefined): Promise<void> {
    if (!files || files.length === 0) return;
    const keep = new Set(files);
    const walk = async (rel: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory: boolean }>;
      try { entries = await this.#ws.fs.readdir(wsPath(rel ? `dist/${rel}` : 'dist')); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory) { await walk(r); continue; }
        if (!keep.has(r)) {
          try { await this.#ws.fs.rm(wsPath(`dist/${r}`), { force: true }); } catch { /* best effort */ }
        }
      }
    };
    await walk('');
  }

  /**
   * Construct the container backend + the Workspace over this DO's storage. Called at
   * `onStart` AND after every build teardown: the backend caches its capnweb session
   * handle, and the vendor's transport-failure detector does not match capnweb's
   * `"Peer closed WebSocket: 1006"` phrasing — so after a destroy the DEAD session
   * would stay cached and poison every later exec (verified 2026-08-28, build-box
   * limb 2; package feedback: their `TRANSPORT_PATTERNS` should cover it).
   * Reconstruction drops the cache; the storage-backed fs/git surfaces are stateless
   * over the same SQLite, so nothing else observes the swap.
   */
  #constructWorkspace(): void {
    this.#buildBackend = new CloudflareContainerBackend({
      // Lazy thunks all the way down: `WorkspaceContainerAPI`'s ctor throws where
      // `ctx.container` is absent (pool-workers), so nothing constructs it until the
      // backend actually connects for a build.
      container: () => ({
        getWorkspaceContainer: () => (this.#containerApi ??= new WorkspaceContainerAPI(this.ctx)),
      }),
      workspace: { binding: 'GALAXY', id: this.ctx.id.toString() },
    });
    this.#ws = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      git: createGitClient(),
      defaultGitIdentity: GIT_AUTHOR,
      backends: [this.#buildBackend],
    });
  }

  /** Fresh-container teardown — tolerate every failure shape (nothing running, the
   *  capnweb 1006 from tearing the session being discarded), then drop the cached
   *  transport (see {@link #constructWorkspace}).
   *
   *  ⚠️ `destroy()` returns a PROMISE, so the tolerance has to be a `.catch` on it —
   *  a bare `try/catch` around an un-awaited call catches only a synchronous throw and
   *  lets the rejection escape as an unhandled one, which is the very 1006 this is
   *  written to swallow. Deliberately not awaited: teardown must not extend the turn. */
  #destroyBuildContainer(): void {
    // The marker precedes the container guard, like the warm's: "exactly one teardown
    // follows a warm" is asserted on it in-lane, where there is no container to destroy.
    debug('nebula.Galaxy.teardown').info('build container destroyed', { instanceName: this.lmz.instanceName });
    try {
      void this.ctx.container?.destroy()?.catch(() => { /* tolerated — incl. the 1006 */ });
    } catch { /* a synchronous throw from destroy() itself */ }
    this.#containerApi = undefined;
    this.#constructWorkspace();
  }

  /**
   * The Workspace's raw fs — the container's side of the build seam, for TEST doubles:
   * a probe's faked `build()` writes the compiled row exactly where the real job does
   * (an fs write into the mount — never `writeSource`, which git-commits; the mount
   * does not). `protected` like the other seams; production code outside this class
   * never touches it.
   */
  protected workspaceFs(): Workspace['fs'] {
    return this.#ws.fs;
  }

  /**
   * Run one build cycle on demand — the loop's `build` tool reaches THIS entry (through
   * {@link LOOP_TOOL_ENTRIES}), and it is the manual-rebuild affordance (a participant
   * recovering from an infra failure without spending a model turn) and the
   * drive-verification surface (`harness/scenarios/build-box.ts` proves the
   * sequential/overlap/teardown contract through it — the model's own `build` calls are
   * not deterministically drivable). Same latch, same ephemeral cycle; the report
   * returns to the caller's `callAsync`. `preview` is the model's override
   * ({@link decidePreview}); the pending-ontology job rides by default (compiled for
   * feedback, never appended — the Apply appends).
   */
  @mesh(requireChatWrite)
  buildNow(opts: { preview?: boolean } = {}): Promise<BuildReport> {
    return this.#buildAndAnnounce({ preview: opts.preview });
  }

  /**
   * Tell the client that ASKED for this build that its preview is worth re-fetching —
   * the reply to their request, addressed by the `instanceName` already on the call
   * they made. Not a subscription: a build is somebody's request, and the answer goes
   * back to the asker like any other, so there is no registry to keep, no dead
   * subscriber to reap, and no way for the signal to reach nobody because a client
   * forgot to enrol (which is exactly how it broke — Studio never set the hook that
   * gated the old subscribe, so the fan-out ran to an empty list for a whole build).
   *
   * ⚠️ **Other participants are NOT signalled, deliberately.** In a shared session a
   * second viewer keeps the older UI until their own lazy path catches up — a
   * refocus re-request, or the next thing they ask for. Unchanged ontology means old
   * code is still data-correct, so running behind is a staleness cost, never a
   * correctness one; a fan-out would buy a faster refresh for the passive viewer at
   * the price of a registry that has to be enrolled in, maintained, and reaped.
   *
   * Both build paths reach here through {@link #buildAndAnnounce}: the codegen loop's
   * `build` tool (running under the POSTER's callContext, so `callChain[0]` is the
   * person whose message started the turn) and a direct `buildNow()`.
   */
  protected announceBuildToRequester(): void {
    // No client origin (a server-internal build, or a direct in-DO call with no mesh
    // context at all) — nobody asked, so nobody is told.
    const clientId = this.#clientOrigin()?.clientId;
    if (!clientId) return;
    this.deliverPreviewReady(this.lmz.instanceName!, clientId);
  }

  // ─── The codegen turn ───────────────────────────────────────────────

  /**
   * The post-commit observer — THE codegen trigger. A committed **human** `Message` on
   * the chat node starts a turn; nothing else does, and there is deliberately no
   * mesh-callable `chat` entry at all (an invocable husk would let a mere
   * passage-holder run the loop with no door). The DAG `write` check on the Message
   * commit is therefore the ONLY door: **chat participation is a uniform floor;
   * permissions above it vary** — anyone whose write lands may trigger, and a caller
   * whose write is refused at the DAG can never reach the model.
   *
   * The predicate is on KIND (the stamped actingToken — never `sub`, never the value):
   * an agent reply is itself a committed `Message`, so without the human-only gate
   * Nebula answers itself forever. SINGLE-FLIGHT: a human Message committed while a
   * generation is in flight fires nothing — the skipped message sits in the thread and
   * a participant re-prompts after completion (the pre-alpha floor; the two-stage
   * arrival pipeline is the fast-follow's refinement seam).
   *
   * The detached turn runs under the POSTER's own callContext (AsyncLocalStorage rides
   * the floating promise), so the agent reply commits with the triggering human's
   * authority and Nebula stamped as the actor — the participant model, structurally.
   */
  #onChatCommitted(mutations: Map<string, Snapshot>): void {
    for (const [resourceId, snap] of mutations) {
      if (snap.meta.typeName !== 'Message' || snap.meta.nodeId !== CHAT_NODE_ID) continue;
      if (deriveKind(snap.meta.actingToken) !== 'human') continue;
      if (this.#turnInFlight) {
        debug('nebula.Galaxy.trigger').info('skipped: generation in flight (single-flight)', { resourceId });
        continue;
      }
      const content = (snap.value as { content?: string }).content ?? '';
      debug('nebula.Galaxy.trigger').debug('human Message committed — turn starts', { resourceId });
      void this.runTriggeredTurn(resourceId, content).catch((e) => {
        debug('nebula.Galaxy.trigger').error('triggered turn threw', {
          resourceId, error: e instanceof Error ? e.message : String(e),
        });
      });
    }
  }

  /**
   * One triggered turn: single-flight latch + generation deadline around the turn body.
   * `protected`, NOT `@mesh` — reachable only from the commit trigger (and test
   * probes); the absence of `@mesh` is the not-remotely-callable boundary.
   *
   * ⚠️ Run with `wrangler dev` — the turn calls `env.AI.run` (or the REST lane).
   */
  protected async runTriggeredTurn(userMessageId: string, content: string): Promise<void> {
    // SINGLE-FLIGHT: one generation at a time. The flag is in-memory BY DESIGN — a
    // post-deadline or evicted turn clears it (eviction wipes the isolate), so a fresh
    // message always triggers a NEW generation rather than wedging behind a hung one.
    if (this.#turnInFlight) return;
    this.#turnInFlight = true;
    // RESIDENCY: the turn runs DETACHED (a floating promise off the commit), so no
    // in-flight request pins the Galaxy — what holds it is the turn's own OUTBOUND
    // I/O: every long span is a network await (the `env.AI` fetch, the build's capnweb
    // session), and an open outbound connection keeps a DO resident (measured, ≤15 min
    // hazard-bounded). A `setTimeout` HEARTBEAT was designed here and REMOVED on
    // deployed evidence (experiments/residency-hold, 2026-08-28): a detached timer
    // await was evicted at ~70 s WITH the 5 s re-arming heartbeat running — a timer
    // does not hold an isolate, so the heartbeat insured nothing and billed wall-clock.
    // An eviction mid-turn is covered as designed: input is durable before the LLM
    // runs, the in-memory latch dies with the isolate, and a fresh message starts a
    // fresh generation.
    // The GENERATION DEADLINE stays: past it the latch releases and the turn surfaces
    // as failed server-side (the client's Phase-6 idle-timeout owns the UX), so a hung
    // await (which its own socket may keep resident!) cannot wedge the loop until
    // force-eviction.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#chatTurn(userMessageId, content),
        new Promise<void>((resolve) => {
          deadlineTimer = setTimeout(() => {
            debug('nebula.Galaxy.trigger').error('turn failed: generation exceeded the deadline', {
              userMessageId, deadlineMs: this.generationDeadlineMs,
            });
            resolve();
          }, this.generationDeadlineMs);
        }),
      ]);
    } finally {
      this.#turnInFlight = false;
      // A completed turn must not leave the deadline armed.
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  /** The turn body the trigger races against the generation deadline: ONE assembly with
   *  every layer and the full tool set, the model deciding whether to act. */
  async #chatTurn(userMessageId: string, message: string): Promise<void> {
    // Mint the agent Message id up front (Galaxy-minted — the human message's id is
    // client-minted); stream progress transiently to chat subscribers; commit ONE
    // durable Message at the end, `replyTo`-linked to the triggering human Message.
    // Minted first so the heartbeat below has an id from the first ms.
    const agentMessageId = crypto.randomUUID();

    // ⚠️ ONE heartbeat for the WHOLE turn (`turn-heartbeat.ts`), not one per await. Every
    // model call in a turn is whole-response and therefore silent — each codegen round —
    // and a container build emits nothing until it exits. Wrapping the loop awaits alone
    // once left the turn's opening classifier call (since deleted) uncovered, and the first
    // live drive painted `failed` over a healthy turn before codegen had even started.
    // The turn IS the unit of liveness. Bounded by the same generation deadline the trigger
    // races this body against, so a hung call still fails.
    const deadlineAt = Date.now() + this.generationDeadlineMs;
    await withHeartbeat(
      () => this.#chatTurnBody(userMessageId, message, agentMessageId),
      () => this.streamProgress(DEFAULT_CHAT_ID, agentMessageId, '', CHAT_NODE_ID, userMessageId),
      { intervalMs: TURN_HEARTBEAT_MS, deadlineAt },
    );
  }

  /**
   * The turn body proper — ONE assembly, every layer, the full tool set; the model
   * decides whether to act. A question ends the loop `no-tool-calls` with the reply as
   * the answer, and a question that turns out to need a one-line fix gets the fix, under
   * the poster's authority and named in the reply. (The former answer fork — a
   * classifier-chosen prompt with no tools — is deleted: the split was never the
   * classifier's to make, and a fork without tools could not record a stated convention.)
   *
   * The container WARM is structural: the first `write_file` or `edit_file` of the turn
   * is a certain predictor of a coming `build`, so it fires the warm and hides all but
   * round two's short generation. One latch per turn, closure-local and shared with the
   * write deps, so a turn warms at most once. (A small classifier once fired the same
   * latch earlier as a hint; measured on five real turns, 2026-09-05/06, every first-write
   * to build interval cleared the 3.2 s cold start on its own, and the call was deleted.)
   *
   * ⚠️ A warm STARTS a container, so every turn owes a teardown on EVERY exit — a turn can
   * end without ever calling `build` (`no-tool-calls`, the round cap, a `mark_complete`
   * with no build), and `#buildOnce` is the only other place that destroys. Without the
   * `finally` those turns leak a live container against `max_instances`, breaking the
   * invariant the ephemeral design rests on: a container never outlives its build.
   * Destroy is idempotent, so the common path (build ran, already torn down) pays a no-op.
   */
  async #chatTurnBody(userMessageId: string, message: string, agentMessageId: string): Promise<void> {
    const warm = this.#turnWarmLatch();
    try {
      await this.#codegenTurn(message, agentMessageId, userMessageId, warm);
    } finally {
      this.#destroyBuildContainer();
    }
  }

  /** One turn's warm latch: `fire` starts the box at most once — the first write of the
   *  turn fires it, later writes are no-ops. Closure-local by design — the turn holds it,
   *  `#turnInFlight` stays the only instance field. */
  #turnWarmLatch(): { fire(): void } {
    let fired = false;
    return {
      fire: () => {
        if (fired) return;
        fired = true;
        this.warmBuildBox();
      },
    };
  }

  /** The turn's body — the loop, then the durable reply. `warm` is the turn's latch,
   *  fired by the first write. */
  async #codegenTurn(
    message: string, agentMessageId: string, userMessageId: string,
    warm: { fire(): void },
  ): Promise<void> {
    // The tree the turn READ — captured BEFORE the loop writes (the codegen record's
    // `sourceCommit`; git is local to this DO's VFS, so the ref recovers the bytes).
    let sourceCommit: string | undefined;
    try { sourceCommit = (await this.#ws.git.log({ dir: WS_ROOT, depth: 1 }))[0]?.oid; } catch { /* fresh repo */ }
    const result = await this.runCodegenTurn(
      message, DEFAULT_LOOP_CONFIG,
      (step) => this.streamProgress(DEFAULT_CHAT_ID, agentMessageId, step, CHAT_NODE_ID, userMessageId),
      {
        // The triggering Message is excluded from the history bundle — the request bundle
        // carries it, once.
        triggeringMessageId: userMessageId,
        // The structural warm: the first write of the turn.
        onFirstWrite: () => warm.fire(),
      },
    );
    debug('nebula.Galaxy.chat').debug('loop', {
      instanceName: this.lmz.instanceName, stop: result.stop,
      rounds: result.rounds, applied: result.appliedPaths.length,
    });

    // The reply is the model's own final text on EVERY stop — what the person reads, and
    // what the history bundle carries as "the agent's reply" — with the fixed strings only
    // when it is empty (a `mark_complete` with no words, a bound that tripped mid-sentence).
    const text = result.output.trim();
    const fallback = result.stop === 'complete'
      ? (result.appliedPaths.length > 0 ? 'Updated the preview.' : 'Done — no changes.')
      : result.stop === 'no-tool-calls'
        ? 'See the thought process.'
        : result.stop === 'build-unavailable'
          ? 'Your changes are saved, but the build box could not run just now, so the preview is unchanged. Ask me to build again in a moment.'
          : result.stop === 'error'
            ? `I couldn't finish — ${result.detail}. Try again in a moment.`
            : "I couldn't finish cleanly — see the thought process.";
    const reply = text || fallback;

    // The tool-calling loop carries the generated code in `write_file` *args*, not the
    // model's reply text — so surface the final content of each written file here, else the
    // thought panel loses the code. Last write wins per path (self-correction rounds
    // rewrite the same file); an `edit_file` shows the replacement it landed.
    const written = new Map<string, string>();
    for (const tc of result.toolCalls) {
      const a = tc.args as { path?: string; content?: string; replacement?: string } | undefined;
      if (tc.name === 'write_file' && a?.path && typeof a.content === 'string') {
        written.set(a.path, a.content);
      } else if (tc.name === 'edit_file' && a?.path && typeof a.replacement === 'string' && !tc.error) {
        written.set(`${a.path} (edit)`, a.replacement);
      }
    }
    const files = [...new Set(result.appliedPaths)];
    // The thought panel's check line, written from the LAST build's typeCheck (the
    // per-write gate is gone — a write does no work at all).
    const check = result.lastBuild
      ? (result.lastBuild.typeCheck.findings.length === 0
          ? `checked clean (${result.lastBuild.typeCheck.checked.join(', ') || 'nothing to check'})`
          : `type findings:\n${result.lastBuild.typeCheck.findings.join('\n')}`)
      : 'no build this turn';
    const parts: string[] = [];
    if (result.reasoning) parts.push(`🧠 Reasoning\n\n${result.reasoning}`);
    if (result.output) parts.push(`📄 ${result.output}`);
    for (const [path, content] of written) parts.push(`📝 ${path}\n\`\`\`\n${content}\n\`\`\``);
    parts.push(`🔧 ${result.detail ?? result.stop}\nFiles: ${files.join(', ') || '(none)'} — ${check}`);
    const thought = parts.join('\n\n— — —\n\n');
    // The folded codegen corpus record (the deleted Turns table's successor — the
    // field-by-field pin is nebula-studio-self-improvement.md § The folded shape;
    // `build` replaced the per-write `gate` when the compilers left the Worker —
    // per-FILE credit assignment survives at build granularity via `checked`).
    // `scaffold` stays absent until the scaffold store exists (Part B).
    const codegen: Record<string, unknown> = {
      model: STUDIO_MODEL,
      ...(sourceCommit ? { sourceCommit } : {}),
      rounds: result.rounds,
      stop: result.stop,
      appliedPaths: [...new Set(result.appliedPaths)],
      ...(result.lastBuild
        ? { build: { checked: result.lastBuild.typeCheck.checked, findings: result.lastBuild.typeCheck.findings } }
        : {}),
      toolCalls: result.toolCalls,
    };
    // The DURABLE agent Message — the source of truth, fanned to every chat subscriber
    // via the query rerun (history-restore + multi-participant + disconnect-recovery).
    // The client reconciles its ephemeral stream against it by id.
    await this.commitAgentMessage(DEFAULT_CHAT_ID, agentMessageId, reply, CHAT_NODE_ID, userMessageId, {
      thought,
      codegen,
    });
    // (The reload push is NOT fired here — `build()` announces its own success, so a
    // manual `buildNow()` refreshes the preview too. The retired ontology-install
    // trigger double-fired: the version label is baked at build, so an install without
    // a build had nothing new to fetch.)
  }

  /**
   * Speculatively start the build container — from the turn's latch, so at most once a
   * turn, on the first write (the structural warm). The cold start + mount then hides
   * behind the generation and the build tool's exec finds the box up. Fire-and-forget: a warm
   * failure costs nothing (the exec's own connect starts it) and must never delay the
   * model. A no-container environment (pool-workers) is a silent no-op. `protected` so
   * the drive log can be asserted — one warm per turn.
   */
  protected warmBuildBox(): void {
    // The marker precedes the container guard ON PURPOSE: "exactly one warm per turn" is
    // asserted on this marker's count, in-lane included (where ctx.container is absent
    // and the start below is a no-op).
    debug('nebula.Galaxy.warm').info('container warm fired', { instanceName: this.lmz.instanceName });
    if (!this.ctx.container) return;
    try {
      // enableInternet=false mirrors the backend's own start (its default egress is
      // `{ mode: 'none' }` in 0.2.x — deps are fully baked, nothing needs the net).
      void (this.#containerApi ??= new WorkspaceContainerAPI(this.ctx)).start({}, false).catch((e: unknown) => {
        debug('nebula.Galaxy.warm').warn('warm start failed (non-fatal — exec will retry)', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    } catch (e) {
      debug('nebula.Galaxy.warm').warn('warm start threw (non-fatal)', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Tell the client that asked for a build its preview is ready, by direct delivery — a
   * one-way mesh call to the client's Gateway addressed by its stable `instanceName`
   * (`clientId`), so a WS reconnect doesn't strand it. The build reply is its only
   * caller ({@link announceBuildToRequester}): the former initial-load cue was deleted,
   * because `dist/` serves Galaxy-direct from this DO's VFS and the Studio sets the
   * iframe source before connecting, so there was nothing to warm and nothing to
   * announce. NO `newChain` — the originating client's `originAuth` must ride through so
   * the Gateway's aud check passes; fire-and-forget + try/catch (a delivery failure must
   * never break the dev loop).
   */
  protected deliverPreviewReady(scope: string, clientId: string): void {
    try {
      this.lmz.call(CLIENT_GATEWAY_BINDING, clientId, this.ctn<NebulaClient>().handlePreviewReady(scope));
    } catch (e) {
      debug('nebula.Galaxy.deliverPreviewReady').warn('preview-ready delivery failed (non-fatal)', { error: e });
    }
  }

  // ─── Resource data-plane surface (the chat Chat/Message Resources) ─────────
  //
  // `@mesh()` — no guard on the decorator: chat participants are non-admin but
  // DAG-granted. `onBeforeCall` (NebulaDO base) enforces passage into `{u}.{g}`; the
  // per-op DAG read/write check lives inside the data-plane (Resources/DagTree), exactly
  // as on Star. (The source entries above put that same chat-node `write` check ON the
  // decorator — `requireChatWrite` — because they do no per-op check of their own.)
  // Every op is version-gated against the INSTALLED chat ontology — `OntologyStaleError`
  // on a mismatch, exactly Star's shapes (transaction returns it as a VALUE; read
  // throws; subscribe pushes).

  /**
   * Idempotently seed the pre-alpha default `Chat` at the fixed {@link DEFAULT_CHAT_ID}
   * under {@link CHAT_NODE_ID}. Called at the start of {@link chat} (an authed admin
   * context, so the create's `write` check passes via the CONFINED scope-admin bypass —
   * `requirePermission` grants it only to an admin whose `authScope` covers THIS host)
   * and exposed as an admin-gated entry so a client can guarantee the chat exists
   * before subscribing `Message where chat == DEFAULT_CHAT_ID`. A second call is a
   * no-op (the capability's create-if-absent). Internal `this.ensureChat()` calls
   * bypass the decorator (direct method call).
   */
  @mesh(requireDominionHere)
  async ensureChat(): Promise<void> {
    await this.#dataPlane.ensureResource(DEFAULT_CHAT_ID, 'Chat', CHAT_NODE_ID, { title: 'Studio chat' });
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
  protected streamProgress(
    chatId: string, messageId: string, progress: string, nodeId: string, replyTo: string,
  ): void {
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: chatId };
    const targets = this.queryTargets(query, nodeId);
    // Log identifiers/counts only — never the progress body.
    debug('nebula.Galaxy.stream').debug('chunk', { messageId, targets: targets.length, len: progress.length });
    if (targets.length === 0) return;
    // `replyTo` ATTRIBUTES the chunk: it broadcasts to every chat subscriber (a shared
    // thread — seeing someone else's reply appear is the product working), so without it
    // a recipient cannot tell whose turn is alive, and every client treats every chunk as
    // liveness for its OWN turn. That is a hang: under single-flight a message posted
    // during a generation is skipped and never answered, yet its poster's idle window is
    // re-armed by the running turn's chunks and never fails.
    this.broadcast(targets, this.ctn<NebulaClient>().handleStreamChunk(messageId, progress, replyTo));
  }

  /**
   * Commit the DURABLE agent `Message` at completion — ONE create at `messageId`, which
   * the query rerun fans to every chat subscriber (and the client reconciles against its
   * ephemeral stream by id). Create-if-absent via the capability (a fresh Galaxy-minted
   * id → a create); server-internal, no client delivery.
   *
   * Attribution: the reply runs under the TRIGGERING HUMAN's `callContext`, so the
   * subject `sub` stamps automatically — and Nebula is appended as the ACTOR via the
   * server-supplied write-option (`{ sub: NEBULA_SUB, profileId: NEBULA_SUB }` — the
   * actor-`profileId` stamp is ALWAYS emitted, so a Nebula message never triggers a
   * `sub`→`profileId` Registry lookup). No `role`/`author` is written — display derives
   * only from the stamped `meta.actingToken`.
   *
   * `replyTo` is REQUIRED here (the corpus needs prompt→reply linkage — the folded-shape
   * pin) though optional in the ontology TYPE (a human message has none); `codegen` is
   * the folded corpus record, present on every codegen-path reply.
   */
  protected async commitAgentMessage(
    chatId: string, messageId: string, content: string, nodeId: string,
    replyTo: string,
    opts: { thought?: string; codegen?: Record<string, unknown> } = {},
  ): Promise<void> {
    const value: Record<string, unknown> = { chat: chatId, content, status: 'complete', replyTo };
    if (opts.thought !== undefined) value.thought = opts.thought;
    if (opts.codegen !== undefined) value.codegen = opts.codegen;
    debug('nebula.Galaxy.stream').debug('commit', { messageId, len: content.length });
    // The turn finishes under the authority it STARTED with: the door admitted the post,
    // and that verdict covers the reply — a grant revoked mid-turn does not refuse it.
    await this.#dataPlane.ensureResource(messageId, 'Message', nodeId, value, {
      actor: { sub: NEBULA_SUB, profileId: NEBULA_SUB }, pinnedAtPost: true,
    });
  }

  /** Handler 1: validate the requested ontology version against the INSTALLED chat
   *  ontology, then RETURN the transaction result — the framework fires it back to the
   *  caller's `callAsync`. On a stale version RETURN the `OntologyStaleError` as a VALUE
   *  (resolve, not reject — Star's asymmetry): the client's submit wrapper maps it to the
   *  engine's `{ontologyStale}` signal. ⚠️ No `actor` parameter exists here, deliberately
   *  — the trust fence: only server-internal `commitAgentMessage` supplies one, so a
   *  client cannot forge `act: { sub: NEBULA_SUB }`. */
  @mesh()
  transaction(ontologyVersion: string, newETag: string, ops: Record<string, OperationDescriptor>): Promise<TransactionResult> | OntologyStaleError {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('transaction requires a client origin with instanceName in callChain[0]');
    }
    if (!this.#isCurrentChatVersion(ontologyVersion)) {
      return new OntologyStaleError(ontologyVersion, this.#ensureChatFacet().row.version);
    }
    return this.#dataPlane.doTransaction(newETag, ops, clientId);
  }

  /** Handler 1: validate the requested ontology version, then RETURN the read value. On a
   *  stale version THROW `OntologyStaleError` (→ error RESULT → the client's `callAsync`
   *  rejects → its `.catch` fires `onShouldRefreshUI`). */
  @mesh()
  read(ontologyVersion: string, resourceId: string): Snapshot | null {
    if (!this.#isCurrentChatVersion(ontologyVersion)) {
      throw new OntologyStaleError(ontologyVersion, this.#ensureChatFacet().row.version);
    }
    return this.#dataPlane.doRead(resourceId);
  }

  /** Handler 1: dispatch a single-resource subscribe into the capability (stale → the
   *  error is PUSHED on the resource channel, Star's shape). */
  @mesh()
  subscribe(ontologyVersion: string, resourceType: string, resourceId: string): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('subscribe requires a client origin with instanceName in callChain[0]');
    }
    const subscriberBinding = this.lmz.callContext.callChain.at(-1)?.bindingName;
    if (!subscriberBinding) {
      throw new Error('subscribe requires a gateway in callChain.at(-1)');
    }
    if (!this.#isCurrentChatVersion(ontologyVersion)) {
      this.lmz.call(CLIENT_GATEWAY_BINDING, clientId,
        this.ctn<NebulaClient>().handleResourceUpdate(resourceType, resourceId,
          new OntologyStaleError(ontologyVersion, this.#ensureChatFacet().row.version)));
      return;
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
    this.broadcast(targets, remote, { onResult: this.ctn<Galaxy>().onBroadcastResult(resourceId) });
  }

  /** Per-target broadcast result handler — drop a subscriber whose Gateway reported
   *  it disconnected (`ClientDisconnectedError`). `@mesh()` for the tier-worker path, which
   *  `NebulaDO.broadcast` pins that path off today (TEMP). */
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
    this.broadcast(targets, remote, { onResult: this.ctn<Galaxy>().onQueryBroadcastResult(queryHash) });
  }

  /** Host-side fanout for a subscriber-list roster push — the distinct-by-`sub` roster to a
   *  query's WATCHERS. Dead-WATCHER cleanup uses the DEDICATED
   *  {@link onQuerySubscriberListBroadcastResult} (watcher table, NOT `QuerySubscribers`). */
  #broadcastRosterUpdate(queryHash: string, roster: SubscriberEntry[], targets: BroadcastTarget[]): void {
    const remote = this.ctn<NebulaClient>().handleQuerySubscribersUpdate(queryHash, roster);
    this.broadcast(targets, remote, { onResult: this.ctn<Galaxy>().onQuerySubscriberListBroadcastResult(queryHash) });
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

  /** Mount (or reuse) the tool-args typia validator facet — the COMMITTED precompiled
   *  module (`validator-seeds.ts`, generated from `TOOL_ARGS_TYPES`; ADR-001: TS types
   *  are the schema — the generator compiled them, the Worker never does). Shared
   *  bundle id across tenants (the tool surface is not tenant data). */
  #ensureToolArgsFacet(): ParserValidator {
    if (!this.#toolArgsFacet) {
      this.#toolArgsFacet = getParserValidatorFacet(
        this.ctx,
        this.env.LOADER,
        TOOL_ARGS_BUNDLE_ID,
        () => TOOL_ARGS_VALIDATOR_MODULE,
      );
    }
    return this.#toolArgsFacet;
  }

  /** Trust boundary: typia-validate the untrusted model's tool-call args (shape
   *  only — path *safety* is {@link assertModelPath}, enforced in the entries), then
   *  refuse any key the tool does not declare, BY NAME. The typia facet is
   *  `createValidate`, which ignores excess keys, so without this a stale
   *  `{ "publish": true }` would be silently dropped — the shape the `preview` rename
   *  exists to prevent (parser-validator feedback: the tool-args facet wants a mode
   *  that refuses excess keys; tracked in the backlog). */
  async #validateToolArgs(
    toolName: string,
    args: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const typeName = TOOL_ARG_TYPE[toolName];
    if (!typeName) return { ok: false, error: `unknown tool '${toolName}'` };
    const res = await this.#ensureToolArgsFacet().parse(args, typeName);
    if (!res.valid) {
      const detail = res.errors.map((e) => `${e.path}: expected ${e.expected}`).join('; ');
      return { ok: false, error: `invalid ${toolName} args — ${detail}` };
    }
    const unknown = unknownToolArgKeys(toolName, args);
    if (unknown.length > 0) {
      return { ok: false, error: `unknown key${unknown.length > 1 ? 's' : ''} on ${toolName} args: ${unknown.map((k) => `'${k}'`).join(', ')}` };
    }
    return { ok: true };
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
  protected async callModel(
    messages: ChatMessage[], params: ModelParams, onDelta?: (text: string) => void,
  ): Promise<unknown> {
    return this.runModel(STUDIO_MODEL, {
      messages,
      tools: CODEGEN_TOOLS,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    }, onDelta);
  }

  /**
   * The one model-transport router every generation path shares — the codegen loop via
   * {@link callModel} — so the REST-vs-binding split lives once. `protected` so a probe
   * overriding IT scripts every path at once.
   */
  protected async runModel(
    model: string, body: Record<string, unknown>, onDelta?: (text: string) => void,
  ): Promise<unknown> {
    // With a delta sink the call STREAMS — `stream: true` on either lane yields the same SSE bytes
    // — and `assembleStream` hands the text out live while rebuilding the whole-response shape the
    // caller parses. Without one nothing changes: the call stays a whole response.
    if (onDelta) body = { ...body, stream: true };
    // WORKERS_AI_TOKEN / CLOUDFLARE_ACCOUNT_ID / CF_AI_GATEWAY are runtime env (`.dev.vars`
    // / `wrangler secret`), not committed wrangler vars, so they're absent from the
    // generated `Env` — widen at the read (packaging.md).
    const env = this.env as Env & { WORKERS_AI_TOKEN?: string; CLOUDFLARE_ACCOUNT_ID?: string; CF_AI_GATEWAY?: string };
    if (this.modelLane() === 'rest') return this.#callModelRest(env, env.WORKERS_AI_TOKEN!, model, body, onDelta);
    // The model-catalog types don't cover every @cf id; run() is treated loosely. The
    // options carry the session-affinity header (`extraHeaders` is the binding's own knob).
    const out = await this.aiBinding().run(model, body, { extraHeaders: this.modelCallHeaders() });
    if (onDelta && out instanceof ReadableStream) return assembleStream(out, onDelta);
    return out;
  }

  /** Which transport {@link runModel} takes — REST when a `WORKERS_AI_TOKEN` is present
   *  (the hosted lane), else the `env.AI` binding. `protected` so a probe can pin either
   *  lane and assert what it sends. */
  protected modelLane(): 'rest' | 'binding' {
    return (this.env as Env & { WORKERS_AI_TOKEN?: string }).WORKERS_AI_TOKEN ? 'rest' : 'binding';
  }

  /** The `env.AI` binding — a seam so a probe can capture the options the binding lane
   *  passes without a real inference. */
  protected aiBinding(): { run(model: string, body: unknown, options?: unknown): Promise<unknown> } {
    return this.env.AI as any;
  }

  /**
   * The headers BOTH lanes send on every inference: `x-session-affinity`, keyed
   * `{u}.{g}:main` — the Galaxy's own name plus a segment naming the conversation
   * (`main`, until threads land and each thread keys its own). Workers AI caches the
   * prompt prefix by default but only when a request routes to the model instance
   * holding the cached tensors, which is what this header asks for; the system layer is
   * ordered stable-first for the same reason (`assembleCodegenPrompt`).
   */
  protected modelCallHeaders(): Record<string, string> {
    return { 'x-session-affinity': `${this.lmz.instanceName ?? this.ctx.id.name}:main` };
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
    model: string,
    body: unknown,
    onDelta?: (text: string) => void,
  ): Promise<unknown> {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) throw new Error('Workers AI REST path needs CLOUDFLARE_ACCOUNT_ID');
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const headers = workersAiRestHeaders({ token, gateway: env.CF_AI_GATEWAY, extra: this.modelCallHeaders() });
    // A refused call is retried twice with backoff (`Retry-After` when the service says,
    // else 5 s then 15 s): Workers AI answers 429 under the sweep's call volume, and on
    // 2026-09-06 one 429 ended a turn with no reply while the client waited on nothing.
    // Past the retries it fails into the loop's controlled error, which still replies.
    let resp: Response;
    for (let attempt = 0; ; attempt++) {
      resp = await this.restFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (resp.ok || attempt >= 2 || !(resp.status === 429 || resp.status >= 500)) break;
      await resp.body?.cancel().catch(() => { /* nothing to free */ });
      const retryAfter = Number(resp.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 30) * 1000 : [5_000, 15_000][attempt]!;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!resp.ok) {
      // The provider's own message rides the error, bounded: a 400 is not retried and only
      // its body says why (2026-09-06: one ended a five-round turn with no clue in the log).
      const body = await resp.text().catch(() => '');
      throw new Error(`Workers AI REST ${resp.status} at ${new URL(url).pathname}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    if (onDelta && resp.body) return assembleStream(resp.body, onDelta);
    return unwrapWorkersAiRest(await resp.json());
  }

  /** The REST lane's transport, a seam like {@link Galaxy.aiBinding}: a probe captures the
   *  headers `#callModelRest` actually sends, so the affinity header is asserted at the call
   *  site rather than only on the pure header map. */
  protected restFetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }

  /**
   * Drive one bounded, self-correcting codegen turn: walk the guidance tree into the
   * system layer, stable first — the tool contract, the platform layer (the embed), the
   * app's own `AGENTS.md` when the Workspace holds one, the chat history when there is
   * any — put the ontology and the current source in the user message with the request,
   * run {@link runCodegenLoop}, and return the loop result. Every turn reads the Galaxy
   * file at turn start, which is what makes an edit take effect on the next message with
   * nothing to restart; the platform layer is an import, so the walk costs one VFS read.
   * The former turn-recorder side table is DELETED — the corpus folds into the agent
   * `Message`'s `codegen` value object.
   *
   * `protected` (not `@mesh`): an internal capability, not a remote API. The test
   * harness reaches it through a test-only `@mesh` entry on a subclass.
   */
  protected async runCodegenTurn(
    userRequest: string,
    config: CodegenLoopConfig = DEFAULT_LOOP_CONFIG,
    onProgress?: (step: string) => void,
    opts: {
      triggeringMessageId?: string;
      /** Called before the turn's FIRST write (`write_file` or `edit_file`) — the
       *  structural container warm (`#chatTurnBody`). */
      onFirstWrite?: () => void;
    } = {},
  ): Promise<LoopResult> {
    let currentSource = '';
    try { currentSource = await this.#ws.fs.readFile(wsPath('src/App.vue'), 'utf8'); } catch { /* none yet */ }
    let ontologyDts: string | undefined;
    try { ontologyDts = await this.#ws.fs.readFile(wsPath(ONTOLOGY_PATH), 'utf8'); } catch { /* none yet */ }
    // The Galaxy layer — absent on a Workspace seeded before the layer existed, and then
    // the turn simply runs without it.
    let galaxyAgents: string | undefined;
    try { galaxyAgents = await this.#ws.fs.readFile(wsPath(GALAXY_AGENTS_PATH), 'utf8'); } catch { /* none */ }
    const { bundle: history, posterLabel } = this.#historyBundle(opts.triggeringMessageId);

    const initial = assembleCodegenPrompt({
      systemBundles: [
        TOOL_CONTRACT,
        PLATFORM_AGENTS_MD,
        ...(galaxyAgents !== undefined ? [`${GALAXY_LAYER_PREFACE}\n\n${galaxyAgents}`] : []),
        ...(history ? [history] : []),
      ],
      ontologyDts,
      userRequest,
      currentSource,
      posterLabel,
    });
    // No per-await heartbeat here: liveness is a property of the TURN, and `#chatTurn` beats
    // around the whole body — every round here is a silent model call.
    // Live deltas ride the same `onProgress` seam as the coarse steps — the client appends
    // either — so a round's thinking streams batch by batch instead of landing whole when the
    // model returns. `onDelta` on the deps tells the loop not to re-emit that thinking.
    const onDelta = onProgress ? (text: string) => onProgress(text) : undefined;
    const tools = this.loopToolDeps();
    if (opts.onFirstWrite) {
      // The write deps fire the warm before they write — the latch makes the second and
      // later calls no-ops, so wrapping both is what "the first write" means.
      const fire = opts.onFirstWrite;
      const { write_file, edit_file } = tools;
      tools.write_file = (path, content) => { fire(); return write_file(path, content); };
      tools.edit_file = (path, anchor, replacement) => { fire(); return edit_file(path, anchor, replacement); };
    }
    const deps: CodegenLoopDeps = {
      callModel: (m, p) => this.callModel(m, p, onDelta),
      ...(onDelta ? { onDelta } : {}),
      tools,
      validateToolArgs: (n, a) => this.#validateToolArgs(n, a),
      onProgress,
    };
    return runCodegenLoop(initial, deps, config);
  }

  /**
   * The entry-reaching tool deps, built from {@link LOOP_TOOL_ENTRIES}: one dep per tool
   * the table lists, each reaching only an entry the table names for it — `via` is typed
   * against the table, so `via('build', 'writeSource')` does not compile. The loop's
   * `this.writeSource()` / `this.buildNow()` are the ordinary calls they look like: a
   * turn runs under the poster's own `callContext`, whose Message already passed the
   * chat floor at the door, and a guard on the decorator does not run on an in-process
   * call. `protected` so a test probe can assert the keys are exactly the table's.
   */
  protected loopToolDeps(): LoopToolDeps {
    type Entries = typeof LOOP_TOOL_ENTRIES;
    const via = <T extends LoopToolName, E extends Entries[T][number]>(_tool: T, entry: E): Galaxy[E] =>
      (this[entry] as (...a: unknown[]) => unknown).bind(this) as Galaxy[E];
    const factories: { [K in LoopToolName]: () => LoopToolDeps[K] } = {
      // Resolves in ONE order: a `.platform/` path answers from the embed (or names the
      // missing file), `.universe/` answers the reserved error, anything else passes the
      // entry's path rule and reads the Workspace. An absent Workspace file is a tool
      // error naming the path, never a thrown turn.
      read_file: () => async (path) => {
        const rel = path.replace(/^(\.\/)+/, '');
        if (rel.startsWith('.platform/')) {
          const content = PLATFORM_FILES[rel];
          if (content === undefined) throw new Error(`no such platform file: ${rel}`);
          return content;
        }
        if (rel.startsWith('.universe/')) throw new Error(UNIVERSE_RESERVED_MESSAGE);
        try { return await via('read_file', 'readSource')(path); } catch (e) { throw noSuchFile(path, e); }
      },
      write_file: () => (path, content) => via('write_file', 'writeSource')(path, content),
      // Read, count the anchor, refuse zero or two-plus matches with nothing written,
      // else write the replaced file — so an edit can only change what it names.
      edit_file: () => async (path, anchor, replacement) => {
        assertModelPath(path, { write: true }); // the write's rule, before the read (no read of a reserved path)
        if (anchor.length === 0) throw new Error(`edit_file: an empty anchor matches everywhere in ${path} — nothing written`);
        let content: string;
        try { content = await via('edit_file', 'readSource')(path); } catch (e) { throw noSuchFile(path, e); }
        const count = content.split(anchor).length - 1;
        if (count === 0) throw new Error(`edit_file: anchor not found in ${path} — nothing written; read the file and quote it exactly`);
        if (count > 1) throw new Error(`edit_file: anchor matches ${count} times in ${path} — nothing written; widen it so it matches once`);
        const next = content.replace(anchor, () => replacement); // a function replacer — no `$&` patterns
        return via('edit_file', 'writeSource')(path, next);
      },
      build: () => (opts) => via('build', 'buildNow')(opts),
    };
    return Object.fromEntries(
      (Object.keys(LOOP_TOOL_ENTRIES) as LoopToolName[]).map((tool) => [tool, factories[tool]()]),
    ) as unknown as LoopToolDeps;
  }

  /** The verified claims of the current mesh call, or `undefined` outside one (see
   *  {@link #clientOrigin}). */
  #claimsIfAny(): NebulaJwtPayload | undefined {
    try { return this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined; } catch { return undefined; }
  }

  /**
   * The chat history as the prompt carries it — the EXCLUSIVE projection of the chat's
   * own ordered query (`Message where chat == DEFAULT_CHAT_ID`, by `validFrom`, the same
   * read the UI subscribes to): per message its speaker — `agent`, or a stable per-`sub`
   * label in first-appearance order (`human 1`) — its `content`, and from an agent
   * message's `codegen` record only the manifest (`stop`, `rounds`, `appliedPaths`,
   * `sourceCommit`, `build.findings`). Never `toolCalls`, whose `write_file` args carry
   * whole files, and never `thought`. The triggering Message is excluded (the request
   * bundle carries it). Reads run under the turn's own call context, so a message the
   * poster may not read is skipped; outside a mesh call (a direct in-DO probe) there is
   * no history at all. A message with no reply is carried as itself, in order.
   */
  #historyBundle(triggeringMessageId?: string): { bundle?: string; posterLabel?: string } {
    const claims = this.#claimsIfAny();
    if (!claims) return {};
    let ids: string[];
    try {
      ids = this.#dataPlane.findCurrentByField('Message', 'chat', DEFAULT_CHAT_ID).map((r) => r.resourceId);
    } catch {
      return {};
    }
    const labels = new Map<string, string>();
    const labelFor = (sub: string): string => {
      let l = labels.get(sub);
      if (!l) { l = `human ${labels.size + 1}`; labels.set(sub, l); }
      return l;
    };
    // Read every message in the chat's order, then pair each reply with the message it
    // answers: a reply commits AFTER any message posted during its generation, so a purely
    // chronological list would put a skipped message between a request and its reply and
    // the model could not tell which one was answered. Each human message is followed by
    // its reply if one exists; a message with no reply is carried as itself; an agent
    // message whose request is not in the list is carried in place.
    type Row = { id: string; entry: HistoryEntry; isAgent: boolean; replyTo?: string };
    const rows: Row[] = [];
    for (const id of ids) {
      if (id === triggeringMessageId) continue;
      let snap: Snapshot | null;
      try { snap = this.#dataPlane.doRead(id); } catch { continue; }
      if (!snap) continue;
      const v = snap.value as {
        content?: string;
        replyTo?: string;
        codegen?: { stop?: string; rounds?: number; appliedPaths?: string[]; sourceCommit?: string; build?: { findings?: string[] } };
      };
      const isAgent = deriveKind(snap.meta.actingToken) === 'agent';
      const cg = v.codegen;
      rows.push({
        id, isAgent, replyTo: v.replyTo,
        entry: {
          speaker: isAgent ? 'agent' : labelFor(snap.meta.actingToken.sub),
          content: v.content ?? '',
          ...(isAgent && cg ? {
            manifest: {
              stop: cg.stop ?? '', rounds: cg.rounds ?? 0, appliedPaths: cg.appliedPaths ?? [],
              ...(cg.sourceCommit ? { sourceCommit: cg.sourceCommit } : {}),
              ...(cg.build?.findings?.length ? { findings: cg.build.findings } : {}),
            },
          } : {}),
        },
      });
    }
    const replyOf = new Map<string, Row>();
    for (const r of rows) if (r.isAgent && r.replyTo && !replyOf.has(r.replyTo)) replyOf.set(r.replyTo, r);
    const consumed = new Set<string>();
    const entries: HistoryEntry[] = [];
    for (const r of rows) {
      if (consumed.has(r.id)) continue;
      entries.push(r.entry);
      consumed.add(r.id);
      const reply = r.isAgent ? undefined : replyOf.get(r.id);
      if (reply && !consumed.has(reply.id)) { entries.push(reply.entry); consumed.add(reply.id); }
    }
    return {
      ...(entries.length > 0 ? { bundle: renderHistoryBundle(entries) } : {}),
      posterLabel: labelFor(claims.sub),
    };
  }
}

/** Where the Galaxy layer of the guidance tree lives in the Workspace — the standard's
 *  own location, so the same file reads in any agent opened on a clone. */
const GALAXY_AGENTS_PATH = 'AGENTS.md';
/** The line ahead of the Galaxy layer in the system message, so the model knows which
 *  layer it is reading. */
const GALAXY_LAYER_PREFACE = "The app's own AGENTS.md — the layer below the platform's. It adds to the platform guidance and never subtracts from it; keep it current (see the platform guidance):";

/** The shape `#clientOrigin` reads off a call context. */
type CallContextLike = { callChain: Array<{ instanceName?: string }>; originAuth?: { claims?: unknown } };
