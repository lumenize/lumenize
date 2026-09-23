# A remote caller reaches more than `@mesh` marks

**Status:** Pass 1 — the problem and the alternatives only. **No solution is chosen**, and phases are NOT written. Surfaced 2026-09-22/23 by `/review-task` Stage 2 of [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md). **These are pre-existing holes in `@lumenize/mesh`, not introduced by any Nebula task**, and they must close before the pre-alpha wipe invites the first outside users. A reviewer agent queued a task chip for this work; this file supersedes it.

**Objective — a remote caller reaches exactly what `@mesh` marks, and nothing it reads, calls or smuggles in gets past the allowlist without it.**

**Three goals, in the order they matter:**

1. **The request leg honours the boundary the docs state.** `website/docs/mesh/continuations.mdx` says *"The absence of `@mesh` is exactly what keeps it off the remote call surface — that is the security boundary."* Today the allowlist blocks one thing — an undecorated method as a chain's first call. Reads, `svc` calls and nested get-only markers all pass, so a tenant who self-signs-up can read the host's `env` and run arbitrary SQL on its parent Galaxy.
2. **The subscriber cannot drive the response leg.** When a DO pushes to a client with a 4-arg call, the client writes the reply. The reaper takes its victim's id from that reply, and a marker inside it runs a guarded method with the guard skipped.
3. **The boundary is written once, where a reader looks for it, and matches the code.** Today the docs promise more than the executor enforces.

## Relationships

- **Gates [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md).** Its Phase 7 claims to close the reaper hole by shedding `@mesh()`, and the hole is in the reply path. Its three-tier contract also assumes `@mesh()` entries are the whole wire surface. That task re-runs its Stage 2 after this one lands.
- **Must land before the pre-alpha wipe** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*).

## Context and current state

**What the allowlist does, measured.** A probe ran the real `executeOperationChain` (`packages/mesh/src/ocan/execute.ts`) against a stand-in object holding one of each kind of member (2026-09-23):

| Chain | Leg | Result |
|---|---|---|
| call a `@mesh` method | request | allowed |
| call an undecorated method | request | **refused** — `Method 'plain' is not mesh-callable` |
| call a `@mesh` method whose guard refuses | request | **refused** by the guard |
| read `env.SECRET`, no call | request | **allowed → `the-secret`** |
| read `ctx.id`, no call | request | allowed |
| call `ctx.storage.deleteAll()` | request | refused |
| call `svc.sql(['DELETE FROM x'])` | request | **allowed — the SQL ran** |
| after a `@mesh` gate, walk back to an undecorated method | request | allowed, if the gate's return value holds a reference back |
| nested get-only marker as an argument | request | **allowed — the argument received the secret** |
| nested `svc` chain as an argument | request | **allowed — the SQL ran** |
| nested undecorated call as an argument | request | refused |
| call an undecorated method | response | allowed |
| call a guarded `@mesh` method | response | **allowed, guard skipped** |

**So the allowlist blocks one thing: an undecorated method as the first call in a chain.** The check fires at the first `apply` and latches. That gives four ways through:
- a chain with no call never reaches the check;
- a chain opening `get 'svc'` is exempt (`isServiceCall`);
- nothing after the first call is checked, which is deliberate and is what makes the gate pattern work;
- the response leg runs at `requireMeshDecorator: false`.

**How it got this way.** The check arrived in `a4f9443` (2026-02-09) already shaped as *"check @mesh decorator on entry point method (first apply operation)"*, with the `svc` exemption from the start. `@lumenize/rpc` keeps its own executor (`packages/rpc/src/ocan.ts`) with no allowlist at all, which is right for a tool that calls anything on your own DO. Mesh forked that executor and added the allowlist. No rule, ADR, task file or doc records a decision for anything stricter than "check the first call", though the docs promise it.

**The parts implicated** — what becomes of each waits on the choice below:

