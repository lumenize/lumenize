# Nebula — Pre-alpha (master plan)

**Status (2026-07-29):** prod `nebula.lumenize.com` is **still at `ada3f31`**, deployed 2026-07-04 — the mesh continuation-only refactor + `callAsync`, reactive chat-as-Resources-subscriptions, and the DevContainer stuck-flag fix are live there. ⚠️ **Everything since is UNDEPLOYED and prod is far behind `pre-alpha`** — the auth foundation (surrogate `sub`), the profile store + Profile DO, the `/live` harness on real email login, the `access.scopeAdmin` confinement, open Star self-signup (`claim-star`), `/mint-narrower-token`, and the DO-`exports`/toolchain upgrade have all landed green and all wait on the **single batched wipe+redeploy gate** below. That batching is deliberate (one CF-dashboard worker-delete + redeploy, not two), so **do not read prod as evidence of current behaviour** — and F&F invites stay paused until it fires. **Paused-next = F&F invites**, gated on the ⚠️ items under **[Remaining → Invite-gated](#invite-gated-needed-before-the-first-ff-invite)** (capture-live, consent UI, preview-survives-redeploys, login-prove-then-choose). Sole open mesh threads = the `callAsync`-inventory follow-ups — `#pendingTurns` (chat) homed in [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md); `#pendingSubscribes` + the m6 abort-commit for-docs proof in [backlog.md](backlog.md). (`callAsync` itself ✅ done + archived → [archive/mesh-client-callasync.md](archive/mesh-client-callasync.md).)

**This is the living master plan** — the plan at design-detail **plus** accumulated learnings. Child task files are written **ONE AT A TIME**; on completion their nuggets are extracted **up into this file** and the child is **archived** (never left in `tasks/`, never pre-created as a stub — we lost hours to stale stubs before the demo). See [[feedback_task_file_one_at_a_time]].

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
  that shrinks the security story: acting-as anyone isn't an escalation. The **mint privilege-escalation is
  ✅ FIXED** — `/mint-narrower-token` (then named `/delegated-token`) now gates `activeScope` on the *caller's own* pattern and binds the minted
  pattern + `scopeAdmin` to the caller (never the target's `scopeAdmin` or the instance's), plus rejects refresh-cookie
  auth: [archive/rfc-act-chains.md](archive/rfc-act-chains.md) NOW-1, **+ the `{ sub }` root-identity guard**
  (reject act-bearing tokens). What's LEFT is a single **non-security cleanup** — drop `AuthorizedActors` →
  admins-only, whenever the delegation docs are touched anyway (Star-root/consent eligibility was **dropped** as
  unforeseen) → [on-hold/delegation-hardening.md](on-hold/delegation-hardening.md).

## Building blocks that already EXIST (don't re-derive — verified against code 2026-06-23)

The remaining provisioning / capture / inspection work builds on these:
- **Super-admin** — login at the reserved `nebula-platform` instance with `NEBULA_AUTH_BOOTSTRAP_EMAIL`
  → `access { authScopePattern:'*', scopeAdmin:true }`; `matchAccess('*', …)` always true; bootstrap admin is
  modify-protected. **Seed = set `NEBULA_AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com` at deploy.**
  - ⏳ **The claims shape changes with [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md)** — `authScope`
    becomes the literal `nebula-platform` and the `'*'` sentinel disappears, so *"`matchAccess('*', …)` always
    true"* stops being the mechanism. That file owns the sweep; this row is one of its targets.
  - ⚠️ **"Already exists" is unverified end-to-end, and the coaching use case is what depends on it.** The
    pieces are each present — bootstrap login, `nebula-platform` membership, impersonation core — but nobody
    has driven **superuser → discover → select the platform scope → impersonate a pre-alpha user** in one go.
    A single `/live` scenario answers it, per `live.md` (drive the running system rather than infer from the
    code). **Do that before assuming this block is whole**; if it turns up gaps, that is when a child task
    file earns its existence, and not before.
    - ✅ **The discover → select-the-platform-scope half turned up a gap and is now owned** (2026-08-09): the
      platform membership is minted *by* the request for a platform-scoped link, so before a superuser's
      first login discovery returns nothing and the front door offers them a Universe claim. Owned by
      [nebula-login-prove-then-choose.md](nebula-login-prove-then-choose.md) — its § *Open questions* also
      carries how the platform entry is presented once it does appear. **The impersonate half remains
      undriven**, so the `/live` scenario above is still owed.
- **Impersonation core** — `POST {prefix}/mint-narrower-token` (RFC-8693 `act.sub`, recursive chain,
  `actorsAuthorized`, audited). NEW piece still needed = **synthetic-subject provisioning**.
- **Enumerate-all-users** — `NebulaAuthRegistry` (singleton DO; global email→scope index; `discover` /
  `claimUniverse` / `createGalaxy`).
- **Root-admin Part 1** — initial DataPlane root admin (`admin` on `ROOT_NODE_ID`) (`tasks/on-hold/nebula-dataplane-root-admin.md`).
- **`onBeforeCall` higher-admin reach** — the `enforceScopeReach(name, claims)` guard (one audit point per
  ADR-007, `apps/nebula/src/nebula-do.ts`, shared by `NebulaDO`/`NebulaContainer.onBeforeCall`) admits a
  caller whose `access.authScopePattern` covers the target, **gated on `access.scopeAdmin`**; `{u1}` still can't
  reach `{u2}`. This is what lets the inspection instrument + a support engineer read/write/admin anywhere
  with one identity. ✅ [archive/nebula-onbeforecall-higher-admin-reach.md](archive/nebula-onbeforecall-higher-admin-reach.md).
  - ⚠️ **Live nugget for provisioning + inspection children — REVERSED 2026-08-02.** A `*`/`{u}.*` admin
    first-touching a fresh descendant Star used to trigger `Star.onBeforeCall`'s root-admin seeding, so a
    support/inspection identity left a durable DAG grant behind. **It no longer does:** the seed now requires
    an **exact-star** `authScopePattern`, so only the Star's own admin becomes the initial DataPlane root
    admin. A covering admin still reaches everything via the scope-admin bypass (ADR-015) — it simply no
    longer takes the root grant by arriving first. **There is no seeding side-effect to account for.**
  - The original structural scope-isolation design is frozen at `tasks/archive/nebula-do-scope-isolation.md` (don't edit).

## ✅ Shipped (collapsed — full detail in each archived child)

- ✅ **Self-correcting codegen loop** — `DevStudio.chat` tool-loop → compile gate → Vue SFC → preview. [archive/nebula-codegen-loop.md](archive/nebula-codegen-loop.md)
- ✅ **Recorder — generation capture** — `Galaxy.recordTurn`/`getTurns` (`TurnRecord` = replayable fixture). *The behavioral-UI-events **extension** is still LEFT → THE GATE below.*
- ✅ **Auth gap — `onBeforeCall` higher-admin reach** (2026-06-23) — see Building blocks above. [archive/nebula-onbeforecall-higher-admin-reach.md](archive/nebula-onbeforecall-higher-admin-reach.md)
- ✅ **`/mint-narrower-token` escalation fix** (2026-07-07, when the endpoint was named `/delegated-token`) — scope-bounded mint (gate `activeScope` on the *caller's* pattern; bind minted pattern + `admin` to the caller, never the target/instance) + refresh-cookie rejection + `{ sub }` root-identity guard (reject act-bearing tokens); delegation authz invariant (read + mint side) pinned in `.claude/rules/security.md`. Surfaced by the act-chain `/review-task` detour (whose model settled the chat `actAs` too). [archive/rfc-act-chains.md](archive/rfc-act-chains.md)
- ✅ **Wave-1 ① Studio UI single-origin serving** (vite proxy + the prefix contract ③ transcribed). [archive/nebula-studio-vite-proxy.md](archive/nebula-studio-vite-proxy.md) · **Durable gotcha:** keep two-terminal vite+`wrangler dev`; **avoid the CF Vite plugin** (workerd-in-vite can't construct a `Container` → breaks the DevContainer preview).
- ✅ **Wave-1 ② Local UI smoke** (the `ui-smoke` Playwright lane; real-email login → shell → prompt → preview → wipe). [archive/nebula-local-smoke.md](archive/nebula-local-smoke.md) ⚠️ **The "zero `it.skip`" half of this claim was true when written and is NOT true now — corrected 2026-08-05.** The lane has since accumulated skips from two directions, each with a named owner: the `.dev`-login blocker ([backlog.md](backlog.md) § Testing & Quality) and surfaces the Galaxy collapse deletes or rewrites ([nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)). ⚠️ **Stated as ownership, not as a count** — a number here goes stale the moment any lane gains or greens one, which is exactly how this line came to be wrong; re-derive with `grep -rnE '^\s*(it|test|describe)\.skip\(' apps/nebula/test/ui-smoke/`. **The shipped capability is the lane itself; zero-skip was an acceptance criterion of that build, not a standing property of the repo.**
- ✅ **Wave-1 ③ First prod deploy** (2026-06-26; custom domain `nebula.lumenize.com`, migrations v1 frozen, `/_version` compare-only, `deploy.sh`). [archive/nebula-release-process.md](archive/nebula-release-process.md) · deferred CI/headless hardening → [on-hold/nebula-release-hardening.md](on-hold/nebula-release-hardening.md).
- ✅ **Chat thread ① DevStudio data-plane** — extracted `DagTree`+`Resources`+`Subscriptions` into the composable `ResourceDataPlane`; injectable `resourceHostBinding` (`STAR`/`DEV_STUDIO`). [archive/nebula-devstudio-data-plane.md](archive/nebula-devstudio-data-plane.md)
- ✅ **Chat thread ② parent-child query subscriptions** — `QuerySubs` + `queryHash`, per-push read recheck + `accessAdmin`, windowed lazy content subs. [archive/nebula-query-subscriptions.md](archive/nebula-query-subscriptions.md) · [[sql-migrations-marker-key]]
- ✅ **Chat thread ③ reactive AI chat** (`Turn`→`Message`; chat = Resources on DevStudio; transient `svc.broadcast` stream + ONE durable `Message`; closes "thinking forever" by construction). [archive/nebula-reactive-ai-chat.md](archive/nebula-reactive-ai-chat.md) · prereqs: [archive/resilient-turn-delivery.md](archive/resilient-turn-delivery.md), [archive/preview-ready-autorefresh.md](archive/preview-ready-autorefresh.md).
  - **Still-open deferrals (non-blocking):** ephemeral `onChatResult` removal; D-corpus (Galaxy corpus fate); D-echo hardening (server-validate `author`); Phase-5 viewport UI driver (needs `nebula-studio-ui` rebuilt with the current client).
  - **Decision — do NOT merge Galaxy+DevStudio:** DevStudio's heavy startup (`@cloudflare/shell`+`isomorphic-git`+`@vue/compiler-sfc`+codegen) + long in-DO model `await`s would contend on Galaxy's single-threaded ontology-read path (plus a DO-class + data migration) → stay separate, relocate turns instead.
- ⛔ **Data-use consent flag — REMOVED 2026-07-21 (was shipped, now ripped out).** YAGNI: no consumer was ever built and it kept re-consuming review time; `REGISTRY_MIGRATIONS` id 8 drops the column. If we ever want it, design it then against real use cases. The Phase-4 slug-pick consent notice is dropped with it. ([archive/nebula-consent-flag.md](archive/nebula-consent-flag.md) carries a superseded banner.) · Its prereq ✅ **`@lumenize/sql-migrations`** [archive/sql-migrations.md](archive/sql-migrations.md) **stands** — the migration runner is live and now has a second consumer (the drop).
  - ⚠️ against-real-data migration proof **deferred** (post-wipe prod applied it greenfield); the **consent UI** (human consent moment) is LEFT → Wave-3 gate.
- ✅ **DevContainer wakeup fix** (stuck-`running` `ctx.abort()` recovery; persist-before-abort macrotask yield is load-bearing). [archive/nebula-container-wakeup-fix.md](archive/nebula-container-wakeup-fix.md) · [[miniflare-local-abort-wipes-storage]]. *Follow-on (post-redeploy cold-boot UX) is LEFT → Wave-3 gate "preview survives redeploys".*
- ✅ **Mesh continuation-only refactor + `callAsync`** (killed awaited `callRaw`; client bridges → `callAsync`; ADR-003/007 amended). [archive/mesh-continuation-only-calls.md](archive/mesh-continuation-only-calls.md) · [archive/mesh-client-callasync.md](archive/mesh-client-callasync.md) · identity-stamp removal REJECTED → [archive/decision-mesh-identity-stamp-removal.md](archive/decision-mesh-identity-stamp-removal.md).
- ✅ **Branch flip** `feat/nebula-studio` → PR #15 → `main` → bare-milestone branch `pre-alpha`.
- ✅ **Deploy-timing decision** — deploy early (done 06-26) to host users + retire the one-way-door risk; it is NOT the iteration mechanism.

---

## Remaining

### Invite-gated (needed before the first F&F invite)

- 🔧 **Chat history UI wiring → durable multi-user reactive thread — ⏸️ ON HOLD for the [rfc-act-chains.md](archive/rfc-act-chains.md) auth detour (2026-07-07)** *(paused mid-`/review-task`, S1 settled; the chat's `actAs` builds on the `act`-chain foundation, so we fix that first).* *Capability shipped, UI never wired.* **Corrected by the Stage-1 review panel (verified 2026-07-06):** the user turn **IS** persisted (client-side via `postUserMessage`) — but lands on **STAR not DevStudio** and is **never rendered** (`App.vue` uses a local array + never `subscribe`s); and identity is a spoofable client `author` field. So it's a **render + host-binding + attribution** task, not storage. Design: author = the snapshot's server-stamped **`changedBy.sub`** (durable per-person UUID; **no `author` field** → spoof gone by construction), display **name** resolved from subscriber claims stored at the **subscription layer** (a generic upgrade, not a chat-specific roster); **multi-user is the framing** (3-participant `/live` test); streaming via subscribe **update-in-place** (retires `svc.broadcast`). Feeds THE GATE (identity-attributed user turns = the highest-value capture signal). → **Design + phases: [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)** — *now merged with the collapse bullet below into one file (reviewed S1+S2, ready for build).*
  - 🏗️ **Auth foundation LANDED (undeployed) + PROD WIPE deferred to THIS milestone (2026-07-13).** [archive/nebula-auth-surrogate-sub.md](archive/nebula-auth-surrogate-sub.md) is BUILT + green (surrogate `sub`, NebulaAuth DO dissolved → registry + Workers KV; verifier-panel clean). It provides the durable per-person `sub` the chat attribution (`changedBy.sub`) + the profile→presence sequence build on. **Deliberately NOT deployed** — it needs a greenfield prod **wipe** (re-key + DO-class delete), and rather than wipe once now + again later, we **batch ONE CF-dashboard worker-delete + redeploy at this multi-user-chat milestone** (pre-user window stays open ⇒ **keep F&F invites paused** until then). Runbook: the archived Phase 4. ⚠️ **That runbook's `migrations`-shaped steps (2 + 4) are SUPERSEDED** by the declarative-`exports` conversion — the prod config is `exports` now and `audit-migrations.mjs` is exports-aware, so at the wipe follow [archive/do-exports-and-toolchain-upgrade.md](archive/do-exports-and-toolchain-upgrade.md) § Phase 4, not the frozen migrations narration. The ⚠️ real-CF-KV-login→refresh cross-colo gap is now **de-risked in code** (2026-07-13) — the refresh handler falls back on a KV miss to the strongly-consistent registry `RefreshTokenIndex` (`getRefreshRecord`, self-heals KV); still worth a smoke-check at the wipe — item 5 keeps this fallback deliberately (D15), so it stays a live path. **Follow-ons that ride this milestone:** the "login flows" restoration (SPA login UX + baseline test infra) on the new no-mint model ([backlog.md](backlog.md) § Nebula Auth), and profile→presence schema (their own wipe-needing changes fold into the same batch wipe).
    - 🪟 **The wipe is a CLOSING WINDOW for free schema surgery — batch it here.** Greenfield means every DB is created fresh, so changes that would otherwise need a migration (or be permanently awkward) are **free right now and expensive forever after** we have real users.

      ⚠️ **The numbers are stable citation handles, not a running order.** ADR-016's always-loaded one-liner cites *"item 6"*, so they are **append-only** — never renumber when one is inserted, removed or resequenced (`workflow.md`). **The page order IS the execution order.** Add a new item with the next unused number, placed where it should run. Queued:
      2. **Move the tsc dependency into the container** (⚠️ placeholder — no task file yet). `@lumenize/ts-runtime-parser-validator` is **9.2 MB of the main Worker's 11.8 MB bundle, and a DO pays for its Worker's WHOLE bundle** — measured `create` **1,433 ms → ~357 ms** with it removed. Every tsc user is build-side (`galaxy.ts` compiles the `validatorBundle`, `codegen-gate.ts`, `dev-studio.ts`, `devstudio-resource-ontology.ts`); the request path only *loads* a precompiled bundle via the Worker Loader (`star.ts` → `getParserValidatorFacet(…, env.LOADER)`), which needs no tsc — so the container, which already runs the user-developer's build, is the natural home. Needs **no DO class migration** (so not strictly wipe-gated), but it must land **before** item 3 because it decides which tier the bundle lands in. Bonus: retires `bundle-tsc.mjs`. Evidence: [`experiments/do-cold-start-bundle-ab/RESULTS.md`](../experiments/do-cold-start-bundle-ab/RESULTS.md).
      3. **Middle-tier analysis + split decision** (⚠️ placeholder — no task file yet). After item 2, re-measure the main Worker's bundle. Cold-start cost has **three tiers**: ≤~2.7 MB is cheap and stable (`create` ~340–390 ms), ≥~9 MB is expensive (~1,300–1,430 ms), and **the ~2.7–9 MB middle is unpredictable** — an identical bundle measured 120 ms and 1,256 ms on repeat wake runs, consistent with memory-pressure-driven eviction that may preferentially reap the largest-footprint instances. **No bench can tell you which behavior prod will give you**, so if the main Worker lands in the middle tier, decide whether to split any DO into its own Workers project. ⚠️ **This is the wipe-gated half**: moving a DO class between Workers projects is a `transferred` migration — cheap now, materially harder once live tenants exist. Strongest prior if we split anything: the **Gateway** (on every client connect). Evidence: [`experiments/do-cold-start-bundle-ab/RESULTS.md`](../experiments/do-cold-start-bundle-ab/RESULTS.md).
      5. ✅ **The identity data model — BUILT 2026-08-04.** `Identities` is gone: one **`Emails`** row owns the address and its `profileId`, and **`Memberships`** keys on `emailId` (`sub` PK, scope, `scopeAdmin`, `acceptedAt`). "One human, one profile" is now a **structural fact** rather than an emergent property of N rows agreeing — so derived canonical-ness, the first-mover race, and the N uncoordinated copies of `email` are all *dissolved* rather than guarded. `RefreshTokenIndex` is kept and now swept hourly. ⚠️ **This item is DONE but still listed, because the numbers are append-only citation handles** (see the note above) — do not renumber, and do not treat its presence as queued work. ⚠️ **`schemas.ts` is the authority now, not the task file** — the design reasoning is archived at [archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md) and is frozen. **What still rides the wipe from it:** the collapsed `REGISTRY_MIGRATIONS` baseline is numbered **above** the previously-applied high-water mark, so it is safe against any storage that already ran the old list — but the constraint stands that there is **no deploy between the rewrite and the wipe**.
      6. **Replace Resources' `changedBy` with the full acting claims, and DERIVE the coalesce key** — [ADR-016](../docs/adr/016-record-the-acting-principal.md) conformance (surfaced 2026-07-28, Larry). `SnapshotMeta.changedBy: ActClaim` ([resources.ts:36](../apps/nebula/src/resources.ts); one JSON `TEXT` column at `:91`, parsed at `:133`) holds `{ sub, act? }` — enough to name the actor, not the `profileId` or asserted `access` ADR-016 requires. **The blocker is a conflation, not a cost:** `:212`'s `JSON.stringify(current.meta.changedBy) === changedByJson` makes the stored record *itself* the same-actor key. ⚠️ **Do NOT just widen it** — the coalesce window is **1 hour** (`:107`) while `ACCESS_TOKEN_TTL` is **15 min**, so one window spans several tokens with differing `jti`/`iat` and an hour-long editing session would stop coalescing, multiplying snapshot rows on the highest-volume write path. **The fix:** store the **entire claims object** *in that column's place* (same rule as every other ADR-016 site — not a second field beside it, which would store `sub`/`act` twice in one row), and compute the same-actor key from **identity only** (`sub` + the complete `act` chain); if either changes, new snapshot. ✅ **Coalescing behaviour is provably unchanged** — `{ sub, act }` is already all `changedBy` holds, so the derived key *is* today's stringify, made explicit. Keep `profileId` (derived from `sub`; would spuriously split on a unification re-point) and `access` (asserted authority) **out** of the key. **Rename the field too** — use **`actingToken`**, which is no longer "or similar": the first ADR-016 site (`executeScopeDeletion`'s record, landed 2026-07-29) uses it, and it is [ADR-016](../docs/adr/016-record-the-acting-principal.md)'s own phrase (*"the FULL verified claims of the acting token"*). ⚠️ **Name it for the TOKEN, never for a role.** `actingToken.sub` reads as *the token's subject*, which is what it is. Every role name inverts: `actor.sub` reads as "the actor" but is the person acted *upon* (the actor is `act.sub`) — the misreading ADR-016 exists to prevent — and `actingClaims`, tried first, is the same defect one step removed ("the acting claims" still invites "the acting sub"). Let the structure carry it: a token has a subject and an actor. ⏳ **The line to DELETE when you build this is `projectActClaim` in [resources.ts](../apps/nebula/src/resources.ts)** (exported, with `#buildChangedBy` its only production caller, plus one unit test). It exists solely to keep the widened JWT `act` claim out of this column while the column is still narrow; once the column holds the full claims, the projection is not adjusted — it is removed, because the widened claim is then exactly what should be stored. Its JSDoc says so at the site. **Two deadlines, and the second is tighter than the wipe:** it is persisted history (so breaking, hence this list) **and nothing outside `resources.ts` reads it today** — the only other repo-wide hit is a *comment* at `nebula-client.ts:1631` — so it is a **zero-reader rename right now**, while the Galaxy collapse's chat attribution is its first real consumer. ⚠️ **Check before building** [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) Phase 2's parallel `{sub → profileId}` `Snapshot.meta` map — with both parties' `profileId` on the record it may be redundant. Also: `Snapshot.meta` rides pushes, so the **push boundary needs its own projection** (never ship a writer's `access`/`jti` to subscribers — beyond ADR-008 intra-Star, and worse for global Profile snapshots under ADR-012); that is a disclosure boundary, not a compatibility one, since there are no readers yet. ⚠️ **A doc edit rides this item, as a phase criterion rather than a cleanup step.** [`docs/vision/auth.md`](../docs/vision/auth.md) § *Reading the history* already describes the target — both kinds of record naming the acting principal identically — so the **prose needs no edit**. What this item retires is the one sentence in its `> **Today's code differs.**` blockquote noting that the Resource attribution is **narrower** than the target — no `profileId`, no asserted `access`. Delete that sentence only; everything else there is retired by a durable sink and a history read path, not by this item.
      7. **The dominion vocabulary rename** → [nebula-dominion-vocabulary-rename.md](nebula-dominion-vocabulary-rename.md). ⚠️ **What is on THIS list is one file, not four.** The passage/dominion work was split four ways on 2026-08-11 (§ *Remaining* carries the order); **only the rename file is wipe-gated**, and only for its Phase 2: `Subscribers.accessAdmin` → `dominionAtSubscribe` is a stored-column rename, nearly free before the wipe and a **two-mechanism** migration after — `Subscribers` has a migration list, `QuerySubscribers` has none at all and carries the column inline in a `CREATE TABLE IF NOT EXISTS`, so editing that DDL is a **silent no-op on every table that already exists** (Larry, 2026-08-11). The other three files are code-only and gated on nothing. ⚠️ **It is NOT invite-gated, and was briefly mis-filed as such** (`872a3af`) on the premise that the Registry gate was a live authorization hole; Stage 2 established it is not — the conjunction is real, merely split across a file boundary.
- 🔬 **DevStudio + DevContainer collapse — SPIKE DONE 2026-07-07 → CLEAN → GO.** The ≥3×-failed tab-refocus **reconstitution** race; **simplify-first** fix = merge the two dev-sandbox DOs into one **`DevStudio extends NebulaContainer`** (removes a hibernation dimension — a diagnosis-independent bet). The feasibility spike cleared all four gates (ResourceDataPlane composition · `ctx.abort`-vs-chat · DO-class migration · test-extraction) — a bounded, mechanical, multi-file change, not hard-&-messy. **Build lands AFTER the chat work + `rfc-act-chains` detour** (the merge relocates the chat Resources → don't build against a moving surface). **The collapse itself delivers "make reload work"** — its acceptance bar is the preview self-healing on refocus, so it **subsumes** preview-redeploys GATE candidate (b). A *separate* pre-collapse self-heal would be an interim the collapse obsoletes (same reconstitution path, cross-node → local), so we do **NOT** build one first; any residual self-heal is post-collapse, single-node, and only if the prod trigger-rate still shows it. → the preview-survives-redeploys invite gate **rides on the collapse** (fine — invites aren't imminent). ⚠️ **Reframed 2026-07-16 → build-not-serve; all THREE (Galaxy+DevStudio+DevContainer) collapse into one `Galaxy`** — reversing the earlier "Galaxy stays separate" — **and merged with the chat bullet above into a single file.** → **[nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)** *(supersedes the two former child files; has the punch-list)*.
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
  ⚠️ **The screen it renders on is being re-ordered** — see the login gate below; the claim/slug-pick prompt
  moves behind the magic-link click, so build the two together or this notice ships into a flow that no
  longer exists.
- ⚠️ **GATE — login: prove the mailbox, then choose the workspace (NOT built).** Studio calls `discover(email)`
  **before** anyone proves anything, and three costs fall out of that one ordering: an address with more than
  one membership hits a dead end (the UI logs that a picker is a later feature), a new user spends **two**
  emails to claim a Universe on the open self-signup path, and any caller can ask which scopes an address
  belongs to and administers — narrowing the response does not close it, because at Galaxy/Universe tiers
  membership *is* admin-ship and at the reserved `nebula-platform` scope it *is* superuser-ship. The target
  re-orders to: one scope-less link → the click proves the mailbox → *then* the scopes come back and you
  choose one. Every pre-alpha user meets this screen first, which is why it lands before invites (Larry,
  2026-08-09). → design intent, decisions, and three open questions:
  **[nebula-login-prove-then-choose.md](nebula-login-prove-then-choose.md)** § *The target*.
- ⚠️ **GATE — preview survives redeploys (NOT built; found live on prod 2026-07-04).** Every pre-alpha redeploy re-rolls the DevContainer application (ANY container-config change restarts instances — e.g. the `instance_type` sync `standard`→`standard-1` applied on the 07-04 deploy), so each deploy **cold-boots every active preview**, and a cold boot reverts the container disk to the baked image (Flow 1c). Observed for `larry.2026-07-01-larry-1.dev` right after the 07-04 redeploy: the preview stuck on the **"Waking your preview…"** interstitial that **does NOT self-heal on a plain cold boot** — `wakingPreviewPage`'s `autoRecover` is gated on the stuck-`running`-flag signature (`isStuckFlagResponse`) ONLY, so a normal cold boot shows a **manual-only Reload button that feels dead** for the minutes the boot takes; and once the container came up it served the **baked default** (`App.vue` = "Your app is warming up…", `appVersion:""`) — the user's generated app was **gone until a new codegen turn re-pushed it**. **We redeploy a lot during pre-alpha, so every F&F user's live preview breaks after every deploy and does not come back on its own → must be seamless before/right-after inviting.** Candidate directions (pin at `/review-task`, do NOT pre-pin): **(a)** the waking page **bounded-auto-polls the cold-boot case too** (with backoff), not just the stuck-flag case, so a legit boot self-heals with no clicking; **(b)** **auto-restore on preview-open** — DevStudio holds the durable source (git `Workspace`), so a cold-booted container should be re-pushed on preview-open/return (Flow 1c) **without** requiring a new codegen turn (the existing app returns by itself); **(c)** **deploy pre-warms** the known-active containers (or re-pushes) so users never hit a cold preview post-deploy; **(d)** a codegen push onto an **unavailable** container must **surface/retry visibly**, never silently land on the baked placeholder with `appVersion:""`. Direct follow-on to the wakeup fix (`tasks/archive/nebula-container-wakeup-fix.md`, same `dev-container.ts` preview/waking-page path): that fix handled the RARE stuck-`running` race; this is the **common** post-redeploy/idle cold-boot UX it explicitly deferred.
  - **Acceptance / verify (the bar for "confident"):** after a **container-re-rolling** redeploy (or a >5m idle), the preview **self-heals to the running app within ~60s with zero manual clicks.** Checkable with a post-deploy probe that polls `GET /dev-container/{scope}/` and classifies the body — `Waking your preview` = stuck/cold, `warming up` = baked default (source not re-pushed), `nebula-scope` meta = app serving. ⚠️ **Repro is conditional:** a pure worker-code redeploy that leaves the container image/config unchanged may NOT re-roll the container (preview stays warm), so to actually exercise this, deploy a container-touching change (or let it idle >5m) first.


### Consider before invites (NOT gates)

Nothing here blocks an invite. Each is listed because the window in which it is cheap closes when
someone other than Larry is reading the output — or building against it. Where an item links out, the
full reasoning, the rejected shortcut, and the fix direction live there; follow the link rather than
re-deriving here. *(The first two surfaced from typed-error work, 2026-08-06.)*

- **Give the scope/admin gates typed errors**, so a tester reporting "it's broken" is distinguishable
  from one who was simply refused → [backlog.md](backlog.md) § Nebula, *The scope/admin gates throw bare
  `Error`*. ⚠️ The obvious shortcut — reusing `PermissionDeniedError` — is rejected there, for reasons
  that outlive this milestone.
- **Fix `@lumenize/structured-clone`'s error rehydration, and its published doc caveat** — registering a
  custom Error on `globalThis` silently corrupts the message → [backlog.md](backlog.md) § Lumenize Mesh,
  *Registering a custom Error on `globalThis` CORRUPTS its message*. Nothing in-repo hits it; the reason
  it belongs on a pre-alpha list is that the **published** doc teaches the footgun, and pre-alpha is when
  readership starts.
- **Consider, a runtime verify step for the codegen loop** *(noted 2026-08-06)*. Studio declares a generated
  app done on the compile gate alone — nothing drives the app to see whether it renders, throws in console,
  or loads data. That is `live.md`'s thesis pointed at the **user-developer's** app instead of at us, and it
  earns a place on this list because its value rises the moment non-Larry testers start generating: without
  it, every failure arrives as a human bug report, and
  [`nebula-studio-self-improvement.md`](nebula-studio-self-improvement.md) has no source of truth for whether
  generated code *worked*. ⚠️ **The open question is the SESSION, not the driver.** The preview serve is
  deliberately ungated (`apps/nebula/src/entrypoint.ts` — direct GET/HEAD to `DEV_CONTAINER`, since browsers
  don't attach `Authorization` to document loads), so a driver reaches the shell with no token at all; but
  tenant data is gated on the WS/mesh path, so seeing **real** data needs a session, and ADR-009's ladder
  governs how one is obtained. Mechanism stays open — the Playwright we already run, Browser Run's Chromium,
  or [Kitesurf](https://blog.cloudflare.com/kitesurf/) (Workers-native, agent-shaped CDP output, materially
  cheaper per drive; its stated weak spot is exactly the long authenticated session). ⚠️ Scope it as *the
  codegen loop lacks runtime feedback*, never as *pick a browser* — user-triggered debugging and
  agent-triggered verification are one mechanism with two triggers, and the agent half is the valuable one.

### Wave 2 — the long pole (data-bound, exploratory)

**Two kinds of EXPLORATORY (do not pretend these are pinned):**
1. **Prompt-empirical** — *data-bound generation quality.* Iterate the system prompt against the compile
   gate + (later) the GLM-5.2 judge. Driven by capture → inspection → the **un-parked replay harness**
   (`tasks/on-hold/nebula-offline-prompt-harness.md`). NOT a transcribable spec — capable-of-failing checks
   + captured findings (build-task exploratory rule).
2. **UX-exploratory** — *the act-as / persona UI.* Open, prototype-and-react, NOT pinnable up front;
   the tight loop is **Larry's own dogfooding**: the `mint-narrower-token` consent UX; persona switching;
   multi-tab use; preview-panel tabs coupled to the act-as UI.

- **Provision-a-subject-into-{scope, role}** — the unification: Universe-admin invite (pre-provisioned
  slug+name + magic-link claim) **+** synthetic (act-as-only, no claim) subjects **+** act-as
  wiring. Generic on scope — but the typical case is **synthetic test users Star-scoped to the `.dev`
  Star**, driven via act-as to exercise multi-user behavior. The Universe admin's `{u}.*` reach (the Wave-1
  `onBeforeCall` change) lets them provision + grant into `.dev` without re-minting a per-target token;
  act-as downscopes automatically because DAG checks key off the delegated token's `sub` (the test
  user), never `act` (the admin). For **all Universe/Galaxy admins editing their apps going forward**, not
  just pre-alpha. This is the **push** half; shares the subject/grant/scope core with
  `tasks/nebula-request-access.md` (the **pull** half) — share it, don't fork.
  ⚠️ **Sequenced ahead of all three, and SPLIT FOUR WAYS on 2026-08-11** — the old two-file seam ('reach' vs 'authority') stopped existing once accepted `auth.md` § *Grants* made the invite bit **derived from dominion**, so one decision ran straight through the middle of it. In dependency order: **(i)** [nebula-dominion-vocabulary-rename.md](nebula-dominion-vocabulary-rename.md) — pure identifier swap, no behaviour change, and **the only one of the four that is wipe-gated** (§ *The wipe is a CLOSING WINDOW*, item 7); **(ii)** [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md) — the spine: a token carries the member's scope and two predicates compute `passage` and `dominion` from it; **(iii)** [nebula-registry-route-guards.md](nebula-registry-route-guards.md) — each Registry route states its complete requirement, and the mint asks one question; **(iv)** [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md) — invite, which now owns **who may invite**. Together they **amend ADR-015** (commitment intact, mechanism replaced) and close the collaborator's open question about tenant-Star over-reach by deleting the over-reach. ⚠️ **ADR-015 ratification is NOT gated on any of them** — Larry's ad-hoc call.
  **Split into three on 2026-08-05, by dependency rather than topic:**
  **(a)** the invite MECHANISM — [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md), buildable
  now, no collapse dependency: per-invitee `scopeAdmin`, the minted `sub` in the response, a client method.
  It names no collaborator. **(b)** the COLLABORATOR — ⏸️ **ON HOLD and OUT of pre-alpha
  (2026-08-09, Larry)**, [on-hold/nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md).
  Its design mixes the **Registry domain and the mesh domain** — the registry structurally cannot
  pre-stage a DAG grant, Nebula structurally cannot mint a membership — and that is worth not thinking
  hard about until after pre-alpha unless forced. **Pre-alpha pays for the pause with training or a code
  workaround** for its handful of users; the interim shape is the Galaxy-admin-via-bypass enrollment
  [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) already carries, which is
  broader than the bundle and deliberately so. ⚠️ **The collapse gate still holds and is not why it
  paused** — resuming is a scheduling call, first consumer being `docs/vision/enterprise.md`
  § *The invitation is the land motion*. **(c)** the SYNTHETIC subjects — below, still unowned.
  🔄 **A pinned decision was reversed here (2026-08-05):** `collaborator = admin at the invited scope`
  (pinned 2026-07-19) is retired. It was not the narrowest thing that worked — an exact-star invite at
  `{u}.{g}.dev` reaches that Star and nothing else and needs zero grant machinery — and shipping a
  named-but-wrong collaborator would cost more in re-reading than it saved (`workflow.md` § *unlearning
  tax*). Reasoning lives in (b)'s § *Decisions*, first row.
  ⚠️ **(a) has a task file and (b) has one on hold. (c) is NEEDED and UNOWNED** — called out here so it stops being a
  clause inside someone else's bullet. Neither invite path exercises a data-plane permission model: (a)
  mints a membership and (b) grants a bundle, but both are people with mailboxes. For a Star to be
  exercised it needs **non-admin members driven under test**, and the pre-alpha answer is **synthetic
  act-as-only subjects** (no mailbox, no claim, RFC-reserved dead domain — § Caveats) plus whatever
  attaches their DAG grants.
  ✅ **Checkable:** `createSubject` exists **only** in `apps/nebula/test/test-helpers.ts` — zero
  production callers, no UI — so today this capability exists for tests and for nobody else.
  ⚠️ **Placement is open, and it is a real question, not a formatting one:** this sits in Wave 2 as
  exploratory, but *"a pre-alpha user can test the permission model of the app they just generated"*
  reads as **Invite-gated**. Decide before the collapse lands, since that is when real users arrive.
  ⚠️ **A galaxy-tier invite is NOT missing capability**, and reading it as such is what produced the
  reversed decision above: a universe admin's `{u}.*` already covers `{u}.{g}` and everything beneath,
  so a galaxy-tier admin is a *narrower* principal, never a new one. The narrow mechanical consequence
  is that nobody can *authenticate at* a Galaxy by claim (no identity row can exist at a 2-segment scope
  — `create-galaxy` mints none and there is no `claim-galaxy`), so callers authenticate at the universe
  and name the galaxy in `activeScope` — the shape prod uses, and it stays correct afterward.
- **Ontology annotations** (`@title` / `@description` / `@inverse`) — data-bound prereq; additive to
  `extractTypeMetadata` (engine roadmap item).
- **Container vite swc** — Rung-2 runtime so data-bound apps (importing `{client, store}`) actually run
  in preview (`unplugin-swc` for TC39 decorators + image rebuild). This is also when the container first
  needs the **unpublished `@lumenize/nebula` source**: **vendor `src/` into the image** (`file:`/workspace
  ref, the same bundle-from-`src/` move the rest of the deploy uses) — **not** a public-npm publish (Nebula
  is `UNLICENSED`). See `tasks/archive/nebula-release-process.md` Phase 3 § *Dependency resolution*.
- **Data-bound generation (EXPLORATORY)** — the empirical prompt loop. **Un-parks** the replay harness
  (`tasks/on-hold/nebula-offline-prompt-harness.md`) + the **skills** (`tasks/nebula-skills.md`). Dogfood
  secret-santa-grade apps with synthetic users + act-as. Includes the UX-exploratory questions above.

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
- 👤 **LARRY HAND-REVIEW — ADR-011 onward, then restructure/merge/split wholesale.** Scheduled **after the Galaxy
  collapse ships** (Larry, 2026-07-27). ADR-010 was the last one carefully hand-reviewed, so **011 through 015 plus
  whatever lands in the interim have never had a careful pass.** Reviewing and restructuring them all is a bigger job
  than is worth doing mid-flight, so the interim is: land the access-model ADR + its ADR-012/013 knock-ons now, and
  reorganize the whole set here. **Known inputs for that pass:**
  - **The access-control model was never written down anywhere** until `tasks/archive/nebula-identity-data-model.md`, which is
    exactly why it drifted for a week unnoticed. Its § *The invariant* + § *Settled* are the best statement of the
    coarse-grained model (`{u}.{g}.{s}`) we have; decide how much of it stays a task file vs becomes an ADR, and
    whether ADR-012 shrinks back to being about *visibility* once an access ADR owns "a profile is never an authz
    input." ⚠️ **That file is ARCHIVED and therefore frozen** — whatever of it must stay live has to be lifted into an
    ADR or a rule here, not maintained in place.
  - 🔴 **RATIFY ADR-016 / ADR-018 — DUE NOW, and this is the only thing still tracking them.** Both are ⚠️ **ADR-015 came OFF this row on 2026-08-11 and is tracked nowhere by design.** Larry ratifies it **ad-hoc**, gated on nothing, likely just before or just after the Galaxy collapse — his read is that the model is solid but will see more tweaks (the invite rule is still being calibrated). ⚠️ **Do not re-add a ratification gate for it here or in any task file**, and do not let `/review-task` or `/build-task` block on one: the tasks amending it land without it. Its Status line is the authority.
    `Proposed`, held that way deliberately so the identity/schema build could battle-test them rather than ratifying on
    the strength of a design review (Larry, 2026-08-04) — a knowing departure from `docs/adr/README.md` § *The
    ratification gate*, which fires **before** `/build-task`. **That build shipped 2026-08-04, so the evidence the
    departure was waiting for now exists**, and the debt it created is live: the build cites all three as settled
    constraints while none is ratified. ADR-016 was amended *from* that build (the session trigger, symbol-cited
    Evidence, structurally-stated conformance) and ADR-012 alongside it, so the amendments are inputs to the
    ratification, not a substitute for it. ⚠️ **Do not fold this into the wholesale restructure above and lose it** —
    ratifying a Status line is a decision, restructuring is editorial, and the first should not wait on the second.
  - **Candidates to merge or split:** 008 (intra-scope visibility) / 012 (global profile visibility) / 013 (identity
    keying) / 015 (authority direction) each cover one facet of one model. That may be four ADRs or one.
  - ⚠️ **Three ADRs violate the README's own forward-facing discipline** (*"don't accrete dated 'Amended …' notes —
    git is the record"*): **008** and **013** carry dated amendment notes, and **009** carries a whole amendment
    blockquote. Decide per-file — 009's may **earn** its place, since it exists to stop sessions citing a withdrawn
    latency figure to justify shortcuts, and git is *not* loaded into context. If a carve-out is warranted, write it
    into `docs/adr/README.md` rather than leaving three silent exceptions.
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
  pre-alpha **users** live (mandatory for invites), **(c)** realistic multi-tab / auth / act-as
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
  `tasks/nebula-skills.md` · eval / **Studio self-improvement loop** `tasks/nebula-studio-self-improvement.md`
- Provisioning pull-half: `tasks/nebula-request-access.md` · Root-admin: `tasks/on-hold/nebula-dataplane-root-admin.md`
- Fast-follow / demand-driven capabilities (reactive, post-core): `tasks/nebula-pre-alpha-fast-follow.md` —
  parent index for media storage, app AI persona, and outside-world connectivity (design+phases in
  `tasks/nebula-outside-world.md`; `fetch` → email → search → secrets-last; incl. Wave-3 inbound email).
- ✅ **Live self-verification harness — SHIPPED + ARCHIVED 2026-07-06** (`tasks/archive/claude-live-verification.md`, commits `8b1b4ff` + `f04ebcb` + `8214f59`): the `/live` skill + always-loaded `live.md` rule + `apps/nebula/harness/` drive a running Nebula (API via `NebulaClient` + browser capture: screenshot/a11y/console/network). Reproduced the chat-history gap live (fed the answer into the chat-history entry above). Also shipped the bootstrap-array `*` super-admin (nebula-auth `#bootstrapEmails` comma-list). **Prod drive (3b/3d + attach) — ALSO SHIPPED 2026-07-06:** `apps/nebula/harness/prod.ts` drives *deployed* prod autonomously (no boot) → stored `*`-admin refresh (headless ~2.5s, no email); verified live by enumerating the real prod scope tree. **Standing authorization:** I drive/read prod when Larry asks — no reconfirming (read-mostly; writes/deploys stay deliberate). The `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN` header bypass (nebula-auth `checkTurnstile`) is built + deployed + unit-tested — the enabler for the alpha "turn Turnstile ON in prod" step. ⚠️ Turnstile is **still OFF in prod today** (`TURNSTILE_SECRET_KEY` unset — confirmed via `wrangler secret list`), so the live run currently clears via the no-secret skip; the bypass path only becomes load-bearing once Turnstile flips ON. M1 controls + findings: `apps/nebula/harness/FINDINGS.md`.
