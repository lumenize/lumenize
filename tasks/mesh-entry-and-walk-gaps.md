# A remote caller reaches more than `@mesh` marks

**Status:** Pass 2 — **design intent is COMPLETE, every decision is settled (§ *What needs Larry*), and the ten phases are written.** `/review-task` Stage 1 ran twice and Stage 2 twice — the second time against the phases, which is the pass that can see decomposition, ordering and criteria that cannot fail. **Both legs carry a settled design** (§ *The request leg* and § *The response leg*), reworked through a `/review-task` Stage 1 re-run on 2026-09-24. A response-leg member-level check was weighed and rejected, with the trigger to re-derive recorded (§ *R3*). Surfaced 2026-09-22/23 by `/review-task` Stage 2 of [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md). **These are pre-existing holes in `@lumenize/mesh`, not introduced by any Nebula task.** The urgency is not the wipe's ordering — that file notes there is exactly one deploy, so ordering by it means little — it is that `continuations.mdx` publishes the boundary promise TODAY, and the wipe is what invites the first readers who will rely on it. A reviewer agent queued a task chip for this work; this file supersedes it.

**Objective — a remote caller reaches exactly what `@mesh` marks and nothing else.**

**The primary goal is to close a currently open vulnerability** where properties at the root of an instance are accessible and methods within objects at the root are callable. The current approach only requires that the first call in an OCAN chain be decorated with `@mesh` but says nothing about properties and objects. `svc` calls and nested get-only markers all pass, so a tenant who self-signs-up can read the host's `env` or run arbitrary SQL on its parent Galaxy. **The same reach is available on the response leg**, where a reply the far side authored is re-read as a chain and run with the member-level check off — a different mechanism at the same severity, so it belongs in this goal rather than the one below. **What must be true when this is done:** a remote caller reaches the members `@mesh` marks, and from there only what the marked member hands back — plus the two doors JavaScript opens on every object, `constructor` and `__proto__`, which are closed for them. ⚠️ **It does NOT mean the framework stops an author handing back `this` or `this.ctx`**; that is the author's business and the docs recommend against it (§ *The request leg*).

**The far less important secondary goal is to prevent a Client node running in a bad actor's environment from being able to unsubscribe anyone who called it or whose action resulted in a subscription push** to the bad actor. When a DO pushes to a client with a 4-arg call, the client writes the reply, and the reaper takes its victim's id from that reply. ⚠️ The same reap needs no reply at all — a reaper carries a bare `@mesh()`, so a member calls it directly with a forged error as an ordinary argument.

## Relationships

- **Gates [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md).** Its Phase 7 claims to close the reaper hole by shedding `@mesh()`. That shed refuses the direct request-leg call and nothing on the reply path, so it was never the whole fix — and after § *R2* it carries no security at all, since the forgeable field is gone. Good hygiene, not the guard. Its three-tier contract also assumes `@mesh()` entries are the whole wire surface. That task re-runs its Stage 2 after this one lands.
- **Gates ④ in the milestone** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*), where it now has its own row, `deploy`-gated and ordered above it. That file's decision 3 says so too, so the two no longer disagree about whether ④ can start.

## Context and current state

**What the member-level check does, measured.** Probes ran the real `executeOperationChain` (`packages/mesh/src/ocan/execute.ts`) against stand-in objects holding one of each kind of member, in Node 24 and in workerd `2026-08-15` (2026-09-23):

**Bold marks an outcome we do not want** — every bold row is something the fix has to turn around, and every plain row is behaviour to preserve.

| Chain | Leg | Result |
|---|---|---|
| call a `@mesh` method | request | allowed |
| call an undecorated method | request | refused — `Method 'plain' is not mesh-callable` |
| call a `@mesh` method whose guard refuses | request | refused by the guard |
| read `env.SECRET`, no call | request | **allowed → `the-secret`** |
| read `ctx.id`, no call | request | **allowed** |
| call `ctx.storage.deleteAll()` | request | refused |
| call `svc.sql(['DELETE FROM x'])` | request | **allowed — the SQL ran** |
| open `svc.<plugin>`, walk to the node, call an undecorated method | request | **allowed — the method ran** |
| after a `@mesh` gate, walk back to an undecorated method | request | allowed if the gate's return value holds a reference back — **and it stays allowed**: what a gate hands back is the author's business (§ *The request leg*) |
| after a gate, walk `constructor` to `Object` and write to `Object.prototype` | request | **allowed in workerd — the write persisted in the isolate** |
| after a gate, walk `constructor` to `Function` | request | **allowed in V8, so in a browser client**; refused in workerd (`EvalError`) |
| nested get-only marker as an argument | request | **allowed — the argument received the secret** |
| nested `svc` chain as an argument | request | **allowed — the SQL ran** |
| nested undecorated call as an argument | request | refused |
| call an undecorated method | response | allowed — **and it stays allowed**: a response-leg chain is one the node itself authored, and the sibling's `resourcesResults` gate depends on exactly this (§ *R3*) |
| call a guarded `@mesh` method | response | allowed, guard skipped — **and it stays allowed**: `getMeshGuard` runs inside the same block as the member check, so the flag turns off both together, which ADR-007 sanctions (§ *R3*) |
| a marker-shaped result substituted into a handler's arguments | response | **allowed — an undecorated method on the node ran, and the handler got that chain's return value instead of the result** |
| round-trip an `Error` whose `name` is a registered class | either | arrives as a real instance of that class, own properties intact — [ADR-002](../docs/adr/002-structured-clone-everywhere.md) behaviour we keep, and the reason `instanceof` proves nothing about a wire-borne value |

**So the member-level check catches one thing: an undecorated method as the first call in a chain.** The check fires at the first `apply` and latches. That gives these ways through:
- a chain with no call never reaches the check;
- a chain opening `get 'svc'` is exempt (`isServiceCall`), and past `svc` lies the whole node;
- nothing after the first call is checked, which is deliberate and is what makes the gate pattern work — but it also admits `constructor` and `__proto__`;
- the response leg runs at `requireMeshDecorator: false`.

**How it got this way — checking the first CALL was the intended design, not a slip.** The check arrived in `a4f9443` (2026-02-09) already shaped as *"check @mesh decorator on entry point method (first apply operation)"*, with the `svc` exemption from the start. `meshFn` in `mesh-decorator.ts` settles the intent: it exists to mark a function sitting in a plain object, and its own test calls `c.nested.deep.method(5)` — a path of `get`s ending at a marked function. So the model protected calls wherever they sat, and reads were never in view. `@lumenize/rpc` keeps its own executor (`packages/rpc/src/ocan.ts`) with no member-level check at all, which is right for a tool that calls anything on your own DO. Mesh forked that executor and added the member-level check.

⚠️ **The docs promised the stronger boundary all along, which is what makes this a divergence rather than a redesign.** `website/docs/mesh/continuations.mdx` states it as *"The absence of `@mesh` is exactly what keeps it off the remote call surface — that is the security boundary."* A user-developer reading that would leave a method undecorated and believe the omission protected it. So the gap is between what we told people and what the executor does, which is why it blocks the wipe instead of waiting for a release that can afford a behaviour change.

**Four things the probes found that the table above does not show:**

- **`svc` exposes the whole node, not only SQL.** `NadisPlugin` declares `doInstance`, `ctx` and `svc` as `protected`, which TypeScript enforces and the runtime does not. `Fetch` extends `NadisPlugin`, so any DO importing `@lumenize/fetch` can be walked through `svc.fetch` to an undecorated method, to `ctx.storage`, or to `env`. `Alarms` keeps its fields `#`-private and leaks nothing this way.
- **The exemption exists for one chain that crosses a hop.** The FetchExecutor Worker delivers its result with `svc.fetch.__handleProxyFetchResult(reqId, result)` (`fetch-executor-entrypoint.ts`). That method's optional third argument is a stringified continuation, which it parses and runs at `requireMeshDecorator: false`. A pending `reqId` — a random UUID — is all that stands in front of it.
- **Only `callChain[0]` is trustworthy, so neither obvious replacement for the exemption works.** The Gateway stamps `callChain[0]` and copies `callChain[1+]` from the client's own message (`lumenize-client-gateway.ts`), so "the caller is a Worker" is forgeable. And the fetch callback inherits a client's `callChain[0]` whenever `proxy()` fired during a client call, since nothing starts a fresh chain — so "the origin is not a client" refuses real callbacks.
- **A write to `Object.prototype` reaches authorization.** `hasDominionOver` (`packages/nebula-auth/src/parse-id.ts`) tests `access?.scopeAdmin`, and `buildNebulaAccessEntry` leaves that key **absent** on a non-admin token — so an inherited key answers the test. In a browser client the same walk reaches `Function`, which workerd refuses and V8 does not.

**The parts implicated:**

- **The entry-point check** in `executeOperationChain`, and the way it found the object a method hangs off — `findParentObject`, which re-ran earlier calls (§ *Gotchas*, item 6; **deleted in Phase 2**, which carries the parent along the walk instead).
- **The `isServiceCall` exemption.** Its comment calls `svc` methods *"trusted internal framework methods"*.
- **`resolveNestedOperations`**, which executes any argument shaped like `{ __isNestedOperation: true, __operationChain }` against the DO. `processArgumentsForNesting` in `ocan/proxy-factory.ts` builds these from ordinary `ctn()` calls.
- **`@mesh()` and `meshFn`** in `mesh-decorator.ts`, and **`Unprotected<T>`** in `ocan/types.ts` — a published export whose only purpose is to type a remote chain opening on `ctx`.
- **`Fetch.__handleProxyFetchResult`** with its continuation argument.
- **The Gateway's expired-token branch** in `__executeOperation`, which returns the same class as a genuine disconnect.
- ⓘ **Two parts an earlier draft listed and this design does NOT touch:** `NadisPlugin`'s `protected` fields, which stop mattering once `svc` is not an entry; and the Gateway's `#handleIncomingCallResponse`, which keeps passing a client's error through unchanged, because § *The response leg* fixes who the reaper believes rather than what the Gateway forwards.
- **The local handler run in `lmz-api.ts`** — `executeOperationChain(filled, nodeInstance, { requireMeshDecorator: false })`.

**Every hole is reachable from an ordinary browser session — the published client API is enough, and none of them needs Workers RPC.** What each one reaches is the Result column of the probe table above; what a test must assert about each is § *Criteria to carry into the phases*. ⓘ A worked code sketch used to sit here and was deleted 2026-09-24: it named a client handler that does not exist, so it could not have run, and it still described forging the field § *The response leg* removes. The table and the criteria carry the same ground with measured evidence behind each row.

⚠️ **Not yet driven end to end.** Every link was read in source and the executor links were run, but nobody has driven the full path from a real browser session through the Gateway to a DO. The first phase does that for each hole before anything is fixed.

The rest of this file gives the request-leg design, the response-leg design, the gotchas any fix must handle, and the criteria the phases carry — then what all of that obliges elsewhere: the backlog rows it falsifies, and the decisions log.

## The request leg — `@mesh` marks any member, and the first op must name one

**The rule: the first op of every chain that arrives off the wire names a member the host class marked `@mesh()`.** The member may be a method or a getter. That op is where the `@mesh(guard)` guard runs, as it does at a gate method today. Everything after that first op runs unchecked on whatever the member yields, exactly as today after a gate method. A getter gate and a method gate side by side:

```ts
class Galaxy extends LumenizeDO<Env> {
  // A GETTER gate. The guard runs at the entry, read off the descriptor before the
  // getter body is invoked; the body then picks what to hand back.
  @mesh(requireAdmin) get admin() { return this.#admin; }

  // A METHOD gate, unchanged. Use one when the entry needs arguments.
  @mesh() resources() { return this.#dataPlane; }

  // Undecorated, so unreachable as an entry — a getter is refused WITHOUT running,
  // which is why the lookup reads descriptors rather than the property.
  get secrets() { return this.env; }
}

ctn<Galaxy>().admin.addUser(u);            // passes — `admin` is marked, requireAdmin runs
ctn<Galaxy>().resources().invite(n, who);  // passes — `resources` is marked
ctn<Galaxy>().secrets;                     // refused — not marked, and the getter never runs
ctn<Galaxy>().env.SECRET;                  // refused — `env` is not marked
ctn<Galaxy>().svc.sql(['SELECT 1']);       // refused — `svc` is not marked, and nothing exempts it
```

**Methods and getters — not fields, and not `accessor` (decided 2026-09-24).** Both carry the mark on their function value, so they cost the carrier the package already has.

- **A field has none**, and `Symbol.metadata` is `undefined` in both runtimes, so marking one needs a second carrier: an `addInitializer` name registry keyed per class. `workflow.md` § *Evaluating alternatives* reserves the YAGNI objection for exactly that — "a new subsystem, **carrier**, or protocol". A marked field is also the one entry kind that hands over its object as-is, with no code in between to narrow it.
- **`accessor` is cut for a DIFFERENT reason, and not on cost** — its decorator receives `{ get, set }` rather than a function, so today's `(target)[MESH_CALLABLE] = true` marks the wrapper and `isMeshCallable` returns false; a `context.kind` branch stamping `target.get` is about two lines, which the carrier exception does **not** cover. It is cut because it **adds no capability**: `OperationChain` is `get` and `apply` only (`ocan/types.ts`), so no remote caller can express a write, and a marked `accessor` is a marked getter with a setter nobody can reach. That is a second spelling of the first, which is the more-than-one-right-way problem rather than a YAGNI one.

**Both stay refused and are additive later**, since adding a member kind breaks no chain this rule allows. Nothing in `packages/*/src` or `apps/nebula/src` marks anything but a method today.

**A getter is the form for a GATE, and a gate is what returns a capability surface and does nothing else.** `ctn<Galaxy>().resources.transaction(…)` matches `client.resources.transaction(…)`, the vocabulary [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md) already pins for app authors — where a method gate would leave one capability with two spellings. **Every other entry stays a method, whatever its arity.**

⚠️ **Scoped to gates, NOT to arity — arity was a proxy and it is wrong in both directions.** The three real zero-arg `@mesh` members on disk are `Star.resetDevData()`, `Galaxy.getCurrentOntology()` and `getGalaxyConfig()`; an arity rule says make them getters, and `resetDevData` **destroys and rebuilds data**, so that turns an action into a mutation on property read. Two of the three are `async` besides, which § *Gotchas*, item 6 measured as throwing `parent[methodName] is not a function`. A gate taking a selector argument would want a method too. ⓘ Both readings agree on `resources`, which is the case actually decided, so this narrows the rule rather than reopening it.

