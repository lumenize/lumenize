# Promote `@lumenize/debug` sink → production transport API

> 🧊 **Iceboxed 2026-06-22.** Speculative — no consumer yet (Sentry/Logflare/custom forwarder). Bulk analytics already routes via the Tail Worker, not this. Revive when a real error-forwarding consumer asks.

**Status**: On hold — speculative; pick up when a real consumer asks (Sentry forwarder, Logflare, custom HTTP/dashboard). **Scope narrowed 2026-06-14**: bulk Cloudflare analytics (R2/AE) is *out* — that goes via the Tail Worker, not an in-process push. See [nebula-observability-tail-worker-r2-ae.md](../on-hold/nebula-observability-tail-worker-r2-ae.md).
**Related**:
- [tasks/on-hold/nebula-observability-tail-worker-r2-ae.md](../on-hold/nebula-observability-tail-worker-r2-ae.md) — the **out-of-band** alternative (Tail Worker harvests console → R2/AE). Supersedes this file *for bulk Cloudflare analytics*; this file owns the in-process, portable, full-fidelity, synchronous path. See "Scope boundary" below.
- Current sink at [packages/debug/src/sink.ts](../../packages/debug/src/sink.ts) — explicitly scoped to tests; module docstring says "Production code MUST NOT depend on this module."
- LumenizeDO error logging path at [packages/mesh/src/lumenize-do.ts](../../packages/mesh/src/lumenize-do.ts) — uses `debug('lmz.mesh.LumenizeDO.onStart').error(...)` after [cloudflare/workers-sdk#14180](https://github.com/cloudflare/workers-sdk/issues/14180) workaround.
- Compared design surface: Cloudflare Agents / partyserver's `onError` hook (per-class override point for error policy). See chat history 2026-06-04 for the side-by-side.

## Goal

Give framework users a single, documented way to route every `debug()` log entry to an external destination (Sentry, Logflare, a custom HTTP endpoint) without monkey-patching or installing a test-only sink. The mechanism already exists at the sink layer — this task is about promoting it to a real production API and sorting out the rough edges.

## Scope boundary vs the Tail Worker (why both exist)

This in-process transport and the [Tail Worker harvest](../on-hold/nebula-observability-tail-worker-r2-ae.md) are **complementary, not competitors** — different layer, different job. The Tail Worker is superior for bulk Cloudflare analytics; it structurally **cannot** do what this path is for:

1. **Full structured-clone fidelity.** This hook fires inside `#log` with the *live* `DebugLogOutput` — real `Error` objects (stack, `cause`), `Date`, `Map`, cycles (ADR-002). A Tail Worker only ever sees the already-`JSON.stringify`'d console string, where an `Error` is `{}`. So Sentry-style error capture belongs here.
2. **Non-Cloudflare runtimes.** `@lumenize/debug` is a public MIT package (Node/Bun/browser). A Tail Worker doesn't exist off Cloudflare; the in-process transport is the only portable forwarding story.
3. **Immediate / synchronous forwarding.** Tail delivery is out-of-band, batched, best-effort (sampled under load, Paid/Enterprise only). "Forward the instant it throws" belongs here.

**Decision when either is picked up:** AE/R2 (bulk, queryable, batched) → Tail Worker. Sentry/Logflare/custom-HTTP and any non-Cloudflare runtime → this in-process transport. Don't route bulk analytics through `addDebugTransport`.

## Why this shape (vs. per-class `onError` hooks)

- **One config point** covers every Lumenize package (`mesh`, `alarms`, `auth`, etc.) and every level (`debug`/`info`/`warn`/`error`), not just thrown errors. Per-class hooks duplicate the wiring N times.
- **Captures pre-failure signal.** A transport sees `warn` and `info` — useful for "something is degrading" telemetry — that an error-only hook misses by design.
- **Already structured.** Entries have `{level, namespace, timestamp, message, data}`. Transports route on those discriminators for free; an `onError(err)` hook would have to invent its own.
- **Doesn't entangle with control flow.** Subclasses still decide swallow-vs-rethrow via normal JS. Avoids the "do I override `onError` or install a transport?" confusion if we ever added both.
- **Zero migration.** Every existing `debug('...').error(...)` call already flows through. No catch blocks need to change.

## Phase 1 — Design decisions

Each is a real fork worth thinking through before writing code; rough leanings noted but not pinned.

- **Multi-transport.** Replace single-slot `setDebugSink(fn)` with `addDebugTransport(fn) → disposer`. Different consumers (Sentry, Logflare, devtools) co-exist. *Lean: yes.*
- **Augment vs. replace `console.debug`.** Test sink replaces (clean assertions). Production transport almost certainly wants to ADD (still see logs in `wrangler tail`). Per-transport flag, default `{ replaceConsole: false }`. *Lean: yes.*
- **Test-sink precedence.** When a test installs a sink, production transports installed elsewhere must NOT fire (otherwise tests do real Sentry calls). Probably: test sink takes over the chain for its duration; production transports resume on clear. *Lean: yes — but verify the test-sink-clear path actually re-enables them cleanly.*
- **Sync vs. async transports.** Logging must never throw or block. Either restrict transports to sync `void` returns and tell consumers to do their own queueing, or accept `void | Promise<void>` and fire-and-forget any returned Promise. *Lean: accept both, fire-and-forget the Promise.*
- **Filter precedence.** Production transports probably want to bypass the `DEBUG` env filter (current test-sink semantics — "I'm forwarding, let the destination decide"). Confirm this matches Sentry/Logflare reality before committing. *Lean: yes, transports bypass the filter, same as today's sink.*
- **Per-isolate installation.** The sink slot is per-module-instance. Installing once in the Worker entry doesn't reach DOs (separate isolate, separate module instance). Either provide a helper that registers from the DO ctor too, or document the constraint very loudly. *Lean: both — a helper plus a doc section. Don't ship without the docs because cross-isolate confusion will be the #1 support question.*
- **Error in transport.** Wrap transport calls in try/catch so a misbehaving transport can't break logging or crash the worker. Log the transport failure to console (carefully — recursion risk). *Lean: yes; track recursion with a per-call flag.*

## Phase 2 — Implementation

- Rename / extend `sink.ts` → `transports.ts` (or keep `sink.ts` for back-compat and have transports build on it).
- Public API on the root export:
  ```ts
  export function addDebugTransport(
    transport: (entry: DebugLogOutput) => void | Promise<void>,
    opts?: { replaceConsole?: boolean }
  ): () => void;  // disposer
  ```
- Keep `setDebugSink` / `clearDebugSink` for test ergonomics — implemented internally as `addDebugTransport(fn, {replaceConsole: true})` with sticky precedence.
- Add `installInDurableObject(ctx: DurableObjectState, transports)` helper that registers transports during the DO's first instantiation. Or just document the pattern — TBD in Phase 1.

## Phase 3 — Docs + canonical example

- New page `website/docs/debug/transports.md` covering: what a transport is, the install pattern (Worker entry + DO ctor), the test-sink precedence, the cross-isolate caveat, and a worked example.
- Worked example: a ~30-line Sentry forwarder transport. Real enough that user-developers can copy/paste.
- Update the LumenizeDO error-handling section of the mesh docs to mention transports as the answer to "how do I forward errors to my monitoring."

## Out of scope

- Replacing `console.debug` as the default output. Today's behavior is fine.
- Buffering / backpressure / retry inside the transport layer. Transport's problem.
- Anything related to the `onError` hook pattern from Cloudflare Agents — that's a different layer (control-flow disposition) and would compete with this design. Decided 2026-06-04 not to adopt it; this task explicitly supersedes that direction.

## Pickup signal

Someone asks "how do I forward Lumenize errors to Sentry / Logflare / my own dashboard?" and the answer "monkey-patch the framework or install a test-only sink" is no longer acceptable.
