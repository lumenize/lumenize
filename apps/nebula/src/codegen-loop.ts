/**
 * The self-correcting codegen loop driver (tasks/archive/nebula-codegen-loop.md Phases
 * 2–3; per-write compiling removed by tasks/archive/nebula-move-compilers-out-of-the-worker.md).
 * The model emits `tool_calls`, this driver runs them, and repeats until
 * `mark_complete` or a bound trips. A `write_file` is a PURE WRITE — every build-like
 * step (ontology compile, SFC type check, `vite build`) runs in the container when the
 * model calls `build`, whose {@link BuildReport} comes back as the tool result and, on
 * findings or a failed step, as a user-layer fix prompt.
 *
 * **Standalone + dependency-injected** so the loop is testable with a synthetic (fake)
 * model and no AI binding (vitest-pool-workers), and so the offline prompt harness can
 * drive it too. The driver imports only {@link assertSafeRelPath}; it holds **no
 * reference** to the `.dev` Star binding or the install/wipe methods
 * (`compileAndInstallOntology` / `resetDevData` / `setOntology`) — that absence is the
 * secure-by-default D2 guarantee (an autonomous tool can write and build but never
 * install or wipe; install/wipe stays the human-gated apply step fired AFTER the loop).
 *
 * @see tasks/archive/nebula-codegen-loop.md § Phases 2–3 (D1, D2, D4, D5, D5a, D6, D7, D8)
 */
import { stepFailed } from './build-report';
import type { BuildReport, Finding, StepResult } from './build-report';

// Re-exported for the loop's consumers (tests, the Galaxy record) — the shapes live in
// the `./build-report` leaf so the container job can share them.
export { stepFailed } from './build-report';
export type { BuildReport, Finding, StepResult } from './build-report';

/** One model tool call — the loop's per-call record slot (every dispatched call + its
 *  result/error). Folds into the agent `Message`'s `codegen` value object (Phase 2). */
export interface ToolCall {
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

/**
 * Path-safety guard for the untrusted, model-chosen `write_file` path (defense-in-depth —
 * `writeSource` only strips leading slashes, so `..` would survive). Rejects any absolute
 * path or `..` segment BEFORE anything is written. Pure + synchronous so it's
 * unit-testable. Throws on reject.
 */
export function assertSafeRelPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`Invalid source path: ${String(path)}`);
  }
  if (path.startsWith('/')) {
    throw new Error(`Absolute source path rejected: ${path}`);
  }
  if (path.split(/[/\\]/).includes('..')) {
    throw new Error(`'..' segment rejected in source path: ${path}`);
  }
}

// ─── Tool surface (write_file + build + mark_complete) ───────────────────
// The tool-args TYPES + bundle id live in the Node-safe leaf `./tool-args-constants`,
// shared with `scripts/gen-validator-seeds.ts` (which compiles them to the committed
// validator literal under tsx) without either dragging the other's graph.

/** Map a tool name → the typia type name its args validate against. */
export const TOOL_ARG_TYPE: Record<string, string> = {
  write_file: 'WriteFileArgs',
  build: 'BuildArgs',
  mark_complete: 'MarkCompleteArgs',
};

/**
 * The tool definitions handed to the model (OpenAI-shaped `tools` array, D5
 * "convert to JSON for the model"). This is a **prompt artifact**, not the
 * validation authority — typia (derived from `tool-args-constants.ts`'s
 * `TOOL_ARGS_TYPES`) is. Kept in sync with those types by hand (the surface is
 * tiny + frozen).
 */
