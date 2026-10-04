# Nebula — Pre-alpha (master plan)

**Status (2026-09-03):** prod `nebula.lumenize.com` still serves `ada3f31`, deployed 2026-07-04. Everything since is UNDEPLOYED behind the one batched wipe + redeploy (§ *⑥ The wipe*), so do not read prod as evidence of current behaviour. F&F invites stay paused until the wipe has landed, and the wipe waits on everything above it in § *What remains*.

**Goal:** ~4–5 pre-alpha users — Larry's friends, family and business partners ("users," not "partners") — building their own data-bound, multi-user apps on a deployed Nebula, exercised through personas, with enough instrumentation for near-daily conversations as they build.

**How to read this file.** § *What remains* is the plan, in order. The sections after it hold only what an item needs and has no task file for yet; once a child task file exists it is the authority and this file keeps one line. Built work is one line in § *Shipped*. Work deferred past pre-alpha is not tracked here — it lives in `tasks/on-hold/` and [backlog.md](backlog.md), each item with its own reasoning. Children are written one at a time and archived on completion ([[feedback_task_file_one_at_a_time]]).

## What remains

**Three decisions first.** Each blocks a build below, and each costs hours of thinking rather than code:

1. ✅ **Decided 2026-09-18 — a persona has no address, membership or cookie.** Its tab gets a plain token as the persona, with no `act`, from the cookie of whoever opened it, and only where that cookie's membership has dominion over the persona's Star ([ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md) § *A persona's host*). It replaces the 2026-09-07/08 decision that personas ride `impersonate()` as real `@lumenize.io` accounts. What that decision built stands on its own: the narrower-token mint refuses a subject whose membership is not accepted, and the Profile's owner branch has no `act` clause (§ *Shipped*).
2. **Ontology — where compiled validators are stored**, tabled in [nebula-ontology-history-file.md](nebula-ontology-history-file.md). Blocks ⑤'s phases, and the Star-fetch path rides the mesh methods that task deletes.
3. ✅ **Decided 2026-09-08, re-derived 2026-09-28 — yes, deliberate, and the merged registry keeps no register-time check.** A subscriber sees what it can read and is told which nodes it can't, on every kind of subscription (④'s D25). A refusal naming the missing nodes would also satisfy [ADR-008](../docs/adr/008-full-org-tree-visibility.md), but it would cost the subscriber everything it can read. So the method's guard is authentication plus the delivery-time evaluation, written as a guard rather than recorded as an absence. Larry's two push-path questions were answered with it — the stored dominion bit stays and gains its convergence statement, the per-push recheck stays because every alternative stores more — in [nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md) § *The push path — what it stores, and what it rechecks*. ⚠️ The Profile was cut out of that file 2026-09-22 and now follows it in [on-hold/nebula-profile-storage.md](on-hold/nebula-profile-storage.md); the answer above is plane-general and stayed. ④'s phases are unblocked by THIS decision, and its other gate — [archive/mesh-entry-and-walk-gaps.md](archive/mesh-entry-and-walk-gaps.md) — cleared 2026-09-25, so Phase 7 has the reaper hole closed under it rather than owing the fix. ④'s Stage 2 ran 2026-09-27.

**Then the builds, riskiest first.** *Gate* is what an item waits on: `data` needs the greenfield DB and is a migration if missed; `deploy` only needs to be in the bundle; `ungated` never rides the deploy.

| # | Item | Task file | Gate |
|---|---|---|---|
| — | ✅ **BUILT 2026-09-27 — Broadcast is core to every mesh node, and it delivers directly** — `lmz.broadcast` is on every node so any node can fan out, the broken tier branch is deleted rather than guarded, and the Gateway no longer forwards hops a client appended | [archive/mesh-broadcast-is-core-and-direct.md](archive/mesh-broadcast-is-core-and-direct.md) — five phases, built 2026-09-27 | deploy · **enables ④** (its D22) |
| — | **The test toolchain moves to `@cloudflare/vitest-plugin`, then every Worker to compatibility date 2026-10-01** — so a Galaxy turn stays in memory after the request that started it has answered | none — § *The test toolchain and the compatibility date* | deploy |
| — | ✅ **BUILT 2026-10-04 — The scope moves from a URL segment to a subdomain** — every scope its own host ([ADR-021](../docs/adr/021-every-scope-has-its-own-host.md)), every session on the platform host ([ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md)), and the certificate wait shown on Galaxy create | [archive/nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) — sixteen phases, built 2026-10-04 | **data** · **enables ②** |
| — | **Calls to and from a Client behave like calls between nodes** — a Client's result handler travels with its call, a Gateway keeps the handler of a call it receives, the Gateway checks passage on what it sends down, and the three-argument `lmz.call` goes | [mesh-calls-to-and-from-clients.md](mesh-calls-to-and-from-clients.md) — every decision Larry's, 2026-09-30; Stage 1 ran 2026-10-04 and its open items are being settled; builds after the toolchain row above | deploy |
| ② | **Personas** — synthetic users the LLM defines, each in its own preview tab | [nebula-testing-with-personas.md](nebula-testing-with-personas.md) — Pass 1 complete; Stage 1 run and every question answered 2026-09-08/09, verdicts in its § *Pinned*. Pass 2 writes the phases | deploy |
| — | ✅ **BUILT 2026-09-03 — Turn-liveness heartbeat** — a truthful server signal through the whole turn | none — § *Turn-liveness heartbeat* | deploy |
| ③ | ⚠️ **THE GATE — capture live** | none — § *③ Capture live* | deploy |
| — | **A remote caller reaches more than the `@mesh()`-decorated methods** — the member-level check catches only an undecorated first CALL, so reads, `svc` chains and nested markers get through, and the response leg runs with it off | ✅ **BUILT + ARCHIVED 2026-09-25** — [archive/mesh-entry-and-walk-gaps.md](archive/mesh-entry-and-walk-gaps.md), twelve phases | deploy · **④'s gate is CLEARED** |
| ④ | ✅ **BUILT 2026-09-28 — Every Resources guard lives in the Resources plane** — one `@mesh()` door per host, a decorator-less results gate beside it, and every guard inside | [archive/nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md) — eight phases, built 2026-09-28 | **data** |
| — | **Denied access shows in the app** — a generated app shows what a partial query or a denied resource subscription is missing and who can grant it, and Studio's guidance steers the model to build that | none — § *Denied access in generated apps* | deploy |
| — | **A `computed()` over the store can miss its subscription** — switching to a resource id the store has already seen never subscribes it, so the view goes stale with no error | none — § *A `computed()` misses its subscription* | deploy |
| — | **Generated apps are pure Vapor** — the scaffold mounts with `createVaporApp`, every SFC is `<script setup vapor>`, and Lucide icons compile through `unplugin-icons` | none — § *Generated apps are pure Vapor* | deploy |
| ⑤ | **The ontology history is one committed file** | [nebula-ontology-history-file.md](nebula-ontology-history-file.md) — design intent only; independent of ④, either order | **data** |
| — | **Shared pages** — Universe Signup, Galaxy create and login: scope full names captured at claim, and per page whether an app forwards to ours or runs its own | none — § *Shared pages* | **data** |
| ⑥ | **The wipe + redeploy** | § *⑥ The wipe* | — |
| — | **Turn-log inspection v0** | none — § *Turn-log inspection v0* | ungated |
| — | **The superuser → impersonate join scenario** (~¼ day) | none — § *The superuser join scenario* | ungated |

