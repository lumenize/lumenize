# Nebula — Pre-alpha (master plan)

**Status (2026-11-12):** production, `nebula.lumenize.com`, was last deployed on 2026-07-06. Everything built since waits for a wipe and redeploy (§ *⑥ The wipe*), so production is no evidence of current behaviour. The first invite waits on § *What remains*. The wipe need not.

**Goal:** ~4–5 pre-alpha users — Larry's friends, family and business partners ("users," not "partners") — building their own data-bound, multi-user apps on a deployed Nebula, exercised through personas, with enough instrumentation for near-daily conversations as they build.

**How to read this file.** § *What remains* is the plan, in order. Each section after it holds what one item needs and has no task file for yet. Once a task file exists it is the authority, and this file keeps one line. Built work is one line in § *Shipped*. Work deferred past pre-alpha is not tracked here: it lives in `tasks/on-hold/` and [backlog.md](backlog.md). Task files are written one at a time and archived when built.

**The circled numbers are handles other files cite.** They were assigned once and are never reused, so a gap is an item that left the plan: ①, ④ and ⑤ are in § *Shipped*.

## What remains

**The first invite is the line that matters, not the wipe.** Until someone is invited, production holds only Larry's test data, so wiping it again costs a redeploy and re-entering its secrets (§ *⑥ The wipe*). *Gate* says what a row needs:

- **`data`** changes a stored shape. It lands before the wipe, or production is wiped again after it.
- **`deploy`** only needs to reach production, by any deploy, before the first invite.

**Before the wipe, or wipe again after it:**

| # | Item | Specified in | Gate |
|---|---|---|---|
| — | **Shared pages** — Universe Signup and Galaxy create capture each scope's full name, and each page decides whether an app forwards to ours or runs its own | § *Shared pages*. The names are stored by [nebula-upgrade-universe-with-a-data-plane.md](nebula-upgrade-universe-with-a-data-plane.md), which has its design intent and no phases yet | data |

**Before the first invite, in this order:**

| # | Item | Specified in | Gate |
|---|---|---|---|
| ② | **Personas** — test users the model defines, each a real member of the dev Star in its own preview tab | [nebula-personas-are-real-members.md](nebula-personas-are-real-members.md), which replaced a first build reverted on 2026-11-13 ([the archived file](archive/nebula-testing-with-personas.md)). Before it came query subscriptions that take a filter ([archived](archive/nebula-query-subscriptions-take-a-filter.md)), so a persona can find what a teammate made | deploy |
| ③ | **Capture live** — every turn is recorded from the first one, since a turn nobody captured is gone for good | § *③ Capture live* | deploy |
| — | **Denied access shows in the app** — a generated app shows what a subscriber cannot read and who can grant it | § *Denied access in generated apps* | deploy |
| — | **A `computed()` over the store can miss its subscription**, and the view goes stale with no error | § *A `computed()` misses its subscription* | deploy |
| — | **Generated apps are pure Vapor** | § *Generated apps are pure Vapor* | deploy |

**Why this order.** The riskiest goes first, and risk here is unresolved design, not hard implementation (Larry, 2026-09-02). ② carries the most design uncertainty left. ③ is small but cannot be repaired later. The `computed()` fix comes before Vapor, so Vapor builds on a store whose every read subscribes.

**The first invite waits on both tables, and on ③'s check that capture works on production.** Larry then provisions and invites ~4–5 users, each with a first-app idea chosen for them (Sydney: secret santa with a wishlist).

**What needs users waits for them, in [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md):** turn-log inspection (Item 17), the superuser join scenario (Item 18), the feedback loop (Item 19) and data-bound generation (Item 20).

**Cheap before invites, and never a gate.** Each has a backlog row with its reasoning. They are listed here because the chance closes once someone other than Larry reads the output:

- Typed errors from the scope and admin gates, so "it's broken" can be told from "you were refused": [backlog.md](backlog.md) § *Nebula*, the bare-`Error` row.
- `@lumenize/structured-clone`'s error rehydration and its published doc caveat: [backlog.md](backlog.md) § *Lumenize Mesh*, the `globalThis` row.
- A runtime verify step for the codegen loop: [backlog.md](backlog.md) § *Nebula*, the runtime-verify row.

