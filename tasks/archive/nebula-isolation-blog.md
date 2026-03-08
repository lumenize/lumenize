# Cloudflare Isolation Technologies — Blog Post

**Phase**: 4.0
**Status**: **COMPLETE** — benchmarks done, blog updated, website builds. Container deployment benchmarks skipped (not needed after tsc-in-DWL validated).
**Depends on**: None (can start in parallel with phases 1-3)
**Master task file**: `tasks/nebula.md`
**Deliverable**: Blog post comparing and contrasting Cloudflare's user-provided code isolation offerings
**Audience**: Developers in the DWL private beta channel asking for compare-and-contrast + use-case guidance. Primary goal is our own learning; the blog post is a forcing function.
**Related**: Phase 4.1 (`tasks/nebula-ts-as-schema-research.md`) — deeper research that feeds Phase 5

## Current Status (2026-03-08)

### Completed
- ✅ **Research**: All four technologies researched (DWL, codemode, Containers, Sandbox SDK) via docs, source code, Cloudflare MCP, and web searches
- ✅ **Blog post draft**: `website/blog/2026-03-07-cloudflare-code-isolation-guide/index.md` (~420 lines). Includes: comparison table, DWL deep dive with code samples, codemode pipeline, Container pricing, Sandbox features, crossover framework, WfP context, security models, billing worked examples, spike results, benchmark data, 12 gotchas
- ✅ **Gotchas validated**: All 12 checked against latest docs/releases
- ✅ **codemode patterns evaluated**: `Executor` interface, `ToolDispatcher`, `acorn` normalization documented
- ✅ **DWL spike results incorporated**: All 6 experiments from `experiments/dwl-spike/` summarized in blog post
- ✅ **Phase 4.1 task file updated**: Ezno-WASM approach (A1.5) added to `tasks/nebula-ts-as-schema-research.md`
- ✅ **tsgo-WASM assessed**: 45 MB binary, GC pauses — ruled out vs Ezno-WASM (~2-5 MB, no GC)
- ✅ **Blog tag added**: `cloudflare` tag in `website/blog/tags.yml`
- ✅ **DWL benchmarks**: `experiments/dwl-benchmarks/` — 5 benchmark categories (isolate creation, RPC latency, module loading, globalOutbound, codemode-equivalent). Results: cold creation ~1ms, warm ~0ms, 100KB module ~2ms, 500KB ~8ms, globalOutbound null = zero overhead, codemode wrapping = zero overhead
- ✅ **codemode import gotcha discovered**: `@cloudflare/codemode` v0.1.2 can't be imported in Workers — `zod-to-ts` pulls in TypeScript compiler which uses `__filename` (CJS). Documented in blog post.
- ✅ **tsgo benchmarks**: `experiments/tsgo-benchmarks/` — `@typescript/native-preview` 7.0.0-dev: 10 types = 82ms, 100 types = 91ms, 1000 types = 283ms. Startup-dominated (~80ms overhead), per-type cost ~0.2ms
- ✅ **Blog updated with benchmark data**: DWL benchmark table, tsgo benchmark table, codemode import gotcha, container cold-start estimates
- ✅ **Website builds**: `npm run build` passes (one pre-existing broken anchor warning unrelated to blog)

### Remaining
- [ ] **Container deployment benchmarks** (deferred): Deploy to Cloudflare to measure actual cold start times for `lite` vs `basic` vs `standard-1`. Current blog uses Cloudflare's published 2-3s spec + estimate.
- [ ] **Sandbox SDK benchmarks** (deferred): Same underlying Container, SDK overhead is thin HTTP/WS wrapper. Low value vs effort.
- [ ] **Publish**: Blog is ready for review and publishing

## Goal

Research, benchmark, and write a blog post comparing Cloudflare's isolation technologies for running untrusted/dynamic code. These fall into two tiers:

- **V8 Isolate Tier**: DWL (raw) and codemode (wrapped) — millisecond cold starts, JS/Python only, 128MB memory limit
- **Linux VM Tier**: Containers (raw) and Sandbox SDK (wrapped) — 2-3s cold starts, any language/binary, up to 12GB memory

The blog post helps the DWL beta community understand when to use which. For us, it's a forcing function to build hands-on experience with all four technologies before Phase 5 (Resources).

## Technologies to Compare

### Tier 1: V8 Isolates

#### Dynamic Worker Loader (DWL)

Low-level primitive. `LOADER.get(id, callback)` spawns lightweight V8 isolates from code strings at runtime. **Closed beta for production**; local dev works with wrangler. Larry has been accepted into the closed beta.

