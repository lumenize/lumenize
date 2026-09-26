# Broadcast is core to every mesh node, and it delivers directly

**Status:** Pass 1 — design intent, for hand review. No phases yet. Rewritten 2026-09-26 after the review conversation, which grew the scope from one move to a move, a removal and one adoption.

**A deliberate detour** from [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md), which cannot collapse its host bridge until this lands. Still small enough for a **condensed process** (Larry, 2026-09-26): a hand review of this file rather than a `/review-task` panel, phases written straight after it, then a Stage 2 conformance pass only.

**Objective — every mesh node can fan one continuation out to many addresses, and every delivery comes from the node that originated it.** Today fanning out requires extending `LumenizeDO`, and above a hundred targets the delivery comes from somewhere else, which breaks two things that read the sender.

The sections below give what is true today, the three changes that follow, what the removal costs, and the one decision still open.

## Context and current state

**`svc` belongs to `LumenizeDO`; `lmz` belongs to every composer.** `get svc()` is declared on `LumenizeDO` alone, so a node composed the other way has no `svc` at all — not an empty one. `ComposedMeshDO(DurableObject, 'Profile')` in `packages/nebula-auth/src/profile.ts` is that node, in production today, and it therefore cannot reach `broadcast` by any path.

**What `broadcast` needs from its host is two things, and a bare composer has both.** `broadcast(doInstance)` reads exactly `doInstance.ctn` and `doInstance.lmz.call`, and `broadcast.ts` imports only from `./ocan/index.js`. Nothing in it touches storage, alarms, `onStart` or `fetch`. Its home on `svc` comes from one registration line in `lumenize-do.ts`, whose own comment scopes the consequence — *"always available on this.svc.broadcast for LumenizeDO subclasses"*.

**`sql` and `alarms`, its neighbours in that registry, are genuinely different**, which is why this task moves one service and leaves the registry standing. `Profile`'s own comment states the distinction from the outside: it has *"no `onStart`/`alarms`/`svc.broadcast` (a raw composer has no `onStart`…)"*. An alarm needs the `alarm()` handler `LumenizeDO` owns; a broadcast needs a continuation and a way to send it.

### The function has two branches, and the second one is broken

`broadcast` picks its branch on target count alone — a flat loop while `targets.length <= directThreshold` (default 100), and above that it hands the whole list to a recursive tier Worker. The two differ in **who sends the leaf call**, which is what `metadata.caller` is stamped from. On the flat loop that is the origin node; on the tier path it is the tier Worker. Three defects follow, none of them fixed:

1. **The dead-subscriber reaper deletes nothing.** `__forwardBroadcastResult` fires to the origin's `__handleResponse`, where `executeEnvelope` overwrites `callContext.callee` with the *receiving* node's own identity — so the reaper reads the broadcasting DO's own name and its `DELETE` matches no row. Nothing throws and nothing logs; the row just leaks.
2. **A caller-gated receiver refuses a legitimate push.** `NebulaClientGateway.onBeforeCallToClient` opens a cross-scope profile push only for `caller.bindingName === 'PROFILE'` and otherwise throws *Active-scope mismatch*. Past the threshold the caller is the tier Worker, so the fence correctly refuses — triggered by nothing but popularity.
3. **The client-origin branch is misrouted**, because `svc.broadcast` starts no fresh chain: `callChain[0]` is whoever originated the write, so a delivery failure is forwarded to that client rather than to the broadcasting DO. That same branch is also where a filled chain still reaches a client's push door, defended only incidentally — its op 0 happens to name a DO method.

**The tier is dormant, and doubly so.** `apps/nebula` binds no `LUMENIZE_BROADCAST_TIER`, and `lmz.call` validates its target synchronously, so without a pin the 101st subscriber would not degrade — it would throw and fail the transaction that triggered it. `NebulaDO.broadcast` pins `directThreshold: Infinity` to stop that. Nothing else reaches the tier: the only exercise anywhere is two `packages/mesh` unit tests that force it with `directThreshold: 0`, plus one browser bench built to measure it.

**Who calls broadcast today:** exactly one production site, `apps/nebula/src/nebula-do.ts`, plus two calls in `packages/mesh/test/test-worker-and-dos.ts` and five conceptual blocks in `website/docs/mesh/broadcast.mdx`. Everything else a grep finds is JSDoc describing the mechanism.

