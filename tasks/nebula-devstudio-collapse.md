# DevStudio + DevContainer collapse (spike)

**Status:** **Feasibility spike DONE 2026-07-07 → CLEAN on all four gates → GO** (per the decision rule). Ready to build — see the **Feasibility spike RESULT** section below for the punch-list. The **build** should still land after the chat work ([nebula-chat-history-multiuser.md](nebula-chat-history-multiuser.md) + its [rfc-act-chains.md](archive/rfc-act-chains.md) detour), since the chat Resources are what the merge relocates — building it against a moving Resource surface = rework. Tracked from [nebula-pre-alpha.md](nebula-pre-alpha.md). Node shape/naming pinned below.

> **Deliberate convention break (2026-07-07).** The repo runs "living master + ONE child task file at a time / no stub" ([[task-file-one-at-a-time]]). This file is a considered exception, not a violation: it's substantive capture of thinking already done across a design thread — **not an empty speculative stub** (the anti-pattern the rule guards against) — pulled OUT of the master to keep the master lean while the chat + act-chains detours run long. Do **not** fold it back into the master, and don't treat the two-active-children state as an error to "fix."

## Driver — why collapse at all

After **≥3 failed attempts**, waking + reconstituting the dev sandbox on **tab-refocus** is a race-prone state machine. The tab holds **two independent channels**:
- tab → **Gateway** → **DevStudio** (chat / control plane)
- tab (preview **iframe**) → **DevContainer** vite **HMR WebSocket** (preview / data plane)

…and the backing entities wake independently: **DevStudio-DO hibernation × DevContainer-DO hibernation × container-process states.**

**A leading hypothesis (unconfirmed — context, NOT the plan):** *one* plausible cause is that the node that *serves* the preview (the container) is **not** the node holding what it needs to serve (**DevStudio**: source + readiness) — so a cold-wake serve needs a **cross-node push** (`bootAndApply`) and there's **no in-process point to gate the HMR reconnect** (gating cross-node is a race by construction; gating client-side from the cross-origin **iframe** running the *generated* app is likely impossible). If that's the cause, the fix is to collapse to **one node** so the gate becomes **local** — the vite proxy already sits in the HMR path and could hold the WS until *container-up + source-applied + logic-warm* (in-process), dropping a hibernation dimension.

⚠️ **But we do NOT actually know the primary failure yet** — and we're **not going to bet on out-diagnosing it.** Three fixes have not held, and in this system a wrong diagnosis isn't refuted until *after* we build the treatment and watch the patient not improve — so diagnosis has near-zero standalone refutation power here. The cause could equally be the **client's dual-channel reconnect**, **container lifecycle**, or **hibernation-wake ordering**. **See Approach: simplify-first, not diagnose-first.**

**NOT the rejected merge:** this is **DevStudio + DevContainer**, not the shipped-and-rejected **Galaxy + DevStudio** merge (rejected because DevStudio's heavy startup + long in-DO model awaits would contend on Galaxy's single-threaded ontology-read path — see the Chat-③ decision in [nebula-pre-alpha.md](nebula-pre-alpha.md) ✅-Shipped). **Galaxy stays separate.** This folds the *disposable builder* INTO the *studio*.

## Pinned — the node shape (name by dominant responsibility)

| Decision | Choice | Rationale |
|---|---|---|
| Merged class name | **`DevStudio`** | After the merge the container is the *minority* capability; the authoring brain (codegen loop + chat Resources + Workspace) is the identity. Name a class for what it *is*, not for its superclass. |
| Base class | **`extends NebulaContainer`** (→ `LumenizeContainer` → CF `Container` → `DurableObject`) | The hierarchy **must** include CF's `Container` — there is no "attach a container to a plain DO" path — so *code* flows DevStudio→the container class even though the *name* stays DevStudio. `NebulaContainer` also carries the tenant scope-reach guard, inherited unchanged. |
| Binding | one binding — **`STUDIO`** (`DEV_CONTAINER` removed) | Today `{u}.{g}.dev` exists on *two* bindings; the merge collapses the dual-binding-same-instance oddity to **one binding + one instance**. |
| wrangler config | `containers[].class_name` **and** the DO binding both → `DevStudio`; `defaultPort=5173` / `sleepAfter='5m'` move onto the class | container-capability config lives on the concrete node now. |
| Capability layers | keep `LumenizeContainer` / `NebulaContainer` container-named | they express the reusable "node-with-a-container (+ Nebula guard)" capability seam (ADR-007); only the concrete node takes the responsibility name — mirrors `LumenizeDO → NebulaDO → concrete`. |

