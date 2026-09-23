# A remote caller reaches more than `@mesh` marks

**Status:** Pass 1 — phases are NOT written. **Both legs have a chosen direction** (§ *The request leg* and § *The response leg*, 2026-09-23) and the file is written against them until we say otherwise. A response-leg allowlist was weighed and rejected, with the trigger to re-derive recorded (§ *R3*). The opening paragraphs above § *Relationships* await Larry's rewrite before review. Surfaced 2026-09-22/23 by `/review-task` Stage 2 of [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md). **These are pre-existing holes in `@lumenize/mesh`, not introduced by any Nebula task**, and they must close before the pre-alpha wipe invites the first outside users. A reviewer agent queued a task chip for this work; this file supersedes it.

**Objective — a remote caller reaches exactly what `@mesh` marks, and nothing it reads, calls or smuggles in gets past the allowlist without it.**

**Three goals, in the order they matter:**

1. **The request leg honours the boundary the docs state.** `website/docs/mesh/continuations.mdx` says *"The absence of `@mesh` is exactly what keeps it off the remote call surface — that is the security boundary."* Today the allowlist blocks one thing — an undecorated method as a chain's first call. Reads, `svc` calls and nested get-only markers all pass, so a tenant who self-signs-up can read the host's `env` and run arbitrary SQL on its parent Galaxy.
2. **The subscriber cannot drive the response leg.** When a DO pushes to a client with a 4-arg call, the client writes the reply. The reaper takes its victim's id from that reply, and a marker-shaped reply runs a chain of the client's choosing on the pushing node with the allowlist off.
3. **The boundary is written once, where a reader looks for it, and matches the code.** Today the docs promise more than the executor enforces.

## Relationships

- **Gates [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md).** Its Phase 7 claims to close the reaper hole by shedding `@mesh()`, and the hole is in the reply path. Its three-tier contract also assumes `@mesh()` entries are the whole wire surface. That task re-runs its Stage 2 after this one lands.
- **Must land before the pre-alpha wipe** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*).

## Context and current state

**What the allowlist does, measured.** Probes ran the real `executeOperationChain` (`packages/mesh/src/ocan/execute.ts`) against stand-in objects holding one of each kind of member, in Node 24 and in workerd `2026-08-15` (2026-09-23):

| Chain | Leg | Result |
|---|---|---|
| call a `@mesh` method | request | allowed |
| call an undecorated method | request | **refused** — `Method 'plain' is not mesh-callable` |
| call a `@mesh` method whose guard refuses | request | **refused** by the guard |
| read `env.SECRET`, no call | request | **allowed → `the-secret`** |
| read `ctx.id`, no call | request | allowed |
| call `ctx.storage.deleteAll()` | request | refused |
| call `svc.sql(['DELETE FROM x'])` | request | **allowed — the SQL ran** |
| open `svc.<plugin>`, walk to the node, call an undecorated method | request | **allowed — the method ran** |
| after a `@mesh` gate, walk back to an undecorated method | request | allowed, if the gate's return value holds a reference back |
| after a gate, walk `constructor` to `Object` and write to `Object.prototype` | request | **allowed in workerd — the write persisted in the isolate** |
| after a gate, walk `constructor` to `Function` | request | allowed in V8, so in a browser client; refused in workerd (`EvalError`) |
| nested get-only marker as an argument | request | **allowed — the argument received the secret** |
| nested `svc` chain as an argument | request | **allowed — the SQL ran** |
| nested undecorated call as an argument | request | refused |
| call an undecorated method | response | allowed |
| call a guarded `@mesh` method | response | **allowed, guard skipped** |
| a marker-shaped result substituted into a handler's arguments | response | **allowed — an undecorated method on the node ran, and the handler got that chain's return value instead of the result** |
| round-trip an `Error` whose `name` is a registered class | either | **arrives as a real instance of that class, own properties intact** |

