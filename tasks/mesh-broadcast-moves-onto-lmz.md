# Any mesh node can broadcast, not just a `LumenizeDO`

**Status:** Pass 1 — design intent, for hand review. No phases yet.

**A deliberate detour** from [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md), which cannot collapse its host bridge until this lands. Small and isolated enough for a **condensed process** (Larry, 2026-09-26): a hand review of this file rather than a `/review-task` panel, and one build pass rather than phase-by-phase verifiers.

**Objective — a node that can make a mesh call can fan one out.** Today fanning out requires extending `LumenizeDO`, and that requirement is an accident of where the function was registered rather than anything the function needs.

The sections below give what is true today, the change that follows from it, the two things it deliberately does not fix, and the three decisions it needs before phases can be written.

## Context and current state

**`svc` belongs to `LumenizeDO`; `lmz` belongs to every composer.** That is the line the whole task turns on, and it is sharper than it looks: `get svc()` is declared on `LumenizeDO` alone, so a node composed the other way has no `svc` at all — not an empty one. `ComposedMeshDO(DurableObject, 'Profile')` in `packages/nebula-auth/src/profile.ts` is that node, in production today.

**What `broadcast` needs from its host is two things, and a bare composer has both.** `broadcast(doInstance)` reads exactly `doInstance.ctn` and `doInstance.lmz.call`, and `broadcast.ts` imports only from `./ocan/index.js`. Nothing in it touches storage, alarms, `onStart` or `fetch`. Its home on `svc` comes from one registration line in `lumenize-do.ts`, whose own comment scopes the consequence — *"always available on this.svc.broadcast for LumenizeDO subclasses"*.

**`sql` and `alarms`, its neighbours in that registry, are genuinely different**, which is why this task moves one service and leaves the registry standing. `Profile`'s own comment states the distinction from the outside: it has *"no `onStart`/`alarms`/`svc.broadcast` (a raw composer has no `onStart`…)"*. An alarm needs the `alarm()` handler `LumenizeDO` owns; a broadcast needs a continuation and a way to send it.

**Moving it costs almost nothing, because there is one production caller in the repo:**

```ts
// apps/nebula/src/nebula-do.ts — the only production svc.broadcast call anywhere
this.svc.broadcast(targets, remote, { directThreshold: Infinity, ...opts });
```

Alongside it: two calls in `packages/mesh/test/test-worker-and-dos.ts`, and five code blocks in `website/docs/mesh/broadcast.mdx`, every one `@skip-check-approved('conceptual')` — hand-approved prose with no fixture behind it, so they are text edits rather than a fixture to keep in sync. Everything else the grep finds is JSDoc prose describing the mechanism.

**Two consumers want this.** The Profile hand-rolls a `lmz.call` loop plus its own dead-subscriber cleanup, and `tasks/backlog.md`'s fence-safe-broadcast row records why it had to. The data-plane sibling wants its plane to take `() => this.lmz` and own every fan-out itself, which is what deletes eleven duplicated bridge members.

## Design intent

**`lmz.broadcast(targets, remote, opts?)`, registered where `call` and `ctn` are registered, so every mesh composer has it.** The signature and semantics are unchanged — same targets, same continuation, same `onResult` and `directThreshold` options, same tier path. What changes is the access path and who has one.

**`svc.broadcast` goes; no alias is left behind.** One production caller makes the sweep trivial, and an alias would be a second spelling of one capability — the interim a later reader has to unlearn, for a rename nobody is forced to do.

**`broadcast.ts` keeps its module, its exported types and `BROADCAST_TIER_BINDING`.** What moves is the registration line and which object the function hangs off, which is what keeps this a detour rather than a rewrite.

**ADR-007's core gains `broadcast`** (Larry, 2026-09-26). The ADR defines the core as *"exactly comms + guards"* and lists receiving calls, `callContext` propagation, `lmz.ctn()`, `onBeforeCall` and `@mesh()`; broadcast belongs there because it is one continuation sent to many addresses and needs nothing else — no storage, no alarm, no lifecycle hook. So it is comms, and the enumeration was simply written before anyone asked. ⚠️ **This AMENDS an Accepted ADR rather than changing its status**, which is a different act from ratifying one: it gains an `**Amended**:` header line in the shape ADR-008 already uses, and its one-liner in `.claude/rules/workflow.md` gains the member, because that line is what an always-loaded session reads instead of the ADR.