**The Profile hand-rolls what the flat loop already does.** Its `#fanout()` is the same three lines per target — `lmz.call(binding, clientId, remote, onResult, { onErrorOnly: true })` — and its `onProfileBroadcastResult` reads `callContext.callee?.instanceName` exactly as `Star.onBroadcastResult` does. It exists because `svc.broadcast` was unreachable *and* unsafe, and this task removes both reasons.

**And the address it stores is one a client can choose.** `subscribe` takes `subscriberBinding` from `callChain.at(-1)?.bindingName`, and the Gateway rebuilds the chain as `[verifiedOrigin, ...clientCallChain.slice(1)]` — so element 0 is stamped from verified sources and everything after it is copied from the client's own frame. A client that appends a hop therefore decides which binding the Profile stores and later calls. The consequence is not a wrong push but no pushes: `lmz.call` validates its target synchronously, `#fanout()` has no per-target catch, so one poisoned row aborts the loop and every subscriber ordered after it stops receiving updates — and no reaper clears the row, because the failure is not a `ClientDisconnectedError`.

## Design intent

**Three changes, in the order they depend on each other.**

1. **`lmz.broadcast(targets, remote, opts?)`, registered where `call` and `ctn` are registered**, so every mesh composer has it — a DO or a Worker. `broadcast.ts` keeps its module and its exported types; what moves is the registration line and which object the function hangs off. `svc.broadcast` goes with no alias: one production caller makes the sweep trivial, and an alias would be a second spelling of one capability.
2. **The tier branch is deleted**, and with it `__broadcastTier` and `__forwardBroadcastResult` (whose only callers are the tier itself), `BROADCAST_TIER_BINDING`, the `directThreshold` and `branch` options, and their two defaults. Every fan-out is then a direct loop from the origin node at any N, so the sender a receiver sees is always the node that decided to push. **This deletes a class rather than guarding it** (`calibration.md` §2): a default flip or a fence-safe sibling primitive would both be guards on a mechanism that can simply not exist.
3. **The Profile adopts it and deletes its loop.** `#fanout()` becomes one `lmz.broadcast` call over targets built from its subscriber rows; `onProfileBroadcastResult` stays unchanged as the `onResult` continuation, and its explicit `onErrorOnly` becomes implicit, since the loop applies that whenever `onResult` is given. ⚠️ **This is not tidying — it is the only proof the task works.** The Profile is the repo's one bare composer, so without it nothing shows a non-`LumenizeDO` host can broadcast, and the criterion would have to be synthetic.

4. **The Profile derives that binding from `callChain[0]` instead** (added to scope 2026-09-26, Larry — we are editing the file anyway, and `prefer-doing-small-local-work-now` prefers the fix to a backlog row). `callChain[0].bindingName` is the Gateway's own binding, stamped at the WebSocket upgrade from the `X-Lumenize-DO-Binding-Name` header `routeDORequest` sets, which the Gateway's comment calls out as replacing *"whatever the client sent"*. ⚠️ **For a plain client call the chain is ONE element, so the two expressions read the same element today** — the fix changes no behaviour and closes the forgery, which is what makes it safe to carry in a detour.

**ADR-007's core gains `broadcast`** (Larry, 2026-09-26). The ADR defines the core as *"exactly comms + guards"* and lists receiving calls, `callContext` propagation, `lmz.ctn()`, `onBeforeCall` and `@mesh()`; broadcast belongs there because it is one continuation sent to many addresses and needs nothing else. ⚠️ **This AMENDS an Accepted ADR rather than changing its status**, which is a different act from ratifying one: it gains an `**Amended**:` header line in the shape ADR-008 already uses, and its one-liner in `.claude/rules/workflow.md` gains the member, because that line is what an always-loaded session reads instead of the ADR.

**No per-target catch is added to the loop, and that is deliberate.** Once the binding comes from a verified source, an unroutable one can only be a genuine misconfiguration, and failing loudly on the first is better than delivering to some targets and swallowing the reason. A catch here would be the second guard on a mechanism whose root cause this task removes (`calibration.md` §2).

**A Worker's `lmz` gets it too.** `LumenizeWorker` has `ctn` and `lmz.call`, so nothing distinguishes it here, and `workflow.md`'s cost test prefers the general form when it costs the same. The one argument for DO-only was that `broadcast` would sit confusingly beside `__broadcastTier` on the same class — and that method is being deleted.

**Nebula's pin goes and `NebulaDO.broadcast` survives as a pass-through**, one line shorter. With no branch to choose, `directThreshold: Infinity` has nothing to pin, so a dated interim is deleted rather than documented. The wrapper itself is the sibling task's to remove, once every fan-out has moved into the plane.