**Why this order.** Risk — and here risk is unresolved design rather than hard implementation (Larry, 2026-09-02: *"I should favor doing the riskiest ones first"*). ① — the guidance file tree, now built (§ *Shipped*) — was the largest unknown and gated ②. ② carries the most design uncertainty, so it follows its prerequisites at once: ①, and the scope's move to a subdomain, since a persona tab needs a host of its own. ③ is small but irreversible: day-1 signal that was not captured is gone. ④ and ⑤ are the biggest and the best understood, and size is not risk when the shape is known. The toolchain row goes first because it changes the runtime under every pool test, which is cleaner between builds than inside one, and every build after it is then tested at the date production launches with. ⚠️ **"Before the wipe" orders nothing** — there is exactly ONE deploy, so every line of code here precedes it; only the `data` gate is real.

**After the wipe — invite, then the feedback loop:**

- **Provision + invite ~4–5 users**, each with a tailored first-app idea (Sydney → secret-santa + wishlist). Involvement achieved; capture already live.
- **Inbound `claude@lumenize.io` → durable store** (R2 or a DO, readable via the Cloudflare MCP) — the first real exercise of [nebula-outside-world.md](nebula-outside-world.md)'s inbound-email primitive.
- **In-Studio feedback button v0** — dead simple ("this broke / I wish"), into the same store.
- **Daily digest v1 (by 7:30am)** — cron → yesterday's turns + behavioural signals → judge scores → lands in the store → a scheduled morning Claude Code session writes the human digest and prompt-improvement suggestions, reviewed and never auto-applied, with a spend line. Build only after § *Turn-log inspection v0* shows what is worth automating.
- **Data-bound generation (EXPLORATORY)** — the empirical prompt loop. Un-parks [on-hold/nebula-offline-prompt-harness.md](on-hold/nebula-offline-prompt-harness.md) and [on-hold/nebula-skills.md](on-hold/nebula-skills.md), and is the first rung of [on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md) — Larry's stated next big track, gated on usage density. Notes in § *Data-bound generation*.
- **Ontology annotations** (`@title` / `@description` / `@inverse`) — a data-bound prerequisite, additive to `extractTypeMetadata`.

**Cheap before invites, never gates.** Each has a backlog row carrying the reasoning; they are listed here only because the window closes once someone other than Larry reads the output:

- Typed errors from the scope/admin gates, so "it's broken" is distinguishable from "you were refused" → [backlog.md](backlog.md) § *Nebula*, the bare-`Error` row.
- `@lumenize/structured-clone`'s error rehydration and its published doc caveat → [backlog.md](backlog.md) § *Lumenize Mesh*, the `globalThis` row.
- A runtime verify step for the codegen loop → [backlog.md](backlog.md) § *Nebula*, the runtime-verify row.

**Close-out, after pre-alpha ships:**

- 👤 **Larry's hand-review of ADR-011 onward** — inputs in § *ADR hand-review*.
- **npm publish** from merged `main` (`/release-workflow`); no package has been published yet.
- **`pre-alpha` → `alpha`:** PR `pre-alpha` → `main`, release, branch `alpha` off `main`. Continuous CI comes from an open draft PR `pre-alpha` → `main`.

---

## The test toolchain and the compatibility date

Production should launch at compatibility date 2026-10-01, and our pinned test toolchain cannot run that date. So the toolchain moves first and the date follows, in two commits.

