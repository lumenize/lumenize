/**
 * The self-correcting codegen loop driver (tasks/archive/nebula-codegen-loop.md Phases
 * 2–3; per-write compiling removed by tasks/archive/nebula-move-compilers-out-of-the-worker.md;
 * `read_file` + `edit_file` and the `preview` rename by tasks/nebula-guidance-file-tree.md).
 * The model emits `tool_calls`, this driver runs them, and repeats until
 * `mark_complete` or a bound trips. A `write_file` is a PURE WRITE — every build-like
 * step (ontology compile, SFC type check, `vite build`) runs in the container when the
 * model calls `build`, whose {@link BuildReport} comes back as the tool result and, on
 * findings or a failed step, as a user-layer fix prompt.
 *
 * **Standalone + dependency-injected** so the loop is testable with a synthetic (fake)
 * model and no AI binding (vitest-pool-workers), and so the offline prompt harness can
 * drive it too. The driver imports nothing from the Galaxy: the entries a tool reaches
 * arrive as {@link CodegenLoopDeps.tools}, built by the Galaxy from its `LOOP_TOOL_ENTRIES`
 * table, and it holds **no reference** to the `.dev` Star binding or the install/wipe
 * methods (`compileAndInstallOntology` / `resetDevData` / `setOntology`) — that absence is
 * the secure-by-default D2 guarantee (an autonomous tool can read, write and build but
 * never install or wipe; install/wipe stays the human-gated apply step fired AFTER the
 * loop). Path safety is the ENTRY's rule (`assertModelPath`, in `galaxy.ts`), so a refused
 * path reaches the loop as a thrown tool dep and is captured like any other tool error.
 *
 * @see tasks/archive/nebula-codegen-loop.md § Phases 2–3 (D1, D2, D4, D5, D6, D7, D8)
 */
import { stepFailed } from './build-report';
import type { BuildReport, Finding, StepResult } from './build-report';

// Re-exported for the loop's consumers (tests, the Galaxy record) — the shapes live in
// the `./build-report` leaf so the container job can share them.
export { stepFailed } from './build-report';
export type { BuildReport, Finding, StepResult } from './build-report';

/** One model tool call — the loop's per-call record slot (every dispatched call + its
 *  result/error). Folds into the agent `Message`'s `codegen` value object. A `read_file`
 *  records `{ path, bytes }`, never the content: the model already holds it as the
 *  in-turn result, and the stored record fans to every subscribed client. */
