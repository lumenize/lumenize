---
title: "Running untrusted code on Cloudflare: DWL, codemode, Containers, and Sandbox compared"
slug: cloudflare-code-isolation-guide
authors: [larry]
tags: [architecture, cloudflare]
description: "A hands-on comparison of Cloudflare's four isolation technologies for running dynamic or untrusted code — from millisecond V8 isolates to full Linux containers."
---

Cloudflare now offers four distinct ways to run code you don't fully trust — user-submitted functions, LLM-generated scripts, plugin systems, or third-party integrations. They fall into two tiers that differ by orders of magnitude in startup time, capability, and cost:

- **V8 Isolate tier**: Dynamic Worker Loader (DWL) and codemode — millisecond cold starts, JavaScript/Python only, 128 MB memory
- **Linux VM tier**: Containers and Sandbox SDK — 2-3 second cold starts, any language or binary, up to 12 GB memory

We needed to understand all four for [Lumenize Nebula](https://lumenize.com/blog/introducing-lumenize-nebula), where vibe-coder-provided guards and validators run in DWL isolates, and heavier workloads like TypeScript type-checking may run in Containers. This post is what we learned.

<!-- truncate -->

## The two tiers at a glance

| Criterion | DWL | codemode | Container | Sandbox SDK |
|-----------|-----|----------|-----------|-------------|
| **Cold start** | ~1 ms | ~1 ms | 2-3 s | 2-3 s |
| **Runtime** | V8 (JS/Python/WASM) | V8 (JS only) | Any binary | Ubuntu 22.04 (Python, Node, Git) |
| **Network isolation** | `globalOutbound: null` | Default null | `enableInternet` flag | Configurable |
| **Max memory** | 128 MB | 128 MB | Up to 12 GB | Instance-dependent |
| **Billing model** | Worker request | Worker request | CPU + memory + disk per 10 ms + egress | Same as Container |
| **GA status** | Closed beta (prod), open for local dev | Experimental | Open beta | Beta |
| **DX level** | Low-level API | High-level (AI SDK tool) | Medium (Dockerfile + DO sidecar) | High-level SDK |
| **State** | Assume stateless | Stateless | Ephemeral disk | Ephemeral + R2 mounts |
| **Best fit** | Hot-path code dispatch, guards, validators | LLM tool orchestration | Custom binaries, heavy compute | AI agent code execution |

The rest of this post unpacks each cell.

---

## Tier 1: V8 Isolates — fast, cheap, constrained

Both DWL and codemode run inside V8 isolates — the same technology that powers every Cloudflare Worker. The difference is abstraction level.

### Dynamic Worker Loader (DWL)

DWL is the low-level primitive. You get a `LOADER` binding, call `LOADER.get(id, callback)`, and back comes a `WorkerStub` that can handle `fetch()` requests and Workers RPC calls. The callback returns a `WorkerCode` object: your code as strings, organized into modules.

```javascript
// Host Worker or Durable Object
const worker = env.LOADER.get('plugin-v3', () => ({
  compatibilityDate: '2025-09-12',
  mainModule: 'main.js',
  modules: {
    'main.js': pluginCode,           // JS string
    'utils.js': utilsCode,           // additional modules
  },
  env: { API_KEY: 'safe-to-share' }, // only structured-clonable values
  globalOutbound: null,              // block all fetch/connect
}));

// Call a named entrypoint's RPC method — no fetch() needed
const entrypoint = worker.getEntrypoint('PluginConfig');
const config = await entrypoint.getResourceConfig();
const result = await entrypoint.validate(data);
```

**What makes DWL interesting:**

- **Isolate caching.** The runtime may keep an isolate warm across calls with the same `id`. No guarantee, but in practice you get near-zero overhead for repeated calls. Change the code? Change the `id`.
- **RPC, not just fetch.** DWL Workers can export `WorkerEntrypoint` classes with regular methods. The host calls them directly over Workers RPC — no HTTP serialization, no routing boilerplate.
- **Explicit env control.** The child Worker gets *only* what you pass in `env`. No inherited bindings, no ambient access. Combined with `globalOutbound: null`, the sandbox can't reach the network at all.
- **Module dictionaries.** You can bundle dependencies (like a 143 KB mesh framework) and pass them alongside user code. The child imports them with standard ES module syntax.

**What to watch out for:**

- **WASM modules are supported.** Since November 2025 ([workerd #5460](https://github.com/cloudflare/workerd/pull/5462)), you can include `{ wasm: wasmData }` modules alongside `{ js }`, `{ cjs }`, `{ text }`, `{ data }`, `{ json }`, and `{ py }`.
- **No runtime validation of `WorkerCode`.** Unknown properties are silently ignored ([workerd #5681](https://github.com/cloudflare/workerd/issues/5681)). TypeScript types are your only guard against typos.
- **Can't pass `DurableObjectNamespace` bindings directly.** You get `DataCloneError`. However, `DurableObjectClass` references and `ServiceStub` (Fetcher) bindings *can* be passed via `env` (workerd PR #4834). In practice, the constraint pushes you toward the "inverted model" where the host DO owns storage and the DWL isolate makes decisions — which is the right pattern anyway.
- **Python is much slower to start.** The docs warn that Python Workers startup may defeat the performance benefits of dynamic isolate loading, and pricing may differ at GA.
- **Closed beta for production deployment.** Local dev with wrangler works today. Production requires [beta signup](https://forms.gle/MoeDxE9wNiqdf8ri9).
- **Assume stateless.** Isolate caching is an optimization, not a contract. Any mutable state should live in the host's storage.

### codemode (`@cloudflare/codemode`)

Codemode wraps DWL into a purpose-built tool for LLM code execution. Instead of managing module dictionaries and entrypoints yourself, you define tools (as Zod schemas or JSON Schema), and codemode generates a TypeScript type declaration that goes into the LLM prompt. The LLM writes JavaScript code that calls `codemode.toolName(args)`, and codemode executes it in an isolated DWL Worker.

```javascript
import { createCodeTool } from '@cloudflare/codemode/ai';
import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { tool } from 'ai';
import { z } from 'zod';

// 1. Define your tools
const tools = {
  getWeather: tool({
    description: 'Get current weather for a city',
    parameters: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ temp: 72, city }),
  }),
};

// 2. Create executor and codemode tool
const executor = new DynamicWorkerExecutor({
  loader: env.LOADER,
  globalOutbound: null,  // default — fully isolated
  timeout: 30_000,       // 30s execution limit
});

const codeTool = createCodeTool({ tools, executor });
// codeTool is a standard AI SDK Tool — pass it to streamText/generateText
```

**The pipeline:**

1. `generateTypes(tools)` introspects Zod schemas (via `zod-to-ts`) or JSON Schema wrappers and produces TypeScript declarations for the LLM prompt
2. The LLM writes an async function calling `await codemode.getWeather({ city: 'Seattle' })`
3. `acorn` parses and normalizes the LLM's code (strips markdown fences, wraps in async function if needed)
4. `DynamicWorkerExecutor` creates a DWL Worker with the code wrapped in a `WorkerEntrypoint`
5. Inside the sandbox, a `Proxy` intercepts `codemode.*` calls and routes them back to the host via `ToolDispatcher extends RpcTarget`
6. Console output is captured and returned in `ExecuteResult.logs`

**When codemode helps vs. when it doesn't:**

| Use codemode when... | Use raw DWL when... |
|----------------------|---------------------|
| LLM generates the code | Code is pre-authored or uploaded by users |
| You want AI SDK integration | You need custom entrypoints or module loading |
| Tool orchestration is the goal | You're embedding a framework (like Mesh) |
| You want console capture + timeout out of the box | You need fine-grained control over isolate lifecycle |

**Codemode gotchas:**

- **Import broken in Workers (v0.1.2).** The `zod-to-ts` dependency pulls in the TypeScript compiler, which uses `__filename` — a CJS global unavailable in Workers ESM. You'll get `__filename is not defined` at import time. This affects the entire package, not just `generateTypes()`, because the module graph isn't tree-shaken at the entry point level. Likely to be fixed in a future release.
- The `zod-to-ts` dependency bundles the TypeScript compiler (`ts.factory`), which significantly increases bundle size even if you only use `DynamicWorkerExecutor`.
- Only JavaScript execution — the LLM is explicitly instructed to write JS, not TypeScript.
- `needsApproval` on tools is not supported yet — tools execute immediately in the sandbox.
- The `Executor` interface is runtime-agnostic (great for portability), but `DynamicWorkerExecutor` is the only shipped implementation.

---

## Tier 2: Linux VMs — powerful, slower, pricier

When V8's constraints don't fit — you need a native binary, filesystem access, more than 128 MB of memory, or a language beyond JS/Python — Cloudflare Containers give you full Linux VMs on Cloudflare's network. Each Container is paired with a Durable Object that acts as a programmable sidecar.

### Containers

Containers run your Docker images on Cloudflare's infrastructure. You push to Cloudflare's registry, configure an instance type, and the platform handles placement, sleep/wake, and the DO sidecar.

```typescript
// wrangler.jsonc
{
  "containers": [{
    "class_name": "MyContainer",
    "image": "./Dockerfile",
    "instance_type": "basic",     // 1/4 vCPU, 1 GiB memory, 4 GB disk
    "max_instances": 3
  }]
}
```

```typescript
// src/index.ts
import { Container } from '@cloudflare/containers';

export class MyContainer extends Container {
  defaultPort = 8080;

  override sleepAfter = '10m';      // auto-sleep after 10 min idle
  override envVars = {
    NODE_ENV: 'production',
  };

  async onStart() {
    console.log('Container started');
  }
}
```

**Instance types and pricing** (Workers Paid plan, $5/month):

| Type | vCPU | Memory | Disk | Memory cost/hr | CPU cost/hr (100% util) |
|------|------|--------|------|----------------|------------------------|
| lite | 1/16 | 256 MiB | 2 GB | $0.0023 | $0.0045 |
| basic | 1/4 | 1 GiB | 4 GB | $0.009 | $0.018 |
| standard-1 | 1/2 | 4 GiB | 8 GB | $0.036 | $0.036 |
| standard-2 | 1 | 6 GiB | 12 GB | $0.054 | $0.072 |
| standard-3 | 2 | 8 GiB | 16 GB | $0.072 | $0.144 |
| standard-4 | 4 | 12 GiB | 20 GB | $0.108 | $0.288 |

CPU is billed on **active usage only** (not provisioned) since November 2025. Memory and disk are billed on provisioned resources. Plus Workers request costs, DO wall-clock billing, and network egress ($0.025-0.05/GB).

**Container facts:**

- **Disk is ephemeral.** Everything is lost on sleep/restart. Persist with R2 bucket mounts.
- **Cold start is 2-3 seconds**, image-dependent. Future Firecracker snapshot support could potentially reduce this.
- **Only Cloudflare Registry.** No Docker Hub or ECR pulls.
- **No autoscaling yet.** Manual scaling only via `getContainer(binding, id)` or `getRandom(binding, count)`. Autoscaling and latency-aware routing are planned for GA.
- **Shutdown is graceful.** `SIGTERM` first, then `SIGKILL` after 15 minutes. Design for graceful shutdown.
- **Billing stacks.** You pay Workers + DO + Container compute + egress. Four billing meters for one request path.

### Sandbox SDK (`@cloudflare/sandbox`)

Sandbox SDK wraps Containers the way codemode wraps DWL — adding a high-level API on top of the raw primitive. It ships a pre-built Ubuntu 22.04 image with Python 3, Node.js, and Git pre-installed.

```typescript
import { getSandbox } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox(env.Sandbox, 'my-sandbox');

    // Execute a command
    const result = await sandbox.exec('python3', ['-c', 'print(2 + 2)']);
    // result.exitCode, result.stdout, result.stderr

    // Or use the code interpreter for persistent sessions
    const ctx = await sandbox.createCodeContext({ language: 'python' });
    const output = await ctx.execute('import math; math.pi');

    return new Response(JSON.stringify(output));
  },
};
```

**What Sandbox adds over raw Containers:**

| Feature | Raw Container | Sandbox SDK |
|---------|--------------|-------------|
| Shell execution | DIY HTTP API | `sandbox.exec(cmd, args)` |
| Streaming output | DIY | `sandbox.execStream()` |
| File operations | DIY | `sandbox.files.read/write/list` |
| Code interpreter | DIY | `createCodeContext()` with rich output |
| Process management | DIY | `sandbox.process.start/stop/list` |
| Port exposure | DIY | `sandbox.ports.expose()` with preview URLs |
| R2 mounts | Config-only | SDK-managed |
| Git operations | DIY | `sandbox.git.clone/pull/push` |
| Pre-installed runtimes | Build your own image | Python 3, Node.js, Git included |

**What Sandbox does NOT add:** Authentication, authorization, input validation, rate limiting. Those are your responsibility.

**Transport options:** The SDK communicates with the container over HTTP (default) or WebSocket. HTTP is simpler but each SDK call is a subrequest (50 free / 1,000 paid per request). WebSocket multiplexes all calls over a single connection, avoiding subrequest limits for concurrent operations. The transport is transparent to your code.

**Sandbox gotchas:**

- **State is ephemeral.** Files, processes, and env vars are lost when the sandbox sleeps (default: 10 minutes).
- **Within a sandbox, all code shares resources.** There's no per-execution isolation. Different users or actors need separate sandbox instances.
- **Same billing as raw Containers** — the SDK abstraction is free, but you're still paying for the underlying Container.

---

## The crossover: when to use which tier

The decision between tiers is usually obvious:

| You need... | Use |
|-------------|-----|
| Sub-millisecond dispatch for JS/Python code | V8 Isolate tier (DWL or codemode) |
| Native binaries (Go, Rust, C++) | Linux VM tier (Container or Sandbox) |
| More than 128 MB memory | Linux VM tier |
| Filesystem access | Linux VM tier |
| Lowest possible cost per invocation | V8 Isolate tier |
| Pre-built Ubuntu with Python/Node | Sandbox SDK |
| Full control over the Docker image | Raw Container |

The decision *within* each tier is about abstraction level:

| Question | Raw (DWL / Container) | Wrapped (codemode / Sandbox) |
|----------|-----------------------|------------------------------|
| Who writes the code? | You or your users | The LLM |
| Do you need custom module loading? | Yes → Raw | No → Wrapped is simpler |
| Do you need the AI SDK `Tool` interface? | No → Raw | Yes → codemode |
| Do you need exec/files/git/interpreter? | No → Raw Container | Yes → Sandbox |
| How much boilerplate are you willing to write? | More → Raw gives control | Less → Wrapped handles it |

### Can they coexist?

Yes. A single Worker can have both a `LOADER` binding (DWL) and a Container binding. This enables architectures where the hot path (guards, validation, config) runs in DWL with ~1 ms overhead, while cold-path operations (type-checking, code compilation, heavy compute) run in Containers with 2-3 second startup amortized across many calls.

---

## Also worth knowing: Workers for Platforms

Workers for Platforms (WfP) is the production-grade predecessor to DWL for multi-tenant code execution. It's been GA for years and powers services like Shopify Oxygen. Where DWL uses `LOADER.get(id, callback)` to spawn isolates from code strings, WfP uses "dispatch namespaces" — you upload customer Workers to a namespace via API, then a dispatch Worker routes requests to them.

| Aspect | DWL | Workers for Platforms |
|--------|-----|----------------------|
| Code delivery | In-memory strings | API upload to namespace |
| GA status | Closed beta | GA |
| Pricing | Worker request | Per-namespace + per-request |
| Isolation model | Isolate per `get()` call | Isolate per dispatched Worker |
| Use case | Runtime code loading, plugins | Multi-tenant SaaS platforms |

If you need production-stable multi-tenant isolation today and DWL's beta status is a blocker, WfP is the proven alternative. DWL's advantage is developer ergonomics — code-as-strings is simpler than managing upload/deployment pipelines.

---

## Security model comparison

All four technologies provide strong isolation, but the mechanisms and defaults differ:

| Security aspect | DWL | codemode | Container | Sandbox |
|-----------------|-----|----------|-----------|---------|
| **Isolation boundary** | V8 isolate | V8 isolate | Linux VM | Linux VM |
| **Network default** | Open (must set `globalOutbound: null`) | Blocked by default | Open (must configure) | Configurable |
| **Env inheritance** | None — explicit only | None | Explicit `envVars` | Explicit |
| **Filesystem access** | None (V8 has no FS) | None | Full (ephemeral) | Full (ephemeral) |
| **Process spawning** | Not possible | Not possible | Full | Full |
| **Resource limits** | 128 MB, CPU time limits | 128 MB, 30s timeout | Instance-type dependent | Instance-type dependent |
| **Auth/authz** | Your responsibility | Your responsibility | Your responsibility | Your responsibility |

The V8 isolate boundary is arguably *stronger* for code-level isolation because there's no filesystem, no process table, and no kernel to attack. The trade-off is capability — you can only run what V8 supports.

---

## Billing deep dive

**V8 Isolate tier** — DWL and codemode add no billing beyond the host Worker request. You pay standard Workers pricing: $0.30 per million requests on the paid plan (first 10M/month included). The DWL isolate itself has no separate meter. This makes DWL essentially free for hot-path dispatch.

**Linux VM tier** — Containers stack four billing meters:

1. **Worker request** — same as above
2. **Durable Object** — wall-clock billing for the sidecar DO ($12.50/million GB-s)
3. **Container compute** — CPU (active usage), memory (provisioned), disk (provisioned)
4. **Network egress** — $0.025-0.05/GB

For a `basic` instance (1/4 vCPU, 1 GiB) running continuously at 20% CPU utilization:
- Memory: 1 GiB × 3600s × $0.0000025 = $0.009/hr
- CPU: 0.25 vCPU × 3600s × $0.000020 × 0.20 = $0.0036/hr
- Disk: 4 GB × 3600s × $0.00000007 = $0.001/hr
- **Total: ~$0.014/hr or ~$10/month**

Plus DO wall-clock and Worker request costs.

**Break-even: cold-starting vs. staying warm.** If each cold start costs ~3 seconds of compute and you're paying for idle time, the break-even point depends on request frequency. At 1 request/minute, the 3-second startup amortizes to 5% overhead. At 1 request/hour, you're paying ~$0.014/hr in idle costs vs. ~$0.00004 in startup compute — staying warm is 350x more expensive per request. Use `sleepAfter` aggressively for bursty workloads.

---

## What we measured

We built a [spike](https://github.com/lumenize/lumenize/tree/main/experiments/dwl-spike) with six DWL experiments:

| Test | What | Result |
|------|------|--------|
| Basic DWL fetch | DO spawns isolate, calls `fetch()` | Works |
| Env passing | Structured-clonable values in `env` | Works |
| WorkerEntrypoint RPC | Named entrypoint with typed methods | Works — full RPC, objects round-trip |
| DO namespace binding | Pass `DurableObjectNamespace` in `env` | `DataCloneError` — confirms inverted model |
| Framework integration | 143 KB mesh bundle in module dict | Works — `this.lmz`, `this.ctn()` all functional |
| Auth-aware guards | Mesh envelope with JWT claims propagation | Works — role-based guards in DWL |

**DWL benchmarks** (local dev, wrangler 4.71.0 — production numbers will differ):

| Benchmark | Median | p95 | Notes |
|-----------|--------|-----|-------|
| Isolate creation (cold) | 1 ms | 2 ms | Unique id per call — forces fresh isolate |
| Isolate creation (warm) | &lt;1 ms | &lt;1 ms | Same id — runtime reuses cached isolate |
| RPC: string return | &lt;1 ms | &lt;1 ms | Pre-warmed isolate, `ping() → 'pong'` |
| RPC: complex object | &lt;1 ms | 1 ms | Pre-warmed, 100-user nested object |
| Module loading: 1 KB | 1 ms | 2 ms | Cold, main + helper module |
| Module loading: 100 KB | 2 ms | 3 ms | Cold, main + 98 KB helper |
| Module loading: 500 KB | 8 ms | 12 ms | Cold, main + 488 KB helper |
| `globalOutbound: null` | &lt;1 ms | &lt;1 ms | Zero overhead vs. unrestricted |
| codemode-equivalent | 1 ms | 1 ms | Console capture + Proxy + timeout + RPC dispatch |

Key takeaways: isolate creation is the dominant cost (~1 ms cold), and it scales linearly with module size. RPC marshaling, `globalOutbound: null`, and codemode's wrapping pattern (console capture, Proxy-based tool dispatch, setTimeout timeout) all add no measurable overhead. The caching benefit is real — once an isolate is warm, calls are sub-millisecond.

One codemode gotcha we hit: `@cloudflare/codemode` v0.1.2 can't currently be imported in Workers because its `zod-to-ts` dependency pulls in the TypeScript compiler, which uses `__filename` (a CJS global unavailable in Workers ESM). We benchmarked codemode's overhead by replicating its `DynamicWorkerExecutor` pattern directly.

**`tsgo` type-checking benchmarks** (local, `@typescript/native-preview` 7.0.0-dev — representative of Container workload):

| Schema size | Files | Disk | Median | Notes |
|-------------|-------|------|--------|-------|
| 10 types | 12 | 48 KB | 82 ms | Startup-dominated (~80 ms overhead) |
| 100 types | 102 | 416 KB | 91 ms | Only 9 ms more than 10 types |
| 1000 types | 1002 | 4 MB | 283 ms | ~0.2 ms per additional type |

Each "type" is a realistic schema: 3 interfaces (resource, metadata, config), a discriminated union event type, and a type guard function. tsgo's startup overhead (~80 ms) dominates small schemas. At scale, the per-type cost is negligible. In a Container with 2-3 second cold start, the type-checking itself is the fast part — it's the Container startup you're amortizing.

**Container cold start**: We haven't deployed container benchmarks yet. Cloudflare's published spec is 2-3 seconds, image-dependent. A minimal `tsgo`-only image would add ~45 MB (the `@typescript/native-preview` binary). Combined with the type-checking numbers above, a full cold-start-plus-check cycle for 100 types would be roughly 2-3 seconds (startup) + 91 ms (check) ≈ 2.1-3.1 seconds total.

---

## Decision framework

Rather than prescribing a "best for" answer, here's how we think about the choice:

**Start with the constraints:**

1. Does the code need native binaries or more than 128 MB? → Linux VM tier. Otherwise → V8 Isolate tier.
2. Can you tolerate 2-3 second cold starts? No → V8 Isolate tier only.
3. Is the code LLM-generated? → Consider codemode (V8) or Sandbox (Linux). Both are purpose-built for AI agents.
4. Is cost the primary concern? → V8 Isolate tier. DWL adds zero marginal cost beyond the host Worker request.

**Then choose the abstraction level:**

5. Do you need fine-grained control (custom modules, entrypoints, lifecycle)? → Raw (DWL or Container).
6. Do you want batteries-included with less code? → Wrapped (codemode or Sandbox).
7. Are you building a multi-tenant SaaS platform that needs GA stability today? → Workers for Platforms.

**In Nebula**, we use DWL for hot-path operations (resource guards, validators, config) where ~1 ms overhead matters and the code is pre-authored JavaScript. Containers are reserved for operations that need native tooling — like running `tsgo` for TypeScript type-checking — where 2-3 second cold starts are acceptable because the results are cached.

---

## Current limitations worth tracking

These are the rough edges we've hit or that the docs call out. All are expected to improve as the technologies mature:

1. **DWL production access requires beta signup.** Local dev with wrangler works today.
2. **DWL doesn't validate `WorkerCode` at runtime** ([workerd #5681](https://github.com/cloudflare/workerd/issues/5681)). Typos in config silently pass.
3. **codemode can't be imported in Workers (v0.1.2).** The `zod-to-ts` → TypeScript compiler chain uses `__filename`, breaking ESM Workers. The wrapping patterns work fine if replicated directly.
4. **Container disk is ephemeral.** Use R2 mounts for anything you need to survive sleep.
5. **Sandbox shares resources within a single instance.** Different actors need different sandbox IDs.
6. **No Container autoscaling.** Manual `max_instances` only.
7. **DWL isolate caching has no SLA.** Same `id` *may* reuse an isolate. Design for statelessness.
8. **codemode's `needsApproval` is not wired up.** Tools execute immediately without approval flow.
9. **Containers only support Cloudflare Registry.** No Docker Hub or ECR.
10. **CPU pricing changed November 2025.** Now based on active usage, not provisioned. Old blog posts may show higher numbers.
11. **DWL Python Workers are slow to start.** The docs explicitly warn that Python's startup time "may defeat some of the benefits of dynamic isolate loading."
12. **Sandbox subrequest limits.** The default HTTP transport counts each SDK call as a Worker subrequest (50 free, 1,000 paid). Use WebSocket transport for high-call-volume workloads.
