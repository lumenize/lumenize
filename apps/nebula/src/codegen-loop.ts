/**
 * The self-correcting codegen loop driver (tasks/archive/nebula-codegen-loop.md Phases 2–3).
 * Replaces the one-shot regex `extractVueBlock` path: the model emits `tool_calls`,
 * this driver runs them, feeds the **container-free Rung-1 compile** error-tail back
 * each round, and repeats until `mark_complete` or a bound trips.
 *
 * **Standalone + dependency-injected** so the loop is testable with a synthetic (fake)
 * model and no AI binding (Phase 2/3, vitest-pool-workers), and so the offline prompt
 * harness can drive it too. The driver imports only the pure {@link compileSource} gate
 * and {@link assertSafeRelPath}; it holds **no reference** to the `.dev` Star / DevContainer
 * bindings or the install/wipe methods (`compileAndInstallOntology` / `applyOntologyChange`
 * / `resetDevData` / `setOntology` / `setAppVersion` / `applyChanges`) — that absence is
 * the secure-by-default D2 guarantee (an autonomous tool can compile but never install or
 * wipe; install/wipe stays the human-gated apply step fired AFTER the loop, Flow 1b).
 *
 * @see tasks/archive/nebula-codegen-loop.md § Phases 2–3 (D1, D2, D4, D5, D5a, D6, D7, D8)
 */
import { compileSource, type GateResult } from './codegen-gate';
import { assertSafeRelPath } from './dev-container';
import type { ToolCall } from './galaxy';

// ─── Tool surface (D1: write_file + mark_complete only) ──────────────────

/** Tool-arg TS types — the ADR-001 source of truth for runtime validation
 *  (compiled to a typia validator via `generateParseModule`; see DevStudio). */
export const TOOL_ARGS_TYPES = `
interface WriteFileArgs { path: string; content: string; }
interface MarkCompleteArgs {}
`;

/** Stable Worker-Loader bundle id for the tool-args validator facet. The tool
 *  surface is identical across tenants (not tenant data), so a shared id is
 *  correct — same validator, shared cache (durable-objects.md Worker Loader cache). */
export const TOOL_ARGS_BUNDLE_ID = 'nebula-devstudio-tool-args-v1';

/** Map a tool name → the typia type name its args validate against. */
export const TOOL_ARG_TYPE: Record<string, string> = {
  write_file: 'WriteFileArgs',
  mark_complete: 'MarkCompleteArgs',
};

/**
 * The tool definitions handed to the model (OpenAI-shaped `tools` array, D5
 * "convert to JSON for the model"). This is a **prompt artifact**, not the
 * validation authority — typia (derived from {@link TOOL_ARGS_TYPES}) is. Kept
 * in sync with those types by hand (the surface is tiny + frozen).
 */
export const CODEGEN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write the COMPLETE new contents of one source file (e.g. src/App.vue or ' +
        'src/ontology.d.ts). The file is compiled immediately; the result (and any ' +
        'compile error) is returned so you can fix it. Path is relative to the project root.',
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
      name: 'mark_complete',
      description: 'Call when the app is finished and all files compile cleanly.',
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
  /** The recorder slot (`TurnRecord.toolCalls`) — every dispatched call + its result/error. */
  toolCalls: ToolCall[];
  /** The full assembled transcript (system + user + assistant/tool/user rounds). */
  messages: ChatMessage[];
  /** Paths written this run (normalized). */
  appliedPaths: string[];
  /** The last compile-gate result (the recorder's `validate`/`error` source). */
  lastGate?: GateResult;
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
  /** Persist one file (DevStudio.writeSource → Workspace + git commit). */
  writeFile(path: string, content: string): Promise<{ oid: string; path: string }>;
  /** typia shape validation of tool args (D5). Async — the validator is a facet. */
  validateToolArgs(toolName: string, args: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface CodegenLoopConfig {
  /** Max model inferences per turn (D4 — the runaway stop). */
  maxToolDepth: number;
  /** Per-call params (D6): full temp for the first/generate pass. */
  generateParams: ModelParams;
  /** Lower temp once self-correcting on a compile error (D6). */
  fixParams: ModelParams;
}

export const DEFAULT_LOOP_CONFIG: CodegenLoopConfig = {
  maxToolDepth: 8,
  generateParams: { temperature: 0.7, max_tokens: 4096 },
  fixParams: { temperature: 0.2, max_tokens: 4096 },
};

// ─── Prompt assembly (D7) ────────────────────────────────────────────────

/**
 * Assemble the layered codegen prompt. The system layer is a **cascade of
 * composable bundles** (NOT a single hardcoded string) — the future insertion
 * seam for the Platform/Universe/Galaxy practice cascade (on-hold/nebula-skills.md);
 * out of scope to fill now, but the shape must not foreclose it. The **ontology
 * `.d.ts` is pinned in its own stable system block** (D7). The user layer carries
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

/** The user-layer self-correction message after a failing compile (D1/D7/D8):
 *  the just-written source + the bounded error-tail, pushed back so the model fixes it. */
function buildFixFeedback(path: string, content: string, errorTail: string | undefined): string {
  return (
    `\`${path}\` did not compile. Here is what you wrote:\n\`\`\`\n${content}\n\`\`\`\n\n` +
    `Compile error:\n\`\`\`\n${errorTail ?? '(no detail)'}\n\`\`\`\n\n` +
    `Fix it and call write_file again with the corrected full file contents.`
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
  let lastGate: GateResult | undefined;
  let lastText = '';
  let round = 0;
  let fixMode = false; // D6: drop to fixParams once self-correcting on an error

  const done = (stop: StopReason, detail: string): LoopResult => ({
    stop, detail, rounds: round, toolCalls: recorded, messages, appliedPaths, lastGate,
    output: lastText, reasoning: reasoningParts.join('\n\n— — —\n\n'),
  });

  while (round < config.maxToolDepth) {
    round++;
    const raw = await deps.callModel(messages, fixMode ? config.fixParams : config.generateParams);
    const turn = parseModelTurn(raw);
    lastText = turn.text;
    if (turn.reasoning.trim().length > 0) reasoningParts.push(turn.reasoning);

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

      // Persist, then run the path-dispatched Rung-1 compile gate.
      try {
        await deps.writeFile(path, content);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        recorded.push({ name: tc.name, args: tc.args, error });
        messages.push(toolResultMessage(tc.id, { error }));
        sawError = true;
        continue;
      }
      const gate = compileSource(path, content);
      lastGate = gate;
      appliedPaths.push(path.replace(/^\/+/, ''));
      recorded.push({ name: tc.name, args: tc.args, result: gate });
      messages.push(toolResultMessage(tc.id, gate));
      if (!gate.ok) {
        sawError = true;
        // D1/D7/D8: push the source + bounded error-tail in the USER layer.
        messages.push({ role: 'user', content: buildFixFeedback(path, content, gate.errorTail) });
      }
    }

    fixMode = sawError;
  }
  return done('max-depth', `reached maxToolDepth ${config.maxToolDepth}`);
}
