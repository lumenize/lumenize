# Cloudflare Isolation Technologies — Research & Blog Post

**Phase**: 4
**Status**: Pending
**Depends on**: None (can start in parallel with phases 1-3; must complete before Phase 5)
**Master task file**: `tasks/nebula.md`
**Deliverable**: Blog post comparing and contrasting Cloudflare's isolation technologies

## Goal

Research, benchmark, and write a blog post comparing Cloudflare's four isolation technologies for running untrusted/dynamic code. Nebula uses at least two of these (DWL for customer code, Containers for `tsc` schema validation), so we need a clear mental model of when to use which.

## Technologies to Compare

### Dynamic Worker Loader (DWL)

Low-level primitive. `LOADER.get(id, callback)` spawns lightweight V8 isolates from code strings at runtime. Already spiked in `experiments/dwl-spike/` — confirmed: full RPC, `LumenizeWorker` extension, callContext propagation, `globalOutbound: null` sandboxing. Closed beta for production; local dev works with wrangler 4.66.0+.

### `@cloudflare/codemode` SDK

Higher-level wrapper around DWL. v0.1.0 rewrite (2026-02-20) provides `DynamicWorkerExecutor` with network isolation, console capture, configurable timeout (30s default). Also provides `createCodeTool()` for AI SDK integration and a minimal `Executor` interface for custom implementations. Runtime-agnostic — no longer owns LLM integration.

### Cloudflare Containers

Full Linux containers on Cloudflare's network. Can run arbitrary binaries — including `tsc`/`tsgo` for runtime type validation. Heavier than DWL (cold start, memory, billing) but can run things V8 isolates can't.

### Cloudflare Sandbox SDK

Wrapper around Containers. [Announced](https://developers.cloudflare.com/sandbox/) for running untrusted code in isolated environments. Need to understand how it compares to raw Containers and whether it offers better DX or security guarantees.

## Research Questions

**Cold start times**: DWL vs Containers vs Sandbox SDK. How does this affect user experience for on-demand code execution?

**DX comparison — direct vs wrapper**:
- DWL raw vs codemode SDK: What does the SDK buy you? Is the abstraction worth the dependency?
- Containers raw vs Sandbox SDK: Same question.

**Use case distinctions**:
- DWL: V8-compatible code, low-latency, high-frequency calls (guards, validation, resource config). Nebula customer code lives here.
- Containers: Non-V8 workloads (`tsc`/`tsgo` for schema checking, future binary tools). Nebula platform infrastructure, not customer code.
- When would you use one over the other? Where's the crossover?

**Billing**: Per-request costs, wall-clock billing, idle costs for Containers vs DWL isolate caching.

**Security**: Network isolation models, env binding restrictions, what each technology prevents.

**Nebula-specific**: Can we use codemode's `Executor` interface for our DWL executor? Does Sandbox SDK's isolation model match our `globalOutbound: null` pattern?

## Blog Post Outline (Draft)

1. **The Problem**: Running untrusted code on Cloudflare — why, and what are the options?
2. **The Spectrum**: V8 isolates (DWL) → Wrapped isolates (codemode) → Containers → Wrapped containers (Sandbox SDK)
3. **Head-to-Head**: Cold start, latency, DX, security, billing for each
4. **Decision Framework**: When to use which (with concrete examples from Nebula)
5. **Our Architecture**: Why Nebula uses DWL for customer code and Containers for `tsc`

## Success Criteria

- [ ] Cold start benchmarks for all four technologies
- [ ] DX comparison with code samples (raw vs wrapper for each pair)
- [ ] Clear use case decision framework
- [ ] Published blog post
- [ ] Any findings that affect Phase 5/6 (Resources) documented and fed back
