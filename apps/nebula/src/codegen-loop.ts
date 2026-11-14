/**
 * The self-correcting codegen loop driver (tasks/archive/nebula-codegen-loop.md; per-write
 * compiling removed by tasks/archive/nebula-move-compilers-out-of-the-worker.md; `read_file` +
 * `edit_file` and the `preview` rename by tasks/archive/nebula-guidance-file-tree.md).
 * The model emits `tool_calls`, this driver runs them, and repeats until
 * `mark_complete` or a bound trips. A `write_file` is a PURE WRITE — every build-like
 * step (ontology compile, SFC type check, `vite build`) runs in the container when the
 * model calls `build`, whose {@link BuildReport} comes back as the tool result and, on
 * findings or a failed step, as a user-layer fix prompt.
 *
 * **Standalone + dependency-injected** so the loop is testable with a synthetic (fake)
 * model and no AI binding (vitest-plugin), and so the offline prompt harness can
 * drive it too. The driver imports nothing from the Galaxy: the entries a tool reaches
 * arrive as {@link CodegenLoopDeps.tools}, built by the Galaxy from its `LOOP_TOOL_ENTRIES`
 * table, and it holds **no reference** to the `.dev` Star binding, the wipe (`resetDevData`) or
 * the ontology pull's answer (`onOntologyPulled`). That absence is the secure-by-default line:
 * an autonomous tool reads, writes and builds. A build that lands changes the types the `.dev`
 * Star runs, which touches only test data. Only a person wipes. Nothing a build compiles reaches
 * a Star with real users (ADR-024). Path safety is the ENTRY's rule (`assertModelPath`, in
 * `galaxy.ts`), so a refused path reaches the loop as a thrown tool dep and is captured like any
 * other tool error.
 *
 * @see tasks/archive/nebula-codegen-loop.md
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
  /** The post a loop tool acted for: the one its turn took up. */
  post?: string;
  /** The claims that call ran under, in the form a client may be sent: who, and for whom. */
  claims?: ActedUnder;
}

/** Whose claims a tool call ran under: `sub`, `act` and `profileId`, never `access` or `aud`,
 *  since the record reaches every subscriber of the chat (ADR-016). */
export interface ActedUnder { sub: string; profileId?: string; act?: unknown }

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
  take_up: 'TakeUpArgs',
  invite: 'InviteArgs',
  run_in_tab: 'RunInTabArgs',
};