## What the removal costs, stated plainly

- **Tail latency at high N becomes the only option.** The flat loop reaches the last of 1,000 subscribers in about 1.7 s deployed, where the tier's measured median was roughly 2.2× better. We keep working-but-slower and delete broken-but-faster; the measurement that would justify rebuilding stays in the 2026-06-06 blog post.
- **That blog post documents a capability that stops existing**, and it is a dated artifact, so it is not edited ([[blog-posts-frozen]]). A reader following it finds no `directThreshold`. This is the real cost of removal, named here rather than discovered later.
- **Rebuilding is not free, but nothing is lost.** The design is in the blog, the three defects are in `tasks/backlog.md`'s flat-loop row, and the code is in git. What is deferred is work nobody has done.

## Two backlog rows change meaning

- **The fence-safe-primitive row CLOSES.** It asks for *"a reusable direct-delivery broadcast any `lmz-api` node (raw or `LumenizeDO`) can compose — no tier hop … `onErrorOnly` drop-on-failed-delivery built in"*, and `lmz.broadcast` satisfies every clause once the tier is gone. Its one named consumer, the Profile, is adopted here, so the row has no remaining work.
- **The flat-loop row INVERTS.** It currently reads *"the model is the recursive tier; this is the dead interim"* and lists what lifting the pin requires. It becomes: build the tier when a real workload needs it, and its three defect bullets become the specification for doing it right. The pin it describes will not exist.

## Open question

One. **Is this the first step of retiring `svc`, or does `svc` keep `sql` and `alarms` indefinitely?** After broadcast leaves, the registry holds those two plus whatever a plugin registers. The answer changes nothing this task builds, and someone will ask it the moment they see one service move — so it is worth a sentence here rather than a re-derivation later.

## Non-goals

- **Rebuilding the tier**, now triggered by a real workload past ~100 subscribers on one resource or query, or a lag complaint.
- **Retiring `svc`, or moving `sql` or `alarms`** — pending the open question, and neither has a consumer asking.
- **The data-plane's bridge collapse**, which is the sibling's work and the reason this detour exists.
- **The Profile composing the Resources plane.** `ResourceDataPlane` lives in `apps/nebula/src` and `packages/nebula-auth` cannot import from the app, so that host has a packaging blocker this task does not touch — stated for [on-hold/nebula-profile-storage.md](on-hold/nebula-profile-storage.md) as a precondition, because nothing records it today.

## Relationships

**Gates** — [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md). Its bridge collapse hands the plane `() => this.lmz` and lets it own every fan-out; that is only host-agnostic if `broadcast` is on `lmz`, since one of its future hosts is not a `LumenizeDO`. The collapse also gets simpler with no branch to reason about.

**Standing guidance and docs this changes**, listed because most of it is prose a grep for the old call finds:

- [ADR-007](../docs/adr/007-shared-node-security-core.md) — the core enumeration in § *Decision*, plus an `**Amended**:` line; and its one-liner in `.claude/rules/workflow.md`, which spells the core as `` (`lmz.call`, `lmz.ctn`, `callContext`, `onBeforeCall`, `@mesh()`) `` and needs the new member.
- `.claude/rules/mesh.md` — the section **titled** *A Nebula node broadcasts through `NebulaDO.broadcast`, never `this.svc.broadcast`*, its neighbouring 4-arg example, the naming paragraph calling `this.svc.broadcast` the Lumenize primitive, and every sentence describing the tree path or the cutoff.
- `.claude/rules/containers.md` — the raw-path paragraph listing `svc.alarms` / `svc.sql` / `svc.broadcast` as free to use.
- `website/docs/mesh/broadcast.mdx` — five conceptual blocks, the tier section, `directThreshold`, and the *When Not to Use* heading.
- `packages/mesh/src/index.ts`'s registration comment and `BROADCAST_TIER_BINDING` export, the framework-method list in `ocan/execute.ts`, and the JSDoc in `broadcast.ts`, `types.ts`, `lumenize-worker.ts`, `lumenize-client.ts` and `lumenize-client-gateway.ts`.
- **Tests and benches:** the two tree-path tests in `packages/mesh/test/lumenize-worker.test.ts` and the two forced-tier calls in `test-worker-and-dos.ts` go with the branch they exercise (`testing.md` — a test of removed behaviour is removed, not skipped). `apps/nebula/test/browser/worker/bench-fanout-tier.ts` goes too, its result preserved in the blog post and `RESULTS-fanout-comparison-deployed.md`. `star.ts`'s `STAR_BROADCAST_DIRECT_THRESHOLD` override has nothing left to override. The `broadcast-past-threshold` scenario keeps its value and loses its premise — 120 subscribers on one query still all receive the push, so its header is rewritten rather than the scenario retired.

