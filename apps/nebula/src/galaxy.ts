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
 * `{u}.{g}`); codegen/source methods carry `@mesh(requireDominionHere)` on top, while the
 * chat data-plane surface is bare `@mesh()` — participants are non-admin but DAG-granted.
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
import { NEBULA_SUB, ACCESS_TOKEN_TTL } from '@lumenize/nebula-auth';
import { NebulaDO, requireDominionHere } from './nebula-do';
// Types only — the COMPILE itself runs in the container build job
// (tasks/archive/nebula-move-compilers-out-of-the-worker.md: the Worker orchestrates and
// stores, and does not build). No value import of the compile half may return here;
// scripts/check-worker-graph.mjs is the tripwire.
import type { OntologyVersionRow } from './ontology-compile';
import { stepFailed, REPORT_MARKER, ROW_PATH, WS_ROOT, wsPath } from './build-report';
import { withHeartbeat } from './turn-heartbeat';
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
  CODEGEN_TOOLS,
  TOOL_ARG_TYPE,
  DEFAULT_LOOP_CONFIG,
  type CodegenLoopConfig,
  type CodegenLoopDeps,
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

/** The fast-discriminator model id — small + cheap, sub-second budget (the two-LLM-calls
 *  Decisions row). Swappable like {@link STUDIO_MODEL}; never surfaced. */
const DISCRIMINATOR_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

/**
 * The default generation deadline, at module scope so a test can assert the
 * shipped value rather than a copy of it (see `Galaxy.generationDeadlineMs`,
 * whose JSDoc carries why this is an authorization bound).
 */
export const GENERATION_DEADLINE_MS = 300_000;

/** A hung build job is killed here; the report's `container` tail then NAMES the
 *  timeout, so the model does not rebuild the same code until the turn deadline.
 *  Generous: a heavy-lib vite 8 build measured seconds, not minutes (§ Relationships
 *  in the collapse task; re-tune from evidence, not fear). */

const BUILD_TIMEOUT_MS = 180_000;

/** Per-cycle job options: the host-computed ontology work, when the `.d.ts` changed. */
type BuildJobOpts = { ontology?: { version: string; wipe: boolean } };

/** The seam's placeholder `publish` — {@link Galaxy.#buildAndAnnounce} overwrites it
 *  with the real decision, so a faked `build()` never decides publishing either. */
const PUBLISH_UNDECIDED = { done: false, why: 'not decided at the build layer' };

/**
 * The publish decision — default: reload only on a clean build; the MODEL may override
 * to publish alongside findings it judges harmless (the task's
 * publishing-is-the-model's-call decision). What it can never override is a failed (or
 * never-run) bundle: there is no `dist`, so nothing to publish — structural, not
 * policy. Pure and exported so every arm is unit-testable; the announce layer
 * (`#buildAndAnnounce`) is its only production caller.
 */