**Class-doc must flag two surprises the name now hides:** (i) *why a "Studio" extends a Container* — the container is a capability, not the identity; (ii) it's therefore **not constructable under vitest-pool-workers** ([[container-no-construct-pool-workers]]) → unit-test the logic via extracted, container-independent modules.

## Approach — simplify-first, NOT diagnose-first

**Why we're inverting the usual order:** diagnosis has already been wrong **three times** here, and — the load-bearing fact — a wrong diagnosis in this system **isn't refuted until *after* we build the fix and watch the patient not improve.** When diagnosis has that little standalone refutation power, betting the next move on finally getting it right is the bad bet.

So we make a move whose payoff is **diagnosis-independent: remove the concurrency** (collapse the state machine) rather than debug the race. Collapse-first **dominates** diagnose-first here:
- if it fixes the failure → we never needed the diagnosis;
- if it doesn't → we're debugging a **simpler** system (one hibernation dimension gone), so any diagnosis still required is *easier* than today;
- the only losing branch — collapse is **expensive AND** doesn't fix it — is exactly what the Phase-1 feasibility spike gates.

**Decision rule (Larry, 2026-07-07):** run the collapse-feasibility spike first; **if it does NOT come back "really hard & messy," do the collapse next — regardless of any diagnosis we could name now.**

## Phase 1 — spike the collapse's feasibility (the go/no-go)

Goal: decide whether the full merge (shape pinned above) is **clean or messy** — nothing more. This is **not** a diagnosis of the wake bug; it's a cost/risk probe of the *merge itself*. Prototype only far enough to answer, then stop.

**"Hard & messy" = any of these bites** (else it's **clean → do the collapse**):
- **`ResourceDataPlane` won't compose cleanly** onto a node already carrying the full lmz-api + CF `Container` (the piece already flagged as needing a spike; precedent = the [DevStudio data-plane extraction](archive/nebula-devstudio-data-plane.md) via `resourceHostBinding`).
- **`ctx.abort()`-recovery can't be separated from the chat** — no way to recover a stuck container without nuking the (now co-located) live chat session.
- **The DO-class merge migration is nasty** — folding two prod DO classes (`STUDIO` + `DEV_CONTAINER`, same instance) into one is a DO migration (one-way door). *Probably defused by pre-alpha's wipe-freely posture* — confirm.
- **Test extraction is infeasible** — can't pull the chat/codegen logic into container-independent modules to keep a unit lane ([[container-no-construct-pool-workers]]).

**Companion (do this too — it is NOT diagnosis): a reproduction we can run on command.** A scripted refocus that reliably makes the patient sick, so we can tell whether the collapse **makes it better.** This is the piece missing from the last three cycles — without a repro, collapse-first has the *same* ship-and-hope blindness as diagnose-first. Repro = treatment-verification ("did it work?"); diagnosis = root-cause ("why is it sick?"). We need only the first. It may be non-trivial (hibernation timing / container states — possibly *why* the bug was only caught post-deploy), but it's reusable for whatever comes next, and light instrumentation can ride along opportunistically (not a gate). *(Reconciled in the reload/self-heal thread: the **cold** case IS reproducible on command via reload-after-idle; the built collapse is verified primarily by the **prod self-heal trigger-rate** dropping — see the master's preview-survives-redeploys gate.)*

## Feasibility spike RESULT (2026-07-07): CLEAN → GO

All four "hard & messy" gates came back **CLEAN** (four parallel code-grounded assessments). Per the decision rule, **the collapse is a go.** "Clean" ≠ trivial — it's a bounded, mechanical, multi-file change with a clear punch-list and no blocker.

