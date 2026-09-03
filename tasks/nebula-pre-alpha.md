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
| ① | **Guidance file tree** — platform → galaxy, universe skipped | [nebula-guidance-file-tree.md](nebula-guidance-file-tree.md) — design intent only | deploy |
| ② | **Personas** — synthetic users the LLM defines, each in its own preview tab | none yet, Larry's — § *② Personas* | deploy, plus `data` if the column lands |
| — | **Turn-liveness heartbeat** — a truthful server signal through a long quiet stretch | none — § *Turn-liveness heartbeat* | deploy |
| ③ | ⚠️ **THE GATE — capture live** | none — § *③ Capture live* | deploy |
| ④ | **Every Resources guard lives in the Resources plane** | [nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md) — design intent only | **data** |
| ⑤ | **The ontology history is one committed file** | [nebula-ontology-history-file.md](nebula-ontology-history-file.md) — design intent only; independent of ④, either order | **data** |
| ⑥ | **The wipe + redeploy** | § *⑥ The wipe* | — |
| — | **Turn-log inspection v0** | none — § *Turn-log inspection v0* | ungated |
| — | **The superuser → impersonate join scenario** (~¼ day) | none — § *The superuser join scenario* | ungated |
| — | **Same-origin guard verdict** — "no guard" is a complete outcome | [nebula-same-origin-guard.md](nebula-same-origin-guard.md) | ungated |

**Why this order.** Risk — and here risk is unresolved design rather than hard implementation (Larry, 2026-09-02: *"I should favor doing the riskiest ones first"*). ① is the largest unknown and gates ②. ② carries the most design uncertainty, so it follows its prerequisite at once. ③ is small but irreversible: day-1 signal that was not captured is gone. ④ and ⑤ are the biggest and the best understood, and size is not risk when the shape is known. ⚠️ **"Before the wipe" orders nothing** — there is exactly ONE deploy, so every line of code here precedes it; only the `data` gate is real.

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

## ① Guidance file tree

Now [nebula-guidance-file-tree.md](nebula-guidance-file-tree.md), a Pass-1 draft and the authority for the shape: platform guidance in code, Galaxy guidance in the user-developer's Workspace repo, both read every turn, under the cross-vendor name `AGENTS.md`. It precedes ② because personas are guidance the LLM authors and re-reads — building them first invents a second home for guidance and then unlearns it. It also answers [on-hold/nebula-skills.md](on-hold/nebula-skills.md)'s "where do skills live".

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
- **Drive `impersonate()`'s teardown before writing the design intent** (`/live`, container-free, ~20 min). A child client renews through the parent's mint helper, with `registerChild` / `deregisterChild` / `onClientTornDown` wired around it in `nebula-client.ts`, so closing or reloading the Studio tab plausibly tears down every persona tab — fatal to a feature whose point is tabs left open across a session. Discoverable, not arguable.
- **State the sizing.** Every persona is a membership row in the Registry, the [ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md) singleton. Pre-alpha's users × apps × personas is negligible but multiplicative; say so in the file so a later reviewer need not re-derive the worry.

Adjoins [on-hold/nebula-studio-multi-user-testing.md](on-hold/nebula-studio-multi-user-testing.md) (the same tab UI, and `/create-star`'s fate) and shares the subject/grant/scope core with [on-hold/nebula-request-access.md](on-hold/nebula-request-access.md), the pull half — share it, don't fork.

## Turn-liveness heartbeat

The client already consumes the signal (`signalTurn` in [turn-liveness.ts](../apps/nebula/src/turn-liveness.ts)). What is missing is a truthful server emit during the non-streaming stretch — a cold first token, or the container build — which today crosses the `TURN_IDLE_MS` idle window and paints the `failed` banner before the next chunk heals it. Low-risk polish, slotted right after ② because it touches the codegen streaming path and belongs near the guidance work rather than drifting into "much later" (Larry, 2026-09-02).

## ③ Capture live

Confirm generation capture is live on deploy, then extend it with UI events — undo, abandon, feedback — sharing the sink with the feedback button. Capture reads the agent `Message` Resources (the collapse's turn-as-Resource model; the old `Turns` side table is gone). Also store the container git-hash on each turn's `Message`, so a prompt can be replayed from its exact starting code — the prerequisite for the nightly replay loop, which reads testers' turns cross-scope through the harness's `*` reach against the bench in [on-hold/nebula-offline-prompt-harness.md](on-hold/nebula-offline-prompt-harness.md). Its risk is not difficulty but being the thing squeezed at the end: everything else in the run is repairable in a later deploy, and this is not.

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

Iterating the prompt must not require a deploy — the prompt is content, not code. Tight loop = the offline replay harness (model + gate, seconds, no preview); live checks = local `wrangler dev` + Docker; deploy only for where users live and for realistic multi-tab / auth / act-as checks, at ~1-minute cycles and not every iteration.

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