/**
 * The tool definitions handed to the model (an OpenAI-shaped `tools` array, converted to JSON for
 * the model). This is a **prompt artifact**, not the
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
        'Check and bundle the whole app in a clean build box — one call runs the ' +
        'steps and reports each: ontology (compiles src/ontology.d.ts when it changed; if it ' +
        'does not compile, the bundle is skipped, so fix it first), ' +
        'typeCheck (advisory findings over every .vue — a checked file with no findings ' +
        'is clean), bundle (vite build), and preview (whether the build landed on the .dev ' +
        'preview, and why). A failed container step is infrastructure: read its tail, which says ' +
        'whether retrying the same code can help. Fix code problems and call build again. ' +
        'A build lands on the .dev preview, where every Studio on the app sees it, by default ' +
        'only when it has no type findings; a build you do not preview is served nowhere, and .dev ' +
        'keeps the last one you did. Pass { "preview": true } to land a build whose findings you ' +
        'judge harmless (never possible when bundle failed — there is no dist).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preview: {
            type: 'boolean',
            description:
              'Your call on the .dev preview: true lands this build even with type findings you ' +
              'judge harmless, false holds a clean one back. A build you do not preview is served nowhere.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invite',
      description:
        'Invite a person into this app by email. Like every tool, it runs under the claims of ' +
        'the person whose post this turn took up: only an admin of the app can invite, so ' +
        'when that person is not one the call is refused, and you should say so and ask an ' +
        'admin in the chat. By default the invitee becomes a collaborator, who can post here ' +
        'and work in the preview. Pass { "scopeAdmin": true } only when you were asked to make ' +
        'them an admin of the app. The email goes out after this call returns: a failure, and ' +
        'the result of an admin invite, is posted to the chat for everyone.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['email'],
        properties: {
          email: { type: 'string', description: 'The address to invite.' },
          scopeAdmin: { type: 'boolean', description: 'true makes the invitee an admin of the app. Leave it out for a collaborator.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_in_tab',
      description:
        'Run JavaScript in one of the preview\'s tabs and get back what it returns. The tabs are ' +
        'pages of the built app in the dev Star: "me" is the own page of the person whose post ' +
        'this turn took up, and each persona that docs/personas.md names has a tab under its ' +
        'slug, such as "gerry". The code is the body of an async function, in plain JavaScript ' +
        'with no TypeScript, with the app\'s own `client` and `store` in scope. It can do what ' +
        'that tab\'s person can do in the app, and nothing more. Use "me" to build the cast, ' +
        'and a persona\'s tab to make what that persona would make or to see what they see. ' +
        'Before the first run of a turn, read .platform/skills/define-the-cast/SKILL.md, which ' +
        'has the calls to copy. The result is { ok: true, value }, with the value as JSON and a ' +
        'Map as an array of its entries, or { ok: false, error } when the code threw. ok: true ' +
        'says only that the code returned, not that what it tried worked, so return what tells ' +
        'you, such as a transaction\'s outcome. The tool needs the person\'s Studio open and an ' +
        'app that has been built, and a persona\'s tab opens a few seconds after its invite.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['tab', 'code'],
        properties: {
          tab: { type: 'string', description: '"me", or a persona\'s slug from docs/personas.md.' },
          code: { type: 'string', description: 'The body of an async function. `client` and `store` are in scope. Return what you want to read.' },
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
        'bundle ok, and any remaining type findings are ones you have judged harmless. A build ' +
        'you did not preview is served nowhere. Your text beside this call is the message ' +
        'everyone reads. Pass answers: the ids of the OTHER posts that message answers, each ' +
        'done, refused or asked back; the post this turn took up is counted without being named.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the posts your message answers. Never a post you only promise to get to.',
          },
        },
      },
    },
  },
] as const;

/** `mark_complete`'s definition, the one tool every step is offered. */
const MARK_COMPLETE_TOOL = CODEGEN_TOOLS[CODEGEN_TOOLS.length - 1]!;

/**
 * A decision's pick. It reaches no Galaxy entry, as `mark_complete` reaches none, so it is no
 * loop tool: the Galaxy checks the post and then runs the rest of the turn under the claims
 * recorded on it.
 */
export const TAKE_UP_TOOL = {
  type: 'function',
  function: {
    name: 'take_up',
    description:
      'Take up one waiting post: the rest of this turn works on it, under its poster\'s claims, ' +
      'and must end with a message that answers it. Only a post listed as waiting can be taken up.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['postId'],
      properties: {
        postId: { type: 'string', description: 'The id of the waiting post to take up.' },
      },
    },
  },
} as const;

/** What a decision is offered: a pick, or a message. No loop tool, since nothing is taken up yet. */
export const DECISION_TOOLS = [TAKE_UP_TOOL, MARK_COMPLETE_TOOL] as const;

/** What a step that may not act is offered: a message, and nothing else. */
export const MESSAGE_ONLY_TOOLS = [MARK_COMPLETE_TOOL] as const;

/** Every tool definition the model can be sent, for a lookup by name. */
const ALL_TOOLS = [...CODEGEN_TOOLS, TAKE_UP_TOOL] as const;

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
- typeCheck findings are ADVISORY and you are the judge: a finding may be a real bug a user would hit, or something the checker cannot see is safe. Fixing is not always the right call — finishing with a reasoned findings list is a legitimate outcome. A build you do not preview is served nowhere; the build tool says how to preview one.
- When the app is done and the last build report is acceptable, call mark_complete. When the request needs no change — a question, a conversation — answer it in prose and call no tool.
- Your reply is what the people in the chat read. Say what you did in a sentence or two; the files themselves are not shown to them.
Several people may post in one chat:
- You post as yourself. Everything else you do in a turn, you do under the claims of the person whose post the turn took up: every tool runs under them, and you cannot choose another's.
- So do in a turn only what that person asked for or said yes to, and say in your reply whose authority you used. Work another person asked for waits for a turn that takes up their post. Ask before acting on what nobody asked for.
- A tool is refused when that person lacks the permission it needs, and the refusal says which. Say so in your reply, and ask someone who holds it.
- End every turn with a message that answers the post it took up. If that message also answers other posts, name them in mark_complete's answers; name a post only when the message answers it, done, refused or asked back, never for work you only promise.
- When you are asked to decide what to take up next, call take_up with one waiting post's id, or answer in a message.`;

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
  const tool = ALL_TOOLS.find((t) => t.function.name === toolName);
  const declared = new Set(Object.keys(tool?.function.parameters.properties ?? {}));
  return Object.keys(args as Record<string, unknown>).filter((k) => !declared.has(k)).sort();
}