**Close-out, after pre-alpha ships.**

- 👤 **Larry hand-reviews ADR-011 onward.** Its inputs are in § *ADR hand-review*.
- **Mesh 1.0.0-alpha.1 ships** before the npm publish. [mesh-1-alpha.md](mesh-1-alpha.md) holds what an adopter needs that Nebula does not.
- **npm publish** from merged `main`, with `/release-workflow`. No package has been published from this branch yet.
- **`pre-alpha` becomes `alpha`:** a PR from `pre-alpha` to `main`, a release, then a branch `alpha` off `main`. An open draft PR from `pre-alpha` to `main` gives continuous CI until then.

---

## ③ Capture live

**Confirm on the deploy that generation capture is live, then extend it with UI events: undo, abandon and feedback.** The events share a sink with the feedback button. Its code rides the one deploy like any `deploy` row, and the confirmation comes after the deploy and before the first invite, which waits on it. The risk is not difficulty. It is that this item gets squeezed at the end, when everything else in the run can be repaired by a later deploy and this cannot.

**What exists.** Each agent `Message` Resource carries a `codegen` value object, and `codegen.sourceCommit` is captured before the loop writes, so a prompt can be replayed from the exact code it started on. That is what the nightly replay loop needs: it reads testers' turns across scopes and runs them against the bench in [on-hold/nebula-offline-prompt-harness.md](on-hold/nebula-offline-prompt-harness.md).

**What is missing:**

- **A turn that dies at the generation deadline is never captured.** A handled failure does commit a reply, but the deadline's `Promise.race` abandons the turn body, so nothing lands and "how often does a turn hang?" has no stored answer. `commitAgentMessage` hardcodes `status: 'complete'` at its one write site, which is where a terminal record would go.
- **The UI events** above.
- **`report_finding`**, below.
- **The preview's error channel**, below.

### `report_finding`: the model as a reporter

A codegen tool the model calls when a doc misled it or an API misbehaved. The finding rides the turn's agent `Message` as structured capture. It stays inside the tenant, the digest removes duplicates, and a person reads it before anything reaches a public tracker.

- **It never files a GitHub issue from inside a tenant's Galaxy.** That would cross the tenant boundary carrying text someone may have injected, and its likeliest failure is pasting a user-developer's ontology into a public issue.
- **Its parts have different homes.** The record field is capture, and belongs here. The filing a person approves belongs to the daily digest. The instruction telling the model when to report is guidance, and goes where `studio-guidance.md` places it.
- **A broken link in the platform guidance is not its job.** That tree's generator resolves every link at build time and fails on a bad one.

The acceptance events have a second consumer. A turn the user corrected or abandoned feeds the platform's own guidance ([on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md) § *Part B*). The app's own conventions need no such signal, because the transcript in the prompt lets the model see a correction as it arrives.

### The preview's error channel

A user-developer says "the preview screen is blank", and the model's first move should be to read the log tail. This may become a task file of its own once ③ starts. Its trigger and first consumer is ② ([nebula-personas-are-real-members.md](nebula-personas-are-real-members.md)), where a denied persona tab and a broken one look the same without logs. ② builds the tool the model reads a tab with, `run_in_tab`, so this section keeps its buffer and adds no tool of its own.

- **`@lumenize/debug` gains a second callback: filtered by `DEBUG`, and added to console output.** `setDebugSink` exists, but it is for tests: it bypasses the `DEBUG` filter and replaces console output. Production wants the opposite of both. A second slot beats a flag, since neither behaviour is then re-derived at the call site and no sink has to repeat the filter.
- **The scaffold's `nebula.ts` installs it**, entries land in this section's sink, and a loop tool reads the tail: one entry in `LOOP_TOOL_ENTRIES`. A later tool that lets the model widen its own `DEBUG` filter adds to this and is not owed now.
- **An entry carries the persona slug, decided before the buffer is written.** ② opens several previews at once, so an untagged tail is several streams interleaved. Tagging is cheap at the write and cannot be recovered afterwards.
- **The scaffold half cannot be added to an existing app.** `nebula.ts` is seeded once, so an app created before the sink lands keeps a copy without it, and nothing tells the model to go back. That is why this rides the one deploy and is not fast-follow.

## Denied access in generated apps