- **Why 2026-10-01.** From that date `durable_object_io_tasks_prevent_eviction` is on by default ([changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/)). A pending binding call, DO RPC, `fetch()`, `ctx.waitUntil` promise or timer then keeps a DO in memory after its caller has gone, for up to 15 minutes per operation. The Galaxy needs it: `runTriggeredTurn` runs after the commit that triggered it has answered, and a deployed Galaxy calls the model through the `env.AI` binding, because neither the `nebula` nor the `test-nebula` worker has a `WORKERS_AI_TOKEN`. That shape was evicted at 08-15 and held at 10-01 ([experiments/residency-hold/RESULTS.md](../experiments/residency-hold/RESULTS.md) § *Round 2*).
- **Why the toolchain goes first.** Our pinned workerd, 1.20260815.1, accepts dates only up to 2026-08-22 and does not know the flag by name. Given either, `wrangler dev` refuses to start the Worker, which takes `npm run dev` and every `/live` scenario down with it. Pool-workers is worse: it exits 0 having skipped every test file that runs inside workerd. `packages/structured-clone` ran 31 of its 46 files that way on 2026-10-01, so CI would have read green.
- **The move is to `@cloudflare/vitest-plugin`, the v1 rename of `@cloudflare/vitest-pool-workers`.** The old name has had no release since 0.22.0 (2026-08-18), and npm does not mark it deprecated, so nothing in the tree tells you. On 2026-10-01 the newest `vitest-plugin` was 1.3.4, on wrangler 4.145.0 and miniflare 5.20260930.0-alpha (workerd 1.20260930.2). Whether that workerd accepts 2026-10-01 is not yet checked, so run one workspace at the new date before sweeping. The `-alpha` is a maturity label, not a reason to defer (`calibration.md` §8).
  - **Rename and bump are one job.** No `vitest-plugin` release pins our wrangler — the first, 1.0.0, already moves it to 4.125.0 — so there is no rename-only step. Choose the version on the day and read its pair with `npm view @cloudflare/vitest-plugin@<version> dependencies`; 1.0.0 through 1.3.1 each pin a different wrangler.
  - **Declare `vitest-plugin` exact, as we already do `wrangler`.** Our `^0.22.0` could only move within 0.22.x. A `^1` range floats across minors on the next full re-resolve, each minor brings its own wrangler, and the tree splits: the tests on the plugin's runtime, `wrangler dev` on ours. That is the split `workflow.md` § *Toolchain bumps* measured for a caret on `wrangler`. The codemod writes `^1.0.0`, so change the `devDependencies` entry by hand.
  - **The runtime jump is smaller than it was.** The miniflare 4 → 5-alpha move landed in `0fb3ea2` (2026-08-30); what is left is six weeks inside one major. It still changes the workerd under every pool test, so budget the full suite, a `drive.ts all` sweep, and the deployed pass `live.md` § *Two venues, one registry* requires after a triple change. Treat an unexplained new failure as signal.
  - **Published packages declare it in `peerDependencies`** — `@lumenize/mesh`, `@lumenize/testing` and others — so the rename reaches anyone who installs them. Renaming a peer is a breaking change: flag the next release (`workflow.md` § *Releases*).
  - **The codemod is `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`, a text rename over JS, TS and JSON files.** It covers the dependency and peer entries, the `vitest.config.js` imports, the tsconfig `types` entries and `cloudflare-test-env.d.ts`'s reference. That is all the source needs: 0.22.0 already serves the `cloudflare:test` types from `./types`, as v1 does, and `cloudflareTest()` is unchanged, so no test bodies change. Three things it does not do:
    - **Move our exact `wrangler` pins**, including those in the `workspaces` experiments that declare `wrangler` without the plugin — bump those or drop them from `workspaces` (`workflow.md` § *Experiments*).
    - **Touch Markdown** — the rules that name the package, `workflow.md` § *Toolchain bumps* first (it calls the package the knob), and the `website/docs` pages that tell readers to `npm install` it.
    - **Stay inside `workspaces`** — unrestricted, it also rewrites the spikes no longer listed there. Restrict it with `--files` to the `workspaces` entries and the root `cloudflare-test-env.d.ts`, then grep the bare old name (`workflow.md` § *Symbol renames*).
  - **Open for Larry:** whether the rules keep calling the in-workerd Vitest lane "pool-workers" once no package has that name.
  - **This is also the first step toward `cf`** ([launch post](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)). Tests can load `cloudflare.config.ts` through `vitest-plugin`'s `cloudflareTest({ experimental: { newConfig: true } })`; the old package cannot. It decides nothing about adopting `cf`.
  - **Leave Vitest at 4.** `vitest-plugin` 1.3.4 still peers `vitest ^4.1.0`, so Vitest 5 waits for the plugin.
- **Then the date, repo-wide, in its own commit.** Every workspace's `wrangler.jsonc` moves to 2026-10-01, along with what the 08-15 bump (`6041f17`) moved beside them: the floor in `critical.md` and `packaging.md`, the dates in the `website/docs` examples, and the regenerated `worker-configuration.d.ts` files. Experiments keep their dates. The same commit hands the turn `runTriggeredTurn` floats to `this.ctx.waitUntil`. On a DO that did nothing at 08-15, and at 10-01 it holds the whole turn from its start, which the 14-minute generation deadline keeps under the 15-minute cap.
- **Check both commits by test-file count, never by exit code.** Record each workspace's `Test Files N passed` before the change and compare after. Add a check to `scripts/test-code.sh` that fails when workerd refuses a date or a flag, so the next bump cannot repeat the silent skip.
- **Rewrite what the measurement falsified, in either commit.** Galaxy's comment in `runTriggeredTurn` says an open outbound connection holds the turn, but in production the model call is a binding call, which held nothing at 08-15. The comment above `executeEnvelope`'s `waitUntil` calls it a no-op on a DO, which stops being true at 10-01. `durable-objects.md`'s `setTimeout` bullet tells the reader to ride an open outbound connection. And `backlog.md`'s `keepAlive` row goes, because the platform now holds the DO itself.
- **It also unblocks** the container-snapshot item in [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 11: Snapshots replace the deps baked into the build-box image*, which needs wrangler 4.135 or later.

## ② Personas

Its task file is the authority: [nebula-testing-with-personas.md](nebula-testing-with-personas.md). The inputs this section used to hold moved there on 2026-09-08 — the pins into its § *Pinned*, the disk facts into its § *Verified on disk*, and what was still to settle into its open-questions list, which `/review-task` Stage 1 cut to ten decisions the same day. Larry has since answered those and nine more over a Pass-1 review, and every verdict now sits in that file's § *Pinned* beside the alternative it beat.

## Turn-liveness heartbeat

✅ **BUILT 2026-09-03.** The server beats through the **whole turn** — [turn-heartbeat.ts](../apps/nebula/src/turn-heartbeat.ts), wrapped once at `Galaxy.#chatTurn` — with an empty transient chunk every quarter of the client's idle window (`TURN_HEARTBEAT_MS`, derived from `TURN_IDLE_MS` in [turn-liveness.ts](../apps/nebula/src/turn-liveness.ts) so the two cannot drift apart). The client treats an empty chunk as liveness only: it re-arms the window and paints nothing, so "thinking…" stays up instead of a blank bubble (`App.vue`'s stream hook).

**Bounded, deliberately.** `callModel` has no timeout of its own; a hung model call runs until the 300 s generation deadline releases the latch. The heartbeat stops at that same deadline so it cannot mask the hang the window exists to catch — a dead turn still fails, one window later than before rather than never.

**The lesson the build taught, worth keeping:** the first cut wrapped only the codegen loop's two awaits (model call, container build). `first-app-built`'s new live watch caught the banner painting *before codegen had started* — the discriminator and the entire plain-answer generation are silent model calls too. The turn is the unit of liveness, not any await inside it. That watch (limb 3: no banner mid-turn, no empty bubble, across a real 60–100 s turn) is what now locks the flash out.

**Deliberately not here:** a per-call `callModel` timeout — it changes the model lane's failure semantics and is parked in [backlog.md](backlog.md) § *Other Nebula backlog*. Real token streaming, first parked beside it, was pulled forward and built the same day (`apps/nebula/src/model-stream.ts`, 2026-09-03): the thinking now arrives as it is written, so the heartbeat covers only the builds and the gaps between calls.

## ③ Capture live