**Release** — two breaking changes to `@lumenize/mesh`'s public surface in one task: `svc.broadcast` becomes `lmz.broadcast`, and `directThreshold` / `branch` / `BROADCAST_TIER_BINDING` stop existing. The next release is flagged for both, per CLAUDE.md's preference for breaking changes over technical debt.

## Phases

Numbering is executable order. Each phase leaves the suite green, so any of them can be the last commit of a sitting.

⚠️ **The guidance, the ADR and the docs land in Phase 4, not where they are first noticed.** Phases 1 and 2 both change how the call is spelled, so a rewrite in either ships prose the other falsifies — and no test reds prose.

**Every command below was EXECUTED against the tree on 2026-09-26**, so the builder knows which criteria arrive pre-verified. Each returns a value that makes the criterion capable of failing today:

| Phase | Command | Today | After |
|---|---|---|---|
| 1 | `grep -rn -e '__broadcastTier' -e '__forwardBroadcastResult' -e BROADCAST_TIER_BINDING -e directThreshold -e DEFAULT_BRANCH packages/mesh/src apps/nebula/src --include='*.ts'` | 37 lines | nothing |
| 1 | `grep -rn -e '__broadcastTier' -e '__forwardBroadcastResult' -e directThreshold packages/mesh/test apps/nebula/test apps/nebula/harness --include='*.ts'` | 15 lines | nothing |
| 2 | `grep -rn 'svc\.broadcast' packages/*/src apps/*/src --include='*.ts'` | 38 lines | nothing |
| 2 | `grep -c "__lumenizeServiceRegistry\['" packages/mesh/src/lumenize-do.ts` | 3 | **2** — `sql` and `alarms` stay (Larry, 2026-09-26) |
| 3 | `grep -c 'this.lmz.call(' packages/nebula-auth/src/profile.ts` | 2 | **1** — the single-target initial snapshot stays; only the fan-out loop goes |
| 4 | `grep -rn -e 'svc\.broadcast' -e directThreshold -e BROADCAST_TIER_BINDING .claude/rules website/docs --include='*.md' --include='*.mdx'` | 30 lines | nothing |

⚠️ **The Phase 4 grep is scoped to `.claude/rules` and `website/docs`, which deliberately excludes `website/blog`.** The 2026-06-06 post measured the tier when the tier existed and is not edited.

Not executable at write time, and named so nobody assumes otherwise: every behavioural criterion, and the `/live` scenario runs.

1. **The tier branch is gone, and every fan-out is a direct loop from the origin at any N.** First, because it shrinks the function the next phase moves.
   - **Success criteria:** the two Phase 1 rows above reach nothing; `npm run test:code` is green in every workspace; the tier's two methods, its binding constant, the `directThreshold` and `branch` options and their defaults are all deleted, not deprecated.
   - **The tests of the deleted branch go with it** (`testing.md` — a test of removed behaviour is removed, not skipped): the two tree-path tests in `packages/mesh/test/lumenize-worker.test.ts` and the two forced-tier calls in `test-worker-and-dos.ts`. `apps/nebula/test/browser/worker/bench-fanout-tier.ts` goes too; its measurement survives in the 2026-06-06 post and `RESULTS-fanout-comparison-deployed.md`.
   - **`broadcast-past-threshold` keeps its value and loses its premise.** With no cutoff there is nothing to be wider than, but 120 subscribers on one query all receiving the push is still worth driving. Its header is rewritten and `npx tsx apps/nebula/harness/drive.ts broadcast-past-threshold` is green.
   - ⚠️ **Nebula's pin has nothing left to pin.** `NebulaDO.broadcast` loses `directThreshold: Infinity` and survives as a one-line pass-through for the sibling task to delete; `star.ts`'s `STAR_BROADCAST_DIRECT_THRESHOLD` override goes with it.
   - **Mutation note:** the risk here is deleting something the surviving loop needs, so prove the loop is covered rather than that the deletion happened — drop `onErrorOnly: true` from the direct branch and `nebula-client-disconnect-cleanup.test.ts` reds, because every push then fires a success handler as well.