/** The most a `run_in_tab` value may add to the transcript, in characters of its JSON. */
export const RUN_RESULT_MAX_CHARS = 20_000;
/** The most of a thrown error's text a `run_in_tab` result keeps. */
export const RUN_ERROR_MAX_CHARS = 2_000;

/**
 * A `run_in_tab` result as the model and the record get it. A value is kept as its JSON has it,
 * and one whose JSON runs past {@link RUN_RESULT_MAX_CHARS} is replaced by its first characters
 * and a note; an error's text is cut at {@link RUN_ERROR_MAX_CHARS}. Either goes into every later
 * round's request and into a record every chat subscriber receives.
 */
export function clipRunResult(
  result: { ok: true; value: unknown } | { ok: false; error: string },
): { ok: true; value: unknown } | { ok: false; error: string } | { ok: true; clipped: true; json: string; note: string } {
  if (!result.ok) {
    return result.error.length <= RUN_ERROR_MAX_CHARS ? result
      : { ok: false, error: `${result.error.slice(0, RUN_ERROR_MAX_CHARS)}… (${result.error.length} characters in all)` };
  }
  let json: string | undefined;
  try { json = JSON.stringify(result.value); } catch { json = undefined; }
  if (json === undefined) return { ok: true, value: undefined };
  // What is kept is what was measured: the value as its JSON has it.
  if (json.length <= RUN_RESULT_MAX_CHARS) return { ok: true, value: JSON.parse(json) };
  return {
    ok: true, clipped: true, json: json.slice(0, RUN_RESULT_MAX_CHARS),
    note: `The value was ${json.length} characters of JSON and only the first ${RUN_RESULT_MAX_CHARS} are here. Return less.`,
  };
}

/** Tools EXEMPT from the identical-call loop detector: `build` because fix-then-rebuild
 *  legitimately repeats it; `read_file` because a read is idempotent, and the retro's
 *  read → edit → read would otherwise end the turn `loop-detected`. `mark_complete`
 *  ends the turn before the detector runs. `run_in_tab` because the same code is rightly
 *  run again: a persona's tab opens a few seconds after its invite, and a read of a page is
 *  worth repeating after a change. */
const LOOP_DETECTOR_EXEMPT: ReadonlySet<string> = new Set(['build', 'read_file', 'run_in_tab']);

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

/** A tool's throw that means the post the turn took up changed under it: told by `name`, as the
 *  Resources plane's errors are. Nothing ran, and nothing more may run under the old snapshot. */
const postMoved = (e: unknown): boolean => e instanceof Error && e.name === 'ResourceMovedOnError';
/** A refusal for want of a grant, by `name`. */
const permissionDenied = (e: unknown): boolean => e instanceof Error && e.name === 'PermissionDeniedError';
const POST_MOVED_DETAIL = 'the post this turn took up was edited or deleted while it ran';

export type StopReason =
  | 'complete'        // mark_complete
  | 'max-depth'       // maxToolDepth cap
  | 'loop-detected'   // identical tool-call repeat OR repeated model text
  | 'no-tool-calls'   // model replied with text only (m2c) — safe termination
  | 'build-unavailable' // the container step failed TWICE in one turn — nothing the model writes changes that
  | 'post-moved'      // the post the turn took up was edited or deleted while it ran
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
  /** The posts `mark_complete` named as answered by the final message, as the model wrote them. */
  answers?: string[];
}

