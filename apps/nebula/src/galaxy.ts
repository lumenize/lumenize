/**
 * Galaxy — the app-level brain, one DO per galaxy (instanceName = `{u}.{g}`, e.g. "acme.app").
 *
 * The collapse of three former nodes (Galaxy + DevStudio + DevContainer) into one class
 * (tasks/archive/nebula-galaxy-collapse-and-chat.md). It owns:
 *  - the **`.dev` Star's current ontology row**: the build compiles the Workspace's `.d.ts`
 *    to a `validatorBundle` row, and the Galaxy stores it when the build lands; the `.dev`
 *    Star pulls it on a version mismatch ({@link Galaxy.getCurrentOntology}).
 *  - the **git Workspace** (source of truth for the user-developer's app source) — a
 *    `@cloudflare/computer` SQLite-backed VFS in this DO's own storage, with host-side git
 *    (no container involved in fs or git work).
 *  - the **codegen engine**: the sole writer of source, driving the bounded self-correcting
 *    tool-calling loop (`runCodegenLoop`) against `env.AI` / the Workers-AI REST lane.
 *  - the **chat Session/Message Resources** via the composed {@link Resources}.
 *  - the co-located **ephemeral build container** via raw `ctx.container` — a
 *    stateless build-box, never `extends Container` (containers.md).
 *
 * `extends ScopedMeshDO` for the structural tenant isolation its passage step enforces (passage into
 * `{u}.{g}`). Three guard tiers sit on top of it. The source entries — `readSource`,
 * `writeSource`, `buildNow` — carry `@mesh(requireChatWrite)`,
 * the chat floor: DAG `write` at the chat node, the same check a Message create passes
 * at the door, so a collaborator's direct call and the turn their message triggers agree.
 * Galaxy configuration (`setGalaxyConfig`) keeps `@mesh(requireDominionHere)`.
 * The resources door is bare `@mesh()` — chat participants are non-admin but
 * DAG-granted, and the per-op check lives inside the plane.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { addressOf, mesh, rawRpc } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { Workspace } from '@cloudflare/computer';
import type { DurableObjectStorageLike } from '@cloudflare/computer';
import { ContainerBackend, WorkspaceContainerAPI } from '@cloudflare/computer/backends/container';
import type { ContainerLaunchSpec } from '@cloudflare/computer/backends/container';
import { createGitClient } from '@cloudflare/computer/git';
import git from 'isomorphic-git';
import {
  getParserValidatorFacet,
  type ParserValidator,
} from '@lumenize/ts-runtime-parser-validator/runtime';
import { NEBULA_SUB, projectActingToken } from '@lumenize/mesh/auth';
import type { AuthClaims } from '@lumenize/mesh/auth';
import { GATEWAY_PREFIX, ScopedMeshDO, requireDominionHere } from '@lumenize/mesh';
// Types only — the COMPILE itself runs in the container build job
// (tasks/archive/nebula-move-compilers-out-of-the-worker.md: the Worker orchestrates and
// stores, and does not build). No value import of the compile half may return here;
// scripts/check-worker-graph.mjs is the tripwire.
import type { OntologyVersionRow } from './ontology-compile';
import { REPORT_MARKER, ROW_PATH, WS_ROOT, stepFailed, wsPath } from './build-report';
import { withHeartbeat } from './turn-heartbeat';
import { assembleStream } from './model-stream';
import { TURN_HEARTBEAT_MS } from './turn-liveness';
import type { BuildReport, StepResult } from './build-report';
import { Resources } from '@lumenize/resources';
import type { OntologySource, ResourcesHost, ResourcesRequests, ResourcesResults } from '@lumenize/resources';
import type { QueryDescriptor } from '@lumenize/resources';
import { chatOntologySeedRow } from './chat-ontology';
import { DEFAULT_CHAT_ID, CHAT_NODE_ID } from './chat-constants';
import { serveApp } from './serve';
import { afterCall, cloudflareCertificateApi, isFinalStatus, nextCall, onWake, packHosts, packNamesGalaxy, teardownSteps } from './certificate';
import type { CertificateApi, CertificateState } from './certificate';
import { PUBLIC_PREFIX, PUBLIC_SCOPE_HEADER } from './page-forward';
import { LUMENIZE_ORIGIN_META } from '@lumenize/mesh/client';
import { deploymentOrigin, hostOrigin } from '@lumenize/mesh/client';
import { deriveKind } from './participants';
import { SCAFFOLD_FILES } from './scaffold-seed';
import { PLATFORM_FILES, PLATFORM_AGENTS_MD } from './platform-embed';
import type { Snapshot } from '@lumenize/resources/client';
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

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Where the `.dev` Star's current row lives: this Galaxy's own storage, copied there when a build
 * lands. Never the mount — the job writes its row at {@link ROW_PATH} before `vite build` runs
 * the Workspace's own `vite.config.ts`, which could overwrite a file there, and nothing a build
 * runs can write this key. One row, replaced by each landing: during development a version
 * nothing runs is never read again.
 */
const DEV_ONTOLOGY_ROW_KEY = 'galaxy:devOntologyRow';

/** The ontology source file — compiled to the runtime validator (the ontology is just
 *  another source file in the Workspace). */
const ONTOLOGY_PATH = 'src/ontology.d.ts';

const GIT_AUTHOR = { name: 'Lumenize', email: 'noreply@lumenize.io' };
const GIT_INITED_KEY = 'galaxy:gitInited';
/** The certificate pack's state (`certificate.ts` `CertificateState`), in this Galaxy's own storage. */
const CERTIFICATE_KEY = 'galaxy:certificate';
/** The one alarm id the certificate uses, so a second wake re-arms it rather than adding another. */
const CERTIFICATE_ALARM_ID = 'galaxy-certificate';
/** How long a teardown waits for an order already in flight before listing packs. */
const CERTIFICATE_ORDER_WAIT_MS = 20_000;

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

/** Per-cycle job options: the host-computed ontology version, when the `.d.ts` changed. */
type BuildJobOpts = { ontology?: { version: string } };

/** The seam's placeholder `preview` — {@link Galaxy.#buildAndLand} overwrites it with the
 *  landing's outcome, so a faked `build()` never decides one either. */
const PREVIEW_UNDECIDED = { refreshed: false, why: 'not decided at the build layer' };

/**
 * Entered around a triggered turn's loop and nowhere else, so a landing tells a turn's build from
 * a direct `buildNow` by where it runs, never by anything a caller sends ({@link Galaxy}'s
 * `#recordServedBuild`). A direct `buildNow` arrives on a request of its own, outside it, even
 * while a turn runs.
 */
const turnContext = new AsyncLocalStorage<true>();

/** The `.dev` Star's served copy: the build a landing copied out of `/workspace/dist/`. It sits
 *  outside `/workspace`, so the model's paths (`assertModelPath`) never reach it and git never
 *  tracks it; the exec's sync still carries it into each build box, as any root-level write. */
const DEV_SERVED_DIR = '/dist-dev';

/**
 * Whether a build LANDS on `.dev` — the moment `.dev` starts serving it, its compiled types become
 * the `.dev` Star's, and Studio hears of it. The model's call on the preview is part of it: a clean
 * build lands by default, one with type findings only on the model's `{ "preview": true }`, and none
 * on `{ "preview": false }`. What no call overrides is a build that cannot be served: a bundle that
 * failed or never ran, one whose `index.html` digest is missing (its arrival cannot be checked), a
 * `dist` that did not arrive, or types that did not compile. Its result IS the report's `preview`
 * step, so the model reads one reason. Pure and exported so every arm is unit-testable.
 */
