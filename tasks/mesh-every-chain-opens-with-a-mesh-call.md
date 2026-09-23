# Every remote chain opens with a call to a `@mesh` method

**Status:** Pass 1 — design intent only, phases NOT written. Surfaced 2026-09-22/23 by `/review-task` Stage 2 of [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md). **These are pre-existing holes in `@lumenize/mesh`, not introduced by any Nebula task**, and they must close before the pre-alpha wipe invites the first outside users. A reviewer agent queued a task chip for this work; this file supersedes it.

**Objective — a remote caller reaches exactly what `@mesh` marks, and nothing it reads, calls or smuggles in gets past the allowlist without it.**

**Three goals, in the order they matter:**

1. **The request leg honours the boundary the docs state.** `website/docs/mesh/continuations.mdx` says *"The absence of `@mesh` is exactly what keeps it off the remote call surface — that is the security boundary."* Today the allowlist blocks one thing — an undecorated method as a chain's first call. Reads, `svc` calls and nested get-only markers all pass, so a tenant who self-signs-up can read the host's `env` and run arbitrary SQL on its parent Galaxy.
2. **The subscriber cannot drive the response leg.** When a DO pushes to a client with a 4-arg call, the client writes the reply. The reaper takes its victim's id from that reply, and a marker inside it runs a guarded method with the guard skipped.
3. **The boundary is written once, where a reader looks for it, and matches the code.** Today the docs promise more than the executor enforces.

## Relationships

- **Gates [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md).** Its Phase 7 claims to close the reaper hole by shedding `@mesh()`, and the hole is in the reply path, which only this task can close. Its three-tier contract also assumes `@mesh()` entries are the whole wire surface. That task re-runs its Stage 2 after this one lands.
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

**Built already, and what becomes of each part:**

- **The entry-point check** in `executeOperationChain`. **Adapted.** It arrived in `a4f9443` (2026-02-09) already shaped as *"check @mesh decorator on entry point method (first apply operation)"*. No record anywhere decides a stricter rule.
- **The `isServiceCall` exemption.** **Adapted or deleted** — open question 2.
- **`resolveNestedOperations`**, which executes any argument shaped like `{ __isNestedOperation: true, __operationChain }` against the DO. **Adapted**, since every nested chain must meet the same rule. `processArgumentsForNesting` in `ocan/proxy-factory.ts` builds these markers from ordinary `ctn()` calls, so no low-level crafting is needed.
- **The Gateway's `#handleIncomingCallResponse`**, which takes a client's `success: false` error unvalidated. **Adapted** for the response leg.
- **The local handler run in `lmz-api.ts`** — `executeOperationChain(filled, nodeInstance, { requireMeshDecorator: false })`. **Adapted.**
- **`@lumenize/rpc`'s own executor** (`packages/rpc/src/ocan.ts`). **Carried over unchanged.** It has no allowlist by design, since rpc calls anything on your own DO.

**How a browser reaches each hole — the ordinary API is enough, and none needs Workers RPC:**

```ts
lmz.call('GALAXY', scope, ctn<any>().svc.sql(['DELETE FROM Subscribers']));    // SQL, request leg
lmz.call('STAR', scope, ctn<Star>().transaction(ctn<any>().env.SECRET, e, o)); // read, nested
class Evil extends NebulaClient {                                               // response leg
  handleQuerySubscriberListUpdate() { throw Object.assign(new Error(), { name: 'ClientDisconnectedError', clientInstanceName: victim }); }
}
```

⚠️ **Not yet driven end to end.** Every link was read in source and the executor links were run, but nobody has driven the full path from a real browser session through the Gateway to a DO. The first phase does that as a `/live` scenario, and that scenario becomes the regression test.

## Design intent, constraints, and future state

**The rule, as Larry stated it (2026-09-23): a chain must open with a call — a `get` of a method followed immediately by its `apply` — and that method must be `@mesh`.** It applies to the top-level chain and to every nested marker. This one structural rule closes three holes at once:
- property reads (`env.SECRET`, `ctx.id`) are refused, because no call follows;
- `svc` chains from the wire are refused, because `svc` is not a `@mesh` method;
- get-only nested markers are refused under the same rule.

Legitimate chains still pass. `resources().transaction(…)` and `resources().orgTree.setPermission(…)` both open `get resources`, `apply`.

**The response leg gets its own fix, because its holes are not about chain shape.**
- The reaper takes the dead client's id from **the push's own target address, never from the reply body**. The caller always knows whom it pushed to.
- **A result substituted into a handler chain is never treated as a nested marker.**

**Whatever a `@mesh` gate returns decides how much of the DO is reachable**, since nothing after the first call is checked. That stays by design, and the rule every gate owes is written once in `mesh.md`: the returned object holds no path back to the DO, its `ctx`, `env` or `svc`. `DagTree` meets it today, since every field is `#`-private.

⚠️ **To decide here, before phases:**

1. **May a `@mesh` annotation on a getter or property open a chain, or only a method?** Methods only is simpler, and neither current gate opens with a property. There is also a mechanical wrinkle: the check reads `parent[methodName]`, which for a getter invokes it, so it would test the getter's return value rather than the getter. A getter entry would need the check to read the property descriptor instead.
2. **What the `svc` exemption exists for.** Its comment calls `svc` methods *"trusted internal framework methods"*. If `alarms`, `broadcast` or `fetch` execute stored continuations that open with `svc`, the fix must tell a local chain from one that came in off the wire, rather than delete the exemption.
3. **Whether the local handler run keeps `requireMeshDecorator: false`** once a result can no longer carry a marker.

**Constraints.** [ADR-003](../docs/adr/003-continuation-messaging.md) — continuations are the only call shape, so the fix must not break nesting or the fire-back. [ADR-007](../docs/adr/007-shared-node-security-core.md) — the guard core is shared, so this lands once in the package for every node type. `CLAUDE.md` — a package gap is fixed in the package, never worked around in Nebula. `security.md` governs the fail-closed behaviour.

**Future state.** The allowlist is the boundary the docs describe, and the probe table above flips to refused on every row that reaches something undecorated. `mesh.md` § *Object-capability access* and `continuations.mdx` state the rule and the gate's obligation in the same words.