Confirm generation capture is live on deploy, then extend it with UI events — undo, abandon, feedback — sharing the sink with the feedback button. Capture reads the agent `Message` Resources (the collapse's turn-as-Resource model; the old `Turns` side table is gone). The git-hash half is DONE — `codegen.sourceCommit` is captured before the loop writes, so a prompt replays from its exact starting code — the prerequisite for the nightly replay loop, which reads testers' turns cross-scope through the harness's `*` reach against the bench in [on-hold/nebula-offline-prompt-harness.md](on-hold/nebula-offline-prompt-harness.md). Its risk is not difficulty but being the thing squeezed at the end: everything else in the run is repairable in a later deploy, and this is not.

- ⚠️ **A turn that dies at the deadline is never captured.** A handled failure does commit a reply — `done('error', …)` returns rather than throwing — but the deadline's `Promise.race` abandons the turn body, so nothing lands and *“how often does a turn hang?”* has no durable answer. `commitAgentMessage` hardcodes `status: 'complete'` at its one write site, which is where a terminal record would start meaning something.

**`report_finding` — the model as a reporter (moved here 2026-09-03 from the guidance task, where it was a bad fit).** A codegen tool the model calls when a doc misled it or an API misbehaved; the result rides the turn's agent `Message` as structured capture — tenant-local, deduplicated at the digest, and read by a human before anything reaches a public tracker. Never a direct GitHub filing from inside a tenant's Galaxy: that crosses the tenant boundary carrying possibly injected content, and its natural failure is pasting a user-developer's ontology into a public issue. Three homes: the record field is capture and is ③'s; the human-gated filing is the digest's (Wave 3); the standing instruction that tells the model *when* to report is guidance and is [nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md)'s. A broken link in the platform tree is not this tool's job — that tree's generator resolves every link at build time and fails on a bad one. The same acceptance events — undo, abandon, feedback — have a second consumer: **scaffold-level learning**, where a corrected or abandoned turn feeds the platform's own guidance evolution ([on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md) § *Part B*). The app-level retro needs no such signal — the transcript in the prompt lets the model see a correction as it arrives, so that one is a standing instruction in the guidance task.

**The preview's error channel — folded in here 2026-09-09, and it may split into its own task file once ③ starts.** A user-developer says *"the preview screen is blank"* and the model's first move is to read the log tail. `@lumenize/debug` already has `setDebugSink`, but it is fenced test-only, **bypasses the DEBUG filter** and **REPLACES console output** — all three deliberate for tests. Production wants the opposite on the last two, so the package gains a **second callback**: filtered, and additive to console. Two slots rather than a flag, so neither semantics has to be re-derived at the call site and the filter is never duplicated in a sink function that may not even hold the filter value. The scaffold's `nebula.ts` installs it, entries land in this section's sink, and a loop tool reads the tail — one entry in `LOOP_TOOL_ENTRIES`, which sits at the chat floor. A later tool letting the model widen its own DEBUG filter is additive on top and is not owed now.

- ⚠️ **Decide before the buffer is written: an entry carries the persona slug.** ② opens N previews at once, so an untagged tail is N interleaved streams and *"the preview"* is ambiguous. Tagging is cheap at write time and unrecoverable after.
- ⚠️ **The scaffold half does not retrofit.** `nebula.ts` is seed — the model writes `App.vue` and components — so an app created before the sink lands keeps a copy without one, and nothing tells the model to go back. That is what puts this before the one deploy rather than in fast-follow.
- **Its trigger and first consumer is ②** ([nebula-testing-with-personas.md](nebula-testing-with-personas.md)), where a denied persona tab and a broken one look identical without logs.

## Turn-log inspection v0

Manual: registry-resolve the user's `{u}` → a super-admin delegated token → fan out the user's `Message` Resources → a local JSON corpus the assistant reads to answer Larry's questions. Built once, inside the `/live` harness ([archive/claude-live-verification.md](archive/claude-live-verification.md)), so it is local tooling that never rides the deploy, and `Message` Resources already exist. Slot it anywhere, including after the invites.

## The superuser join scenario

Both halves are driven separately: the front door by `superuser-front-door.ts` (the platform membership mints at the consume, behind proof, so a superuser arrives through the ordinary scope-less login), impersonation by `impersonation-lifecycle.ts`. Unproven is that they compose — one scenario chaining superuser login → Home → the pre-alpha user's host → impersonate them there, which is exactly the coaching session. If it turns up gaps, that is when a child task file earns its existence, and not before.

## Denied access in generated apps

**Under ④'s D25, an app with no UI for what a subscriber can't read looks like it works.** Bob sees 20 of a project's 21 tasks, and nothing tells him one is missing unless he compares notes with a coworker. All-or-nothing would have failed loudly instead, and lost because it costs Bob all 20 when one task is out of his reach (Larry, 2026-09-28). So D25 is the better experience only once the app shows the missing part.

This item settles two things:

- **What a generated app shows.** A query handle already carries `deniedNodes`, and after ④ a resource handle carries them too, with its `.snapshot` resolving `null`. The app names what is missing and who can grant it. It needs no code for the grant arriving: a client watching the org tree re-subscribes whatever was denied at the next tree change (④'s D25), so once an admin grants access the missing task simply appears. Who that is when the climb finds no admin, and how the request reaches them, are [on-hold/nebula-request-access.md](on-hold/nebula-request-access.md)'s open questions; this item needs only enough of them for the app to point somewhere.
- **What Studio's guidance says.** The model builds that affordance by default, without being asked. Each piece lands in its home per `studio-guidance.md`: the convention in `apps/nebula/platform/AGENTS.md`, the procedure in a skill, and the reference in `api-reference.md`.

## A `computed()` misses its subscription

**A component's `computed()` that switches to a resource id the store already holds never subscribes it, and the view shows stale data with no error.** Take `computed(() => store.resources.Todo[selectedId.value])`. When `selectedId` changes, Vue re-runs the getter during the render's dirty check, where neither an effect scope nor a component instance is active, so `trackRead` in `apps/nebula/src/frontend/create-nebula-client.ts` ties the read to nothing.

- **Why it mostly works today.** A never-seen id is rescued by accident: the read writes `{}` into the store, that write runs the getter again inside the render, and there the read subscribes.
- **When it fails.** The id was read once outside any scope, or read by a component that has since unmounted and let it go. Either way the store already holds it, nothing is written, and the getter does not run again.
- **Evidence.** Found 2026-10-03, failing identically on Vue 3.5.34 and 3.6.0-rc.10: [experiments/vue-vapor-autosubscribe/RESULTS.md](../experiments/vue-vapor-autosubscribe/RESULTS.md) § *A pre-existing bug the spike surfaced*, whose `npm run test:revisit` reproduces it. A `watch` getter reading a new id after setup should miss the same way; that is not yet probed.

It lands before § *Generated apps are pure Vapor*, so that item builds on a store whose every read subscribes.

## Generated apps are pure Vapor

**A generated app should be a pure Vapor app before the first user builds one, so that nobody's app needs migrating afterwards** (Larry, 2026-10-03). The repo is already on Vue 3.6.0-rc.10, and the store's auto-subscribe works inside a Vapor component, checked with a mutation in [experiments/vue-vapor-autosubscribe/RESULTS.md](../experiments/vue-vapor-autosubscribe/RESULTS.md). The one thing to avoid is mixing the two modes: a Vapor component inside an ordinary app ships both runtimes and roughly doubles the scaffold's bundle, while a pure Vapor app shrinks it (that file's § *Bundle size*).

Four things change:

- **Icons.** `lucide-vue-next`, the one import `apps/nebula/platform/AGENTS.md` allows, renders nothing at all in a pure Vapor app, with no error and a green build. So do its renamed successor `@lucide/vue` and `@iconify/vue`. `unplugin-icons` with `compiler: 'vue-vapor'` compiles Lucide's set into Vapor components at build time — `import House from '~icons/lucide/house'` — and replaces it in the scaffold's `vite.config.ts`, the image's baked dependencies, and that guidance line. Studio's own UI keeps `lucide-vue-next`; moving Studio is not part of this item.
- **A check for what the compiler lets through.** Under `vapor`, `v-memo` compiles and is silently dropped, and `@vue:` events and `getCurrentInstance()` compile too; only the Options API fails. The guidance names all three, and a check over the generated source refuses each one loudly. Whether that check sits in `container/compiler/sfc-check.ts` or in the codegen loop is this item's call.
- **The scaffold and the contract.** `main.ts` mounts with `createVaporApp`, `App.vue` takes `vapor`, `scaffold-seed.ts` is regenerated, and `TOOL_CONTRACT` in `codegen-loop.ts` and the Vue surface in `sfc-contract.ts` say Vapor.
- **The docs.** `using-vue.md`'s CDN example compiles its templates in the browser, which Vapor cannot do, so it is marked as the ordinary mode or removed. `coding-your-ui.md`'s "render-function modules" stops being true.

**The proof is `first-app-built` building a pure Vapor app whose icons render.** That needs a new limb checking that the `<svg>` is present, because a broken icon fails silently.

**If Vue 3.6.0 has shipped by then, the pins move to it first.** Every `3.6.0-rc.10` pin becomes `3.6.0`, and both `"overrides": { "vue": "$vue" }` blocks go, in the root and the scaffold `package.json`. They exist only because no plugin's `vue` peer range admits a prerelease.

## Shared pages

**The pages several builds touch — Universe Signup, Galaxy create and login — are one item** (Larry, 2026-09-16). Universe Signup already asks for the account's slug and its first app's, since the claim writes both. This item captures scope full names on the first two, below. It also decides, page by page, whether a user-developer's app forwards to ours with `return_to`, which is the default, or runs a page of its own that posts what it collected to the platform host, gets a one-time token back, and navigates on with it to the platform host, which finishes the way login does. Which kind comes first is this item's call, and the custom kind may land after pre-alpha. [nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) caps the slugs these pages collect at 30 characters, and names the one `POST` ADR-022 would need to admit for a custom page.

### Scope full names

`Scopes` is one column — `universeGalaxyStarId TEXT PRIMARY KEY` — so a Universe, Galaxy or Star has no human name anywhere, and its slug is doing two jobs at once. [nebula-upgrade-universe-with-a-data-plane.md](nebula-upgrade-universe-with-a-data-plane.md) stores each name as a scope-metadata resource on the scope's own host, never on `Scopes`, written where the scope is created: the two universe claims, which also write the first app, `claimStar`, and `createGalaxy` for every later app. **Two pages already exist and both gain the field: Universe Signup and Galaxy create** (Larry, 2026-09-11). Star signup is NOT pre-alpha — only the `.dev` Star is created in this cycle — so `claimStar`'s column is written without a page to type into yet. **It is `data`-gated for a reason no other item here has: the name is only knowable at the moment it is typed.** Nothing derives "Northwind Traders International" from `northwind-traders-intl`, so a claim path that never asked leaves nothing to backfill — and after the wipe the people being asked are real users, whose names would be discarded permanently rather than for a cycle.

It also decides how the slug cap lands. [the domain-allocation record](archive/decision-domain-allocation.md) § *C — nested scope labels* caps every slug at 30 characters, because a persona and a Star share one 63-character DNS label. With a name captured beside it, signup reads *"Workspace name: Northwind Traders International → URL: `northwind-traders-intl`"* with the slug editable; without one, the same cap reads as "that name is too long" and the slug is all the user ever gets to say.

**Capture only — the display surfaces are a separate question and gate nothing.** Whether a breadcrumb, the org tree, the scope picker or the Studio header shows the name or the slug has real answers on both sides, and an unread column misleads nobody while an uncaptured name is unrecoverable. ⚠️ **The name is display-only: never in a URL, never unique, never compared, never looked up, and nothing derives it from the slug or the slug from it after the claim.** Break any of those and a scope has two identifiers, which is what capping the slug rather than hashing it was chosen to avoid. It is the rule a persona name already follows — the slug is the identity, the name is a display attribute the model may edit freely.

## The certificate wait

Folded into [nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) on 2026-09-15 (Larry) and built there: its § *Design intent, constraints, and future state* carries the wait on Galaxy create and its count-up, and a galaxy's teardown deletes its certificate pack before it wipes, so the soft-delete reaper has no certificate work.

## ⑥ The wipe

One CF-dashboard worker-delete + redeploy, deliberately one and not two. Greenfield means every DB is created fresh. Runbook: [archive/do-exports-and-toolchain-upgrade.md](archive/do-exports-and-toolchain-upgrade.md) § *Phase 4* — not the surrogate-sub file's older `migrations`-shaped narration, which the declarative `exports` conversion superseded.

**The wipe is the closing window for free schema surgery**, and several built things already lean on it: the identity model's collapsed `REGISTRY_MIGRATIONS` baseline, `Snapshots.actingToken`, and `subscriptions.ts`'s in-place migration edit. The constraint they share, and that ④ and ⑤ inherit: **no deploy stands between those rewrites and the wipe.**

**Ops at the deploy:**

- **Secrets.** `deploy.sh`'s preflight refuses to deploy without `NEBULA_AUTH_BOOTSTRAP_EMAIL`, the JWT key pair and `RESEND_API_KEY` and `CERTIFICATE_API_TOKEN`, and prints the exact command. `NEBULA_AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com, claude@lumenize.io` seeds the two superusers: Larry, and Claude acting as itself (Larry, 2026-10-03). Claude acting on Larry's behalf waits for the consent-gated support session, `backlog.md` § *Other Nebula backlog*. ⚠️ **Production's JWT pair and its certificate token are production's own, set only as its secrets and never copied from `.dev.vars`.** That template already labels its keys *"test keys - not for production"*, and sharing them lets an admin token minted on the test target or a local stack verify here. `.dev.vars` also holds the test zone's certificate token, which would order packs on the wrong zone ([nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) § *Decisions*). The hint the preflight prints copies from `.dev.vars` today, so it changes for those values. Every other value still comes from that file; [backlog.md](backlog.md) § *Infrastructure* is where that stops being ad hoc. What stays open on email is in [backlog.md](backlog.md) § *Nebula Auth*, the Resend rows.
- **DNS and certificates, after the worker-delete.** Production's `CERTIFICATE_ZONE_ID` var, and proxied `*.lumenize.dev` and apex records on `lumenize.dev`, whose Advanced Certificate Manager has been on since 2026-09-11. The same step gives `lumenize.dev` a null SPF record (`v=spf1 -all`) and a `p=reject` DMARC record, since the zone sends no mail and goes live here, and a DMARC record on the apex covers every host beneath it. Each step is outward-facing ([nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) § *Constraints* carries the test zone's matching list).
- **`wrangler containers delete` the retired `nebula-devcontainer` application** (still listed on the account, 2026-09-03). A dashboard worker-delete removes DO namespaces, not container applications, and this cannot be a phase criterion because it fires after a deploy that happens long after `/build-task` ends.
- **Smoke:** a real-CF KV login → refresh across colos. A KV miss falls back to the registry's `RefreshTokenIndex`, a deliberately live path.