export function decideLanding(
  report: BuildReport, opts: { arrived: boolean; ontologyVersion?: string; preview?: boolean },
): BuildReport['preview'] {
  if (!(report.bundle.ran && report.bundle.ok === true)) {
    const why = report.bundle.ran
      ? 'bundle failed — there is no dist to serve'
      : `bundle did not run (${(report.bundle as { why: string }).why}) — there is no new dist`;
    return { refreshed: false, why };
  }
  if (!report.bundle.indexSha256) {
    return { refreshed: false, why: 'the bundle reported no digest of its index.html, so its arrival cannot be checked — build again' };
  }
  if (!opts.arrived) {
    return { refreshed: false, why: 'the built dist did not arrive back from the container (sync pull incomplete) — build again' };
  }
  if (opts.ontologyVersion !== undefined && !(report.ontology.ran && report.ontology.ok === true)) {
    return { refreshed: false, why: 'the ontology compile did not succeed' };
  }
  if (opts.preview === false) {
    return { refreshed: false, why: 'held back on the model\'s { "preview": false }, so .dev still serves the last previewed build' };
  }
  if (report.typeCheck.findings.length > 0 && opts.preview !== true) {
    return { refreshed: false, why: HELD_FOR_FINDINGS };
  }
  return {
    refreshed: true,
    why: report.typeCheck.findings.length > 0 ? 'landed on the model\'s { "preview": true }' : 'clean build, landed',
  };
}

/** The `why` of a build held back for its type findings alone, which {@link heldBackLine} reads
 *  back, so the reply names findings only when findings are what held the build. */
const HELD_FOR_FINDINGS = 'type findings — held back, so .dev still serves the last previewed build; build again with { "preview": true } to land it anyway';

/**
 * The line a turn's reply ends with when its last build did not land, or `undefined` when it landed
 * or the turn built nothing. It is the Galaxy's own sentence, appended whatever the model wrote, so
 * a turn never ends saying "done" while the preview silently shows the last build. Pure and
 * exported so the reply's two readers of it, the line and the `Updated the preview.` fallback,
 * agree, and so every arm is unit-testable.
 */
export function heldBackLine(lastBuild: BuildReport | undefined): string | undefined {
  if (!lastBuild || lastBuild.preview.refreshed) return undefined;
  const reason = stepFailed(lastBuild.container)
    ? 'the build box could not run the last build'
    : !(lastBuild.bundle.ran && lastBuild.bundle.ok === true)
      ? 'the last build did not bundle'
      : lastBuild.preview.why === HELD_FOR_FINDINGS
        ? 'the last build was held back for its type findings'
        : `the last build did not land (${lastBuild.preview.why})`;
  return `The preview was not updated: ${reason}.`;
}

/**
 * What a completed turn's reply says when the model wrote none: that the preview moved, nothing
 * at all when the build was held back (the Galaxy's own {@link heldBackLine} says why), or what
 * the turn changed without a build. Pure and exported, so the order of these arms is a table's,
 * not a template's (calibration §12).
 */
export function completedTurnFallback(appliedPaths: number, lastBuild: BuildReport | undefined): string {
  if (lastBuild?.preview.refreshed) return 'Updated the preview.';
  if (heldBackLine(lastBuild)) return '';
  return appliedPaths === 0 ? 'Done — no changes.' : 'Saved the changes; nothing was built, so the preview is unchanged.';
}

/**
 * Whether the node that called is `galaxy`'s own `.dev` Star, read from the LAST hop of the call's
 * chain: the framework appends each hop, and a Client's chain is stamped by its Gateway from the
 * verified socket, so no caller writes it. The binding and the whole name must match, so
 * `acme.crm.devops` does not pass for `acme.crm.dev`, and neither does a Client on its page, whose
 * name always carries a `/` (`acme.crm.dev/alice.x`).
 */
export function isDevStarCall(
  callChain: ReadonlyArray<{ bindingName: string; instanceName?: string }> | undefined,
  galaxy: string,
): boolean {
  const last = callChain?.at(-1);
  return last?.bindingName === 'STAR' && last.instanceName === `${galaxy}.dev`;
}

/** The build box's image: its key in the `images` map of `wrangler.jsonc`'s containers block, which
 *  the `durable_object` scheduling policy exposes as `ctx.container.images`. */
const BUILD_BOX_IMAGE = 'build-box';

/** The build box's size, chosen at each `start()` — the `durable_object` scheduling policy has no
 *  `instance_type` in config. 1 vCPU / 6 GiB. Do not drop back to `standard-1` (½ vCPU): measured on
 *  real Cloudflare 2026-07-20 (`experiments/container-cold-start-probe`), a small app with one
 *  charting library built in 21–26 s on `standard-1` against 7.7–8.7 s on `standard-4`, colo held
 *  constant. That is a hedge, not an optimum: colo dominated (one colo took ~28 s at both sizes), and
 *  n was 3–5 per cell, so revisit with a powered experiment before spending more here. */
const BUILD_BOX_INSTANCE = 'standard-2';

/** The launch spec `ContainerBackend.connect()` passes with our options (no `containerPort`, no
 *  `containerEnv`, no `egress`), so the warm and the backend's start agree and the container is
 *  reused: computer relaunches a running container whose env, internet, image or size differ. */
const BUILD_BOX_LAUNCH_SPEC: ContainerLaunchSpec = {
  env: { PORT: '8080', MOUNT_POINT: '/workspace' },
  enableInternet: false,
  name: BUILD_BOX_IMAGE,
  instance: BUILD_BOX_INSTANCE,
};

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

/** The SHA-256 of `bytes`, as lowercase hex — the form the build job reports `indexSha256` in. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── The chat floor + the path rule (the source entries' own guards) ────────

/**
 * Guard: the CHAT FLOOR — DAG `write` at the chat node, the check a Message create runs
 * at the door. Every source entry (`readSource`, `writeSource`, `buildNow`) carries
 * `@mesh(requireChatWrite)`, so a collaborator who can
 * post — and whose post therefore triggers a turn that writes and builds under their own
 * claims — can make the same calls directly. A Galaxy admin passes through the confined
 * scope-admin bypass inside `requirePermission`, so nothing changes for the owner.
 *
 * Distinct from {@link requireDominionHere}, which stays on the Galaxy's configuration
 * entries: this guard reads the DAG grant, so it inherits `OrgTree.requirePermission`'s
 * obligations — the host-confined dominion bypass and the `PermissionDeniedError` message
 * a boundary refusal is told apart by (`security.md`).
 */
export function requireChatWrite(instance: Galaxy): void {
  instance.resources.orgTree.requirePermission(CHAT_NODE_ID, 'write');
}