/**
 * The entry-reaching tool deps, keyed by TOOL NAME — one per loop tool that reaches a
 * Galaxy entry (`mark_complete` reaches nothing and is not here). None names a post: the Galaxy
 * runs every one under the claims recorded on the post the turn took up. The Galaxy builds this
 * from its `LOOP_TOOL_ENTRIES` table, which is what makes "a tool cannot reach an entry the
 * table does not name" a property of the table rather than of the loop. Every dep may
 * throw; the loop captures the throw as that call's tool error and the turn continues, except a
 * `ResourceMovedOnError`, which means the post itself changed and ends the loop `post-moved`.
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
   * One ephemeral container build cycle — the job runs each step (ontology compile,
   * SFC type check, `vite build`, which a failed compile skips) against the FUSE-mounted
   * workspace and reports each
   * (Galaxy's `buildNow`, serialized by its promise-chain latch). `preview` is the
   * model's override (BuildArgs). A throw is captured by the loop into a report whose
   * `container` step failed; it never aborts the turn.
   */
  build(opts?: { preview?: boolean }): Promise<BuildReport>;
  /**
   * Invite a person into the app, as a collaborator or, with `scopeAdmin`, as an admin of it.
   * Throws when the poster of the post the turn took up lacks
   * dominion over the app, which reaches the model as the call's tool error within the turn.
   */
  invite(email: string, scopeAdmin?: boolean): Promise<{ invited: string; as: 'collaborator' | 'admin'; note: string }>;
  /**
   * Run `code` in a preview tab of the person whose post the turn took up, "me" or a persona's,
   * and answer with what the page said: the code's value, or the error it threw. Throws when
   * nothing ran it: no Studio of theirs is open, or the tab did not answer in time.
   */
  run_in_tab(tab: string, code: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
}

/** The loop tools that reach an entry — the keys of {@link LoopToolDeps}. */
export type LoopToolName = keyof LoopToolDeps;

export interface CodegenLoopDeps {
  /** Abstracts `env.AI.run(STUDIO_MODEL, …)` — fake (script) in tests. */
  callModel(messages: ChatMessage[], params: ModelParams): Promise<unknown>;
  /** The entry-reaching tools, keyed by tool name ({@link LoopToolDeps}). */
  tools: LoopToolDeps;
  /**
   * The post the latest loop tool call acted for and the claims it ran under, or `undefined`
   * when it ran under none. Asked after the call, whether it returned or threw, and written on
   * the call's record: the claims are the ones read inside the block the tool ran in.
   */
  actsFor?: () => { post: string; claims: ActedUnder } | undefined;
  /** typia shape validation of tool args (+ the unknown-key refusal). Async — the validator is a facet. */
  validateToolArgs(toolName: string, args: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Progress/thought emit seam. Called per round with the model's
   * reasoning and per file with `wrote <path>` — the coarse, step-level content the
   * assistant progress stream fans to session subscribers (NOT model tokens; `callModel`
   * is non-streaming). Optional + synchronous fire-and-forget: a slow/throwing sink must
   * not perturb the loop, so callers keep it cheap (Galaxy buffers + broadcasts). Only
   * exercised under `wrangler dev` (real `chat`); vitest-plugin tests drive the downstream
   * push directly via the test harness.
   */
  onProgress?: (step: string) => void;
  /** Present when `callModel` streams its text live through `onProgress` — the loop then
   *  emits only its own steps (`building…`, `wrote …`), never the round's thinking again. */
  onDelta?: (text: string) => void;
}

export interface CodegenLoopConfig {
  /** Max model inferences per turn (the runaway stop). */
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
export const HISTORY_HEADER = 'Chat history — each post in this thread with the reply it got, oldest first; a post with no reply stands alone. A person\'s post carries its id, and a reply names the posts it answers. The current request follows separately.';

/** One message of the chat as the history bundle carries it: who said it, what they
 *  said, and — for an agent turn — the manifest of what that turn changed. Never the
 *  tool calls (whole files ride in their args) and never the thought panel. */
export interface HistoryEntry {
  /** `agent`, or a stable per-person label in first-appearance order (`human 1`). */
  speaker: string;
  content: string;
  /** A person's post: its id, which `take_up` and `answers` name it by. */
  postId?: string;
  /** An agent message: the posts it answers. */
  answers?: string[];
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
    const who = e.postId ? `${e.speaker} (post ${e.postId})`
      : e.answers && e.answers.length > 0 ? `${e.speaker} (answers ${e.answers.join(', ')})`
      : e.speaker;
    return `- ${who}: ${e.content}${tail}`;
  });
  return `${HISTORY_HEADER}\n${lines.join('\n')}`;
}

/**
 * A decision's request, the dynamic tail of its prompt: the posts still waiting, oldest first,
 * and the two things the agent can do about them.
 */