**Post-wipe cleanup — done early, 2026-10-03.** [nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) deleted `develop()`'s repair, `/create-star` and `createDevWorkspace`, and `provisionAndLogin` now founds a tenant Star by `claim-star`. ⚠️ **A question died with the endpoint, so do not re-open it:** an admin-pre-created, member-less tenant Star was the one state a stranger could capture by claiming its slug, and nothing creates that state now; the only member-less star rows left are `.dev`, refused as a reserved name. The policy was remediation rather than prevention anyway (Larry, 2026-09-08): an admin above deletes any scope beneath them, members and all, which frees the slug for the real founder to claim ([ADR-015](../docs/adr/015-passage-and-dominion.md)).

## Data-bound generation

Two kinds of EXPLORATORY, neither pinnable up front:

1. **Prompt-empirical** — data-bound generation quality. Iterate the system prompt against the compile gate and, later, a judge model, driven by capture → inspection → the replay harness. Capable-of-failing checks plus captured findings, never a transcribable spec.
2. **UX-exploratory** — the persona UI. Prototype-and-react, and the tight loop is Larry's own dogfooding: persona switching, multi-tab use, and the preview tabs.

Iterating the prompt must not require a deploy — the prompt is content, not code. Tight loop = the offline replay harness (model + gate, seconds, no preview); live checks = local `wrangler dev` + Docker; deploy only for where users live and for realistic multi-tab / auth / act-as checks, at ~1-minute cycles and not every iteration. The platform layer is `apps/nebula/platform/` — edit, run `node scripts/gen-platform.mjs`, and `wrangler dev` picks it up.

