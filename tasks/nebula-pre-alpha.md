# Nebula — Pre-alpha (master plan)

**Status (2026-09-03):** prod `nebula.lumenize.com` still serves `ada3f31`, deployed 2026-07-04. Everything since is UNDEPLOYED behind the one batched wipe + redeploy (§ *⑥ The wipe*), so do not read prod as evidence of current behaviour. F&F invites stay paused until the wipe has landed, and the wipe waits on everything above it in § *What remains*.

**Goal:** ~4–5 pre-alpha users — Larry's friends, family and business partners ("users," not "partners") — building their own data-bound, multi-user apps on a deployed Nebula, exercised through personas, with enough instrumentation for near-daily conversations as they build.

**How to read this file.** § *What remains* is the plan, in order. The sections after it hold only what an item needs and has no task file for yet; once a child task file exists it is the authority and this file keeps one line. Built work is one line in § *Shipped*. Work deferred past pre-alpha is not tracked here — it lives in `tasks/on-hold/` and [backlog.md](backlog.md), each item with its own reasoning. Children are written one at a time and archived on completion ([[feedback_task_file_one_at_a_time]]).

## What remains

**Three decisions first.** Each blocks a build below, and each costs hours of thinking rather than code:

1. **Personas — `impersonate()` or a real login per persona, and does a `synthetic` column land?** Blocks ②. The column is the one SCHEMA consequence in the run: answered early it rides ④ or ⑤ and the persona build can stay late; answered at the build, a yes means delaying the wipe or migrating live data. The argument is in § *② Personas*.
2. **Ontology — where compiled validators are stored**, tabled in [nebula-ontology-history-file.md](nebula-ontology-history-file.md). Blocks ⑤'s phases, and the Star-fetch path rides the mesh methods that task deletes.
3. **`QuerySubs` registers with no permission check — deliberate?** Blocks ④'s phases ([nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md) § *Open question*).

**Then the builds, riskiest first.** *Gate* is what an item waits on: `data` needs the greenfield DB and is a migration if missed; `deploy` only needs to be in the bundle; `ungated` never rides the deploy.

| # | Item | Task file | Gate |
|---|---|---|---|
| ② | **Personas** — synthetic users the LLM defines, each in its own preview tab | none yet, Larry's — § *② Personas* | deploy, plus `data` if the column lands |
| — | ✅ **BUILT 2026-09-03 — Turn-liveness heartbeat** — a truthful server signal through the whole turn | none — § *Turn-liveness heartbeat* | deploy |
| ③ | ⚠️ **THE GATE — capture live** | none — § *③ Capture live* | deploy |
| ④ | **Every Resources guard lives in the Resources plane** | [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md) — design intent only | **data** |
| ⑤ | **The ontology history is one committed file** | [nebula-ontology-history-file.md](nebula-ontology-history-file.md) — design intent only; independent of ④, either order | **data** |
| ⑥ | **The wipe + redeploy** | § *⑥ The wipe* | — |
| — | **Turn-log inspection v0** | none — § *Turn-log inspection v0* | ungated |
| — | **The superuser → impersonate join scenario** (~¼ day) | none — § *The superuser join scenario* | ungated |
| — | **Same-origin guard verdict** — "no guard" is a complete outcome | [nebula-same-origin-guard.md](nebula-same-origin-guard.md) | ungated |

**Why this order.** Risk — and here risk is unresolved design rather than hard implementation (Larry, 2026-09-02: *"I should favor doing the riskiest ones first"*). ① — the guidance file tree, now built (§ *Shipped*) — was the largest unknown and gated ②. ② carries the most design uncertainty, so it follows its prerequisite at once. ③ is small but irreversible: day-1 signal that was not captured is gone. ④ and ⑤ are the biggest and the best understood, and size is not risk when the shape is known. ⚠️ **"Before the wipe" orders nothing** — there is exactly ONE deploy, so every line of code here precedes it; only the `data` gate is real.

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

## ② Personas

Synthetic users the LLM defines, provisioned into the `.dev` Star and opened as separate tabs inside the preview window, each logged in as its own persona. Invite-gated and user-facing, decided 2026-09-02 on a real user: Jennifer builds one of her two pre-alpha apps in Claude Code, and testing her permission model — several tabs open, two personas at a time — is her standard operating procedure. Demand, not speculation, so the bar is day-1 self-service. The task file is Larry's to write; what follows are its inputs.