export interface ToolCall {
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

// ─── Tool surface (read_file + write_file + edit_file + build + mark_complete) ───
// The tool-args TYPES + bundle id live in the Node-safe leaf `./tool-args-constants`,
// shared with `scripts/gen-validator-seeds.ts` (which compiles them to the committed
// validator literal under tsx) without either dragging the other's graph.

/** Map a tool name → the typia type name its args validate against. */
export const TOOL_ARG_TYPE: Record<string, string> = {
  read_file: 'ReadFileArgs',
  write_file: 'WriteFileArgs',
  edit_file: 'EditFileArgs',
  build: 'BuildArgs',
  mark_complete: 'MarkCompleteArgs',
};

/**
 * The tool definitions handed to the model (OpenAI-shaped `tools` array, D5
 * "convert to JSON for the model"). This is a **prompt artifact**, not the
 * validation authority — typia (derived from `tool-args-constants.ts`'s
 * `TOOL_ARGS_TYPES`) is — but its `parameters.properties` ARE the authority for
 * {@link unknownToolArgKeys}. Kept in sync with those types by hand (the surface is
 * tiny + frozen). Tool MECHANICS live here, in each description — what a tool does and
 * when to pick it over its sibling — never in the prompt's prose (`.claude/rules/
 * studio-guidance.md` places each kind of guidance).
 */
export const CODEGEN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read one file, whole. A Workspace path (src/App.vue, AGENTS.md, docs/vision.md, ' +
        'src/components/X.vue) reads the app\'s own tree. A path under .platform/ reads the ' +
        'platform\'s reference and skills: .platform/docs/resources.md, ' +
        '.platform/docs/coding-your-ui.md, and every .platform/skills/<name>/SKILL.md the ' +
        'skills catalog in the platform guidance lists. Read a file before you edit it. ' +
        'An absent path is an error naming it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Relative path, e.g. "src/App.vue" or ".platform/docs/resources.md".' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Save the COMPLETE contents of one file — for a NEW file, or a deliberate rewrite ' +
        'of a whole file. For a change inside a file that exists, use edit_file instead. ' +
        'The write is immediate and nothing is checked here — call build to check and ' +
        'bundle the app. Path is relative to the project root; only the app\'s own tree is ' +
        'writable: a path whose first segment starts with a dot (.env, .gitignore, .git/, ' +
        '.nebula/, .platform/, .universe/) is refused, except under .agents/.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Relative path, e.g. "src/App.vue".' },
          content: { type: 'string', description: 'The full new file contents.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Change one span of a file that exists: anchor is an exact substring of the file ' +
        'that must occur EXACTLY ONCE, and it is replaced by replacement. Refused, with ' +
        'nothing written, when the anchor is absent or matches more than once — read the ' +
        'file, quote it exactly, widen the anchor, and retry. Prefer this to write_file for ' +
        'any change to an existing file: it can only change what it names.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'anchor', 'replacement'],
        properties: {
          path: { type: 'string', description: 'Relative path of an existing file, e.g. "AGENTS.md".' },
          anchor: { type: 'string', description: 'An exact substring of the file, occurring once.' },
          replacement: { type: 'string', description: 'What replaces the anchor (may be several lines, or empty to delete it).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build',
      description:
        'Check and bundle the whole app in a clean build box — one call runs every ' +
        'step and reports each: ontology (compiles src/ontology.d.ts when it changed), ' +
        'typeCheck (advisory findings over every .vue — a checked file with no findings ' +
        'is clean), bundle (vite build), and preview (whether the .dev preview refreshed, ' +
        'and why). A failed container step is infrastructure: read its tail, which says ' +
        'whether retrying the same code can help. Fix code problems and call build again. ' +
        'The preview refreshes by default only on a findings-free build; pass ' +
        '{ "preview": true } to refresh it alongside findings you judge harmless (never ' +
        'possible when bundle failed — there is no dist).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preview: {
            type: 'boolean',
            description:
              'Override the default preview decision: true refreshes the .dev preview even ' +
              'with type findings you judge harmless.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_complete',
      description:
        'Call when the app is finished and the last build report is acceptable — ' +
        'bundle ok, and any remaining type findings are ones you have judged harmless.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
] as const;

/**
 * The TOOL CONTRACT — the first system bundle of every turn, beside the tool definitions
 * it describes so the two change in one place: the identity line and the cross-turn
 * harness policy (findings are advisory and the model judges; tools, not prose; every
 * file, then one build; a turn that changes nothing answers in prose). Tool MECHANICS
 * live in each tool's description above; platform conventions live in the platform
 * layer of the guidance tree (`apps/nebula/platform/AGENTS.md`), the bundle after this
 * one. Byte-identical until a deploy, which is what lets the prefix cache hold across
 * rounds and turns. Model-agnostic (`studio-model-agnostic-naming`) — no vendor name.
 */
export const TOOL_CONTRACT = `You are Studio, an assistant that builds one user-developer's web app inside Nebula — Vue 3 single-file components under src/, with src/App.vue as the root.
How you work:
- Act with the tools; never put code in your reply. Read a file before you change it. Write every file the change needs, then check them all with ONE build; read its per-step report and fix what it names.
- typeCheck findings are ADVISORY and you are the judge: a finding may be a real bug a user would hit, or something the checker cannot see is safe. Fixing is not always the right call — finishing with a reasoned findings list is a legitimate outcome, and the preview override on build is yours to use.
- When the app is done and the last build report is acceptable, call mark_complete. When the request needs no change — a question, a conversation — answer it in prose and call no tool.
- Your reply is what the person reads. Say what you did in a sentence or two; the files themselves are not shown to them.`;

/**
 * The keys of `args` that `toolName` does not declare in its `parameters.properties`,
 * or `[]` — pure, so the refusal is testable without a facet. The typia facet is
 * `createValidate`, which ignores excess keys, so a stale `{ "publish": true }` would
 * otherwise be silently dropped and the build would run WITHOUT the override the model
 * asked for. An unknown tool has no declared keys and reports every key. Non-object
 * args have no keys to judge (the typia shape check owns that refusal).
 */
export function unknownToolArgKeys(toolName: string, args: unknown): string[] {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return [];
  const tool = CODEGEN_TOOLS.find((t) => t.function.name === toolName);
  const declared = new Set(Object.keys(tool?.function.parameters.properties ?? {}));
  return Object.keys(args as Record<string, unknown>).filter((k) => !declared.has(k)).sort();
}

/** Tools EXEMPT from the identical-call loop detector: `build` because fix-then-rebuild
 *  legitimately repeats it; `read_file` because a read is idempotent, and the retro's
 *  read → edit → read would otherwise end the turn `loop-detected`. `mark_complete`
 *  ends the turn before the detector runs. */
const LOOP_DETECTOR_EXEMPT: ReadonlySet<string> = new Set(['build', 'read_file']);

// ─── Message + model-turn shapes ─────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** OpenAI tool_calls echoed on an assistant turn (opaque — for protocol continuity). */
  tool_calls?: unknown;
  /** Correlates a `role: 'tool'` result to its call. */
  tool_call_id?: string;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string from the model. */
  rawArgs: string;
  /** Parsed args, or `undefined` when `rawArgs` was not valid JSON (m2a). */
  args?: unknown;
  argsParseError?: string;
}

export interface ParsedModelTurn {
  toolCalls: ParsedToolCall[];
  /** The raw OpenAI tool_calls array (echoed back on the assistant message). */
  rawToolCalls: unknown;
  /** Assistant text content (chain-of-thought stripped into `reasoning`). */
  text: string;
  reasoning: string;
}

export interface ModelParams {
  temperature: number;
  max_tokens: number;
}

export type StopReason =
  | 'complete'        // mark_complete
  | 'max-depth'       // maxToolDepth cap
  | 'loop-detected'   // identical tool-call repeat OR repeated model text
  | 'no-tool-calls'   // model replied with text only (m2c) — safe termination
  | 'build-unavailable' // the container step failed TWICE in one turn — nothing the model writes changes that
  | 'error';          // a controlled loop error (never an uncaught crash)

export interface LoopResult {
  stop: StopReason;
  /** Model inferences performed (rounds). */
  rounds: number;
  /** Every dispatched call + its result/error — folds into the agent Message's codegen object. */
  toolCalls: ToolCall[];
  /** The full assembled transcript (system + user + assistant/tool/user rounds). */
  messages: ChatMessage[];
  /** Paths written this run (normalized) — `write_file` and `edit_file` alike. */
  appliedPaths: string[];
  /** The last container build's report (the codegen record's `build` source). */
  lastBuild?: BuildReport;
  /** Final assistant text (the recorder's `output`). */
  output: string;
  /** Accumulated chain-of-thought across rounds (the recorder's `reasoning`). */
  reasoning: string;
  /** Human-readable stop detail. */
  detail?: string;
}

/**
 * The entry-reaching tool deps, keyed by TOOL NAME — one per loop tool that reaches a
 * Galaxy entry (`mark_complete` reaches nothing and is not here). The Galaxy builds this
 * from its `LOOP_TOOL_ENTRIES` table, which is what makes "a tool cannot reach an entry the
 * table does not name" a property of the table rather than of the loop. Every dep may
 * throw; the loop captures the throw as that call's tool error and the turn continues.
 */
export interface LoopToolDeps {
  /** Read one file whole — a Workspace path through `readSource`, a `.platform/` path
   *  from the embed; throws naming the path when absent (and the reserved error for
   *  `.universe/`). */
  read_file(path: string): Promise<string>;
  /** Persist one file (Galaxy.writeSource → Workspace + git commit). PURE — no
   *  compile, no check; the container `build` is where checking happens. A throw
   *  (the entry's path rule, say) is captured as the call's tool error. */
  write_file(path: string, content: string): Promise<{ oid: string; path: string }>;
  /** Replace the one occurrence of `anchor` in the file at `path` — reads, counts,
   *  refuses zero or two-plus matches with nothing written, then writes through
   *  `writeSource`. */
  edit_file(path: string, anchor: string, replacement: string): Promise<{ oid: string; path: string }>;
  /**
   * One ephemeral container build cycle — the job runs EVERY step (ontology compile,
   * SFC type check, `vite build`) against the FUSE-mounted workspace and reports each
   * (Galaxy's `buildNow`, serialized by its promise-chain latch). `preview` is the
   * model's override (BuildArgs). A throw is captured by the loop into a report whose
   * `container` step failed; it never aborts the turn.
   */
  build(opts?: { preview?: boolean }): Promise<BuildReport>;
}

/** The loop tools that reach an entry — the keys of {@link LoopToolDeps}. */
export type LoopToolName = keyof LoopToolDeps;

export interface CodegenLoopDeps {
  /** Abstracts `env.AI.run(STUDIO_MODEL, …)` — fake (script) in tests. */
  callModel(messages: ChatMessage[], params: ModelParams): Promise<unknown>;
  /** The entry-reaching tools, keyed by tool name ({@link LoopToolDeps}). */
  tools: LoopToolDeps;
  /** typia shape validation of tool args (+ the unknown-key refusal). Async — the validator is a facet. */
  validateToolArgs(toolName: string, args: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Progress/thought emit seam (Child 3 Phase 3). Called per round with the model's
   * reasoning and per file with `wrote <path>` — the coarse, step-level content the
   * assistant progress stream fans to session subscribers (NOT model tokens; `callModel`
   * is non-streaming). Optional + synchronous fire-and-forget: a slow/throwing sink must
   * not perturb the loop, so callers keep it cheap (Galaxy buffers + broadcasts). Only
   * exercised under `wrangler dev` (real `chat`); pool-workers tests drive the downstream
   * push directly via the test harness.
   */
  onProgress?: (step: string) => void;
  /** Present when `callModel` streams its text live through `onProgress` — the loop then
   *  emits only its own steps (`building…`, `wrote …`), never the round's thinking again. */
  onDelta?: (text: string) => void;
}

export interface CodegenLoopConfig {
  /** Max model inferences per turn (D4 — the runaway stop). */
  maxToolDepth: number;
  /** Per-call params: full temp for the first/generate pass. */
  generateParams: ModelParams;
  /** Lower temp once self-correcting on a compile error. */
  fixParams: ModelParams;
}

export const DEFAULT_LOOP_CONFIG: CodegenLoopConfig = {
  // 32, raised from 8 on 2026-09-06: with the read and edit tools in the loop a first
  // build spends rounds on reading the platform docs and the source before it writes,
  // and eight ended real turns at the cap with one build behind them (`first-app-built`'s
  // manifest line: `max-depth`, eight rounds, one build). The cap is the runaway stop, not
  // a budget; the generation deadline is the wall-clock bound.
  maxToolDepth: 32,
  generateParams: { temperature: 0.7, max_tokens: 4096 },
  fixParams: { temperature: 0.2, max_tokens: 4096 },
};

// ─── Prompt assembly ─────────────────────────────────────────────────────

/**
 * Assemble the layered codegen prompt. The system layer is the guidance tree's layers
 * as an ORDERED list of bundles, stable first — the tool contract, the platform
 * layer, the app's own `AGENTS.md`, the chat history — joined by blank lines; a later
 * layer (the Universe's) is an insertion into that list, never a named slot. The
 * cache reuses the longest unchanged prefix, so what never changes comes first and
 * nothing non-deterministic rides it. The user message is the DYNAMIC tail: the
 * ontology (`src/ontology.d.ts`), the current `src/App.vue`, then the request marked
 * with its poster's label — the ontology left the system block because it changes
 * most turns and every cached token after it would be invalidated with it.
 */
export function assembleCodegenPrompt(opts: {
  systemBundles: string[];
  ontologyDts?: string;
  userRequest: string;
  currentSource?: string;
  /** The poster's label in the history bundle (`human 2`), so the request reads as one
   *  more message from someone the history already names. */
  posterLabel?: string;
}): { system: ChatMessage; user: ChatMessage } {
  const userParts: string[] = [];
  if (opts.ontologyDts) {
    userParts.push(`The current ontology (src/ontology.d.ts) is:\n\`\`\`ts\n${opts.ontologyDts}\n\`\`\``);
  }
  if (opts.currentSource) {
    userParts.push(`Current src/App.vue:\n\`\`\`vue\n${opts.currentSource}\n\`\`\``);
  }
  userParts.push(`User request${opts.posterLabel ? ` (${opts.posterLabel})` : ''}: ${opts.userRequest}`);
  return {
    system: { role: 'system', content: opts.systemBundles.join('\n\n') },
    user: { role: 'user', content: userParts.join('\n\n') },
  };
}

/** The history bundle's first line — a stable header, so a turn with history and one
 *  without are told apart by a string a test can look for. */
export const HISTORY_HEADER = 'Chat history — each request in this thread with the reply it got, oldest first; a message with no reply stands alone. The current request follows separately.';

/** One message of the chat as the history bundle carries it: who said it, what they
 *  said, and — for an agent turn — the manifest of what that turn changed. Never the
 *  tool calls (whole files ride in their args) and never the thought panel. */
export interface HistoryEntry {
  /** `agent`, or a stable per-person label in first-appearance order (`human 1`). */
  speaker: string;
  content: string;
  /** Present on an agent message that carries a codegen record. */
  manifest?: {
    stop: string;
    rounds: number;
    appliedPaths: string[];
    sourceCommit?: string;
    findings?: string[];
  };
}

/** Render the history bundle from its entries — the exclusive projection, as text. */
export function renderHistoryBundle(entries: HistoryEntry[]): string {
  const lines = entries.map((e) => {
    const m = e.manifest;
    const tail = m
      ? ` [${[
          `stop=${m.stop}`,
          `rounds=${m.rounds}`,
          m.appliedPaths.length > 0 ? `applied=${m.appliedPaths.join(',')}` : '',
          m.sourceCommit ? `sourceCommit=${m.sourceCommit.slice(0, 7)}` : '',
          m.findings && m.findings.length > 0 ? `findings=${m.findings.join(' | ')}` : '',
        ].filter(Boolean).join(' ')}]`
      : '';
    return `- ${e.speaker}: ${e.content}${tail}`;
  });
  return `${HISTORY_HEADER}\n${lines.join('\n')}`;
}

/** The user-layer self-correction message after a build with failures or findings
 *  (D1/D7/D8's successor): the report's tails + findings plus the files written this
 *  turn, pushed back so the model fixes and rebuilds. A per-build findings list is not
 *  attached to one file, so no single file's source is re-echoed — the diagnostics
 *  carry file and line themselves. It says "fix and call build again" and nothing
 *  else: how to read a failed step lives on the step (the report's own tail), and how
 *  to override the preview lives on the tool. */
/** The user-layer message after a build whose CONTAINER step failed — the box did not
 *  run, so no step ran and nothing the model writes can change it this turn. Unlike
 *  {@link buildReportFeedback} it says NOT to call build again: finish the edits, tell
 *  the user the preview could not be refreshed. The loop ends the turn on a second
 *  failed container step regardless. */
function buildUnavailableFeedback(report: BuildReport, touchedPaths: string[]): string {
  const tail = stepFailed(report.container) ? (report.container as { tail: string }).tail : '';
  const files = [...new Set(touchedPaths)];
  return (
    `The build box did not run, so nothing was built:\n\`\`\`\n${tail}\n\`\`\`\n\n` +
    `Files written this turn: ${files.join(', ') || '(none)'}\n\n` +
    `This is not something the code can fix. Do not call build again this turn: finish any edits ` +
    `you still need, then reply to the user with what you changed and that nothing was built this turn.`
  );
}

function buildReportFeedback(report: BuildReport, touchedPaths: string[]): string {
  const parts: string[] = [];
  for (const [name, step] of [
    ['container', report.container], ['ontology', report.ontology], ['bundle', report.bundle],
  ] as const) {
    if (stepFailed(step)) parts.push(`${name} step failed:\n\`\`\`\n${(step as { tail: string }).tail}\n\`\`\``);
  }
  if (report.typeCheck.findings.length > 0) {
    parts.push(`Type findings:\n\`\`\`\n${report.typeCheck.findings.join('\n')}\n\`\`\``);
  }
  const files = [...new Set(touchedPaths)];
  return (
    `The build reported problems.\n\n${parts.join('\n\n')}\n\n` +
    `Files written this turn: ${files.join(', ') || '(none)'}\n\n` +
    `Fix and call build again.`
  );
}

// ─── Model-response parsing (D5, m2) ─────────────────────────────────────

/**
 * Extract tool_calls + text from a raw `env.AI.run` response, defensively (m2):
 * handles the OpenAI shape (`choices[0].message.tool_calls`), the `{ response }`
 * shape (no tool_calls → empty), and malformed per-call `arguments` JSON (the
 * call survives with `args: undefined` so the loop reports it rather than crashing).
 */
export function parseModelTurn(raw: unknown): ParsedModelTurn {
  const out = (raw ?? {}) as any;
  const msg = out?.choices?.[0]?.message ?? {};
  const text: string =
    typeof msg.content === 'string'
      ? msg.content
      : typeof out?.response === 'string'
        ? out.response
        : typeof out === 'string'
          ? out
          : '';
  const reasoning: string = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: ParsedToolCall[] = rawToolCalls.map((tc: any, i: number) => {
    const fn = tc?.function ?? tc ?? {};
    const name = String(fn?.name ?? tc?.name ?? '');
    const rawArgs = typeof fn?.arguments === 'string'
      ? fn.arguments
      : fn?.arguments !== undefined
        ? JSON.stringify(fn.arguments)
        : '{}';
    let args: unknown;
    let argsParseError: string | undefined;
    try {
      args = JSON.parse(rawArgs);
    } catch (e) {
      argsParseError = e instanceof Error ? e.message : String(e);
    }
    return { id: String(tc?.id ?? `call_${i}`), name, rawArgs, args, argsParseError };
  });
  return { toolCalls, rawToolCalls, text, reasoning };
}

/** Stable hash for loop-detection. Order-insensitive over object keys so logically
 *  identical args hash identically; cheap FNV-1a over the canonical string. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function toolResultMessage(id: string, payload: unknown): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: JSON.stringify(payload) };
}

// ─── The loop ────────────────────────────────────────────────────────────

/**
 * Drive the bounded, self-correcting tool-calling loop. Returns when the model
 * signals completion, a bound trips, or it stops emitting tool calls — never by
 * throwing on model/tool misbehavior (every such case is captured into the
 * `toolCalls` recorder slot + the transcript; D4/m2). A tool dep that itself
 * throws is also captured, not propagated.
 *
 * Per call, in order: malformed arguments JSON, an unknown tool, and a shape/unknown-key
 * refusal are each captured as that call's error (`mark_complete` included); a validated
 * `mark_complete` ends the turn; the identical-call detector runs for every tool not in
 * {@link LOOP_DETECTOR_EXEMPT}; then the tool dispatches to its dep.
 */
export async function runCodegenLoop(
  initial: { system: ChatMessage; user: ChatMessage },
  deps: CodegenLoopDeps,
  config: CodegenLoopConfig = DEFAULT_LOOP_CONFIG,
): Promise<LoopResult> {
  const messages: ChatMessage[] = [initial.system, initial.user];
  const recorded: ToolCall[] = [];
  const appliedPaths: string[] = [];
  const seenCallHashes = new Set<string>();
  const seenTextHashes = new Set<string>();
  const reasoningParts: string[] = [];
  let lastBuild: BuildReport | undefined;
  let lastText = '';
  let round = 0;
  let fixMode = false; // D6: drop to fixParams once self-correcting on an error
  let containerFailures = 0; // a box that did not run: told once, ended on the second

  const done = (stop: StopReason, detail: string): LoopResult => ({
    stop, detail, rounds: round, toolCalls: recorded, messages, appliedPaths, lastBuild,
    output: lastText, reasoning: reasoningParts.join('\n\n— — —\n\n'),
  });

  while (round < config.maxToolDepth) {
    round++;
    let raw: Awaited<ReturnType<typeof deps.callModel>>;
    try {
      raw = await deps.callModel(messages, fixMode ? config.fixParams : config.generateParams);
    } catch (e) {
      // A refused or broken model call is a CONTROLLED end, never an uncaught throw: the
      // turn still commits a reply that names the cause, so nobody waits on a turn that
      // already died (2026-09-06: a Workers AI 429 threw out of the turn and no reply landed).
      return done('error', `the model call failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const turn = parseModelTurn(raw);
    lastText = turn.text;
    if (turn.reasoning.trim().length > 0) reasoningParts.push(turn.reasoning);
    // Phase 3: emit this round's thinking as a progress step (coarse, not tokens) — unless it
    // already streamed live through `onDelta`, in which case only a line break separates rounds.
    const step = turn.reasoning.trim() || turn.text.trim();
    if (step.length > 0) deps.onProgress?.(deps.onDelta ? '\n' : step);

    // Loop-detection #1 — repeated model text (rolling hash). Checked BEFORE
    // dispatch so it's independent of the identical-call detector.
    if (turn.text.trim().length > 0) {
      const th = fnv1a(turn.text.trim());
      if (seenTextHashes.has(th)) return done('loop-detected', 'repeated model text');
      seenTextHashes.add(th);
    }

    if (turn.toolCalls.length === 0) {
      // m2c: a {response}-shaped / text-only reply with no tool_calls.
      messages.push({ role: 'assistant', content: turn.text });
      return done('no-tool-calls', 'model returned no tool calls');
    }

    messages.push({ role: 'assistant', content: turn.text, tool_calls: turn.rawToolCalls });

    let sawError = false;
    /** Capture one call's failure: the record, the tool message, the fix-mode flag. */
    const fail = (tc: ParsedToolCall, error: string, args: unknown = tc.args ?? tc.rawArgs): void => {
      recorded.push({ name: tc.name, args, error });
      messages.push(toolResultMessage(tc.id, { error }));
      sawError = true;
    };

    for (const tc of turn.toolCalls) {
      if (tc.args === undefined) {
        // m2a: malformed arguments JSON — the call survives as a captured error.
        fail(tc, `malformed tool arguments: ${tc.argsParseError ?? 'not JSON'}`, tc.rawArgs);
        continue;
      }
      if (!(tc.name in TOOL_ARG_TYPE)) {
        fail(tc, `unknown tool '${tc.name}'`); // m2b
        continue;
      }
      // D5: typia shape validation (+ the unknown-key refusal) of untrusted model output
      // BEFORE dispatch — for every tool alike, `mark_complete` included: a stray key on
      // it is refused like any other and the turn continues, rather than ending on a call
      // that was never checked.
      const shape = await deps.validateToolArgs(tc.name, tc.args);
      if (!shape.ok) {
        fail(tc, shape.error, tc.args);
        continue;
      }

      if (tc.name === 'mark_complete') {
        recorded.push({ name: tc.name, args: {} });
        messages.push(toolResultMessage(tc.id, { ok: true }));
        return done('complete', 'mark_complete');
      }
      // Loop-detection #2 — identical tool call repeat (same name + args). A write_file
      // with NEW content is not "identical" (different hash), so legitimate fixes are
      // never aborted; `build` and `read_file` are exempt (see LOOP_DETECTOR_EXEMPT).
      if (!LOOP_DETECTOR_EXEMPT.has(tc.name)) {
        const callHash = `${tc.name}:${fnv1a(stableStringify(tc.args))}`;
        if (seenCallHashes.has(callHash)) return done('loop-detected', `repeated tool call ${tc.name}`);
        seenCallHashes.add(callHash);
      }

      if (tc.name === 'build') {
        // The build is a TOOL — the model checks its own work; each call is one
        // ephemeral container cycle running EVERY step. The per-step report goes back
        // as the tool result; a failed step or a type finding makes this a fix round,
        // never an abort.
        const args = tc.args as { preview?: boolean };
        deps.onProgress?.('building…');
        let report: BuildReport;
        try {
          report = await deps.tools.build(args);
        } catch (e) {
          // The job never ran at all — a container-step failure; every other step is
          // honestly "did not run" rather than absent (the shape's own rule).
          const tail = e instanceof Error ? e.message : String(e);
          report = {
            container: { ran: true, ok: false, tail },
            ontology: { ran: false, why: 'the build job did not run' },
            typeCheck: { ran: false, checked: [], findings: [] },
            bundle: { ran: false, why: 'the build job did not run' },
            preview: { refreshed: false, why: 'the build job did not run' },
          };
        }
        lastBuild = report;
        recorded.push({ name: tc.name, args, result: report });
        messages.push(toolResultMessage(tc.id, report));
        if (stepFailed(report.container)) {
          // The box did not run — infrastructure, not the model's code. Told once, with
          // feedback that says not to build again this turn; a second failed container
          // step ends the turn, so a Galaxy without a box cannot spend the round cap
          // discovering that (2026-09-06: at 32 rounds a container-free turn ran into the
          // 14-minute generation deadline and never replied).
          containerFailures++;
          if (containerFailures >= 2) return done('build-unavailable', 'the container step failed twice in one turn');
          sawError = true;
          messages.push({ role: 'user', content: buildUnavailableFeedback(report, appliedPaths) });
          continue;
        }
        const problems =
          stepFailed(report.container) || stepFailed(report.ontology) ||
          stepFailed(report.bundle) || report.typeCheck.findings.length > 0;
        if (problems) {
          sawError = true;
          // D1/D7/D8's successor: findings-plus-touched-files, in the USER layer.
          messages.push({ role: 'user', content: buildReportFeedback(report, appliedPaths) });
        }
        continue;
      }

      if (tc.name === 'read_file') {
        const { path } = tc.args as { path: string };
        try {
          const content = await deps.tools.read_file(path);
          deps.onProgress?.(`read ${path}`);
          // The model gets the content; the RECORD gets its size in BYTES (UTF-8, what the
          // file holds — not UTF-16 code units) — the content is already in the transcript,
          // and the record fans to every chat subscriber.
          recorded.push({ name: tc.name, args: tc.args, result: { path, bytes: new TextEncoder().encode(content).length } });
          messages.push(toolResultMessage(tc.id, { path, content }));
        } catch (e) {
          fail(tc, e instanceof Error ? e.message : String(e), tc.args);
        }
        continue;
      }

      if (tc.name === 'edit_file') {
        const { path, anchor, replacement } = tc.args as { path: string; anchor: string; replacement: string };
        try {
          const written = await deps.tools.edit_file(path, anchor, replacement);
          deps.onProgress?.(`edited ${written.path}`);
          appliedPaths.push(written.path);
          const result = { edited: written.path };
          recorded.push({ name: tc.name, args: tc.args, result });
          messages.push(toolResultMessage(tc.id, result));
        } catch (e) {
          fail(tc, e instanceof Error ? e.message : String(e), tc.args);
        }
        continue;
      }

      // write_file — persist, a PURE write. No compile, no check: the container `build`
      // is where every check runs, and its report is the self-correction signal. The
      // path rule is the entry's (`assertModelPath` runs first inside `writeSource`), so a
      // traversal or a reserved path arrives here as a throw and is captured.
      const { path, content } = tc.args as { path: string; content: string };
      try {
        const written = await deps.tools.write_file(path, content);
        deps.onProgress?.(`wrote ${written.path}`); // Phase 3: per-file progress step
        appliedPaths.push(written.path);
        const result = { written: written.path };
        recorded.push({ name: tc.name, args: tc.args, result });
        messages.push(toolResultMessage(tc.id, result));
      } catch (e) {
        fail(tc, e instanceof Error ? e.message : String(e), tc.args);
      }
    }

    fixMode = sawError;
  }
  return done('max-depth', `reached maxToolDepth ${config.maxToolDepth}`);
}