2. **`broadcast` is on `lmz`, so any node that can make a mesh call can fan one out.** The registration moves to where `call` and `ctn` are; `broadcast.ts` keeps its module and its exported types.
   - **Success criteria:** the two Phase 2 rows above reach their After values; `lmz.broadcast` is typed on the `LmzApi` surface rather than reached through a cast; `npm run test:code` is green.
   - ⚠️ **`svc` keeps `sql` and `alarms`, so a criterion asserts both still resolve through it** — otherwise the move quietly takes the registry with it and the loss surfaces later as a missing service. Assert a `svc.sql` query and a `svc.alarms.schedule` still work on a `LumenizeDO`.
   - **Mutation notes:** delete the `broadcast` member from the `lmz` api and every broadcast test reds; register it on **both** surfaces and the `svc.broadcast` row reds, which is what stops an alias being left behind.

3. **The Profile broadcasts through it, which is what proves a bare composer can — and stops letting a client choose the address it stores.** Two independent changes to one file; either could land alone, so they may be two commits.
   - **Success criteria:** the Phase 3 row above reaches 1; `#fanout()` names `lmz.broadcast` and holds no loop; `onProfileBroadcastResult` is unchanged and still the `onResult` continuation; its explicit `onErrorOnly` is gone, since the loop applies that for any `onResult`.
   - **The behavioural proof is three tests in `profile-subscribe.test.ts` staying green** — the cross-scope HEADLINE update, the disconnected subscriber's row being dropped after a failed push, and the fence being PROFILE-scoped while a STAR-origin cross-scope push is refused. `client-gateway-aud-fence.test.ts`'s PROFILE-exemption pair stays green too.
   - ⚠️ **The swap is behaviour-preserving by construction, so reverting it reds nothing** — which is why its own criterion is read from source. The capability claim is what the tests make falsifiable.
   - **Mutation note:** register `broadcast` on `svc` instead of `lmz` and the HEADLINE test reds with a `TypeError`, because a bare composer has no `svc` at all. That is the whole task in one assertion.
   - **`subscribe` stores the binding from `callChain[0].bindingName`**, which the router stamps, rather than from `callChain.at(-1)`, which the client's own frame supplies (§ *Context and current state*). The stored column stays; only where its value comes from changes. ⚠️ **The two values in that one function already disagree about which element to trust** — `clientId` reads `callChain[0].instanceName` two lines above, so the fix makes the binding read the element its neighbour already reads.
     - **Criterion:** a subscribe whose frame carries an appended hop naming another binding stores the GATEWAY's binding, and the next profile update still reaches that subscriber. `grep -c 'callChain.at(-1)' packages/nebula-auth/src/profile.ts` returns 0 — that is **2 today**, one read plus the error message naming it, and both change.
     - **Mutation:** read `at(-1)` again and that criterion reds while every other Profile test stays green — which is the point, since the two expressions agree on every honest chain.
     - ⚠️ **This fixes the Profile only.** `apps/nebula`'s hosts read the same client-controlled value at sixteen sites (ten in `star.ts`, six in `galaxy.ts`), and that is [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md)'s to fix — do not read the Profile's fix as covering them.

4. **The guidance, the ADR and the docs describe what now exists.** Last, because Phases 1 and 2 both change what they would say.
   - **Success criteria:** the Phase 4 row above reaches nothing; [ADR-007](../docs/adr/007-shared-node-security-core.md)'s § *Decision* enumerates `broadcast` in the core and the file carries an `**Amended**:` line; its one-liner in `.claude/rules/workflow.md` names the new member; `npm test` passes at the repo root.
   - **`mesh.md` loses a section TITLE, not just prose.** *A Nebula node broadcasts through `NebulaDO.broadcast`, never `this.svc.broadcast`* is named for the call it forbids, so the section is retitled rather than edited in place; its 4-arg example, its naming paragraph, and every sentence describing the tree path or the cutoff go with it. `containers.md`'s raw-path list of free-to-use services drops one member.
   - **`website/docs/mesh/broadcast.mdx` loses its tier section**, its `directThreshold` guidance and its *When Not to Use* framing. Its five blocks are `@skip-check-approved('conceptual')`, so nothing validates them automatically — `/review-skip-check-approved` is the pre-release check that would catch a stale one.
   - **The two backlog rows, per `tasks/README.md`'s convention that a finished row is DELETED rather than marked:** the fence-safe-primitive row is **deleted**, its ask having shipped; the flat-loop row is **rewritten** to "build the tier when a real workload needs it", keeping its three defect bullets as the specification. The release-flag row records both breaking changes.
   - **Mutation note:** the guidance edits are prose and no test reds them, which is exactly why the Phase 4 grep is the check rather than the suite.
