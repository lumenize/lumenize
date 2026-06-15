# Think vs CMA Bake-Off (Studio agent harness)

**Status**: **COMPLETE — archived 2026-06-10.** Recommendation adopted (Think/Kimi+codemode for both Studio and in-app contexts); two open gates (Kimi UI-gen quality — revisit when 5.3.7 ships the SFC substrate; first-turn latency tuning) tracked in MEMORY + below. Originally:

**Status (2026-06-06)**: **BOTH ARMS RAN — Phase-4 complete** (data subset). `experiments/think-vs-cma/` on branch `feat/think-vs-cma-bakeoff` (worktree `.claude/worktrees/think-vs-cma`, head `0deee83`). Results: **CMA/Opus $0.3247 vs Think/Kimi $0.0287** for the 5-step todo data-subset; both correct. Full writeup: [results/RESULTS.md](../../.claude/worktrees/think-vs-cma/experiments/think-vs-cma/results/RESULTS.md) (in the worktree). **Recommendation EVOLVED 2026-06-06 (head `72ec00e`) → Think/Kimi+codemode for BOTH contexts** (supersedes the initial "lean CMA"). Drivers: cost compounds at scale (users × iterations; builder-friction = revenue drag); one-architecture-not-two (in-app context is Think/Kimi regardless); and **codemode** results — switching Think to codemode (one JS script/step + version/eTag prompt discipline + ontology via TS-as-schema) collapsed Kimi to ~2 model-req/step, made steps 2–5 FASTER than CMA (79s vs 124s) at ~12× cheaper ($0.026 vs $0.325), and fixed the relate-lists loop (→26s). Lone outlier: design-v1 116s verbose first turn (tunable). So codemode dissolves the "speed favors CMA" + "codemode=dead-weight" concerns. **Harness vs model separable** (standardize Think harness; default Kimi; Claude-via-Think as quality hedge). **Two open gates:** (a) Kimi UI-gen quality (untested — when 5.3.7 ships the SFC substrate); (b) first-turn latency tuning. The in-DO WS-client shim is a bounded cost (a Nebula-side result-returning-transaction RPC could delete it). Caveats: data-subset only; single runs (Kimi variance); completion = tool-exec + coherent output + validation-recovery, not independent state read-back.

### Scaffolding status (2026-06-05)
- **Real**: benchmark suite (3 apps × 5 steps — `shared/benchmark-suite.ts`), shared custom-tool surface + `ToolExecutor` contract (`shared/tool-surface.ts`), cost rate tables + per-turn math (`shared/cost.ts`), CMA agent-config shape (`cma/agent-definition.ts`).
- **Skeleton/stub** (NOT IMPLEMENTED, wiring spelled out inline): Star executor (`shared/nebula-driver.ts`), CMA Level-1 SSE bridge (`cma/driver.ts`), Project-Think DO (`think/src/*`), rubric checker (`shared/rubric.ts`). Both spike tests `it.skip`.
- **Deps pinned to current registry** (2026-06-05): `@anthropic-ai/sdk@^0.100.1`, `@cloudflare/think@^0.8.3`, `agents@^0.14.2`, `workers-ai-provider@^3.1.14`. ⚠️ Think is now **0.8.x** vs AIA's 0.7.2 — the `StudioThinkAgent` stub mirrors the 0.7.x surface; reconcile the API at Phase 2 wire-up.
- **Findings for Phase 1** (surfaced during scaffold type-check):
  - ~~CMA Node driver shares the frontend bundling prerequisites~~ — **moot** (2026-06-05). (a) Those prerequisites already landed: `@lumenize/debug` uses package-export conditions (no `cloudflare:workers` in node/browser entries — commit `740274e`) and `@lumenize/mesh` isolated `node:async_hooks`/ALS into `lmz-api-context.workerd.ts` with a browser-safe fallback (`1898e1a`/`8f66d17`); `@lumenize/nebula/client` is the explicit node/browser-safe entry. (b) More importantly, the CMA driver is now **server-side (workerd) and the Star executes ops in-process** — it doesn't import the client SDK at all, so there's nothing to bundle off-Worker. The 153 type errors in the scaffold check were just a node-only tsconfig lacking `@cloudflare/workers-types` (type-only re-exports reach server files referencing `DurableObjectState`); a workers-pool tsconfig for the Star-side driver avoids them.
  - The worktree has no `.dev.vars` at its root — postinstall symlinks have nothing to point at. When keys land, put `.dev.vars` (with `ANTHROPIC_*` + email-test `TEST_TOKEN`) at the worktree root or symlink it to the main tree's.

**Decision this experiment informs**: which agent harness drives **Nebula Studio** — the conversational authoring loop that turns "I want to build X" into a working ontology (`.d.ts`) + Vue SFCs deployed to a session's `.dev` Star. Studio's current plan ([nebula-studio.md § Model and Orchestration](../nebula-studio.md), lines ~346-356) is "direct Anthropic API, roll our own orchestration on Workers+DO, mix Opus/Sonnet by task." This experiment tests two productized alternatives to that hand-rolled baseline.