/**
 * The path rule for a model- or client-chosen Workspace path, enforced IN THE ENTRIES
 * (`readSource` / `writeSource`) so a direct call and a loop tool agree. Normalises a
 * leading `./`, then refuses an absolute path and any `..` segment; for a WRITE, also
 * refuses every path whose first segment starts with `.` other than `.agents` —
 * `.platform/` and `.universe/` are mounts, `.nebula/` is machine-owned (the build writes its
 * compiled row there), `.git/` is git's, `.env` is where
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

export class Galaxy extends ScopedMeshDO implements ResourcesHost {
  // Cache over `ctx.storage` (the durable Workspace VFS) — reconstructed in onStart,
  // never the source of truth. `!`-asserted: onStart runs (inside the base
  // blockConcurrencyWhile) before any @mesh method. Read it through `#workspace()`,
  // which seeds the scaffold first; only that seed and the test seam touch it directly.
  #ws!: Workspace;
  // The scaffold seed in flight, so concurrent first uses share one (coordination, not data).
  #seeding?: Promise<void>;
  // Re-derivable cache (loss acceptable) — the tool-args typia validator facet
  // (durable-objects.md "ephemeral caches").
  #toolArgsFacet?: ParserValidator;
  // The composed resources plane — hosts the chat Chat/Message Resources.
  #resources!: Resources;
  // The container transport — the backend object is cheap coordination state (no
  // container starts until a build's exec connects); the API wrapper is constructed
  // LAZILY because its ctor throws where `ctx.container` is absent (vitest-plugin).
  #buildBackend!: ContainerBackend;
  #containerApi?: WorkspaceContainerAPI;
  // The promise-chain build latch — overlapping builds QUEUE on the one container
  // (never `blockConcurrencyWhile`, which would deafen the hub for the probe's
  // seconds — containers.md). In-memory coordination state, not business data.
  #buildChain: Promise<unknown> = Promise.resolve();
  // The same latch one level up, around the whole build-and-land, so each build compares the file
  // with the row only after the build before it has landed.
  #landChain: Promise<unknown> = Promise.resolve();
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
   *  reply commits with the door's verdict pinned (`TransactionOpts.pinnedAtDoor`). It
   *  went from 300 s to 840 s on 2026-09-06 when the round cap went to 32, and the same
   *  day Larry retired the older "must stay under the access TTL" coupling, which had
   *  tied a liveness knob to the token window for no property the design wants. */
  protected generationDeadlineMs = GENERATION_DEADLINE_MS;

  /** Reconstruct the Workspace (fs + host-side git over this DO's own SQLite) and register the
   *  container BACKEND (an inert object until a build's exec connects — no container is started
   *  here). The scaffold is seeded on first use instead, by {@link #workspace}. Async — runs
   *  inside the base `blockConcurrencyWhile`, so requests block until it completes
   *  (durable-objects.md § Initialization).
   *
   *  ⚠️ **No git here.** A deletion constructs every Galaxy it tears down, and a teardown needs
   *  nothing from the tree. The isomorphic-git `@cloudflare/computer` bundles (measured on 0.3.2) serializes
   *  index and ref writes through module-level locks keyed by path and ref name, so every Galaxy
   *  in one isolate shares them (`/workspace/.git/index`, `refs/heads/main`). With the seed here,
   *  deleting an account holding two cold apps seeded both at once under `wrangler dev`, and in
   *  two runs on 2026-10-03 one stopped inside `git.add` while the other finished, until the
   *  runtime reset it at 30 s, so its teardown never ran and its storage was never wiped. */
  override async onStart(): Promise<void> {
    // Construction is observable: `ctx.id.name`, since `onStart` runs before any identity is
    // stamped. A Gateway that refuses a frame proves itself by this never appearing.
    debug('nebula.Galaxy.onStart').debug('started', { name: this.ctx.id.name });
    this.#constructWorkspace();
    // Compose the resources plane — the chat Chat/Message host. The plane installs the chat
    // ontology from the source below on first touch, the way a Star installs its app ontology.
    // The post-commit hook is THE codegen trigger's seam: a committed human Message starts a
    // turn (#onChatCommitted's predicate owns what reacts).
    this.#resources = new Resources(
      this.ctx,
      () => this.lmz,
      this.#chatOntologySource(),
      (mutations) => this.#onChatCommitted(mutations),
    );
  }

  /**
   * The Workspace, with the framework scaffold seeded the first time anything here reads or writes
   * it (`container/app/`, embedded at generation time), so the tree is a COMPLETE vite project
   * before its first use — the build box mounts this very tree at /workspace, so seeding the VFS
   * is the whole delivery (no push step). Concurrent first uses share one seed, and a failed seed
   * is retried by the next use. Every host-side path lives under WS_ROOT: the mount serves that
   * SUBTREE of the VFS, never its root (build-report.ts § WS_ROOT). The repo roots there too, so
   * `.git` rides the mount like a normal checkout.
   */
  async #workspace(): Promise<Workspace> {
    if (!this.ctx.storage.kv.get(GIT_INITED_KEY)) {
      await (this.#seeding ??= this.#seedScaffold().finally(() => { this.#seeding = undefined; }));
    }
    return this.#ws;
  }

  async #seedScaffold(): Promise<void> {
    if (this.ctx.storage.kv.get(GIT_INITED_KEY)) return;
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

  /**
   * The Galaxy's chat-ontology source for its plane. It answers at once, so a Galaxy's op is never
   * told `checking`. The loader `bundleId` embeds the version label, which is bumped by hand
   * whenever the seed row changes (`scripts/gen-validator-seeds.ts` says so), so a new version
   * never reuses a warm bundle. Its `{u}.{g}/chat/{label}` form has two slashes, so it collides
   * neither with a Star's app bundle (`{u}.{g}/{version}`, or `{u}.{g}.dev/{version}` on `.dev`)
   * nor with the slash-less tool-args id.
   */
  #chatOntologySource(): OntologySource {
    return {
      current: () => this.ontologySource(),
      bundleId: (version) => `${this.lmz.instanceName ?? this.ctx.id.name}/chat/${version}`,
    };
  }

  /**
   * The chat ontology's current row — the platform seed. `protected` so a test subclass can answer
   * a newer row, the way a Star's Galaxy would.
   */
  protected ontologySource(): OntologyVersionRow {
    return chatOntologySeedRow();
  }

  /** The installed chat ontology, read from the plane; `protected` lets a test subclass assert
   *  the installed facet directly. */
  protected chatOntology(): { version: string; facet: ParserValidator; relationships: OntologyVersionRow['relationships'] } {
    return this.#resources.installedOntology();
  }

  // ─── Config ─────────────────────────────────────────────────────────

  @mesh(requireDominionHere) // a descendant Star's member is refused: dominion never flows up
  setGalaxyConfig(key: string, value: unknown) {
    const config = this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
    config[key] = value;
    this.ctx.storage.kv.put('config', config);
  }

  @mesh() // open to a descendant Star's member: shared galaxy config, read-only
  getGalaxyConfig(): Record<string, unknown> {
    return this.ctx.storage.kv.get<Record<string, unknown>>('config') ?? {};
  }

  // ─── The ontology each Star runs ────────────────────────────────────

  /**
   * The row the asking Star should run, chosen by which Star asks (ADR-024). The `.dev` Star gets
   * the last landed build's row ({@link isDevStarCall}). Every other caller gets the last
   * published row, and nothing is published until `publish()` exists, so a tenant Star installs
   * nothing and runs no data operation until then; tenant-Star tests come back with `publish()`.
   * A call with no context, such as a direct in-DO test call, gets the published answer too.
   * Bare `@mesh()`: an upward read every member of a descendant scope has passage for.
   */
  @mesh() // open to a descendant Star's member: the Star's own ontology pull reads it
  getCurrentOntology(): OntologyVersionRow | null {
    let callChain: CallContextLike['callChain'] | undefined;
    try { callChain = this.lmz.callContext.callChain; } catch { callChain = undefined; }
    const dev = isDevStarCall(callChain, this.lmz.instanceName ?? '');
    const row = dev ? this.#devOntologyRow() : null;
    // One marker per ask, stamped with the asking node, so a test can count asks per Star.
    debug('nebula.Galaxy.ontology').debug('current asked', {
      instanceName: this.lmz.instanceName, caller: callChain?.at(-1)?.instanceName, dev, version: row?.version,
    });
    return row;
  }

  /** The `.dev` Star's current row, copied here when its build landed — the one reader for
   *  {@link getCurrentOntology}, the served page's version, and personas' hand-off. */
  #devOntologyRow(): OntologyVersionRow | null {
    return this.ctx.storage.kv.get<OntologyVersionRow>(DEV_ONTOLOGY_ROW_KEY) ?? null;
  }

  // ─── Source of truth: the git Workspace ─────────────────────────────

  /**
   * The engine's core write: persist one edit to the working copy + `git commit`
   * (local, durable — the source-of-truth write). Returns the commit oid. There is
   * NO push step: the container's `/workspace` IS this tree via the FUSE mount
   * (containers.md § There is NO source-push step), and the built `dist/` is served
   * from this same VFS.
   *
   * Guarded at the chat floor ({@link requireChatWrite}), and the path rule runs FIRST
   * ({@link assertModelPath}): only the user-owned tree is writable. A call with a
   * client origin logs the acting principal's projection — the ADR-016 record for a
   * direct edit; a turn's writes carry it too, and the agent Message records the turn as a whole.
   */
  @mesh(requireChatWrite) // refused without `write` at the chat node, which no descendant holds by default
  async writeSource(path: string, content: string): Promise<{ oid: string; path: string }> {
    const rel = assertModelPath(path, { write: true });
    if (rel.includes('/')) {
      await (await this.#workspace()).fs.mkdir(wsPath(rel.slice(0, rel.lastIndexOf('/'))), { recursive: true });
    }
    await (await this.#workspace()).fs.writeFile(wsPath(rel), content);
    await (await this.#workspace()).git.add({ dir: WS_ROOT, paths: [rel] });
    const { oid } = await (await this.#workspace()).git.commit({ dir: WS_ROOT, message: `edit ${rel}` });
    const origin = this.#clientOrigin();
    debug('nebula.Galaxy.writeSource').debug('commit', {
      instanceName: this.lmz.instanceName,
      path: rel,
      oid,
      ...(origin ? { clientAddress: origin.clientAddress, actingToken: projectActingToken(origin.claims) } : {}),
    });
    return { oid, path: rel };
  }

  /** Local read — the LLM hot path (read relevant files into context). Chat floor;
   *  the path rule runs first (a read of a dot path is allowed — see
   *  {@link assertModelPath}). */
  @mesh(requireChatWrite) // refused without `write` at the chat node, which no descendant holds by default
  async readSource(path: string): Promise<string> {
    const rel = assertModelPath(path, { write: false });
    return (await this.#workspace()).fs.readFile(wsPath(rel), 'utf8');
  }

  /**
   * The client that made this call and the verified claims it rides, or `undefined` when
   * there is no client origin — a server-internal call, or a direct in-DO test call with
   * no mesh call context at all (reading `lmz.callContext` outside a call throws, and
   * that is the one case this tolerates).
   */
  #clientOrigin(): { clientAddress: string; claims: AuthClaims } | undefined {
    let cc: CallContextLike | undefined;
    try { cc = this.lmz.callContext; } catch { return undefined; }
    const origin = cc?.callChain[0];
    const claims = cc?.originAuth?.claims as AuthClaims | undefined;
    return origin?.type === 'LumenizeClient' && origin.instanceName && claims
      ? { clientAddress: addressOf(origin), claims }
      : undefined;
  }

  /** Read the ontology source + its content-addressed version (`hashBlob` of the
   *  `.d.ts`). The SINGLE source of the version a build lands with, so a
   *  Star's lazy-pull and the client's pinned version agree by construction. */
  async #readOntology(): Promise<{ types: string; version: string }> {
    const types = await (await this.#workspace()).fs.readFile(wsPath(ONTOLOGY_PATH), 'utf8');
    const { oid: version } = await git.hashBlob({ object: types });
    return { types, version };
  }

  // ─── HTTP surface: the built app's serve + the build-box dial-back ──

  /** The paths {@link onRequest} dispatches on, and the only ones: `npm run audit:do-http` holds it to these. */
  static override readonly HTTP_PREFIXES: readonly string[] = [GATEWAY_PREFIX, PUBLIC_PREFIX, '/api'];

  /**
   * The Galaxy's HTTP surface: two tracks, each on a prefix its own caller alone produces.
   *
   *  - **Pages, under `/_public/`.** The Worker's page step forwards a Star's or persona's host here
   *    through the page track (`page-forward.ts`), naming the Star in its own header, so a page on
   *    `dev.crm.acme.lumenize.dev` reaches the built app and nothing else.
   *  - **The build box, at `/api`.** The in-container `computerd` daemon dials back over the
   *    workspace proxy on the path `@cloudflare/computer` fixes, whose upgrade it refuses without
   *    the client secret it minted. No page forward produces it.
   *
   * Everything else goes to `ScopedMeshDO`'s, which accepts a Client's upgrade under `/gateway/` and
   * answers 404 to the rest — the data plane rides the mesh, never HTTP.
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api') {
      return this.#buildBackend.handleFetch(request);
    }
    if (url.pathname === PUBLIC_PREFIX || url.pathname.startsWith(`${PUBLIC_PREFIX}/`)) {
      return this.#serveBuiltApp(request, url);
    }
    return super.onRequest(request);
  }

  /**
   * Serve the built app from this DO's own VFS to a page on one of this Galaxy's Star hosts. The
   * page track names the Star in {@link PUBLIC_SCOPE_HEADER}, and it must be one of this Galaxy's:
   * `.dev` serves {@link DEV_SERVED_DIR}, the copy the last landing made, so a build the model held
   * back is served nowhere; any other star is the published `dist-prod/` tier (deferred — 404 until
   * it exists). `serve.ts` owns the match-first/SPA/caching/containment contract; the page meta is
   * injected here because only this side knows the routed identity (never request-supplied — the
   * wrong-Star footgun guard).
   */
  async #serveBuiltApp(request: Request, url: URL): Promise<Response> {
    const star = request.headers.get(PUBLIC_SCOPE_HEADER) ?? '';
    const segs = star.split('.');
    const galaxy = this.lmz.instanceName;
    if (segs.length !== 3 || segs.some((s) => s.length === 0) || `${segs[0]}.${segs[1]}` !== galaxy) {
      return new Response('Not Found', { status: 404 });
    }
    if (segs[2] !== 'dev') {
      // The published tier (dist-prod/, one copy for every tenant star) is the
      // fast-follow's; answering 404 rather than serving the dev tree is the pin
      // that keeps "same homogeneous path" from meaning one-dist-for-all.
      return new Response('Not Found', { status: 404 });
    }
    // The page's own path, served at the root of its host.
    const pagePath = url.pathname.slice(PUBLIC_PREFIX.length) || '/';
    const page = new Request(new URL(`${pagePath}${url.search}`, url), request);
    // The bytes of the `index.html` this serve read, kept for its build version.
    let indexBytes = null as Uint8Array<ArrayBuffer> | null;
    const res = await serveApp(
      page,
      { directory: DEV_SERVED_DIR, not_found_handling: 'single-page-application', base: '/' },
      async (path) => {
        const bytes = await this.#readBytes(path); // an absolute VFS path, outside `/workspace`
        if (path === `${DEV_SERVED_DIR}/index.html`) indexBytes = bytes;
        return bytes; // a miss is null — the SPA fallback owns it
      },
    );
    if (res === null) return new Response('Not Found', { status: 404 });
    // The page meta, injected only into HTML serves; asset serves pass through untouched.
    if ((res.headers.get('Content-Type') ?? '').includes('text/html')) {
      const deployment = deploymentOrigin(this.env);
      const scopeMeta = JSON.stringify({
        // Whether this page is the dev Star, which Studio frames as the as-you dev tab.
        dev: true,
        // The origin a framed page posts its auth state to: this galaxy's Studio, the only page
        // allowed to frame it (`frame-ancestors`, set by the Worker's page step).
        parentOrigin: hostOrigin({ kind: 'scope', scope: galaxy }, deployment, url.origin),
        // The row getCurrentOntology answers the `.dev` Star with — one definition of
        // "current", so the version a client pins here is the one its Star will install.
        //
        // ⚠️ ABSENT rather than empty when no build has landed an ontology, and `JSON.stringify`
        // drops it. An app with no resources never compiles one, and it is still an app: the
        // client boots without a version and refuses only resource ops. A `?? ''` made that case
        // indistinguishable from a real version to every reader, and the scaffold's
        // `createNebulaClient` threw on it — a freshly generated preview blanked at mount.
        ontologyVersion: this.#devOntologyRow()?.version,
        // The build version (ADR-024): the digest of the `index.html` this page was served, the
        // same digest the build job reported as `bundle.indexSha256`. Computed from the file
        // rather than stored, so it names exactly what the page received.
        buildVersion: indexBytes ? await sha256Hex(indexBytes) : undefined,
      }).replace(/'/g, '&#39;'); // the meta rides a single-quoted attribute
      return new HTMLRewriter()
        .on('head', {
          element(el) {
            el.prepend(`<meta name="${LUMENIZE_ORIGIN_META}" content="${deployment}">`, { html: true });
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
   * the build and nothing else — {@link #buildAndLand} owns the landing, one level up,
   * where a faked success lands exactly like a real one. The seam's report
   * carries a placeholder `preview` the layer above overwrites.
   */
  protected build(opts: BuildJobOpts = {}): Promise<BuildReport> {
    const run = this.#buildChain.then(() => this.#buildOnce(opts));
    this.#buildChain = run.catch(() => { /* the next cycle starts clean */ });
    return run;
  }

  /**
   * A build plus its landing, queued — **the only way callers should build.** The codegen loop's
   * `build` tool (through the `buildNow` entry) and a direct `buildNow()` both go through here. A
   * build that lands records `.dev`'s newest `ServedBuild`, and every Studio subscribed to the
   * `ServedBuild` query hears every landing, whoever asked for the build.
   *
   * When `src/ontology.d.ts` differs from the `.dev` Star's current row, its version rides
   * the job, and the row the job compiles becomes current when the build lands
   * ({@link decideLanding}). So the `.dev` Star runs the last build the model previewed, and
   * nothing a build compiles reaches any other Star.
   *
   * Queued whole: a build compared before the one ahead of it landed would read the old row, so a
   * file reverted between two builds would leave the newer row current over the older source.
   *
   * ⚠️ Deliberately ABOVE {@link build}, which is the test seam, so a faked build lands exactly
   * as a real one does.
   */
  #queueBuild(opts: { preview?: boolean } = {}): Promise<BuildReport> {
    const run = this.#landChain.then(() => this.#buildAndLand(opts));
    this.#landChain = run.catch(() => { /* the next build starts clean */ });
    return run;
  }

  async #buildAndLand(opts: { preview?: boolean }): Promise<BuildReport> {
    const jobOpts: BuildJobOpts = { ontology: await this.#pendingOntology() };
    // Marker: the cycle's start — "the warm precedes the build" is asserted on the order
    // of this marker and the warm's, within one Galaxy (`instanceName` is the discriminator
    // `testing.md` asks every marker to carry).
    debug('nebula.Galaxy.build').debug('cycle start', { instanceName: this.lmz.instanceName, ontology: Boolean(jobOpts.ontology) });
    const report = await this.build(jobOpts);
    // A clean report does not prove the dist ARRIVED: the vendor's post-exec pull
    // swallows its own failure (outcome resolves `status: "pending"`, applied 0, no
    // throw), and local materialize-mode change detection can miss vite's last writes
    // on the bracket — either way the landing would copy a stale or empty dist. The
    // DELIVERY fix is upstream: the job never empties `dist` (job.ts says why the pull
    // lost the empty-then-rewrite), and {@link #buildOnce} verifies arrival by digest
    // before its teardown. This check is the backstop that keeps the residual loss loud,
    // and the landing reads it. It runs whether or not a container ran, so the test seams
    // write the dist they report.
    const arrived = report.bundle.ran && report.bundle.ok === true
      && await this.#distArrived(report.bundle.indexSha256);
    const ontologyVersion = jobOpts.ontology?.version;
    let preview = decideLanding(report, { arrived, ontologyVersion, preview: opts.preview });
    if (preview.refreshed) preview = await this.#land(report, preview, ontologyVersion);
    debug('nebula.Galaxy.landing').info('decided', {
      instanceName: this.lmz.instanceName, lands: preview.refreshed, why: preview.why, version: ontologyVersion,
    });
    return { ...report, preview };
  }

  /**
   * The Workspace's pending ontology change, if any: the content-addressed version
   * (`git.hashBlob` of `src/ontology.d.ts`) when it differs from the `.dev` Star's current
   * row. A build that did not touch the file compiles nothing.
   */
  async #pendingOntology(): Promise<{ version: string } | undefined> {
    let version: string;
    try {
      ({ version } = await this.#readOntology());
    } catch {
      return undefined; // no ontology file yet
    }
    return version === this.#devOntologyRow()?.version ? undefined : { version };
  }

  /**
   * Land a build {@link decideLanding} let through, in an order that leaves `.dev` serving one
   * whole build at every moment: check the compiled row, copy the build's files from
   * `/workspace/dist/` to {@link DEV_SERVED_DIR} with `index.html` last, make the row the `.dev`
   * Star's at once after it, record the build as `.dev`'s newest `ServedBuild`, then remove what
   * the build no longer has. A page served mid-copy gets
   * the old `index.html`, whose hashed assets are still there, or the new one, and the row follows
   * `index.html` immediately, so no page is served old code pinned at the new ontology version.
   *
   * The row is stored only when its own types hash to the version the host asked for: a stale row
   * file from an earlier build, or one a chat write changed between the host's hash and the job's
   * compile, would otherwise land a validator under the wrong version, and the Star's Worker Loader
   * cache keys on the version. The hash is the whole check, since a version IS the hash of its
   * types, so the label the file carries is never read; the stored row is built from its named
   * fields, never spread from the file. A refused step lands nothing and returns why.
   */
  async #land(
    report: BuildReport, landed: BuildReport['preview'], ontologyVersion: string | undefined,
  ): Promise<BuildReport['preview']> {
    const log = debug('nebula.Galaxy.landing');
    const instanceName = this.lmz.instanceName;
    let row: OntologyVersionRow | undefined;
    if (ontologyVersion !== undefined) {
      try {
        const file = JSON.parse(await (await this.#workspace()).fs.readFile(wsPath(ROW_PATH), 'utf8')) as OntologyVersionRow;
        const { oid } = await git.hashBlob({ object: file.types });
        if (oid !== ontologyVersion) {
          log.warn('refused: the compiled row does not match the version asked for', {
            instanceName, expected: ontologyVersion, typesHash: oid,
          });
          return { refreshed: false, why: 'the compiled types do not match the version the build was asked for — build again' };
        }
        row = { version: ontologyVersion, types: file.types, validatorBundle: file.validatorBundle, relationships: file.relationships };
      } catch (e) {
        log.error('refused: the compiled row could not be read', { instanceName, expected: ontologyVersion, error: e });
        return { refreshed: false, why: 'the compiled ontology row could not be read — build again' };
      }
    }
    // The file list comes from a box that runs the app's own `vite.config.ts`, so a path that
    // leaves `dist/` is refused before anything is copied.
    const files = report.bundle.files ?? ['index.html'];
    if (files.some((f) => f.startsWith('/') || f.split('/').includes('..'))) {
      log.warn('refused: the build reported a file outside dist/', { instanceName });
      return { refreshed: false, why: 'the build reported a file outside dist/ — build again' };
    }
    let index: Uint8Array<ArrayBuffer>;
    try {
      for (const f of files) if (f !== 'index.html') await this.#copyToServed(f);
      index = await this.#copyToServed('index.html');
    } catch (e) {
      log.error('refused: the build could not be copied', { instanceName, error: e });
      return { refreshed: false, why: 'the build could not be copied to where .dev serves it — build again' };
    }
    if (row) this.ctx.storage.kv.put(DEV_ONTOLOGY_ROW_KEY, row);
    // Named from the bytes `.dev` now serves, the digest the page's meta carries, so the record
    // and the page agree even if `dist/index.html` changed after the build reported its digest.
    await this.#recordServedBuild(await sha256Hex(index));
    // A report with no file list says nothing of what to keep, so nothing is removed.
    if (report.bundle.files) await this.#pruneServed(files);
    log.info('landed', { instanceName, version: ontologyVersion, files: files.length });
    return landed;
  }

  /**
   * Record a landed build as `.dev`'s newest `ServedBuild`, which every Studio on the app hears
   * through its query on the chat. A fresh id each time, so a row a participant forged or deleted
   * never keeps the next landing from being the newest. It is written as the build's caller:
   * inside a turn ({@link turnContext}) the poster, with the platform as actor, the record every
   * agent write carries; outside, the direct `buildNow` caller, with no actor. Either way under
   * the verdict of the door that admitted the build (`pinnedAtDoor`), the post or `buildNow`'s
   * `requireChatWrite`, since `.dev` has already moved and nothing may refuse the record now. A
   * failure is logged and the landing stands: `.dev` serves the build either way.
   */
  async #recordServedBuild(buildVersion: string): Promise<void> {
    try {
      await this.#resources.ensureResource(crypto.randomUUID(), 'ServedBuild', CHAT_NODE_ID,
        { chat: DEFAULT_CHAT_ID, star: 'dev', buildVersion },
        { ...(turnContext.getStore() ? { actor: { sub: NEBULA_SUB, profileId: NEBULA_SUB } } : {}), pinnedAtDoor: true });
    } catch (e) {
      debug('nebula.Galaxy.landing').error('served build not recorded', { instanceName: this.lmz.instanceName, buildVersion, error: e });
    }
  }

  /** Copy one built file, workspace-relative under `dist/`, to {@link DEV_SERVED_DIR} when it is
   *  absent there or its bytes differ, and return the bytes now served. Compared by content, never
   *  by name: vite copies `public/` files unchanged, and a name that merely looks hashed can carry
   *  new bytes. */
  async #copyToServed(rel: string): Promise<Uint8Array<ArrayBuffer>> {
    const fs = (await this.#workspace()).fs;
    const bytes = await this.#readBytes(wsPath(`dist/${rel}`));
    if (bytes === null) throw new Error(`built file missing: dist/${rel}`);
    const target = `${DEV_SERVED_DIR}/${rel}`;
    const served = await this.#readBytes(target);
    if (served && sameBytes(served, bytes)) return bytes;
    if (rel.includes('/')) await fs.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    else await fs.mkdir(DEV_SERVED_DIR, { recursive: true });
    await fs.writeFile(target, bytes);
    return bytes;
  }

  /** Remove from {@link DEV_SERVED_DIR} every file the landed build does not have. */
  async #pruneServed(files: string[]): Promise<void> {
    const keep = new Set(files);
    const fs = (await this.#workspace()).fs;
    const walk = async (rel: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory: boolean }>;
      try { entries = await fs.readdir(rel ? `${DEV_SERVED_DIR}/${rel}` : DEV_SERVED_DIR); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory) { await walk(r); continue; }
        if (!keep.has(r)) {
          try { await fs.rm(`${DEV_SERVED_DIR}/${r}`, { force: true }); } catch { /* best effort */ }
        }
      }
    };
    await walk('');
  }

  /** A file's bytes from this Galaxy's VFS, by absolute path, or `null` when it cannot be read. */
  async #readBytes(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const stream = await (await this.#workspace()).fs.readFile(path);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * One ephemeral container cycle running the BUILD JOB (`node /build/job.cjs` — the
   * image-bundled `container/compiler/job.ts`): ontology compile, SFC type check and
   * `vite build`, every step reported, and the bundle skipped when the compile it ran
   * failed, so a page never lands over types that did not compile. Then destroy — a fresh
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
      // `cwd` is the mount root: the workspace IS the app project. `version` is
      // HOST-computed and passed IN via env; the landing checks the row against it.
      const handle = await (await this.#workspace()).runtime.exec('node /build/job.cjs', {
        cwd: '/workspace',
        encoding: 'utf8',
        env: {
          ...BUILD_ENV,
          ...(opts.ontology ? { ONTOLOGY_VERSION: opts.ontology.version } : {}),
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
        // landing in {@link #buildAndLand} refusing a dist that did not arrive, loudly.
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
        debug('nebula.Galaxy.build').error('stuck-flag signature observed', { error: e });
      }
      this.#destroyBuildContainer();
      return skipped(message);
    }
  }

  /** Did the built `dist` arrive in this DO's VFS? The delivery check behind the
   *  pre-teardown arrival check in {@link #buildOnce} and the landing in
   *  {@link #buildAndLand}. With `expectedSha256` (the job's digest of the
   *  `index.html` it wrote) the check is for THAT dist: a stale one from an earlier
   *  build reads as not arrived, which a presence check let through on 2026-09-06
   *  (a pull that applied nothing, and the previous build's dist answering for it). */
  async #distArrived(expectedSha256?: string): Promise<boolean> {
    try {
      // Read as text, the way every other host-side read of this VFS is: vite's index.html
      // is UTF-8, so re-encoding is byte-exact and the digest matches the job's.
      const text = await (await this.#workspace()).fs.readFile(wsPath('dist/index.html'), 'utf8');
      if (!expectedSha256) return true;
      return await sha256Hex(new TextEncoder().encode(text)) === expectedSha256;
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
      try { entries = await (await this.#workspace()).fs.readdir(wsPath(rel ? `dist/${rel}` : 'dist')); } catch { return; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory) { await walk(r); continue; }
        if (!keep.has(r)) {
          try { await (await this.#workspace()).fs.rm(wsPath(`dist/${r}`), { force: true }); } catch { /* best effort */ }
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
    this.#buildBackend = new ContainerBackend({
      // Lazy thunks all the way down: `WorkspaceContainerAPI`'s ctor throws where
      // `ctx.container` is absent (vitest-plugin), so nothing constructs it until the
      // backend actually connects for a build.
      container: () => ({
        getWorkspaceContainer: () => (this.#containerApi ??= new WorkspaceContainerAPI(this.ctx)),
      }),
      workspace: { binding: 'GALAXY', id: this.ctx.id.toString() },
      name: BUILD_BOX_IMAGE,
      instance: BUILD_BOX_INSTANCE,
    });
    this.#ws = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      git: createGitClient(),
      defaultGitIdentity: GIT_AUTHOR,
      backends: [this.#buildBackend],
    });
  }

  /**
   * Before a teardown wipes this Galaxy, destroy its build container, awaited and whatever its
   * state: a container still running could otherwise name the fresh object. Unlike
   * {@link #destroyBuildContainer}, which is deliberately not awaited, and gating on nothing,
   * since `running` can be stale (`containers.md`). Every failure is tolerated and no build marker
   * is logged.
   */
  protected override async beforeTeardown(): Promise<void> {
    // The certificate's steps lead (certificate.ts `teardownSteps`): `disarm` runs before any
    // `await`, so a wake or an alarm arriving mid-teardown orders nothing. `wipe` is the base
    // teardown's own, after this returns.
    const steps = teardownSteps(this.ordersCertificates(), this.#certificateOrder !== undefined);
    for (const step of steps) {
      if (step === 'disarm') this.#disarmCertificate();
      else if (step === 'awaitOrder') await this.#awaitCertificateOrder();
      else if (step === 'deletePacksNamingHost') await this.#deletePacksNamingHost();
    }
    try { await this.ctx.container?.destroy(); } catch { /* nothing running, or the 1006 */ }
  }

  // ─── The certificate pack (certificate.ts) ──────────────────────────────────
  // Coordination, not data (`containers.md`'s latch): the order in flight, and whether a teardown
  // has begun. Both die with the object, which the teardown aborts anyway.
  #certificateOrder?: Promise<void>;
  #tearingDown = false;
  /** How long a teardown waits for an order in flight before listing packs. `protected` so a test
   *  can shorten it, the way `generationDeadlineMs` is. */
  protected certificateOrderWaitMs = CERTIFICATE_ORDER_WAIT_MS;

  /** Whether this deployment orders certificates: only an `https` origin does. A seam for tests. */
  protected ordersCertificates(): boolean {
    return new URL(deploymentOrigin(this.env)).protocol === 'https:';
  }

  /** Cloudflare's certificate-packs API for this deployment's zone, or `undefined` where no token
   *  or zone is configured, which the deploy preflight refuses for an `https` origin. A seam for
   *  tests. */
  protected certificateApi(): CertificateApi | undefined {
    // The token is a deployed Worker's secret, empty on a local stack; the zone id is a var.
    const { CERTIFICATE_API_TOKEN, CERTIFICATE_ZONE_ID } = this.env;
    if (!CERTIFICATE_API_TOKEN || !CERTIFICATE_ZONE_ID) return undefined;
    return cloudflareCertificateApi(CERTIFICATE_ZONE_ID, CERTIFICATE_API_TOKEN);
  }

  /** This galaxy's own host, which its pack names beside its wildcard: `crm.acme.lumenize.dev`. */
  #galaxyHost(): string {
    return new URL(hostOrigin({ kind: 'scope', scope: this.lmz.instanceName ?? '' }, deploymentOrigin(this.env))).hostname;
  }

  #certificateState(): CertificateState {
    return (this.ctx.storage.kv.get(CERTIFICATE_KEY) as CertificateState | undefined) ?? { wanted: false };
  }

  /**
   * Wake this galaxy's certificate order — the auth layer's `orderCertificate` hook, after a create or a
   * claim's acceptance. `@rawRpc()`, never `@mesh()`: no client may make a Galaxy spend a pack, so a
   * Galaxy nobody created never orders one (ADR-023). It records that a pack is wanted and arms the
   * alarm, which is the one caller of Cloudflare's API, so two wakes order once.
   *
   * Logs its marker first, with `this.lmz.instanceName` read with no fallback, so an entry that
   * stamped nothing shows as a missing name. An `http` origin orders nothing.
   */
  @rawRpc()
  async orderCertificate(operationId: string): Promise<void> {
    debug('nebula.Galaxy.orderCertificate').info('wake', { instanceName: this.lmz.instanceName, operationId });
    if (!this.ordersCertificates()) return;
    const { state, arm } = onWake(this.#certificateState(), this.#tearingDown);
    this.ctx.storage.kv.put(CERTIFICATE_KEY, state);
    if (arm) this.svc.alarms.schedule(0, this.ctn<Galaxy>().certificateAlarm(), { id: CERTIFICATE_ALARM_ID });
  }

  /**
   * The certificate alarm: makes the one API call {@link nextCall} names, stores what it answered,
   * and re-arms as {@link afterCall} says. Reached only from this Galaxy's own alarm, so it carries no
   * `@mesh()`. The call runs in the latch a teardown waits on.
   */
  async certificateAlarm(): Promise<void> {
    const call = nextCall(this.#certificateState(), this.#certificateOrder !== undefined, this.#tearingDown);
    if (call.kind === 'none') return;
    const log = debug('nebula.Galaxy.certificate');
    const api = this.certificateApi();
    if (!api) {
      log.error('no certificate token or zone is configured; nothing ordered', { host: this.#galaxyHost() });
      return;
    }
    const run = (async () => {
      const result = call.kind === 'order'
        ? await api.order(packHosts(new URL(deploymentOrigin(this.env)).hostname, this.#galaxyHost()))
        : await api.get(call.packId);
      // A teardown under way lists packs by host, so an order that lands now is still found.
      if (this.#tearingDown) return;
      const { state, rearmSeconds } = afterCall(this.#certificateState(), result);
      this.ctx.storage.kv.put(CERTIFICATE_KEY, state);
      // A pack that ended anywhere but `active` leaves the host without a certificate.
      const failed = result.ok && result.status !== 'active' && isFinalStatus(result.status);
      log[failed ? 'error' : 'info'](call.kind === 'order' ? 'ordered' : 'polled', {
        host: this.#galaxyHost(), ok: result.ok, ...(result.ok ? { packId: result.packId, status: result.status } : {}),
      });
      if (rearmSeconds !== undefined) {
        this.svc.alarms.schedule(rearmSeconds, this.ctn<Galaxy>().certificateAlarm(), { id: CERTIFICATE_ALARM_ID });
      }
    })();
    this.#certificateOrder = run;
    try { await run; } finally { if (this.#certificateOrder === run) this.#certificateOrder = undefined; }
  }

  /** Teardown's first step, synchronous: no wake or alarm after it orders, and none is pending. */
  #disarmCertificate(): void {
    this.#tearingDown = true;
    this.svc.alarms.cancelSchedule(CERTIFICATE_ALARM_ID);
    this.ctx.storage.kv.put(CERTIFICATE_KEY, { wanted: false } satisfies CertificateState);
  }

  /** Wait, with a bound, for an order already in flight, so the listing after it sees its pack. */
  async #awaitCertificateOrder(): Promise<void> {
    const order = this.#certificateOrder;
    if (!order) return;
    const outcome = await Promise.race([
      order.then(() => 'returned', () => 'returned'),
      new Promise<string>((resolve) => setTimeout(() => resolve('outlived'), this.certificateOrderWaitMs)),
    ]);
    if (outcome === 'outlived') {
      debug('nebula.Galaxy.certificate').error('an order outlived the teardown wait; its pack may survive', { host: this.#galaxyHost() });
    }
  }

  /**
   * Delete every pack naming this galaxy's host, found by host through the API rather than by the id
   * in storage, so an order that returned during teardown is found too. A failed list or delete is
   * logged at error, naming the pack and host, and the wipe goes ahead: a deleted scope's data never
   * waits on Cloudflare's API.
   */
  async #deletePacksNamingHost(): Promise<void> {
    const log = debug('nebula.Galaxy.certificate');
    const host = this.#galaxyHost();
    const api = this.certificateApi();
    if (!api) {
      log.error('no certificate token or zone is configured; no pack deleted', { host });
      return;
    }
    let packs;
    try { packs = await api.list(); } catch (e) {
      log.error('certificate packs could not be listed; none deleted', { host, error: e });
      return;
    }
    for (const pack of packs.filter((p) => packNamesGalaxy(p.hosts, host))) {
      try {
        await api.delete(pack.id);
        log.info('pack deleted', { packId: pack.id, host });
      } catch (e) {
        log.error('certificate pack delete failed', { packId: pack.id, host, error: e });
      }
    }
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
   * returns to the caller's `callAsync`. `preview` is the model's call on whether a build with
   * type findings lands, or whether a clean one is held back ({@link decideLanding}); a changed
   * `src/ontology.d.ts` rides the job, and its row becomes the `.dev` Star's when the build lands.
   * `preview` is the only option passed on, so nothing a caller sends decides how its landing is
   * recorded.
   *
   * Every in-process caller has already passed the chat floor: the loop's `build` tool runs inside
   * a turn whose post passed the Message create's DAG `write` at the chat node, the same check
   * `requireChatWrite` makes here, and the landing records under that verdict.
   */
  @mesh(requireChatWrite) // refused without `write` at the chat node, which no descendant holds by default
  buildNow(opts: { preview?: boolean } = {}): Promise<BuildReport> {
    return this.#queueBuild({ preview: opts.preview });
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
      // `waitUntil` holds the Galaxy for the detached turn — see RESIDENCY in runTriggeredTurn.
      this.ctx.waitUntil(this.runTriggeredTurn(resourceId, content).catch((e) => {
        debug('nebula.Galaxy.trigger').error('triggered turn threw', {
          resourceId, error: e,
        });
      }));
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
    // in-flight request pins the Galaxy. What holds it is `ctx.waitUntil`, which the
    // commit trigger hands the turn: from compatibility date 2026-10-01 that keeps a DO
    // in memory for up to 15 minutes from the promise's start, and the generation
    // deadline below (14 min) keeps every turn under that. Before that date nothing
    // held a production turn: it calls the model through the `env.AI` BINDING (neither
    // deployed worker has a `WORKERS_AI_TOKEN`, so `modelLane()` never takes the REST
    // lane), and a detached binding call was evicted as early as a timer, about 70 s
    // (durable-objects.md § Wall-clock billing). A timer heartbeat is not the hold
    // either: it held nothing at the old date, and `waitUntil` states the hold directly.
    // An eviction mid-turn — a restart or a deploy — is covered as designed: input is
    // durable before the LLM runs, the in-memory latch dies with the isolate, and a
    // fresh message starts a fresh generation.
    // The GENERATION DEADLINE stays: past it the latch releases and the turn surfaces
    // as failed server-side (the client's idle timeout owns the UX), so a hung
    // await cannot wedge the loop for the rest of the 15-minute hold.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        turnContext.run(true, () => this.#chatTurn(userMessageId, content)),
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
      () => this.#chatProgress(agentMessageId, '', userMessageId),
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
    try { sourceCommit = (await (await this.#workspace()).git.log({ dir: WS_ROOT, depth: 1 }))[0]?.oid; } catch { /* fresh repo */ }
    const result = await this.runCodegenTurn(
      message, DEFAULT_LOOP_CONFIG,
      (step) => this.#chatProgress(agentMessageId, step, userMessageId),
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
    // A turn whose last build did not land says so in our own words, whatever the model wrote,
    // so it never reads as done while the preview still shows the last build.
    const heldBack = result.stop === 'build-unavailable' ? undefined : heldBackLine(result.lastBuild);
    const fallback = result.stop === 'complete'
      ? completedTurnFallback(result.appliedPaths.length, result.lastBuild)
      : result.stop === 'no-tool-calls'
        ? 'See the thought process.'
        : result.stop === 'build-unavailable'
          ? 'Your changes are saved, but the build box could not run just now, so the preview is unchanged. Ask me to build again in a moment.'
          : result.stop === 'error'
            ? `I couldn't finish — ${result.detail}. Try again in a moment.`
            : "I couldn't finish cleanly — see the thought process.";
    const reply = [text || fallback, heldBack].filter(Boolean).join('\n\n');

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
    // (No reload is asked for here: a turn's last build that landed recorded `.dev`'s newest
    // `ServedBuild`, which every Studio on the app hears, as a manual `buildNow()`'s does.)
  }

  /**
   * Speculatively start the build container — from the turn's latch, so at most once a
   * turn, on the first write (the structural warm). The cold start + mount then hides
   * behind the generation and the build tool's exec finds the box up. Fire-and-forget: a warm
   * failure costs nothing (the exec's own connect starts it) and must never delay the
   * model. A no-container environment (vitest-plugin) is a silent no-op. `protected` so
   * the drive log can be asserted — one warm per turn.
   */
  protected warmBuildBox(): void {
    // The marker precedes the container guard ON PURPOSE: "exactly one warm per turn" is
    // asserted on this marker's count, in-lane included (where ctx.container is absent
    // and the start below is a no-op).
    debug('nebula.Galaxy.warm').info('container warm fired', { instanceName: this.lmz.instanceName });
    if (!this.ctx.container) return;
    try {
      // The spec MUST equal the backend's own: `WorkspaceContainerAPI.start` reuses a running
      // container only when it was launched with the same spec, and relaunches otherwise, so a
      // mismatch would turn the warm into a wasted boot. The backend's defaults are port 8080 and
      // egress `{ mode: 'none' }`, hence no internet — deps are fully baked.
      void (this.#containerApi ??= new WorkspaceContainerAPI(this.ctx)).start(BUILD_BOX_LAUNCH_SPEC).catch((e: unknown) => {
        debug('nebula.Galaxy.warm').warn('warm start failed (non-fatal — exec will retry)', { error: e });
      });
    } catch (e) {
      debug('nebula.Galaxy.warm').warn('warm start threw (non-fatal)', { error: e });
    }
  }

  // ─── Resource plane (the chat Chat/Message Resources) ─────────
  //
  // The passage step (ScopedMeshDO base) enforces passage into `{u}.{g}`; the per-op DAG read/write
  // check lives inside the plane, exactly as on Star. (The source entries above put that same
  // chat-node `write` check ON the decorator — `requireChatWrite` — because they do no per-op
  // check of their own.)

  /**
   * Stream one transient progress chunk of the agent's reply to the chat's subscribers. The chat
   * query is built here, since the plane never names `Message` or the chat; the plane sends the
   * chunk ({@link Resources.streamProgress}) to the subscribers who may read
   * `CHAT_NODE_ID`, the node the reply will be committed under, attributed to the human message
   * whose turn it is.
   */
  #chatProgress(agentMessageId: string, progress: string, userMessageId: string): void {
    const chatQuery: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };
    this.#resources.streamProgress(chatQuery, agentMessageId, progress, CHAT_NODE_ID, userMessageId);
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
    await this.#resources.ensureResource(messageId, 'Message', nodeId, value, {
      actor: { sub: NEBULA_SUB, profileId: NEBULA_SUB }, pinnedAtDoor: true,
    });
  }

  /**
   * The one `@mesh()` door onto the resource plane — its request surface, whose members derive
   * the caller's own address and check each op themselves. Chat participants are non-admin, so
   * there is no guard on the door: each op's DAG check at the chat node is the gate, and a
   * transaction's has no `actor` argument, so a client cannot forge `act: { sub: NEBULA_SUB }` —
   * only host code calling `ensureResource` supplies one: the agent's reply and a turn's landing.
   */
  @mesh() // open to a descendant Star's member: each member behind the door checks itself
  get resources(): ResourcesRequests {
    return this.#resources.requests;
  }
  /**
   * The plane's response-leg surface — where a failed update's reaper and the node invite's
   * facade answer land. Deliberately NOT `@mesh()`: those answers arrive locally or at the
   * fire-back door, and neither checks for `@mesh()`. Every host's surface also carries
   * `onOntologyPulled`, which checks no permission and installs whatever row it is handed, so
   * `@mesh()` would let any caller with passage load a validator of their own onto this Galaxy.
   */
  get resourcesResults(): ResourcesResults {
    return this.#resources.results;
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
    // WORKERS_AI_TOKEN / CLOUDFLARE_ACCOUNT_ID / CF_AI_GATEWAY come from `.dev.vars`, and
    // `.dev.vars.example` types them on `Env` as strings; a deployed Worker sets none of them,
    // so each read here treats missing and empty alike.
    const env = this.env;
    if (this.modelLane() === 'rest') return this.#callModelRest(env, env.WORKERS_AI_TOKEN, model, body, onDelta);
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
    return this.env.WORKERS_AI_TOKEN ? 'rest' : 'binding';
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
   * **Never log the token or the `Authorization` header** (critical.md); errors carry the
   * URL `pathname` + status only (the token rides the header, never the URL). A refused call
   * logs the provider's whole body at warn, beside identifiers and nothing from `headers`.
   */
  async #callModelRest(
    env: { CLOUDFLARE_ACCOUNT_ID?: string; CF_AI_GATEWAY?: string },
    token: string,
    model: string,
    body: Record<string, unknown>,
    onDelta?: (text: string) => void,
  ): Promise<unknown> {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) throw new Error('Workers AI REST path needs CLOUDFLARE_ACCOUNT_ID');
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const headers = workersAiRestHeaders({ token, gateway: env.CF_AI_GATEWAY, extra: this.modelCallHeaders() });
    const payload = JSON.stringify(body);
    // A refused call is retried twice with backoff (`Retry-After` when the service says,
    // else 5 s then 15 s): Workers AI answers 429 under the sweep's call volume, and on
    // 2026-09-06 one 429 ended a turn with no reply while the client waited on nothing.
    // Past the retries it fails into the loop's controlled error, which still replies.
    let resp: Response;
    let attempt = 0;
    for (; ; attempt++) {
      resp = await this.restFetch(url, { method: 'POST', headers, body: payload });
      if (resp.ok || attempt >= 2 || !(resp.status === 429 || resp.status >= 500)) break;
      await resp.body?.cancel().catch(() => { /* nothing to free */ });
      const retryAfter = Number(resp.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 30) * 1000 : [5_000, 15_000][attempt]!;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!resp.ok) {
      // A 400 is not retried and only its body says why. The error, which becomes the reply,
      // carries it bounded; the log carries it whole, because a nested `AiError` runs past
      // any bound a reply can hold (2026-10-12: two sweeps' build turns ended on a 400 whose
      // cause was cut at 300 characters, and nothing else recorded it).
      const text = await resp.text().catch(() => '');
      const path = new URL(url).pathname;
      debug('nebula.Galaxy.model').warn('model call refused', {
        instanceName: this.lmz.instanceName ?? this.ctx.id.name,
        status: resp.status,
        path,
        attempts: attempt + 1,
        requestBytes: payload.length,
        messages: Array.isArray(body.messages) ? body.messages.length : undefined,
        body: text,
      });
      throw new Error(`Workers AI REST ${resp.status} at ${path}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
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
    try { currentSource = await (await this.#workspace()).fs.readFile(wsPath('src/App.vue'), 'utf8'); } catch { /* none yet */ }
    let ontologyDts: string | undefined;
    try { ontologyDts = await (await this.#workspace()).fs.readFile(wsPath(ONTOLOGY_PATH), 'utf8'); } catch { /* none yet */ }
    // The Galaxy layer — absent on a Workspace seeded before the layer existed, and then
    // the turn simply runs without it.
    let galaxyAgents: string | undefined;
    try { galaxyAgents = await (await this.#workspace()).fs.readFile(wsPath(GALAXY_AGENTS_PATH), 'utf8'); } catch { /* none */ }
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
  #claimsIfAny(): AuthClaims | undefined {
    try { return this.lmz.callContext.originAuth?.claims as AuthClaims | undefined; } catch { return undefined; }
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
      ids = this.#resources.findCurrentByField('Message', 'chat', DEFAULT_CHAT_ID).map((r) => r.resourceId);
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
      try { snap = this.#resources.doRead(id); } catch { continue; }
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
type CallContextLike = { callChain: Array<{ type?: string; bindingName: string; instanceName?: string }>; originAuth?: { claims?: unknown } };