**API surface**:
- `env.LOADER.get(id, () => WorkerCode)` → `WorkerStub`
- `workerStub.getEntrypoint(name?, { props? })` → entrypoint with `.fetch()` and RPC methods
- `WorkerCode`: `{ mainModule, modules, compatibilityDate, env?, globalOutbound?, compatibilityFlags? }`
- Module types: `{js}`, `{cjs}`, `{py}`, `{text}`, `{data}`, `{json}`

**Isolation guarantees**: `globalOutbound: null` blocks all fetch/connect at runtime level; child gets only explicitly-provided `env` (no inheritance); V8 isolate boundary.

**DO access from DWL**: Global bindings (KV, R2, D1) can be passed via `env`. DO storage must be wrapped in `RpcTarget` and passed per-call — see PR #27603 (unmerged, reported local dev issues). https://github.com/cloudflare/cloudflare-docs/pull/27603/changes

**workerd issue #5681**: DWL API does NOT validate `WorkerCode` at runtime — unknown properties silently ignored. Validation comes from TypeScript types only.

#### `@cloudflare/codemode` SDK

Higher-level wrapper around DWL, purpose-built for **LLM-generated code execution**. v0.1.0 rewrite (2026-02-20) — experimental, breaking changes possible.

**What it does**:
1. `generateTypes(tools)` converts tool definitions (Zod or JSON Schema) into TypeScript type strings for the LLM prompt — never compiled, purely a prompt engineering technique
2. `createCodeTool({ tools, executor })` returns an AI SDK `Tool` — LLM writes JS code calling `await codemode.toolName(args)`
3. `DynamicWorkerExecutor` wraps DWL with network isolation (default `globalOutbound: null`), console capture, configurable timeout (30s default)
4. Code goes through `acorn` AST normalization → wrapped in a `WorkerEntrypoint` class → executed in isolated DWL Worker
5. Tool calls from sandbox route back via Workers RPC (`ToolDispatcher extends RpcTarget`)

**`Executor` interface** — minimal, runtime-agnostic:
```typescript
interface Executor {
  execute(code: string, fns: Record<string, (...args: unknown[]) => Promise<unknown>>): Promise<ExecuteResult>;
}
interface ExecuteResult { result: unknown; error?: string; logs?: string[]; }
```

**Type generation internals**:
- `generateTypes(tools)` takes live in-memory schema objects (Zod v4 or AI SDK `jsonSchema()` wrappers) and produces a TypeScript string for LLM consumption. Two paths:
  - Zod path: `isZodSchema()` detects `_zod` property → `zod-to-ts` introspects runtime object internals via `ts.factory` AST → `printNode()` → string. **Requires in-process Zod objects — cannot cross network/RPC boundaries.**
  - JSON Schema path: `isJsonSchemaWrapper()` detects AI SDK wrapper → `extractJsonSchema()` → hand-rolled `jsonSchemaToTypeString()` recursive converter. JSON Schema is plain data and could theoretically be serialized.
- Output: `declare const codemode: { toolName: (input: InputType) => Promise<OutputType>; }` with JSDoc
- Neither path accepts TypeScript type strings as input

**What codemode does NOT do**: No TypeScript compilation or type-checking. The LLM is explicitly instructed to write JavaScript only. No incremental feedback loop (fire-and-forget, no "compile → get errors → fix" cycle).

**Nebula IDE relevance**: Codemode's `generateTypes()` converts Zod/JSON Schema → TypeScript strings → LLM prompt. This is backwards from what Nebula wants. In Nebula, TypeScript IS the schema — no conversion needed. The TypeScript types go directly into LLM prompts as-is. Codemode's patterns are still worth studying for: (a) the `Executor` abstraction, (b) the RPC-based tool dispatch (`ToolDispatcher extends RpcTarget`), (c) the `acorn` AST normalization of LLM output. But the type generation pipeline is not relevant because we start from TypeScript, not convert TO it.

**Key dependencies**: `acorn` (JS parsing), `zod-to-ts` (bundles the TypeScript compiler — large bundle impact), peer deps: `ai`, `zod`.

### Tier 2: Linux VMs

#### Cloudflare Containers

Full Linux containers on Cloudflare's network. **Open beta since June 2025**. Each Container is managed by a paired Durable Object (programmable sidecar).

**Cold start**: 2-3 seconds typical (image-dependent). Future: Firecracker snapshots could potentially get under 200ms.

**Instance types**:

| Type | vCPU | Memory | Disk |
|------|------|--------|------|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

**Billing** (stacks: Workers + DO wall-clock + Container compute + egress):
- Memory: $0.0000025 / GiB-second (25 GiB-hours/month free)
- CPU: $0.000020 / vCPU-second (375 vCPU-min/month free)
- Disk: $0.00000007 / GB-second (200 GB-hours/month free)
- Egress: $0.025-$0.05 / GB depending on region (1TB/month free NA/EU)

**Disk is ephemeral** — all data lost on sleep/restart. R2 bucket mounts are the persistence mechanism.

