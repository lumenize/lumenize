# Structural `@mesh` callContext Guard — close the raw-RPC bypass

**Status**: On hold — **post-demo hardening** (moved to on-hold 2026-06-16). [nebula-do-scope-isolation.md](../archive/nebula-do-scope-isolation.md) (Fix 1) **landed 2026-06-16**, making `onBeforeCall` the sole structural tenant gate; this closes the remaining raw-RPC escape around it. **Not a demo blocker** — the gap is reachable only by a DO making a raw `stub.method()` call, held shut for the demo by the no-raw-RPC convention (`mesh.md`) since every demo DO is Nebula's own trusted code. Revive post-demo — *or sooner if the Studio DWL sandbox is ever given raw DO bindings to tier DOs* (it should reach the host only through narrow, mesh-routed seams — the in-DO WS-client shim this once cited is iceboxed, Think not adopted, `tasks/icebox/think-nebula-integration.md`; if a raw DO binding is ever added, this becomes demo-relevant).
**Origin**: Surfaced by the 2026-06-08 scope-isolation design review (finding m-8). Once `NebulaDO.onBeforeCall` is the *sole* structural tenant gate, the long-standing raw-RPC bypass stops being "one of several backstops" and becomes the one hole in an otherwise-structural wall.

## Objective

Make a `@mesh` method **refuse to execute outside a mesh callContext**, so a direct Workers-RPC call (`stub.method()` / `env.X.get(id).method()`) to a `@mesh`-decorated method **fails closed** instead of silently running with no `onBeforeCall`, no identity, and no `@mesh(requireAdmin)` guard. This upgrades "structural for mesh-routed calls" to "structural, period," completing the thesis of the scope-isolation task.

## The gap (verified)

`onBeforeCall` and every `@mesh(guard)` run only inside `executeEnvelope` ([lmz-api.ts:894-895](../../packages/mesh/src/lmz-api.ts#L894)) — `runWithCallContext(...) → node.onBeforeCall() → __executeChain(...)`. A raw `stub.method()` enters the DO method directly, skipping `executeEnvelope` entirely: no `callContext` installed, no `onBeforeCall`, no decorator. So any *public* method on a tenant-scoped DO is reachable cross-tenant by a foreign DO holding a raw stub — including `@mesh(requireAdmin)` methods. Today this is held shut only by the "no raw RPC in Nebula" convention (`mesh.md`), not by structure.

## Design sketch (to be hardened before "go")

- **Guard:** the `@mesh` decorator wraps the method so it asserts an **active mesh callContext** at entry before running the body; absent ⇒ throw a typed `RawRpcBypassError`, fail-closed. **Why it works:** `executeEnvelope` establishes the context via `runWithCallContext` (AsyncLocalStorage); a raw cross-DO `stub.method()` lands in the callee's *fresh* isolate where ALS carries no context → the assert fails. (Verify ALS genuinely doesn't cross the RPC isolate boundary — expected, but confirm.)
- **Don't break internal/OCAN paths.** The alarm executor (`alarms.ts` `triggerAlarms` → `__localChainExecutor`) runs chains **without** `runWithCallContext`, so under a naive guard it would throw — it needs a **system context**. OCAN continuation-target methods (`doSubscribe`, etc.) aren't `@mesh` today and would need the same wrapper/carve-out. Enumerate every local-execution path and give each either a system context or an explicit internal-call exemption.
- **Framework-level, not Nebula-only.** This lives in `@lumenize/mesh` (the `@mesh` decorator) and affects every `LumenizeDO`, so it needs the mesh test surface, not just `apps/nebula`.

## Open questions (resolve in design review before "go")

- Does every legitimate local/OCAN execution path carry a callContext, or do some need an explicit carve-out? Enumerate them (continuations, alarms, 4-arg result handlers, `onBeforeCall` re-entrancy).
- Throw vs warn during a migration window? A hard throw surfaces latent raw-RPC call sites loudly; a warn-then-throw rollout may be safer for the broader mesh ecosystem.
- Interaction with `createTestingClient` (isolated-DO RPC, which deliberately bypasses the Gateway) — that test path must keep working.
- Perf: one extra context check per mesh call (negligible) vs. the decorator-wrap cost.

## Relation

- **Completes** [nebula-do-scope-isolation.md](../archive/nebula-do-scope-isolation.md) — that task makes `onBeforeCall` the sole structural gate; this one removes the raw-RPC escape around it. Do scope-isolation first.
- Backlog also carries "promote `activeScope`/`authScopePattern` to typed `originAuth` fields" (separate concern).