**A subscriber sees what it can read and is told which nodes it cannot, so an app with no UI for the missing part looks like it works.** Bob sees 20 of a project's 21 tasks, and nothing tells him one is missing unless he compares notes with a coworker. Refusing the whole subscription would have failed loudly, and lost because it costs Bob all 20 when one task is out of his reach (Larry, 2026-09-28). So the partial answer is the better experience only once the app shows what is missing.

This item settles:

- **What a generated app shows.** A query handle and a resource handle both carry `deniedNodes`, and a denied resource's `.snapshot` resolves `null`. The app names what is missing and who can grant it. It needs no code for the grant arriving: a client re-subscribes whatever was denied at the next org-tree change, so the missing task appears once an admin grants access (`grant-reveals-denied` drives this). Who to name when no admin is found, and how the request reaches them, are open in [on-hold/nebula-request-access.md](on-hold/nebula-request-access.md). This item needs only enough of that for the app to point somewhere.
- **What Studio's guidance says.** The model builds that UI by default, without being asked. Each piece lands where `studio-guidance.md` places it: the convention in `apps/nebula/platform/AGENTS.md`, the procedure in a skill, and the reference in `api-reference.md`, which already documents `deniedNodes`.

## A `computed()` misses its subscription

**A component's `computed()` that switches to a resource id the store already holds never subscribes it, and the view shows stale data with no error.** Take `computed(() => store.resources.Todo[selectedId.value])`. When `selectedId` changes, Vue re-runs the getter during the render's dirty check, where neither an effect scope nor a component instance is active. `trackRead` in `packages/resources/src/frontend/create-nebula-client.ts` then finds no scope and subscribes nothing.

- **Why it mostly works today.** An id the store has never seen is rescued by accident: the read writes `{}` into the store, that write runs the getter again inside the render, and there the read subscribes.
- **When it fails.** The id was read once outside any scope, or by a component that has since unmounted and let it go. The store already holds it, nothing is written, and the getter does not run again.
- **Evidence.** Found 2026-10-03, failing the same way on Vue 3.5.34 and 3.6.0-rc.10: [experiments/vue-vapor-autosubscribe/RESULTS.md](../experiments/vue-vapor-autosubscribe/RESULTS.md) § *A pre-existing bug the spike surfaced*, whose `npm run test:revisit` reproduces it. A `watch` getter that reads a new id after setup should miss the same way, and that is not yet probed.

## Generated apps are pure Vapor

**A generated app should be a pure Vapor app before the first user builds one, so that nobody's app needs migrating afterwards** (Larry, 2026-10-03). The repo is on Vue 3.6.0-rc.10, and the store's auto-subscribe works inside a Vapor component, checked with a mutation in [experiments/vue-vapor-autosubscribe/RESULTS.md](../experiments/vue-vapor-autosubscribe/RESULTS.md). Mixing the modes is what to avoid: a Vapor component inside an ordinary app ships both runtimes and roughly doubles the scaffold's bundle, while a pure Vapor app shrinks it (that file's § *Bundle size*).

These change:

- **Icons.** `lucide-vue-next`, the one import `apps/nebula/platform/AGENTS.md` allows, renders nothing in a pure Vapor app, with no error and a green build. So do its renamed successor `@lucide/vue` and `@iconify/vue`. `unplugin-icons` with `compiler: 'vue-vapor'` compiles Lucide's set into Vapor components at build time, imported as `import House from '~icons/lucide/house'`. It replaces `lucide-vue-next` in the scaffold's `vite.config.ts`, in the dependencies baked into the image, and in that guidance line. Studio's own UI keeps `lucide-vue-next`.
- **A check for what the compiler lets through.** Under `vapor`, `v-memo` compiles and is silently dropped, and `@vue:` events and `getCurrentInstance()` compile too. Only the Options API fails. The guidance names all of these, and a check over the generated source refuses each one loudly. Whether the check sits in `container/compiler/sfc-check.ts` or in the codegen loop is this item's call.
- **The scaffold and the prompt.** `main.ts` mounts with `createVaporApp`, `App.vue` takes `vapor`, `scaffold-seed.ts` is regenerated, and `TOOL_CONTRACT` in `codegen-loop.ts` says Vapor. The build's type check needs no change, since it reads the installed Vue's own types.
- **The docs.** `using-vue.md`'s CDN example compiles its templates in the browser, which Vapor cannot do, so it is marked as the ordinary mode or removed. `coding-your-ui.md`'s "render-function modules" stops being true.