**Config**: `@cloudflare/containers` npm package (v0.1.1). Container class extends `Container` with `defaultPort`, `sleepAfter`, `envVars`. Wrangler `containers` array in wrangler.jsonc. Only Cloudflare Registry supported (no Docker Hub/ECR).

**Known beta limitations**: No autoscaling, DOs not always co-located with containers, manual scaling only.

#### Cloudflare Sandbox SDK

Wrapper around Containers. `@cloudflare/sandbox` v0.6.9. Pre-built Ubuntu 22.04 image with Python, Node.js, Git. Designed for AI agents executing untrusted code.

**What it adds over raw Containers**: Rich API (exec/execStream, file operations, process management, port exposure with preview URLs, R2 bucket mounts, code interpreter with session management), VM-level isolation (filesystem, process, network, resource limits per sandbox).

**What it does NOT add**: Authentication, authorization, input validation, rate limiting — those are developer responsibilities.

**Key config**: `getSandbox(binding, id, { sleepAfter, keepAlive, containerTimeouts })`. Default sleep after 10 minutes.

**Sandbox state is ephemeral** — files, processes, env vars lost on sleep. Within a single sandbox, all code shares resources (not per-execution isolation).

### Also Worth Mentioning (Out of Scope for Deep Research)

#### Workers for Platforms (WfP)

The production-grade predecessor to DWL for multi-tenant code execution. GA, unlike DWL. Uses a different access model (dispatch namespaces) and pricing structure. We've already ruled it out for Nebula's use case due to the older access/pricing model, but blog readers will want to know where it fits on the spectrum.

## What the DWL Spike Already Proved

The `experiments/dwl-spike/` directory (commit `b0e9f4e`, Feb 2026) ran six experiments:

| Test | What | Result |
|------|------|--------|
| 1 | Basic DWL fetch | ✅ Works |
| 2 | Env vars (structured-clonable) | ✅ Works |
| 3 | WorkerEntrypoint RPC (getResourceConfig, guard, validate) | ✅ Full RPC, objects round-trip cleanly |
| 4 | DO namespace binding in DWL env | ❌ `DataCloneError` — validates inverted model |
| 5 | LumenizeWorker in DWL (mesh bundle import, `this.lmz`, `this.ctn()`) | ✅ Full Mesh integration works |
| 6 | Mesh envelope propagation (callContext, originAuth.claims, role-based guards) | ✅ Auth-aware guards in DWL work |

**Key validated architecture**: The inverted model where host DO owns storage/subscriptions and calls DWL for decisions (guards, config, validation). DWL doesn't need DO bindings — it gets auth context via `callContext`.

**Mesh bundle**: ~140KB unminified, ~100KB minified+tree-shaken. Exports LumenizeWorker, mesh, meshFn, MESH_CALLABLE, MESH_GUARD, NadisPlugin, continuation utilities.

**What's NOT yet validated**:
- vitest-pool-workers support for DWL (spike used `wrangler dev` + manual curl)
- Isolate caching behavior across requests (must assume stateless)
- Performance with large module dictionaries
- Error propagation from DWL to host DO stack traces
- Production deployment (closed beta)

## Research Questions

### Benchmarking Plan

**V8 Isolate Tier (local dev only — DWL is closed beta for production)**:
- [ ] DWL isolate creation time: first load vs cached (vary `id` parameter)
- [ ] RPC round-trip latency: simple return vs complex object marshaling
- [ ] Module loading performance: small module (1KB) vs mesh bundle (~100KB) vs large (500KB+)
- [ ] `globalOutbound: null` overhead (if any) vs unrestricted
- [ ] codemode `DynamicWorkerExecutor` overhead vs raw DWL (timeout/console capture cost)
- [ ] Document that these are local-only numbers — production may differ

**Linux VM Tier (deployable — open beta)**:
- [ ] Container cold start: lite vs basic vs standard-1 (minimal Docker image)
- [ ] Container cold start: with tsgo binary included (~27MB image addition)
- [ ] `tsgo --noEmit` execution time on representative schema sizes (10 types, 100 types, 1000 types)
- [ ] Sandbox SDK cold start vs raw Container cold start (overhead of pre-built Ubuntu image)
- [ ] Idle cost: Container sleep/wake cycle vs staying alive
- [ ] Compare: running `tsgo` in Container vs hypothetical WASM-compiled checker in DWL (if feasible)

### DX Comparison

- [ ] Side-by-side code samples: raw DWL vs codemode for the same task (execute user function, capture output)
- [ ] Side-by-side code samples: raw Container vs Sandbox SDK for the same task (run a shell command, get output)
- [ ] Lines of code, boilerplate, error handling, testing story for each

### Use Case Distinctions

