# vibesdk LLM-Patterns Extraction

**Status**: Planned — gates on Phase 5.3 (subscriptions) shipping
**Output**: `tasks/reference/vibesdk-llm-patterns.md` — a topic-organized pattern playbook
**Why it slots here**: The patterns inform both Studio's own design AND the in-app chat-feature building block we'll ship to user-developers. Doing this read before the pre-Studio milestone means the milestone's prompts and tool surface are designed against accumulated production wisdom, not first-principles guessing.
**Estimated effort**: 2–3 hours of focused reading + writing.

## Goal

Mine [`cloudflare/vibesdk`](https://github.com/cloudflare/vibesdk) (MIT, ~5K stars, actively maintained) for production-tested patterns in building LLM-powered applications, and capture them as a topic-organized reference document we can apply during Studio implementation and in-app chat-feature design.

vibesdk is an open-source vibe-coding platform from Cloudflare. The back-end architecture overlaps heavily with what we've already designed for Nebula (DO-per-session, SQLite-backed git for iteration, multi-LLM, sandboxed-container previews), so we're NOT mining for back-end patterns. We're mining for the layer above — the prompts, the model routing, the tool definitions, the state-machine-driven agent loop, the streaming-and-abort plumbing — which is where vibesdk's ~year of production iteration produces wisdom we can't easily derive from first principles.

## Files to read deeply

Listed roughly in priority order — early files are highest expected payoff per minute spent.

1. **`worker/agents/inferutils/config.ts`** — `AGENT_CONFIG` object mapping each operation to a specific model. Their choices encode measured trade-offs.
2. **`worker/agents/prompts.ts`** — system prompts that survived production iteration.
3. **`worker/agents/operations/UserConversationProcessor.ts`** (system prompt around line 50) — the chat pattern itself.
4. **`worker/agents/operations/PhaseGeneration.ts`** and **`PhaseImplementation.ts`** — state machine in action, multi-step generation with bounded autonomy.
5. **`worker/agents/assistants/codeDebugger.ts`** — deep-debugger pattern. Gemini 2.5 Pro at high reasoning effort with a specific tool ordering (`run_analysis → get_runtime_errors → get_logs`).
6. **`worker/agents/tools/customTools.ts`** and **`worker/agents/tools/toolkit/`** — tool definitions. Especially `read-files`, `run-analysis`, `regenerate-file`.
7. **`worker/agents/schemas.ts`** — structured output schemas for LLM responses.
8. **AI Gateway integration code** — likely in `worker/services/` or `worker/agents/inferutils/`. Patterns for routing multi-provider calls through Cloudflare's AI Gateway for observability, caching, rate limiting, retry.
9. **`samplePrompts.md`** + anything in **`docs/`** — prompt engineering reference material.
10. **Their `CLAUDE.md`** — already partially read; flagged production behaviors like "Backend skips redundant LLM calls (empty tool results)" and message-deduplication patterns worth understanding the implementation of.

## Topics for the output reference doc

Organize `tasks/reference/vibesdk-llm-patterns.md` by topic, not by file. Suggested sections:

- **Model routing** — which model for which operation, and why
- **System prompt architecture** — how the prompts are structured, what's in vs out, how they teach the LLM constraints
- **Tool definitions and tool-use loops** — when the LLM should call tools vs. answer directly; tool-result handling
- **State machine for bounded agent work** — IDLE → PHASE_GENERATING → PHASE_IMPLEMENTING → REVIEWING and the transitions
- **Streaming + abort + reconnect** — abort-controller patterns, state restoration, message dedup during tool execution
- **Token-efficiency techniques** — empty-tool-result skipping, message dedup, anything related to prompt caching
- **AI Gateway integration patterns** — how observability, caching, rate-limit handling, retry are wired
- **Structured output and validation** — schemas, retry-on-malformed-output patterns
- **Long-context strategies** — how they handle growing project size against context window limits

For each section: a short prose summary + a code excerpt or two + a "what to consider for Nebula" note that maps the pattern onto Studio specifically and onto in-app chat features specifically.

## Where the output applies

- **Studio's own AI design**: cold-start interview prompts, the wizard-flow state machine, the tool surface (`get_current_ontology`, `subscribe_debug_namespace`, `deploy_to_dev`, etc.), model selection per task. See `tasks/nebula-studio.md`.
- **In-app chat features for user-developer-built products**: user-developers won't author LLM orchestration; they'll use a platform-provided chat-agent building block. Same patterns transfer.
- **Future LLM-touching features** anywhere on the platform.

## Caveats

- vibesdk's deployment target (Workers for Platforms namespaces, generated React+Tailwind apps) is NOT Nebula's deployment target. Filter the reading: we want patterns about *talking to LLMs*, not patterns about *what code to generate*.
- vibesdk uses isomorphic-git + SQLite; we may end up using the same (see scratchpad note about replacing wasm-git with isomorphic-git for iteration history). That's a separate decision tracked elsewhere.
- License: vibesdk is MIT. Quoting code excerpts in our reference doc is fine; if we end up copying any module, follow CLAUDE.md's attribution rules (entry in `ATTRIBUTIONS.md`, comment above copied code, <1000 SLOC threshold for liberal copy).

## Stop condition

The output doc is "done enough" when:
- All sections above have content (even if rough)
- Each section has at least one concrete code reference
- Each section has a "what to consider for Nebula" note
- A reader can use it during Studio prompt/tool design without having to re-read vibesdk themselves

Polish iterations on the doc happen during Studio implementation — first read produces the skeleton; subsequent passes deepen as specific design questions arise.

## Notes

- This is reading-and-writing work, not implementation work. No code changes.
- Reading vibesdk cold is less useful than reading it with a specific design question to map onto. But waiting until Studio implementation is in flight defers a known-valuable input. Compromise: do the read after 5.3 ships (so back-end work isn't blocked) but before pre-Studio milestone really gets going (so the milestone benefits from the patterns).
- If during the read we find a pattern that demands an active discussion, escalate it back into the design conversation rather than just dropping it into the reference doc.