**The proof is `first-app-built` building a pure Vapor app whose icons render.** That needs a new limb checking that the `<svg>` is present, because a broken icon fails silently.

**If Vue 3.6.0 has shipped by then, the pins move to it first.** Every `3.6.0-rc.10` pin becomes `3.6.0`, and both `"overrides": { "vue": "$vue" }` blocks go, in the root and the scaffold `package.json`. They exist only because no plugin's `vue` peer range admits a prerelease.

## Shared pages

**The pages several builds touch — Universe Signup, Galaxy create and login — are one item** (Larry, 2026-09-16). It does the following:

- **It captures scope full names** on Universe Signup and Galaxy create, as § *Scope full names* describes.
- **It decides, page by page, how a user-developer's app reaches each one.** The default is that the app forwards to our page with `return_to`. The alternative is a page of the app's own, which posts what it collected to the platform host, gets a one-time token back, and navigates on with it to the platform host, which finishes the way login does. Which pages get the custom kind first is this item's call, and the custom kind may land after pre-alpha.

[nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) caps the slugs these pages collect at 30 characters, and names the one `POST` ADR-022 would need to admit for a custom page.

### Scope full names

**A Universe, Galaxy or Star has no human name anywhere today, so its slug does two jobs.** `Scopes` is one column, `universeGalaxyStarId TEXT PRIMARY KEY`. [nebula-upgrade-universe-with-a-data-plane.md](nebula-upgrade-universe-with-a-data-plane.md) stores each name as a scope-metadata resource on the scope's own host, never on `Scopes`, written where the scope is created: the universe claims, which also write the first app, `claimStar`, and `createGalaxy` for every later app.

- **Universe Signup and Galaxy create both gain the field** (Larry, 2026-09-11). Star signup is not in pre-alpha, where only the `.dev` Star is created, so `claimStar` writes a name with no page to type it into yet.
- **It is `data`-gated because the name is knowable only at the moment it is typed.** Nothing derives "Northwind Traders International" from `northwind-traders-intl`, so a claim that never asked leaves nothing to backfill. After the wipe the people asked are real users, whose names would be lost for good.
- **It decides how the slug cap reads.** Every slug is capped at 30 characters, because a persona and a Star share one 63-character DNS label ([the domain-allocation record](archive/decision-domain-allocation.md) § *C — nested scope labels*). With a name beside it, signup reads *"Workspace name: Northwind Traders International → URL: `northwind-traders-intl`"*, with the slug editable. Without one, the cap reads as "that name is too long".
- **This is capture only.** Whether a breadcrumb, the org tree, the scope picker or the Studio header shows the name or the slug is a separate question that gates nothing. A name nobody displays misleads no one, and a name nobody captured cannot be recovered.
- **The name is display-only.** It is never in a URL, never unique, never compared and never looked up, and after the claim nothing derives it from the slug or the slug from it. Otherwise a scope has two identifiers, which capping the slug instead of hashing it was chosen to avoid. A persona's name already follows this rule: the slug is the identity, and the model may edit the name freely.

## ⑥ The wipe

**A worker-delete from the Cloudflare dashboard, then a redeploy.** Every database is created fresh. The runbook is [archive/do-exports-and-toolchain-upgrade.md](archive/do-exports-and-toolchain-upgrade.md) § *Phase 4*, not the surrogate-sub file's older narration, which is written for `migrations` and was superseded when the config moved to declarative `exports`.

**Production's next deploy has to be a wipe, never an upgrade in place.** Built work rewrote stored shapes on the understanding that nothing in production would carry the old ones: the identity model's collapsed `REGISTRY_MIGRATIONS` baseline, `Snapshots.recordedClaims`, and `subscriptions.ts`'s migration edited in place.

**Free schema surgery lasts until the first invite, not until the wipe.** Until then production holds only Larry's test data, and a dashboard worker-delete takes the Worker's secrets with it, so a second wipe costs a redeploy and re-entering secrets. After the first invite, it costs users their data.