**What a getter entry OWES, because nothing at the call site says code runs:** it is side-effect-free, synchronous, cheap and idempotent. ⓘ **The number that motivated this is gone, and the obligation is not.** Before Phase 2 the executor replayed every `get` to find a method's parent, so a getter entry's body ran **three times to its guard's once**; carrying the parent along the walk makes it **once**. The obligation stands on what a getter IS — code behind a property read, where nothing at the call site says so — which is why `mesh.md` § *Object-capability access* is still where it belongs, beside the gate-return recommendation already headed there.

**The SHIPPED signature accepts `ClassMethodDecoratorContext | ClassGetterDecoratorContext` and nothing else** — an overload pair, since `ClassGetterDecoratorContext` types `target` as a zero-argument function. ⚠️ **It is deliberately NARROWER than the probe's**, which took one signature across all four kinds: widening that far lets `@mesh() accessor` and `@mesh()` field **compile**, leaving the runtime refusal limb as the only net, which is the foot-gun the cut exists to avoid. ⓘ Today `mesh()` is typed over `ClassMethodDecoratorContext` alone, so this file's own `@mesh(requireAdmin) get admin()` example fails `tsc --strict` with TS1241 until the pair lands.

**Feasibility is measured, not assumed (2026-09-23).** One probe class carrying a marked method, getter, `accessor` and field was compiled through every decorator transform this repo uses — SWC 1.15.30 at `2022-03` and `2023-11`, esbuild 0.27.3, esbuild 0.28.1 (the one inside `apps/nebula`'s wrangler 4.124), and tsc 5.9.3 — then run in Node 24 and in workerd `2026-08-15`. All four member kinds reached the decorator with a working `addInitializer` on all five transforms and both runtimes, a subclass's marked field resolved, and `tsc --strict` accepted one `@mesh()` signature across all four kinds. ⚠️ **`Symbol.metadata` is `undefined` in both runtimes**, so the marks cannot ride `context.metadata`. ⚠️ **REACHING the decorator is not being MARKED by it** — that probe proved the first and was written up as though it proved the second, which is how `accessor` survived a round (`calibration.md` §7). What decides it is what `target` IS for each kind, measured separately: a function for a method and a getter, `{ get, set }` for an `accessor`.

**What comes with the rule:**

- **THE ENTRY RULE — op 0 is the entry, and only a wire-borne chain must have it name a marked member.** A chain the node authored itself — a `$result` handler, a stored alarm continuation, `@lumenize/fetch`'s callback — may root anywhere, including `ctx` or `svc`: `this.ctn().ctx.storage.kv.put('cache', remote)` is the JSDoc example on `replaceNestedOperationMarkers` and must keep working. The prototype fence applies from op 1 on every leg regardless.
- **DESCRIPTOR LOOKUP — the check reads descriptors and never reads the member.** It walks the prototypes with `Object.getOwnPropertyDescriptor`, which is where both a method and a getter live, and never evaluates `parent[key]` — so an unmarked getter is refused without running. ⓘ An own-property read is the branch a field entry would add if fields are ever brought in; the first cut does not need it. Both carry the mark on their function value, exactly as methods do today.
- **THE PROTOTYPE FENCE — after the entry, a `get` of `constructor`, `__proto__`, `__lookupGetter__`, `__lookupSetter__`, `__defineGetter__` or `__defineSetter__` is refused, as is one resolving on `Function.prototype`.** Those are the doors JavaScript puts on every object, and no amount of careful authoring removes them; everything else past the entry is the author's business.
  - ⚠️ **Naming keys is not the deny-list `calibration.md` §2 warns about, because the spec fixes what every object carries — and the list is SIX, not two (measured 2026-09-24).** `Object.getOwnPropertyNames(Object.prototype)` returns twelve names in workerd `2026-08-15` and in Node 24: `constructor`, `__proto__`, the four Annex-B accessors above, and six benign ones — `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toString`, `toLocaleString`, `valueOf` — which stay reachable. The four matter for two different reasons. **`__lookupGetter__('__proto__')` hands back the `__proto__` getter**, so it is a third named route to a facade's own prototype without naming either of the first two keys. **`__defineGetter__`/`__defineSetter__` are the only property WRITES a chain can name** — a chain expresses `get` and `apply` only, but a write reached as a method call is still a write, and a get-only nested marker naming a marked member yields the function argument they take.
  - ⓘ **Refusing every `__`-prefixed key instead reads more structural and is not available:** `__executeOperation`, `__handleResponse`, `__broadcastTier`, `__forwardBroadcastResult` and `__handleProxyFetchResult` are real mesh members, two of them `@mesh()`-marked in `lumenize-worker.ts`.
  - ⓘ **The rule this replaces — refuse a `get` resolving on `Object.prototype` — covered all four Annex-B names for free, and the measurement that retired it never tested them** (`calibration.md` §7: the verdict was one nobody argued with, so its supporting clause went unchecked). On the case it *was* compared on it is genuinely weaker: `constructor` own-resolves on `String.prototype`, `Array.prototype`, `Map.prototype` and on any class's own prototype, so **only a plain object routes it to `Object.prototype`** — and the shape this task promotes is a gate returning a facade, i.e. a class instance, which that rule misses. Keying on names still wins, and at six it still gives back the benign members an ancestry rule costs.
  - ⓘ The severe path was already closed two hops out and stays closed: `constructor.constructor` reaches `Function.prototype.constructor`, which the `Function.prototype` half refuses. What the old rule left open was the middle hop — a facade's own class and prototype, which is enough to pollute every instance of that facade.
- **NO `svc` EXEMPTION — it is deleted rather than scoped, and NOTHING replaces it.** The one chain that opened on `svc` across a hop is `@lumenize/fetch`'s proxy callback, and it simply stops working: the package is all but deprecated, so no door is built for it (§ *What needs Larry*, item 6). The alternative and the evidence against it are in § *Context and current state*; § *Gotchas*, item 4 prices the deletion.
  - ⓘ **A marked entry on `Fetch` was the earlier answer and it was never available anyway** — the executor addresses the node and checks op 0 against the host class's descriptors, so a mark two ops along the chain `svc.fetch.__handleProxyFetchResult` is never the entry, and nothing lets a plugin put a member on the host (`NadisPlugin.register` writes only the global service registry). The only doors that would have worked are a gate on `LumenizeDO` or a carrier installing plugin members — both priced against a package nobody runs.
- **`meshFn` GOES.** It marks a function reached through a path of `get`s, which is exactly what the rule refuses. `grep -rn '\bmeshFn\b' packages apps website` is the list of uses — all tests, plus two barrel exports — and `packages/mesh/test/node-import.test.mjs` asserts the *export* rather than the behaviour, so a builder who deletes the export reds a suite nobody named.
- **`Unprotected<T>` GOES (measured 2026-09-24).** It exists to type-enable `this.ctn<Unprotected<RemoteDO>>().ctx.storage.kv.get('key')` — a **remote** chain opening on `ctx` — so after this fix every chain written with it compiles and throws at runtime, the worst shape for a package promising no foot-guns. **Narrowing it to locally-authored chains was the alternative, and the measurement retires it:** `ctn` is an overload pair, `ctn(): Continuation<this>` beside `ctn<T>(): Continuation<T>`, so `this.ctn().ctx.storage.kv.put('cache', 1)` and `this.ctn<MyDO>().ctx…` both typecheck with no helper — `protected` is reachable from inside your own class — while `this.ctn<RemoteDO>().ctx…` errors, which is the only case the helper ever served. It has zero uses in source or tests; the definition, the barrel export and one sentence of `continuations.mdx` are the whole of it. Rides `meshFn`'s release note.

⚠️ **The prototype fence is a WALK rule, not the member-level check, so it MUST NOT be gated on `requireMeshDecorator`.** It runs on every op, on every leg, at every flag setting — because what it refuses is never legitimate, whoever authored the chain, and nothing legitimate roots at those keys: a node's own continuation roots at `ctx`, `svc`, or a method name. Only the entry rule's *"must name a marked member"* is what the flag turns off. Writing it inside the flag's branch is the plausible mistake, and it would leave the response leg able to name `constructor` — § *R3* rejects a response-leg member-level check partly on the prototype fence being unconditional, so gating it silently withdraws that argument. **From op 0, not op 1:** on the request leg the entry rule covers position 0, but on the response, alarm and local-handler legs it is switched off, so a chain whose FIRST op names `constructor` meets no rule at all unless the fence starts there.

**BOTH RULES LIVE INSIDE `executeOperationChain`, and that is a composition requirement rather than a preference.** [ADR-007](../docs/adr/007-shared-node-security-core.md) makes the guards core something every node type gets by composition and never reimplements, and its one licensed divergence is the client's **receive shell** — no `AsyncLocalStorage` in a browser, no addressable fire-back door — explicitly *not* the engine: the client *"runs the same continuation-dispatch engine as the server node types (including the `@mesh()` member-level check)"*. So the engine is where a rule reaches every node for free, and the envelope seam is where it reaches only the two that compose `executeEnvelope`.

- **FIVE runners execute a chain, not four.** `executeEnvelope`'s two doors, the two `__localChainExecutor` getters (`lumenize-do.ts`, `lumenize-worker.ts`), and **the browser client** — `lumenize-client.ts` calls `executeOperationChain(chain, this)` with no config, so `requireMeshDecorator` takes its `true` default and a wire-borne request leg runs the member-level check **in a browser**. `apps/nebula/src/nebula-client.ts` has thirteen `@mesh()` push handlers behind that door.
- **Writing the rules at the seam is MORE code for LESS reach**, and it buys a divergence ADR-007 calls a defect unless justified: the client cannot compose `executeEnvelope`, so it would need its own copy of a security rule — the same logic written per host that `calibration.md` §11 names as the reflex to resist. One composed location serves all five.
- ⇒ **It is a phase criterion, proven by a limb rather than by inspection** (§ *Criteria*), because "the rule is in the right function" is exactly the kind of claim a reviewer confirms by reading and a builder breaks by refactoring.

**What a gate hands back is the author's business (decided 2026-09-24, Larry).** The framework fences what JAVASCRIPT puts on every object — the prototype fence — and does not police the door. There is deliberately NO rule refusing a member whose value is the node, its `ctx`, its `env` or its `svc`: `@mesh() get self() { return this }` is the author's own foot-gun, visible in their own source, and a guard against it would buy little while costing the carve-out that lets a node's own continuation root at `ctx`. **What the docs recommend instead:** hand back only methods (including getters), and be careful not to accidentally hand back access to `this`, `this.ctx`, `this.svc` and the like. That is guidance in `mesh.md` § *Object-capability access*, not a refusal. ⚠️ **Do not grow it into a list of ways to misuse the decorator** — a dozen exist, and enumerating them costs UX and power for no security.

**A nested marker's chain gets the SAME rule, one level down (decided 2026-09-24).** Its op 0 must name a marked member too. That refuses `ctn<Star>().transaction(ctn<any>().env.SECRET, e, o)` and a nested `svc` chain, while `website/docs/mesh/calls.mdx` § *Operation Nesting* keeps working unedited — its `@check-example` target is a browser client whose nested arguments each open with a call to a `@mesh()` method, so the canonical case already conforms. It is also close to free: `resolveNestedOperations` already passes its `config` into the recursive `executeOperationChain`, so the nested chain inherits the rule as soon as the rule exists.

⚠️ **The check MUST run after `$result` substitution**, or every 4-arg handler breaks — `ctn().handler(ctn().$result)` would have its `[get '$result']` chain checked and refused (§ *Gotchas*, item 1). ⓘ That ordering already holds unconditionally and needs nothing built: `replaceNestedOperationMarkers` has no call site inside `executeOperationChain`, so substitution always precedes the executor, and every filled-handler sink runs at `requireMeshDecorator: false` besides. § *R1* adds skipping, not ordering.

ⓘ **Refusing nested markers off the wire was the alternative, and it is not merely costlier — it cannot be built correctly here.** It needs to know a chain came from a client, and `lmz-api.ts` appends each hop as `[...currentContext.callChain, callerIdentity]`, so `callChain[0]` stays the *original* origin: a Star→Galaxy call made while serving a client still shows a client there. It would refuse legitimate node-to-node nesting whenever a client started the flow, and scoping it properly means doing it at the Gateway.

## The response leg — two holes, one defect

**Both are the same mistake: the node treats a value the far side authored as if the framework had authored it.** One is a marker, the other an identity — and both fixes are the same move, taking the answer from something the far side cannot write. Neither depends on the other.

### R1 — a substituted result is re-scanned as a nested marker

**What happens.** `replaceNestedOperationMarkers` substitutes the result into the handler's arguments, and then `executeOperationChain` calls `resolveNestedOperations` over those same arguments. `isNestedOperationMarker` tests only `typeof obj === 'object' && obj.__isNestedOperation === true` — it does not check the prototype, and structured clone carries own properties across, which is how `clientInstanceName` rides an Error today. So a result carrying those two properties is re-read as a marker and its chain is executed.

Measured 2026-09-23 against the real executor, with a handler chain of `handler(ctn().$result)` and a result carrying `__operationChain`:

```
["undecoratedInternal RAN", "handler got string"]
```

⚠️ **This is not a guarded method with its guard skipped — it is any chain at all, on the node, at `requireMeshDecorator: false`.** The second entry matters too: the handler then received that chain's return value rather than the result, so the substitution is silently displaced.

**The fix: a FILLED chain is data, and the executor never resolves data (decided 2026-09-24, Larry).** Said structurally: **the marker shape is a property of a CHAIN, which `processArgumentsForNesting` builds; a result is data and can never be one.** The callee already populates the handler completely before it goes over the wire, so the caller has no populating left to do — running the fill step again on an arrival is the whole defect, and the cure is to stop running it rather than to record what it wrote.

**Scope: the substitution writes ONLY the final apply, so that is the only position that stops resolving.** `replaceNestedOperationMarkers` has **two branches and both write there** — it replaces every marker in the last `apply`, and when there is no marker it APPENDS the result as a last argument. ⚠️ **The append branch is the one production uses**: a reaper is `onQueryBroadcastResult(queryHash, result?)` with no `$result` marker, which `broadcast.ts`'s JSDoc states as *the framework appends the result at each leaf*. A fix written against the `$result` repro alone turns every limb green with the only live path open. An EARLIER apply may still carry a marker the author genuinely nested — `ctn().a(ctn().x()).b($result)` — and that one still resolves.

**Shape: TWO ENTRY POINTS, not a flag.** `executeOperationChain` runs a template and resolves nesting; a second entry runs a filled chain and does not, both sharing one walk so the entry rule and the fence still live in one place (§ *The request leg*). The choice is static at every call site, never a runtime decision, so a named entry cannot be forgotten or inverted the way a defaulted boolean can.

⚠️ **The distinction is irreducible and cannot be borrowed from `requireMeshDecorator`, which is ORTHOGONAL in both directions.** A template's final apply is exactly where legitimate nesting lives — `calculator-client.ts` builds `[get 'add'][apply(marker, marker)]`, the file's one positive control — so the executor cannot simply always skip. And the existing flag does not partition the same way: `alarms.ts` runs a never-substituted chain with the flag OFF, while `__forwardBroadcastResult` sends a pre-filled chain into a door where it is ON.

**FOUR sites substitute, and the entry-point split covers three of them statically.** `lmz-api.ts` does it twice — the dispatch-rejected local handler, and `fireResponse`, which fills at the **callee** and ships the filled chain to a caller whose `__handleResponse` re-scans it — plus the client's in-heap run. Each of those hands the chain straight to an executor in the same breath, so each simply names the filled entry. (`@lumenize/fetch` substitutes too and is ignored throughout — § *What needs Larry*, item 6.) ⓘ Reachable without a thrown Error: `outcome` is whatever the callee's chain returned, so attacker data stored earlier and read back later is enough, and `checkForMarkers` recurses into a returned plain object.

⚠️ **The fourth site defeats a static split and is fixed by DELETING the case, not accommodating it.** `__forwardBroadcastResult` fills locally and then sends the filled chain over a fresh `lmz.call` to a generic request door, which cannot know what it is holding. **It should not pre-fill at all** — it is forwarding a *result*, so it ships the unfilled chain plus the result and the receiving node substitutes locally, exactly as every other path does. Then no filled chain ever crosses a wire into a template door, and nothing has to travel to say so. It costs nothing to defer: the tier is pinned at `directThreshold: Infinity`, so the condition rides that backlog row (§ *Backlog rows this task trips*).

⇒ The criteria limb goes on the **node-to-node fire-back**, not only the local-handler path, or the fix ships covering the runner nobody attacked.

⚠️ **ADR-002 is what rules out the tempting alternative.** *Neutralising* the substituted value before `preprocess` — stripping or renaming the two keys — would close it with no protocol change and no entry-point split, and it contradicts [ADR-002](../docs/adr/002-structured-clone-everywhere.md): every surface round-trips the full structured-clone value space including own properties, with no reserved-key carve-out. A result carrying those keys must arrive **intact and unexecuted**, which is a criterion rather than a hope.

### R2 — the reaper takes its victim from the payload

**What happens.** A Galaxy fans a query update to its subscribers with one 4-arg `lmz.call` per target, and **every target shares one handler chain**: `this.ctn<Galaxy>().onQueryBroadcastResult(queryHash)`. That chain carries the `queryHash` and nothing identifying which target a result came back from. So when the reaper runs, its only source of *who died* is the payload:

```ts
onQueryBroadcastResult(queryHash: string, result?: unknown): void {
  if (result instanceof Error && result.name === 'ClientDisconnectedError') {
    const clientId = (result as { clientInstanceName?: string }).clientInstanceName;
    if (clientId) this.#dataPlane.removeQuerySubscriber(queryHash, clientId);
```

A client's handler throws an `Error` it built, naming any `clientInstanceName` it likes. `postprocess` restores `name` and copies every own key onto a plain `Error` **whatever the constructor**, so the guard matches and the named row is deleted. **Nothing about the reply is forged** — it is correctly identified as coming from the client that sent it. What is forged is a field in the payload that names somebody else.

⚠️ **The push hands the attacker its victim.** `#forwardToClient` sends `callContext.callChain` to the client verbatim, and a broadcast inherits the mutating client's chain, so a push triggered by B's transaction arrives at A carrying B's clientId in `callChain[0].instanceName`. A does not have to guess, and A and B share the query by definition. ⓘ A clientId is `${sub}.${tabId}` and the roster pushed to watchers deliberately carries `{ sub, profileId }` only — the `callChain` is the leak, and whether a clientId belongs there at all is tracked in the settle list at the end of this section.

**The risk is one unsubscription, and it needs hand-written client code.** No disclosure, no authority change, nothing persisted: the DELETE is exact-match on `(queryHash, clientId)`, so one subscriber row goes and the victim's UI silently goes stale until they reload. Attacker and victim are members of the same Star.

**The fix: delete `clientInstanceName` from the error, and take the victim from the address the CALLER used.** `dispatchEnvelope` already holds `calleeInstanceName` as a parameter — the same function that runs the local handler — so the unforgeable value is in scope at the line that currently hands the forged one to the reaper. The framework supplies it; the payload stops carrying it.

⚠️ **It reaches the reaper on `callContext`, and a POSITIONAL parameter is disqualified — not merely less tidy (decided 2026-09-24).** An appended argument is written by whoever writes the arguments, so on the direct request-leg call below the caller supplies it and the forged value simply moves from `result.clientInstanceName` to the last position. `executeEnvelope` runs a wire chain as given and appends nothing, so the append never reaches that call at all. `callContext` is the channel the framework builds rather than the caller: the Gateway assembles it field by field *"from VERIFIED sources"* and its `originRequest` field is the same move already made, its JSDoc stating the invariant a callee field inherits — kept out of `callChain[0]`, which a client partly authors, and out of `state`, which any hop may mutate. **Set it in three places** — `dispatchEnvelope` from `calleeInstanceName`, `fireResponse` from the fire-back return address, `executeEnvelope` from the node's own name — and a reaper reading it no-ops when it is absent. ⓘ The outbound rebuild that crosses to a client is itself an allow-list of three fields, so a new one is withheld from clients by construction rather than by remembering.

⚠️ **On the mesh fire-back leg the value is the callee's SELF-REPORTED identity**, so it is trustworthy on the Gateway and local-handler paths and not generally. Say so where the field is defined; a later reader over-trusting it is the likelier failure than one under-trusting it.

**This deletes the class rather than guarding it, and it closes BOTH legs:**

- **The response leg.** A forges an error, the reaper reads the callee — which is A — and reaps **A**. A can already unsubscribe itself, so that is a no-op rather than an attack.
- **The request leg, which no guard on the reply could have reached.** Every reaper carries a bare `@mesh()`, `onBeforeCall` enforces passage only, and structured clone carries an `Error` as an ordinary argument — so any Star member calls `ctn<Star>().onQueryBroadcastResult(hash, forgedError)` directly, with no reply involved, and **§ *The request leg*'s entry rule permits it**. After this fix there is no `clientInstanceName` to read, and the framework-supplied callee on such a call is the Star itself, which matches no subscriber row. ⓘ `profile.ts`'s `onProfileBroadcastResult` JSDoc already documents this hazard as its reason for staying undecorated, and the sibling's undecorated `resourcesResults` gate independently refuses the chain — that stays good hygiene, but it stops being what carries the security.

⚠️ **Rejected, and recording why because both looked right for a while:** *wrapping the client's thrown error* at the Gateway so its `name` no longer matches, and *a Symbol-keyed marker* the wire cannot carry that the reapers would check. Both guard the reply; neither touches the request leg, and neither removes the forgeable field. `calibration.md` §2 — the second guard on a mechanism whose problem can be made structurally impossible.

**Two questions the file used to run together, and only one of them is ours.** *Who failed?* is the security question, answered by the address. *Did delivery fail?* is a correctness question, and the name guard already answers it: a client's ordinary bug carries its own error name, so the reaper never matches it. Trying to make one mechanism carry both is why the earlier design did not close the hole.

⚠️ **The Gateway uses ONE error class for two of its own conclusions, and that is the only real conflation left.** `ClientDisconnectedError` covers both a client that is gone — no socket, no reconnect, null attachment, timeout — and one whose token just lapsed, which gets `ws.close(4401)` and is back in about 100 ms. The second is self-healing and reaping it is already wrong (`tasks/backlog.md` § *Lumenize Mesh*, the `subscriptionRequired` row, argues exactly that at this site). **It gets its own class; the reaper's name guard then refuses it for free.** Nothing else in the Gateway's vocabulary changes, and the timeout keeps returning `ClientDisconnectedError`, which is correct.

ⓘ **A distinct ACK SHAPE for delivery failure was designed and then dropped** (`$undeliverable`, 2026-09-24). Once the victim comes from the address, a forged name reaps only the forger, and the name guard already discriminates an ordinary client bug — so the shape had no consumer left, while costing a protocol change, an edit to `lmz-api`'s ack handling, and a rule that the timeout resolve rather than reject. `$error` therefore still carries two meanings, and nobody reads the difference. ⇒ **The trigger to re-derive: the first consumer that genuinely needs to tell "never reached them" from "they ran and threw"** — then the distinction is worth a shape, and not before (`calibration.md` §4).


**What this means for the reapers.** Their bodies **do** change: they stop reading `clientInstanceName` and take the callee the framework hands them. **`grep -rn 'clientInstanceName' packages/*/src apps/nebula/src .claude/rules website/docs` is the inventory, never a count — and it returns TWO mechanisms that share a spelling** — the sibling task is actively changing how many exist, so any number written here is wrong within one task. ⚠️ **Only one of the two goes.** The forgeable `ClientDisconnectedError.clientInstanceName` goes, with the four `new ClientDisconnectedError(msg, clientInstanceName)` sites and the `#withClientInstanceName` helper that exists only to stamp it. `ClientResultEnvelope.clientInstanceName` **stays** — the framework supplies it, so it is the model § *R2* argues for rather than a counter-example, and it feeds only two `log.warn` calls since delivery re-resolves through the DO stub. ⚠️ **They span THREE packages, not the two this file otherwise discusses.** Beyond `apps/nebula`'s Galaxy and Star, `packages/nebula-auth/src/profile.ts` carries `onProfileBroadcastResult` — the Profile is a node type this task names nowhere else, and its push is a **hand-rolled `lmz.call` loop rather than `svc.broadcast`**, deliberately, so a tier worker cannot rewrite `metadata.caller` and defeat its cross-scope fence. The address the caller used still reaches it, so the fix works there unchanged — but a builder sweeping only `apps/nebula` would miss it. ⓘ That same JSDoc is what § *R2* cites as the in-repo precedent for a reaper staying undecorated, so the file leans on the file it forgot to count. `.claude/rules/mesh.md` § *Errors across mesh calls* is untouched — the name guard still identifies the *kind* of error, it just no longer answers *who*.

**What R2 leaves to settle:**

- **What the `callContext` field is CALLED, and how a handler reads it.** The channel is pinned above; what a phase still picks is the field name and the accessor a reaper uses. ⓘ The `$result` wrinkle that made this look like an argument-shape question is gone with the argument — a handler spelling an explicit `$result` marker reads the same `callContext` as any other.
- **A refusal by `onBeforeCallToClient` is not a delivery failure.** The client is connected and fine, so it stays `$error`. Worth pinning, because the site sits beside the ones that change.
- **What the expired-token class is CALLED**, and whether anything else should stop reaping on it. Nothing depends on reaping it today, since `NebulaClient` ignores the flag and re-subscribes unconditionally. **The residual is a bounded leak**: a client that lapses and never returns keeps its row until the next push finds no socket.
- **The tier path** must carry the callee's `callContext` field through `__forwardBroadcastResult` if the tier is ever unpinned, since the forward re-fires the handler as a fresh request and the address is what the reaper now needs (§ *Gotchas*, item 3). ⚠️ That condition belongs on `tasks/backlog.md`'s `directThreshold` row, which outlives this file.
- **Whether a clientId belongs in a forwarded `callChain` at all**, given the roster withholds it on purpose. This fix removes the attacker's *use* for it, not the leak.

### R3 — a response-leg member-level check, considered and NOT built

**A second decorator marking which methods may be a fire-back target was weighed and rejected.** It would have closed the R1 attack too — `resolveNestedOperations` passes its config to the nested chain, so an injected chain's entry would be checked — which is what makes the comparison worth recording rather than just the verdict.

**R1 is strictly stronger on the attack they share.** R1 stops a value becoming a chain at all, so the only chain that runs is the one the node authored. A decorator leaves the injection working and merely narrows where it lands: an attacker would still reach any marked method with arguments of their choosing. `Galaxy.onQueryBroadcastResult(queryHash, result)` would carry the mark, so a forged result could name it with a different `queryHash` and reap a subscriber of a query the attacker never subscribed to — worse than R2's hole. Deleting the class beats narrowing it (`calibration.md` §2), and adding both is the second guard that entry warns about.

**What the decorator would uniquely cover is a future regression, and other things already cover it. Four runners execute a chain here, and each is safe for its OWN reason** (measured 2026-09-24 — an earlier draft gave a single wrong reason for all of them, and the wrong one was load-bearing):

| Runner | Why a caller cannot choose its chain |
|---|---|
| `dispatchEnvelope`'s local handler | the chain is the node's own continuation, never inbound |
| `ComposedMeshDO.__handleResponse` | it runs `postprocess(envelope.chain)` — the **sender's** chain — but it **carries no `@mesh()` mark**, so no chain a client can address can name it, and `returnAddr` is stamped from the sender's own `selfIdentity` rather than read from inbound content |
| `Fetch.__handleProxyFetchResult` | its continuation argument closes with `svc`, which stops being an entry |
| the client's in-heap handler | the chain is the client's own, run in its own isolate |

⚠️ **The earlier draft said `__handleResponse` "takes its chain from a `response` descriptor the Gateway builds".** It does not — the Gateway builds only `kind: 'client'` descriptors, while the `kind: 'mesh'` one is built by the **calling** node. The verdict survives on the two properties in the table, which is `calibration.md` §7 exactly: nobody argued with the conclusion, so nothing checked the clause beneath it.

ⓘ The forged-error vector § *R2* closes was never a chain addressed here either — it is an ARGUMENT to a legitimate handler. Beyond that, § *The request leg*'s prototype fence is unconditional, so even a hostile chain arriving here could not reach a prototype or `Function`.

**The cost is paid by the people we promise no foot-guns.** A handler missing the mark throws in the detached post-ack task, and a fire-back envelope carries no `response` descriptor, so `fireResponse` takes its `!response` branch and logs *"post-ack chain threw with no handler to receive the error"*. The handler silently never ran, and a log line is the only evidence. ⚠️ **Who actually hits it is narrower than an earlier draft claimed:** `fireResponse` is server-side, so this bites whoever writes a DO's result handlers — us, and any package consumer building their own node — not the `NebulaClient` subclasses Studio generates, whose handlers the Gateway reaches by a different path. It is still a silent failure on a hand-written surface, which is why it counts against the decorator; it is just not the generated-app population.

⚠️ **The trigger to re-derive, which is what this entry exists to carry: if `__handleResponse` ever becomes reachable from a chain a client can address — it gains a mark, or the Gateway learns to dispatch to it — or if any node ever takes `returnAddr` from inbound content, the response leg needs its own member-level check and the design above is it.** Those are the two properties the table rests on, and the first is one a builder implementing *"entries need the mark"* could break by hand without noticing, so it is named on the line that would stop them. `calibration.md` §4 says a justification that can expire is re-derived when it does, never pre-guarded now. ADR-003 rules out the stateless alternatives — the handler must travel, so a node cannot verify it authored a chain without holding state, which is why a decorator would be the answer and nothing cheaper is.

## Gotchas

These are the places the framework's own services travel the paths being closed, so any fix must handle them. They apply to both legs.

1. **`$result` is itself a get-only nested marker.** `ctn().handler(ctn().$result)` puts a marker in the handler's arguments, and `replaceNestedOperationMarkers` in `execute.ts` swaps a marker for the result before the chain runs. ⚠️ **It substitutes only in the chain's FINAL operation, and only when that op is an `apply`** — its own comment says so — so a marker in an earlier apply is *executed* rather than overwritten. So any alternative that refuses get-only markers, or requires every nested marker to open with a `@mesh` call, must apply **after** that substitution — otherwise every 4-arg handler, alarm and `svc.fetch` continuation using `$result` breaks. Note too that within that final apply it replaces every marker, not only `$result`, so a handler nesting a real sub-continuation there has it overwritten.
   - ⚠️ **When it finds NO marker it takes its other branch and APPENDS the result as a last argument** — which is the branch production uses, since a reaper is `onQueryBroadcastResult(queryHash, result?)` and spells no marker at all. Both branches write the final apply, which is what lets § *R1* name one position rather than record two cases.
   - ⚠️ **A marker the substitution leaves behind is not caught by the nested rule:** a filled handler chain runs at `requireMeshDecorator: false` and the nested chain inherits that `config`, so it keeps resolving silently to `undefined`, which § *Backlog rows this task trips* already records as an open ergonomics issue.
2. **Alarms run stored continuations with the member-level check OFF** — `executor(parse(row.operationChain), { requireMeshDecorator: false })` in `alarms.ts`. A fix keyed on that flag leaves alarms alone. A structural rule applied regardless of the flag also hits alarm handlers, which are undecorated local handlers by design.

   ⚠️ **Answered from source, and the answer is that it is closed today (2026-09-24).** `Alarms.schedule` recovers a chain only through `getOperationChain`, a module-scoped WeakMap keyed on proxies registered **in this isolate**, and a hand-shaped nested marker is resolved to its *result* before it reaches the argument list — so no wire-borne value can become a stored continuation. ⚠️ **The WeakMap alone is not what closes it**, and writing only that invites the reader to stop early: a nested chain rooted at `svc` can walk `svc.fetch.doInstance.ctn()` — the probe table's own measured-allowed row, since `NadisPlugin.doInstance` is `protected`, i.e. runtime-public — toward a genuine registered proxy. What closes *that* is that `executeOperationChain` awaits every `apply` and returns from an `async` function while a continuation proxy is a never-settling thenable, so the chain **hangs** instead of yielding one. ⓘ Either way `svc` stops being an entry (§ *The request leg*), so the design does not turn on this — what turned on it was the red-first evidence, and the row is now a green-before-and-after limb.
3. **`svc.broadcast`'s tier path forwards the reaper as a plain request — which costs NOTHING today, and would cost something only after the sibling lands.** `__forwardBroadcastResult` re-fires the handler through `__executeOperation`, where the member-level check is on. Every `svc.broadcast` reaper carries `@mesh()` today, each JSDoc naming this dispatch path as the reason, so the entry rule passes them through unchanged. It is the sibling's Phase 7 shed that would make a forwarded reaper **undecorated** and therefore refused — a condition that task already claims for itself, so this file must not count it twice. The tier is pinned off (`directThreshold: Infinity`) and already misroutes failures to the mutating client, so a choice either keeps that forward reachable or leaves the tier pinned and says so. **Pinned is the answer here:** the tier is a dead interim, the path is independently broken when unpinned, and making the forwarded reaper survive the new rule is guard machinery for code nobody runs (`calibration.md` §2).
4. **Exactly one `svc`-opening chain crosses a hop, and it is `@lumenize/fetch`'s callback.** `svc.fetch.__handleProxyFetchResult(reqId, result)` is the only one the probes found; `alarms` and `broadcast` build their `svc` chains locally, and `__broadcastTier` and `__forwardBroadcastResult` are both already `@mesh()`. **So deleting the exemption costs `@lumenize/fetch`'s proxy callback and nothing else** — accepted rather than replaced (§ *What needs Larry*, item 6), which is the price § *The request leg*'s no-`svc`-exemption rule pays. ⓘ The package's own **alarm/timeout** path is untouched: it calls the same method through `(this.doInstance.ctn()).svc.fetch.…`, a locally-authored chain THE ENTRY RULE's carve-out already permits, and that path reads its continuation back off the cancelled alarm row — so the method keeps its third parameter whatever happens to the wire leg.
5. **What a `@mesh` gate may return is an AUTHORING obligation, not a check.** Nothing after the first op is checked, so a gate whose return value holds a path back to the node, its `ctx`, `env` or `svc` exposes all of it — and nothing refuses that (§ *The request leg*). `DagTree`'s `#`-private fields are the defence, and the recommendation to hand back only methods is what generalises it. The obligation needs a home in `mesh.md`.
6. **The executor runs every earlier call again, and an `async` gate breaks.** To find the object a method is called on, `findParentObject` in `execute.ts` starts over from the DO and re-runs every earlier op, synchronously and without awaiting. Measured 2026-09-23 against the real executor:
   - `gate().invite('ann')` ran the guard once and the gate body **twice**.
   - The second run got the raw arguments, so a nested marker arrived as an unresolved `{ __isNestedOperation: true, … }` object instead of its value.
   - An `async` gate threw `parent[methodName] is not a function`, because the re-run's parent is a Promise.

   No gate had hit this yet: `dagTree()` is the only one on disk, and it is synchronous with no side effects. (`resources` is the sibling's, not yet built.) ✅ **FIXED in Phase 2 (2026-09-24): the parent is carried along the walk**, so each op runs exactly once and every call is awaited, and `findParentObject` is deleted. All three measurements above were re-run red first and are now green. ⓘ It landed in its own phase rather than inside the member-level-check rewrite, because every later phase edits this loop.
7. **The prototype fence costs almost nothing, because it names six keys rather than an ancestry.** `Array.prototype.map`, `Map.prototype.get`, the `RequestSync`/`ResponseSync` methods, and all six benign `Object.prototype` members on a returned value — `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toString`, `toLocaleString`, `valueOf` — all still pass. What stops working is a chain naming one of the six (§ *The request leg*), or reaching a `Function.prototype` member such as `call` or `bind`. Nothing in the repo does either, which the first phase confirms by running the suites rather than by grep.

## Criteria to carry into the phases

**The first phase proves every hole before anything is fixed.** For each hole it writes a test asserting the secure behaviour, runs it against today's code, and records that it FAILS. A test never seen red cannot show that a fix closed anything (`testing.md`). Here the red run also answers what § *Context and current state* leaves open — whether each hole is reachable from a real browser, not only from the executor. No fix lands in that phase.

- **Tier.** Each hole gets a `/live` limb, because reachability through the Gateway is exactly what is unverified, and `live.md` makes `/live` the default tier. **Four carve-outs, and EACH CARVED-OUT TEST FILE carries its own one-line reason** — `live.md` puts that MUST on the test, not on the task file, and a task file archives while the test outlives it — `live.md` makes `/live` the default precisely so nobody drops to a cheaper tier out of convenience, and `calibration.md` §6 says the rationalisation will be written before any test exists, so an unexplained exception reads like one.
  - **The probe table's executor behaviour** gets a unit test: `executeOperationChain` against a stand-in object needs no running system.
  - **The member-kind and guard-ordering limbs** live in `packages/mesh`'s own real-mesh-path tests, on a class built for them. They are properties of the decorator and the executor, and driving them in `/live` would mean shipping a marked field, a marked `accessor` and a call-recorder into `apps/nebula`'s production Star or Galaxy — where there are ninety-one `@mesh` sites and not one marked getter, and where the real getter pair is the sibling's unbuilt Phase 7 this file says not to document. Counting a getter body's invocations is DO-internal control flow besides: readable under pool-workers through the debug sink, but in `/live` only through `DevStack.logs`, which does not exist under `HARNESS_TARGET_URL`. ⚠️ Real mesh path, not `createTestingClient` — `testing.md` forbids that for a fixture demonstrating a guard — and any "records it ran" recorder is read back **through the mesh**, never from stdio.
  - **The R1 substitution rows** live in `packages/mesh`'s own real-mesh-path tests, on the same ground and for the same reason as the member-kind limbs — each needs a node that RECORDS an injected call, and in `/live` that means shipping a recorder into `apps/nebula`'s production Star or Galaxy. ⚠️ **The node-to-node fire-back is additionally UNREACHABLE from a browser**: a client addresses `__executeOperation` through the Gateway and can never address `__handleResponse`, so the runner § *R1* says the fix must cover has no `/live` venue at all. The lane drives a real DO-to-DO hop in workerd, so this is a venue swap rather than a drop to a cheaper tier. (Added at build time 2026-09-24; the three earlier carve-outs were written before the recorder's home was traced.)
  - **The two `svc.fetch` rows** live in `packages/fetch`'s own pool-workers suite, which already registers the plugin and defines meshed DOs. `/live` drives Nebula, and `apps/nebula` has no `@lumenize/fetch` dependency and no `svc.fetch` reference at all, so those rows are structurally undrivable there. ⚠️ **This is PERMANENT, not pending**, and it is a venue swap rather than a drop to a cheaper tier — that suite drives a real Worker↔DO hop in workerd, so it is not the "genuinely pure" carve-out `live.md` licenses; the reason is that `/live`'s system under test is Nebula and Nebula will never take the dep, which would be the `workflow.md` trap of a test becoming the reason a thing exists. ⓘ Both rows assert the **rule** — that `svc` is no longer an entry — and neither keeps the package working; the round trip itself breaks by decision (§ *What needs Larry*, item 6).
- **Prove each hole with a harmless payload.** `svc.sql(['SELECT 1'])` proves arbitrary SQL runs as well as a `DELETE` would. A skipped guard is proven by a test-only guarded method that records it ran, never by `teardown`. So a red run cannot destroy state, which matters because the harness can target a deployed worker through `HARNESS_TARGET_URL`.
- **One limb per hole, each with a mutation that isolates it, matched on the refusal MESSAGE.** A scenario reddens on its first failing limb and hides every later one (`live.md`).

Every row below is red today unless its own Status cell says otherwise, so the table states its exceptions rather than counting them. **The ✅ rows must be GREEN before and after** — positive controls, here rather than among the regression guards because a fix that refuses too much satisfies every refusal row while breaking them. **A row whose Status says "unknown until checked" is not known to be red**: the first phase finds out, and either outcome is a finding.

| Hole | The test asserts | Status today |
|---|---|---|
| read `env.<name>` with no call | refused | a chain with no call is never checked |
| a wire-borne `ctx.<anything>` read | refused, on the entry-rule message | same — and this is the probe table's `ctx` row, which had no limb |
| the same read, as a nested argument | refused | a get-only marker is never checked |
| `svc.sql(['SELECT 1'])` | refused | `svc` is exempt |
| a nested `svc` chain as an argument | refused | the exemption applies per chain |
| `svc.fetch` walked to an undecorated method on the node | refused | `NadisPlugin`'s fields are `protected`, not `#`-private |
| after a gate, a write to `Object.prototype` via `constructor` | refused at the `constructor` op, **and** `({}).<key>` is still `undefined` | nothing after the first call is checked |
| after a gate, `constructor` reached from a returned string, and from a returned FACADE | refused at the `constructor` op in both | same; the facade case is the one an owner-based rule missed, and in a browser client the string case reaches `Function` |
| after a gate, the facade's prototype reached by `__lookupGetter__('__proto__')`, naming neither fenced key | refused at the `__lookupGetter__` op, **on its own message** | same — and a fence closing only `constructor`/`__proto__` permits it, which is why this limb exists |
| after a gate, `__defineGetter__` given a function obtained as a get-only nested marker on a marked member | refused at the `__defineGetter__` op, **and** `({}).<key>` is still `undefined` | **ANSWERED 2026-09-24, and the answer is YES** — a get-only nested marker ending on a method yields the function, `__defineGetter__` runs with it, and routed through a marked member that hands back a PLAIN object (`constructor` → `prototype`) the write lands on `Object.prototype`: `({})[key]` read back the getter's value, in workerd and from a real browser session alike |
| a reply naming `ClientDisconnectedError` and ANOTHER client | the named client's row is intact, **and** the replying client's own row is the only one touched | the reaper takes its victim from the payload |
| the same forged error passed DIRECTLY to a reaper that still carries `@mesh()`, no reply involved | the call was PERMITTED — it returned normally, and the failure text is not `is not mesh-callable` — **and** no subscriber row changes | a reaper carries a bare `@mesh()`, so the chain is permitted |
| a marker-shaped reply on the LOCAL handler path, with a chain naming a method that records it ran | that method did NOT run, **and** the handler received the reply itself | the substituted result is re-scanned by `resolveNestedOperations` |
| the same, on the node-to-node FIRE-BACK, and separately on a reaper-shaped handler with NO `$result` marker so the result is APPENDED | neither method ran, and each handler received the reply itself | **ANSWERED 2026-09-24: BOTH are open.** A real DO-to-DO hop ran the injected chain on the caller from a reply the callee had merely `JSON.parse`d, on the fire-back and on the appended branch alike — and the local-handler path ran it too, which also confirms structured clone carries both marker keys across an Error |
| a result whose own properties include `__isNestedOperation` and `__operationChain`, delivered to a handler | it arrives **intact and unexecuted** — both keys present, nothing ran | the chain runs; [ADR-002](../docs/adr/002-structured-clone-everywhere.md) is what this row protects, and it is what rules out closing R1 by stripping the value |
| ✅ `svc.alarms.schedule` with a wire-borne chain | no stored continuation is created, asserted on a BOUNDED WAIT | **GREEN** — § *Gotchas*, item 2 answers it from source. ⚠️ Not a message match: the closing mechanism is a HANG, not a refusal |
| a client whose token lapses on a live socket, same push | NOT reaped — its subscriber row survives the reconnect | the expired-token branch returns `ClientDisconnectedError`, which every reaper's name guard matches |
| ✅ a genuine disconnect, same push | the disconnected client's row IS dropped | **GREEN** — the cleanup the reaper exists for |
| ✅ a client that never answers a push | the timed-out client's row IS dropped, and it is the TIMED-OUT one | **GREEN** — the second way the Gateway concludes a client is gone |

- **The walk rule gets a limb on the RESPONSE leg, not only the request leg.** A chain run at `requireMeshDecorator: false` must still be refused when it names `constructor` — **and a second limb puts `constructor` at op 0 there**, since that position is covered by the entry rule only on the request leg. These are the criteria that fail if the prototype fence is written inside the flag's branch or starts at op 1, and § *R3* rejects a response-leg member-level check partly on its being unconditional — so without them, that rejection has no test holding it up.
- **Each fence clause gets its OWN limb, matched on its own message.** Today every fence row names `constructor`, so a fix closing only that key satisfies all of them: `__proto__`, a `Function.prototype` member such as `call` or `bind` — reachable precisely because the design encourages handing back methods — and the four Annex-B accessors each need one. An empty chain and an apply-first chain are **refusals**, not fall-throughs, and get a limb each, matched on their own messages. `validateOperationChain` accepts both today, and they then behave differently: an EMPTY chain returns the target object itself, while an apply-first chain on a function target **calls it** — the executor throws only when the target is not a function.
- **The BROWSER CLIENT gets a limb, in `packages/mesh/test/browser/`, and it is what proves the rules are composed rather than seam-written.** It drives a DO→client push whose chain names an unmarked member, `constructor`, and a `Function.prototype` member, and asserts refusal **on the client executor**. Two things make this the one limb no other tier substitutes for: it is the only place the probe table's `constructor`→`Function` row succeeds, since workerd refuses what unrestricted V8 allows; and a fix written at the envelope seam passes every other criterion in this file while leaving the client's door and both `__localChainExecutor` getters unfenced (§ *The request leg*).
  - ⚠️ **It is a NEW SPEC, not an extra assertion on the existing one.** That lane is one narrative spec plus a small worker that re-exports the getting-started DOs as-is, and it boots through a real magic-link round trip — nothing there can currently send a caller-chosen chain to a named client. ⓘ It needs no chain-forging DO, though: the fence half rides the client's OWN response door, which runs the executor on a client-authored chain, and a forged incoming push needs only the existing Gateway binding, which reads the target binding off the client's message and relays.
- **The direct-call limb asserts the call was PERMITTED as well as harmless, and must name a reaper that still carries `@mesh()`.** A refusal satisfies "no subscriber row changes" just as readily as R2 does — so without both halves the limb green-lights the sibling's Phase 7 shed, which this file says *"stops being what carries the security"*, and stops discriminating at all the moment that task lands and sheds the decorator from every Star and Galaxy reaper.
- **The reaper's positive limbs cover BOTH ways the Gateway concludes a client is gone** — it refused delivery, and it timed out waiting. Both must reap, and must reap the RIGHT client, since a fix that supplies the callee wrongly on one path satisfies every refusal limb while quietly breaking real cleanup on it.
- **The re-run bug gets its own red-first test:** a gate that counts its calls runs **once** per chain, an `async` gate's chain completes, and a gate given a nested marker receives the resolved value on its only run. It is a pure executor property, so a unit test against a stand-in object is the right tier, and the test says so.
- **The prototype-write limb asserts the SIDE EFFECT, not the refusal alone.** A refused chain that still wrote before it threw is a pass by message and a failure in fact, so the limb reads `({}).<key>` afterwards and requires `undefined`. It uses a key nothing reads — never `scopeAdmin` — so a red run cannot grant anyone dominion.
- **Every `@mesh` member kind gets a limb that PASSES**, not only a refusal: a marked method and a marked getter each reach their target, and a getter gate's guard runs before its body does. ⚠️ **The getter limb must assert the GETTER path, not a call** — a criterion phrased on "calls" is satisfied by a method-only test and leaves the getter entry unmeasured. It asserts a getter gate's body runs **once** per chain (§ *The request leg* derives the three; § *Gotchas*, item 6 measures **two** for a METHOD gate, so do not substitute that number), and that an `async` getter is either refused with its own message or proven to work. ⚠️ A limb MUST assert that an `@mesh() accessor` and an `@mesh()` field are REFUSED — they are cut, not merely unbuilt, and a rule that quietly admitted one would satisfy every other limb here. A rule that refuses everything satisfies every refusal limb in the table above, and these are what catch it.
- **The whole-suite run IS a criterion, not a cleanup step.** `npm run test:code` plus a `drive.ts all` sweep is what shows the `Object.prototype` rule and the deleted `svc` exemption broke no existing chain (§ *Gotchas*, items 4 and 7). `live.md` requires the sweep after changing anything other scenarios depend on, and every scenario depends on this executor.
- **Regression guards for what must keep working, green before and after:** `calls.mdx` § *Operation Nesting*'s own `@check-example` target, `packages/mesh/test/for-docs/calls/calculator-client.ts` — a browser client nesting two `@mesh()` calls as arguments, which is the ONE positive control for legitimate nesting and is already written and already run; a 4-arg handler using `$result`, a stored alarm continuation firing, `svc.broadcast`'s flat branch reaping a disconnected subscriber, a legitimate gate chain such as today's `dagTree().setPermission(…)`, and **the `ctx`-rooted handler THE ENTRY RULE names as what must keep working** — `this.ctn().ctx.storage.kv.put('cache', remote)`, which appears only in JSDoc today and is the one carve-out with nothing exercising it.
  - ⚠️ **The `ctx`-rooted limb is not redundant with the others.** every listed flag-off guard roots at an explicitly undecorated **method**, and `svc` is a prototype getter, whereas **`ctx` is a constructor-assigned own property the descriptor walk cannot see** — so it is the exact case the specified lookup would miss. ⚠️ **`@lumenize/fetch`'s proxy round trip is deliberately NOT on this list** — it breaks by design (§ *What needs Larry*, item 6), so a phase that finds it red has found the intended outcome, not a regression. They catch a fix that closes a hole by breaking a service, which is exactly the risk § *Gotchas* names.
- **They stay committed** as the regression suite once the fix turns them green.

**The docs change what `@mesh` IS, not only what it guards, so they are phase work rather than a tidy-up.** A page saying "marks methods" now describes a decorator we do not ship, and a user-developer who reads it will not know a property can be an entry at all.

- **Every page describing `@mesh` as a METHOD decorator states the member kinds that ship.** `mesh-api.mdx` § *Decorator: `@mesh()`* opens *"Marks methods as mesh entry points"*, and the per-node-type pages each characterise the shared API the same way. **Grep `@mesh` across `website/docs/` — the whole tree, not `website/docs/mesh/`** — since `nebula/nebula-client.md`, `introduction.md` and `fetch/index.md` all carry method-only framings. ⚠️ `nebula-client.md` matters most, and **the artifact its criterion asserts over is the EMBED, not the page**: Studio's generation loop reads `apps/nebula/src/platform-embed.ts`, generated from `apps/nebula/platform/` plus `website/docs/nebula/*.md` and served to the model from `PLATFORM_FILES`. Editing the page without running `node apps/nebula/scripts/gen-platform.mjs` and committing the embed leaves the loop reading the stale method-only framing **and** reds `apps/nebula`'s suite, since `gen-platform.mjs --check` is in its `test` script — surfacing under this file's own whole-suite criterion as an unexplained failure.
- **"Allowlist" goes, because there is no list.** The whole mechanism is `(target)[MESH_CALLABLE] = true` in the decorator and `method[MESH_CALLABLE] === true` in `isMeshCallable` — a flag on the member, no array, set or registry anywhere. The word implies something to look a candidate up in, which is why the sibling task has to say a node's surface is *"read off that class's own prototype and stated as an inventory, never a count"*. It also now covers two mechanisms with different scopes, since the walk rules are unconditional and the member-level check is not. **The replacement vocabulary is already in the repo, so nothing is coined:** `@mesh` **marks** a member (the decorator's own JSDoc), a marked member is **mesh-callable** (`isMeshCallable`, and the runtime error text), the set of them is the node's **mesh surface**, the check at op 0 is the **member-level check**, and the fence past it is the **walk rules**. ⓘ *Member-level* rather than *entry* because `onBeforeCall` also runs at the entry; what distinguishes this one is that it decides per member, where passage decides once for the whole node.
  - ⚠️ **ADR-007's widened sentence joins the when-the-fix-lands list, and this file nearly shipped the defect it names one bullet below.** This task rewrote it to *"are never an entry op, so nothing checks them"*, the ADR mentions the fence nowhere, and the file records the ADR as **done** — so once the walk rules are unconditional that sentence is incomplete in exactly the way the four JSDoc parentheticals are. It needs the same one-sentence addition (past the entry, the walk rules still refuse the six keys and `Function.prototype`), as a phase criterion. ⓘ *"Them"* scopes to a capability's methods, so the ADR is incomplete rather than false.
  - **TWO files of standing guidance are conformed, not all of it** (2026-09-24, done ahead of the phases because an ADR and an always-loaded rule steer every later reader and every review panel): [ADR-007](../docs/adr/007-shared-node-security-core.md) and `.claude/rules/mesh.md` now say *member-level check*. One ADR-007 sentence was improved rather than renamed — a capability's methods *"need no allowlist entry of their own"* became *"are never an entry op, so nothing checks them"*, which is what it was reaching for, since there are no entries to need.
  - ⚠️ **`CLAUDE.md`'s own table counts JSDoc as standing guidance, so `website/docs/` is the WRONG instrument for the rest.** A second one is needed: `grep -rn 'allowlist' .claude/rules packages/*/src apps/nebula/src`, discarding the CORS, `allowedHosts` and `PUBLIC_FIELDS` senses that legitimately keep the word. It finds a rule as well as source — `.claude/rules/testing.md` states the retired noun *and* the pre-fix rule in a file that loads for every test the phases will write.
  - ⚠️ **FIVE JSDoc sites need a SENTENCE ADDED, not a word swapped, and no grep-and-replace will produce it — and none of the four a grep finds is a reaper.** `star.ts`'s `onOntologyPulled`, the two `onInviteResult` forwards in `star.ts` and `galaxy.ts`, and `resource-data-plane.ts` each gloss the response leg as *"(allowlist off, scope-check on)"*. The fifth, `profile.ts`'s `onProfileBroadcastResult`, carries neither that phrase nor the word at all, so no instrument reaches it. Once the prototype fence is unconditional that parenthetical is **materially incomplete** — the member-level check being off no longer means nothing is checked — and it is the note a builder reads at the moment they choose whether to decorate a reaper. ⓘ These are edited **when the fix lands, not before**: they would otherwise describe behaviour that does not exist, which is the un-annotated divergence `docs/vision/auth.md` just needed two blockquotes to repair.
  - **`tasks/backlog.md` quotes two JSDoc comments as VERBATIM by path** — `lmz-api.ts` and `lumenize-worker.ts`, *not* two of the five above — so rewording either source turns a quotation into an invented one (`workflow.md` § *Referring to things across files*). ⚠️ **Neither was ever verbatim**: the row drops *per-method*, and its `lmz-api.ts` line pointer resolves to fire-back transport logging rather than the JSDoc. So the fix is not re-quoting but replacing the quotation with a characterisation and a corrected pointer. § *Backlog rows this task trips* carries that row.
  - **What remains is user-facing and decision-dependent:** `website/docs/mesh/index.mdx` and `security.mdx` each carry a *"(method allowlist)"* table cell, where both words change — the noun for this reason and `method` for § *What needs Larry*, item 1. Sweep `website/docs/` with the `@mesh` grep above rather than these two paths.
  - **Usually the fix is to delete the noun and state the rule.** Where a sentence wants a mechanism name and reads worse for it, say the rule instead: *"a chain's entry op must name a mesh-callable member; nothing later in the chain is checked."*
  - ⚠️ **The sibling task file is deliberately NOT swept.** `nebula-data-plane-owns-its-guards.md` uses the old word throughout to describe today's behaviour, and it re-runs its Stage 2 after this lands; conforming it now is churn on prose that pass will rewrite.
  - ⚠️ **Keep the word where a list exists** — [ADR-012](../docs/adr/012-global-profile-visibility.md)'s `PUBLIC_FIELDS` is a real allow-list of three field names and stays one, as do the CORS allowlists in the routing docs and `nightly-pass`'s known-RED list. The test is whether you could print the list.
  - ⓘ If fields are ever brought in, a per-class name registry appears and that one member kind genuinely has a list — the only place in this mechanism where the word would have fit.
- ⚠️ **`.claude/rules/mesh.md` § *`lmz.call` 4-arg* escapes ALL THREE named instruments and states the deleted mechanism as a MUST.** The `@mesh` grep is scoped to `website/docs/`, `grep allowlist` returns nothing in that file, and the `clientInstanceName` grep was scoped to source — yet that section carries the same *"add `@mesh()` only when… forwarded from a tier Worker"* sentence as a requirement, and its canonical `@mesh() onBroadcastResult` example reads `clientInstanceName` off the error, the field § *R2* deletes. Both the MUST and the example change, in an always-loaded rule. `website/docs/mesh/broadcast.mdx` states the same field as the published API contract in prose and joins the pages the phases edit.
- **`creating-plugins.mdx` needs an edit no grep will find** — it documents `doInstance`, `ctx` and `svc` as the plugin extension point and contains **zero** `@mesh` occurrences. It is the page that has to say those stay `protected` and why the prototype fence and the deleted `svc` exemption close the hole without touching them.
- **`docs/vision/auth.md` is `status: accepted`, describes the TARGET in present tense, and this task moved the target — so it was edited ahead of the phases (2026-09-24).** M4 now states the target: only marked members are reachable, and the walk onward never arrives at `ctx`, `env`, `svc` or anything unmarked on the node. The fence was folded INTO M4 rather than added as a fourth layer, since it is a property of the callable-surface layer rather than a gate you separately pass — so § *Inside the node*'s *"Three things still stand"* is untouched.
  - ⚠️ **That doc's `working_agreement` makes `grep -n '^> \*\*Today' docs/vision/auth.md` the COMPLETE register of what is not built yet, so target prose without a note is a claim that it IS built.** Both divergent passages now carry one — M4 and § *Inside the node* — and **this task deletes them when the fix lands**, which is a phase criterion rather than a tidy-up. Without them the one gap that is a live vulnerability was the only one the register could not enumerate.
  - ⓘ **What M4 does NOT promise, deliberately:** that a marked member cannot hand back the node. `@mesh() get self() { return this }` is the author's own foot-gun and is risk-accepted (Larry, 2026-09-24) — the framework fences the walk, not what an author puts behind a door it marked. Do not grow that sentence into a list of ways to misuse the decorator.
  - ⓘ **That doc was 59.9KB before this task touched it and is 61.3KB now — every byte of the overage is ours**, about half of it the two gap notes, whose own deletion repays it when the fix lands, and the rest M4's rewrite. **The trim is this task's debt and is still owed**, but it is no longer a gate: the `docs/vision` budget went 60KB → 80KB on 2026-09-24 (Larry), because the gate's only cheap satisfying edit was to DEFER a decision rather than trim, and it forced exactly that once here — M4's fence correction was written and reverted over ~90 bytes before the budget moved. `scripts/check-prose.mjs` carries the reasoning at its `docs/vision` entry.
  - ⚠️ **M4 is CORRECTED on both counts (2026-09-24), and it SPLIT into sub-bullets doing it.** Its fence sentence used to say *"Two doors"* and now names all six keys plus the `Function.prototype` clause it had never carried; and its promise is now scoped, since *"nothing else on the node can be called or read"* was false on the response leg — ADR-007 sanctions a result-delivery running with the member check off, and the sibling's D5 **depends** on that, since it is what keeps `resourcesResults` request-closed and response-open. ⓘ The split was forced rather than chosen: at four concerns in one bullet M4 hit the vision genre's 150-word longest-bullet budget at 178, which is `prose-voice.md` § *Information-outline a paragraph that answers more than one question* arriving as a gate. The numbered M-walk is untouched.
- **`managing-context.mdx`'s `requireMeshDecorator` row is the one that states the RULE**, so it changes meaning rather than wording: *"the entry-point method must have `@mesh()`"* becomes the first op naming a marked member. Its *"Set to `false` only for trusted chains you created yourself"* becomes true rather than aspirational once R1 lands, and § *R3* is what makes it enforceable — say so there, since that row is where a reader looks for it.
- **The getter gate ships as a CHECKED example carrying BOTH legs.** One marked getter and one unmarked one on the same class, because the asymmetry is what readers get wrong: a marked gate is request-open, an unmarked gate is request-closed and response-open, and the absence of the decorator is what does the second. ADR-007 has to argue it in prose — its § *Decision* states the asymmetry as a sentence, that turning the member-level check off is not turning the guard off — where two adjacent lines show it. ⓘ Characterised rather than quoted on purpose: this task's own vocabulary sweep reworded that sentence, and an earlier draft here quoted the pre-sweep wording, which `workflow.md` § *Referring to things across files* calls an invented example. The example also carries the property a reader cannot infer — **an unmarked getter is refused without running**, which is why the lookup reads descriptors rather than the value.
  - **Home:** `packages/mesh/test/for-docs/security/`, whose `team-doc-do.ts` and `user-profile-do.ts` back every `@check-example` block in `security.mdx`. A gate pair belongs beside them, and `mesh-api.mdx`'s `@mesh()` block turns from `@skip-check-approved('conceptual')` into a `@check-example` against it.
  - ⚠️ **Teach it on a NEUTRAL class, not on `resources`.** The real pair — `@mesh() get resources` and the undecorated `get resourcesResults` — is Phase 7 of [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md) and does not exist yet; documenting it here would publish an example of unbuilt code. That task documents the real pair when it builds it.
- **`continuations.mdx` line 48 is EDITED, not merely re-verified — it states the promise and teaches how to cross it in the same sentence.** It carries the boundary quote in § *Context and current state* and then *"For reaching a base class's `protected` `ctx`/`env` through a continuation proxy, use the `Unprotected<T>` helper instead of widening the member."* The second half goes or is re-scoped with the type itself (§ *The request leg*, its `Unprotected<T>` bullet); the first half is verified last, against merged code.
  - ⚠️ **A THIRD clause on that line is the one with teeth and is easy to read past:** *"Add `@mesh()` only when the same handler must also be dispatched remotely (e.g. a `svc.broadcast` result handler forwarded from a tier Worker)"* — advice whose output is exactly the bare-`@mesh()` reaper § *R2* names as the request-leg vector. It gains the consequence: a fire-back handler needs no mark, and a mark on one makes it callable as an ordinary request with caller-chosen arguments. ⓘ Do **not** write that the tier reason is dead — it is dead only inside Nebula (`directThreshold: Infinity`); an external consumer on the default threshold with a bound tier Worker still must mark a forwarded reaper (§ *Gotchas*, item 3).
- **`mesh.md` § *Object-capability access* has a sentence that this task turns false**, not merely reworded: *"(`svc.*` chains are the framework's built-in version — they skip the member-level check entirely.)"* They stop skipping it, because `svc` stops being an entry (§ *The request leg* § *no `svc` exemption*). It reads correctly today, so it is phase work rather than part of the vocabulary sweep.
- **The GATE EXAMPLES change everywhere they are taught, because the recommended spelling changed.** A zero-argument gate is a getter — `@mesh(requireAdmin) get admin()` — and a gate taking arguments stays a method. ⚠️ **The method gate is NOT deprecated and nothing refuses it**; what changed is which one an example should show. `docs/adr/007-shared-node-security-core.md` § *Decision* is already updated as the one commitment-level instance; the rest are under `website/docs/mesh/` and `.claude/rules/mesh.md`. **Find them with the `@mesh` grep over `website/docs/` rather than from a list here** — a snapshot would be stale by the time anyone reads it, and the point of grepping is that the sweep is one pass over every page that teaches a gate.
- **`mesh.md` § *Object-capability access* gains two things it does not carry today** (§ *Gotchas*, item 5), both guidance rather than rules the framework enforces. **What a gate hands back:** the whole of what the caller may then read and call, so hand back only methods (including getters) and take care not to hand back `this`, `this.ctx` or `this.svc` by accident. **What a getter entry owes:** side-effect-free, synchronous, cheap, idempotent — a gate returns a surface and does nothing else, and every other entry is a method whatever its arity. ⚠️ Keep it to that — it MUST NOT become a catalogue of ways to misuse the decorator. `feedback_check_example_exact_over_wildcard` governs any example it gains — exact match over `// ...`.
- **The published surface breaks in several ways, and the durable flag is a backlog row rather than this file. ⚠️ State them structurally: `tasks/backlog.md`'s row is titled *"three changes"*, lists three and closes on *"all three"*, so a count there is already falsified and a new count would falsify again.** `meshFn` goes (two barrel exports, no page mentions it), `Unprotected<T>` goes (a barrel export plus the `continuations.mdx` sentence), **`svc` stops being reachable from the wire — the break with no export to grep for**, since an outside caller's `ctn<T>().svc.…` still compiles and fails at runtime, and **`@lumenize/fetch`'s proxy callback stops arriving**, which is the same break reaching the one published consumer of it. `.claude/rules/workflow.md` § *Releases* requires the next release be flagged, and a task file archives, so the obligation lives in `tasks/backlog.md` § *Lumenize Mesh* where it is read per-row (`workflow.md` § *Referring to things across files*).

## Backlog rows this task trips

Each row below states something a later reader would act on, and this task's deliverables falsify or narrow it. Found by reading rather than by a complete sweep, so treat the list as open.

- **`directThreshold: Infinity`** (§ *Lumenize Mesh*) says *"Lifting it takes all three together"*. ⇒ **The count is what breaks, not the list.** This task adds TWO conditions and the sibling adds its own, which is the sibling's to record; the row states its conditions structurally instead of counting them. **First**, an undecorated forwarded reaper would meet the member-level check on the way through `__executeOperation` — which costs nothing until the sibling sheds those decorators (§ *Gotchas*, item 3). **Second, and it is a correctness condition rather than a cost:** `__forwardBroadcastResult` pre-fills a handler chain and then sends it over a fresh `lmz.call` to a generic request door, which cannot tell filled data from a template (§ *R1*). Unpinning the tier without changing that re-opens R1 on the forwarded path. **The fix is to stop pre-filling** — forward the unfilled chain plus the result and let the receiving node substitute locally, as every other path does — and it also carries the callee § *R2* needs, so the two conditions have one answer.
- **`subscriptionRequired` is broken** (§ *Lumenize Mesh*) diagnoses the expired-token branch at the exact Gateway site § *R2* converts, and argues the conflation itself is the bug: *"a live-socket-expired-token client is self-healing."* ⇒ **Half of it lands here.** § *R2* gives that branch its own error class, so the reaper's name guard stops matching it and a self-healing client is no longer reaped. What stays owed on the row is the wider conflation — the Gateway deciding reachability from its grace alarm while the Star decides it reactively, with the two uncoordinated.
- **The `globalThis` registration row** rests on *"the repo registers zero classes"*, which a grep for `(globalThis as any).<Name> =` over `packages/*/src apps/nebula/src` falsifies. ⇒ The row keeps its verdict: the name guard stays the contract, and § *The response leg* leans on it rather than on `instanceof`. What it gains is the corrected premise — **registrations exist**, stated as that grep rather than as a number — which strengthens the row's own argument, since a check that varies by bundle is worse where registrations actually exist. ⚠️ **State it as the grep, not a count.** An earlier draft here named three files and concluded "three classes"; all three register the SAME class, `ClientDisconnectedError`, and the real population is three distinct classes across six sites — `FetchTimeoutError` and `LoginRequiredError` too, and a fourth `ClientDisconnectedError` site in `lumenize-container.ts`. **Four modules registering one class is itself the interesting fact for that row**, since whichever loads last wins.
- **"Improve continuation ergonomics"** (§ *Lumenize Mesh*) ⇒ **neither issue is settled by this task, and one claim about it was wrong.** Issue 1's `$defer` want SURVIVES, because nesting survives (§ *The request leg*), and it lives in the very loop R1 rewrites — so the row gains a line that the two are designed together or `$defer` pays for the rewrite twice. Issue 2, `this.ctn().handleResult` with no call, is **untouched**: a get-only handler chain runs on the response leg, where the member-level check is off by design, so it stays a silent no-op.
- **The compose-site sweep** (§ *Nebula*) warns that *"a method on a nested plain object is not in the mesh surface"*. A marked field would have refuted that. ⇒ Fields do not ship (§ *The request leg*), so the row stands as written — and it is worth a line saying a getter gate is how a plane exposes one.
- **The task-file-handle sweep** (§ *Testing & Quality*) quotes `lmz-api.ts` ~:896 and `lumenize-worker.ts` ~:186 VERBATIM to show what a `(D5)` citation stands for. Both JSDoc comments are ones this task rewords. ⇒ The row gains a line: reword those two and the quotations become invented examples, so whoever edits the source updates the row in the same pass — the defect `workflow.md` § *Referring to things across files* describes, arriving from the other direction.
- **The TTL-sweep row** (§ *Nebula*) owns the only tracked third reap and has no disposition here. ⇒ It gains one clause: decision 3 gives the expired-token branch its own error class, so the reactive reap's name guard stops matching it, and **a client that lapses and never returns keeps its row until the next push finds no socket** — a further reason the sweep is wanted. The row's own cited sentence stays true as written.
- **The release-flag row** (§ *Lumenize Mesh*) is titled *"three changes"*, lists three and closes on *"all three"*. ⇒ **This task falsifies the count and adds a break with no home** — `svc` unreachable from the wire, plus `@lumenize/fetch`'s proxy callback. The row states its breaks structurally with no count in the heading or the close condition, and repoints its `CLAUDE.md` § *Releases* citation at `.claude/rules/workflow.md` § *Releases*, which is where that MUST actually lives.
- **Broadcast-to-client could go fully async** (§ *Lumenize Mesh*) proposes replacing the synchronous ack with a Gateway fire-back. ⇒ **The row gains a CONDITION.** Nothing is owed on the ack's *shape* — § *R2* adds nothing to it, so the leg can move without dragging a delivery-verdict shape along, and a design that added one would have owed this row a line. But R2 creates a dependency the row must carry: the callee is set on `callContext` in `dispatchEnvelope`, which the reaper reaches on the **synchronous ack path**, and an early-ack Gateway fire-back arrives through `executeEnvelope` instead — where the node stamps its own name, not the client's. `LumenizeClientGateway extends DurableObject` directly with no `lmz` identity, so it cannot fall back on `fireResponse` either. **Whoever moves the leg carries the address, or silently re-breaks the reaper.**

## What needs Larry

Every decision here is settled. They stay listed with their answers, so a later reader sees what was decided rather than wondering what was skipped — and § *The request leg*, § *The response leg* and § *Backlog rows this task trips* carry the reasoning. The list is append-only, so a later addition does not renumber what an earlier file already cites.

1. ✅ **DECIDED 2026-09-24 — methods and getters ship; fields and `accessor` do not. A getter is the form for a GATE; every other entry is a method, whatever its arity.** Both shipping kinds carry the mark on their function value. A field would need a second carrier, `workflow.md`'s named exception to the cost test. `accessor` was cut later the same day on different grounds: it costs only a two-line branch, but a chain can only `get` and `apply`, so a marked `accessor` is a marked getter with an unreachable setter — a second spelling, not a capability. Both are additive later. The gate form is a **getter** where the entry takes no arguments, which also makes `ctn<Galaxy>().resources.transaction(…)` match the `client.resources.transaction(…)` the sibling pins — D5 and D6 there are amended to match.
   - ⚠️ **The amendment VOIDS that file's own safety assertion, so the corrected instrument is recorded here rather than left for its Stage 2 to rediscover.** It prescribes `expect(isMeshCallable(Galaxy.prototype.resourcesResults)).toBe(false)` and calls it what catches *"the one edit that would otherwise open every continuation target to any logged-in browser"* — but reading a getter off the prototype **invokes** it with `this === Galaxy.prototype`, so the `#resources` private-brand check throws; and absent the throw it tests the returned surface, which is `false` whether the getter is marked or not. **The descriptor form is the fix** — `isMeshCallable(Object.getOwnPropertyDescriptor(Galaxy.prototype, 'resourcesResults')?.get)` — the same lookup THE ENTRY RULE already specifies for the executor, and this file's own member-kind limbs use it too. § *The request leg* carries the reasoning.
2. ✅ **DECIDED 2026-09-24 — the same rule applies one level down.** A nested marker's op 0 must name a marked member. `calls.mdx` § *Operation Nesting* and its `@check-example` keep working unedited, since every nested chain there already opens on a `@mesh()` method. Refusing them off the wire was rejected: `callChain[0]` names the original origin, so it cannot tell a client's chain from a node's chain serving that client. § *The request leg* carries the reasoning.
3. ✅ **DECIDED 2026-09-24 — a client whose token just lapsed is not reaped, and it gets its own error class to say so.** A live socket with a lapsed token is back in about 100 ms, so the reaper's name guard simply stops matching it. The wider conflation stays owed on `tasks/backlog.md`'s `subscriptionRequired` row, which points back here. § *R2*.
4. ✅ **DONE 2026-09-24 — the milestone has a row for this task**, `deploy`-gated and ordered above ④, and its decision 3 now names this file as ④'s remaining gate. § *Relationships* states the ordering fact rather than borrowing *"before the wipe"*, which that file drains of force.
5. ⊘ **MOOT 2026-09-24 — the thing it named is not being built.** `$undeliverable` was to be a distinct ack shape for delivery failure; taking the victim from the address left it with no consumer, so it was dropped along with the protocol change it required. § *R2* records the trigger that would bring it back.
6. ✅ **DECIDED 2026-09-24 — `@lumenize/fetch` is all but deprecated, so the `svc` exemption's deletion breaks its proxy callback and we accept that rather than build a door.** Larry runs none of it in production and doubts anyone else does. Its bugs stay ours to fix where a fix is cheap — it is published — but **it does not get new framework surface built to keep it working**, and the replacement doors considered (a gate on `LumenizeDO`, a carrier installing plugin members) are priced against nobody. § *Gotchas*, item 4 states what actually breaks.
   - ⚠️ **Deprecated is not dead, and the difference decides two things.** `@lumenize/fetch` comes back **if it ever supports streaming** — the one case where proxying a fetch through a Worker genuinely saves money, and the reason Larry stopped using it is that every other case turned out rarer than expected (2026-09-24). So its suites are **`it.skip`ped rather than deleted** (Phase 5), because a revived path would otherwise have to be proven from nothing.
   - ⚠️ **The re-derive trigger: a revived `@lumenize/fetch` needs a wire door, and the options are already priced.** A plugin cannot put a member on its host — `NadisPlugin.register` writes only the global service registry — so any chain reaching one must open on `svc`, which this task stops being an entry. The two doors that would work are a narrow `@mesh()` gate on `LumenizeDO` over the plugin half of the registry, and a carrier that installs marked members. **Neither is built now, and neither is foreclosed** (`calibration.md` §4: re-derive when the justification expires, never pre-guard).
   - ⚠️ **A REVIEW PANEL MUST NOT GROUND A FINDING IN `@lumenize/fetch`.** "This breaks the fetch round trip", "the fetch hole needs its own limb", "the new door's signature is wrong" and anything else resting on that package being kept alive is out of scope by decision, not by oversight. The two `svc.fetch` rows in § *Criteria* stay only because they assert the exemption is gone — they are tests of the **rule**, and the package is merely the vehicle that made the hole reachable.

## Constraints and future state

**Constraints.** [ADR-003](../docs/adr/003-continuation-messaging.md) — continuations are the only call shape, so a fix must not break nesting between mesh nodes or the fire-back. [ADR-007](../docs/adr/007-shared-node-security-core.md) — the guard core is shared, so the fix lands once in the package for every node type. `CLAUDE.md` — a package gap is fixed in the package, never worked around in Nebula. `security.md` governs the fail-closed behaviour.

**Future state.** Every bold row of the probe table turns refused, and every plain row still reads as it does today — including the three that reach something undecorated and say on the line why they stay: past a gate that is the author's choice to make, and on the response leg it is the node's own chain running. `@mesh()` marks a method or a getter, and every page that describes it as a method decorator says so — found by the `@mesh` grep over `website/docs/`, never from a list. `mesh.md` § *Object-capability access* and `continuations.mdx` state the boundary as the code enforces it, including what a gate may hand back.

## Phases

Numbering is executable order. § *Criteria to carry into the phases* is the source for every
criterion below; a phase names which rows it owns rather than restating why they exist.

⚠️ **Standing-guidance edits are deliberately pooled in Phase 10 rather than sitting in the phase
that causes them.** An enumeration's correctness is a property of the task's END state: the four
JSDoc parentheticals are falsified by Phase 4, and ADR-007's sentence by Phase 4 too — so any earlier home ships a rule that is wrong by the time the task lands
(`/write-task`, the enumeration trap). Code comments a phase's own diff creates stay with that phase.

1. **Every hole is proven red before anything is fixed.** Write one limb per row of § *Criteria*'s
   table, run it against today's code, and record the result in the phase's commit message. The red
   run also answers what § *Context and current state* leaves open — whether each hole is reachable
   from a real browser session rather than only from the executor.
   - **Success criteria (capable of failing):** every non-✅ row is RED, each matched on its refusal
     message rather than on a boolean, and each with the mutation that isolates it; both ✅ rows are
     GREEN; every regression guard listed in § *Criteria* is GREEN. **The `__defineGetter__` row is the
     one whose status is unknown** — whether a chain can obtain a function argument at all is what this
     phase measures, and either answer is a finding. The fire-back half of the marker-shaped-reply row
     is the other: § *R1* calls it open, so it is checked here rather than assumed red.
   - **Every limb lands SKIPPED, and a later phase un-skips its own.** Write them all, watch them all
     fail, then skip them all; each fixing phase removes the skip from the limbs it closes and asserts
     the rest of the registry is still green. That is what makes a later *"row X is GREEN"* attributable
     to one phase: without it, Phase 1's reds make the sweep non-zero by construction all the way to
     Phase 8, and `live.md`'s first-failing-limb rule then hides whatever comes after the first hole.
     ⓘ For vitest limbs this is `it.skip`. For `/live` it needs a small harness change — `SCENARIOS` in
     `drive.ts` is a plain name→module map with no skip flag, so an unwritten-off scenario would simply
     be absent and therefore invisible; **add a `skip` flag the sweep reports**, so a parked scenario
     prints rather than vanishing. Each scenario is registered here with `needsContainer` stated.
   - **Both tier carve-outs this phase owns state their reason IN THE TEST FILE**, not only here —
     `live.md` puts that MUST on the file, which outlives this task file (§ *Criteria*). And every limb
     uses a harmless payload: `svc.sql(['SELECT 1'])` proves arbitrary SQL runs as well as a `DELETE`
     would, because the harness can target a deployed worker through `HARNESS_TARGET_URL`.
   - **Mutation note:** the phase's own product IS the mutation evidence. A limb that cannot be shown
     red here does not ship; deleting the criterion is the correct outcome when the hole turns out
     not to exist, and saying so is the finding — **except** where § *Criteria* marks a row
     green-before-and-after, which is kept deliberately.
   - ✅ **DONE 2026-09-24. Every non-✅ row is RED and each red is the hole itself**, not an absence:
     the executor handed back `the-secret` for an `env` read, `ran: SELECT 1` for `svc.sql`,
     `[Function Facade]` for `constructor` past a gate, and `[Function get __proto__]` for
     `__lookupGetter__`. From a REAL logged-in browser session the same ten chains were permitted
     through the Gateway, ending with a write that landed on the Galaxy's `Object.prototype` and
     was read back by a second chain. Both ✅ rows are GREEN and every positive control was
     mutation-isolated. The two rows § *Criteria* marked unknown are answered there.
   - ⚠️ **One finding with no row, and it is a user-developer foot-gun rather than a hole:
     OVERRIDING a `@mesh()` method drops the mark.** The mark lives on the function value, and a
     subclass override is a new function, so the Gateway's push then fails the client's own
     member-level check and the subscription's initial snapshot never arrives — a hang with no
     subscriber, not an error. It cost an hour of this phase. `Studio` generates `NebulaClient`
     subclasses, so it wants a backlog row rather than a fix here.
   - ⓘ **No fix lands.** Member-kind limbs are NOT written here — a marked getter does not exist
     until Phase 5, so those limbs are new capability rather than holes and land with the capability.

2. **The executor walks a chain once, carrying the parent forward.** `findParentObject` restarts from
   the DO and re-runs every earlier op, synchronously and unawaited, which runs a gate body twice per
   `apply` and throws `parent[methodName] is not a function` on an `async` gate (§ *Gotchas*, item 6).
   Replacing it with a parent carried along the walk is the loop every later phase edits, so it lands
   first and alone.
   - **Success criteria:** a gate that counts its calls runs **once** per chain; an `async` gate's
     chain completes; and a gate handed a nested marker receives the RESOLVED value on its only run.
     Unit tier against a stand-in object, and the test says why it needs no running system.
   - **Mutation note:** restore the re-run and the call count goes to two; drop the `await` and the
     `async` gate throws again. ⚠️ The resolved-value criterion needs its OWN mutation — pass
     `operation.args` at the single apply rather than the resolved ones — because the executor already
     resolves before it walks, so under the re-run mutation the FIRST run was always resolved and an
     assertion on it stays green.
   - ✅ **DONE 2026-09-24.** All three limbs were red first — the gate body ran twice, the `async`
     gate threw `parent[methodName] is not a function`, and the second run received the unresolved
     marker — and all three are green. `findParentObject` is deleted; `parent` now lags `current` by
     one op, which is what that function computed, so no call form changed. Four mutations, each
     isolating what it should: restoring the re-run reds all three, an extra awaited invocation reds
     the count alone, dropping the `await` reds the `async` limb alone, and raw args red the
     resolved-value limb alone.

3. **A filled chain is data, so the executor stops resolving it (R1).** Two entry points over one
   shared walk — a template resolves nesting, a filled chain does not — and the three same-breath
   substitution sites name the filled entry (§ *R1*). `__forwardBroadcastResult` is fixed by no
   longer pre-filling: it forwards the unfilled chain plus the result and the receiving node
   substitutes locally, which also carries the callee § *R2* needs. It lands before Phase 5 because
   it closes an open hole in the loop Phase 5 edits next, not for any ordering reason — substitution
   already precedes the executor unconditionally.
   - **Success criteria:** the marker-shaped-reply rows are GREEN on the local-handler path, on the
     node-to-node fire-back, **and** on a reaper-shaped handler with no `$result` marker, where the
     result is APPENDED — each asserting the named method did not run and the handler received the
     reply itself. The ADR-002 fidelity row is GREEN: a result carrying both marker keys arrives
     intact and unexecuted. `calls.mdx`'s nesting positive control, a `$result` handler, and a stored
     alarm continuation all stay GREEN — the first proves a template's final apply still resolves.
   - **Mutation note:** point a filled site at the template entry and its limb reds; cover only the
     replacement branch and the appended limb alone reds; skip the final apply on a TEMPLATE too and
     the `calculator-client.ts` control reds, which is what pins the two entries apart. Strip the two
     keys from the value instead and every marker limb goes green while the fidelity row reds.

4. **The prototype fence refuses the doors JavaScript opens on every object.** Six keys plus a `get`
   resolving on `Function.prototype`, from op 0, on every leg, at every flag setting — inside
   `executeOperationChain`, which is what makes the browser client and both `__localChainExecutor`
   getters inherit it by composition (§ *The request leg*). An empty chain and an apply-first chain
   become refusals rather than fall-throughs.
   - **Success criteria:** every fence row in § *Criteria* is GREEN, each on its OWN refusal message —
     `constructor`, `__proto__`, a `Function.prototype` member, and the four Annex-B accessors. The
     prototype-write limb asserts `({}).<key>` is still `undefined` afterwards, on a key nothing reads.
     The response-leg limbs are GREEN with `constructor` at op 1 **and** at op 0. The browser limb is
     GREEN. Empty and apply-first chains are refused, each on its own message.
   - **Suites this phase changes:** `packages/mesh/src/ocan/test/ocan.test.ts` — the apply-first case
     (asserts `10` today) and the `is not a function` message case are both REWRITTEN to assert the new
     refusals. `npm run type-check` and `packages/mesh`'s own suite pass at this commit.
   - **Mutation note:** close only `constructor` and the five other clause limbs red while every
     pre-existing row stays green; gate the fence on `requireMeshDecorator` and the response-leg limbs
     red; write it at the envelope seam instead of in the executor and the browser limb alone reds —
     which is the limb's whole reason for existing.

5. **`@mesh()` marks a getter, and the first op of a wire-borne chain names a marked member.** The
   decorator and the rule that gives it meaning land together, because a mark on a getter is INERT
   until the check moves to op 0: today the check fires at the first `apply` and keys on `prevOp`, so
   `ctn<Galaxy>().admin.addUser(u)` tests `facade.addUser` and never consults the mark on `admin`.
   Splitting them would leave a phase whose only green spelling is a bare `ctn().admin` read — which
   passes because reads are unchecked, the vulnerability itself. So this phase carries: the overload
   pair over `ClassMethodDecoratorContext | ClassGetterDecoratorContext` and no wider; descriptor
   lookup, so an unmarked getter is refused WITHOUT running; the `isServiceCall` exemption deleted
   outright; the same rule one level down for a nested marker's op 0; and the carve-out that a chain
   the node authored itself may still root anywhere, including `ctx` and `svc`.
   - **Success criteria — refusals:** the `env` read, a wire-borne `ctx.<anything>` read, the nested
     `env` read, `svc.sql(['SELECT 1'])`, the nested `svc` chain and the `svc.fetch` walk are all
     REFUSED. An `@mesh() accessor` and an `@mesh()` field are refused **at runtime**, not only by the
     compiler — an own-property fallback added beside the descriptor walk would defeat a compile-only
     check silently.
   - **Success criteria — the member kinds work:** a marked method and a marked getter each reach
     their target; a getter gate's guard runs BEFORE its body; a getter gate's body runs **once** per
     chain — which is what Phase 2 already makes true for a METHOD gate, so the limb is asserting
     that a GETTER entry inherits it rather than re-deriving a number; an `async` getter is refused with its own message or proven to work;
     and an unmarked getter is refused **without running**, which is the property that justifies
     reading descriptors rather than `parent[key]`.
   - **Success criteria — types:** `tsc --strict` accepts `@mesh()` and `@mesh(guard)` on a method and
     a getter and REJECTS both on an `accessor` and a field, spelled `@ts-expect-error` so widening
     the signature reds it (`packages/mesh/tsconfig.json` includes `test/**/*`).
   - **Success criteria — what must keep working:** the `ctx`-rooted node-authored handler, the
     `calls.mdx` nesting positive control, the alarm continuation and `dagTree().setPermission(…)` are
     all still GREEN. `@lumenize/fetch`'s proxy round trip is RED, which is the intended outcome
     (§ *What needs Larry*, item 6) and is recorded rather than fixed.
   - **Suites this phase changes, each named with its disposition.** REWRITTEN to assert the new rule:
     `ocan.test.ts`'s property-access chain at the default flag, its own-data-property `checkIdentity`
     case, and its `meshFn` nested-object case (`c.nested.deep.method(5)` — op 0 is `get 'nested'` on an
     unmarked field); `packages/mesh/test/lumenize-client-gateway.test.ts`; `test-worker-and-dos.ts`;
     `continuation-only-feasibility.test.ts`. **`it.skip`ped with a one-line reason pointing at
     § *What needs Larry*, item 6:** the eight round-trip tests in `packages/fetch/test/proxy-fetch.test.ts`
     and the seven in `test/for-docs/basic-usage.test.ts`. ⚠️ **Skipped rather than deleted because
     revival is live, not theoretical** — `@lumenize/fetch` comes back if it ever supports streaming,
     which is the one case where proxying genuinely saves money (Larry, 2026-09-24), and a deleted suite
     would have to be rewritten from nothing to prove the revived path. The two `svc.fetch` refusal rows
     stay ACTIVE in that same suite; they test the rule, not the package. `npm run type-check` and each
     touched package's suite pass at this commit.
   - **Mutation note:** keep the exemption and the two `svc` rows red; read `parent[key]` instead of
     the descriptor and the unmarked-getter-does-not-run limb reds; skip the recursion into nested
     markers and the two nested rows red while the top-level ones stay green; carve out `ctx`/`svc` by
     ROOT KEY instead of keying on the flag and the `ctx` read reds while the node-authored positive
     stays green, which is what pins the carve-out to the flag and nothing else; widen the decorator
     signature and the `accessor`/field limbs red at compile time.

6. **`meshFn` and `Unprotected<T>` leave the published surface.** `meshFn` marks a function reached
   through a path of `get`s, which is exactly what Phase 5 refuses; `Unprotected<T>` types a remote
   chain opening on `ctx`, so every chain written with it would now compile and throw.
   - **Success criteria:** `grep -rn '\bmeshFn\b' packages/*/src packages/*/test apps website` returns
     nothing outside a release note. The same grep for `Unprotected` returns **only** the two CORS table
     cells, `website/docs/{routing,testing}/cors-support.mdx` — an unrelated English sense this task does
     not touch, named here the way § *Criteria*'s `allowlist` bullet names its own discards. ⚠️ Do NOT
     narrow the pattern to `Unprotected<`: that misses `packages/mesh/src/ocan/index.ts`'s bare barrel
     export, which is what the mutation below relies on. ⓘ `continuations.mdx`'s `Unprotected<T>`
     sentence rides this phase, not Phase 9, since the grep cannot be clean without it.
   - **Suites this phase changes:** `packages/mesh/test/node-import.test.mjs` stops asserting the
     `meshFn` export. `npm run type-check` and `packages/mesh`'s suite pass at this commit.
   - **Mutation note:** leave either barrel export in place and its grep returns more than the two CORS
     cells. ⚠️ Scope the grep away from `dist/`, which is gitignored but present on a working tree.

7. **The framework tells a handler who the callee was, and a lapsed token stops looking like a death.**
   A `callContext` field set in `dispatchEnvelope`, `fireResponse` and `executeEnvelope` from sources
   the caller does not write (§ *R2*), and a distinct error class for the Gateway's expired-token
   branch so the reaper's name guard stops matching it.
   - **Success criteria — the field.** Each of the three sites OVERWRITES it unconditionally with THIS
     hop's source, and a wire-supplied value is DISCARDED — `dispatchEnvelope` from the instance the
     caller addressed, `executeEnvelope` from this node's own name, `fireResponse` from the fire-back
     return address. ⚠️ **Presence is not the criterion**: a set-if-absent implementation leaves an
     upstream node's name in place and the reaper reads someone else's address, so the security fix is
     silently a no-op. One limb per path, read back through a handler, since the reaper rows exercise
     `dispatchEnvelope` alone. Both spread sites that carry *"any later immutable field ride through"*
     are amended to exclude it, and `CallContext` labels it per-hop rather than Immutable.
   - **Success criteria — the lapse.** A client whose token lapses on a live socket is NOT reaped and
     its row survives the reconnect; the phase states whether the lapse is a real wait or
     `vi.setSystemTime`, which `testing.md` measures as moving the clock both isolates see. Both ✅
     reaper rows stay GREEN, and each reaps the RIGHT client.
   - **Mutation note:** set the field from a handler argument instead and the Phase 8 direct-call limb
     reds; add it to the Gateway's outbound rebuild and the withheld-from-client criterion reds; keep
     one error class for both conclusions and the lapsed-token criterion reds.

8. **Every reaper takes its victim from the address, and `clientInstanceName` leaves the error.** The
   field goes from `ClientDisconnectedError`, with the sites that stamp it; the reapers across
   `apps/nebula` and `packages/nebula-auth` read the callee instead. `ClientResultEnvelope`'s
   same-named field stays — the framework supplies that one (§ *R2*).
   - **Success criteria:** the forged-reply row is GREEN — the named client's row is intact and the
     REPLYING client's is the only one touched. The direct-call row is GREEN on both halves: the call
     was PERMITTED, and no subscriber row changed. `grep -rn 'clientInstanceName' packages/*/src
     packages/*/test apps/nebula/src .claude/rules website/docs` returns only the `ClientResultEnvelope`
     sites — § *R2*'s full scope, plus the test tier, which no narrower grep reaches. ⚠️ **Do not count
     the construction sites**: four spell the literal identifier and the rest pass `#getInstanceName()`,
     so a grep for the identifier misses them and `tsc` is what enumerates them all.
   - **The third package gets a BEHAVIOURAL limb, not just a grep.** `packages/nebula-auth/src/profile.ts`
     pushes through a hand-rolled `lmz.call` fan-out rather than `svc.broadcast`, so it is the one path
     § *R2* says differs — and a grep proves only that the field is gone, never that the callee ARRIVES
     there. Assert over the Profile's own push: a real disconnect reaps its subscriber row, and a forged
     reply reaps no other. Without it a Phase 7 miss on that path leaves every other criterion green
     while real cleanup silently dies.
   - **Suites this phase changes:** deleting the constructor parameter makes `tsc` enumerate every
     construction site, since `gateway-messages.ts` declares it as a parameter property — so
     `npm run type-check` IS the inventory here, and it is a criterion. `packages/mesh`,
     `packages/nebula-auth` and `apps/nebula` suites each pass at this commit.
   - **Mutation note:** restore the field on the error and the forged-reply row reds; convert the
     `apps/nebula` reapers (Star and Galaxy) but not `packages/nebula-auth/src/profile.ts`, and the
     third-package limb reds.

9. **The docs describe the decorator we ship, and one checked example carries both legs.** Sweep
    `@mesh` across the whole of `website/docs/` — not `website/docs/mesh/` — for method-only framings
    and for gate examples whose recommended spelling changed; add the getter-gate pair to
    `packages/mesh/test/for-docs/security/` on a neutral class, and turn `mesh-api.mdx`'s `@mesh()`
    block from `@skip-check-approved` into a `@check-example` against it.
    ⚠️ **This phase owns the ENTIRE `website/docs/` sweep, including the `allowlist` cells** — Phase 10
    keeps the standing-guidance instruments only. `index.mdx` and `security.mdx` each read
    *"(method allowlist)"*, where both words change, so splitting the page between two phases means
    fixing the same cells twice or half-changing them.
    - **Three pages no grep reaches, each named because no instrument finds them.** `broadcast.mdx`
      teaches a bare `@mesh()` reaper reading `clientInstanceName` — the exact request-leg vector
      § *R2* names — inside a `@skip-check-approved('conceptual')` block the checker never reads, and
      states the field as the published contract in prose; both go, and its `@mesh()` gains the
      consequence rather than simply being removed, since the tier reason is dead only inside Nebula.
      `creating-plugins.mdx` has ZERO `@mesh` and zero `allowlist` and documents `doInstance`, `ctx` and
      `svc` as the plugin extension point — it says those stay `protected` and why the fence plus the
      deleted `svc` exemption close the hole without touching them. `continuations.mdx`'s line 48 gains
      the consequence on its third clause: a fire-back handler needs no mark, and a mark on one makes it
      callable as an ordinary request with caller-chosen arguments.
    - **Success criteria:** `npm run test:doc` passes. The new example shows a marked getter and an
      unmarked one on the same class and states that an unmarked getter is refused WITHOUT running.
      After editing any `website/docs/nebula/*.md`, `node apps/nebula/scripts/gen-platform.mjs` has been
      run and the embed committed — `gen-platform.mjs --check` is in `apps/nebula`'s `test` script, so
      skipping it reds that suite rather than only the docs.
    - ⚠️ **The new fixture is DRIVEN, and that is a criterion rather than an afterthought.** It lands in
      the directory where `testing.md`'s `createTestingClient` ban was written after the `requireSubscriber`
      incident, and `npm run test:doc` runs only the `@check-example` checker — never
      `packages/mesh/test/for-docs/` — so a fixture class with no assertions passes this phase and the
      whole-suite run alike, never instantiated, while the published block teaches an access check the
      test never performs. Drive it `LumenizeClient` → Worker → Gateway → DO and assert BOTH halves:
      refused, then permitted.
    - **Mutation note:** revert the `mesh-api.mdx` block to the pre-fix wording and the checker reds;
      edit `nebula-client.md` without regenerating and `apps/nebula`'s suite reds; leave the fixture
      unasserted and the driven-both-halves criterion reds where `test:doc` would not.

10. **Standing guidance says what the code now does, and the suites prove it.** The `allowlist` sweep
    over `.claude/rules packages/*/src apps/nebula/src` (Phase 9 owns everything under `website/docs/`),
    the response-leg JSDoc parentheticals, ADR-007's widened sentence, `mesh.md`'s edits, the backlog
    rows § *Backlog rows this task trips* disposes of, and the deletion of `auth.md`'s two gap notes.
    - **`mesh.md` owes THREE edits, enumerated rather than counted:** its § *Object-capability access*
      `svc.*` sentence, which this task turns false; that section's two guidance additions on what a
      gate may hand back and what a getter entry owes; and § *`lmz.call` 4-arg*, whose MUST advises
      adding `@mesh()` to a forwarded reaper **and** whose canonical `onBroadcastResult` example reads
      `clientInstanceName` off the error. That last section escaped all three named instruments.
    - **The response-leg JSDoc population is FIVE sites and is not what an earlier draft called it.**
      The four `(allowlist off, scope-check on)` parentheticals are `star.ts`'s `onOntologyPulled`, the
      two `onInviteResult` forwards in `star.ts` and `galaxy.ts`, and `resource-data-plane.ts` — **no
      reaper among them**. The fifth is `profile.ts`'s `onProfileBroadcastResult` JSDoc, which justifies
      staying undecorated by the forgeable-field hazard Phase 8 retires and contains neither phrase, so
      no grep finds it; it is edited in Phase 8's own diff. State the rule structurally: undecorated
      stays right as hygiene, and what carries the security is the framework-supplied callee.
    - **Two backlog corrections this task owes beyond the disposition rows.** The release-flag row is
      titled *"three changes"*, lists three and closes on *"all three"*, while this task makes four and
      the fourth has no home — restate it structurally with no count, and repoint its `CLAUDE.md`
      § *Releases* citation at `.claude/rules/workflow.md`. And the task-file-handle row quotes two
      JSDoc comments as VERBATIM when neither ever was — both sources read *"only the **per-method**
      @mesh allowlist is skipped"* — so the quotation becomes a characterisation with a corrected
      pointer, which is what `workflow.md` § *Referring to things across files* asks for anyway.
    - **Success criteria:** `grep -n '^> \*\*Today' docs/vision/auth.md` no longer returns the M4 or
      § *Inside the node* notes, and returns every other note unchanged. No site glossing the response
      leg still says the member-level check being off means nothing is checked. `npm run test:code`
      passes, every limb Phase 1 parked is un-skipped, and `npx tsx apps/nebula/harness/drive.ts all` is
      green — the sweep is a criterion, not a cleanup, because every scenario depends on this executor.
      ⓘ Earlier phases already ran their own: `npm run test:code` on each phase touching
      `packages/mesh/src`, and `drive.ts all --fast` at the three executor seams (after phases 2, 5 and
      8), where a red scenario is signal rather than flake.
    - **Mutation note:** the guidance edits are prose and no test reds them, which is why they are
      pooled here and checked by the two greps rather than by a suite. The suite-and-sweep criterion
      is what catches a fix that closed a hole by breaking a service.
    - ⚠️ **Not swept:** `nebula-data-plane-owns-its-guards.md`, which re-runs its own Stage 2 after
      this lands, and ADR-012's `PUBLIC_FIELDS`, which is a real allow-list of three names.