export function renderDecisionRequest(waiting: Array<{ postId: string; speaker: string; content: string }>): string {
  const posts = waiting.map((w) => `- post ${w.postId} (${w.speaker}): ${w.content}`);
  return [
    'No turn is running, and these posts are still waiting for an answer, oldest first:',
    ...posts,
    'Decide what to do next. Call take_up with the id of one of them to work on it now, under ' +
    'its poster\'s claims. Or write a message that answers one or more of them, and name each ' +
    'post it answers in mark_complete\'s answers.',
  ].join('\n');
}

/**
 * A closing step's request, appended last to a finished turn's transcript: the posts that
 * arrived while the turn ran, and a request for the message that ends it. It comes after
 * everything the turn already sent, so the provider's cache still holds the whole prefix.
 */
export function renderClosingRequest(arrived: Array<{ postId: string; speaker: string; content: string }>): string {
  return [
    'While you worked, these posts arrived, oldest first:',
    ...arrived.map((a) => `- post ${a.postId} (${a.speaker}): ${a.content}`),
    'Write the message that ends this turn now. It replaces your reply above, so it must still ' +
    'answer the post this turn took up, and it may also answer any of these: name each one it ' +
    'answers in mark_complete\'s answers. A post you do not answer waits, and you can take it up ' +
    'next. No tool that acts is offered in this step.',
  ].join('\n');
}

/**
 * The value of an agent message, built in one place so `replyTo` and `answers` stay consistent:
 * `answers` is every post the message answers, the post its turn took up (`replyTo`) always
 * among them, each once. `answers` is absent when the message answers nothing, as a result
 * handler's outcome post does.
 */
export function agentMessageValue(input: {
  chat: string; content: string; replyTo?: string; answers?: readonly string[];
  thought?: string; codegen?: Record<string, unknown>;
}): Record<string, unknown> {
  const answers = [...new Set([...(input.replyTo ? [input.replyTo] : []), ...(input.answers ?? [])])];
  return {
    chat: input.chat, content: input.content, status: 'complete',
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(answers.length > 0 ? { answers } : {}),
    ...(input.thought !== undefined ? { thought: input.thought } : {}),
    ...(input.codegen !== undefined ? { codegen: input.codegen } : {}),
  };
}