**So the wipe can come as soon as the builds in flight land.** A `data` row that lands after it means wiping again. Going early lets Larry use production on its real hosts, and proves this runbook's outward-facing steps on `lumenize.dev` before anyone depends on them. The plan's old rule of one wipe dates from July, when the aim was to fold the auth foundation's wipe into everyone else's. It was never about users.

**At the wipe:**

- **Secrets.** `deploy.sh`'s preflight refuses to deploy without `AUTH_BOOTSTRAP_EMAIL`, the JWT key pair, `RESEND_API_KEY` and `CERTIFICATE_API_TOKEN`, and prints the command for each. `AUTH_BOOTSTRAP_EMAIL=larry@lumenize.com, claude@lumenize.io` seeds the superusers: Larry, and Claude acting as itself (Larry, 2026-10-03). Claude acting on Larry's behalf waits for the consent-gated support session in [backlog.md](backlog.md) § *Other Nebula backlog*.
- **Production's JWT pair and certificate token are its own, set only as its secrets and never copied from `.dev.vars`.** A shared key pair would let an admin token minted on the test target or a local stack verify in production, and `.dev.vars` holds the test zone's certificate token, which would order packs on the wrong zone ([nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) § *Decisions*). Every other value still comes from `.dev.vars`. What stays open on email is in [backlog.md](backlog.md) § *Nebula Auth*, the Resend rows.
- **DNS and certificates, after the worker-delete.** Production's `CERTIFICATE_ZONE_ID` var, and proxied `*.lumenize.dev` and apex records on `lumenize.dev`, whose Advanced Certificate Manager has been on since 2026-09-11. The same step gives `lumenize.dev` a null SPF record (`v=spf1 -all`) and a `p=reject` DMARC record, since the zone sends no mail and goes live here. Each of these is outward-facing ([nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) § *Constraints* has the test zone's matching list).
- **The Galaxy's container application is created here, under the `durable_object` scheduling policy.** Production has never had one: its last deploy predates the Galaxy.
- **`wrangler containers delete` the retired `nebula-devcontainer` application**, still listed on the account on 2026-10-08. A dashboard worker-delete removes Durable Object namespaces and leaves container applications.
- **Smoke test:** a login against real Workers KV, then a refresh from another colo. A KV miss falls back to the registry's `RefreshTokenIndex`, which is a live path on purpose.

## ADR hand-review

After pre-alpha ships (Larry, 2026-09-02). Reviewing is not ratifying, and no ADR is ratified until after launch. ADR-010 was the last one Larry reviewed closely by hand. His standing read narrows the pass: ADR-015 is solid and is kept current as we go, 012 and 013 have settled, and the rest are what the pass is for. Its inputs:

- **The coarse-grained access model has no ADR of its own.** Its best statement is frozen at [archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md) § *The invariant* and § *Settled*. Decide what lifts into an ADR or a rule, and whether ADR-012 shrinks back to visibility once an access ADR owns "a profile is never an input to authorization".
- **008, 012, 013 and 015 each cover one facet of one model.** Should they stay separate ADRs or become one?
- **008, 009 and 013 carry dated amendment notes**, against `docs/adr/README.md`'s forward-facing discipline. Decide per file, and write any carve-out into the README. ADR-009's note may earn its place, since it stops sessions citing a withdrawn latency figure.
- **ADRs written before November 2026 are wordier than they need to be**, and the pass is a good time to reword them (Larry, 2026-11-12).

---

## Where pre-alpha sits

- **Pre-alpha, this file:** user-developers build data-bound multi-user apps, which they and we evaluate through personas. There is no real third-party end-user signup and no migration testing, since users have the wipe.
- **Alpha:** the publish path for real use, plus data migration. Writing migration code is easy. Testing it is the hard part, and probably needs Star branching (`tasks/icebox/nebula-branches.md`).
- **Beta:** automated testing, to near production-ready. Then production.

**Capture is where involvement and feedback meet.** Involvement runs from capture live (③) through the wipe (⑥) to the first invite. Feedback starts from the same capture, in fast-follow Items 17 and 19. No one is invited until capture is confirmed live.

**Pre-alpha users are Universe admins.** Larry invites each one and picks their slug and name beforehand. This shrinks the security story, because acting as anyone beneath you is not an escalation. The cleanup it leaves, dropping `AuthorizedActors` for admins-only, is [on-hold/delegation-hardening.md](on-hold/delegation-hardening.md).

