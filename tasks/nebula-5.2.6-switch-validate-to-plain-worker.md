# 5.2.6 — Switch Nebula Validation to Plain Worker (Service Binding)

**Status**: Not started
**Depends on**: 5.2.3 (ontology wiring complete)
**Spike evidence**: `experiments/dw-bundler-spike/` — deployed benchmarks from user's machine

## Context

The Dynamic Worker spike (5.2.3.6.5) proved that **a plain Worker via Service Binding** is the best approach for offloading tsc validation from Durable Objects:

| Path | Warm single check | E2E (6 checks) | Cold/first |
|---|---|---|---|
| Ping (baseline) | 33 ms | — | — |
| In-process | 49–53 ms | 209 ms | 129 ms |
| **Plain Worker (Service Binding)** | **38–53 ms** | **138 ms** | 479 ms |
| Dynamic Worker | 45–55 ms | 993 ms | 687–839 ms |

Key findings:
- **~15-25ms tsc compute cost** per validation (after subtracting 33ms ping)
- **DW adds no benefit** — same warm latency, much worse cold start and sequential throughput
- **Plain Worker cold start** (479ms) only happens on deploy, not on eviction like DW
- **DO cannot run validation in-process** — would cap throughput at ~10 req/s per DO
- **DO `await`s the Service Binding call** — opens input gates, allows interleaving, pays wall-clock billing (~15-25ms per validation). Acceptable cost.

## Architecture

```
Browser → Gateway Worker → Star DO → tsc-checker Worker (Service Binding)
                                   ↓
                              Transaction proceeds if valid
```

- Star DO calls `env.TSC_CHECKER.check(types, literal, typeName)` via Workers RPC
- The checker Worker has the pre-bundled tsc (3.4 MB) with Node.js shims
- Service Binding = same-colo, no external network hop
- Checker Worker fans out infinitely — no throughput bottleneck
- Star DO holds wall-clock open during `await` but allows interleaving

## Phases

### Phase 1 — Extract tsc-checker as a package
- Create `packages/tsc-checker-worker/` (or similar)
- WorkerEntrypoint with `check()` method
- Pre-bundled tsc with esbuild alias shims (os, path, fs, etc.)
- Own `wrangler.jsonc`, deployed as a standalone Worker

### Phase 2 — Wire into Nebula
- Add Service Binding in Nebula's `wrangler.jsonc`
- Star's `doTransaction()` calls checker before proceeding
- Star's `doRead()` calls checker for read validation
- Remove in-process tsc import from Star (reclaim ~40-50 MB memory)

### Phase 3 — Test
- Integration tests: valid/invalid payloads through full Nebula stack
- Verify error messages propagate correctly to client
- Verify wall-clock billing is acceptable under load

## Bundling Notes

The `.mjs` bundle for in-process use requires esbuild with:
- `platform: 'neutral'` (not `browser` — its shims are broken)
- `alias` to redirect `os`, `path`, `fs`, `perf_hooks`, `crypto`, `inspector` to custom shims
- `inject` for `__filename`/`__dirname` globals

See `experiments/dw-bundler-spike/scripts/bundle-tsc.mjs` and `scripts/shims/` for the working config.