/** The user-layer self-correction message after a build with failures or findings
 *  (the per-write compile feedback's successor): the report's tails + findings plus the files written this
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

// ─── Model-response parsing ──────────────────────────────────────────────

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
 * `toolCalls` recorder slot + the transcript). A tool dep that itself
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
  let fixMode = false; // drop to fixParams once self-correcting on an error
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
    // Emit this round's thinking as a progress step (coarse, not tokens) — unless it
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

    // A call whose arguments did not parse goes back with `{}` in their place: the provider parses
    // every tool call in the history it is sent, and refuses the whole next request with a 400 over
    // one it cannot. The tool message that answers it still quotes what the model wrote.
    const echoed = (turn.rawToolCalls as any[]).map((raw, i) => (turn.toolCalls[i]?.args === undefined
      ? { ...raw, function: { ...(raw?.function ?? {}), arguments: '{}' } }
      : raw));
    messages.push({ role: 'assistant', content: turn.text, tool_calls: echoed });

    let sawError = false;
    /** Capture one call's failure: the record, the tool message, the fix-mode flag. */
    const fail = (tc: ParsedToolCall, error: string, args: unknown = tc.args ?? tc.rawArgs, acted?: Pick<ToolCall, 'post' | 'claims'>): void => {
      // A call that was refused still ran on someone's claims, so its record names them.
      recorded.push({ name: tc.name, args, error, ...acted });
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
      // typia shape validation (+ the unknown-key refusal) of untrusted model output
      // BEFORE dispatch — for every tool alike, `mark_complete` included: a stray key on
      // it is refused like any other and the turn continues, rather than ending on a call
      // that was never checked.
      const shape = await deps.validateToolArgs(tc.name, tc.args);
      if (!shape.ok) {
        fail(tc, shape.error, tc.args);
        continue;
      }

      if (tc.name === 'mark_complete') {
        const { answers } = tc.args as { answers?: string[] };
        recorded.push({ name: tc.name, args: answers ? { answers } : {} });
        messages.push(toolResultMessage(tc.id, { ok: true }));
        return { ...done('complete', 'mark_complete'), ...(answers ? { answers } : {}) };
      }
      if (tc.name === 'take_up') {
        // A pick belongs to a decision, which is not this loop: inside a turn a post is already
        // taken up, and another person's work waits for a turn of its own.
        fail(tc, 'take_up picks a post when you are asked to decide; this turn has already taken one up, and every tool in it runs under that post. Another person\'s work waits for a turn that takes up their post.');
        continue;
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
          report = await deps.tools.build({ preview: args.preview });
        } catch (e) {
          if (postMoved(e)) return done('post-moved', POST_MOVED_DETAIL);
          // A refusal at the chat floor is the poster's, not the box's: the model reads it as
          // this call's error, where a container failure would tell it not to build again.
          if (permissionDenied(e)) { fail(tc, (e as Error).message, args, deps.actsFor?.()); continue; }
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
        recorded.push({ name: tc.name, args, result: report, ...deps.actsFor?.() });
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
          // The per-write feedback's successor: findings-plus-touched-files, in the USER layer.
          messages.push({ role: 'user', content: buildReportFeedback(report, appliedPaths) });
        }
        continue;
      }

      if (tc.name === 'invite') {
        const { email, scopeAdmin } = tc.args as { email: string; scopeAdmin?: boolean };
        try {
          const result = await deps.tools.invite(email, scopeAdmin);
          deps.onProgress?.(`invited ${email}`);
          recorded.push({ name: tc.name, args: tc.args, result, ...deps.actsFor?.() });
          messages.push(toolResultMessage(tc.id, result));
        } catch (e) {
          if (postMoved(e)) return done('post-moved', POST_MOVED_DETAIL);
          fail(tc, e instanceof Error ? e.message : String(e), tc.args, deps.actsFor?.());
        }
        continue;
      }

      if (tc.name === 'run_in_tab') {
        const { tab, code } = tc.args as { tab: string; code: string };
        try {
          const result = clipRunResult(await deps.tools.run_in_tab(tab, code));
          deps.onProgress?.(`ran code in the ${tab} tab`);
          recorded.push({ name: tc.name, args: tc.args, result, ...deps.actsFor?.() });
          messages.push(toolResultMessage(tc.id, result));
        } catch (e) {
          if (postMoved(e)) return done('post-moved', POST_MOVED_DETAIL);
          fail(tc, e instanceof Error ? e.message : String(e), tc.args, deps.actsFor?.());
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
          recorded.push({ name: tc.name, args: tc.args, result: { path, bytes: new TextEncoder().encode(content).length }, ...deps.actsFor?.() });
          messages.push(toolResultMessage(tc.id, { path, content }));
        } catch (e) {
          if (postMoved(e)) return done('post-moved', POST_MOVED_DETAIL);
          fail(tc, e instanceof Error ? e.message : String(e), tc.args, deps.actsFor?.());
        }
        continue;
      }

      if (tc.name === 'edit_file') {
        const { path, anchor, replacement } = tc.args as { path: string; anchor: string; replacement: string };
        try {
          const written = await deps.tools.edit_file(path, anchor, replacement);
          deps.onProgress?.(`edited ${written.path}`);
          appliedPaths.push(written.path);
          const result = { edited: written.path, oid: written.oid };
          recorded.push({ name: tc.name, args: tc.args, result, ...deps.actsFor?.() });
          messages.push(toolResultMessage(tc.id, result));
        } catch (e) {
          if (postMoved(e)) return done('post-moved', POST_MOVED_DETAIL);
          fail(tc, e instanceof Error ? e.message : String(e), tc.args, deps.actsFor?.());
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
        deps.onProgress?.(`wrote ${written.path}`); // per-file progress step
        appliedPaths.push(written.path);
        const result = { written: written.path, oid: written.oid };
        recorded.push({ name: tc.name, args: tc.args, result, ...deps.actsFor?.() });
        messages.push(toolResultMessage(tc.id, result));
      } catch (e) {
        if (postMoved(e)) return done('post-moved', POST_MOVED_DETAIL);
        fail(tc, e instanceof Error ? e.message : String(e), tc.args, deps.actsFor?.());
      }
    }

    fixMode = sawError;
  }
  return done('max-depth', `reached maxToolDepth ${config.maxToolDepth}`);
}