**What that leaves unproven:**

- **Tenant isolation.** With every user a Universe admin, "pre-alpha worked" says codegen and in-app multi-user work. It says nothing about the boundary between Galaxies.
- **Cost.** A ceiling is set and Larry watches the Cloudflare dashboard. A spend line in the digest would be nice to have.

**A Durable Object class added, renamed or deleted is a migration forever.** That has been true since the first production deploy on 2026-06-26, and the wipe resets it only once.

## Building blocks that exist

The code is the authority for each of these, so do not re-derive them.

- **A superuser** holds an ordinary membership at the reserved platform scope, `PLATFORM_SCOPE`, which is the root of the scope tree. Dominion everywhere is then the downward rule applied from the top: one branch inside `isAtOrAbove`, and no special case at any call site. `superuser-front-door.ts` and `superuser-end-to-end.ts` drive it.
- **Impersonation** is one mint endpoint, reached from the client as `NebulaClient.impersonate`. It writes an RFC 8693 `act.sub` chain and is audited. Fine-grained checks key on the minted token's `sub` and never on `act`, so an impersonator gets what the person they impersonate has.
- **A galaxy-tier invite mints a membership at the galaxy and a second at its `.dev` workspace.** The invitee signs in at the galaxy, and one acceptance takes up both. The workspace membership's admin bit is the inviter's dominion verdict, so a peer's invite enrolls the invitee without it. See `issueInvites` in `packages/mesh/src/auth/auth-registry.ts`; `four-party-chat.ts` drives it.
- **Listing every user** is the Registry's job (`AuthRegistry`), the singleton that holds the global index from email to scope.
- **The passage step** is `requirePassage(name, claims)` in `packages/mesh/src/scoped-mesh-do.ts`, which `ScopedMeshDO` runs on every call. It is the one audit point on every scoped node, and what lets turn-log inspection and a support engineer read, write and administer anywhere with one identity.

## Open decisions

1. **Starter scaffold on invite.** Does the Universe invite also provision a starter Galaxy, so the first build takes no setup, or does the user create one as a Universe admin? Lean: provision it, since a non-coder should not hit a naming decision at first login.
2. **A second wipe between pre-alpha and alpha.** An option kept open, not a plan (Larry, 2026-08-24). Before it, stash each user's Workspace repo, which holds the code and the ontology's git history, and the codegen corpus: the Galaxy's `Message`s with their `codegen` value objects, the harvest ③ exists for. Then wipe and restore. Their `.dev` data is lost, and we say so up front. Identities are minted again on re-invite, and stamped attribution degrades to display-only. It eases the squeeze on structural work without licensing deferral, because every wipe spends user goodwill.

## Links

- **Engine design**, reference only: `tasks/reference/nebula-agentic-engine-design.md`. Dev and publish flows: `tasks/reference/nebula-dev-flows.md`.
- **Fast-follow**, picked up on demand after the core: [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md), where each item carries its own trigger. Outside-world connectivity has its own design file, [nebula-outside-world.md](nebula-outside-world.md).
- **Deferred out of pre-alpha:** `tasks/on-hold/`. Each file's status line says why it waits and what would bring it back.
- **The live harness.** Local runs use `apps/nebula/harness/`, through the `/live` skill and the `live.md` rule. Production is driven and read through `apps/nebula/harness/prod.ts`, with standing authorization when Larry asks; writes and deploys stay deliberate. Findings are in `apps/nebula/harness/FINDINGS.md`.
- **Turnstile is off in production** (`TURNSTILE_SECRET_KEY` is unset). The `AUTH_TURNSTILE_BYPASS_TOKEN` header exists for when it is turned on.

## Shipped

One line each. The archived file is the record, and the code is the authority.

Newest first. Where a build's own date was not recorded, the date is the day its task file was archived.