### Findings — the model in the loop, observed

One line per observation, appended, never edited: `date · limb · pass|fail · one sentence`. The limbs are the `/live` scenarios that watch the real model — `studio-guidance-loop` (a) (b) (c) (d) (f), `four-party-chat` (e), `first-app-built` (g) — each reported by the scenario and never gating a sweep; a fail is a finding for ③ and for the platform file's next edit. Un-parking this section's exploratory loop starts from the last line here.

- 2026-09-05 · (a) · pass · asked for a wishlist, the model's `App.vue` reads and writes through `store` / `client.resources` — the 2026-09-03 hand-driven gap did NOT reproduce; the turn read `resources.md`, `coding-your-ui.md`, `ontology.md` and the `wire-a-view` skill first, and hit the round cap on container-free builds (8 rounds, 70 s)
- 2026-09-05 · (b1) · pass · "no countdown timers", stated in turn one, was honoured by the next turn's output
- 2026-09-05 · (b2) · pass · after ten further turns the rule is still in `AGENTS.md` (568 bytes)
- 2026-09-05 · (c) · fail · the convention landed in `AGENTS.md` on the turn it was stated (`edit_file`, `applied=AGENTS.md`), but the reply did not name the file — the retro's "say so in one sentence" half is the platform file's next edit
- 2026-09-05 · (d) · fail · a request naming data the app did not hold activated `wire-a-view`, not `define-ontology` — it wrote the ontology anyway, under the view skill; the two descriptions overlap on "data", and `define-ontology`'s trigger needs to win when the type is absent
- 2026-09-05 · (f) · pass · asked what was requested first, the reply named the rule word for word
- 2026-09-05 · (e) · pass · four-party "what does this app do so far?" — the reply named what the seed app has: the starter shell, the one `Item` type in the ontology, the placeholder page — and invented nothing
- 2026-09-05 · (g) · pass · on the real `first-app-built` turn the first write landed 32.3 s before the `build` call (the hint had warmed 49.8 s ahead; the cycle then took 3.9 s) against a 3.2 s cold start — the write warm alone hides it, so the discriminator's hint is dead weight on this shape; n=1, so keep it through one more pass and drop it in ③'s edit if the second number agrees
- 2026-09-05 · (g) · pass · second pass, same turn shape: the first write landed 7.5 s before the `build` call (the hint had warmed 52.9 s ahead; the cycle took 3.9 s) against the 3.2 s cold start — the second number agrees, so the hint is dead weight on this shape; n=2, and the drop goes in ③'s edit as the line above says
- 2026-09-05 · (c) · pass · second pass: the convention landed in `AGENTS.md` and the reply named the file. The first pass's fail did not reproduce on an unchanged line of the platform file — variance, so the "say so" edit stays queued rather than urgent
- 2026-09-05 · (a) · fail · second pass: no `App.vue` was written (stop=no-tool-calls, rounds=3). The turn read four platform files and the source, then replied without a write; the first pass wrote it. Variance, not the 09-03 shape — that one wrote user data outside resources
- 2026-09-05 · (b1) · fail · second pass: not exercised — no `App.vue` this turn, which the limb now counts as a fail rather than a pass with nothing to judge
- 2026-09-05 · (d) · fail · second pass: `wire-a-view` again, never `define-ontology` — reproduced. The two descriptions' split on "the type is absent" is the platform file's next edit, now with two runs behind it
- 2026-09-05 · (b2) · pass · second pass: after ten further turns the rule is still in `AGENTS.md` (556 bytes)
- 2026-09-05 · (f) · pass · second pass: the reply quoted the first request word for word
- 2026-09-05 · (e) · pass · second pass: "a starter shell", then the one `Item` type with `title` and `done` — named what the seed has, invented nothing
- 2026-09-05 · (g) · pass · third pass: the first write landed 31.7 s before the `build` call (the hint had warmed 56.2 s ahead; the cycle took 3.5 s) against the 3.2 s cold start — n=3, all three agree, the hint is dead weight on this shape
- 2026-09-06 · (g) · pass · under the 32-round cap a turn ran two build cycles: write→build 21.0 s and 10.1 s (hint 38.2 s and 61.8 s ahead; cycles 9.0 s and 12.9 s) against 3.2 s — n=5 intervals, every one above the cold start
- 2026-09-06 · (g) · resolved · the hint is deleted (Larry): five intervals from 7.5 s to 32.3 s, every one above the 3.2 s cold start, so the first-write warm is the only warm and the classifier call with it; limb (g) retired with its question
- 2026-09-06 · (d) · pass · fixed: the two skill descriptions made disjoint and the Skills section naming the order, `define-ontology` was read first on both passes (2 of 2; 0 of 3 before). The skill itself now carries the ask-or-propose judgment — the prompt's shape, then the user-developer's preference once the profile holds it, then the conversation (Larry, 2026-09-06)
- 2026-09-06 · (a) · asked · pass 1 under the new skill: the wishlist prompt names fields, and the model asked about the shape instead of building — the judgment the skill describes, so the limb now reports "asked" rather than fail; pass 2 built `App.vue` through the store
- 2026-09-06 · (c) · pass · pass 2 under the new skill: the reply named `AGENTS.md`; pass 1 did not — still variance, one of two
- 2026-09-25 · (g) · fail · the SCENARIO fails, for a non-model reason and a new one: making `ontologyVersion` optional let the preview app boot for the first time (2 WS upgrades against 0 before), and the newly-live client draws `subscribeTree` refused at the GALAXY — which `NebulaClientConfig`'s own JSDoc says does not host it, and which `constructionPairs` routes there for any galaxy-tier driver — plus four `refresh-token` 401s and a container `exit code: 137` that is not explained. Proven by stash: green without the change at 60.5 s, red with it at 152 s, twice on a cleaned Docker. Backlog row carries it; the limb itself was never reached


