# Nebula — Pre-alpha (master plan)

**Status (2026-08-20):** prod `nebula.lumenize.com` is **still at `ada3f31`**, deployed 2026-07-04. ⚠️ **Everything since is UNDEPLOYED** — it all waits on the **single batched wipe+redeploy gate** below (deliberate: one CF-dashboard worker-delete + redeploy, not two), so **do not read prod as evidence of current behaviour** — and F&F invites stay paused until the ⚠️ items under **[Remaining → Invite-gated](#invite-gated-needed-before-the-first-ff-invite)** land. **Sequence (decided 2026-08-19):** ① ✅ profile accepted-membership gate → [archive/nebula-profile-accepted-membership-gate.md](archive/nebula-profile-accepted-membership-gate.md); ② wipe item 6 (`actingToken`) — built directly from its own bullet, no child task file; ③ in any order: [nebula-registry-scope-in-url.md](nebula-registry-scope-in-url.md) · ~~[nebula-login-prove-then-choose.md](nebula-login-prove-then-choose.md)~~ **moved AFTER the collapse** (pinned 2026-08-24 — the shared `consumeAndLogin` seam; the collapse's half is one env value; see that file's Status) **built together with** the consent-UI gate (same screen) · the `createGalaxy`-bundles-`.dev` item · [nebula-same-origin-guard.md](nebula-same-origin-guard.md)'s verdict; ④ the **Galaxy collapse** — its whole-file review is **deliberately deferred to just before its build** (Larry, 2026-08-19), and the two gates that ride it (preview-survives-redeploys, capture-live) wait with it; the ③ items are themselves invite gates or invite-adjacent, so working them first does not lengthen the critical path. Sole open mesh threads = the `callAsync`-inventory follow-ups — `#pendingTurns` (chat) homed in [nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md); `#pendingSubscribes` + the m6 abort-commit for-docs proof in [backlog.md](backlog.md).

**This is the living master plan** — the plan at design detail, plus only what still bears on remaining work. Child task files are written **ONE AT A TIME**; on completion the child is **archived** (never left in `tasks/`, never pre-created as a stub), and history stays in the archive — decision history survives only in a Decisions table (alternatives rejected + why). The code is the authority for anything built. See [[feedback_task_file_one_at_a_time]].

## Goal

Get **~4–5 pre-alpha users** (Larry's friends / family / business partners — "users," not
"partners") building their own **data-bound, multi-user** apps on a **deployed** Nebula, evaluated
via **act-as / synthetic users**, with enough **instrumentation** to have **near-daily
conversations** as they build — to generate valuable feedback and build stakeholder buy-in.

## Staging ladder (where pre-alpha sits — and what it deliberately is NOT)

- **pre-alpha (THIS) = (iii-build):** dev-users *build* data-bound multi-user apps; *evaluated* by
  them + us via **synthetic users + act-as**. **No real third-party end-user signup.**
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
  that shrinks the security story: acting-as anyone isn't an escalation. Residual non-security cleanup
  (drop `AuthorizedActors` → admins-only) → [on-hold/delegation-hardening.md](on-hold/delegation-hardening.md).

## Building blocks that already EXIST (don't re-derive)

The remaining provisioning / capture / inspection work builds on these (the code is the authority):
- **Super-admin** — login at the reserved `nebula-platform` instance with `NEBULA_AUTH_BOOTSTRAP_EMAIL`
  → `access { authScope:'nebula-platform', scopeAdmin:true }`: an **ordinary membership at the reserved
  scope**, and that scope is the **ROOT of the scope tree**, so dominion everywhere is the ordinary
  downward rule applied from the top — one branch inside `isAtOrAbove`, never a special arm at a call
  site. **Seed = set `NEBULA_AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com` at deploy.** Driven end to end by
  the `superuser-end-to-end` `/live` scenario.
  - ⚠️ **Still owed: one `/live` scenario driving superuser → discover → select the platform scope →
    impersonate a pre-alpha user in one go** (the coaching use case). The discover half's gap is owned by
    [nebula-login-prove-then-choose.md](nebula-login-prove-then-choose.md) (the platform membership is
    minted *by* the request for a platform-scoped link, so first-login discovery returns nothing); the
    impersonate half of that specific chain is undriven. If it turns up gaps, that is when a child task
    file earns its existence, and not before.
- **Impersonation core** — `POST {prefix}/mint-narrower-token` (RFC-8693 `act.sub`, recursive chain,
  audited). NEW piece still needed = **synthetic-subject provisioning**.
- **Enumerate-all-users** — `NebulaAuthRegistry` (singleton DO; global email→scope index).
- **Root-admin Part 1** — initial DataPlane root admin (`admin` on `ROOT_NODE_ID`) ([on-hold/nebula-dataplane-root-admin.md](on-hold/nebula-dataplane-root-admin.md)).
- **`onBeforeCall` passage guard** — `requirePassage(name, claims)` (one audit point per ADR-007,
  `apps/nebula/src/nebula-do.ts`, every Nebula node's `onBeforeCall` — they all extend `NebulaDO`) admits a caller
  with **passage** into the target. This is what lets the inspection instrument + a support engineer
  read/write/admin anywhere with one identity. Note for provisioning/inspection children: the DataPlane
  root-admin seed requires an **exact-star** `authScope`, so a covering admin first-touching a fresh
  Star leaves **no** durable grant behind.

## ✅ Shipped (one line each — full detail in the archived children; the code is the authority)

- ✅ **Self-correcting codegen loop** → [archive/nebula-codegen-loop.md](archive/nebula-codegen-loop.md)
- ✅ **Recorder — generation capture**; the `Turns` side table it shipped as is DELETED by the collapse's Phase 1 — the capture re-homes onto the agent `Message`'s `codegen` value object ([nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md) Phase 2, a deliberate one-phase gap). The behavioral-UI-events extension is THE GATE below.
- ✅ **`onBeforeCall` downward dominion** → [archive/nebula-onbeforecall-higher-admin-reach.md](archive/nebula-onbeforecall-higher-admin-reach.md)
- ✅ **`/mint-narrower-token` escalation fix** → [archive/rfc-act-chains.md](archive/rfc-act-chains.md); the delegation authz invariants are pinned in `.claude/rules/security.md`.
- ✅ **Studio UI single-origin serving** → [archive/nebula-studio-vite-proxy.md](archive/nebula-studio-vite-proxy.md). ⚠️ Standing trap: keep two-terminal vite+`wrangler dev`; **avoid the CF Vite plugin** (workerd-in-vite can't construct a `Container` → breaks the DevContainer preview).
- ✅ **Local UI smoke** (the `ui-smoke` Playwright lane) → [archive/nebula-local-smoke.md](archive/nebula-local-smoke.md). Its `it.skip`s have named owners: [backlog.md](backlog.md) § Testing & Quality (the `.dev`-login blocker) and [nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md) (surfaces the collapse deletes or rewrites).
- ✅ **First prod deploy** (2026-06-26; `nebula.lumenize.com`, `deploy.sh`) → [archive/nebula-release-process.md](archive/nebula-release-process.md); CI/headless hardening → [on-hold/nebula-release-hardening.md](on-hold/nebula-release-hardening.md)
- ✅ **DevStudio data-plane extraction** (`ResourceDataPlane`) → [archive/nebula-devstudio-data-plane.md](archive/nebula-devstudio-data-plane.md)
- ✅ **Parent-child query subscriptions** → [archive/nebula-query-subscriptions.md](archive/nebula-query-subscriptions.md)
- ✅ **Reactive AI chat** (chat = `Message` Resources on DevStudio) → [archive/nebula-reactive-ai-chat.md](archive/nebula-reactive-ai-chat.md). Its deferrals are discharged by [nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md): the ephemeral `onChatResult` machinery is deleted (completion rides the `Message` subscription, with a client idle-timeout for the never-commits case), D-echo died with the client-written `author` (display derives from the server-stamped `actingToken`), and D-corpus resolved with codegen folded into Galaxy. Still open: the archived file's viewport-UI-driver phase.
- ⛔ **Data-use consent flag REMOVED** (no consent column exists anywhere) → [archive/nebula-consent-flag.md](archive/nebula-consent-flag.md). The human consent *moment* is the consent-UI GATE below. Its prereq `@lumenize/sql-migrations` stands → [archive/sql-migrations.md](archive/sql-migrations.md).
- ✅ **DevContainer wakeup fix** (stuck-`running` `ctx.abort()` recovery) → [archive/nebula-container-wakeup-fix.md](archive/nebula-container-wakeup-fix.md) · [[miniflare-local-abort-wipes-storage]]. The common cold-boot UX it deferred is the preview-survives-redeploys GATE below.
- ✅ **Mesh continuation-only refactor + `callAsync`** → [archive/mesh-continuation-only-calls.md](archive/mesh-continuation-only-calls.md) · [archive/mesh-client-callasync.md](archive/mesh-client-callasync.md)

---

## Remaining

### Invite-gated (needed before the first F&F invite)

- ✅ **Deploy + mount (2026-08-29)** → [archive/nebula-move-compilers-out-of-the-worker.md](archive/nebula-move-compilers-out-of-the-worker.md); `scripts/check-worker-graph.mjs` is the standing tripwire, `containers.md` carries the `/workspace`-subtree mount contract.

- ✅ **`createGalaxy` bundles `{galaxy}.dev` (2026-08-30)** — the rationale lives in `createGalaxy`'s JSDoc (no membership at `.dev` included), mutation-validated in `nebula-auth-registry.test.ts`. Post-wipe residue: `develop()`'s client-side repair is dead code, and `/create-star`'s zero-caller fate is [on-hold/nebula-studio-multi-user-testing.md](on-hold/nebula-studio-multi-user-testing.md)'s open question.
- ✅ **Chat history UI wiring (2026-08-28)** → [archive/nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md); feeds THE GATE (identity-attributed user turns).
  - 🏗️ **Auth foundation LANDED (undeployed) + PROD WIPE batched at THIS milestone.** [archive/nebula-auth-surrogate-sub.md](archive/nebula-auth-surrogate-sub.md) is built (surrogate `sub`; registry + Workers KV); deploying it needs a greenfield prod **wipe** (re-key + DO-class delete), batched as ONE CF-dashboard worker-delete + redeploy — **keep F&F invites paused until then**. Wipe runbook: [archive/do-exports-and-toolchain-upgrade.md](archive/do-exports-and-toolchain-upgrade.md) § *Phase 4* (⚠️ NOT the surrogate-sub file's frozen `migrations`-shaped narration — superseded by the declarative-`exports` conversion). Smoke-check at the wipe: real-CF KV login→refresh cross-colo (a KV miss falls back to the registry `RefreshTokenIndex` — a deliberately-live path). **Follow-ons riding this milestone:** the "login flows" restoration ([backlog.md](backlog.md) § Nebula Auth) and the profile→presence schema changes. ⚙️ **Ops step at this deploy: set the `RESEND_API_KEY` secret** — `deploy.sh`'s required-secrets preflight refuses to deploy without it and prints the exact command (value from the gitignored root `.dev.vars`); what stays open → [backlog.md](backlog.md) § *Nebula Auth*, the Resend row.
    - ⚙️ **Second ops step at this deploy, once the Galaxy collapse has landed: `wrangler containers delete` the retired DevContainer container application** (`apps/nebula/wrangler.jsonc` declares one). ⚠️ A dashboard worker-delete does **not** cover it — that removes DO namespaces, not container applications — and it cannot be a phase criterion, because it fires after a deploy that happens well after `/build-task` ends. Handed here from [nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md) § *Files*, 2026-08-21.
    - 🪟 **The wipe is a CLOSING WINDOW for free schema surgery — batch it here.** Greenfield means every DB is created fresh, so changes that would otherwise need a migration are **free right now and expensive forever after** we have real users.

      💡 **OPTION kept open (Larry, 2026-08-24): a SECOND wipe between pre-alpha and alpha.** Mechanism: stash each pre-alpha user's **codebase** (the Workspace repo — which, under [nebula-ontology-history-file.md](nebula-ontology-history-file.md), is self-contained: code + ontology history + migrations in one repo, so the stash is one artifact per app), wipe, restore. Their `.dev` Star data is lost and we say so up front — pre-alpha has no release capability, so no customer data exists. ⚠️ **The stash MUST also carry the codegen corpus** (the Galaxy's `Message`s with their `codegen` value objects): THE GATE exists because day-1 signal is irreplaceable, and a wipe that discards the harvest contradicts its purpose. Identities re-mint on re-invite; stamped attribution in a restored corpus dangles into the ADR-013 cold case, which degrades display-only — acceptable. **An option, not a plan** — it relaxes the one-wipe squeeze on structural work without licensing deferral (every wipe still spends user goodwill).

      ⚠️ **The numbers are stable citation handles, not a running order.** ADR-016's always-loaded one-liner cites *"item 6"*, so they are **append-only** — never renumber when one is inserted, removed or resequenced (`workflow.md`). **The page order IS the execution order.** Add a new item with the next unused number, placed where it should run. Queued:
      2. ✅ **Compilers out of the Worker (2026-08-29)** → [archive/nebula-move-compilers-out-of-the-worker.md](archive/nebula-move-compilers-out-of-the-worker.md); nothing of it rides the wipe.
      3. ✅ **DECIDED 2026-08-29 — NO SPLIT** (2,342.79 KiB / 32–35 ms startup sits in the cheap-and-stable tier — [`experiments/do-cold-start-bundle-ab/RESULTS.md`](../experiments/do-cold-start-bundle-ab/RESULTS.md)). The guard is behavioural, not a number: `check-worker-graph.mjs` reds on any compiler import; a future heavy non-compiler dep is a fresh decision at its own review.
      5. ✅ **The identity data model — BUILT 2026-08-04**; listed only because the numbers are append-only citation handles. `schemas.ts` is the authority; design reasoning archived (frozen) at [archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md). **What still rides the wipe:** the collapsed `REGISTRY_MIGRATIONS` baseline is numbered above the previously-applied high-water mark, and the constraint stands that there is **no deploy between the rewrite and the wipe**.
      6. ✅ **BUILT 2026-08-20 — `Snapshots.actingToken` replaces `changedBy` with the full ADR-016 record; the same-actor coalesce key derives from IDENTITY only; the wire allow-lists what leaves the DO (`WireActingToken`).** The rationale lives at the sites — `identityKey`'s JSDoc carries the identity-only + window-vs-TTL argument, `WireActingToken`'s the disclosure boundary, ADR-016 the naming — and the original spec is in git history. First real consumer: the collapse's Phase 2. Deploys at the wipe gate.
      7. ✅ **The dominion vocabulary rename — BUILT 2026-08-11** → [archive/nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md); listed only because the numbers are append-only citation handles. **What still rides the wipe:** migration id-2 in `subscriptions.ts` was edited **in place** — legitimate only because **no deploy stands between that edit and the wipe**; the header JSDoc at the site records the spent licence.
- ✅ **Galaxy collapse (2026-08-28; criteria discharged 08-29/30)** → [archive/nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md); the 08-30 one-good-way pass finished the ontology story (install ONLY by lazy-pull; registry as a directory of files).
- ⚠️ **GATE — capture live (THE GATE)** — confirm generation-capture is live on deploy; extend with UI
  events (undo / abandon / feedback), sharing the sink with the feedback button. **Rides the
  turn-as-Resource (`Message`) model** (capture = reading those Resources), not the deleted
  `Turns` recorder. *THE hard gate — capture must be live before day-1 or the data is lost.* **+ store
  the container git-hash on each turn's `Message`** so a prompt can be replayed from its exact code
  starting point — the prerequisite for the nightly prompt-improvement/replay loop (reads testers' turns
  cross-scope via the [live-verification harness](archive/claude-live-verification.md)'s `*` reach;
  replay bench = [`on-hold/nebula-offline-prompt-harness.md`](on-hold/nebula-offline-prompt-harness.md)).
- **Turn-log inspection v0 (manual)** — registry-resolve the user's `{u}` → super-admin (delegated) token →
  fanout the user's `Message` Resources → local JSON corpus the assistant reads to answer Larry's
  questions. Its API/inspection client is folded into the live-verification harness
  ([claude-live-verification.md](archive/claude-live-verification.md)) — build once, there.
- ⚠️ **GATE — data-use consent UI (NOT built).** A short, **informational** notice (no functional gating,
  no stored value), **generic "improve the product" framing** — never `nebula`/`studio`-specific —
  rendered at the slug-pick / claim-universe prompt in **`nebula-studio-ui`**. Must ship **before the
  first non-Larry user is invited** (Larry owns + accepts responsibility; pre-invite he's the only
  subject). ⚠️ **The screen it renders on is being re-ordered** — the claim/slug-pick prompt moves behind
  the magic-link click, so build together with the login gate below or this notice ships into a flow
  that no longer exists.
- ⚠️ **GATE — login: prove the mailbox, then choose the workspace (NOT built).** Studio calls
  `discover(email)` **before** anyone proves anything; three costs fall out: a multi-membership address
  hits a dead end, a new user spends **two** emails to claim a Universe, and any caller can ask which
  scopes an address belongs to and administers (at Galaxy/Universe tiers membership *is* admin-ship; at
  `nebula-platform` it *is* superuser-ship). Target: one scope-less link → the click proves the mailbox →
  *then* the scopes come back and you choose one. Every pre-alpha user meets this screen first, which is
  why it lands before invites. → design intent, decisions, open questions:
  **[nebula-login-prove-then-choose.md](nebula-login-prove-then-choose.md)** § *The target*.
- ✅ **GATE — preview survives redeploys: discharged structurally by the collapse; the deploy-only confirm ran 2026-08-29** (same pre-redeploy hashed asset served post-redeploy on `test-nebula`) — record in [archive/nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md)'s status banner.

### Consider before invites (NOT gates)

Nothing here blocks an invite. Each is listed because the window in which it is cheap closes when
someone other than Larry is reading the output — or building against it. Where an item links out, the
full reasoning, the rejected shortcut, and the fix direction live there; follow the link rather than
re-deriving here.

- **Give the scope/admin gates typed errors**, so a tester reporting "it's broken" is distinguishable
  from one who was simply refused → [backlog.md](backlog.md) § Nebula, *The scope/admin gates throw bare
  `Error`*. ⚠️ The obvious shortcut — reusing `PermissionDeniedError` — is rejected there, for reasons
  that outlive this milestone.
- **Fix `@lumenize/structured-clone`'s error rehydration, and its published doc caveat** — registering a
  custom Error on `globalThis` silently corrupts the message → [backlog.md](backlog.md) § Lumenize Mesh,
  *Registering a custom Error on `globalThis` CORRUPTS its message*. Nothing in-repo hits it; the
  **published** doc teaches the footgun, and pre-alpha is when readership starts.
- **Consider: a runtime verify step for the codegen loop.** Studio declares a generated app done on the
  compile gate alone — nothing drives the app to see whether it renders, throws in console, or loads
  data. That is `live.md`'s thesis pointed at the **user-developer's** app instead of at us; without it
  every failure arrives as a human bug report, and
  [`nebula-studio-self-improvement.md`](on-hold/nebula-studio-self-improvement.md) has no source of
  truth for whether generated code *worked*. ⚠️ **The open question is the SESSION, not the driver.**
  The preview serve is deliberately ungated (`apps/nebula/src/entrypoint.ts` — direct GET/HEAD to
  `DEV_CONTAINER`, since browsers don't attach `Authorization` to document loads), so a driver reaches
  the shell with no token; but tenant data is gated on the WS/mesh path, so seeing **real** data needs a
  session, and ADR-009's ladder governs how one is obtained. Mechanism stays open (Playwright, Browser
  Run's Chromium, or [Kitesurf](https://blog.cloudflare.com/kitesurf/)). ⚠️ Scope it as *the codegen
  loop lacks runtime feedback*, never as *pick a browser* — user-triggered debugging and agent-triggered
  verification are one mechanism with two triggers, and the agent half is the valuable one.

### Wave 2 — the long pole (data-bound, exploratory)

**Two kinds of EXPLORATORY (do not pretend these are pinned):**
1. **Prompt-empirical** — *data-bound generation quality.* Iterate the system prompt against the compile
   gate + (later) the GLM-5.2 judge. Driven by capture → inspection → the **un-parked replay harness**
   ([on-hold/nebula-offline-prompt-harness.md](on-hold/nebula-offline-prompt-harness.md)). NOT a
   transcribable spec — capable-of-failing checks + captured findings (build-task exploratory rule).
2. **UX-exploratory** — *the act-as / persona UI.* Open, prototype-and-react, NOT pinnable up front;
   the tight loop is **Larry's own dogfooding**: the `mint-narrower-token` consent UX; persona switching;
   multi-tab use; preview-panel tabs coupled to the act-as UI.

- **Provision-a-subject-into-{scope, role}** — Universe-admin invite (pre-provisioned slug+name +
  magic-link claim) **+** synthetic (act-as-only, no claim) subjects **+** act-as wiring. Generic on
  scope — the typical case is **synthetic test users Star-scoped to the `.dev` Star**, driven via act-as
  to exercise multi-user behavior (act-as downscopes automatically because DAG checks key off the
  delegated token's `sub`, never `act`). Shares the subject/grant/scope core with
  [on-hold/nebula-request-access.md](on-hold/nebula-request-access.md) (the **pull** half) — share it,
  don't fork.
  - ✅ **The dominion/passage/guards/invite spine is BUILT + archived:**
    [archive/nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md) ·
    [archive/nebula-passage-dominion-from-scope.md](archive/nebula-passage-dominion-from-scope.md) ·
    [archive/nebula-registry-route-guards.md](archive/nebula-registry-route-guards.md) ·
    [archive/nebula-invite.md](archive/nebula-invite.md) (client surface:
    `NebulaClient.invite(targetScope, invitees)`). Two live spin-offs are sequenced in ③:
    [nebula-registry-scope-in-url.md](nebula-registry-scope-in-url.md) (independent of the collapse in
    both directions; ⚠️ both edit `apps/nebula/src/nebula-client.ts`, different regions — do not
    interleave, a concurrency note, not an ordering one) and
    [nebula-same-origin-guard.md](nebula-same-origin-guard.md) (design intent only; its honest outcome
    may be *no guard at all*).
  - ⏸️ **The COLLABORATOR** (named-role grant bundle, valid-combinations UI, self-signup redeem hook) is
    **ON HOLD and OUT of pre-alpha** → [on-hold/nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md);
    resuming is a scheduling call (first consumer: `docs/vision/enterprise.md` § *The invitation is the
    land motion*). Pre-alpha no longer needs a workaround for it: the collapse file now enrolls a
    **genuine non-`scopeAdmin` peer** through the shipped invite — a membership at `{u}.{g}` plus one
    `write` grant at the session node (corrected 2026-08-21; the Galaxy-admin-via-bypass interim it
    used to carry is gone). What stays on hold is the multi-node grant BUNDLE, not the collaborator.
  - ⚠️ **The SYNTHETIC subjects are NEEDED and UNOWNED.** Neither invite path exercises a data-plane
    permission model — both mint people with mailboxes. For a Star to be exercised it needs **non-admin
    members driven under test**: synthetic act-as-only subjects (no mailbox, no claim, RFC-reserved dead
    domain — § Caveats) plus whatever attaches their DAG grants. Today `createSubject` exists **only** in
    `apps/nebula/test/test-helpers.ts` — zero production callers, no UI. ⚠️ **Placement is open:** this
    sits in Wave 2, but *"a pre-alpha user can test the permission model of the app they just generated"*
    reads as **Invite-gated** — decide before the collapse lands, since that is when real users arrive.
  - **A galaxy-tier invite is NOT missing capability:** a universe admin's `{u}.*` already covers
    `{u}.{g}` and beneath. Nobody can *authenticate at* a Galaxy by claim (no identity row can exist at a
    2-segment scope), so callers authenticate at the universe and name the galaxy in `activeScope` — the
    shape prod uses, and it stays correct afterward.
- **Ontology annotations** (`@title` / `@description` / `@inverse`) — data-bound prereq; additive to
  `extractTypeMetadata` (engine roadmap item).
- **Container vite swc** — Rung-2 runtime so data-bound apps (importing `{client, store}`) actually run
  in preview (`unplugin-swc` for TC39 decorators + image rebuild). This is also when the container first
  needs the **unpublished `@lumenize/nebula` source**: **vendor `src/` into the image** (`file:`/workspace
  ref) — **not** a public-npm publish (Nebula is `UNLICENSED`). See
  [archive/nebula-release-process.md](archive/nebula-release-process.md) Phase 3 § *Dependency resolution*.
- **Data-bound generation (EXPLORATORY)** — the empirical prompt loop. **Un-parks** the replay harness
  ([on-hold/nebula-offline-prompt-harness.md](on-hold/nebula-offline-prompt-harness.md)) + the **skills**
  ([on-hold/nebula-skills.md](on-hold/nebula-skills.md)). Dogfood secret-santa-grade apps with synthetic
  users + act-as. Includes the UX-exploratory questions above.

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
  *(v1 — build only after the v0 manual inspection loop shows what's worth automating.)*
- **In-Studio feedback button v0** — dead-simple ("this broke / I wish"), writes to the shared store.
- **Studio self-improvement loop — the arc these rungs build toward** *(design captured; full loop gated
  on usage density → post-pre-alpha expansion)*. The Wave-2 eval/GLM-5.2 judge and the automated digest
  above are **rungs 1–2** of [on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md):
  evolve Studio's generation *scaffold* (prompts / skills / exemplars) from outcome signal — frozen base
  model, **no training**. **Part A — the reward function / eval — is the first buildable piece and
  un-parks in Wave 2**; the full loop needs density, so it's the **post-invite expansion**, governed by
  [`docs/vision/self-improving-platform.md`](../docs/vision/self-improving-platform.md). *Larry's stated
  primary next-big track.*

### Close-out
- 👤 **LARRY HAND-REVIEW — ADR-011 onward, then restructure/merge/split wholesale.** Scheduled **after
  the Galaxy collapse ships**. ADR-010 was the last one carefully hand-reviewed. Known inputs:
  - The best statement of the coarse-grained access-control model (`{u}.{g}.{s}`) is archived (frozen) at
    [archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md) § *The invariant* +
    § *Settled* — decide what gets lifted into an ADR or a rule (and whether ADR-012 shrinks back to
    *visibility* once an access ADR owns "a profile is never an authz input").
  - **Candidates to merge or split:** 008 / 012 / 013 / 015 each cover one facet of one model. That may
    be four ADRs or one.
  - **008 / 009 / 013 carry dated amendment notes** against `docs/adr/README.md`'s forward-facing
    discipline. Decide per-file — 009's may earn its place (it stops sessions citing a withdrawn latency
    figure) — and write any carve-out into the README rather than leaving silent exceptions.
- ⏳ **npm publish — deferred to `pre-alpha`'s close-out** (not in a rush). No packages published
  (`/release-workflow`); `main` carries merged-but-unreleased package changes. Release then from merged
  `main`, not per-commit.
- ⏳ **`pre-alpha` → `alpha` close-out (future, when in a rhythm):** PR `pre-alpha` → `main` → release npm
  from merged main → branch `alpha` off main. Continuous CI comes from an open **draft PR `pre-alpha` →
  main** (CI runs on `pull_request → main` + `push → main`).

---

## Iteration & deploy model

- **Iterating the data-bound PROMPT must NOT require a deploy** (prompt = content, not code). Tight loop
  = the offline replay harness (model + gate, **seconds**, no preview / no deploy); live checks = local
  `wrangler dev` + Docker. Deploy is for: **(a)** retiring the one-way migrations-door risk, **(b)** where
  pre-alpha **users** live (mandatory for invites), **(c)** realistic multi-tab / auth / act-as
  integration checks (**~1-min** cycles — not run every iteration).
- **The system prompt becomes a platform-owned FILE TREE, not a baked const.** `STUDIO_LOOP_SYSTEM_PROMPT`
  is one source string today; the target is a `NEBULA.md` (the `CLAUDE.md` analog) + `skills/*.md` + `rules/*.md`
  tree, served from a **dedicated `@cloudflare/shell`-backed registry DO** whose FS methods are exposed over
  mesh and **read per turn** during prompt assembly. Editing the prompt = a git commit into that DO's Workspace
  (over mesh) — **no redeploy**. Answers `nebula-skills.md`'s "where do skills live"; home for the
  Platform→Universe→Galaxy cascade. **Wave-2 substrate — stand it up before heavy data-bound iteration** so
  iteration is deploy-free from day one (also un-parks the [skills](on-hold/nebula-skills.md) work).

## Caveats (stated once)

- Pre-alpha = all Universe admins → **does NOT exercise tenant isolation.** "Pre-alpha worked" ≠
  "isolation proven" (validates codegen + in-app multi-user, not cross-Galaxy boundaries).
- **Migrations one-way door** is open (first prod deploy 06-26): DO-class add/rename/delete = a migration forever.
- **Synthetic users** use an RFC-reserved dead domain (`@example.com` / `*.test` / `*.invalid`),
  **NEVER `@lumenize.io`** (collides with `claude@` routing + it's a domain we own). Act-as-only (the
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
  `tasks/on-hold/nebula-skills.md` · eval / **Studio self-improvement loop** `tasks/on-hold/nebula-studio-self-improvement.md`
- Provisioning pull-half: `tasks/on-hold/nebula-request-access.md` · Root-admin: `tasks/on-hold/nebula-dataplane-root-admin.md`
- Fast-follow / demand-driven capabilities (reactive, post-core): `tasks/nebula-pre-alpha-fast-follow.md` —
  the parent index; each item carries its own demand trigger, so read them there rather than tracking a
  list here. Outside-world connectivity is the one with its own design+phases file
  (`tasks/nebula-outside-world.md`; `fetch` → email → search → secrets-last; incl. Wave-3 inbound email).
- **Live harness:** local drive = `apps/nebula/harness/` (the `/live` skill + always-loaded `live.md`
  rule); prod drive = `apps/nebula/harness/prod.ts` (autonomous, read-mostly; **standing authorization**
  to drive/read prod when Larry asks — writes/deploys stay deliberate). ⚠️ Turnstile is **OFF in prod**
  (`TURNSTILE_SECRET_KEY` unset), so live runs clear via the no-secret skip; the
  `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN` header bypass is built for when it flips ON. Findings:
  `apps/nebula/harness/FINDINGS.md`. Archive: [archive/claude-live-verification.md](archive/claude-live-verification.md).