- 2026-11-11 — The agent posts as itself and acts for several people in one chat. A turn its Galaxy's reset cuts off is answered at the next post, and the agent asks whether to proceed; answering on wake is fast-follow Item 15 → [archive/nebula-agent-posts-as-itself.md](archive/nebula-agent-posts-as-itself.md)
- 2026-11-08 — `validFrom` is a resource's only version → [archive/resources-validfrom-is-the-only-version.md](archive/resources-validfrom-is-the-only-version.md)
- 2026-10-15 — A build reaches every Studio, which tells each one which build landed → [archive/nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md)
- 2026-10-14 — Every stored value is in a form a merge patch can address. Sending patches is fast-follow Item 14 → [archive/structured-clone-patches-small-and-exact.md](archive/structured-clone-patches-small-and-exact.md)
- 2026-10-12 — The `.dev` Star runs the last build's ontology, and its compiled row lives in the Galaxy's own storage. Where a published version's validator lives is fast-follow Item 4 → [archive/nebula-star-ontology.md](archive/nebula-star-ontology.md)
- 2026-10-11 — ⑤, the ontology history file, was iceboxed. During development the ontology's history is the file's git history → [icebox/nebula-ontology-history-file.md](icebox/nebula-ontology-history-file.md)
- 2026-10-09 — The Gateway routes a Client's call, and a call it refuses wakes nothing → [archive/mesh-gateway-routes-client-calls.md](archive/mesh-gateway-routes-client-calls.md)
- 2026-10-08 — Mesh is built on the scope tree: `@lumenize/mesh` took in what Nebula layered on it, and Resources ships beside it as `@lumenize/resources` → [archive/mesh-is-built-on-the-scope-tree.md](archive/mesh-is-built-on-the-scope-tree.md)
- 2026-10-08 — The build box runs `@cloudflare/computer` 0.4 under the `durable_object` scheduling policy, with its deps still baked into the image. No task file: commit `4c6e1d4`, measurements in [experiments/container-snapshot-deps/RESULTS.md](../experiments/container-snapshot-deps/RESULTS.md). Snapshots replacing the baked deps is fast-follow Item 11
- 2026-10-07 — A Client connects to its scope's node, so no Client needs a Gateway of its own → [archive/nebula-clients-connect-to-their-scope.md](archive/nebula-clients-connect-to-their-scope.md)
- 2026-10-06 — Calls to and from a Client behave like calls between nodes → [archive/mesh-calls-to-and-from-clients.md](archive/mesh-calls-to-and-from-clients.md)
- 2026-10-04 — The scope moved from a URL segment to a subdomain (ADR-021, ADR-022), with the certificate wait shown on Galaxy create. It also deleted `/create-star` and `createDevWorkspace`, so nothing creates a tenant Star with no members, and whether a stranger could claim one is no longer a question → [archive/nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md)
- 2026-10-04 — The test toolchain moved to `@cloudflare/vitest-plugin`, then every Worker to compatibility date 2026-10-01, which keeps a Galaxy turn in memory after its request has answered. No task file: commits `c2b04d2` and `53f2e94`; `packaging.md` § *Toolchain bumps* holds what outlives it
- 2026-09-28 — ④ Every Resources guard lives in the Resources plane. A subscriber sees what it can read and is told which nodes it cannot, on every kind of subscription → [archive/nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md)
- 2026-09-27 — Broadcast is core to every mesh node and delivers directly → [archive/mesh-broadcast-is-core-and-direct.md](archive/mesh-broadcast-is-core-and-direct.md)
- 2026-09-25 — A remote caller reaches only `@mesh()`-decorated members → [archive/mesh-entry-and-walk-gaps.md](archive/mesh-entry-and-walk-gaps.md)
- 2026-09-18 — Decided: a persona has no address, membership or cookie. Its tab gets a plain token with no `act`. Reversed on 2026-11-13: a persona is a real member, invited at an address its host spells, and its tab holds an impersonation token → [ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md) § *A persona's host*
- 2026-09-08 — Profile access control: acceptance is enforced at the mint, and the owner branch has no `act` clause → [archive/nebula-profile-access-control.md](archive/nebula-profile-access-control.md); [ADR-012](../docs/adr/012-global-profile-visibility.md) and `security.md` outlive it
- 2026-09-06 — ① The guidance file tree: a platform layer in code and a Galaxy layer in the Workspace, both read every turn → [archive/nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md); `studio-guidance.md` is the convention that outlives it
- 2026-09-03 — The turn-liveness heartbeat beats through the whole turn, and model output streams as it is written. No task file: `apps/nebula/src/turn-heartbeat.ts` and `model-stream.ts`; `calibration.md` §13 keeps what the build taught
- 2026-09-02 — Login prove-then-choose and the data-use notice, with `discover(email)` deleted → [archive/nebula-login-prove-then-choose.md](archive/nebula-login-prove-then-choose.md)
- 2026-08-30 — The Galaxy collapse and chat history UI. Generation capture became the `codegen` value object on each agent `Message`, the preview survives redeploys, and the ontology installs only by lazy pull → [archive/nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md)
- 2026-08-30 — Container vite on rolldown, with `unplugin-swc` for decorators; `vite.config.ts` says why the plugin is required
- 2026-08-30 — Compilers moved out of the Worker, with no bundle split → [archive/nebula-move-compilers-out-of-the-worker.md](archive/nebula-move-compilers-out-of-the-worker.md); `check-worker-graph.mjs` is the standing tripwire
- 2026-08-20 — The auth foundation, archived from 2026-07-13 to 2026-08-20: surrogate `sub` → [archive/nebula-auth-surrogate-sub.md](archive/nebula-auth-surrogate-sub.md) · identity data model → [archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md) · dominion vocabulary → [archive/nebula-dominion-vocabulary-rename.md](archive/nebula-dominion-vocabulary-rename.md) · passage and dominion from scope → [archive/nebula-passage-dominion-from-scope.md](archive/nebula-passage-dominion-from-scope.md) · registry route guards → [archive/nebula-registry-route-guards.md](archive/nebula-registry-route-guards.md) · invite → [archive/nebula-invite.md](archive/nebula-invite.md)
- 2026-08-20 — `Snapshots.recordedClaims`, the ADR-016 record; `identityKey`'s JSDoc in `snapshots.ts` carries the argument
- 2026-08 — `createGalaxy` bundles `{galaxy}.dev`; its JSDoc carries the rationale
- 2026-07-07 — The `/mint-narrower-token` escalation fix → [archive/rfc-act-chains.md](archive/rfc-act-chains.md); `security.md` pins the delegation invariants
- 2026-07-06 — Mesh continuation-only calls and `callAsync` → [archive/mesh-continuation-only-calls.md](archive/mesh-continuation-only-calls.md) · [archive/mesh-client-callasync.md](archive/mesh-client-callasync.md)
- 2026-07-04 — The DevContainer wakeup fix → [archive/nebula-container-wakeup-fix.md](archive/nebula-container-wakeup-fix.md)
- 2026-07-01 — Reactive AI chat → [archive/nebula-reactive-ai-chat.md](archive/nebula-reactive-ai-chat.md); its one deferral, the viewport window driver, is a [backlog.md](backlog.md) § *Nebula Studio UI* row
- 2026-06-30 — Parent-child query subscriptions → [archive/nebula-query-subscriptions.md](archive/nebula-query-subscriptions.md)
- 2026-06-30 — The data-use consent flag was removed, and no consent column exists anywhere → [archive/nebula-consent-flag.md](archive/nebula-consent-flag.md); `@lumenize/sql-migrations` → [archive/sql-migrations.md](archive/sql-migrations.md)
- 2026-06-29 — DevStudio data-plane extraction → [archive/nebula-devstudio-data-plane.md](archive/nebula-devstudio-data-plane.md)
- 2026-06-26 — The first production deploy → [archive/nebula-release-process.md](archive/nebula-release-process.md)
- 2026-06-24 — Studio UI served from a single origin → [archive/nebula-studio-vite-proxy.md](archive/nebula-studio-vite-proxy.md)
- 2026-06-24 — Local UI smoke, the `ui-smoke` Playwright lane → [archive/nebula-local-smoke.md](archive/nebula-local-smoke.md); [backlog.md](backlog.md) § *Testing & Quality* owns its `it.skip`s. `ui-smoke/smoke.test.ts` also drives the create-app flow
- 2026-06-23 — `onBeforeCall` downward dominion → [archive/nebula-onbeforecall-higher-admin-reach.md](archive/nebula-onbeforecall-higher-admin-reach.md)
- 2026-06-22 — The self-correcting codegen loop → [archive/nebula-codegen-loop.md](archive/nebula-codegen-loop.md)
