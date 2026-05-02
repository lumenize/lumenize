# Phase 5.3: Subscriptions & Fanout

**Status**: Pending
**Depends on**: Phase 5.1 (Storage Engine)

## Scope

`subscribe()` with initial value + ongoing updates, BroadcastChannel semantics (own messages not echoed), cleanup on disconnect, continuation pattern for DO subscribers, auto-resubscribe on reconnect for Clients.

## Open considerations to resolve when this task picks up

- **Consider promoting `apps/nebula/test/browser/` harness to a public subpath export** (e.g., `@lumenize/nebula/browser-test-helpers`). Built during `tasks/parse-validate-release.md` Phase 1 (2026-04-28) as the platform for testing reactivity end-to-end: vitest browser mode + Playwright + auto-spawned `wrangler dev` + `NebulaClientBench` subclass with `@mesh()` result-handler overrides + `?_test=true` auth bootstrap. Currently private; left private until this task's reactivity tests shake out the surface. If downstream consumers want to write similar end-to-end tests against their own Nebula deployments, this is the harness they'd want — promote then.
- **Consider retrofitting the same auto-spawn-wrangler-dev `globalSetup` pattern to Lumenize Mesh's tests** (per-package, not just Nebula). Same lift, same payoff: real-browser-clock timing for any mesh-driven flow.