**So the allowlist blocks one thing: an undecorated method as the first call in a chain.** The check fires at the first `apply` and latches. That gives these ways through:
- a chain with no call never reaches the check;
- a chain opening `get 'svc'` is exempt (`isServiceCall`), and past `svc` lies the whole node;
- nothing after the first call is checked, which is deliberate and is what makes the gate pattern work — but it also admits `constructor` and `__proto__`;
- the response leg runs at `requireMeshDecorator: false`.

**How it got this way — checking the first CALL was the intended design, not a slip.** The check arrived in `a4f9443` (2026-02-09) already shaped as *"check @mesh decorator on entry point method (first apply operation)"*, with the `svc` exemption from the start. `meshFn` in `mesh-decorator.ts` settles the intent: it exists to mark a function sitting in a plain object, and its own test calls `c.nested.deep.method(5)` — a path of `get`s ending at a marked function. So the model protected calls wherever they sat, and reads were never in view. `@lumenize/rpc` keeps its own executor (`packages/rpc/src/ocan.ts`) with no allowlist at all, which is right for a tool that calls anything on your own DO. Mesh forked that executor and added the allowlist.

**Four things the probes found that the table above does not show:**

- **`svc` exposes the whole node, not only SQL.** `NadisPlugin` declares `doInstance`, `ctx` and `svc` as `protected`, which TypeScript enforces and the runtime does not. `Fetch` extends `NadisPlugin`, so any DO importing `@lumenize/fetch` can be walked through `svc.fetch` to an undecorated method, to `ctx.storage`, or to `env`. `Alarms` keeps its fields `#`-private and leaks nothing this way.
- **The exemption exists for one chain that crosses a hop.** The FetchExecutor Worker delivers its result with `svc.fetch.__handleProxyFetchResult(reqId, result)` (`fetch-executor-entrypoint.ts`). That method's optional third argument is a stringified continuation, which it parses and runs at `requireMeshDecorator: false`. A pending `reqId` — a random UUID — is all that stands in front of it.
- **Only `callChain[0]` is trustworthy, so neither obvious replacement for the exemption works.** The Gateway stamps `callChain[0]` and copies `callChain[1+]` from the client's own message (`lumenize-client-gateway.ts`), so "the caller is a Worker" is forgeable. And the fetch callback inherits a client's `callChain[0]` whenever `proxy()` fired during a client call, since nothing starts a fresh chain — so "the origin is not a client" refuses real callbacks.
- **A write to `Object.prototype` reaches authorization.** `hasDominionOver` (`packages/nebula-auth/src/parse-id.ts`) tests `access?.scopeAdmin`, and `buildNebulaAccessEntry` leaves that key **absent** on a non-admin token — so an inherited key answers the test. In a browser client the same walk reaches `Function`, which workerd refuses and V8 does not.

**The parts implicated:**

- **The entry-point check** in `executeOperationChain`, and **`findParentObject`**, which re-runs earlier calls (§ *Gotchas*, item 6).
- **The `isServiceCall` exemption.** Its comment calls `svc` methods *"trusted internal framework methods"*.
- **`resolveNestedOperations`**, which executes any argument shaped like `{ __isNestedOperation: true, __operationChain }` against the DO. `processArgumentsForNesting` in `ocan/proxy-factory.ts` builds these from ordinary `ctn()` calls.
- **`@mesh()` and `meshFn`** in `mesh-decorator.ts`.
- **`NadisPlugin`'s fields**, and **`Fetch.__handleProxyFetchResult`** with its continuation argument.
- **The Gateway's `#handleIncomingCallResponse`**, which takes a client's `success: false` error without checking it.
- **The local handler run in `lmz-api.ts`** — `executeOperationChain(filled, nodeInstance, { requireMeshDecorator: false })`.

**How a browser reaches the first holes — the ordinary API is enough, and none needs Workers RPC:**

