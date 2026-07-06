# Nebula — Pre-alpha (master plan)

**Status (2026-07-04):** prod `nebula.lumenize.com` is **redeployed at HEAD `ada3f31`** (clean tree) — the mesh continuation-only refactor + `callAsync`, reactive chat-as-Resources-subscriptions, and the DevContainer stuck-flag fix are all **live**. **Paused-next = F&F invites**, gated on the ⚠️ items under **[Remaining → Invite-gated](#invite-gated-needed-before-the-first-ff-invite)** (capture-live, consent UI, preview-survives-redeploys). Sole open mesh threads = the `callAsync`-inventory follow-ups — `#pendingTurns` (chat) homed in [nebula-chat-history-multiuser.md](nebula-chat-history-multiuser.md); `#pendingSubscribes` + the m6 abort-commit for-docs proof in [backlog.md](backlog.md). (`callAsync` itself ✅ done + archived → [archive/mesh-client-callasync.md](archive/mesh-client-callasync.md).)

**This is the living master plan** — the plan at design-detail **plus** accumulated learnings. Child task files are written **ONE AT A TIME**; on completion their nuggets are extracted **up into this file** and the child is **archived** (never left in `tasks/`, never pre-created as a stub — we lost hours to stale stubs before the demo). See [[feedback_task_file_one_at_a_time]].

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

- **Path to involvement** (users building): codegen loop *(DONE)* → capture-live → deploy *(DONE)* → provision → invite.
- **Path to valuable feedback:** capture *(shared gate)* → `claude@` email → digest → in-Studio feedback.
- **THE GATE** = the turn-recorder capturing behavioral signals **live BEFORE the first invite** — else day-1 data is lost forever.
- **Pre-alpha users are Universe admins** (Larry invites, pre-picks slug + name). This is the decision
  that shrinks the security story: impersonating anyone isn't an escalation, so **scope-bounded
  impersonation enforcement is DEFERRED** until the first non-Universe-admin user exists (returns then:
  scope-bounded / audited / reversible, security-review-gated with capable-of-failing negative tests).

## Building blocks that already EXIST (don't re-derive — verified against code 2026-06-23)

The remaining provisioning / capture / inspection work builds on these:
- **Super-admin `*`** — login at the reserved `nebula-platform` instance with `NEBULA_AUTH_BOOTSTRAP_EMAIL`
  → `access { authScopePattern:'*', admin:true }`; `matchAccess('*', …)` always true; bootstrap admin is
  modify-protected. **Seed = set `NEBULA_AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com` at deploy.**
- **Act-as / impersonation core** — `POST {prefix}/delegated-token` (RFC-8693 `act.sub`, recursive chain,
  `actorsAuthorized`, audited). NEW piece still needed = **synthetic-subject provisioning**.
- **Enumerate-all-users** — `NebulaAuthRegistry` (singleton DO; global email→scope index; `discover` /
  `claimUniverse` / `createGalaxy`).
- **Root-admin Part 1** — founder admin-on-`ROOT_NODE_ID` (`tasks/on-hold/nebula-dataplane-root-admin.md`).
- **`onBeforeCall` higher-admin reach** — the `enforceScopeReach(name, claims)` guard (one audit point per
  ADR-007, `apps/nebula/src/nebula-do.ts`, shared by `NebulaDO`/`NebulaContainer.onBeforeCall`) admits a
  caller whose `access.authScopePattern` covers the target, **gated on `access.admin`**; `{u1}` still can't
  reach `{u2}`. This is what lets the inspection instrument + a support engineer read/write/admin anywhere
  with one identity. ✅ [archive/nebula-onbeforecall-higher-admin-reach.md](archive/nebula-onbeforecall-higher-admin-reach.md).
  - ⚠️ **Live nugget for provisioning + inspection children:** a `*`/`{u}.*` admin *first-touching a fresh
    descendant Star* now also triggers `Star.onBeforeCall`'s root-admin seeding (`star.ts:94` seeds the first
    scope-admin caller as `ROOT_NODE_ID` admin), which it couldn't before — **account for this seeding
    side-effect** when a support/inspection identity touches a Star it hasn't before.
  - The original structural scope-isolation design is frozen at `tasks/archive/nebula-do-scope-isolation.md` (don't edit).

## ✅ Shipped (collapsed — full detail in each archived child)

- ✅ **Self-correcting codegen loop** — `DevStudio.chat` tool-loop → compile gate → Vue SFC → preview. [archive/nebula-codegen-loop.md](archive/nebula-codegen-loop.md)
- ✅ **Recorder — generation capture** — `Galaxy.recordTurn`/`getTurns` (`TurnRecord` = replayable fixture). *The behavioral-UI-events **extension** is still LEFT → THE GATE below.*
- ✅ **Auth gap — `onBeforeCall` higher-admin reach** (2026-06-23) — see Building blocks above. [archive/nebula-onbeforecall-higher-admin-reach.md](archive/nebula-onbeforecall-higher-admin-reach.md)
- ✅ **Wave-1 ① Studio UI single-origin serving** (vite proxy + the prefix contract ③ transcribed). [archive/nebula-studio-vite-proxy.md](archive/nebula-studio-vite-proxy.md) · **Durable gotcha:** keep two-terminal vite+`wrangler dev`; **avoid the CF Vite plugin** (workerd-in-vite can't construct a `Container` → breaks the DevContainer preview).
- ✅ **Wave-1 ② Local UI smoke + zero `it.skip`** (the `ui-smoke` Playwright lane; real-email login → shell → prompt → preview → wipe). [archive/nebula-local-smoke.md](archive/nebula-local-smoke.md)
- ✅ **Wave-1 ③ First prod deploy** (2026-06-26; custom domain `nebula.lumenize.com`, migrations v1 frozen, `/_version` compare-only, `deploy.sh`). [archive/nebula-release-process.md](archive/nebula-release-process.md) · deferred CI/headless hardening → [on-hold/nebula-release-hardening.md](on-hold/nebula-release-hardening.md).
- ✅ **Chat thread ① DevStudio data-plane** — extracted `DagTree`+`Resources`+`Subscriptions` into the composable `ResourceDataPlane`; injectable `resourceHostBinding` (`STAR`/`DEV_STUDIO`). [archive/nebula-devstudio-data-plane.md](archive/nebula-devstudio-data-plane.md)
- ✅ **Chat thread ② parent-child query subscriptions** — `QuerySubs` + `queryHash`, per-push read recheck + `accessAdmin`, windowed lazy content subs. [archive/nebula-query-subscriptions.md](archive/nebula-query-subscriptions.md) · [[sql-migrations-marker-key]]
- ✅ **Chat thread ③ reactive AI chat** (`Turn`→`Message`; chat = Resources on DevStudio; transient `svc.broadcast` stream + ONE durable `Message`; closes "thinking forever" by construction). [archive/nebula-reactive-ai-chat.md](archive/nebula-reactive-ai-chat.md) · prereqs: [archive/resilient-turn-delivery.md](archive/resilient-turn-delivery.md), [archive/preview-ready-autorefresh.md](archive/preview-ready-autorefresh.md).
  - **Still-open deferrals (non-blocking):** ephemeral `onChatResult` removal; D-corpus (Galaxy corpus fate); D-echo hardening (server-validate `author`); Phase-5 viewport UI driver (needs `nebula-studio-ui` rebuilt with the current client).
  - **Decision — do NOT merge Galaxy+DevStudio:** DevStudio's heavy startup (`@cloudflare/shell`+`isomorphic-git`+`@vue/compiler-sfc`+codegen) + long in-DO model `await`s would contend on Galaxy's single-threaded ontology-read path (plus a DO-class + data migration) → stay separate, relocate turns instead.
- ✅ **Data-use consent flag (value)** — nullable `improveProductConsent` on `NebulaAuthRegistry.Instances`, recorded at `claimUniverse`; assume-`true` for F&F. [archive/nebula-consent-flag.md](archive/nebula-consent-flag.md) · Prereq ✅ **`@lumenize/sql-migrations`** [archive/sql-migrations.md](archive/sql-migrations.md).
  - ⚠️ against-real-data migration proof **deferred** (post-wipe prod applied it greenfield); the **consent UI** (human consent moment) is LEFT → Wave-3 gate.
- ✅ **DevContainer wakeup fix** (stuck-`running` `ctx.abort()` recovery; persist-before-abort macrotask yield is load-bearing). [archive/nebula-container-wakeup-fix.md](archive/nebula-container-wakeup-fix.md) · [[miniflare-local-abort-wipes-storage]]. *Follow-on (post-redeploy cold-boot UX) is LEFT → Wave-3 gate "preview survives redeploys".*
- ✅ **Mesh continuation-only refactor + `callAsync`** (killed awaited `callRaw`; client bridges → `callAsync`; ADR-003/007 amended). [archive/mesh-continuation-only-calls.md](archive/mesh-continuation-only-calls.md) · [archive/mesh-client-callasync.md](archive/mesh-client-callasync.md) · identity-stamp removal REJECTED → [archive/decision-mesh-identity-stamp-removal.md](archive/decision-mesh-identity-stamp-removal.md).
- ✅ **Branch flip** `feat/nebula-studio` → PR #15 → `main` → bare-milestone branch `pre-alpha`.
- ✅ **Deploy-timing decision** — deploy early (done 06-26) to host users + retire the one-way-door risk; it is NOT the iteration mechanism.

---

## Remaining

### Invite-gated (needed before the first F&F invite)

- 🔧 **Chat history UI wiring — ACTIVE (next up).** *Capability shipped, UI never wired* (confirmed 2026-07-05). The deployed Studio (`nebula-studio-ui/src/App.vue`) keeps chat in a **local in-memory `messages` array** (a `{role,text}` shape, NOT `Message` Resources) and uses the ephemeral `client.chat()`→`onChatResult` path — it **never `subscribe`s** to the Messages, so reload / multi-tab / reconnect all start empty (old turns don't return). This is the deferred Child-3 *Phase-5 viewport UI driver*; git shows the Child-3 work never touched the SPA. **Backend already persists** durable Messages (`DevStudio.ensureSession` + `commitAssistantMessage` + the `Message where session==DEFAULT_SESSION_ID` query sub) and the client SDK already exposes `client.resources.subscribe(type, id)` — so the fix is **mostly SPA-side**: replace the local array with a live subscription to the session's Messages (render + history-restore), post the user turn durably, reconcile the live ephemeral stream by id. **Resolve first:** (1) confirm the durable Messages actually exist in prod (old turns recoverable vs ephemeral-only); (2) is the **user** message persisted, or only the assistant reply?; (3) reuse Child-2 windowing/grace. **live harness reproduced this live 2026-07-05** (`studio-chat-reload` scenario, `/live`): a submitted turn DOES trigger codegen (`DevContainer.applyChanges` + preview updates), but the user's message **never renders in the thread — before OR after reload** (a11y shows only the empty "Connected. Describe the app…" placeholder). So Q2's answer for the *rendered* thread: the user turn isn't echoed/rendered at all in this ephemeral path — the SPA-side subscribe+render is the whole fix. **Files:** `nebula-studio-ui/src/App.vue` · `apps/nebula/src/frontend/create-nebula-client.ts` (subscribe surface) · `apps/nebula/src/dev-studio.ts` (Message host). Spin a **child task file** at start (critical chat path + open Qs) — unless (1) shows it's a clean subscribe+render, then a lean inline build.
- ⚠️ **GATE — capture live (THE GATE)** — confirm generation-capture is live on deploy; extend with UI
  events (undo / abandon / feedback), sharing the sink with the feedback button. **Rides the
  turn-as-Resource (`Message`) model** Child 3 introduced (capture = reading those Resources), not the
  about-to-be-replaced `Galaxy.recordTurn`. *THE hard gate — capture must be live before day-1 or the data is lost.* **+ store the container git-hash on each turn's `Message`** so a prompt can be replayed from its exact code starting point — the prerequisite for the nightly prompt-improvement/replay loop (reads testers' turns cross-scope via the [live-verification harness](archive/claude-live-verification.md)'s `*` reach; replay bench = [`on-hold/nebula-offline-prompt-harness.md`](on-hold/nebula-offline-prompt-harness.md); distinct from the code-review [`nebula-nightly-loop.md`](nebula-nightly-loop.md)).
- **Turn-log inspection v0 (manual)** — registry-resolve the user's `{u}` → super-admin (delegated) token →
  fanout the user's turn Resources → local JSON corpus the assistant reads to answer Larry's questions.
  *(Fanout target moves from `Galaxy.getTurns` → `DevStudio` `Message` Resources now that Child 3 relocated turns.)* **→ its API/inspection client is now folded into the live-verification harness** ([claude-live-verification.md](archive/claude-live-verification.md)) — build once, there.
- ⚠️ **GATE — data-use consent UI (NOT built).** The consent notice must render at the slug-pick /
  claim-universe prompt in **`nebula-studio-ui`** (locate via `grep` for the claim-universe / slug input):
  a short, **informational** notice (no functional gating), **generic "improve the product" framing** —
  never `nebula`/`studio`-specific. The consent *value* is already written from day one (the flag above);
  this is the human consent *moment*, so it must ship **before the first non-Larry user is invited** (Larry
  owns + accepts responsibility; pre-invite he's the only subject). *(It's "Phase 4" in the frozen archived
  consent file [`archive/nebula-consent-flag.md`](archive/nebula-consent-flag.md) — named descriptively here.)*
- ⚠️ **GATE — preview survives redeploys (NOT built; found live on prod 2026-07-04).** Every pre-alpha redeploy re-rolls the DevContainer application (ANY container-config change restarts instances — e.g. the `instance_type` sync `standard`→`standard-1` applied on the 07-04 deploy), so each deploy **cold-boots every active preview**, and a cold boot reverts the container disk to the baked image (Flow 1c). Observed for `larry.2026-07-01-larry-1.dev` right after the 07-04 redeploy: the preview stuck on the **"Waking your preview…"** interstitial that **does NOT self-heal on a plain cold boot** — `wakingPreviewPage`'s `autoRecover` is gated on the stuck-`running`-flag signature (`isStuckFlagResponse`) ONLY, so a normal cold boot shows a **manual-only Reload button that feels dead** for the minutes the boot takes; and once the container came up it served the **baked default** (`App.vue` = "Your app is warming up…", `appVersion:""`) — the user's generated app was **gone until a new codegen turn re-pushed it**. **We redeploy a lot during pre-alpha, so every F&F user's live preview breaks after every deploy and does not come back on its own → must be seamless before/right-after inviting.** Candidate directions (pin at `/review-task`, do NOT pre-pin): **(a)** the waking page **bounded-auto-polls the cold-boot case too** (with backoff), not just the stuck-flag case, so a legit boot self-heals with no clicking; **(b)** **auto-restore on preview-open** — DevStudio holds the durable source (git `Workspace`), so a cold-booted container should be re-pushed on preview-open/return (Flow 1c) **without** requiring a new codegen turn (the existing app returns by itself); **(c)** **deploy pre-warms** the known-active containers (or re-pushes) so users never hit a cold preview post-deploy; **(d)** a codegen push onto an **unavailable** container must **surface/retry visibly**, never silently land on the baked placeholder with `appVersion:""`. Direct follow-on to the wakeup fix (`tasks/archive/nebula-container-wakeup-fix.md`, same `dev-container.ts` preview/waking-page path): that fix handled the RARE stuck-`running` race; this is the **common** post-redeploy/idle cold-boot UX it explicitly deferred.
  - **Acceptance / verify (the bar for "confident"):** after a **container-re-rolling** redeploy (or a >5m idle), the preview **self-heals to the running app within ~60s with zero manual clicks.** Checkable with a post-deploy probe that polls `GET /dev-container/{scope}/` and classifies the body — `Waking your preview` = stuck/cold, `warming up` = baked default (source not re-pushed), `nebula-scope` meta = app serving. ⚠️ **Repro is conditional:** a pure worker-code redeploy that leaves the container image/config unchanged may NOT re-roll the container (preview stays warm), so to actually exercise this, deploy a container-touching change (or let it idle >5m) first.

### Wave 2 — the long pole (data-bound, exploratory)

**Two kinds of EXPLORATORY (do not pretend these are pinned):**
1. **Prompt-empirical** — *data-bound generation quality.* Iterate the system prompt against the compile
   gate + (later) the GLM-5.2 judge. Driven by capture → inspection → the **un-parked replay harness**
   (`tasks/on-hold/nebula-offline-prompt-harness.md`). NOT a transcribable spec — capable-of-failing checks
   + captured findings (build-task exploratory rule).
2. **UX-exploratory** — *the impersonation / persona UI.* Open, prototype-and-react, NOT pinnable up front;
   the tight loop is **Larry's own dogfooding**: the `delegated-token` consent UX; persona switching;
   multi-tab use; preview-panel tabs coupled to the impersonation UI.

- **Provision-a-subject-into-{scope, role}** — the unification: Universe-admin invite (pre-provisioned
  slug+name + magic-link claim) **+** synthetic (impersonate-only, no claim) subjects **+** act-as
  wiring. Generic on scope — but the typical case is **synthetic test users Star-scoped to the `.dev`
  Star**, impersonated to exercise multi-user behavior. The Universe admin's `{u}.*` reach (the Wave-1
  `onBeforeCall` change) lets them provision + grant into `.dev` without re-minting a per-target token;
  impersonation downscopes automatically because DAG checks key off the delegated token's `sub` (the test
  user), never `act` (the admin). For **all Universe/Galaxy admins editing their apps going forward**, not
  just pre-alpha. This is the **push** half; shares the subject/grant/scope core with
  `tasks/nebula-request-access.md` (the **pull** half) — share it, don't fork.
- **Ontology annotations** (`@title` / `@description` / `@inverse`) — data-bound prereq; additive to
  `extractTypeMetadata` (engine roadmap item).
- **Container vite swc** — Rung-2 runtime so data-bound apps (importing `{client, store}`) actually run
  in preview (`unplugin-swc` for TC39 decorators + image rebuild). This is also when the container first
  needs the **unpublished `@lumenize/nebula` source**: **vendor `src/` into the image** (`file:`/workspace
  ref, the same bundle-from-`src/` move the rest of the deploy uses) — **not** a public-npm publish (Nebula
  is `UNLICENSED`). See `tasks/archive/nebula-release-process.md` Phase 3 § *Dependency resolution*.
- **Data-bound generation (EXPLORATORY)** — the empirical prompt loop. **Un-parks** the replay harness
  (`tasks/on-hold/nebula-offline-prompt-harness.md`) + the **skills** (`tasks/nebula-skills.md`). Dogfood
  secret-santa-grade apps with synthetic users + impersonation. Includes the UX-exploratory questions above.

### Wave 3 — invite + scale the feedback loop

*(The two Wave-3 GATEs — consent UI + preview-survives-redeploys — are hoisted to **Invite-gated** above.)*
- **Provision real users + send ~4–5 personalized invites** (each a tailored first app idea, e.g.
  Sydney → secret-santa + wishlist). *Involvement achieved; capture already live.*
- **Inbound `claude@lumenize.io` → email Worker → durable store** (R2 or a DO; readable via Cloudflare
  MCP). Doubles as the first real exercise of the `nebula-outside-world` inbound-email primitive.
- **Automated daily digest v1 (by 7:30am)** — cron → fanout-aggregate yesterday's turns + behavioral
  signals → in-system GLM-5.2 judge scores at scale → lands in the store via `claude@` → scheduled morning
  Claude Code session synthesizes the human digest + prompt-improvement suggestions → emailed. **Suggestions
  reviewed, not auto-applied**; each new failure mode feeds the eval-suite golden set. Include a spend line.
  Morning cousin of the 12:30am `tasks/nebula-nightly-loop.md`. *(v1 — build only after the v0 manual
  inspection loop shows what's worth automating.)*
- **In-Studio feedback button v0** — dead-simple ("this broke / I wish"), writes to the shared store.
- **Studio self-improvement loop — the arc these rungs build toward** *(design captured; full loop gated on usage density → post-pre-alpha expansion)*. The Wave-2 eval/GLM-5.2 judge and the automated digest above are **rungs 1–2** of [`nebula-studio-self-improvement.md`](nebula-studio-self-improvement.md): evolve Studio's generation *scaffold* (prompts / skills / exemplars) from outcome signal — frozen base model, **no training** (the Ornith idea, lifted from weights to orchestration). **Part A — the reward function / eval (absorbed from the old eval-suite) — is the first buildable piece and un-parks in Wave 2**; the full loop (scaffold store + Vectorize retrieval-augmented generation + human-gated promotion) needs density, so it's the **post-invite expansion**, governed by [`docs/vision/self-improving-platform.md`](../docs/vision/self-improving-platform.md) (the compounding-moat vision) and kept **separate** from the code-review [`nebula-nightly-loop.md`](nebula-nightly-loop.md). *Larry's stated primary next-big track.*

### Close-out
- ⏳ **npm publish — NOT done, deferred to `pre-alpha`'s close-out** (Larry 2026-06-30 — not in a rush).
  No packages published (`/release-workflow`); `main` carries merged-but-unreleased package changes. Release
  then from merged `main`, not per-commit.
- ⏳ **`pre-alpha` → `alpha` close-out (future, when in a rhythm):** PR `pre-alpha` → `main` → release npm
  from merged main → branch `alpha` off main. Continuous CI comes from an open **draft PR `pre-alpha` → main**
  (CI runs on `pull_request → main` + `push → main`; the non-main push trigger was dropped 2026-06-29).

---

## Iteration & deploy model

- **Iterating the data-bound PROMPT must NOT require a deploy** (prompt = content, not code). Tight loop
  = the offline replay harness (model + gate, **seconds**, no preview / no deploy); live checks = local
  `wrangler dev` + Docker. Deploy is for: **(a)** retiring the one-way migrations-door risk, **(b)** where
  pre-alpha **users** live (mandatory for invites), **(c)** realistic multi-tab / auth / impersonation
  integration checks (**~1-min** cycles — not run every iteration).
- **The system prompt becomes a platform-owned FILE TREE, not a baked const.** `STUDIO_LOOP_SYSTEM_PROMPT`
  is one source string today; the target is a `NEBULA.md` (the `CLAUDE.md` analog) + `skills/*.md` + `rules/*.md`
  tree, served from a **dedicated `@cloudflare/shell`-backed registry DO** whose FS methods are exposed over
  mesh and **read per turn** during prompt assembly. Editing the prompt = a git commit into that DO's Workspace
  (over mesh) — **no redeploy**. Answers `nebula-skills.md`'s "where do skills live"; home for the
  Platform→Universe→Galaxy cascade. **Wave-2 substrate — stand it up before heavy data-bound iteration** so
  iteration is deploy-free from day one (also un-parks the [skills](nebula-skills.md) work).

## Caveats (stated once)

- Pre-alpha = all Universe admins → **does NOT exercise tenant isolation.** "Pre-alpha worked" ≠
  "isolation proven" (validates codegen + in-app multi-user, not cross-Galaxy boundaries).
- **Migrations one-way door** is open (first prod deploy 06-26): DO-class add/rename/delete = a migration forever.
- **Synthetic users** use an RFC-reserved dead domain (`@example.com` / `*.test` / `*.invalid`),
  **NEVER `@lumenize.io`** (collides with `claude@` routing + it's a domain we own). Impersonate-only (the
  fake email is just a label). The `synthetic:true` flag is **deferred (YAGNI)** — add it only when the
  digest needs to filter test users out of real-activity metrics (a one-column add).
- Cost ceiling is set; Larry watches the CF dashboard. A spend line in the digest is a nice-to-have.

## Open decisions

1. **Starter scaffold on invite** — does the Universe invite auto-provision a starter Galaxy/Star
   (zero-click first build) vs. self-create as a Universe admin? *(Lean: auto-provision a starter — a
   non-coder shouldn't hit a naming/collision wall on first login.)*
2. **Digest phasing** — v0 manual inspection now + v1 automated digest later *(lean)*, or build the
   7:30am pipeline up front? Hard constraint either way: **capture live before invite.**

## Links

- Engine design (reference, no sequencing): `tasks/reference/nebula-agentic-engine-design.md` — the
  *what-runs-when* lives in THIS file (Wave 2 items; the offline harness + eval suite un-park from here).
- Dev/publish flows: `tasks/reference/nebula-dev-flows.md` · Studio node: `tasks/archive/nebula-studio.md`
- Parked (un-park in Wave 2): replay bench `tasks/on-hold/nebula-offline-prompt-harness.md` · skills
  `tasks/nebula-skills.md` · eval / **Studio self-improvement loop** `tasks/nebula-studio-self-improvement.md`
- Provisioning pull-half: `tasks/nebula-request-access.md` · Root-admin: `tasks/on-hold/nebula-dataplane-root-admin.md`
- Outside-world (reactive on demand — `fetch` → email → search → secrets-last): design
  `tasks/nebula-outside-world.md` · build plan `tasks/nebula-outside-world-build.md` (incl. Wave-3 inbound email).
- ✅ **Live self-verification harness — SHIPPED + ARCHIVED 2026-07-06** (`tasks/archive/claude-live-verification.md`, commits `8b1b4ff` + `f04ebcb` + `8214f59`): the `/live` skill + always-loaded `live.md` rule + `apps/nebula/harness/` drive a running Nebula (API via `NebulaClient` + browser capture: screenshot/a11y/console/network). Reproduced the chat-history gap live (fed the answer into the chat-history entry above). Also shipped the bootstrap-array `*` super-admin (nebula-auth `#bootstrapEmails` comma-list). **Prod drive (3b/3d + attach) — ALSO SHIPPED 2026-07-06:** `apps/nebula/harness/prod.ts` drives *deployed* prod autonomously (no boot) → stored `*`-admin refresh (headless ~2.5s, no email); verified live by enumerating the real prod scope tree. **Standing authorization:** I drive/read prod when Larry asks — no reconfirming (read-mostly; writes/deploys stay deliberate). The `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN` header bypass (nebula-auth `checkTurnstile`) is built + deployed + unit-tested — the enabler for the alpha "turn Turnstile ON in prod" step. ⚠️ Turnstile is **still OFF in prod today** (`TURNSTILE_SECRET_KEY` unset — confirmed via `wrangler secret list`), so the live run currently clears via the no-secret skip; the bypass path only becomes load-bearing once Turnstile flips ON. M1 controls + findings: `apps/nebula/harness/FINDINGS.md`.