**The two contenders**:
- **Think** — Cloudflare **Project Think** (`@cloudflare/think` ^0.8.3) on top of the `agents` SDK (^0.14.2), model = open-weight **Kimi K2.5/K2.6 on Workers AI** via `workers-ai-provider`, `env.AI` binding only (no AI Gateway). This is the AIA stack — `/Users/larry/Projects/aia/arch-integrity/apps/aia` is the working reference (AIA is on the older 0.7.2/0.13.2 line; bump-reconcile at Phase 2).
- **CMA** — **Claude Managed Agents** (beta header `managed-agents-2026-04-01`): Anthropic runs the agent loop server-side; **the Star DO is the hands** via **custom tools** (built-in bash/filesystem toolset disabled → **no Cloudflare Container/isolate sandbox required**). Custom-tool calls surface on the session event stream as `agent.custom_tool_use`; a **server-side poller Worker** (workerd) relays them to the **Star, which executes the ops in-process**, and posts `user.custom_tool_result` back. No Node driver, no client SDK off-Worker. Model = **Opus 4.8** (+ Sonnet 4.6 / Haiku 4.5 for cheaper iterations — matches the Studio plan). See § CMA tool-execution architecture.

**Related**:
- AIA reference impl: `/Users/larry/Projects/aia/arch-integrity` — `apps/aia/src/agents/{conversation,aia-coordinator}.ts`, `docs/cloudflare-think-design.md`, `.claude/skills/cloudflare-think/SKILL.md`.
- Think keeps session memory in the DO's SQLite. AIA confirmed this state **is** cleanly resettable (an earlier `main→main5` instance-rotation hack was later replaced by a real reset path) — so "can't reset Think memory" is **not** a valid concern. The remaining fit question is the architectural one below: two parallel memory systems in one Star vs Resources as the single source of truth.
- [Star.ts](../../apps/nebula/src/star.ts) — one Star per `{universe}.{galaxy}.{star}.{branch}`; Resources ARE the memory.
- [coding-your-ui.md](../../website/docs/nebula/coding-your-ui.md) — the doc Studio's LLM consults when generating UI.

---

## Objective

Decide Think vs CMA for the **Studio context** (single developer-user, no parallel contention for AI resources). Produce a written recommendation backed by:

1. **USD cost per successfully-completed benchmark task** (the headline number Larry cares about), decomposed into model-token cost + harness/runtime/compute cost.
2. An **architectural-fit scorecard** measuring how each harness's memory model cooperates (or fights) with Nebula's "Resources-as-memory, one-Star-per-tenant" design.

**Explicitly out of scope**: the *second* agentic context — AI features inside the apps that developer-users ship. There, Think + cheap open-weight models hosted on Cloudflare likely wins (no per-token Anthropic bill, runs next to the data). Note it, don't measure it here.

## Hypothesis / Larry's framing