- [ ] Where's the crossover between DWL and Containers? (V8 memory limit, execution time limit, binary requirements)
- [ ] When does codemode's abstraction help vs get in the way? (AI tool orchestration vs pre-authored code)
- [ ] When does Sandbox SDK's abstraction help vs get in the way? (quick untrusted script vs custom binary workflow)
- [ ] Can DWL and Containers coexist in the same Worker? (DWL for hot-path decisions, Container for cold-path validation)

### Billing Deep Dive

- [ ] Cost per 1M guard checks via DWL (Worker request cost only)
- [ ] Cost per 1000 schema validations via Container with tsgo (compute + startup amortization)
- [ ] Break-even analysis: at what call volume does keeping a Container warm beat cold-starting each time?
- [ ] DWL isolate caching: is there any idle cost, or is it purely per-invocation?

### Security Models

- [ ] DWL: `globalOutbound: null` + explicit `env` — what attack surfaces remain?
- [ ] Containers: `enableInternet` flag, filesystem isolation, process visibility
- [ ] Sandbox SDK: per-sandbox VM isolation (filesystem, process, network, resource limits)
- [ ] What does each prevent that the others don't?

## Known Gotchas

Collected from spike, research, and docs:

- **DWL can't pass `DurableObjectNamespace`** — `DataCloneError`. Only structured-clonable types + service bindings. Validates inverted architecture.
- **DO storage in DWL via `RpcTarget`** — PR #27603 pattern. Unmerged, reported `fetch failed` in miniflare 4.20260302.0.
- **DWL doesn't validate `WorkerCode`** — unknown properties silently ignored (workerd #5681). TypeScript types are the only guard.
- **codemode bundles TypeScript compiler** — `zod-to-ts` dependency pulls in `ts.factory`. Large bundle impact.
- **Container disk is ephemeral** — files, processes, env vars lost on sleep/restart.
- **Sandbox SDK shares resources within a sandbox** — not per-execution isolation. Different users/actors need separate sandboxes.
- **No autoscaling for Containers** — manual scaling only during beta.
- **DWL isolate caching is not guaranteed** — same `id` may or may not reuse an existing isolate. Must assume stateless.
- **DWL is closed beta for production** — all benchmarks are local-dev only until beta access granted (we have access).
- **codemode instructs LLMs to write JavaScript only** — no TypeScript syntax. Nebula IDE will need LLMs to write TypeScript instead.

## Blog Post Outline (Draft)

1. **The Problem**: Running untrusted/dynamic code on Cloudflare — why, and what are the options?
2. **Two Tiers**: V8 isolates (ms cold start, JS only, 128MB) vs Linux VMs (2-3s cold start, anything, up to 12GB)
3. **Tier 1 Deep Dive**: DWL raw vs codemode SDK — what the wrapper buys you, when you want raw access
4. **Tier 2 Deep Dive**: Containers raw vs Sandbox SDK — same question at the VM layer
5. **Head-to-Head**: Comparison table (cold start, latency, DX, security, billing, GA status)
6. **Also Worth Knowing**: Workers for Platforms — where it fits, why you might still choose it
7. **Decision Framework**: Concrete guidance for when to use which
8. **tsgo in Containers**: Fast type-checking as a Container use case — why not in V8, benchmarks
9. **Our Architecture**: How Nebula uses DWL + Containers together (without prescribing "best for" conclusions)

## Comparison Table (Draft — "Best for" row TBD)

| Criterion | DWL | codemode | Container | Sandbox SDK |
|-----------|-----|----------|-----------|-------------|
| Cold start | ~ms | ~ms | 2-3s | 2-3s |
| Runtime | V8 (JS/Py) | V8 (JS) | Any binary | Ubuntu 22.04 |
| Network isolation | `globalOutbound: null` | Default null | `enableInternet` flag | Configurable |
| Max memory | 128MB | 128MB | Up to 12GB | Instance-dependent |
| Billing | Worker request | Worker request | CPU+mem+disk/10ms + egress | Same as Container |
| GA status | Closed beta | Experimental | Open beta | Beta |
| DX level | Low (raw API) | High (AI SDK tool) | Medium (Dockerfile + DO) | High (rich SDK) |
| State | Stateless (assume) | Stateless | Ephemeral disk | Ephemeral + R2 mounts |

## Success Criteria

- [ ] Cold start benchmarks for both tiers (DWL local-only, Containers deployable)
- [x] DX comparison with code samples (raw vs wrapper for each pair) — in blog post
- [ ] `tsgo` benchmarked in Container for representative schema sizes
- [x] codemode's `Executor`, `ToolDispatcher`, and `acorn` normalization patterns evaluated for reuse
- [x] Gotchas section validated against latest docs/releases
- [x] Clear use case guidance (not prescriptive "best for" — let readers decide) — decision framework in blog post
- [ ] Published blog post
