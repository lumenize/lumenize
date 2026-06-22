# vibesdk — LLM-orchestration patterns (mined for Nebula's codegen engine)

**What this is.** Patterns mined from [`cloudflare/vibesdk`](https://github.com/cloudflare/vibesdk) (MIT, ~a year of production iteration), shallow-cloned 2026-06-22. The output of the **vibesdk study** roadmap item in [`../nebula-agentic-development-engine.md`](../nebula-agentic-development-engine.md) Part 2. **Filter applied:** *talking-to-LLMs* patterns only — NOT what-code-to-generate, NOT vibesdk's sandbox/dev-loop/backend (we have `nebula-dev-flows.md`). Code refs are `path:line` into the repo. vibesdk uses the **Vercel AI SDK / OpenAI SDK over AI Gateway**; Nebula uses the **Workers AI binding** (`env.AI.run`) directly — so "adopt" usually means *port the idea*, not the transport. MIT — excerpts fine; any copied code follows `ATTRIBUTIONS.md` + the <1000-SLOC rule.

> **Reproduce:** `git clone --depth 1 https://github.com/cloudflare/vibesdk /tmp/vibesdk`. Line numbers are from the 2026-06-22 HEAD; treat as approximate if the repo has moved.

---

## Top takeaways for our next builds

For the **self-correcting codegen loop** (the next roadmap item) and the future **in-app AI chat**, in rough priority:

1. **Completion-signal tools bound the loop.** A `mark_generation_complete` / `mark_debugging_complete` tool that, when called, *stops* the loop — cleaner than polling or a turn counter alone. Pair with a hard **max-tool-calling-depth per operation** and **loop detection** (below). → our loop's stop condition.
2. **Native tool-calling = Zod schema + impl, split.** Tools declare a schema (→ JSON for the model) + a TypeScript implementation; the loop dispatches `tool_calls`, runs them (topologically by resource conflicts), feeds results back. Port the *shape*; bridge Zod→JSON ourselves for the Workers AI binding (no OpenAI SDK). NOTE: our schema language is TS-types/typia (ADR-001), not Zod — define tool schemas the typia way.
3. **Error-tail freshness discipline.** Runtime errors are *stale* until deploy→wait→re-fetch; vibesdk's debugger enforces that sync-point. Our **Rung-1 compile error-tail is synchronous** (good), but a *runtime/preview* error-tail needs the deploy→wait→re-fetch cycle before declaring a fix.
4. **Loop detection guards autonomy.** Detect (a) identical tool-call repeats and (b) text repetition (rolling hash) → abort + retry. Cheap, high-value; adopt for the self-correcting loop.
5. **Composable system prompt; live state in the *user* layer.** Base role + modular instruction bundles in the system message (stable); inject files/errors/state in the user message. For us: **pin the ontology `.d.ts` in a stable system block**; keep the codegen prompt separate from the in-app-chat prompt.
6. **Bounded state machine.** Decompose into phases with a `MAX_PHASES` cap + per-phase completion signal + errors fed back to the planner. Maps cleanly onto mesh continuations / DO states.
7. **Token efficiency for in-app chat:** LLM-powered conversation **compactification** (summarize older turns past a 40-turn / ~100k-token threshold, keep the last 10) — but **pin the ontology outside the windowed history** (it's schema, not conversation).
8. **AI-Gateway metadata tags** (`cf-aig-metadata`) for per-call cost attribution → directly feeds `nebula-tenant-ai-billing.md`.

---

## 1. Model routing

**Pattern.** A two-tier config: a `PLATFORM_AGENT_CONFIG` (multi-provider via AI Gateway) and a `DEFAULT_AGENT_CONFIG`, each mapping ~13 agent operations (`blueprint`, `phaseImplementation`, `conversationalResponse`, …) to `{ name, reasoning_effort, max_tokens, fallbackModel, temperature }`. User overrides are stored in DB and merged with defaults at runtime, with constraint validation + automatic fallback on violation.
- **Ref:** `worker/agents/inferutils/config.ts:58–186` (the config maps); `worker/database/services/ModelConfigService.ts:54–111` (`mergeWithDefaults` + `applyConstraintsWithFallback`); `worker/agents/inferutils/config.types.ts:387–410` (`ModelConfig` + `AgentActionKey`).
- **For Nebula:** Adopt the per-operation config map — a small `{ generate, chat, fix }` table with Kimi primary + a fallback model + per-op `temperature`/`max_tokens`. Map `reasoning_effort` → Kimi's thinking budget. The constraint+fallback merge is portable; keep it model-agnostic (one swappable `STUDIO_MODEL`-style indirection per op).

## 2. System-prompt architecture

**Pattern.** Composable, template-based assembly: a base system prompt + reusable instruction *bundles* (`UI_NON_NEGOTIABLES_V3`, `COMMON_PITFALLS`, `COMMON_DEP_DOCUMENTATION`) + `{{variable}}` injection that's **sanitized against prompt injection**. Code-gen ops use a **three-layer message stack**: system (base + blueprint) → user (serialized project context: file tree, phase history, command history) → assistant ack. Live state lives in the *user* layer so the system prompt stays stable/reusable. The conversational agent has its own large static persona prompt, isolated from codegen.
- **Ref:** `worker/agents/prompts.ts:16–43` (`replaceTemplateVariables` + `sanitizeUserQueryForPrompt`), `:886–933` (`generalSystemPromptBuilder`); `worker/agents/operations/common.ts:17–44` (the three-layer stack); `worker/agents/operations/UserConversationProcessor.ts:74–285` (isolated chat persona).
- **For Nebula:** Adopt composable bundles + the system/user split. **Pin the current ontology `.d.ts` + Nebula API surface as a stable system block** (it's the spec); inject files/errors/turn state in the user layer. **Separate** the in-app-chat prompt from the codegen prompt — don't mix a conversational persona with the architect/generation rules. The injection-sanitization step matters once user-developer vision docs feed the prompt (ties to the parked `nebula-skills.md`).

## 3. Tool definitions & the tool-calling loop

**Pattern.** A `tool()` factory wraps a Zod schema + a TS implementation into a `ToolDefinition`, compiled to an OpenAI function schema (`z.toJSONSchema`). The loop builds a **topological execution plan** (parallelize independent tools, respect read/write resource conflicts), retries on `InferError`, and **stops immediately when a completion-signal tool fires** (`mark_generation_complete` / `mark_debugging_complete`).
- **Ref:** `worker/agents/tools/types.ts:87–118` (`tool()` factory); `worker/agents/inferutils/toolExecution.ts:24–234` (`buildExecutionPlan` / `executeToolCallsWithDependencies`); `worker/agents/inferutils/completionDetection.ts` (completion scan); `worker/agents/tools/toolkit/completion-signals.ts:10–69`.
- **For Nebula:** Adopt the **schema+impl split** and the **completion-signal tool** (our loop's clean stop). Define our tool surface (`write_file`, `read_files`, `get_recent_errors`, `mark_complete`). Skip the OpenAI SDK — convert our **typia/TS-type** tool schemas to JSON and parse `tool_calls` from the Workers AI response ourselves. Resource-conflict topological execution is a nice-to-have once we have >1 concurrent tool; not needed for the first thin loop.

## 4. State machine for bounded work

**Pattern.** Generation is decomposed into **explicit phases**: `PhaseGenerationOperation` plans the next milestone (detects incomplete work, prioritizes runtime errors, emits an `isFinal`/`lastPhase` signal) and `PhaseImplementationOperation` executes it. Bounds are enforced at several levels: a `MAX_PHASES` cap, a per-action **max tool-calling depth** (`getMaxToolCallingDepth(actionKey)`), completion-signal detection, and an error-recovery operation (`FastCodeFixerOperation`) feeding static-analysis results back to the planner.
- **Ref:** `worker/agents/operations/PhaseGeneration.ts:274–336`; `worker/agents/operations/PhaseImplementation.ts:37–156`; `worker/agents/inferutils/core.ts:695–707` (tool-depth enforcement); `worker/agents/core/state.ts` (`MAX_PHASES`).
- **For Nebula:** Adopt phase decomposition + the multi-level bound (max rounds + max tool-depth + completion signal + error feedback to the planner). Each phase maps to a **mesh continuation / DO state** — a natural fit for DevStudio (ADR-003: one-way messages + continuations). Start with a single "generate→validate→fix" phase loop bounded at a few rounds, not vibesdk's full multi-phase project builder.

## 5. Streaming, abort & reconnect

**Pattern.** A chunk-accumulator + `onChunk` callback streams content (and tool_calls, accumulated by index/id) as it arrives; an `AbortController` per inference (`getOrCreateAbortController`) cancels mid-generation and is caught as an `AbortError` that **captures the partial response + tool-call transcript**. Reconnect uses a `shouldBeGenerating` flag + a `generationPromise` guard so `RESUME_GENERATION` re-enters the same state without duplicating work.
- **Ref:** `worker/agents/inferutils/core.ts:911–938` (streaming loop), `:870` (abort signal), `:881–886` (abort → partial transcript); `worker/agents/core/behaviors/base.ts:308–338` (abort lifecycle); `worker/agents/core/websocket.ts:108–148` (STOP/RESUME).
- **For Nebula:** The engine doc already wants **streaming as a Mesh WS primitive over the existing connection** — vibesdk's `onChunk` shape ports directly (broadcast chunks as they arrive). Abort → our mesh cancellation; **keep the partial-transcript-on-abort** (useful for the turn recorder + debugging). Reconnect/resume is **thin in vibesdk** (relies on agentId + message history; no mid-stream DO-restart recovery) — for us, persisted generation state + resume-from-last-phase is the equivalent; don't over-invest.

## 6. Token efficiency

**Pattern.** Four tactics: (a) **message dedup** by `(conversationId, role, tool_call_id)`; (b) **orphaned-tool-result skipping** (drop tool messages with empty name / mismatched `tool_call_id`); (c) **LLM-powered conversation compactification** — past 40 turns OR ~100k est. tokens, summarize older messages into one archive message, keep the last 10 (fallback: keep last 20 if summarization fails); (d) conservative **whitespace-only text trimming** (never touches code indentation). A `MAX_LLM_MESSAGES` hard cap is a runaway guard. No prompt-level caching — caching is left to AI Gateway.
- **Ref:** `worker/agents/utils/conversationCompactifier.ts:94–317` (`shouldCompactify` + `compactifyContext`); `worker/agents/inferutils/core.ts:768–802` (orphaned-tool filtering), `:204–243` (`optimizeTextContent`); `worker/agents/constants.ts:126` (`MAX_LLM_MESSAGES`).
- **For Nebula:** **Compactification is the big win for in-app chat** — adopt the turn/token-threshold + summarize-older pattern. **Crucial difference:** the ontology `.d.ts` is *pinned schema*, not windowed history — never summarize it. Dedup + orphaned-tool filtering apply once our loop is multi-turn tool-calling. Whitespace trimming is safe to adopt wholesale.

## 7. AI-Gateway integration

**Pattern.** All inference routes through a resolved gateway URL (user BYOK → runtime override → platform env → CF binding) with a **`cf-aig-metadata`** JSON header tagging each request `{ chatId, userId, schemaName, actionKey }` for per-request analytics. Token accounting (cached vs uncached) comes back via the Analytics GraphQL API → a cache-hit-rate dashboard.
- **Ref:** `worker/agents/inferutils/core.ts:255–304` (`buildGatewayUrl`), `:872–878` (metadata header); `worker/services/analytics/AiGatewayAnalyticsService.ts:265–321` (token/cache analytics).
- **For Nebula:** The **metadata-tag pattern feeds `nebula-tenant-ai-billing.md`** directly — tag Workers AI / AI-Gateway calls with `{ instance, userId, op }` for per-tenant cost attribution. The gateway URL-resolution chain is vibesdk-specific (we call `env.AI.run`); if we later front Workers AI with AI Gateway (for caching/multi-region), the metadata + analytics pattern transfers.

## 8. Structured output & validation

**Pattern.** Zod schemas are the single source of truth, converted to OpenAI strict `json_schema` response format (`additionalProperties:false`). For code *edits*, vibesdk ships **two diff formats** — unified diff and **search/replace blocks** — the latter parsed by a state machine with **multi-strategy matching** (exact → whitespace-insensitive → indentation-preserving → fuzzy/Levenshtein) and **ambiguity/quality scoring** that raises the fuzzy threshold on repetitive code (switch cases, `Math.*`) to avoid hallucinated matches.
- **Ref:** `worker/agents/schemas.ts` (Zod output schemas); `worker/agents/inferutils/core.ts:64–81` (`buildJsonSchemaResponseFormat`); `worker/agents/output-formats/diff-formats/search-replace.ts:17–879` (the robust parser + `analyzeSearchBlockQuality`).
- **For Nebula:** Validate model outputs against our **TS-types via typia** (ADR-001) — the analog of vibesdk's Zod→json_schema, but it's *our* schema language (don't introduce Zod). When DevStudio moves beyond whole-file regen to **edits**, the **search/replace format + ambiguity detection** is the proven, LLM-reliable choice — strongly consider porting that parser (MIT, ~860 lines — mind the <1000-SLOC + ATTRIBUTIONS rule).

## 9. Long-context strategies

**Pattern.** Beyond compactification (§6): **selective file inclusion** — only "relevant" files (blueprint/user-generated) enter the context, template boilerplate is excluded and frozen as an immutable `GenerationContext`; a `MessageLoader` abstraction swaps history backends (SQLite vs AI-SDK store); multimodal images are converted to base64 *just before* inference (not stored in history).
- **Ref:** `worker/agents/domain/values/GenerationContext.ts:38–80` (relevant-file filtering + freeze); `worker/agents/core/conversation/MessageLoader.ts:36–103`; `worker/agents/utils/common.ts:269–288` (just-in-time image prep).
- **For Nebula:** Adopt **selective inclusion** — once an app has many files, don't dump all of them every turn; include touched/relevant files in full, reference the rest by name with fetch-on-demand (a `read_files` tool). Keep the ontology pinned. The MessageLoader abstraction is more than we need now (one backend), but the "context is an immutable, filtered snapshot" discipline is worth keeping.

## Deep-debugger ordering (sub-pattern of §3/§4)

**Pattern.** `DeepDebuggerOperation` is an isolated nested tool-loop: loads file summaries + initial runtime errors once (a reusable "session"), runs read→understand→fix→deploy→verify (ordering is *prompt-hinted*, not hard-sequenced — dependencies drive parallelization), and signals `mark_debugging_complete`. It explicitly treats runtime errors as **stale until a fresh deploy→wait→re-fetch** and reuses the previous transcript on interrupt.
- **Ref:** `worker/agents/operations/DeepDebugger.ts:1–238`; `worker/agents/tools/toolkit/get-runtime-errors.ts:5–56` (error-staleness note); `worker/agents/tools/customTools.ts:69–83` (`buildDebugTools`).
- **For Nebula:** This is the template for our **error-tail self-correction**: a bounded debug sub-loop with a completion signal, a once-loaded session (current source + the error-tail), and the **deploy→wait→re-fetch freshness rule** for runtime/preview errors (our compile-stage Rung-1 errors are synchronous, so that half is simpler). Save the partial transcript on user-abort for the next round.

## Bonus: loop detection + diff robustness

- **Loop detection (adopt):** a `LoopDetector` flags 2+ identical tool calls (same name+args) within 2 min; a **rolling-hash text-repetition detector** (char/word/sentence level over a ~4k window) aborts runaway generation → retry. Cheap insurance for any autonomous loop. (`worker/agents/inferutils/core.ts` repetition guard; LoopDetector util.)
- **Search/replace robustness:** see §8 — the ambiguity/quality scoring is the non-obvious part that makes LLM edits reliable on repetitive code.

## What's vibesdk-specific (skip) + the Think note

- **`@cloudflare/think` is one pluggable *behavior*, not the foundation — grep-verified 2026-06-22.** vibesdk selects a `behaviorType` at runtime among **four interchangeable behaviors** (`base`/`phasic`/`agentic`/`think` — `worker/agents/core/behaviors/`, chosen in `codingAgent.ts:194–206`). Only `behaviors/think.ts` + `worker/agents/think/*` + `space-workspace-ops.ts` import `@cloudflare/think@0.8.6`. **The entire shared orchestration stack is Think-free** — `inferutils/core.ts` (streaming, abort, the tool-calling loop, completion-detection, AI-Gateway, token-efficiency), `inferutils/config.ts` (model routing), `tools/*`, `prompts.ts` + `operations/*`, `schemas.ts` + `output-formats/*`, `conversationCompactifier.ts` all have **zero** Think imports. So **~none of §1–§9 comes from Think**: each is either that shared infrastructure or the **`phasic`** behavior (§4), the Think-free sibling of the `think` behavior. **Our 'no Think' decision costs us nothing here** — the patterns port cleanly; we'd simply pick a non-`think` behavior. (vibesdk keeps Think as a *peer* option, not a deprecation.)
- **Vercel/OpenAI SDK over AI Gateway** — our transport is the Workers AI binding; port ideas, not the SDK wiring.
- **Their sandbox/dev-loop/deploy** (containers, preview, git) — out of scope; we have `nebula-dev-flows.md`.
- **Codemode** — vibesdk doesn't lean on it; our rejection (ADR-002) stands. When we want sandboxed dynamic execution it's the mesh full-type bridge, not codemode's JSON.

A reader can now design DevStudio's self-correcting loop + the in-app chat prompts/tools without re-reading vibesdk.
