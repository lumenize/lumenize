# Make `lmz.call()` with response handlers eviction-safe by default

**Goal**: Consider making all `lmz.call()` invocations that include a response handler automatically use the two-one-way pattern (fire-and-forget + callback) under the covers, so framework users get eviction-safety as a default rather than a manual discipline.

**Status**: Iceboxed (2026-04-30) — see "Why this is iceboxed" below.

## Background

The two-one-way pattern (sometimes called Handler 1 / Handler 2 split) is the standard Lumenize approach for any `lmz.call()` whose callee does long-running work:

1. Caller does `lmz.call(binding, instance, continuation)` — fire-and-forget
2. Callee's `@mesh()` method (Handler 1) is **synchronous** — it dispatches to async work without awaiting
3. The async work (Handler 2) runs in the background and fires a fire-and-forget mesh callback back to the original caller (or to the caller's gateway, which routes to the caller's `@mesh()` handler)

Applied correctly, this pattern keeps no outbound RPC stub held across an await — meaning the calling DO never blocks waiting for the result, which is the core eviction-safety property.

The concern: this is a **discipline a developer applies manually**. Any code path that doesn't apply it — e.g., `await stub.method()` or a 4-arg `lmz.call(..., handler)` that the framework treats as request/response under the covers — holds an outbound stub across an await, which is eviction-unsafe.

## Original idea

Make the framework do this automatically: any `lmz.call()` invocation with a response handler (4th param) should fire-and-forget and have the callee call back with the result + handler continuation. Developers wouldn't have to think about Handler 1 / Handler 2 explicitly; the framework would always be eviction-safe.

## Updated assessment (2026-04-30)

The original framing rested on three premises beyond eviction-safety. The architectural deep-dive in [What I got wrong about Durable Object throughput](../website/blog/2026-04-29-what-i-got-wrong-about-do-throughput/) (and the discussion that produced it) weakened all three:

- **Wall-clock billing on awaiting DOs** — much smaller than feared. The actual heavy paths in Nebula already use Handler 1 / Handler 2: Handler 1 is synchronous and dispatches to async work without awaiting; the async work fires the result back via a fire-and-forget mesh callback. The Gateway → Star RPC await is microseconds (just the Handler 1 dispatch), not the full transaction duration (which includes facet call + storage commit + output-gate flush).
- **Throughput / 6-simultaneous-connection limit** — similarly weak. Same reason: the awaited window at the Gateway is short.
- **Latency hit from making it the default** — negligible (was the open question in the original idea).

## Remaining hypothesis: eviction-safety as a framework default

This is the only premise that survives the analysis. Whenever a developer writes a non-Handler-1/Handler-2 path — including legacy code, third-party integrations, or simply a path where they forgot to apply the discipline — they hold an outbound RPC stub across an await. Making two-one-way the framework default would make eviction-safety automatic.

## Why this is iceboxed

The cases where developers *don't* apply Handler 1 / Handler 2 are typically short-running paths (the discipline is well-known where it matters). The eviction-safety win from making it the default is real but marginal in practice. Adding default-fire-and-forget semantics adds non-trivial framework complexity for that marginal gain.

Promote out of icebox if any of these become true:

- A concrete eviction-related bug surfaces in production code that Handler 1 / Handler 2 would have prevented.
- Framework consumers (vibe-coders especially) are systematically forgetting Handler 1 / Handler 2 and shipping eviction-unsafe code.
- The framework gains other reasons to convert request/response into two-one-way under the covers (e.g., a uniform retry/idempotency model that needs the fire-and-forget shape anyway).

## Discovered/refined during

Originally captured in `tasks/backlog.md` as an experiment item. Refined and moved here on 2026-04-30 during the [What I got wrong about Durable Object throughput](../website/blog/2026-04-29-what-i-got-wrong-about-do-throughput/) blog post drafting, which traced the actual code paths and weakened the original throughput / billing premises.