export function decidePublish(report: BuildReport, override?: boolean): BuildReport['publish'] {
  if (!(report.bundle.ran && report.bundle.ok === true)) {
    const why = report.bundle.ran
      ? 'bundle failed — there is no dist to publish'
      : `bundle did not run (${(report.bundle as { why: string }).why}) — there is no new dist`;
    return { done: false, why };
  }
  if (override === true) {
    return { done: true, why: 'published on the model\'s override' };
  }
  if (override === false) {
    return { done: false, why: 'the model declined to publish' };
  }
  if (stepFailed(report.ontology)) {
    return { done: false, why: 'ontology compile failed — publish withheld by default' };
  }
  if (report.typeCheck.findings.length > 0) {
    return { done: false, why: 'type findings — publish withheld by default (the model may override)' };
  }
  return { done: true, why: 'clean build' };
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
- Call write_file with the COMPLETE new contents of a file. It is a pure save — nothing is checked at write time — so write every file the change needs, then check them all with one build.
- Call build to check and bundle the app. Read its per-step report: fix a failed ontology or bundle step with write_file and build again; a failed container step is infrastructure and may be retried unchanged — unless its tail says the job timed out, in which case simplify instead of retrying.
- typeCheck findings are ADVISORY, and you are the judge: a finding may be a real bug a user would hit, or something the checker cannot see is safe. Fixing is not always the right call — shipping with a reasoned findings list is a legitimate outcome. The preview publishes by default only on a findings-free build; pass { "publish": true } to build to publish alongside findings you judge harmless. You can never publish when bundle failed (there is no dist).
- When the app is done and the last build report is acceptable, call mark_complete.
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
   *  ⚠️ **It MUST stay under `ACCESS_TOKEN_TTL`, and the assert below is why.** A
   *  triggered turn runs detached under the POSTER's `callContext`, whose claims were
   *  verified when they posted and are never re-verified at the write — so a turn that
   *  outran the token's own lifetime would commit under claims that had expired before
   *  the write landed. At 300 s against 900 s the write always lands inside the window
   *  the access TTL already bounds, which is what keeps this inside `security.md`'s
   *  accepted revocation exposure rather than widening it. Raise this and you are
   *  changing an authorization property, not a timeout. */
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
   */
  @mesh(requireDominionHere)
  async writeSource(path: string, content: string): Promise<{ oid: string; path: string }> {
    const rel = path.replace(/^\/+/, '');
    if (rel.includes('/')) {
      await this.#ws.fs.mkdir(wsPath(rel.slice(0, rel.lastIndexOf('/'))), { recursive: true });
    }
    await this.#ws.fs.writeFile(wsPath(rel), content);
    await this.#ws.git.add({ dir: WS_ROOT, paths: [rel] });
    const { oid } = await this.#ws.git.commit({ dir: WS_ROOT, message: `edit ${rel}` });
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
    return this.#ws.fs.readFile(wsPath(path), 'utf8');
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
   * Worker Loader cache, and the wipe bit is decided under this method's dominion
   * check. The Galaxy keeps the append-only check, the write and the
   * `transactionSync` unchanged — only the compile moved.
   *
   * The WIPE decision is made (and dominion-checked, via this method's guard) HERE, in
   * the turn that changed the ontology, and rides the row as `wipeOnInstall` — written
   * once, immutable, never consumed-and-cleared. A Star pulling this version from an
   * older one wipes first; one already on it never asks (install idempotent).
   *
   * `version` is content-addressed (`git.hashBlob` of the ontology source) so a
   * re-apply of unchanged source is a no-op and the Star-side Worker Loader cache
   * (`bundleId = galaxyId/version`) never serves a stale validator.
   */
  @mesh(requireDominionHere)
  async appendWorkspaceOntology({ wipe = false }: { wipe?: boolean } = {}): Promise<{ version: string }> {
    const { version } = await this.#readOntology();
    if (await this.#registryRow(version)) return { version }; // unchanged source → already applied
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
   * the build and nothing else — {@link #buildAndAnnounce} owns the publish decision
   * and the reload push, one level up, where a faked success announces exactly like a
   * real one. The seam's report carries a placeholder `publish` the layer above
   * overwrites.
   */
  protected build(opts: BuildJobOpts = {}): Promise<BuildReport> {
    const run = this.#buildChain.then(() => this.#buildOnce(opts));
    this.#buildChain = run.catch(() => { /* the next cycle starts clean */ });
    return run;
  }

  /**
   * A build plus its publish decision + announcement — **the only way callers should
   * build.** A published build tells whoever asked for it (see
   * {@link announceBuildToRequester}), and that belongs to the EVENT (new `dist` in
   * the VFS) rather than to whichever caller produced it: the codegen loop's `build`
   * tool, the admin `buildNow()` and the dev Apply all go through here.
   *
   * When the caller passes no explicit ontology job, the Workspace's own pending
   * ontology change rides along (compiled for FEEDBACK — the row is written to the
   * mount but NOT appended to the registry; only {@link appendWorkspaceOntology}, the
   * dominion-gated Apply, appends — the secure-by-default D2 line).
   *
   * ⚠️ Deliberately ABOVE {@link build}, which is the test seam. Putting the push inside
   * `build()` made every faked build silently stop announcing — the suite caught it.
   */
  async #buildAndAnnounce(opts: BuildJobOpts & { publish?: boolean } = {}): Promise<BuildReport> {
    const jobOpts: BuildJobOpts = {
      ontology: opts.ontology ?? await this.#pendingOntology(),
    };
    const report = await this.build(jobOpts);
    let publish = decidePublish(report, opts.publish);
    // A clean report does not prove the dist ARRIVED: the vendor's post-exec pull
    // swallows its own failure (outcome resolves `status: "pending"`, applied 0, no
    // throw), and local materialize-mode change detection can miss vite's last writes
    // on the bracket — either way the serve would 404 behind a "clean build". The
    // DELIVERY fix is upstream: {@link #buildOnce} verifies arrival and re-pulls
    // before its teardown, while the container's store still exists. This gate is the
    // backstop that keeps the residual loss loud instead of a silent 404. Only where a
    // container actually ran — pool-workers' faked builds have no dist.
    if (publish.done && this.ctx.container && !(await this.#distArrived())) {
      publish = {
        done: false,
        why: 'the built dist did not arrive back from the container (sync pull incomplete) — retry the build',
      };
    }
    if (publish.done) this.announceBuildToRequester();
    return { ...report, publish };
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
   * arrival is verified and re-pulled via no-op exec brackets before the container is
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
      publish: PUBLISH_UNDECIDED,
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
          bundle: StepResult;
        };
        // The bracket's pull can fail SILENTLY (the vendor resolves it `status:
        // "pending"` without throwing) or miss late writes (local materialize-mode
        // change detection) — and the data is only recoverable while THIS container
        // lives, since a fresh pull reads its store. So before the teardown, when the
        // job says a dist exists, confirm it arrived host-side; on a miss, a no-op
        // exec re-runs the whole sync bracket, which is the retry.
        if (steps.bundle.ran && steps.bundle.ok === true) {
          // Budget 5: a naturally-occurring miss (2026-08-30, local loop run 6) consumed
          // all of a 3-attempt budget before the pull delivered — 3 was exactly enough,
          // which is no margin at all. The loop exits at first arrival, so a healthy
          // bracket pays one readFile and zero execs.
          // ⚠️ SPACED, not back-to-back. The miss heals with TIME, not with more execs: five
          // re-pulls fired in a row can all race the same in-flight pull and exhaust the budget
          // in under a second (the 2026-09-03 `build-box` reds — bundle ok, dist never arrived).
          // The hand-observed heal was "a no-op exec on the still-alive container, within a few
          // tries" — tries spaced by human time. 250 ms doubling → ~8 s of patience in total.
          // The await opens this DO's input gate, but this whole build is already a chain of
          // container awaits serialized by `#buildChain`, so nothing new is exposed here.
          let attempt = 0;
          for (; attempt < 5 && !(await this.#distArrived()); attempt++) {
            debug('nebula.Galaxy.build').warn('dist not in the VFS after the bracket — re-pulling', { attempt });
            await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
            try {
              await (await this.#ws.runtime.exec('true', { cwd: '/workspace', timeoutMs: 30_000 })).result();
            } catch { break; /* session dead — the publish gate reports the loss */ }
          }
          if (attempt > 0) {
            debug('nebula.Galaxy.build').info('dist arrived after re-pull', { attempts: attempt, arrived: await this.#distArrived() });
          }
        }
        this.#destroyBuildContainer();
        debug('nebula.Galaxy.build').info('job report', {
          ontology: steps.ontology.ran, findings: steps.typeCheck.findings.length,
          bundleOk: steps.bundle.ran && steps.bundle.ok === true,
          pushed: result.pushed, pulled: result.pulled,
          // "pending" = the pull attempt THREW and is over (misleading name; retried
          // only under the opt-in retryScheduler). "complete" + pulled 0 is ambiguous:
          // nothing-to-sync AND detection-missed-everything both look like it — which
          // is why arrival is verified by reading the file, not by this field.
          syncStatus: (result as { sync?: { status?: string; error?: string } }).sync?.status,
          syncError: (result as { sync?: { status?: string; error?: string } }).sync?.error,
        });
        return { container: { ran: true, ok: true }, ...steps, publish: PUBLISH_UNDECIDED };
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
   *  pre-teardown re-pull in {@link #buildOnce} and the publish gate in
   *  {@link #buildAndAnnounce}. */
  async #distArrived(): Promise<boolean> {
    try {
      await this.#ws.fs.readFile(wsPath('dist/index.html'));
      return true;
    } catch {
      return false;
    }
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
   * Run one build cycle on demand — the manual-rebuild affordance (an admin recovering
   * from an infra failure without spending a model turn), and the drive-verification
   * surface (`harness/scenarios/build-box.ts` proves the sequential/overlap/teardown
   * contract through it — the model's own `build` calls are not deterministically
   * drivable). Same latch, same ephemeral cycle as the loop's tool; the report
   * returns to the caller's `callAsync`.
   */
  @mesh(requireDominionHere)
  buildNow(): Promise<BuildReport> {
    return this.#buildAndAnnounce();
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
   * person whose message started the turn) and the admin `buildNow()`.
   */
  protected announceBuildToRequester(): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    // No client origin (a server-internal build) — nobody asked, so nobody is told.
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

  /** The turn body the trigger races against the generation deadline: discriminator
   *  first, then the codegen loop OR the plain-answer generation. */
  async #chatTurn(userMessageId: string, message: string): Promise<void> {
    // Mint the agent Message id up front (Galaxy-minted — the human message's id is
    // client-minted); stream progress transiently to chat subscribers; commit ONE
    // durable Message at the end, `replyTo`-linked to the triggering human Message.
    // Minted BEFORE the discriminator so the heartbeat below has an id from the first ms.
    const agentMessageId = crypto.randomUUID();

    // ⚠️ ONE heartbeat for the WHOLE turn (`turn-heartbeat.ts`), not one per await. Every
    // model call in a turn is whole-response and therefore silent — the discriminator, the
    // plain-answer generation, and each codegen round — and a container build emits nothing
    // until it exits. Wrapping the two loop awaits alone left the discriminator and the entire
    // answer path uncovered, and the first live drive of it painted `failed` over a healthy
    // turn before codegen had even started. The turn IS the unit of liveness. Bounded by the
    // same generation deadline the trigger races this body against, so a hung call still fails.
    const deadlineAt = Date.now() + this.generationDeadlineMs;
    await withHeartbeat(
      () => this.#chatTurnBody(userMessageId, message, agentMessageId),
      () => this.streamProgress(DEFAULT_CHAT_ID, agentMessageId, '', CHAT_NODE_ID, userMessageId),
      { intervalMs: TURN_HEARTBEAT_MS, deadlineAt },
    );
  }

  /** The turn body proper — discriminator first, then the codegen loop OR the plain answer. */
  async #chatTurnBody(userMessageId: string, message: string, agentMessageId: string): Promise<void> {
    // STAGE 1 — the fast DISCRIMINATOR (the two-LLM-calls model): its verdict places
    // nothing UI-side pre-alpha (`respond?` is hardwired YES), but it GATES the
    // container warm (on the codegen verdict, never on message-arrival) and forks the
    // generation prompt. A plain question therefore starts ZERO containers.
    const verdict = await this.discriminate(message);
    debug('nebula.Galaxy.trigger').info('discriminator verdict', { userMessageId, codegen: verdict.codegen });

    if (!verdict.codegen) {
      // ANSWER path — big model, answer prompt, no tools, zero container involvement.
      const reply = await this.#answerTurn(message, agentMessageId, userMessageId);
      await this.commitAgentMessage(DEFAULT_CHAT_ID, agentMessageId, reply, CHAT_NODE_ID, userMessageId);
      return;
    }

    // CODEGEN path — fire the container warm NOW (the ~3 s cold+mount hides behind
    // the generation; the build tool's exec finds it already up), then run the loop.
    // ⚠️ The warm STARTS a container, so from here the turn owes a teardown on EVERY
    // exit: a turn can end without ever calling `build` (`no-tool-calls`, the round
    // cap, a `mark_complete` with no build, or the discriminator failing open on a
    // plain question), and `#buildOnce` is the only other place that destroys. Without
    // the `finally` below those turns leak a live container against `max_instances`,
    // breaking the invariant the whole ephemeral design rests on — that a container
    // never outlives its build. Destroy is idempotent, so the common path (build ran,
    // already torn down) pays a no-op.
    this.warmBuildBox();
    try {
      await this.#codegenTurn(message, agentMessageId, userMessageId);
    } finally {
      this.#destroyBuildContainer();
    }
  }

  /** The codegen fork's body — extracted so the container teardown above can wrap it. */
  async #codegenTurn(message: string, agentMessageId: string, userMessageId: string): Promise<void> {
    // The tree the turn READ — captured BEFORE the loop writes (the codegen record's
    // `sourceCommit`; git is local to this DO's VFS, so the ref recovers the bytes).
    let sourceCommit: string | undefined;
    try { sourceCommit = (await this.#ws.git.log({ dir: WS_ROOT, depth: 1 }))[0]?.oid; } catch { /* fresh repo */ }
    const result = await this.runCodegenTurn(
      message, DEFAULT_LOOP_CONFIG,
      (step) => this.streamProgress(DEFAULT_CHAT_ID, agentMessageId, step, CHAT_NODE_ID, userMessageId),
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
   * The plain-answer generation — the discriminator's non-codegen fork: the big model,
   * an answer prompt, NO tools, zero container involvement. The whole answer streams
   * as transient chunks (best-effort animation); the durable Message is the caller's
   * commit.
   */
  async #answerTurn(message: string, agentMessageId: string, userMessageId: string): Promise<string> {
    const raw = await this.runModel(STUDIO_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You are Studio, the assistant inside an app-building workspace. Answer the ' +
            'question conversationally and concisely. Do NOT emit code or tool calls — ' +
            'this turn changes nothing in the app.',
        },
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    });
    const turn = parseModelTurn(raw);
    const reply = turn.text.trim() || 'I had nothing to add — try rephrasing?';
    this.streamProgress(DEFAULT_CHAT_ID, agentMessageId, reply, CHAT_NODE_ID, userMessageId);
    return reply;
  }

  /**
   * The fast DISCRIMINATOR — a small model, short prompt, sub-second budget, answering
   * `{ respond?, codegen? }`. Pre-alpha `respond` is HARDWIRED YES (the unhardwiring
   * policy is the fast-follow's); what the verdict does today is gate the container
   * warm and fork the generation prompt. `protected` so probes can pin the verdict.
   *
   * Fails OPEN toward `codegen: true`: the pre-alpha journey is building, so a
   * discriminator hiccup costs one speculative container start rather than a builder's
   * change silently answered as chat.
   */
  protected async discriminate(message: string): Promise<{ respond: true; codegen: boolean }> {
    try {
      const raw = await this.runModel(DISCRIMINATOR_MODEL, {
        messages: [
          {
            role: 'system',
            content:
              'A message arrived in an app-building chat. Reply with ONLY the JSON ' +
              '{"codegen": true} if the message asks to build, change, style, or fix ' +
              'the app (its UI, behavior, or data model); reply {"codegen": false} if ' +
              'it is a question or conversation that changes nothing.',
          },
          { role: 'user', content: message },
        ],
        temperature: 0,
        max_tokens: 32,
      });
      const text = parseModelTurn(raw).text;
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { codegen?: unknown };
      return { respond: true, codegen: parsed.codegen !== false };
    } catch (e) {
      debug('nebula.Galaxy.discriminate').warn('verdict failed — defaulting to codegen', {
        error: e instanceof Error ? e.message : String(e),
      });
      return { respond: true, codegen: true };
    }
  }

  /**
   * Speculatively start the build container at the CODEGEN VERDICT (never at
   * message-arrival — the criterion), so its cold start + mount hides behind the
   * generation and the build tool's exec finds it up. Fire-and-forget: a warm failure
   * costs nothing (the exec's own connect starts it) and must never delay the model.
   * A no-container environment (pool-workers) is a silent no-op. `protected` so the
   * drive log can be asserted (a plain-question turn starts ZERO containers).
   */
  protected warmBuildBox(): void {
    // The marker precedes the container guard ON PURPOSE: "a plain-question turn fires
    // ZERO warms" is asserted on this marker's count, in-lane included (where
    // ctx.container is absent and the start below is a no-op).
    debug('nebula.Galaxy.warm').info('container warm fired (codegen verdict)');
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
   * Signal the client its preview can load. Immediate BY DESIGN post-collapse: `dist/`
   * serves Galaxy-direct from this DO's VFS, so there is nothing to warm for VIEWING —
   * the container is engaged only on a build, off the read path entirely. The signal
   * survives as Studio's initial-load auto-refresh cue; subsequent refreshes ride the
   * build-completion reload push.
   */
  @mesh(requireDominionHere)
  warmPreview(clientId: string): void {
    this.deliverPreviewReady(this.lmz.instanceName!, clientId);
  }

  /**
   * Tell the originating client the preview is ready, by direct delivery — a one-way
   * mesh call to the client's Gateway addressed by its stable `instanceName`
   * (`clientId`), so a WS reconnect doesn't strand it. NO `newChain` — the originating
   * client's `originAuth` must ride through so the Gateway's aud check passes;
   * fire-and-forget + try/catch (a delivery failure must never break the dev loop).
   */
  protected deliverPreviewReady(scope: string, clientId: string): void {
    try {
      this.lmz.call(CLIENT_GATEWAY_BINDING, clientId, this.ctn<NebulaClient>().handlePreviewReady(scope));
    } catch (e) {
      debug('nebula.Galaxy.warmPreview').warn('preview-ready delivery failed (non-fatal)', { error: e });
    }
  }

  // ─── Resource data-plane surface (the chat Chat/Message Resources) ─────────
  //
  // `@mesh()` — **NOT** `@mesh(requireDominionHere)` (unlike the codegen/source methods
  // above): chat participants are non-admin but DAG-granted. `onBeforeCall` (NebulaDO
  // base) enforces passage into `{u}.{g}`; the per-op DAG read/write check lives inside
  // the data-plane (Resources/DagTree), exactly as on Star. Every op is version-gated
  // against the INSTALLED chat ontology — `OntologyStaleError` on a mismatch, exactly
  // Star's shapes (transaction returns it as a VALUE; read throws; subscribe pushes).

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
    this.svc.broadcast(targets, this.ctn<NebulaClient>().handleStreamChunk(messageId, progress, replyTo));
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
    await this.#dataPlane.ensureResource(messageId, 'Message', nodeId, value, {
      actor: { sub: NEBULA_SUB, profileId: NEBULA_SUB },
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
    return this.runModel(STUDIO_MODEL, {
      messages,
      tools: CODEGEN_TOOLS,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    });
  }

  /**
   * The one model-transport router every generation path shares — the codegen loop
   * (via {@link callModel}), the discriminator, and the plain-answer turn — so the
   * REST-vs-binding split lives once. `protected` so a probe overriding IT scripts
   * every path at once.
   */
  protected async runModel(model: string, body: Record<string, unknown>): Promise<unknown> {
    // WORKERS_AI_TOKEN / CLOUDFLARE_ACCOUNT_ID / CF_AI_GATEWAY are runtime env (`.dev.vars`
    // / `wrangler secret`), not committed wrangler vars, so they're absent from the
    // generated `Env` — widen at the read (packaging.md).
    const env = this.env as Env & { WORKERS_AI_TOKEN?: string; CLOUDFLARE_ACCOUNT_ID?: string; CF_AI_GATEWAY?: string };
    if (env.WORKERS_AI_TOKEN) return this.#callModelRest(env, env.WORKERS_AI_TOKEN, model, body);
    // The model-catalog types don't cover every @cf id; run() is treated loosely.
    return (this.env.AI as any).run(model, body);
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
  ): Promise<unknown> {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) throw new Error('Workers AI REST path needs CLOUDFLARE_ACCOUNT_ID');
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
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
    try { currentSource = await this.#ws.fs.readFile(wsPath('src/App.vue'), 'utf8'); } catch { /* none yet */ }
    let ontologyDts: string | undefined;
    try { ontologyDts = await this.#ws.fs.readFile(wsPath(ONTOLOGY_PATH), 'utf8'); } catch { /* none yet */ }

    const initial = assembleCodegenPrompt({
      systemBundles: [STUDIO_LOOP_SYSTEM_PROMPT],
      ontologyDts,
      userRequest,
      currentSource,
    });
    // No per-await heartbeat here: liveness is a property of the TURN, and `#chatTurn` beats
    // around the whole body — the discriminator and the answer path are silent model calls too.
    const deps: CodegenLoopDeps = {
      callModel: (m, p) => this.callModel(m, p),
      writeFile: (path, content) => this.writeSource(path, content),
      validateToolArgs: (n, a) => this.#validateToolArgs(n, a),
      // The model's publish override passes through; the pending-ontology job rides
      // by default (compiled for feedback, never appended — the Apply appends).
      build: (opts) => this.#buildAndAnnounce({ publish: opts?.publish }),
      onProgress,
    };
    return runCodegenLoop(initial, deps, config);
  }
}