## ADR hand-review

After pre-alpha ships (Larry, 2026-09-02); the old trigger, "after the collapse", is retired. Reviewing is not ratifying — no ADR is ratified until after launch. ADR-010 was the last one carefully hand-reviewed, and Larry's standing read narrows the pass: **ADR-015 is rock solid** (two passage/dominion task files went by without changing it — keep it current as we go rather than deferring to this pass), **012 and 013 have solidified**, and the rest are what the pass is for. Inputs:

- The best statement of the coarse-grained access model (`{u}.{g}.{s}`) is frozen at [archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md) § *The invariant* and § *Settled* — decide what lifts into an ADR or a rule, and whether ADR-012 shrinks back to visibility once an access ADR owns "a profile is never an authz input".
- 008 / 012 / 013 / 015 each cover one facet of one model — four ADRs or one?
- 008 / 009 / 013 carry dated amendment notes against `docs/adr/README.md`'s forward-facing discipline. Decide per file (009's may earn its place: it stops sessions citing a withdrawn latency figure) and write any carve-out into the README rather than leaving silent exceptions.

---

## Where pre-alpha sits

- **pre-alpha (THIS):** user-developers build data-bound multi-user apps, evaluated by them and us through personas. No real third-party end-user signup, and no migration testing — users have the wipe.
- **alpha:** the real-use publish path plus data migration. Writing migration code is easy; testing it is the hard part and probably needs Star branching (`tasks/icebox/nebula-branches.md`).
- **beta:** automated testing → near-production-ready. Then production.

**Two critical paths, one gate.** Involvement: codegen loop ✅ → capture live (③) → the wipe (⑥) → provision → invite. Feedback: capture → `claude@` email → digest → in-Studio feedback. THE GATE is capture live before the first invite.

**Pre-alpha users are Universe admins** (Larry invites, pre-picks slug + name). This is the decision that shrinks the security story: acting-as anyone is not an escalation. The residual non-security cleanup (drop `AuthorizedActors` → admins-only) is [on-hold/delegation-hardening.md](on-hold/delegation-hardening.md).

## Building blocks that exist

Don't re-derive these; the code is the authority.

- **Super-admin** is an ordinary membership at the reserved platform scope, `PLATFORM_SCOPE`, and that scope is the ROOT of the scope tree — so dominion everywhere is the downward rule applied from the top, one branch inside `isAtOrAbove` and never a special arm at a call site. Driven by `superuser-front-door.ts` and `superuser-end-to-end.ts`.
- **Impersonation** is one mint endpoint (RFC-8693 `act.sub`, recursive chain, audited), reached from the client as `NebulaClient.impersonate`. Act-as downscopes automatically because DAG checks key off the delegated token's `sub`, never `act`.
- **A galaxy-tier invite mints a membership at the galaxy itself, and a second at its `.dev` workspace.** The invitee authenticates at the galaxy, and one acceptance takes up both. The workspace membership's admin bit is the inviter's dominion verdict, so a peer's invite enrolls the invitee without it. `issueInvites` in `nebula-auth-registry.ts`; driven by `four-party-chat.ts`.
- **Enumerate-all-users** is `NebulaAuthRegistry`, the singleton with the global email → scope index.
- **The `onBeforeCall` passage guard** is `requirePassage(name, claims)` in `nebula-do.ts`, one audit point on every Nebula node — what lets the inspection instrument and a support engineer read, write and admin anywhere with one identity.

## Caveats