**`NebulaDO.broadcast` survives this task with one line changed inside it.** Its JSDoc calls it *"the ONE place a Nebula node reaches `svc.broadcast`"*, and that stays true with `lmz` in place of `svc`, so Nebula's `directThreshold: Infinity` pin keeps its single home. The sibling task is what deletes the wrapper, once every fan-out has moved into the plane and the pin moves with them — and that ordering is deliberate, because deleting it here would strand the pin in a task that has no plane to put it in.

## What this does NOT fix, so nobody reads it as fixed

**The tier path still rewrites `metadata.caller`.** `tasks/backlog.md`'s fence-safe row asks for a primitive with *"no tier hop (so `metadata.caller` stays the origin node → the fence stays reliable at any N)"*, and moving a method changes no dispatch behaviour. So this task delivers the **composition** half of that row and none of the fence half: a bare composer can now reach `broadcast`, and a bare composer that needs a caller-gated cross-scope fan-out still cannot use it. ⇒ That row stays open, and gains a line saying which half is done.

**The Profile still cannot compose the Resources plane**, for a reason unrelated to broadcast: `ResourceDataPlane` lives in `apps/nebula/src`, and `packages/nebula-auth` cannot import from the app — the dependency runs the other way. This task removes one of that host's blockers, not both, and the other belongs to [on-hold/nebula-profile-storage.md](on-hold/nebula-profile-storage.md) as a stated precondition.

## Open questions

Two, each a decision to make before phases are written.

1. **Does a Worker's `lmz` get it too, or is it DO-only?** `createLmzApiForWorker` exists beside `createLmzApiForDO`, and a `LumenizeWorker` has both `ctn` and `lmz.call`, so "both" costs nothing to implement. But a Worker that fans out is a shape nobody has designed, and `LumenizeWorker` already carries `__broadcastTier` for the tier role — so the two could be confused at the call site. DO-only is the narrow answer and `workflow.md`'s cost test argues against narrowing for its own sake; this is a judgement about what `lmz` should teach a reader who meets both names.
2. **Is this the first step of retiring `svc`, or does `svc` keep `sql` and `alarms` indefinitely?** After broadcast leaves, the registry holds those two plus whatever a plugin registers. The answer changes nothing this task builds, and someone will ask it the moment they see one service move — so it is worth a sentence in the file rather than a re-derivation later.

## Non-goals

- **The fence-safe direct-delivery primitive** — the other half of the backlog row above, still triggered by its second consumer.
- **Retiring `svc`, or moving `sql` or `alarms`** — pending open question 3, and neither has a consumer asking.
- **Any change to dispatch**: the direct-versus-tier cutoff, the tier's `metadata.caller` rewrite, and Nebula's `directThreshold: Infinity` pin all behave exactly as they do today.
- **The Profile composing the Resources plane**, which needs the packaging decision named above.

## Relationships

**Gates** — [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md). Its bridge collapse hands the plane `() => this.lmz` and lets it own every fan-out; that is only host-agnostic if `broadcast` is on `lmz`, since one of its future hosts is not a `LumenizeDO`.

**Standing guidance and docs this changes**, listed because most of it is prose a grep for the call finds:

- [ADR-007](../docs/adr/007-shared-node-security-core.md) — the core enumeration in § *Decision*, plus an `**Amended**:` line; and its one-liner in `.claude/rules/workflow.md`, which spells the core as `` (`lmz.call`, `lmz.ctn`, `callContext`, `onBeforeCall`, `@mesh()`) `` and needs the new member.
- `.claude/rules/mesh.md` — the section **titled** *A Nebula node broadcasts through `NebulaDO.broadcast`, never `this.svc.broadcast`*, plus its neighbouring 4-arg example and the naming paragraph that calls `this.svc.broadcast` the Lumenize primitive.
- `.claude/rules/containers.md` — the raw-path paragraph listing `svc.alarms` / `svc.sql` / `svc.broadcast` as free to use.
- `website/docs/mesh/broadcast.mdx` — five conceptual blocks and the prose around them, including its *When Not to Use* heading.
- `packages/mesh/src/index.ts`'s registration comment, and the JSDoc in `broadcast.ts`, `types.ts`, `lumenize-worker.ts`, `lumenize-client.ts` and `lumenize-client-gateway.ts` that names the old path.
- ⚠️ **The 2026-06-06 broadcast blog post is NOT edited.** It is a dated artifact and stays as written ([[blog-posts-frozen]]); a reader meeting `svc.broadcast` there is reading June's API correctly.

**Release** — this is a breaking change to `@lumenize/mesh`'s public surface, so the next release is flagged for it, per CLAUDE.md's preference for breaking changes over technical debt.