```ts
lmz.call('GALAXY', scope, ctn<any>().svc.sql(['DELETE FROM Subscribers']));    // SQL, request leg
lmz.call('STAR', scope, ctn<Star>().transaction(ctn<any>().env.SECRET, e, o)); // read, nested
class Evil extends NebulaClient {                                               // response leg
  handleQuerySubscriberListUpdate() { throw Object.assign(new Error(), { name: 'ClientDisconnectedError', clientInstanceName: victim }); }
}
```

⚠️ **Not yet driven end to end.** Every link was read in source and the executor links were run, but nobody has driven the full path from a real browser session through the Gateway to a DO. The first phase does that for each hole before anything is fixed.

The rest of this file gives the request-leg design, the response-leg design, the gotchas any fix must handle, and the criteria the phases carry.

## The request leg — `@mesh` marks any member, and the first op must name one

**The rule: the first op of every chain that arrives off the wire names a member the host class marked `@mesh()`.** The member may be a method, a getter, an `accessor`, or a field. That op is where the `@mesh(guard)` guard runs, as it does at a gate method today. Everything after that first op runs unchecked on whatever the member yields, exactly as today after a gate method. A field entry and a method gate side by side:

```ts
class Galaxy extends LumenizeDO<Env> {
  // A field entry: the object IS the facade, and the declaration is the whole of it.
  // Arrow functions in a field initializer bind `this`, so they reach `this.#anything`.
  @mesh(requireAdmin) admin = {
    addUser: (user: User) => { /* … */ },
    removeUser: (user: User) => { /* … */ },
  };

  // A method gate, unchanged: code runs at the entry, so it can pick what to hand back.
  @mesh() resources() { return this.#dataPlane; }
}

ctn<Galaxy>().admin.addUser(u);            // passes — `admin` is marked, requireAdmin runs
ctn<Galaxy>().resources().invite(n, who);  // passes — `resources` is marked
ctn<Galaxy>().env.SECRET;                  // refused — `env` is not marked
ctn<Galaxy>().svc.sql(['SELECT 1']);       // refused — `svc` is not marked, and nothing exempts it
```

**Why any member rather than only methods.** Methods-only was the alternative, and it is this rule with one member kind. Under it the field above becomes a `#admin` field plus a one-line gate method that returns it, and every call site gains a `()`. Marking any member costs a decorator overload per kind plus a name registry for fields — small, and no new subsystem — so `workflow.md` § *Evaluating alternatives* prefers it: YAGNI gates capability, never generality. Methods-only forecloses nothing either, which is why this is reversible if the cost turns out higher than measured.