- All Universe admins ⇒ pre-alpha does NOT exercise tenant isolation. "Pre-alpha worked" validates codegen and in-app multi-user, not cross-Galaxy boundaries.
- The migrations one-way door has been open since the first prod deploy (2026-06-26): a DO-class add, rename or delete is a migration forever.
- The cost ceiling is set and Larry watches the CF dashboard; a spend line in the digest is a nice-to-have.

## Open decisions

1. **Starter scaffold on invite** — does the Universe invite auto-provision a starter Galaxy/Star (zero-click first build), or does the user self-create as a Universe admin? Lean: auto-provision, since a non-coder should not hit a naming wall on first login.
2. **Digest phasing** — v0 manual inspection now and v1 automated later (lean), or the 7:30am pipeline up front. Either way, capture is live before the invite.
3. **A second wipe between pre-alpha and alpha** — an option kept open, not a plan (Larry, 2026-08-24). Stash each user's Workspace repo (self-contained under ⑤: code + ontology history + migrations, one artifact per app) AND the codegen corpus (the Galaxy's `Message`s with their `codegen` value objects — the harvest THE GATE exists for), wipe, restore. Their `.dev` data is lost and we say so up front; identities re-mint on re-invite and stamped attribution degrades to display-only. It relaxes the one-wipe squeeze on structural work without licensing deferral, because every wipe still spends user goodwill.

## Links

- Engine design, reference only: `tasks/reference/nebula-agentic-engine-design.md`. Dev/publish flows: `tasks/reference/nebula-dev-flows.md`.
- Fast-follow, demand-driven and post-core: [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md), the parent index — each item carries its own trigger. Outside-world connectivity has its own design file, [nebula-outside-world.md](nebula-outside-world.md).
- Deferred out of pre-alpha: `tasks/on-hold/`. Each file's status line says why it waits and what would bring it back.
- Live harness: local drive = `apps/nebula/harness/` (the `/live` skill and the always-loaded `live.md` rule); prod drive = `apps/nebula/harness/prod.ts`, with standing authorization to drive and read prod when Larry asks — writes and deploys stay deliberate. Turnstile is OFF in prod (`TURNSTILE_SECRET_KEY` unset); the `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN` header bypass exists for when it flips on. Findings: `apps/nebula/harness/FINDINGS.md`.

## Shipped

One line each. The archived file is the record and the code is the authority.

- Profile access control — acceptance is enforced at the MINT. The owner branch drops its `act` clause, so an impersonated session owns its own profile → [archive/nebula-profile-access-control.md](archive/nebula-profile-access-control.md). What outlives it: [ADR-012](../docs/adr/012-global-profile-visibility.md), and `security.md` rules (1) and (2)
- ① The guidance file tree — platform layer in code, Galaxy layer in the Workspace, both read every turn; `read_file` + `edit_file`; the chat history in the prompt; one assembly per turn → [nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md) (archive on commit); the convention that outlives it is `.claude/rules/studio-guidance.md`
- Self-correcting codegen loop → [archive/nebula-codegen-loop.md](archive/nebula-codegen-loop.md)
- Generation capture, now the `codegen` value object on each agent `Message` (the `Turns` side table is gone) → [archive/nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md)
- `onBeforeCall` downward dominion → [archive/nebula-onbeforecall-higher-admin-reach.md](archive/nebula-onbeforecall-higher-admin-reach.md)
- `/mint-narrower-token` escalation fix → [archive/rfc-act-chains.md](archive/rfc-act-chains.md); the delegation invariants are pinned in `security.md`
- Studio UI single-origin serving → [archive/nebula-studio-vite-proxy.md](archive/nebula-studio-vite-proxy.md)
- Local UI smoke, the `ui-smoke` Playwright lane → [archive/nebula-local-smoke.md](archive/nebula-local-smoke.md); its `it.skip`s are owned by [backlog.md](backlog.md) § *Testing & Quality*
- First prod deploy, 2026-06-26 → [archive/nebula-release-process.md](archive/nebula-release-process.md)
- DevStudio data-plane extraction → [archive/nebula-devstudio-data-plane.md](archive/nebula-devstudio-data-plane.md)
- Parent-child query subscriptions → [archive/nebula-query-subscriptions.md](archive/nebula-query-subscriptions.md)
- Reactive AI chat → [archive/nebula-reactive-ai-chat.md](archive/nebula-reactive-ai-chat.md); its one open deferral, the viewport window driver, is a [backlog.md](backlog.md) § *Nebula Studio UI* row
- Data-use consent flag REMOVED — no consent column exists anywhere → [archive/nebula-consent-flag.md](archive/nebula-consent-flag.md); `@lumenize/sql-migrations` → [archive/sql-migrations.md](archive/sql-migrations.md)
- DevContainer wakeup fix → [archive/nebula-container-wakeup-fix.md](archive/nebula-container-wakeup-fix.md)
- Mesh continuation-only + `callAsync` → [archive/mesh-continuation-only-calls.md](archive/mesh-continuation-only-calls.md) · [archive/mesh-client-callasync.md](archive/mesh-client-callasync.md)
- Auth foundation: surrogate `sub` → [archive/nebula-auth-surrogate-sub.md](archive/nebula-auth-surrogate-sub.md) · identity data model → [archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md) · dominion vocabulary → [archive/nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md) · passage/dominion from scope → [archive/nebula-passage-dominion-from-scope.md](archive/nebula-passage-dominion-from-scope.md) · registry route guards → [archive/nebula-registry-route-guards.md](archive/nebula-registry-route-guards.md) · invite → [archive/nebula-invite.md](archive/nebula-invite.md)
- `Snapshots.actingToken`, the ADR-016 record — `identityKey`'s JSDoc in `snapshots.ts` carries the argument
- Compilers out of the Worker, and NO bundle split → [archive/nebula-move-compilers-out-of-the-worker.md](archive/nebula-move-compilers-out-of-the-worker.md); `check-worker-graph.mjs` is the standing tripwire
- Galaxy collapse + chat history UI, preview survives redeploys, ontology installs only by lazy-pull → [archive/nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md)
- Container vite on rolldown with `unplugin-swc` for decorators, shipped with the collapse — `vite.config.ts` says why the plugin is required ([[rolldown-no-tc39-decorators]])
- `createGalaxy` bundles `{galaxy}.dev` — its JSDoc carries the rationale
- Login prove-then-choose + the data-use notice; `discover(email)` deleted → [archive/nebula-login-prove-then-choose.md](archive/nebula-login-prove-then-choose.md)
- UI create-app flow coverage — `ui-smoke/smoke.test.ts` drives it