export const CODEGEN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Save the COMPLETE new contents of one source file (e.g. src/App.vue or ' +
        'src/ontology.d.ts). The write is immediate and nothing is checked here — ' +
        'call build to check and bundle the app. Path is relative to the project root.',
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
      name: 'build',
      description:
        'Check and bundle the whole app in a clean build box — one call runs every ' +
        'step and reports each: ontology (compiles src/ontology.d.ts when it changed), ' +
        'typeCheck (advisory findings over every .vue — checked files with no findings ' +
        'are clean), bundle (vite build), and publish (whether the preview refreshed). ' +
        'A failed container step is infrastructure — you may retry unchanged, unless ' +
        'its tail says the job TIMED OUT, in which case retrying the same code will ' +
        'time out again. Fix code problems with write_file and call build again. The ' +
        'preview publishes by default only on a findings-free build; pass ' +
        '{ "publish": true } to publish alongside findings you judge harmless (never ' +
        'possible when bundle failed — there is no dist).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          publish: {
            type: 'boolean',
            description:
              'Override the default publish decision: true publishes the preview even ' +
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
  | 'error';          // a controlled loop error (never an uncaught crash)

export interface LoopResult {
  stop: StopReason;
  /** Model inferences performed (rounds). */
  rounds: number;
  /** Every dispatched call + its result/error — folds into the agent Message's codegen object. */
  toolCalls: ToolCall[];
  /** The full assembled transcript (system + user + assistant/tool/user rounds). */
  messages: ChatMessage[];
  /** Paths written this run (normalized). */
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

export interface CodegenLoopDeps {
  /** Abstracts `env.AI.run(STUDIO_MODEL, …)` — fake (script) in tests. */
  callModel(messages: ChatMessage[], params: ModelParams): Promise<unknown>;
  /** Persist one file (Galaxy.writeSource → Workspace + git commit). PURE — no
   *  compile, no check; the container `build` is where checking happens. */
  writeFile(path: string, content: string): Promise<{ oid: string; path: string }>;
  /**
   * One ephemeral container build cycle — the job runs EVERY step (ontology compile,
   * SFC type check, `vite build`) against the FUSE-mounted workspace and reports each
   * (Galaxy's `build`, serialized by its promise-chain latch). `publish` is the
   * model's override (BuildArgs). A throw is captured by the loop into a report whose
   * `container` step failed; it never aborts the turn.
   */
  build(opts?: { publish?: boolean }): Promise<BuildReport>;
  /** typia shape validation of tool args. Async — the validator is a facet. */
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
  maxToolDepth: 8,
  generateParams: { temperature: 0.7, max_tokens: 4096 },
  fixParams: { temperature: 0.2, max_tokens: 4096 },
};

// ─── Prompt assembly ─────────────────────────────────────────────────────

/**
 * Assemble the layered codegen prompt. The system layer is a **cascade of
 * composable bundles** (NOT a single hardcoded string) — the future insertion
 * seam for the Platform/Universe/Galaxy practice cascade (on-hold/nebula-skills.md);
 * out of scope to fill now, but the shape must not foreclose it. The **ontology
 * `.d.ts` is pinned in its own stable system block**. The user layer carries
 * the request + current source (+ error-tail on a fix round, added by the loop).
 */
export function assembleCodegenPrompt(opts: {
  systemBundles: string[];
  ontologyDts?: string;
  userRequest: string;
  currentSource?: string;
}): { system: ChatMessage; user: ChatMessage } {
  const bundles = [...opts.systemBundles];
  if (opts.ontologyDts) {
    bundles.push(`The current ontology (src/ontology.d.ts) is:\n\`\`\`ts\n${opts.ontologyDts}\n\`\`\``);
  }
  const userParts = [`User request: ${opts.userRequest}`];
  if (opts.currentSource) {
    userParts.unshift(`Current src/App.vue:\n\`\`\`vue\n${opts.currentSource}\n\`\`\``);
  }
  return {
    system: { role: 'system', content: bundles.join('\n\n') },
    user: { role: 'user', content: userParts.join('\n\n') },
  };
}

/** The user-layer self-correction message after a build with failures or findings
 *  (D1/D7/D8's successor): the report's tails + findings plus the files written this
 *  turn, pushed back so the model fixes and rebuilds. A per-build findings list is not
 *  attached to one file, so no single file's source is re-echoed — the diagnostics
 *  carry file and line themselves. */
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
    `Fix with write_file (complete file contents) and call build again — or, if you judge ` +
    `every finding harmless, call build with { "publish": true }.`
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
 * `toolCalls` recorder slot + the transcript; D4/m2). A `writeFile` that itself
 * throws is also captured, not propagated.
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

  const done = (stop: StopReason, detail: string): LoopResult => ({
    stop, detail, rounds: round, toolCalls: recorded, messages, appliedPaths, lastBuild,
    output: lastText, reasoning: reasoningParts.join('\n\n— — —\n\n'),
  });

  while (round < config.maxToolDepth) {
    round++;
    const raw = await deps.callModel(messages, fixMode ? config.fixParams : config.generateParams);
    const turn = parseModelTurn(raw);
    lastText = turn.text;
    if (turn.reasoning.trim().length > 0) reasoningParts.push(turn.reasoning);
    // Phase 3: emit this round's thinking as a progress step (coarse, not tokens).
    const step = turn.reasoning.trim() || turn.text.trim();
    if (step.length > 0) deps.onProgress?.(step);

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
    for (const tc of turn.toolCalls) {
      if (tc.name === 'mark_complete') {
        recorded.push({ name: tc.name, args: {} });
        messages.push(toolResultMessage(tc.id, { ok: true }));
        return done('complete', 'mark_complete');
      }

      if (tc.name === 'build') {
        // The build is a TOOL — the model checks its own work; each call is one
        // ephemeral container cycle running EVERY step. EXEMPT from the identical-call
        // detector below (like mark_complete): fix-then-rebuild legitimately repeats
        // `build`. The per-step report goes back as the tool result; a failed step or
        // a type finding makes this a fix round, never an abort.
        if (tc.args === undefined) {
          // m2a: malformed arguments JSON — same capture as any other tool.
          const error = `malformed tool arguments: ${tc.argsParseError ?? 'not JSON'}`;
          recorded.push({ name: tc.name, args: tc.rawArgs, error });
          messages.push(toolResultMessage(tc.id, { error }));
          sawError = true;
          continue;
        }
        const args = tc.args as { publish?: boolean };
        const shape = await deps.validateToolArgs('build', args);
        if (!shape.ok) {
          recorded.push({ name: tc.name, args: tc.args, error: shape.error });
          messages.push(toolResultMessage(tc.id, { error: shape.error }));
          sawError = true;
          continue;
        }
        deps.onProgress?.('building…');
        let report: BuildReport;
        try {
          report = await deps.build(args);
        } catch (e) {
          // The job never ran at all — a container-step failure; every other step is
          // honestly "did not run" rather than absent (the shape's own rule).
          const tail = e instanceof Error ? e.message : String(e);
          report = {
            container: { ran: true, ok: false, tail },
            ontology: { ran: false, why: 'the build job did not run' },
            typeCheck: { ran: false, checked: [], findings: [] },
            bundle: { ran: false, why: 'the build job did not run' },
            publish: { done: false, why: 'the build job did not run' },
          };
        }
        lastBuild = report;
        recorded.push({ name: tc.name, args, result: report });
        messages.push(toolResultMessage(tc.id, report));
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

      // Loop-detection #2 — identical tool call repeat (same name + args).
      // mark_complete is exempt (handled above); a write_file with NEW content
      // is not "identical" (different hash), so legitimate fixes are never aborted.
      const callHash = `${tc.name}:${fnv1a(stableStringify(tc.args ?? tc.rawArgs))}`;
      if (seenCallHashes.has(callHash)) return done('loop-detected', `repeated tool call ${tc.name}`);
      seenCallHashes.add(callHash);

      if (tc.name !== 'write_file') {
        // m2b: unknown tool name.
        const error = `unknown tool '${tc.name}'`;
        recorded.push({ name: tc.name, args: tc.args ?? tc.rawArgs, error });
        messages.push(toolResultMessage(tc.id, { error }));
        sawError = true;
        continue;
      }

      if (tc.args === undefined) {
        // m2a: malformed arguments JSON.
        const error = `malformed tool arguments: ${tc.argsParseError ?? 'not JSON'}`;
        recorded.push({ name: tc.name, args: tc.rawArgs, error });
        messages.push(toolResultMessage(tc.id, { error }));
        sawError = true;
        continue;
      }

      // D5: typia shape validation (untrusted model output) BEFORE dispatch.
      const shape = await deps.validateToolArgs('write_file', tc.args);
      if (!shape.ok) {
        recorded.push({ name: tc.name, args: tc.args, error: shape.error });
        messages.push(toolResultMessage(tc.id, { error: shape.error }));
        sawError = true;
        continue;
      }
      const { path, content } = tc.args as { path: string; content: string };

      // D5a: path-safety on the untrusted, model-chosen path BEFORE any write
      // (writeSource only strips leading slashes — `..` would survive).
      try {
        assertSafeRelPath(path);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        recorded.push({ name: tc.name, args: tc.args, error });
        messages.push(toolResultMessage(tc.id, { error }));
        sawError = true;
        continue;
      }

      // Persist — a PURE write. No compile, no check: the container `build` is where
      // every check runs, and its report is the self-correction signal.
      try {
        await deps.writeFile(path, content);
        deps.onProgress?.(`wrote ${path}`); // Phase 3: per-file progress step
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        recorded.push({ name: tc.name, args: tc.args, error });
        messages.push(toolResultMessage(tc.id, { error }));
        sawError = true;
        continue;
      }
      const rel = path.replace(/^\/+/, '');
      appliedPaths.push(rel);
      const result = { written: rel };
      recorded.push({ name: tc.name, args: tc.args, result });
      messages.push(toolResultMessage(tc.id, result));
    }

    fixMode = sawError;
  }
  return done('max-depth', `reached maxToolDepth ${config.maxToolDepth}`);
}
