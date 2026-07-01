# Nebula — Pre-alpha (master plan)

**Status**: **Active program** (started 2026-06-23) — the top goal now that the demo target is met.
This is the **living master plan**: it holds the plan at design-detail **plus accumulated
learnings/research as we go**. Lower-level (child) task files are written **ONE AT A TIME**, and on
completion their important nuggets are extracted **up into this file** (or the next child) and the
child is **archived** — never left in `tasks/` as reference, never pre-created as a stub. (We lost
hours to stale pre-created stubs before the demo; not again.)

## Goal

Get **~4–5 pre-alpha users** (Larry's friends / family / business partners — "users," not
"partners") building their own **data-bound, multi-user** apps on a **deployed** Nebula, evaluated
via **impersonation / synthetic users**, with enough **instrumentation** to have **near-daily
conversations** as they build — to generate valuable feedback and build stakeholder buy-in.

## Staging ladder (where pre-alpha sits — and what it deliberately is NOT)

- **pre-alpha (THIS) = (iii-build):** dev-users *build* data-bound multi-user apps; *evaluated* by
  them + us via **synthetic users + impersonation**. **No real third-party end-user signup.**
  Pre-alpha sidesteps migration-testing entirely because users already have the **wipe** capability.
- **alpha:** real-use publish path + **data migration**. Writing migration code is relatively easy;
  **testing** migration code is the hard part and probably needs the on-hold **branching** work.
- **beta:** **automated testing** capabilities → near-production-ready.
- → production.

## Framing — two critical paths, one gate

- **Path to involvement** (users building): codegen loop *(DONE)* → capture-live → deploy → provision → invite.
- **Path to valuable feedback:** capture *(shared gate)* → `claude@` email → digest → in-Studio feedback.
- **THE GATE** = the turn-recorder capturing behavioral signals **live BEFORE the first invite** — else day-1 data is lost forever.
- **Pre-alpha users are Universe admins** (Larry invites, pre-picks slug + name). This is the decision
  that shrinks the security story: impersonating anyone isn't an escalation, so **scope-bounded
  impersonation enforcement is DEFERRED** until the first non-Universe-admin user exists (returns then:
  scope-bounded / audited / reversible, security-review-gated with capable-of-failing negative tests).

## What's already DONE / EXISTS — don't re-derive (verified against code 2026-06-23)

- **Self-correcting codegen loop — DONE / archived** (`tasks/archive/nebula-codegen-loop.md`). Its live
  `it.skip`s get validated by the first prod deploy.
- **Recorder — generation capture DONE** (`Galaxy.recordTurn`/`getTurns`, `TurnRecord` JSON payload =
  the replayable fixture). Behavioral *UI* events (undo / abandon / explicit feedback) are **not**
  captured — that's the extension.
- **Super-admin `*` — EXISTS.** Login at the reserved `nebula-platform` instance with
  `NEBULA_AUTH_BOOTSTRAP_EMAIL` → `access { authScopePattern:'*', admin:true }`; `matchAccess('*', …)`
  is always true; bootstrap admin is modify-protected. **Seed = set
  `NEBULA_AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com` at deploy.**
- **Act-as / impersonation core — EXISTS.** `POST {prefix}/delegated-token` (RFC-8693 `act.sub`,
  recursive chain, `actorsAuthorized`, audited). NEW piece = **synthetic-subject provisioning**.
- **Enumerate-all-users — EXISTS.** `NebulaAuthRegistry` (singleton DO; global email→scope index;
  `discover` / `claimUniverse` / `createGalaxy`) — "the nebula-auth DO that holds all of them."
- **Root-admin Part 1 — done** (founder admin-on-`ROOT_NODE_ID`; `tasks/on-hold/nebula-star-root-admin.md`).

## The one auth gap — ✅ DONE 2026-06-23 (Wave 1, first child)

