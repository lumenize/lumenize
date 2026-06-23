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

## Plan (waves — child task files written ONE AT A TIME, NOT pre-created)

**Wave 1 — infra + the gate**
- **First prod deploy of `apps/nebula`** → child [`tasks/nebula-release-process.md`](nebula-release-process.md)
  (the first-prod-deploy + deploy-process task — merged 2026-06-23). Phase 0 = first-deploy readiness
  (`migrations` block one-way door, super-admin seed, concurrency, DevStudio source-of-truth durability,
  laptop+WARP deploy); Phases 1/3 = SHA-stamp + `/_version` + `apps/nebula/scripts/deploy.sh`. Validates the
  loop's live `it.skip`s. CI/headless deploy + npm-reproducibility deferred →
  `tasks/on-hold/nebula-release-hardening.md`. *(Biggest single chunk — ready for `/review-task`.)*
- ✅ **`onBeforeCall` higher-admin reach** — the auth gap above (DONE 2026-06-23; archived child).
- **Capture confirm/extend (THE GATE)** — confirm generation-capture is live on deploy; extend with UI
  events (undo / abandon / feedback), sharing the sink with the feedback button.
- **Turn-log inspection v0 (manual)** — registry-resolve the user's `{u}` → super-admin (delegated)
  token → fanout `Galaxy.getTurns` → local JSON corpus the assistant reads to answer Larry's questions.
  *(Absorbs the dissolved offline-harness extraction. Fanout, not a central sink, is the accepted design
  for the rare cross-Universe question.)*
- **Data-use consent flag** — add `improveProductConsent` column to `NebulaAuthRegistry`'s `Instances`
  table (`packages/nebula-auth/src/schemas.ts` `REGISTRY_SCHEMAS`). Generically named (consent to use
  your data to improve the product — never `nebula`/`studio`-specific, so nebula-auth stays
  product-agnostic). Surface a notice at the slug-pick prompt. **Assume `true` for now** (hard yes for
  F&F testers). `SELECT instanceName FROM Instances WHERE improveProductConsent = 1` gives the corpus
  pool. Home: the auth registry (self-signup is an auth feature; consent lives where the `claimUniverse`
  call happens).

**Wave 2 — the long pole (data-bound, exploratory)**
- **Provision-a-subject-into-{scope, role}** — the unification: Universe-admin invite (pre-provisioned
  slug+name + magic-link claim) **+** synthetic (impersonate-only, no claim) subjects **+** act-as
  wiring. Generic on scope — but the typical case is **synthetic test users Star-scoped to the `.dev`
  Star** (the dev app + dev data live there), impersonated to exercise multi-user behavior. The
  Universe admin's `{u}.*` reach (the Wave-1 `onBeforeCall` change) is what lets them provision + grant
  into `.dev` without re-minting a per-target token; impersonation downscopes automatically because DAG
  checks key off the delegated token's `sub` (the test user), never `act` (the admin). This capability
  is for **all Universe/Galaxy admins editing their apps going forward**, not just pre-alpha. This is the
  **push** half; shares the subject/grant/scope core with `tasks/nebula-request-access.md` (the **pull**
  half) — share it, don't fork.
- **Ontology annotations** (`@title` / `@description` / `@inverse`) — data-bound prereq; additive to
  `extractTypeMetadata` (engine roadmap item).
- **Container vite swc** — Rung-2 runtime so data-bound apps (importing `{client, store}`) actually run
  in preview (`unplugin-swc` for TC39 decorators + image rebuild; engine DX-backlog item).
- **Data-bound generation (EXPLORATORY)** — the empirical prompt loop. **Un-parks** the replay harness
  (`tasks/on-hold/nebula-offline-prompt-harness.md`) + the **skills** (`tasks/nebula-skills.md`).
  Dogfood secret-santa-grade apps with synthetic users + impersonation. Includes the UX-exploratory UI
  questions above.

**Wave 3 — invite + scale the feedback loop**
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
3. **Deploy timing** — deploy early (Wave 1) *(lean)*, confirmed reframe: deploy hosts users + retires
   the one-way-door risk; it is NOT the iteration mechanism.

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
- First prod deploy + release process (Wave 1, merged): `tasks/nebula-release-process.md` · deferred hardening: `tasks/on-hold/nebula-release-hardening.md`
- Outside-world capabilities (reactive on user demand — `fetch` → email → search → secrets-last): design `tasks/nebula-outside-world.md` · build plan `tasks/nebula-outside-world-build.md` (incl. Wave 3 inbound email)
