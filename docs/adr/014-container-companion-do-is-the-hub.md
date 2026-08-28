# ADR-014: A Container Node Orchestrates From Its Own Companion DO — Never Across a Hop From a Sibling

**Date**: 2026-07-17
**Status**: Proposed
**Deciders**: Larry
**Evidence**: `apps/nebula/src/galaxy.ts` — the first hub, a plain `NebulaDO` driving its own build container through raw `ctx.container`; `.claude/rules/containers.md` (day-to-day mechanics + the state machines). Origin: a month of running CF Containers ([[studio-keep-container-native-tide]]).

## Context

A Cloudflare Container is always paired with a **companion Durable Object** — there is no "attach a container to a plain DO" path, and no way to reach the container except through that DO. The question every design faces is: *where does the orchestration logic live* — the code that calls AI, calls other DOs, decides what to build, and drives the container?

The intuitive answer, and the one a fresh contributor or LLM reaches for by reflex, is **separation of concerns**: keep the companion DO a thin proxy that only forwards calls into the container, and put the real orchestration in a clean sibling DO next door. It reads as tidy layering. It is a trap.

Reaching the container across a hop means the critical path now spans **three independently-hibernating state machines at once**: the sibling DO (asleep/awake) × the companion DO (asleep/awake) × the container's own lifecycle (`absent → provisioning → starting → healthy → stopped`, plus the off-path `frozen`/stuck state). Each can be cold when the others are warm. Waking all three in the right order, on a cold start, under retry, is a race-prone coordination problem — it is exactly where the system wedged on bootup, and the wedge was bad enough that recovery required `ctx.abort()` (forced DO reconstruction), which is a poor-DX sledgehammer we would rather not reach for.

The dissolving insight: **the companion DO is a full-fledged Durable Object that happens to have a container attached — not a proxy.** Container work is ~300 ms–3 s per call and, from the DO's view, a *network await* that opens the input gate. That leaves the DO thread almost entirely free. It has ample capacity to *be* the orchestrator, and doing so erases the cross-node wake entirely — there is no sibling to coordinate with, because there is no sibling.

## Decision

**A container node's hub/orchestration logic lives in the container's own companion DO. Do not front a container with a proxy-only DO and drive it from a separate DO across a mesh hop when the two must be live together.**

- **The companion DO is the hub.** It calls *out* (AI, other DOs, the outside world) and calls *down* into its own container — one hop from either side. Put the controller anywhere else and you add a hop to one side and a lifecycle to manage.
- **The container is a general compute platform, not a single-purpose binary.** Model it as a box that runs many jobs behind a supervisor process, not "one binary this DO invokes." Adding a capability is a new job inside the existing container, not a new node.
- **The generalization — the durable *why*:** do not distribute a **liveness-coupled** workflow across multiple independently-hibernating nodes; colocate it in one node so there is **one lifecycle to manage, not the product of several.** This is scoped to *coupled* liveness. Cross-node hops remain correct and expected where lifecycles are **not** coupled — the Star data plane, the Gateway, Resource hosts. This ADR is not "prefer fewer nodes"; it is "don't split a thing whose parts must wake together."

The mechanism (state machines, the `running`×`status` trap, what's verifiable only when deployed, the raw-`ctx.container` drive checklist) is not part of this commitment — it lives in `.claude/rules/containers.md` and will evolve. The commitment is the *placement*.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Thin proxy companion DO + sibling orchestrator** (the reflexive "separation of concerns" design) | Multiplies the critical path across three independently-hibernating state machines; cold-start wake-ordering is race-prone and is what forced the `ctx.abort()` recovery hack. Tidiness on paper, brittleness in production. |
| **Container as a single-purpose binary** (one job per container, more containers/DOs for more jobs) | Forgoes the free DO-thread capacity, and every new capability becomes a new node with its own lifecycle — re-introducing the hop-multiplication this ADR removes. |
| **A separate DO per container job, all proxying in** | Same defect as the sibling design, N times over. |
| **Leave it as a project pin in the Galaxy task file** | Fails the ADR test in the wrong direction: a fresh session designing *any* future container feature would re-propose the sibling-proxy split within its first week, and a task-file pin is invisible at that moment. The always-loaded index line is the only thing that catches it. |

## Consequences

### Positive
- The entire wake-ordering class of bug **dissolves** — one node, one lifecycle, no cross-node cold-start choreography.
- The hub sits **one hop from the outside world and one hop from the container** — minimal latency to either side.
- Vertical scale (`instance_type`) is available if a single tenant ever outgrows the default instance, so a tenant-sharded system can let its one container do everything ill-suited to JS/WASM.

### Negative / open
- The hub is a plain `LumenizeDO` driving raw `ctx.container` — never `extends Container`. The base's homework transfers to the drive: attach `monitor()`, bound the readiness poll, serialize lifecycle transitions on a promise-chain latch. `.claude/rules/containers.md` § *The `Container` base is optional* carries the checklist. Skip an item and the hub wedges on the next container death.
- An eviction mid-operation orphans the container **and** tears its capnweb session. Container lifetime therefore sits strictly inside one in-flight request. The ephemeral drive — construct, build, destroy, per build — satisfies that, and pays the container cold-start on every build.
- The stuck-flag race stays cloud-only and deploy-verifiable. The hub keeps its signature predicates as logged evidence; nothing acts on them.