`NebulaDO.onBeforeCall` matched **the DO's** scope pattern against **the caller's `aud`**, so a `*` /
`{u}.*` admin couldn't reach a lower scope without re-minting `aud` per target. **Shipped fix:** a shared
`enforceScopeReach(name, claims)` guard (one audit point per ADR-007, in `apps/nebula/src/nebula-do.ts`,
delegated to by both `NebulaDO.onBeforeCall` and `NebulaContainer.onBeforeCall`) admits a caller whose
`access.authScopePattern` covers the target — **gated on `access.admin`** (pattern-coverage alone is not
authority, so a non-admin keeps today's aud-narrowed behavior; closes the latent non-admin-wildcard reach
into the not-DAG-gated `subscribeTree`). `{u1}` still can't reach `{u2}`. This is what lets the inspection
instrument + a Lumenize support engineer read/write/admin anywhere with one identity. Built + panel-verified;
child archived at [`tasks/archive/nebula-onbeforecall-higher-admin-reach.md`](archive/nebula-onbeforecall-higher-admin-reach.md).

- **Nugget for the descendant children (inspection instrument + provisioning):** a `*` / `{u}.*` admin
  *first-touching a fresh descendant Star* now also triggers `Star.onBeforeCall`'s root-admin seeding
  (`star.ts:94` — it seeds the first scope-admin caller as `ROOT_NODE_ID` admin), which it couldn't before
  (it couldn't reach the Star at all). Aligned with the reach intent + `nebula-star-root-admin` Part 1, but
  those children should account for the seeding side effect when a support/inspection identity touches a
  Star it hasn't before.
- The original structural scope-isolation design is archived/frozen at
  `tasks/archive/nebula-do-scope-isolation.md` (don't edit).

## Two kinds of EXPLORATORY (do not pretend these are pinned)

1. **Prompt-empirical** — *data-bound generation quality.* Iterate the system prompt against the
   compile gate + (later) the GLM-5.2 judge. Driven by capture → inspection → the **un-parked replay
   harness** (`tasks/on-hold/nebula-offline-prompt-harness.md`). NOT a transcribable spec — capable-of-
   failing checks + captured findings (build-task exploratory rule).
2. **UX-exploratory** — *the impersonation / persona UI.* Open and prototype-and-react, NOT pinnable
   up front. The tight loop here is **Larry's own dogfooding of the UI** — pre-alpha users give
   longer-cycle feedback (daily, sometimes sub-daily), not the fast UI-iteration signal:
   - How does a dev-user grant Studio permission to act on their behalf, in the UI? (the
     `delegated-token` consent UX)
   - How does a dev-user switch personas?
   - Do we encourage multi-tab use?
   - Do we provide tabs in the preview panel, coupled to the impersonation UI?

## Iteration & deploy model

- **Iterating the data-bound PROMPT must NOT require a deploy** (prompt = content, not code). Tight loop
  = the offline replay harness (model + gate, **seconds**, no preview / no deploy); live checks = local
  `wrangler dev` + Docker. Deploy is for: **(a)** retiring the one-way migrations-door risk, **(b)**
  where pre-alpha **users** live (mandatory for invites), **(c)** realistic multi-tab / auth /
  impersonation integration checks (**~1-min** cycles are fine — not run every iteration).
- **The system prompt becomes a platform-owned FILE TREE, not a baked const.** `STUDIO_LOOP_SYSTEM_PROMPT`
  is one string in source today; the target is a `NEBULA.md` (the `CLAUDE.md` analog) + `skills/*.md`
  (workflows) + `rules/*.md` tree, served from a **dedicated `@cloudflare/shell`-backed registry DO**
  whose shell/FS methods are exposed over mesh and **read per turn** during prompt assembly. Editing the
  prompt = a git commit into that DO's Workspace (over mesh) — **no redeploy**. This answers
  `nebula-skills.md`'s open integration-point-1 ("where do skills live"), is the delivery vehicle for its
  three-tier prompt, and is the home for the D7 / Platform→Universe→Galaxy cascade. v0 = a single
  platform-scoped tree (admin-gated, trusted content); the per-Universe/Galaxy cascade is later
  (enterprise-gated). **Wave-2 substrate — stand it up before heavy data-bound iteration so iteration is
  deploy-free from day one** (it also un-parks the [skills](nebula-skills.md) work).
- **Lean: deploy early (Wave 1)** to retire the one-way-door risk + enable prod dogfooding; iterate
  offline/local regardless of where the stack runs.

## Current focus (updated 2026-06-30) — the multi-user chat thread

Substrate built; **Child 3 (`reactive-ai-chat`) is the one remaining child.** A 3-child thread, built ONE AT A TIME (extract nuggets up + archive each before the next):
- ✅ **Child 1 — DevStudio data-plane** — DONE + archived ([`tasks/archive/nebula-devstudio-data-plane.md`](archive/nebula-devstudio-data-plane.md)). Extracted `DagTree`+`Resources`+`Subscriptions` out of Star into the composable **`ResourceDataPlane`** capability (capability owns Handler 2; each DO keeps its Handler-1 `@mesh` wrapper; the ontology-version gate is a no-op on DevStudio's single fixed ontology); composed it into **DevStudio** with the platform-fixed `Session`/`Turn` ontology; made `NebulaClient`'s resource-host binding injectable (`resourceHostBinding`, default `STAR`, `DEV_STUDIO` for chat). Seam = injected `getOntology()` (Star=Galaxy-cached, DevStudio=fixed constant).
- ✅ **Child 2 — parent-child query subscriptions** — DONE + archived ([`tasks/archive/nebula-query-subscriptions.md`](archive/nebula-query-subscriptions.md)). Landed once into the capability → Star + DevStudio together: `QuerySubs` + canonical `queryHash` (FNV-1a-64; `onPartial` excluded, M3), `DagTree.evaluatePermissions`, per-push read recheck + `accessAdmin` on `Subscribers`, `enumerateCurrentByField`, `subscribeQuery`/`unsubscribeQuery`, commit + permission reruns, and the client handle (membership-replace + windowed lazy content subs w/ grace). The `accessAdmin` add went through `@lumenize/sql-migrations` — restoring its per-component `markerKey` knob ([[sql-migrations-marker-key]]).
- ⏳ **Child 3 — `reactive-ai-chat`** — **FIRST DRAFT written, pending `/review-task`** ([`tasks/nebula-reactive-ai-chat.md`](nebula-reactive-ai-chat.md)). Each chat turn = a `Turn` Resource FK'd to a `Session`; the Child-2 query sub becomes the delivery + history channel → history-restore on refresh, completed-while-disconnected recovery, multi-participant, and relocating turns off Galaxy onto DevStudio. Closes the known chat hang by construction (turn state is a subscribed Resource, not one awaited promise). THE GATE's capture-extension follows Child 3 (capture = reading those Resources).

## Plan (waves — child task files written ONE AT A TIME, NOT pre-created)

**Wave 1 — infra + the gate**

*Resequenced 2026-06-24:* the first prod deploy can't be "usable by F&F" until the Studio UI is **served from
the deployed Worker** — today it isn't (the `apps/nebula` Worker 404s the root; the Studio UI is a separate
SPA, `apps/nebula-studio-ui`, served by a second vite terminal in dev). So two prerequisite tasks land **before**
the (already-reviewed) deploy task. Written **one at a time** — Task ① has a file; Task ② is a bullet only until ① lands.

- ✅ **① Studio UI single-origin local serving (vite proxy + endpoint prefixes)** — **DONE 2026-06-24, archived**
  ([`tasks/archive/nebula-studio-vite-proxy.md`](archive/nebula-studio-vite-proxy.md) — the frozen prefix contract
  the deploy task ③ transcribes). Clean API-vs-SPA path split, **prod-Assets-ready** (same prefix rule Workers
  Assets uses). **Durable gotcha:** keep the two-terminal vite+`wrangler dev` setup and **avoid the CF Vite
  plugin** (workerd-in-vite can't construct a `Container` → breaks the DevContainer preview). Build detail lives
  in the archived child.
- ✅ **② Local UI smoke + `it.skip` cleanup** → archived child [`tasks/archive/nebula-local-smoke.md`](archive/nebula-local-smoke.md) —
  **`/review-task` ✅ + `/build-task` ✅ Phases 1–2 DONE + GREEN on real infra 2026-06-24; Phase 3
  RESOLVED — the codegen/Container `it.skip`s DELETED in favor of top-down coverage → **zero `it.skip` in all of
  `apps/nebula`**; verifier fan-out clean. ② COMPLETE + ARCHIVED.** A Playwright **UI-level** smoke driving the *rendered*
  Studio (**real-email login [identical local+prod, never test-mode]** → shell renders → prompt → preview updates →
  wipe teardown) — the `ui-smoke` vitest project (raw Playwright + `wrangler dev` on the apps/nebula config + Docker +
  programmatic vite; auto-detect `HAS_DOCKER`/`HAS_CF_CREDS` gating). **Phase 3 re-thought (with Larry):** the
  codegen/Container `it.skip`s were empty placeholders written low-level only because pool-workers can't build a
  `Container`/`env.AI` — so rather than port them, they were **deleted** in favor of top-down coverage (the smoke now
  also asserts a **non-blank** preview render; a new focused **security** decoy test) + existing deterministic suites;
  residual hardening (cold-boot, ordering, reset generation-counter, Wave-2 version-contract) → `backlog.md`. **Zero
  `it.skip` in `apps/nebula`.** Scope clarified at draft: the **≥1 Resources hit + the real magic-link
  loop already exist API-side** in `smoke.test.ts` (not re-done here); the full *manipulate-state-via-the-UI* journey
  is **Wave 2** (Studio doesn't wire Resources yet); a **prod** UI smoke (re-target this lane at the deployed URL) is a
  **backlog** item that ③ *unblocks* (by serving the Studio from the Worker — Decision-3 Assets), not a ③ deliverable;
  ③'s pre-deploy gate is the local `ui-smoke` lane. Backlog origin: `tasks/backlog.md` § Testing & Quality.
  - **Two prod-affecting build outcomes:** **(a)** `apps/nebula` had **no email-sender binding** → real magic-link
    mail silently dropped; wired it into prod (Option C, Larry) — `services[AUTH_EMAIL_SENDER→NebulaEmailSender]` +
    `send_email[EMAIL, remote:true]` in `wrangler.jsonc`, `NebulaEmailSender.from` env-configurable (`AUTH_EMAIL_FROM`).
    **This shrinks ③** (prod email SENDING done; ③ verifies the from-domain is onboarded for CF Email Sending +
    builds the login UI). **(b)** the review's `test--` scope marker is **invalid** at the `nebula-auth parse-id`
    layer (rejects consecutive hyphens — a SECOND, stricter slug validator than `dag-ops`); corrected to single-hyphen
    `test-u0.test-g0.dev`. Backlog item filed to converge the two validators.
- ✅ **③ First prod deploy of `apps/nebula`** — **DONE 2026-06-26.** Worker live at **`nebula.lumenize.com`**
  (custom domain + `nebula.transformation.workers.dev` fallback); **migrations v1 FROZEN** (the one-way door is
  now open); Studio SPA served via **`run_worker_first` route-list** (`entrypoint.ts` unchanged); `/_version?sha=`
  compare-only endpoint; **real-email self-provision login** (discovery-resolve, no hardcoded scope — the dead
  `acme.app.dev` interim is gone); `deploy.sh` = stamp→migrations/secret preflight→`vite build`→deploy→self-check.
  Child archived → [`tasks/archive/nebula-release-process.md`](archive/nebula-release-process.md); deferred
  release-discipline (CI/headless, npm-reproducibility) → [`on-hold/nebula-release-hardening.md`](on-hold/nebula-release-hardening.md).
- ✅ **`onBeforeCall` higher-admin reach** — the auth gap above (DONE 2026-06-23; archived child).
**⏳ Deferred behind the chat thread (see Current focus) — all three are invite-gated: needed before Wave-3 invites, NOT before the chat substrate.**
- **Capture confirm/extend (THE GATE)** — confirm generation-capture is live on deploy; extend with UI
  events (undo / abandon / feedback), sharing the sink with the feedback button. **Comes AFTER the chat thread
  on purpose:** the capture-*extension* should ride the **turn-as-Resource** model Child 3 introduces (capture =
  reading those Resources), not the about-to-be-replaced `Galaxy.recordTurn`.
- **Turn-log inspection v0 (manual)** — registry-resolve the user's `{u}` → super-admin (delegated)
  token → fanout `Galaxy.getTurns` → local JSON corpus the assistant reads to answer Larry's questions.
  *(Absorbs the dissolved offline-harness extraction. Fanout, not a central sink, is the accepted design
  for the rare cross-Universe question.)* **Fanout target moves `Galaxy.getTurns` → `DevStudio` turn Resources
  once Child 3 relocates turns.**
- ✅ **Data-use consent flag** — **BUILT + verified + archived 2026-06-30** ([`archive/nebula-consent-flag.md`](archive/nebula-consent-flag.md)). Nullable `improveProductConsent` column on `NebulaAuthRegistry.Instances` (the **first prod DO schema migration**, via `@lumenize/sql-migrations`); recorded at `claimUniverse` (Universe-level, per-level-ready — galaxy/star later is UI-only); corpus = `WHERE improveProductConsent = 1 AND instanceName != PLATFORM_INSTANCE_NAME`; assume-`true` for F&F. **Not yet in prod** (confirmed 2026-06-30 — no prod push since it landed; last deploy was 06-26): it self-applies on the next `apps/nebula` deploy, so **verify it ran post-deploy** (D6, the only prod-path proof). The **consent UI** (the human consent moment) is a separate, not-yet-built item → **Wave 3 GATE** below.
  - ✅ **Prereq `@lumenize/sql-migrations`** — standalone MIT substrate package (id-gated DO SQL migration runner, vendored+modified from durable-utils), BUILT + archived ([`archive/sql-migrations.md`](archive/sql-migrations.md)); later gained a per-component `markerKey` knob during Child 2 ([[sql-migrations-marker-key]]).

**Wave 2 — the long pole (data-bound, exploratory).** The chat thread **led** (Child 1 + Child 2 DONE; Child 3 drafted — see **Current focus**); the items below are the not-yet-started remainder, orthogonal / soft-adjacent to it.
- **Chat thread → reactive AI chat** — substrate DONE (Child 1 composable data-plane + Child 2 query subscriptions); **Child 3 = `reactive-ai-chat`** (turn = `Turn` Resource FK'd to a `Session`; one query sub `Turn where session=={id}` gives history-restore / disconnect-recovery / multi-participant; relocates turns off Galaxy) — **drafted, pending `/review-task`** ([`tasks/nebula-reactive-ai-chat.md`](nebula-reactive-ai-chat.md)). Live turn-delivery prereq shipped 2026-06-29 ([`archive/resilient-turn-delivery.md`](archive/resilient-turn-delivery.md)). **Rejected alt (2026-06-29) — merge Galaxy+DevStudio:** DevStudio's heavy startup (`@cloudflare/shell` + `isomorphic-git` + `@vue/compiler-sfc` + codegen) + long in-DO model-inference `await`s would contend on Galaxy's single-threaded tenant-facing ontology-read path, plus a DO-class + data migration on deployed prod — stay separate, relocate turns instead.
- **Provision-a-subject-into-{scope, role}** — the unification: Universe-admin invite (pre-provisioned
  slug+name + magic-link claim) **+** synthetic (impersonate-only, no claim) subjects **+** act-as
  wiring. Generic on scope — but the typical case is **synthetic test users Star-scoped to the `.dev`
  Star** (the dev app + dev data live there), impersonated to exercise multi-user behavior. The
  Universe admin's `{u}.*` reach (the Wave-1 `onBeforeCall` change) is what lets them provision + grant
  into `.dev` without re-minting a per-target token; impersonation downscopes automatically because DAG
  checks key off the delegated token's `sub` (the test user), never `act` (the admin). This capability
  is for **all Universe/Galaxy admins editing their apps going forward**, not just pre-alpha. This is the
  **push** half; shares the subject/grant/scope core with `tasks/nebula-request-access.md` (the **pull**
  half) — share it, don't fork. *(Soft-adjacent to the chat thread's Child 3 multi-user demo; the substrate
  itself — Child 1/2 — tests with one `NebulaClient` + synthetic subjects + direct DAG grants, so NOT a prereq.)*
- **Ontology annotations** (`@title` / `@description` / `@inverse`) — data-bound prereq; additive to
  `extractTypeMetadata` (engine roadmap item).
- **Container vite swc** — Rung-2 runtime so data-bound apps (importing `{client, store}`) actually run
  in preview (`unplugin-swc` for TC39 decorators + image rebuild; engine DX-backlog item). This is also when
  the container first needs the **unpublished `@lumenize/nebula` source**: **vendor `src/` into the image**
  (`file:`/workspace ref, the same bundle-from-`src/` move the rest of the deploy uses) — **not** a public-npm
  publish (Nebula is `UNLICENSED`). See `tasks/archive/nebula-release-process.md` Phase 3 § *Dependency resolution*.
- **Data-bound generation (EXPLORATORY)** — the empirical prompt loop. **Un-parks** the replay harness
  (`tasks/on-hold/nebula-offline-prompt-harness.md`) + the **skills** (`tasks/nebula-skills.md`).
  Dogfood secret-santa-grade apps with synthetic users + impersonation. Includes the UX-exploratory UI
  questions above.

**Wave 3 — invite + scale the feedback loop**
- ⚠️ **GATE — data-use consent UI (NOT built).** The consent notice must render at the slug-pick /
  claim-universe prompt in **`nebula-studio-ui`** (locate via `grep` for the claim-universe / slug input):
  a short, **informational** notice (no functional gating), **generic "improve the product" framing** —
  never `nebula`/`studio`-specific. The consent *value* is already written from day one (the flag above);
  this is the human consent *moment*, so it must ship **before the first non-Larry user is invited** (Larry
  owns + accepts responsibility; pre-invite he's the only subject). *(It's "Phase 4" in the frozen archived
  consent file [`archive/nebula-consent-flag.md`](archive/nebula-consent-flag.md) — named descriptively here.)*
- **Provision real users + send ~4–5 personalized invites** (each a tailored first app idea, e.g.
  Sydney → secret-santa + wishlist). *Involvement achieved; capture already live.*
- **Inbound `claude@lumenize.io` → email Worker → durable store** (R2 or a DO; readable via Cloudflare
  MCP). Doubles as the first real exercise of the `nebula-outside-world` inbound-email primitive.
- **Automated daily digest v1 (by 7:30am)** — cron → fanout-aggregate yesterday's turns + behavioral
  signals → in-system GLM-5.2 judge scores at scale → lands in the store via `claude@` → scheduled
  morning Claude Code session synthesizes the human digest + prompt-improvement suggestions → emailed.
  **Suggestions reviewed, not auto-applied**; each new failure mode feeds the eval-suite golden set
  (digest *discovers*, eval suite *prevents regression*). Include a spend line. Morning cousin of the
  12:30am `tasks/nebula-nightly-loop.md` (shared capture). *(v1 — build only after the v0 manual
  inspection loop shows what's worth automating.)*
- **In-Studio feedback button v0** — dead-simple ("this broke / I wish"), writes to the shared store.

## Caveats (stated once)

- Pre-alpha = all Universe admins → **does NOT exercise tenant isolation.** "Pre-alpha worked" ≠
  "isolation proven" (validates codegen + in-app multi-user, not cross-Galaxy boundaries).
- **Migrations one-way door** starts at the first prod deploy (DO-class add/rename/delete = a migration
  forever).
- **Synthetic users** use an RFC-reserved dead domain (`@example.com` / `*.test` / `*.invalid`),
  **NEVER `@lumenize.io`** (collides with `claude@` routing + it's a domain we own). They're
  impersonate-only (the fake email is just a label). The `synthetic:true` flag is **deferred (YAGNI)** —
  add it only when the digest needs to filter test users out of real-activity metrics (a one-column add).
- Cost ceiling is set; Larry watches the CF dashboard. A spend line in the digest is a nice-to-have.

## Open decisions

1. **Starter scaffold on invite** — does the Universe invite auto-provision a starter Galaxy/Star
   (zero-click first build) vs. self-create as a Universe admin? *(Lean: auto-provision a starter — a
   non-coder shouldn't hit a naming/collision wall on first login.)*
2. **Digest phasing** — v0 manual inspection now + v1 automated digest later *(lean)*, or build the
   7:30am pipeline up front? Hard constraint either way: **capture live before invite.**
3. ✅ **Deploy timing — RESOLVED + EXECUTED** (deployed Wave 1, 2026-06-26): deploy early hosts users +
   retires the one-way-door risk; it is NOT the iteration mechanism. (Kept here as a settled decision, not open.)

## Process note

This master = the living plan + accumulated learnings. **One lower-level task file at a time** (then
`/review-task` → `/build-task`). On completion: **extract nuggets up here (or into the next child),
then archive** — no completed files lingering in `tasks/`, no pre-created stubs. See
[[feedback_task_file_one_at_a_time]].

## Links

- Engine design (reference, no sequencing): `tasks/reference/nebula-agentic-engine-design.md` — the *what-runs-when* for its work items lives in THIS file (Wave 2: ontology annotations, container vite swc, data-bound generation; the offline harness + eval suite un-park from here)
- Dev/publish flows: `tasks/reference/nebula-dev-flows.md` · Studio node: `tasks/archive/nebula-studio.md`
- Replay bench (parked, un-parks in Wave 2): `tasks/on-hold/nebula-offline-prompt-harness.md`
- Skills (Wave 2): `tasks/nebula-skills.md`
- Eval suite (parked; regression, later): `tasks/on-hold/nebula-studio-eval-suite.md`
- Provisioning pull-half: `tasks/nebula-request-access.md` · Root-admin: `tasks/on-hold/nebula-star-root-admin.md`
- First prod deploy + release process (Wave 1, DONE 2026-06-26, archived): `tasks/archive/nebula-release-process.md` · deferred hardening: `tasks/on-hold/nebula-release-hardening.md`
- Outside-world capabilities (reactive on user demand — `fetch` → email → search → secrets-last): design `tasks/nebula-outside-world.md` · build plan `tasks/nebula-outside-world-build.md` (incl. Wave 3 inbound email)
- Resilient chat delivery (DONE 2026-06-29): `tasks/archive/resilient-turn-delivery.md` · preview auto-refresh (DONE 2026-06-29): `tasks/archive/preview-ready-autorefresh.md` · query subscriptions (DONE, archived): `tasks/archive/nebula-query-subscriptions.md` · reactive AI chat (Child 3, DRAFT — turn = child Resource FK'd to Session): `tasks/nebula-reactive-ai-chat.md`

## Branch / close-out

- ✅ **Branch flip DONE.** `feat/nebula-studio` was PR'd (**#15**) + merged to `main`; the phase then
  flipped to the **bare-milestone** branch **`pre-alpha`** (the old `feat/` prefix was a misnomer — a
  milestone integration branch, not one feature) and was pushed to `origin`. Long-lived phase branches use
  the bare name (`pre-alpha`, then `alpha`/`beta`), never a `feat/` prefix; delete stale `claude/*` branches
  once reconciled.
- ⏳ **npm publish — NOT done, deferred to `pre-alpha`'s close-out** (Larry 2026-06-30 — not in a rush).
  No packages have been published (`/release-workflow`); `main` carries merged-but-unreleased package
  changes. Release then from merged `main`, not per-commit.
- ⏳ **`pre-alpha`'s own close-out (future, when in a rhythm):** PR `pre-alpha` → `main` → release npm from
  merged main → branch `alpha` off main. Continuous CI comes from an open **draft PR `pre-alpha` → main**
  (CI runs on `pull_request → main` + `push → main`; the non-main push trigger was dropped 2026-06-29).