**Per-gate verdict:**
- **ResourceDataPlane composition — CLEAN.** Extracted to be host-agnostic (its own doc: *"Star today, DevStudio next"*); needs only `ctx.storage.sql` / `lmz.callContext` / Worker-Loader ontology / `@mesh`+`onBeforeCall`, all present on the Container node. The no-`onStart` crux dissolves into a **lazy first-use getter** (the pattern `LumenizeContainer` already uses for `lmz`; construction is synchronous). No storage-table collisions.
- **`ctx.abort()` vs chat — CLEAN (and better than we'd written).** A container-only recovery that spares the chat **already exists** — `destroy()` resets just the container process, leaving DO storage intact; it's the *primary* branch for every failure except the rare cloud stuck-flag. And the client socket isn't in this DO at all — it's held by the separate `NebulaClientGateway`, and subscriber registrations are durable SQL rows. So an abort drops **only the in-flight AI turn**, not subscriber liveness or history.
- **DO-class merge migration — CLEAN.** Pre-alpha wipe-freely fully defuses it: everything `DEV_CONTAINER` persists is regenerable/transient/dead, and the merged class keeps the `DevStudio` name so its precious Workspace + chat Resources ride through untouched. Precedent: the DevStar→Star collapse retired a prod class the same way (`deleted_classes`).
- **Test extraction — CLEAN (~90% already done).** Logic already lives in pure, DI'd, Container-agnostic modules (`codegen-loop.ts`, `codegen-gate.ts`); the DO is already a thin shell, and the fast unit lane doesn't construct DevStudio today. Only the ~6–12 `runInDurableObject` integration tests need re-homing to the pattern `DevContainer` already uses.

**Punch-list (the actual scope — none a blocker):**
1. **Merge the classes** — fold `DevContainer` into `class DevStudio extends NebulaContainer`; the 5 `DEV_CONTAINER` mesh calls in dev-studio.ts (`setAppVersion`/`bootAndApply`/`applyChanges`/`warmAndAwaitReady`) become local; move `defaultPort=5173`/`sleepAfter='5m'` onto the class.
2. **Lazy `#dataPlane` getter** — construct `ResourceDataPlane` on first use, not in `onStart` (Container node has none); sync construction makes this trivial.
3. **`LumenizeContainer.broadcast` accessor** — `this.svc.broadcast` is `LumenizeDO`-sugar the Container lacks; add a `broadcast(this)` accessor at the mesh layer (underlying `broadcast()` needs only `lmz`/`ctn`, both present). Legit ADR-007 first-consumer ergonomic gap.
4. **wrangler.jsonc** — rename the `DEV_STUDIO` binding → `STUDIO` (today's name is `DEV_STUDIO`, not `STUDIO`); delete `DEV_CONTAINER`; repoint `containers[].class_name` → `DevStudio`; append a `deleted_classes:["DevContainer"]` migration tag (do NOT edit `v1`).
5. **`audit-migrations.mjs`** *(same change, or the deploy preflight fails)* — teach it to subtract `deleted_classes` from its union + bump `EXPECTED_DO_CLASS_COUNT` 8→7; update its companion test.
6. **Re-home ~6–12 tests** off `runInDurableObject` (won't work on a Container subclass) to the pure-guard / `prototype.call(fakeThis)` / top-down ui-smoke patterns already used for `DevContainer`.
7. **Operational cleanup post-deploy** — `wrangler containers delete` the old DevContainer container app; purge orphaned `DEV_CONTAINER` DO storage (wipe-freely).

**The one bit of real wiring to watch** (surfaced by the assessment, not one of the four gates): DevStudio's `onStart` also does **async git/Workspace init** (`@cloudflare/shell` + isomorphic-git). Unlike the data-plane's *synchronous* construction (lazy getter), an *async* init on a no-`onStart` node needs an `await this.#ensureWorkspace()` latch at the top of each Workspace-touching method — a known async-latch pattern, more touch-points than a sync getter but standard. Closest thing to residual risk.

**Small consistency caveat:** on the reconstruct/abort path, make the dropped in-flight turn surface as a *retriable/interrupted* state, not a silently half-written `Message`. Small turn-commit-path task.

## Fallback lane — ⛔ NOT triggered (spike came back CLEAN — see RESULT above); kept only in case the built collapse ships and the prod self-heal trigger-rate shows it didn't fix it

- **Then diagnose** — reproduce across the state combos, instrument the wake timeline at every participant (tab · HMR-iframe · Gateway · DevStudio · DevContainer-DO · container-process) via the [`/live` harness](../apps/nebula/harness), and post-mortem the three prior attempts. (The full diagnosis work — deliberately the *fallback* here, not the default.)
- **Partial** — container self-hydrate + in-path HMR gate (source as files in the container-side DO, not the Resource layer). A **stopgap that relocates a race without collapsing the machine** — only if a diagnosis implicates the cross-node source-push dependency. Overlaps the *preview-survives-redeploys* GATE candidate (b) in [nebula-pre-alpha.md](nebula-pre-alpha.md).
- **Elsewhere** — if diagnosis points at the client's dual-channel reconnect / container lifecycle / hibernation ordering, the fix lives there and collapse was the wrong tool.

## Costs / risks (re-weighted — wake-flow correctness dominates)

- **Test isolation** — the wake flow was **never** pool-workers-unit-testable anyway (inherently container+DO+WS integration, run via the wrangler-dev+Docker harness). So the part that *benefits* from merging is orthogonal to the part that *loses* unit-constructability. **Mitigation:** keep the chat/codegen **logic** in extractable, container-independent modules (pure functions + a thin DO shell) so the fast unit lane survives on the actively-developed chat surface.
- **`ctx.abort()` coupling — lighter than first written (corrected by the spike).** `#forceReset` aborts + reconstructs the DO, but (a) it fires **only** for the rare cloud stuck-flag — every other recovery uses `destroy()`, which resets just the container and leaves the DO/chat intact; and (b) the client socket isn't in this DO (it's held by the separate `NebulaClientGateway`; subscriptions are durable SQL rows). So an abort drops **only the in-flight AI turn** — not subscriber liveness, not history. Make that dropped turn surface as retriable, not a half-written `Message`.
- **ADR-007** — no conflict. Resources/storage/container are composable per-node capabilities; the merged node is simply the **most-capable** node (comms core + storage + Resources + container + fetch-proxy).
- **Confirm sufficiency** — verify a **server-side** HMR gate is **enough**, i.e. no residual **client-side** sequencing is needed between the Gateway channel and the HMR reconnect. (The merge fixes server-side coordination; if the client's dual-channel reconnect *also* races, that's a separate fix.)

## Method + acceptance

- **Sequence-diagram-first** ([[sequence-diagram-first-when-tangled]]) — draw the wake-up state machine BEFORE prose. Participants: **tab · preview-iframe · Gateway · DevStudio · DevContainer-DO · container-process**; mark each entity's hibernation/cold states and the two client channels. (Run the Mermaid render-safety check after drawing — no `;` or `#` in notes/labels.)
- Then **prototype the collapse far enough to judge clean-vs-messy** (Phase 1); build the specific in-path HMR gate only if we proceed.
- **Acceptance bar:** on **tab-refocus after idle/eviction** (and after a **container-re-rolling redeploy**), the preview **self-heals to the running app with zero manual clicks**, via a **linear** wake — no cross-node readiness round-trip on the serve path.

## Relationships / sequencing

- **Feasibility spike: DONE 2026-07-07 (pulled forward, ahead of chat) → CLEAN.** The **build** still lands after the chat work — its `changedBy.sub` attribution + subscription-layer name resolution are the Resource state the merge relocates — so: finish chat + the rfc-act-chains detour, then build the collapse (else you merge a moving Resource surface).
- **Structural alternative to / subsumer of** the *preview-survives-redeploys* GATE's candidate (b) in the master.
- **Independent of** the container disk-persistence question (turn-1 discussion / [backlog.md](backlog.md)): this is a topology/coordination change, not a persistence-feature dependency — though disk-persistence would *further* simplify self-hydrate (no re-push at all).
- **On go-active:** run `/review-task` → `/build-task`; on completion, lift the durable nuggets up into [nebula-pre-alpha.md](nebula-pre-alpha.md) and archive this file.