- **Cost is the biggest factor, but it's genuinely uncertain.** Raw per-token, Kimi is ~5-8× cheaper than Opus 4.8 (Kimi K2.5 $0.60in/$3out vs Opus $5in/$25out; Opus 4.7+ tokenizer also inflates token count ~35%). The open question is whether Opus 4.8's capability + CMA's efficient managed harness collapse the *turn count* enough to close that gap on a per-task basis.
- **Results are NOT a primary axis.** For simple apps (todo/kanban/CRM) the quality gap is small and already understood. Results matter here only as the *gate* that makes a task "completed" so cost comparisons are apples-to-apples — and indirectly, via turns-to-completion feeding cost.
- **Architectural fit is the real tiebreaker.** Think *wants to own memory* (session state in the DO's SQLite). AIA leaned into that with DO-per-persona/tension and *loved* it — but Nebula is one-Star-per-tenant, so all agent memory would pile into a single long-lived DO. CMA decouples brain from hands, letting Resources stay the single source of truth.

### Claude's added thesis (the sharper version of the fit argument)

Nebula already ships an opinionated, first-class, temporal, validated, access-controlled state model: **Resources**. A harness that "wants to handle memory" (Think) installs a *second, parallel* memory system (its session SQLite) inside the very same Star DO that already holds Resources. Even granting that Think's session state is cleanly resettable (AIA proved it is), the duplication remains a source-of-truth tension: which store is canonical for "what the app currently is" — Resources, or the agent's session? CMA's stateless-loop-with-rehydrated-context model sidesteps it: memory lives in Resources, the agent reads it per task, nothing app-canonical accumulates in the DO. **Prediction: for simple apps the absolute per-task cost of both will be small enough that cost is NOT the decider for the Studio context — the fit/operational findings will be (Larry confirmed 2026-06-05: fit primary, cost secondary; cost matters more for the out-of-scope in-app context). The experiment's real payoff is surfacing that friction empirically, so weight the design toward it, not toward a precise cost decimal.**

## What's already true (verified 2026-06-05)

- ✅ **Opus 4.8 works with CMA.** `claude-opus-4-8` is the canonical example in [Define your agent](https://platform.claude.com/docs/en/managed-agents/agent-setup); "all Claude 4.5-family and later models are supported." Fast mode (`speed: "fast"`) also supported on 4.8. CMA available on first-party API + Claude Platform on AWS only (not Bedrock/Vertex/Foundry).
- ✅ **Cumulative-spend API exists, and per-turn cost is available.** Larry's recollection is correct on both counts:
  - **Cumulative**: Anthropic Admin **Usage & Cost API** (needs an Admin key `sk-ant-admin…`, org accounts only). `GET /v1/organizations/cost_report` → USD by day (`1d` granularity only), group by workspace/description. `GET /v1/organizations/usage_report/messages` → tokens at `1m`/`1h`/`1d`. Data lands ~5 min after a request.
  - **Per-turn**: every Messages response carries a `usage` block; **in CMA specifically the SSE stream emits `span.model_request_end` per model call with a `model_usage` block** (input/output/cache tokens), and the session exposes an aggregate `usage`. That's true per-turn granularity the Admin API can't give.
  - **Cloudflare side**: AI Gateway computes per-request cost, tracks cumulative spend in real time, supports spend limits, has a REST API. Putting AI Gateway in front of Workers AI is the cleanest way to get clean per-request Kimi cost for the Think arm (AIA itself forbade AI Gateway, but this is an experiment harness, not AIA).
- ✅ **CMA cost = tokens + a runtime SKU.** Cloud sandbox: token rates + **$0.08/session-hour** (metered while `running` only; replaces container-hour billing). Self-hosted on Cloudflare: token rates billed by Anthropic + Cloudflare bills the sandbox compute (Containers MicroVM or Dynamic-Worker isolate — isolates are "a fraction of a container session"). Requires **Workers Paid plan**.
- ✅ **Think arm has no Anthropic token bill at all** — Kimi runs on Workers AI, billed by Cloudflare. Cost = Workers AI token metering + standard Workers/DO compute.

## Decisions (locked 2026-06-05)

1. **CMA tool execution → server-side, Star-is-the-hands, custom tools, no sandbox.** Disable the built-in filesystem/shell toolset (`default_config.enabled: false`); define custom tools (`get_current_ontology`, `apply_resource_transaction`, `deploy_to_dev`, `get_recent_errors`). The agent loop runs **server-side in workerd**, NOT in a Node process — the production client is a browser, so a Node middleman is throwaway *and* is the only thing that would drag the browser client SDK off-Worker. The **Star executes the tool ops in-process** (it already holds Resources / ontology / DagTree — it IS the hands; no `@lumenize/nebula/client`, no mesh-client, so the browser-bundling question never arises). Transport: CMA **self-hosted work-queue** (thin outbound poller Worker: claim → call Star to execute → post `user.custom_tool_result` → return) **in preference to a held SSE stream**, because holding a multi-minute session open inside the tenant's Star is a long `await` that blocks the input gate and bills wall-clock — the exact thing AIA dodged via `submitMessages` + alarm-drain. Star is the hands; it is not pinned open for minutes. *(Supersedes the earlier Node "Level 1 / Level 2" framing — 2026-06-05, Larry's call. Decision: drive server-side, don't build a Node driver.)*
2. **No hand-rolled baseline arm.** The direct-API "roll our own orchestration" idea in nebula-studio.md predates both Think and CMA (neither was released when it was envisioned) and is now **vestigial** — 90% not happening, revived only if we hit a wall, which post-AIA + post-CMA-research looks highly unlikely. Not built here. nebula-studio.md § Model and Orchestration should be updated to reflect this (see § Follow-ups).
3. **CMA model tiering → Opus-for-hard / Sonnet-for-iteration**, matching the split nebula-studio.md already specs. Measuring Opus-only would overstate CMA cost vs how we'd really run it.
4. **Spike-first.** Build each arm just enough to generate ONE app (todo) end-to-end, look at numbers + fit friction, expand to the full 3-app × N-run suite only if the decision isn't already obvious. Experiments are point-in-time spikes (per CLAUDE.md).

## Recon: target readiness + SDK ground truth (2026-06-05)

Three parallel recon passes before building. **Headline: the full UI-generation benchmark is NOT runnable today** — the generation *target* (not the harness) is the gap.

**Nebula generation-loop readiness:**
- ✅ Production-ready: Resources `transaction`/`read`/`subscribe` (`OperationDescriptor` = create/put/move/delete with eTag); ontology registration via `Galaxy.appendOntologyVersion({version, types})` (`types` = `.d.ts` string, eagerly compiled to a validator at register time); magic-link auth; deploy (`nebula-browser-test.transformation.workers.dev` is live).
- ❌ **Files-as-resources NOT implemented** — no `file` resourceType, no `mimeType` on `SnapshotMeta`. The agent's "write a `.vue`/`.d.ts` file" mechanism doesn't exist. (Planned for 5.3.7.)
- 🟡 **SFC compile = spike only** (`apps/nebula/spike/sfc-devstar-loop`, a standalone `SpikeGalaxy.compileSFC`) — not wired into the real Star, **and the TS→JS transpile step is missing**.
- ❌ No preview serving; ❌ no error tail (`get_recent_errors` has nothing to read — only per-transaction outcomes).
- **Consequence**: the rubric's "compiles / runs in preview" gates can't be satisfied. Only the **ontology + typed-data subset** is verifiable now. See § Scope decision.

**CMA SDK (`@anthropic-ai/sdk@0.100.1`) — corrects the scaffold's inferred names:**
- Lives at `client.beta.{agents,environments,sessions}` (+ `sessions.events`, `environments.work`). Agent create: `system` (✓), `name` REQUIRED, tools `{type:'custom', name, description, input_schema}` (✓). **Disable built-ins by OMITTING the `agent_toolset_20260401` entry** (not `default_config.enabled:false` on the agent).
- Self-hosted: `environments.create({name, config:{type:'self_hosted'}})` → `sessions.create({agent, environment_id})` → `events.send({events:[{type:'user.message',...}]})` → `events.stream()`. Custom-tool call = `agent.custom_tool_use` event (`id`,`name`,`input`); reply `events.send({events:[{type:'user.custom_tool_result', custom_tool_use_id, content, is_error}]})`. Per-turn cost = `span.model_request_end` → `model_usage{input_tokens,output_tokens,cache_*}`. Optional `events.toolRunner(sessionId,{tools})` auto-dispatches. Work-queue: `environments.work.{poll,ack,heartbeat,stop}` + `.poller()`/`.worker()` helpers (`.worker()` presumes a filesystem/built-in toolset — drive `poll`/stream manually for custom-tools-only).
- **workerd-safe**: fetch-based, beta header auto-injected, no `dangerouslyAllowBrowser` needed; DO NOT import `@anthropic-ai/sdk/tools/agent-toolset/node` (Node built-ins). Pass `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })`.

**Think SDK (`@cloudflare/think@0.8.3` + `agents@0.14.2`):**
- `Think extends Agent`; config via overridable getters `getModel()/getSystemPrompt()/getTools()` + `maxSteps` (NOT a `configure()` setter — the AIA pattern ports). `submitMessages([...])` survives (2nd arg now optional opts). `beforeTurn`→`TurnConfig{activeTools,maxSteps}` unchanged. `createExecuteTool` at `@cloudflare/think/tools/execute` ({loader, tools, state?, globalOutbound}). `createWorkersAI({binding: env.AI, gateway:{id:'think-vs-cma'}})('@cf/moonshotai/kimi-k2.5')`.
- ⚠️ **Heavy peer-dep jump 0.7→0.8**: `ai ^6` (AI SDK v6), `zod ^4`, `@cloudflare/codemode`, `@cloudflare/shell`, `agents >=0.14`. **Resolution gotcha**: a stale `agents@0.2.35` hoisted at the worktree root; the real `0.14.2` is nested under `experiments/think-vs-cma/node_modules` — verify Think resolves 0.14.x.
- New resilience opt-in: set `chatRecovery = true` **in the constructor/as a field** (wraps turns in `runFiber`, enables `stash()`/`onChatRecovery`) — the long-stream-brittleness mitigation.

## Scope decision — RESOLVED: A (Larry, 2026-06-05)

Run the **ontology + typed-data subset now** (ontology design → register → CRUD typed resources → handle a validation failure + an ontology migration; "completed" = registers + commits + validation recovered + migration backfills — no compile/preview needed). Delivers cost + most fit findings today; UI-gen half drops in when 5.3.7 ships files-as-resources + SFC. (Rejected: B build-substrate-now = throwaway vs 5.3.7; C wait = no measurement now.)

### Execution progress (2026-06-05)
- ✅ **Phase 1 data-subset plumbing** (commit `ee6daee`, type-clean, cma-project rubric-coverage test green): `tool-surface.ts` (4 data tools, real `OperationDescriptor`/`TransactionResolution` shapes), `benchmark-suite.ts` (TODO_APP = 5 data steps), `rubric.ts` (todo keys realigned), `StarToolExecutor` (4 tools → Galaxy/Star calls, transport stubbed), `agent-definition.ts` (data-modeling system prompt; built-ins off by omission; `name` added). SDK APIs for both arms mapped (see § Recon).
**Auth/transport decision (2026-06-05, recon + Larry's steer):** use the **established magic-link bootstrap** → admin `NebulaClient` (not JWT-forging). Key facts: only `Galaxy.appendOntologyVersion` is `@mesh(requireAdmin)` (reads JWT `access.admin`); `Star.transaction`/`read` have **no admin guard** — just need an authed origin + DagTree permissions. **The data slice is already proven** by [apps/nebula/test/browser/smoke.test.ts](../../apps/nebula/test/browser/smoke.test.ts): `bootstrapAdmin` → `HarnessNebulaClient` → `appendOntologyVersion` + `resources.transaction`, run as a **Node-side vitest test** against the real deployment. Reuse that exact setup (`global-setup.ts` provides `wranglerBaseUrl` + `emailTestToken`; `BENCH_BASE_URL` points at the deployed Nebula).

**CMA-arm topology decision:** the CMA driver runs in a **Node-side vitest harness** (mirroring `smoke.test.ts`), holding an authed `NebulaClient` as the executor — NOT a workerd poller. Rationale: token cost is identical wherever the driver runs, so measurement doesn't need the production workerd-poller (that's a fit/latency scorecard note). This **supersedes the "server-side workerd poller" framing** for `cma/driver.ts` — reframe it to a Node SDK loop. Use ONE Opus-4.8 agent + ONE session for the whole todo conversation (model-tiering across a single conversation isn't clean — defer tiering as a separate measurement; record the Opus-only cost as the honest upper bound).

- **Remaining, dependency-ordered**:
  1. ✅ **Live CMA SDK smoke** (done 2026-06-05, `cma/smoke.mjs`). Learnings: **cloud env + custom-tools-only works** (no poller); **one `events.stream()` covers the whole turn** (running → `agent.custom_tool_use` → idle(`requires_action`) → resume → idle(`end_turn`)); the stream does NOT auto-close on `end_turn` → **BREAK** on it; `model_usage` per `span.model_request_end`; prompt caching automatic. First datapoint: a trivial 2-request exchange ≈ **$0.012** (mostly cached system-prompt + tool-schema create). → `cma/driver.ts` implemented + **type-clean against the real SDK** (`createCmaRunner`: one cloud env+agent+session, `runStep` streams to end_turn, captures cost, `close()` cleans up).
  2. ✅ **Arm C run harness + run** (done 2026-06-06, commits `874ed31`/`739ec18`). Executor proven green against deployed Nebula (17s, no Opus); then the **real 5-step todo benchmark ran end-to-end through one Opus-4.8 session: TOTAL $0.3247** (`results/cma-todo.json`). Per step ≈ $0.044–$0.095, 4–5 model reqs, 3–6 tool calls, 19–44s. All steps produced coherent ontologies/data; the agent recovered from the injected validation failure by registering a new ontology version adding `urgent`. ⚠️ Formal per-step rubric verification (independent state read-back) is still a stub — formalize + apply to both arms before the Phase-4 writeup. **Cost is modest** → confirms the thesis that for simple apps cost won't be the decider; fit will.
  3. **Arm T (Think)** (NEXT, big build) — deploy `StudioThinkAgent` DO; in-DO minted admin JWT; codemode `execute` wrapping the tool ops; Kimi via `createWorkersAI({gateway:{id:'think-vs-cma'}})`. **Transport finding (recon 2026-06-06) — a concrete FIT SIGNAL:** a `@cloudflare/think` DO extends Cloudflare's `Agent`, NOT a Lumenize mesh participant, so it can't `lmz.call`. The clean forged-admin-envelope → `__executeOperation` direct-DO-RPC path works ONLY for synchronous/result-returning methods (`Galaxy.appendOntologyVersion` ✓, `Star.dagTree().*` ✓), but `Star.transaction`/`read` are **fire-and-forget to a connected Gateway client** — a forged caller never receives the result. The benchmark's data ops (create/read todos, validation-recover) ARE `Star.transaction`/`read`, so the Think DO **must be a real Gateway-connected client** → needs an in-DO WebSocket client (workerd has no outbound `new WebSocket()`; requires a **fetch-upgrade WS shim** injected via `LumenizeClient` `config.WebSocket`) + minted admin JWT (claims: `{iss:NEBULA_AUTH_ISSUER, aud:scope, sub, access:{authScopePattern:scope, admin:true}, ...}`). **Fit takeaway**: CMA's decoupled-brain/client-executes model maps cleanly onto Nebula's client-Gateway Resources API (CMA arm built ~clean); Think's in-DO-codemode-hands model has an **impedance mismatch** requiring a fiddly in-DO client shim — that build-effort asymmetry is itself a fit data point. Building through it (WS shim → Think DO → run) to make it concrete + get the Kimi cost. **PROGRESS 2026-06-06:** (a) `think/src/fetch-ws.ts` shim built (`7cbd76a`); (b) **in-DO transport PROVEN** (`f835c21`) — `TransportProbe` DO in miniflare minted an admin JWT, ran an in-DO NebulaClient via the shim → connected to deployed Nebula → register + transaction(committed) + read-back, all green. So `Star.transaction`/`read` results DO return to the in-DO client; admin needs no magic-link bootstrap (forged admin-claim JWT verifies + clears `requireAdmin` + DagTree admin-bypass). **Refined fit:** the mismatch is real but **surmountable** — Think needs the in-DO WS-client shim (extra machinery + a DO holding a WS connection w/ reconnect timers) where CMA fit natively; the build-effort + ops asymmetry is the signal, not "can't do it". **REMAINING — the Think agent layer:** `StudioThinkAgent extends Think<Env>` (getModel = Kimi via `createWorkersAI({gateway:{id:'think-vs-cma'}})`, getSystemPrompt = STUDIO_SYSTEM_PROMPT, getTools = codemode `createExecuteTool` whose helpers call the PROVEN in-DO executor), an HTTP/RPC trigger to run each benchmark step (submitMessages + await turn drain), Kimi cost capture (AI-Gateway logs or a Think usage hook), run the 5-step todo benchmark, write `results/think-todo.json`. **Still-open fit question the agent run answers:** does Think's in-DO **session memory** (its own SQLite store) conflict with Resources-as-canonical (the core thesis)? The transport probe didn't exercise a Think session; the agent run will.
  4. ✅ **Phase 4 gate — DONE** (`0deee83`). CMA/Opus $0.3247 vs Think/Kimi $0.0287 (~11× cheaper, both cents). `results/RESULTS.md` written: head-to-head + fit scorecard + the feature-utilization answer (Think value = loop + AI-SDK/Kimi + chat; codemode/sub-agents/scheduling/Workflows/MCP = dead weight for Studio; Think needs an in-DO WS-client shim to fit) + recommendation (lean CMA for Studio; Think+Kimi for the out-of-scope in-app context). Confirmed: Think's session memory is chat (orthogonal to Resources). Both justify not rolling our own.

## CMA tool-execution architecture (verified 2026-06-05)

The "sandbox" in CMA-on-Cloudflare is for the **built-in** computer-use tools (`bash`/`read`/`write`/`edit`/`glob`/`grep`) — they need a POSIX filesystem, so they run in a per-session Container MicroVM or Dynamic-Worker isolate. **Nebula doesn't use those.** Our tools are **custom tools**, and custom tools are a different execution model:

- Custom tools are **client-executed**: Anthropic's loop emits an `agent.custom_tool_use` event, the session pauses (`stop_reason: requires_action`), **your code** runs the tool and posts `user.custom_tool_result` back with the `custom_tool_use_id`. Source: [events-and-streaming](https://platform.claude.com/docs/en/managed-agents/events-and-streaming), [tools](https://platform.claude.com/docs/en/managed-agents/tools).
- The built-in toolset can be fully disabled (`default_config.enabled: false`). With it off, **no sandbox does any work** and there's nothing to provision for tool execution.
- **The Star is the hands — but it doesn't hold the loop.** The agent loop runs **server-side in workerd**, not in a Node process (production client = browser; a Node driver is throwaway and the only thing that imports the browser client SDK off-Worker). A DO also can't be the outbound poller / inbound endpoint *by itself*, and shouldn't hold a multi-minute session stream (long `await` → input-gate block + wall-clock, the thing AIA avoided with `submitMessages`+alarm). So: a **thin poller Worker** uses CMA's self-hosted **work-queue** (claim → call Star → post result → return); the **Star executes the resource ops in-process** (it already holds Resources/ontology/DagTree). No client SDK, no mesh-client, no bundling concern.
- Caveat on the official template: `cloudflare/claude-managed-agents` is opinionated toward provisioning a sandbox per session and has **no documented "no sandbox" switch**. We want only the work-queue poller + custom tools, not the sandbox — so we use the self-hosted-environment poller (the template is reference) and skip the per-session sandbox, since custom tools don't need it.
- Alternative we're **not** defaulting to: expose Star ops as a remote **MCP server** Worker and register via `mcp_servers` (+ an outbound-only **MCP tunnel** if we want "Anthropic never dials in"). Valid and reusable, but MCP tunnels are research-preview and it's more surface than custom tools. Keep as fallback.
- Premise note: "self-hosted is outbound-only, Anthropic never dials in" holds for the work-queue and MCP tunnels, but **not** for the session-lifecycle webhook (inbound) — the poller may be woken by a webhook then claim work outbound. The work-queue tool-execution path itself is outbound-only.

## Benchmark suite (the cost denominator)

The three apps already named as the Pre-Studio stop-point in nebula-studio.md: **todo list, kanban board, simple CRM**. Each run is a fixed, scripted prompt sequence (identical across arms) that exercises the *iteration loop*, where harness/memory differences actually show:

1. Cold generate ("build me a todo app where…").
2. Add a field ("add a due date").
3. Change behavior ("filter by status").
4. An ontology migration step (forces the migration-validation gate).
5. A debug step (feed a deliberately broken follow-up; see if the harness recovers).

**Pass/fail rubric per app** (gate for "completed," NOT a quality score): compiles, ontology validates, app runs in preview, access control enforced, the requested feature is actually present. Only completed tasks enter the cost comparison.

## Shared plumbing (built once, both arms reuse)

The Nebula-side tool surface the agent drives — identical for both arms so we compare harnesses, not tool quality:
- `get_current_ontology` (the pinned-ontology view), `apply_resource_transaction` (write ontology/SFC files as Resources via `client.resources.transaction`), `deploy_to_dev` / trigger SFC compile, `get_recent_errors` (compile + validation + runtime debug tail).
- For Think: these are codemode `execute`/tool wrappers in the DO (AIA pattern).
- For CMA self-hosted: these are custom tools in the Cloudflare sandbox worker calling into the Star via mesh / Workers RPC.

---

## Phases

### Phase 0 — Decisions + CMA account/setup provisioning

**Goal**: Unblock the CMA arm. Split into "Larry must do" (accounts, billing, keys) vs "Claude can do" (code, config, deploy).

**Larry must do (account/identity/billing — cannot be automated):**
- [x] Create an Anthropic **API/Console account** (2026-06-05) — confirmed working: standard key authenticates (HTTP 200 on `/v1/models`, `claude-opus-4-8` visible). ⚠️ Auth ≠ billing: `/v1/models` is auth-only — if usage credits aren't loaded yet, the first real agent call (Phase 1) will be the first thing to exercise billing. Load a little credit if not done.
- [x] Standard **API key** added to root `.dev.vars` as `ANTHROPIC_API_KEY` (gitignored) + worktree symlinked to it; placeholder added to `.dev.vars.example`. **Managed Agents is enabled by default** (SDK sets the `managed-agents-2026-04-01` beta header).
- [ ] ~~Admin key + dedicated workspace~~ — **NOT needed for the spike.** The Admin/Cost API (`sk-ant-admin…`, `cost_report`) is blocked on individual accounts and needs a paid multi-member (Team) org. We don't need it: cost is computed **per-turn** from each response's `usage` block + `span.model_request_end.model_usage` (works on a solo account). The Admin API is an optional cumulative cross-check only — defer unless we later want authoritative reconciliation.
- [x] Cloudflare on **Workers Paid** — confirmed 2026-06-05. (No Containers needed; Worker Loader is only for the Think arm's codemode sandbox, already covered by Paid.)
- [x] **AI Gateway created** (2026-06-05, by Claude via REST API + global key — `wrangler` has no AI Gateway command). Slug **`think-vs-cma`**, account `6c2517…eab42f` ("Lumenize and Transformation.dev"), `collect_logs: true`, `authentication: false`, `workers_ai_billing_mode: postpaid`. Think arm routes Kimi through it via `createWorkersAI(env.AI, { gateway: { id: 'think-vs-cma' } })` (or REST `cf-aig-gateway-id: think-vs-cma`). NB: AI Gateway also auto-creates a `default` gateway on first authenticated request (2026-05-21 changelog) — the named one is just for clean cost isolation.
- [x] **Deploy target = `transformation`** (account `6c2517…eab42f`) — matches the `.dev.vars` account, the new gateway, and the existing `nebula-browser-test.transformation.workers.dev` bench harness. Reusing it unless Larry says otherwise.

**Claude can do (and will, once the above exist):**
- [ ] Clone/scaffold the `cloudflare/claude-managed-agents` template into `experiments/think-vs-cma/cma/` (or a worktree), wire `wrangler.jsonc`, register it in root `package.json` workspaces (individual entry, per CLAUDE.md experiment rules), `npm install`.
- [ ] Write the agent definition (model = Opus 4.8 + Sonnet/Haiku tiering, system prompt = Nebula-specific, tools = the shared surface), the self-hosted sandbox worker, and the outbound-polling worker per the template.
- [ ] Stand up an AI-Gateway-fronted Workers AI route for the Think arm so per-request Kimi cost is captured.
- [ ] Verify deploy + a trivial "hello, generate an empty ontology" round-trip on both arms before any benchmarking.

**Deliverable**: Both arms deployable; a checklist in this file marking which setup steps Claude completed vs which needed Larry.

### Phase 1 — Shared plumbing + benchmark harness

**Goal**: The fixed prompt sequences, the pass/fail rubric checker, and the Nebula tool surface (shared) — plus the cost-capture instrumentation.

- [ ] Encode the 3-app × 5-step scripts as data (one source of truth, fed to both arms).
- [ ] Rubric checker: given a `.dev` Star after a run, assert compile/validate/run/access-control/feature-present.
- [ ] Cost capture: CMA → parse SSE `span.model_request_end.model_usage` per turn, sum, cross-check against Admin `cost_report` for the run's day/workspace. Think → AI Gateway per-request cost (or Workers AI usage × Kimi rates).

**Deliverable**: A dry run of the todo script against a stub that records turns + token usage, proving the cost pipeline works end-to-end before either real arm runs.

### Phase 2 — Arm T (Think) spike

**Goal**: Think harness drives Nebula to generate the **todo** app end-to-end (all 5 steps).

- [ ] Port the AIA `Think<Env>` pattern: a Studio-driver agent in the experiment worker, Kimi K2.5/K2.6, codemode `execute` tool wrapping the shared Nebula surface.
- [ ] Decide where Think session memory lives relative to the Star (it will want the DO's SQLite — note whether it can coexist with Resources or needs a separate DO). **Record this; it's a primary fit finding.**
- [ ] Run the todo script; capture cost, turns, latency, and any session-bias / rotation-style friction.

**Deliverable**: Todo app generated by Think + first cost/turns datapoint + fit notes.

### Phase 3 — Arm C (CMA) spike

**Goal**: CMA drives Nebula to generate the **todo** app end-to-end (all 5 steps) with the Star as the hands (Level 1 bridge).

- [ ] Create the agent (Opus/Sonnet tiering; built-in toolset disabled; custom tools = the shared Nebula surface). Driver opens a session and streams events.
- [ ] Implement the Level-1 bridge: on `agent.custom_tool_use`, call the deployed Star via the Nebula client, post `user.custom_tool_result` back.
- [ ] Confirm memory model: agent stateless per task, context rehydrated from Resources via `get_current_ontology` — verify nothing app-canonical accumulates in the Star.
- [ ] Run the todo script; capture cost (per-turn SSE `model_usage` × published rates, cross-check Admin `cost_report` for the workspace/day), turns, latency.

**Deliverable**: Todo app generated by CMA + first cost/turns datapoint + fit notes.

### Phase 4 — Compare-on-one-app decision gate

**Goal**: Look at the two todo-app datapoints + the fit notes and decide whether the answer is already clear.

Decision tree:
- **One arm clearly wins on both cost AND fit** → write it up, skip the full suite. (Likely outcome per Claude's thesis: CMA wins on fit, cost is close/small in absolute terms.)
- **Cost-close but fit-divergent** → fit decides; still skip the expensive full suite, document the fit reasoning.
- **Genuinely too close to call** → expand to Phase 5 (full suite, multiple runs) for statistical confidence.

**Deliverable**: Go/no-go on Phase 5 + a one-paragraph preliminary recommendation.

### Phase 5 — (Optional) Full suite

**Only if Phase 4 is too close to call.**

- [ ] Run all 3 apps × 5 steps × N≈5 runs per arm. Capture full cost/turns/latency distributions.

**Deliverable**: Distribution plots: USD/completed-task per arm, turns-to-completion, p50/p99 iteration latency.

### Phase 6 — Architectural-fit scorecard + recommendation

**Goal**: The written decision.

Scorecard dimensions (qualitative, the thing Larry actually cares about):
- **Memory location & conflict**: where does conversation/session memory live? Does it coexist with Resources in the Star, or fight it? How is it reset?
- **Rehydration after eviction**: DOs evict anytime — how does each harness recover task context? (Resources rehydrate naturally; Think session SQLite must survive or be rebuilt.)
- **Source-of-truth**: for "what the app currently is," is the canonical store Resources or the agent's session? Does the harness force a second app-state store into the Star, and if so how are the two kept consistent?
- **Tool-call latency into the mesh**: Think (in-DO, microseconds) vs CMA (poller Worker → Star via service-binding/mesh RPC).
- **Stream/turn durability (long-stream brittleness)**: Cloudflare DOs are evicted ~1–2×/day (non-deterministic) + runtime updates a few×/week + deploys — any severs an in-flight upstream stream permanently (this is *why* Project Think exists; the `agents` SDK has a multi-release resumable-stream/fiber hardening sprint, v0.14.0 landed 2026-06-02). No hard duration ceiling — it's a hazard rate rising with connection age (<60s ≈ always fine; 1–5 min usually fine with a heartbeat; >10–15 min expect occasional breaks). **Asymmetry**: CMA Managed Agents are event-based with server-side persisted history → a dropped poll re-claims, run never lost (resilient by design). Think's resilience depends on the brand-new SDK fiber/resumable machinery, and AIA's reference is the older 0.7.2/0.13.2 line. Instrument per-turn durations during the spike; treat break-rate as a real risk to monitor (most Studio turns are short, so likely dodged — but verify).
- **Cost integrity under broken streams**: a mid-inference stream break can leave the provider having billed output tokens you never received (`cloudflare/agents` #1257); naive retry pays twice. Mitigation = AI Gateway durable buffer (reconnect + retrieve without re-inferring) — the AI-Gateway-fronted Kimi route we already use for Think cost-capture doubles as this. Ensure broken-stream retries don't inflate measured cost.
- **Operational surface**: keys, plans, beta gates, template maintenance, model-version churn.
- **Cost**: USD/completed-task, with the absolute magnitude called out (does it even matter at this scale?).

**Deliverable**: `experiments/think-vs-cma/RESULTS.md` with the scorecard, the cost table, and a one-line recommendation for the Studio context + a note on why the second (in-app AI) context may decide differently.

---

## What we are explicitly NOT doing

- **The in-app AI context.** Apps that developer-users build will have AI features; Think + cheap Cloudflare-hosted open-weight models likely wins there. Different experiment, different time.
- **Quality/results scoring as a primary axis.** Gap is small and known for simple apps. Results gate "completed"; they don't rank the arms.
- **Multi-tenant / parallel-contention load.** Studio is single-developer-user; no concurrency in scope.
- **Production Studio chat UI.** This experiment is the harness decision that *precedes* building Studio's UI; it rides on the same Claude-Code-drives-the-loop Pre-Studio gate.

## Open questions to resolve during the work

- Can Think's session memory be made to **not** collide with Resources in the same Star DO (separate DO? disable Think's session store and feed Resources-derived context per turn?) — or is the collision inherent? This is the crux of the fit argument.
- For CMA self-hosted, what's the realistic round-trip latency of a tool call from Anthropic's loop → Cloudflare sandbox → Star mesh → back? (vs Think's in-DO microseconds.) Does it matter for a single-user authoring loop?
- Does the Admin `cost_report` 1-day granularity force us to run each arm in its own UTC day/workspace, or is per-turn `model_usage` summation trustworthy enough to skip the cross-check?
- Kimi K2.5 vs K2.6 for the Think arm (K2.6 newer/pricier: $0.95in/$4out). Pick based on the AIA A/B history + current Workers AI catalog at run time.

## Follow-ups (outside this experiment)

- Update [nebula-studio.md § Model and Orchestration](../nebula-studio.md) to retire the "direct Anthropic API, roll our own orchestration on Workers+DO" plan — it predates Think/CMA and is now vestigial (Decision 2). Replace with "harness = outcome of think-vs-cma-bakeoff." Do this once the bake-off picks a winner, not before (don't strand the doc mid-experiment).
- Any task files still describing the roll-your-own loop should get a one-line "superseded by tasks/think-vs-cma-bakeoff.md" pointer.
- **Reverse the `experiments/` gitignore default** (own branch, repo-wide). Rationale: the workspaces rule (CLAUDE.md) requires every *active* experiment to be present on a fresh clone, but `experiments/` ignored means workspace-listed experiments must be force-added or `npm install` breaks — so the ignore only ever hides scaffolds silently (it hid this one). Flip to track-by-default + prune stale dirs. Must verify `node_modules`/`coverage`/build artifacts stay ignored (global rules), and triage the loose untracked scratch files already in `experiments/`. Not bundled into this branch. (Spawned as a background task chip 2026-06-05.)

## Effort estimate

- Phase 0: ~half day Claude-side once Larry's accounts/keys exist (account setup is Larry's wall-clock, not effort we control).
- Phase 1: 1 day (shared scripts + rubric + cost pipeline).
- Phase 2 (Think spike): 1-2 days (AIA port is the head start).
- Phase 3 (CMA spike): 1-2 days (template is the head start; self-hosted tunnel wiring is the unknown).
- Phase 4: half day.
- Phase 5 (optional full suite): 1-2 days IF triggered.
- Phase 6: 1 day writeup.

Total: ~4-6 days to a decision via the spike-first path; +2-3 if the full suite fires.