**Feasibility is measured, not assumed (2026-09-23).** One probe class carrying a marked method, getter, `accessor` and field was compiled through every decorator transform this repo uses — SWC 1.15.30 at `2022-03` and `2023-11`, esbuild 0.27.3, esbuild 0.28.1 (the one inside `apps/nebula`'s wrangler 4.124), and tsc 5.9.3 — then run in Node 24 and in workerd `2026-08-15`. All four member kinds reached the decorator with a working `addInitializer` on all five transforms and both runtimes, a subclass's marked field resolved, and `tsc --strict` accepted one `@mesh()` signature across all four kinds. ⚠️ **`Symbol.metadata` is `undefined` in both runtimes**, so the marks cannot ride `context.metadata`.

**Six things come with the rule:**

1. **The lookup reads descriptors and never reads the member.** It walks the prototypes with `Object.getOwnPropertyDescriptor` rather than evaluating `parent[key]`, so an unmarked getter is refused without running. Methods, getters and accessors carry the mark on their function, as methods do today; a field decorator never sees a value, so it registers its name through `addInitializer` against the class.
2. **After the entry, a `get` that resolves on `Object.prototype` or `Function.prototype` is refused.** That is what stops `constructor`, `__proto__` and `call` without naming them — a closed structural rule rather than a deny-list that the next sensitive member is missing from (`calibration.md` §2).
3. **After the entry, a step whose value IS the node, its `ctx`, its `env` or its `svc` is refused.** Those four roots are a closed set, so this catches a back-reference by any path, however a gate's return value happens to reach one. It is the enforcement behind § *Gotchas*, item 5, which today rests on `DagTree` choosing `#`-private fields.
   ⚠️ **Items 2 and 3 are WALK rules, not allowlist checks, so they MUST NOT be gated on `requireMeshDecorator`.** They run on every leg and every flag setting — request, fire-back, local handler, alarm — because what they refuse is never legitimate, whoever authored the chain. Only the entry check in item 1 is what the flag turns off. Writing them inside the flag's branch is the plausible mistake, and it is what would leave the response leg reachable to `Object.prototype` — § *R3* rejects a response-leg allowlist partly on these two being unconditional, so gating them silently withdraws that argument.
4. **The `svc` exemption is deleted rather than scoped.** `@lumenize/fetch` gets a marked entry whose capability is the pending `reqId`, and loses the caller-supplied continuation argument. Scoping the exemption to local chains was the alternative, and it fails on the `callChain` evidence in § *Context and current state*: "the caller is a Worker" is forgeable and "the origin is not a client" refuses real callbacks.
5. **`NadisPlugin`'s `doInstance`, `ctx` and `svc` become `#`-private.** `protected` is a compile-time claim, and every plugin inherits the runtime one. This is defence in depth behind items 3 and 4, not a substitute for either.
6. **`meshFn` is deleted.** It marks a function reached through a path of `get`s, which is exactly what the rule refuses. Its only uses are two tests, whose equivalent is to mark the object at the entry instead.

**Still open under this rule, and the phases decide it:** whether nested markers in arguments are checked by the same rule or refused outright when the chain came off the wire. Both close the get-only marker; they differ on whether a client keeps `c().combine(c().getData(), …)`. § *Gotchas*, item 1 constrains either one — the check must run after `$result` substitution.

## The response leg — two holes, one defect

**Both are the same mistake: the node treats a value the far side authored as if the framework had authored it.** One is a marker, the other an identity. Each gets its own fix, and neither fix depends on the other.

### R1 — a substituted result is re-scanned as a nested marker

**What happens.** `replaceNestedOperationMarkers` substitutes the result into the handler's arguments, and then `executeOperationChain` calls `resolveNestedOperations` over those same arguments. `isNestedOperationMarker` tests only `typeof obj === 'object' && obj.__isNestedOperation === true` — it does not check the prototype, and structured clone carries own properties across, which is how `clientInstanceName` rides an Error today. So a result carrying those two properties is re-read as a marker and its chain is executed.

Measured 2026-09-23 against the real executor, with a handler chain of `handler(ctn().$result)` and a result carrying `__operationChain`:

```
["undecoratedInternal RAN", "handler got string"]
```

⚠️ **This is not a guarded method with its guard skipped — it is any chain at all, on the node, at `requireMeshDecorator: false`.** The second entry matters too: the handler then received that chain's return value rather than the result, so the substitution is silently displaced.

**The fix: resolve once.** `replaceNestedOperationMarkers` already knows which argument positions it filled, so it says so and `resolveNestedOperations` skips them. Said structurally: **the marker shape is a property of a CHAIN, which `processArgumentsForNesting` builds; a result is data and can never be one.** Nothing weighs against this, it costs no capability, and the request-leg work rewrites that loop anyway.

### R2 — a client's reply can pass for a delivery failure

**What happens, in order.** A Galaxy fans a query update to its subscribers, one 4-arg `lmz.call` per target, every target sharing one `onResult` chain that carries the `queryHash` and nothing identifying the target. The Gateway for one client computes `clientInstanceName` from `envelope.metadata.callee.instanceName`, which is the address the caller used and is authoritative. On a genuine delivery failure it returns `{ $error: preprocess(new ClientDisconnectedError(msg, clientInstanceName)) }` — five sites do this and all are correct. Otherwise it forwards to the client and awaits the reply. **If the client's handler throws, `#handleIncomingCallResponse` runs `postprocess(error)` and rejects with the result, and the `catch` re-wraps it in the identical `{ $error }` shape.** `postprocess` constructs by class name, so a reply naming `ClientDisconnectedError` arrives as a real instance carrying whatever `clientInstanceName` the client set. `onQueryBroadcastResult` tests `result.name`, reads that property, and deletes the named row.

**So `$error` carries two meanings — "delivery failed, and the framework says who" and "the callee ran and threw" — and the reaper acts on the first while reading the second.**

**The risk is one unsubscription, and it needs hand-written client code.** No disclosure, no authority change, nothing persisted: the DELETE is exact-match on `(queryHash, clientId)`, so one subscriber row goes, and the victim's UI silently goes stale until they reload, since they are still connected and never learn. Attacker and victim are members of the same Star.

⚠️ **What lifts this above theoretical is that the victim's clientId is handed to the attacker.** A clientId is `${sub}.${tabId}` with 8 hex characters of randomness, and the roster pushed to watchers deliberately carries `{ sub, profileId }` only. But `#forwardToClient` forwards `callContext.callChain` verbatim, and a broadcast inherits the writer's chain, so `callChain[0].instanceName` is the full clientId of whoever's mutation triggered the push. The line beside it withholds `originRequest` for exactly this reason; the clientId was not withheld.

**The fix: split the ack shape, so a delivery failure is something only the Gateway can assert.** The Gateway's return value is the right carrier — it builds it on every path, and the client neither sees nor writes it.

```ts
// Gateway, at the five delivery-failure sites, which already compute the authoritative name
return { $undeliverable: { instanceName: clientInstanceName, reason: 'Client is not connected' } };

// Gateway, on the client's reply — unchanged in shape, and now honest: the callee ran and threw
return { $error: preprocess(error) };

// Caller (`lmz-api.ts`) — mint the error LOCALLY from the field only the Gateway can set
if ('$undeliverable' in ack) {
  errorObj = new ClientDisconnectedError(ack.$undeliverable.reason, ack.$undeliverable.instanceName);
}
```

**Four things follow:**

1. **The handler signature does not change**, so no per-target handler chains and no framework-wide protocol change. Binding the target into each handler was the alternative, and this is smaller.
2. **`clientInstanceName` is minted by the caller's own code** and never carried from the far side. A client may still throw something calling itself `ClientDisconnectedError`; it arrives as `$error` and the node never mints the class for it.
3. **`instanceof` becomes meaningful again**, since only a wire-borne value defeats it, so the reaper can stop matching on a name string.
4. **The Gateway gets simpler.** One shape stops carrying two meanings, which is the whole defect — this removes an overload rather than adding a check.

**What R2 leaves to settle:**

- **A refusal by `onBeforeCallToClient` is not a delivery failure.** The client is connected and fine, so reaping it would be wrong; it stays `$error`. Worth pinning, because the site sits beside the five that change.
- **The tier path** must carry `$undeliverable` through `__forwardBroadcastResult` if the tier is ever unpinned (§ *Gotchas*, item 3).
- **Whether `ClientDisconnectedError` still needs to be a wire-constructible global.** `#rejectReconnectWaiters` uses it internally, so check before removing the registration.
- **Whether a clientId belongs in a forwarded `callChain` at all**, given the roster withholds it on purpose. Separate from this fix and tracked on its own.

### R3 — a response-leg allowlist, considered and NOT built

**A second decorator marking which methods may be a fire-back target was weighed and rejected.** It would have closed the R1 attack too — `resolveNestedOperations` passes its config to the nested chain, so an injected chain's entry would be checked — which is what makes the comparison worth recording rather than just the verdict.

**R1 is strictly stronger on the attack they share.** R1 stops a value becoming a chain at all, so the only chain that runs is the one the node authored. A decorator leaves the injection working and merely narrows where it lands: an attacker would still reach any marked method with arguments of their choosing. `Galaxy.onQueryBroadcastResult(queryHash, result)` would carry the mark, so a forged result could name it with a different `queryHash` and reap a subscriber of a query the attacker never subscribed to — worse than R2's hole. Deleting the class beats narrowing it (`calibration.md` §2), and adding both is the second guard that entry warns about.

**What the decorator would uniquely cover is a future regression, and two things already cover most of it.** No attacker-controlled chain reaches the response leg today: the local handler is the node's own, `__handleResponse` takes its chain from a `response` descriptor the Gateway builds from the verified attachment, and `Fetch.__handleProxyFetchResult`'s continuation argument and a stored `svc.alarms.schedule` chain both close with `svc`. Beyond that, § *The request leg*, items 2 and 3 are unconditional, so even a hostile chain arriving here could not reach `Object.prototype`, `Function` or the node's own roots — it could only call an undecorated method.

**The cost is paid by the people we promise no foot-guns.** A handler missing the mark throws in the detached post-ack task, and a fire-back envelope carries no `response` descriptor, so `fireResponse` takes its `!response` branch and logs *"post-ack chain threw with no handler to receive the error"*. The handler silently never ran, and a log line is the only evidence. Nebula's user-developers write `NebulaClient` subclasses full of handlers, so that failure would be theirs to hit.

⚠️ **The trigger to re-derive, which is what this entry exists to carry: if any node type ever lets a CALLER choose a fire-back return address, the response leg needs its own allowlist and the design above is it.** Today's safety rests on the Gateway building that descriptor itself, and `calibration.md` §4 says a justification that can expire is re-derived when it does, never pre-guarded now. ADR-003 rules out the stateless alternatives — the handler must travel, so a node cannot verify it authored a chain without holding state, which is why a decorator would be the answer and nothing cheaper is.

## Gotchas any fix must handle

These are the places the framework's own services travel the paths being closed. They apply to both legs.

1. **`$result` is itself a get-only nested marker.** `ctn().handler(ctn().$result)` puts a marker in the handler's arguments, and `replaceNestedOperationMarkers` in `execute.ts` swaps **every** marker in a handler chain for the result before the chain runs (`if (isNestedOperationMarker(arg)) return resultValue`). So any alternative that refuses get-only markers, or requires every nested marker to open with a `@mesh` call, must apply **after** that substitution — otherwise every 4-arg handler, alarm and `svc.fetch` continuation using `$result` breaks. Note too that the substitution replaces every marker, not only `$result`, so a handler that nests a real sub-continuation has it overwritten today.
2. **Alarms run stored continuations with the allowlist OFF** — `executor(parse(row.operationChain), { requireMeshDecorator: false })` in `alarms.ts`. A fix keyed on that flag leaves alarms alone. A structural rule applied regardless of the flag also hits alarm handlers, which are undecorated local handlers by design. ⚠️ **Unchecked, and it matters most:** whether the `svc` hole reaches `svc.alarms.schedule` in a way that persists a caller-chosen chain, which would then run later with the allowlist off — turning the `svc` hole into delayed execution with no guard at all. ⓘ The answer changes the red-first evidence, not the design: `svc` stops being an entry either way (§ *The request leg*, item 4).
3. **`svc.broadcast`'s tier path forwards the reaper as a plain request.** `__forwardBroadcastResult` re-fires the handler 3-arg through `__executeOperation`, where the allowlist is on, so a request-leg rule that refuses undecorated entries refuses the forwarded reaper too. The tier is pinned off (`directThreshold: Infinity`) and already misroutes failures to the mutating client, so a choice either keeps that forward reachable or leaves the tier pinned and says so.
4. **Exactly one `svc`-opening chain crosses a hop, and it is `@lumenize/fetch`'s callback.** `svc.fetch.__handleProxyFetchResult(reqId, result)` is the only one the probes found; `alarms` and `broadcast` build their `svc` chains locally. So deleting the exemption costs one marked entry on `Fetch`, and § *The request leg*, item 4 takes that route because the alternative — scoping the exemption to local chains — has no trustworthy signal to key on.
5. **What a `@mesh` gate may return.** Nothing after the first op is checked, so a gate whose return value holds a path back to the node, its `ctx`, `env` or `svc` exposes all of it. § *The request leg*, item 3 refuses those four roots structurally, which turns `DagTree`'s `#`-private fields from the only defence into defence in depth. The obligation still needs a home in `mesh.md`.
6. **The executor runs every earlier call again, and an `async` gate breaks.** To find the object a method is called on, `findParentObject` in `execute.ts` starts over from the DO and re-runs every earlier op, synchronously and without awaiting. Measured 2026-09-23 against the real executor:
   - `gate().invite('ann')` ran the guard once and the gate body **twice**.
   - The second run got the raw arguments, so a nested marker arrived as an unresolved `{ __isNestedOperation: true, … }` object instead of its value.
   - An `async` gate threw `parent[methodName] is not a function`, because the re-run's parent is a Promise.

   No gate has hit this yet, since `resources()` and `dagTree()` are synchronous and have no side effects. **The fix: carry the parent forward while walking**, so each call runs once and is awaited. The allowlist fix rewrites this loop anyway, so it lands there.
7. **Refusing `Object.prototype` is narrower than refusing all inherited members, and the difference is what keeps chains working.** `Array.prototype.map`, `Map.prototype.get` and the `RequestSync`/`ResponseSync` methods all resolve on their own prototypes, so they still pass. What stops working is a chain calling `hasOwnProperty`, `toString` or `valueOf` on a returned value, and a `Function.prototype` member such as `call` or `bind`. Nothing in the repo does either, which the first phase confirms by running the suites rather than by grep.

## Criteria to carry into the phases

**The first phase proves every hole before anything is fixed.** For each hole it writes a test asserting the secure behaviour, runs it against today's code, and records that it FAILS. A test never seen red cannot show that a fix closed anything (`testing.md`). Here the red run also answers what § *Context and current state* leaves open — whether each hole is reachable from a real browser, not only from the executor. No fix lands in that phase.

- **Tier.** Each hole gets a `/live` limb, because reachability through the Gateway is exactly what is unverified, and `live.md` makes `/live` the default tier. The probe table's executor behaviour also gets a unit test, since `executeOperationChain` run against a stand-in object needs no running system — and the test says so.
- **Prove each hole with a harmless payload.** `svc.sql(['SELECT 1'])` proves arbitrary SQL runs as well as a `DELETE` would. A skipped guard is proven by a test-only guarded method that records it ran, never by `teardown`. So a red run cannot destroy state, which matters because the harness can target a deployed worker through `HARNESS_TARGET_URL`.
- **One limb per hole, each with a mutation that isolates it, matched on the refusal MESSAGE.** A scenario reddens on its first failing limb and hides every later one (`live.md`).

| Hole | The test asserts | Red today because |
|---|---|---|
| read `env.<name>` with no call | refused | a chain with no call is never checked |
| the same read, as a nested argument | refused | a get-only marker is never checked |
| `svc.sql(['SELECT 1'])` | refused | `svc` is exempt |
| a nested `svc` chain as an argument | refused | the exemption applies per chain |
| `svc.fetch` walked to an undecorated method on the node | refused | `NadisPlugin`'s fields are `protected`, not `#`-private |
| after a gate, a write to `Object.prototype` via `constructor` | refused, **and** `({}).<key>` is still `undefined` | nothing after the first call is checked |
| after a gate, `constructor` reached from a returned string | refused | same, and in a browser client this reaches `Function` |
| after a gate, a step back to the node, `ctx`, `env` or `svc` | refused | same |
| a reply naming `ClientDisconnectedError` and another client | that client's row is intact | `$error` carries both meanings, so the reaper reads the reply |
| a marker-shaped reply, with a chain naming a method that records it ran | that method did NOT run, **and** the handler received the reply itself | the substituted result is re-scanned by `resolveNestedOperations` |
| a genuine disconnect, same push | the disconnected client's row IS dropped | it passes today, and must keep passing |
| `svc.alarms.schedule` with a caller-chosen chain | refused | unknown until checked (§ *Gotchas*, item 2) |

- **The walk rules get a limb on the RESPONSE leg, not only the request leg.** A chain run at `requireMeshDecorator: false` must still be refused at `Object.prototype` and at a step back to the node's roots. This is the one criterion that fails if items 2 and 3 are written inside the flag's branch, and § *R3* rejects a response-leg allowlist partly on their being unconditional — so without it, that rejection has no test holding it up.
- **The reaper's two limbs must BOTH run, and the positive one is what catches an over-broad fix.** A fix that stops reaping entirely satisfies the forged limb and breaks the cleanup the reaper exists for, which is why the genuine-disconnect row sits in the table above rather than among the regression guards.
- **The re-run bug gets its own red-first test:** a gate that counts its calls runs **once** per chain, an `async` gate's chain completes, and a gate given a nested marker receives the resolved value on its only run. It is a pure executor property, so a unit test against a stand-in object is the right tier, and the test says so.
- **The prototype-write limb asserts the SIDE EFFECT, not the refusal alone.** A refused chain that still wrote before it threw is a pass by message and a failure in fact, so the limb reads `({}).<key>` afterwards and requires `undefined`. It uses a key nothing reads — never `scopeAdmin` — so a red run cannot grant anyone dominion.
- **Every `@mesh` member kind gets a limb that PASSES**, not only a refusal: a marked method, getter, `accessor` and field each reach their target, and a field entry's guard runs. A rule that refuses everything satisfies every refusal limb in the table above, and these are what catch it.
- **The whole-suite run IS a criterion, not a cleanup step.** `npm run test:code` plus a `drive.ts all` sweep is what shows the `Object.prototype` rule and the deleted `svc` exemption broke no existing chain (§ *Gotchas*, items 4 and 7). `live.md` requires the sweep after changing anything other scenarios depend on, and every scenario depends on this executor.
- **Regression guards for what must keep working, green before and after:** a 4-arg handler using `$result`, a stored alarm continuation firing, `svc.broadcast`'s flat branch reaping a disconnected subscriber, `@lumenize/fetch`'s round trip through its new marked entry, and a legitimate gate chain such as today's `dagTree().setPermission(…)`. They catch a fix that closes a hole by breaking a service, which is exactly the risk § *Gotchas* names.
- **They stay committed** as the regression suite once the fix turns them green.

## Constraints and future state

**Constraints.** [ADR-003](../docs/adr/003-continuation-messaging.md) — continuations are the only call shape, so a fix must not break nesting between mesh nodes or the fire-back. [ADR-007](../docs/adr/007-shared-node-security-core.md) — the guard core is shared, so the fix lands once in the package for every node type. `CLAUDE.md` — a package gap is fixed in the package, never worked around in Nebula. `security.md` governs the fail-closed behaviour.

**Future state.** Every row of the probe table that reaches something unmarked turns refused. `@mesh()` marks a method, getter, `accessor` or field, and the docs that describe it as a method decorator — `mesh-api.mdx`, `security.mdx`, `index.mdx`, `managing-context.mdx`'s `requireMeshDecorator` row — say so. `mesh.md` § *Object-capability access* and `continuations.mdx` state the boundary as the code enforces it, including what a gate may hand back.