- **The entry-point check** in `executeOperationChain`.
- **The `isServiceCall` exemption.** Its comment calls `svc` methods *"trusted internal framework methods"*.
- **`resolveNestedOperations`**, which executes any argument shaped like `{ __isNestedOperation: true, __operationChain }` against the DO. `processArgumentsForNesting` in `ocan/proxy-factory.ts` builds these from ordinary `ctn()` calls.
- **The Gateway's `#handleIncomingCallResponse`**, which takes a client's `success: false` error without checking it.
- **The local handler run in `lmz-api.ts`** — `executeOperationChain(filled, nodeInstance, { requireMeshDecorator: false })`.

**How a browser reaches each hole — the ordinary API is enough, and none needs Workers RPC:**

```ts
lmz.call('GALAXY', scope, ctn<any>().svc.sql(['DELETE FROM Subscribers']));    // SQL, request leg
lmz.call('STAR', scope, ctn<Star>().transaction(ctn<any>().env.SECRET, e, o)); // read, nested
class Evil extends NebulaClient {                                               // response leg
  handleQuerySubscriberListUpdate() { throw Object.assign(new Error(), { name: 'ClientDisconnectedError', clientInstanceName: victim }); }
}
```

⚠️ **Not yet driven end to end.** Every link was read in source and the executor links were run, but nobody has driven the full path from a real browser session through the Gateway to a DO. Whatever is chosen, a `/live` scenario should reproduce each hole first and become the regression test.

## Alternatives to weigh

None is chosen. Each entry says what it closes and what it costs, so the choice can be made on the evidence.

**For the request leg:**

- **A chain must open with a call to a `@mesh` method** — a `get` followed immediately by its `apply` — at the top level and in every nested marker. Larry's recollection is that mesh was meant to work this way. One structural check closes reads, `svc` from the wire, and get-only markers. `resources().transaction(…)` and `resources().orgTree.setPermission(…)` still pass. It needs the `svc` question below answered first.
- **Let `@mesh` mark a getter or property too, and refuse any unmarked one before the first call.** More general: a property could be an entry. The check reads `parent[methodName]`, which for a getter *invokes* it, so it would have to read the property descriptor instead. Neither current gate opens with a property.
- **Scope the `svc` exemption to chains that start locally, rather than removing it.** Closes `svc` from the wire and nothing else. Useful alongside another option, not alone.
- **Refuse nested markers in arguments that come from a client.** Closes get-only markers and nested `svc`, but takes away a documented feature (`c().combine(c().getData(), …)`) from client callers. Whether any client uses nesting is unmeasured.
- **Deny `env`, `ctx` and `svc` by name.** Smallest change, but it enumerates. The next sensitive field is not on the list (`calibration.md` §2).

**For the response leg:**

- **The reaper takes the dead client's id from the push's own target address**, never from the reply. The pusher always knows whom it pushed to. Closes the forged reap.
- **Never treat a substituted result as a nested marker.** Closes the guard-skipped run.
- **Mark a delivery failure as Gateway-made**, so a client's reply can never pass for one. Closes the forged reap at the source; the reaper stays as it is.
- **Run the local handler at `requireMeshDecorator: true`.** Probably breaks by design, since handlers are undecorated on purpose, so a local handler would stop running at all.

**Questions any choice must answer:**

1. **What the `svc` exemption is for.** If `alarms`, `broadcast` or `fetch` execute stored continuations that open with `svc`, a fix must tell a local chain from one that came in off the wire rather than delete the exemption.
2. **What a `@mesh` gate may return.** Nothing after the first call is checked under any option, so a gate whose return value holds a path back to the DO, its `ctx`, `env` or `svc` exposes all of it. `DagTree` is safe today, since every field is `#`-private. The obligation needs a home in `mesh.md` whichever option wins.

## Constraints and future state

**Constraints.** [ADR-003](../docs/adr/003-continuation-messaging.md) — continuations are the only call shape, so a fix must not break nesting between mesh nodes or the fire-back. [ADR-007](../docs/adr/007-shared-node-security-core.md) — the guard core is shared, so the fix lands once in the package for every node type. `CLAUDE.md` — a package gap is fixed in the package, never worked around in Nebula. `security.md` governs the fail-closed behaviour.

**Future state.** Every row of the probe table that reaches something undecorated turns refused, and `mesh.md` § *Object-capability access* and `continuations.mdx` state the boundary as the code enforces it.