**The shape (Larry's sketch):**

- **The LLM writes a PERSONA file into the Workspace repo** as soon as the app has a permission model — day 1 for most apps — and it evolves with the app. Named personas, each with roles and permissions: the permission model written down, not a fixture beside it.
- **Studio materializes them** — accounts provisioned from the file, then opened in separate preview tabs, each logged in as its persona.
- **A `.dev` Star wipe re-establishes them** — re-provision, re-grant, re-login across the tabs.

**Mostly assembly, not new mechanism** (verified on disk 2026-09-02): `invite()` returns the minted `sub` (`InviteeSummary`); `getIdentityScope` does not filter on `acceptedAt`, so an unclaimed persona is impersonable; `impersonate(sub, activeScope)` is built and driven (`impersonation-lifecycle.ts`); `dagTree().setPermission` attaches the grants. **The one capability gap is a no-send mint** — `issueInvites` is mint-only with `sendInviteEmails` dispatched separately after it returns, so the seam exists; without it every wipe re-bounces real magic-link mail off the sender.

**Settle these in the design intent — cheap now, expensive later:**

- **Key the file on persona NAME, never `sub`.** Subs are ADR-010 randoms re-minted by every wipe, so anything storing one dangles.
- **Share ⑤'s Workspace-repo write path, not its append-only rule.** Personas are edited; history is not.
- **Per-persona identity lives in each iframe's own JS realm, never in Web Storage.** The preview is an `<iframe>` in `App.vue` and the personas are same-origin, so they share the top-level tab's `sessionStorage` and its cookie jar — `sessionStorage` partitions per tab, not per iframe. Every persona is also a member of the same `{u}.{g}.dev`, and the refresh cookie is `Path=/auth/{scope}` under one fixed name, so two logins there overwrite each other (the logout comment in `nebula-client.ts` names the hazard). `NebulaClient` takes an injected `sessionStorage` per context; that is the seam for giving each iframe a virtual one.
- **`impersonate()` or a real login per persona** — decision 1 above. An impersonated token carries `act`, and [ADR-012](../docs/adr/012-global-profile-visibility.md)'s owner branch requires `!claims.act`, so a persona made by impersonation is never its own profile's owner and anything keyed on ownership is untestable through it. A real login needs the credential isolation the cookie does not give, and a mailbox per persona.
- **Does a `synthetic` column land** — the other half of decision 1. § *Caveats* deferred `synthetic:true` as YAGNI until the digest needs to filter test users out of real-activity metrics, and every user will now mint several. One column is free before the wipe and a migration after. The justification expired, so re-derive it rather than adopting either verdict.
- **`impersonate()`'s teardown — answered 2026-09-06 by code and by `impersonation-lifecycle`, green in every sweep that day.** Disposing the parent tears every child down through one seam (`onClientTornDown`); a bare disconnect does not mark the parent torn down, so a blip or a reconnect leaves the personas intact. The consequence names the tab model: a child renews through its parent's IN-PROCESS mint helper, so persona tabs cannot be separate browser tabs — they are iframes inside the Studio page, a reload recreates them by construction, the set of OPEN personas is view state and rides the URL ([ADR-017](../docs/adr/017-the-url-is-the-view-state.md)), and each is re-minted on load from the persona file's name → `sub` map. Nothing fatal remains.
- **Credential isolation, answered the same day from the code:** the refresh cookie is one fixed name at `Path=/auth/{scope}` and the refresh route reads one cookie by name, so two personas in one jar at one `.dev` leave the server seeing the last login only — and the first persona's next refresh would hand it the second's identity, not a 401. The per-scope design keeps the OWNER's session safe beside the personas (a different path); it cannot separate two members of one scope. Real-login-per-persona therefore needs per-persona cookie names plus a sub hint on refresh, a `worker-token.ts` change with a first-refresh wrinkle; impersonation needs nothing. Claude's recommendation as input: impersonation, with per-persona cookies recorded as the fallback if profile ownership ever needs testing through a persona.
- **State the sizing.** Every persona is a membership row in the Registry, the [ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md) singleton. Pre-alpha's users × apps × personas is negligible but multiplicative; say so in the file so a later reviewer need not re-derive the worry.

Adjoins [on-hold/nebula-studio-multi-user-testing.md](on-hold/nebula-studio-multi-user-testing.md) (the same tab UI, and `/create-star`'s fate) and shares the subject/grant/scope core with [on-hold/nebula-request-access.md](on-hold/nebula-request-access.md), the pull half — share it, don't fork.

**Inputs from the guidance task (2026-09-04) — the cast's home is ①'s; what runs it is designed HERE.** [nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md) ships `docs/personas.md` as a numbered prose procedure keyed on persona NAME, a seed template naming the four verbs any org-tree shape composes from — mint, node, edge, grant — and a third seed skill, `define-the-cast`, that elicits the cast and each relationship's shape and hands the cast to the executor below as its last step. The run's record is machine-owned under `.nebula/` and survives `resetDevData`, which touches only the Star; its path and shape (per run: the realized tree plus the name → `sub` map) are decided here, with the executor that writes it. Everything below was decided in that task's design conversation and moved here so ① does not transcribe ②'s phases:

- **Execution shape:** the model reads the prose and produces one plan for `provision(plan)`, whose argument is a list of the four operations typed in TypeScript and validated by typia before dispatch (ADR-001, the tool-args pattern). The executor is deterministic and idempotent — create-if-missing throughout — and returns the realized tree plus the name → `sub` map, which the model compares to the prose in the same turn: plan, validate, execute. That result is the record. Rejected: the model executing granular tools step by step (four tools and its judgement on every re-provision), and a typed block Studio parses (the block becomes the DAG's own schema and the *why* has no home).
- ⚠️ **`provision` is not a loop tool.** It mints identities and grants `admin` and `scopeAdmin`, which sit above the chat floor, and the guidance task's rule is that no tool above that floor joins the loop's surface — an injected `AGENTS.md` line persists across posters and would otherwise steer the owner's turn toward it. So the plan is shown and the poster confirms, the same human-gated apply step install and wipe already use, and the executor runs under the confirming user's claims.
- **The stand-in founder:** the `.dev` Star stands in for a tenant Star whose founder is a stranger, never the user-developer, so the first persona gets what that stranger gets — `admin` on `ROOT_NODE_ID` plus `scopeAdmin` at `.dev` — as one plan entry. ⚠️ The root grant is an explicit `setPermission`, never an arrival: `Star.onBeforeCall`'s seed latches one-shot on the first token holding `scopeAdmin` at exactly `.dev` (a collaborator's first sandbox touch on their `.dev` session spends it, since the co-mint carries the inviter's dominion; `createGalaxy` deliberately mints the creator NO `.dev` membership, so the user-developer never does), and `resetDevData`'s `deleteAll()` re-arms it, so arrival order decides and is never relied on. Every operation keeps its in-body check (`DagTree.requirePermission` reads the poster's claims), and the mint composes the scope-level facade that honours the bit under dominion, never the node-level one, which requests none.
- **Where the creating call comes from (Larry, 2026-09-04):** the first call to a new DO fixes where it lives forever. A `.dev` Star created by a call originating at the singleton Registry lands near the Registry, possibly across the world from its users; the creating call should originate from the user-developer's own request — the best proxy for where the app's people are — see [on-hold/mesh-origin-request.md](on-hold/mesh-origin-request.md)'s `CallOptions.locationHint`.
- **Still open, and this file's to settle:** impersonate-or-real-login per persona — an impersonated token carries `act`, which ADR-012's owner branch requires absent, so ownership-keyed behaviour is untestable through it; the ADR-018 sizing sentence (every persona is a Registry membership row); and ADR-016, which binds the executor's mints and grants as authority events.
- **Criteria to carry:** a wiped `.dev` Star is re-established from the file alone — provision from a seeded `personas.md`, wipe, run, and the tree, grants and a fresh `sub` per name match the prose (mutation: drop create-if-missing → the second run fails on "already exists"); and a plan naming an unknown node is refused before anything runs (mutation: remove validation → a grant lands on nothing).

## Turn-liveness heartbeat

✅ **BUILT 2026-09-03.** The server beats through the **whole turn** — [turn-heartbeat.ts](../apps/nebula/src/turn-heartbeat.ts), wrapped once at `Galaxy.#chatTurn` — with an empty transient chunk every quarter of the client's idle window (`TURN_HEARTBEAT_MS`, derived from `TURN_IDLE_MS` in [turn-liveness.ts](../apps/nebula/src/turn-liveness.ts) so the two cannot drift apart). The client treats an empty chunk as liveness only: it re-arms the window and paints nothing, so "thinking…" stays up instead of a blank bubble (`App.vue`'s stream hook).

**Bounded, deliberately.** `callModel` has no timeout of its own; a hung model call runs until the 300 s generation deadline releases the latch. The heartbeat stops at that same deadline so it cannot mask the hang the window exists to catch — a dead turn still fails, one window later than before rather than never.

**The lesson the build taught, worth keeping:** the first cut wrapped only the codegen loop's two awaits (model call, container build). `first-app-built`'s new live watch caught the banner painting *before codegen had started* — the discriminator and the entire plain-answer generation are silent model calls too. The turn is the unit of liveness, not any await inside it. That watch (limb 3: no banner mid-turn, no empty bubble, across a real 60–100 s turn) is what now locks the flash out.

**Deliberately not here:** a per-call `callModel` timeout — it changes the model lane's failure semantics and is parked in [backlog.md](backlog.md) § *Other Nebula backlog*. Real token streaming, first parked beside it, was pulled forward and built the same day (`apps/nebula/src/model-stream.ts`, 2026-09-03): the thinking now arrives as it is written, so the heartbeat covers only the builds and the gaps between calls.

## ③ Capture live

Confirm generation capture is live on deploy, then extend it with UI events — undo, abandon, feedback — sharing the sink with the feedback button. Capture reads the agent `Message` Resources (the collapse's turn-as-Resource model; the old `Turns` side table is gone). Also store the container git-hash on each turn's `Message`, so a prompt can be replayed from its exact starting code — the prerequisite for the nightly replay loop, which reads testers' turns cross-scope through the harness's `*` reach against the bench in [on-hold/nebula-offline-prompt-harness.md](on-hold/nebula-offline-prompt-harness.md). Its risk is not difficulty but being the thing squeezed at the end: everything else in the run is repairable in a later deploy, and this is not.

**`report_finding` — the model as a reporter (moved here 2026-09-03 from the guidance task, where it was a bad fit).** A codegen tool the model calls when a doc misled it or an API misbehaved; the result rides the turn's agent `Message` as structured capture — tenant-local, deduplicated at the digest, and read by a human before anything reaches a public tracker. Never a direct GitHub filing from inside a tenant's Galaxy: that crosses the tenant boundary carrying possibly injected content, and its natural failure is pasting a user-developer's ontology into a public issue. Three homes: the record field is capture and is ③'s; the human-gated filing is the digest's (Wave 3); the standing instruction that tells the model *when* to report is guidance and is [nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md)'s. A broken link in the platform tree is not this tool's job — that tree's generator resolves every link at build time and fails on a bad one. The same acceptance events — undo, abandon, feedback — have a second consumer: **scaffold-level learning**, where a corrected or abandoned turn feeds the platform's own guidance evolution ([on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md) § *Part B*). The app-level retro needs no such signal — the transcript in the prompt lets the model see a correction as it arrives, so that one is a standing instruction in the guidance task.

## Turn-log inspection v0

Manual: registry-resolve the user's `{u}` → a super-admin delegated token → fan out the user's `Message` Resources → a local JSON corpus the assistant reads to answer Larry's questions. Built once, inside the `/live` harness ([archive/claude-live-verification.md](archive/claude-live-verification.md)), so it is local tooling that never rides the deploy, and `Message` Resources already exist. Slot it anywhere, including after the invites.

## The superuser join scenario

Both halves are driven separately: the front door by `superuser-front-door.ts` (the platform membership mints at the consume, behind proof, so a superuser arrives through the ordinary scope-less login), impersonation by `impersonation-lifecycle.ts`. Unproven is that they compose — one scenario chaining superuser login → Home → platform scope → impersonate a pre-alpha user, which is exactly the coaching session. If it turns up gaps, that is when a child task file earns its existence, and not before.

## ⑥ The wipe

One CF-dashboard worker-delete + redeploy, deliberately one and not two. Greenfield means every DB is created fresh. Runbook: [archive/do-exports-and-toolchain-upgrade.md](archive/do-exports-and-toolchain-upgrade.md) § *Phase 4* — not the surrogate-sub file's older `migrations`-shaped narration, which the declarative `exports` conversion superseded.

**The wipe is the closing window for free schema surgery**, and several built things already lean on it: the identity model's collapsed `REGISTRY_MIGRATIONS` baseline, `Snapshots.actingToken`, and `subscriptions.ts`'s in-place migration edit. The constraint they share, and that ④ and ⑤ inherit: **no deploy stands between those rewrites and the wipe.**

**Ops at the deploy:**

- **Secrets.** `deploy.sh`'s preflight refuses to deploy without `NEBULA_AUTH_BOOTSTRAP_EMAIL`, the JWT key pair and `RESEND_API_KEY`, and prints the exact command; values come from the gitignored root `.dev.vars`. `NEBULA_AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com` seeds the super-admin. What stays open on email is in [backlog.md](backlog.md) § *Nebula Auth*, the Resend rows.
- **`wrangler containers delete` the retired `nebula-devcontainer` application** (still listed on the account, 2026-09-03). A dashboard worker-delete removes DO namespaces, not container applications, and this cannot be a phase criterion because it fires after a deploy that happens long after `/build-task` ends.
- **Smoke:** a real-CF KV login → refresh across colos. A KV miss falls back to the registry's `RefreshTokenIndex`, a deliberately live path.

**Post-wipe cleanup:** `develop()` in `App.vue` still creates a missing `.dev` for apps that predate `createGalaxy` bundling it. Once no such app exists it is dead code, and deleting it leaves `/create-star` with zero production callers — [on-hold/nebula-studio-multi-user-testing.md](on-hold/nebula-studio-multi-user-testing.md)'s second open question.

## Data-bound generation

Two kinds of EXPLORATORY, neither pinnable up front:

1. **Prompt-empirical** — data-bound generation quality. Iterate the system prompt against the compile gate and, later, a judge model, driven by capture → inspection → the replay harness. Capable-of-failing checks plus captured findings, never a transcribable spec.
2. **UX-exploratory** — the persona UI. Prototype-and-react, and the tight loop is Larry's own dogfooding: the `mint-narrower-token` consent UX, persona switching, multi-tab use, preview tabs coupled to the act-as UI.

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

- **Super-admin** is an ordinary membership at the reserved `nebula-platform` scope, and that scope is the ROOT of the scope tree — so dominion everywhere is the downward rule applied from the top, one branch inside `isAtOrAbove` and never a special arm at a call site. Driven by `superuser-front-door.ts` and `superuser-end-to-end.ts`.
- **Impersonation** is `POST {prefix}/mint-narrower-token` (RFC-8693 `act.sub`, recursive chain, audited), reached from the client as `impersonate(sub, activeScope)`. Act-as downscopes automatically because DAG checks key off the delegated token's `sub`, never `act`.
- **A galaxy-tier invite is not missing capability.** A universe admin's `{u}.*` already covers `{u}.{g}` and beneath, and nobody can authenticate AT a Galaxy (no identity row can exist at a 2-segment scope), so callers authenticate at the universe and name the galaxy in `activeScope`.
- **Enumerate-all-users** is `NebulaAuthRegistry`, the singleton with the global email → scope index.
- **The `onBeforeCall` passage guard** is `requirePassage(name, claims)` in `nebula-do.ts`, one audit point on every Nebula node — what lets the inspection instrument and a support engineer read, write and admin anywhere with one identity. The DataPlane root-admin seed needs an exact-star `authScope`, so a covering admin first-touching a fresh Star leaves no durable grant behind ([on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md)).

## Caveats

- All Universe admins ⇒ pre-alpha does NOT exercise tenant isolation. "Pre-alpha worked" validates codegen and in-app multi-user, not cross-Galaxy boundaries.
- The migrations one-way door has been open since the first prod deploy (2026-06-26): a DO-class add, rename or delete is a migration forever.
- Synthetic users use an RFC-reserved dead domain (`@example.com` / `*.test` / `*.invalid`), never `@lumenize.io` — it collides with the `claude@` routing and is a domain we own. Act-as only; the address is a label. Whether a `synthetic` column lands is decision 1 in § *What remains*.
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
- `Snapshots.actingToken`, the ADR-016 record — `identityKey`'s JSDoc in `resources.ts` carries the argument
- Compilers out of the Worker, and NO bundle split → [archive/nebula-move-compilers-out-of-the-worker.md](archive/nebula-move-compilers-out-of-the-worker.md); `check-worker-graph.mjs` is the standing tripwire
- Galaxy collapse + chat history UI, preview survives redeploys, ontology installs only by lazy-pull → [archive/nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md)
- Container vite on rolldown with `unplugin-swc` for decorators, shipped with the collapse — `vite.config.ts` says why the plugin is required ([[rolldown-no-tc39-decorators]])
- `createGalaxy` bundles `{galaxy}.dev` — its JSDoc carries the rationale
- Login prove-then-choose + the data-use notice; `discover(email)` deleted → [archive/nebula-login-prove-then-choose.md](archive/nebula-login-prove-then-choose.md)
- UI create-app flow coverage — `ui-smoke/smoke.test.ts` drives it
