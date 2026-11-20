# Nebula Pre-Alpha Fast-Follow

**What this file is.** The work that follows pre-alpha's first invite, each item picked up when its trigger fires rather than on a schedule. [nebula-pre-alpha.md](nebula-pre-alpha.md) comes first, and nothing here jumps ahead of it. An item gets a task file of its own, drafted with `/write-task`, when it goes active, and this file then keeps its goal and a pointer. No task file is drafted ahead as a stub.

**Nothing here is done.** When an item is built it leaves this file: its archived task file, or pre-alpha's § *Shipped*, records it.

**Item numbers are handles other files cite.** They are assigned once and never reused, so a gap is an item that left. Item 7 became pre-alpha's personas work, built on 2026-11-14 ([archive/nebula-personas-are-real-members.md](archive/nebula-personas-are-real-members.md)), Item 8 was built as [archive/nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md), Item 9, a connected client that never re-checked its token, was fixed on 2026-09-03 (`4066b17`), and Item 17, reading a user's turns, became pre-alpha's ③ on 2026-11-18.

**Items 1 and 2 came from the first user-developer spec**, on 2026-07-02: Jennifer's [Luminize Almanac vision, requirements and data model](https://docs.google.com/document/d/1P_YF2qVwQSAFYvg43qCvj3Nc170zBkpBboG8kcjdBGc/edit) and her [UX brief](https://docs.google.com/document/d/10UZ5KaZJXG2MdaHTwA2UPGrFKM_daGDdJaSbg6wGeFo/edit). The question asked of them was what the spec teaches Nebula, not whether the spec is right.

**Not an item: spec drift across a user-developer's documents.** Jennifer's two documents contradict each other, photo-first required against text-first capture. Catching that is a question for Studio's coaching loop and needs its own framing; coaching covers it by hand during alpha. Revisit it when the Studio eval suite resumes.

## The items, by when they start

| When | Items |
|---|---|
| Now: the trigger has fired | 11 An R2 archive replaces the deps baked into the image |
| Before wrangler's support ends | 12 `cf` replaces `wrangler` |
| At the first invite | 19 The feedback loop · 20 Data-bound generation · 22 The model reports what misled it · 23 The preview's error channel |
| When a user wants to show their app to someone | 4 The prod ontology install path · 5 The published tier |
| With a query's sort, paging and limits, so a query's shape breaks once | 21 A query names the node it reads under |
| When Jennifer's app needs a reader who never logs in | 24 Visitors read what anyone may |
| When users ask, or a problem shows | 1 Media storage · 2 An app-branded assistant · 3 Outside-world connectivity · 6 Steering a turn mid-generation · 10 Studio drives the preview · 13 A person with no name · 14 Merge patches on the wire · 15 The wake check · 16 Replies, not edits · 18 The superuser join scenario · 25 The build checks templates |

## Item 1: User-app media storage (photos/blobs)

**Goal:** a generated app accepts, stores and serves media its end users upload, photos first, under the same orgTree access control as every other resource.

**Why:** the Almanac's atomic unit, an `Entry`, needs one or more photos, and Jennifer's spec says the app cannot exist without them. Domain experts think in photos, documents and artifacts more than rows, so media is likely table stakes for many apps.

**Open: whether this is fast-follow at all.** If media is table stakes it belongs with data-bound generation, or before the first invite. Decide at `/review-task`.

**What exists:** one platform bucket, `nebula-blobs` (binding `BLOBS`; the test worker gets `nebula-blobs-test`), whose only tenant is profile pictures, keyed `profile-pictures/{uuid}.{ext}`. `PUT /pictures` needs a bearer token and checks the bytes. `GET /pictures/{key}` is public and immutable, because a profile picture is a public field an `<img>` loads with no credential (`apps/nebula/src/profile-pictures.ts`). No app can call it yet.

**The shape, not yet designed:**

- **A platform capability, never raw R2**, so every app gets the same thing and none has R2 configuration of its own.
- **A photo is readable only by someone who can read the resource that owns it.** The sharing circles in Jennifer's spec map onto that directly.
- **`BLOBS` never gets a public custom domain.** Public R2 access serves any object by key with no reader check, so one leaked key would expose an access-controlled photo for good. If public blobs ever need serving directly, they move to a bucket of their own ([nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) § *Future state*).
- **Look for plumbing shared with resource history in R2** before designing fresh: the same bucket family, a different kind of object.

**Done when:**

- A generated app round-trips an end user's photo: upload, store, display.
- An end user who cannot read the owning resource cannot fetch the photo, by direct URL included.
- No app has R2 configuration of its own.

## Item 2: App-branded AI persona

**Goal:** the chat an app's end users see presents as the app's own assistant, with its own name, tone and limits, while staying the same orgTree-governed chat underneath. It still never reads what the asking user cannot, and nothing about the persona can change that.

**Why:** Jennifer named her app's assistant, "Gigi Kaizen", unprompted in her first spec, and gave it values: always gentle, never interruptive, no urgency language, no gamification. User-developers think of the embedded assistant as part of their product, not as Nebula's chat.

**The shape, not yet designed:**

- **The persona is data the platform's chat reads**, never code the app injects: a display name, tone guidance and value constraints. It adds style and never widens access.
- **The underlying model is never named.**
- **The tone and values come from the app's `docs/vision.md`**, the file the guidance tree seeds ([nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md) § *Design intent*). That is a second reader of one file, never a second store.

**Done when:**

- A user-developer names and styles their app's assistant from Studio.
- A persona instruction that tries to read data out of scope does nothing, in a test that can fail.
- Constraints from the spec, such as no gamification, visibly shape the chat's output.

## Item 3: Outside-world connectivity (`fetch` / email / search / webhooks / cron)

**Its design and phased plan are in [nebula-outside-world.md](nebula-outside-world.md).** Nebula builds a thin, secure substrate: a secrets vault, a server-side runtime for app code, an egress broker, an ingress router, a scheduler and a security library. Studio's agent then writes each integration, such as email, payments, Slack or search, as ordinary app code. The spikes are proven and mutation-checked, and the file waits on `/review-task`. Demand order is `fetch`, then email, then search, with secrets last. Item 19's inbound `claude@` email is its first real use.

## Item 4: The prod ontology install path

**Goal:** an ontology reaches a Star the Galaxy did not push to, with no install step per Star.

**Trigger:** the first pre-alpha user who wants to show their app to someone. It lands with Item 5, since a published Star needs its ontology and its `dist` at the same moment.

**Today every Star pulls lazily.** An operation pinned to a version the Star lacks asks its Galaxy for the current row with `getCurrentOntology()` and installs it. The answer lands in the Resources plane at `resourcesResults.onOntologyPulled`, behind a getter with no `@mesh()`. The Galaxy answers by kind of Star: `.dev` gets the last landed build's row, which the Galaxy keeps in its own storage, and every other Star gets the last published one, which does not exist until this item builds `publish()`. The pull beat a push on every change (Larry, 2026-07-25) because a Star converges only when a tab asks for a version it lacks, so a Star nobody uses costs nothing.

**What it must hold to:**

- **A tenant Star's source answers the published version**, never the Galaxy's current row, so an unpublished breaking row never reaches a tenant.
- **A breaking version that reaches a Star other than `.dev` migrates, and is never wiped.** Until migrations exist none reaches one, because nothing is published.
- **A publish promotes the build's validator and migration as the build compiled them**, with no second compile apart from the app's own code (Larry, 2026-10-12). [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md) § *Consequences* says why that risk is accepted.

**A candidate migration mechanism (Larry, 2026-10-11).** ADR-024 sets the direction: data moves forward only, by the user-developer's migration code running sandboxed, and a publish records the order migration needs. Under this candidate a resource migrates when a tab reads it at a newer version, in place, one published version at a time. Every snapshot records its `ontologyVersion`, so each resource knows where it stands. A `Deal` last written at v3, read by a tab on v5:

1. The Star runs the v3→v4 migration, then v4→v5, each in a sandboxed facet, since a migration is the user-developer's code, as the validator is.
2. It saves the result as a new snapshot, so history keeps the v3 one ([ADR-004](../docs/adr/004-snodgrass-temporal-resources.md)). The write is checked against the version it read and retried on a conflict ([ADR-005](../docs/adr/005-optimistic-concurrency.md)). A facet call is async, so the migration runs before the synchronous transaction, never inside it.
3. It returns the v5 resource.

A resource already at the tab's version comes back as it is. A tab on v2 reading the same `Deal` is behind, so it reloads; nothing migrates backwards. The `.dev` Star never migrates: it is wiped instead.

**What `publish()` records for that to work:**

- **An order of published versions**, since a version is a content hash and hashes do not order themselves.
- **Everything from one publish, for each published version:** the types, the compiled validator, the compiled migration from the previous published version, and the app's `dist`.

**Open:**

- **How it records them.** One candidate is a git tag per published version, since a version is already the ontology file's `git.hashBlob`, so git may hold the order with no second file. Another is a Galaxy compile cache, keyed by version, for each published validator and migration: a cache rather than the truth, recompilable from the tagged source. Larry asked on 2026-10-10 whether the history needs a file at all, or whether JSDoc and comments in `src/ontology.d.ts` carry the prose. A file, if there is one, is JSONC read with a parser the Worker already has.
- **Queries over resources nobody has read since a publish.** A query filtering on a field a migration adds will not see it on a row not yet migrated. The usual answer is a sweep after the install, with migration on read as the backstop.
- **What a git remote such as Cloudflare Artifacts would add.** History lives in the Galaxy's SQLite, and a remote would move it off the Durable Object, though under a lower cap ([1 GB on 2026-10-01](https://developers.cloudflare.com/artifacts/platform/limits/)). It would also give a bring-your-own-agent setup a real git server (`archive/nebula-studio.md` § *Enterprise BYO-agent*). Its `fork` could provision a scaffold with its history, so a scaffold upgrade becomes a merge, though whether `fork` copies the bytes is unmeasured. Trying one gets cheaper after the next toolchain bump, since Artifacts gained a local simulator on 2026-11-16 and a test would stop touching our account (`reference/nebula-dev-flows.md` § *Findings — Cloudflare Artifacts*). None of this is on this item's critical path (`reference/nebula-dev-flows.md`, Decision 6).

**Tenant-Star tests come back with it** (Larry, 2026-10-11). Until something is published a tenant Star has no ontology and runs no data operation, so the live tests of node invites and ADR-008's denied-node disclosure run on the `.dev` Star. When `publish()` lands, add them back on a tenant Star running a published version, plus a tenant Star moving to a newly published one.

**A reload keeps what the page had not saved, on every Star** (moved here from [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) on 2026-10-13; Larry deferred it until it can be solved for every Star at once). Resources holds an unsaved write only in memory: a value waiting out its quiet window (1 s after the last keystroke, 3 s at most), a write held while disconnected, and the one transaction in flight per resource. Its queue also forgets a write the Star refused for an old ontology version, while leaving the value on screen. A reload drops all of them, and on a Star with real users a publish that changes the types causes one. The candidate:

- **On `pagehide`, which fires on every reload, Resources saves each unsaved write to `sessionStorage`** under the Client's address, `alice.9f2c41aa`: its kind, its value and the `ifValidFromMatches` it names. A duplicated tab gets a fresh address, so it never reads another tab's writes.
- **The next load sends them again through the ordinary write path.** A write that landed before the reload names the same version again, so it is recognized and told that it committed (ADR-005).

Its reasons rested on `.dev` holding only test data, so re-derive them here:

- **A carried write must migrate forward before it runs** on a Star with real users, so the carry records the ontology version each write was made at.
- **It sits beside Mesh's durable outbox** ([mesh-1-alpha.md](mesh-1-alpha.md) § *Item 11: Durable calls*), which keeps a call already sent, where the carry keeps a value not yet sent. The two must not both resend one write.
- **A crash fires no `pagehide`.**

Rejected: the outbox as the whole answer, since it cannot hold a value in its quiet window or a write already refused ([on-hold/mesh-call-durable.md](on-hold/mesh-call-durable.md) § *Findings from the reload detour*). Also rejected: waiting for the queue to drain before reloading, since the queue has already dropped a refused write.

This item replaces [icebox/nebula-ontology-history-file.md](icebox/nebula-ontology-history-file.md), iceboxed on 2026-10-11.

## Item 5: The published tier serves one `dist` to every tenant Star

**Goal:** every Star but `.dev` serves its app's published build. One copy, `/dist-prod/`, serves every tenant Star, and a per-Star staged rollout is deliberately not a thing. Today a tenant Star's page answers 404 (`#serveBuiltApp` in `apps/nebula/src/galaxy.ts`).

**Trigger:** Item 4's. The two land together.

**How it works:**

- **A publish copies `/dist-dev/` to `/dist-prod/`**, beside the `.dev` Star's compiled row, so it ships the very build `.dev` runs, validator included (ADR-024). Both copies sit outside `/workspace`, where the model cannot write and git does not reach ([nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) § *Design intent*). Publishing is deterministic Galaxy code, so `/dist-prod/` needs no write guard.
- **The publish also commits the source, and a shipped ref points at that commit.** That is provenance. The serve never reads through git, and both tiers read through the same callback `serveApp` takes.
- **Nothing in the build is per-Star.** The scaffold builds with vite `base: './'`, `serve.ts` injects a `<base href>` for the path it serves under, `/` at the root of a Star's own host, and the Galaxy writes the ontology version a Star runs into each page's `nebula-scope` meta ([ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)). So one copy serves every Star's host, and a custom domain later needs no rebuild.

**A page outside Studio learns its build is stale by checking, on `.dev` and every published Star** (Larry, 2026-10-12; moved here from [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) on 2026-10-13). Every page carries the build version it was served, the digest of its `index.html`, in its `nebula-scope` meta. When the page comes back into view, or its connection comes back, it asks its host which build it would serve now. If that differs, it reloads through the app's `onShouldRefreshUI`, once per build version, behind a `sessionStorage` guard like the ontology reload's.

- **A persona's tab updates when someone switches to it.** A tab such as `mary--dev.crm.acme.lumenize.dev` is usually out of view while someone asks Studio for a build. A tab in view keeps the old code until it is next hidden and shown.
- **A page Studio frames leaves its reloads to Studio**, so pacing has one home.
- **The check reaches the Galaxy**, one Durable Object per app, so it grows with end users' activity and wants a cache in front of it before alpha has users.
- **Rejected:** the landing telling the `.dev` Star, which would then tell every Client it hosts. Mesh would need a way for a node to reach all its Clients, which only `ClientGateway.closeAll` does today, and a published Star would still need the check.

**A publish sends no reload push** (Larry, 2026-08-26). Correctness is the ontology version gate's job, and a publish that changes only code is picked up at the next natural reload, as on any website. A push that reloaded every live client at once would have each fetch `index.html` and its assets from the one Galaxy, so one added later ships with client-side jitter or a measurement behind it.

**Open: privacy of a user-developer's source.** If that demand appears, the design restarts here under two constraints (Larry, 2026-08-24): no cookies, and browsers send no `Authorization` on a document or sub-asset load. Together they likely mean the serve itself is never gated, since a published app's end users need `index.html` before they can log in.

**Not this item:**

- **Custom domains**, where an app's Stars are served at its own domain. [ADR-021](../docs/adr/021-every-scope-has-its-own-host.md) § *Deliberately open* holds them.
- **Scale**: an edge cache, the release herd, R2 as an escalation. Measured experience decides those, in [backlog.md](backlog.md) § *Future bigger things*.

## Item 6: Mid-generation chat UX — the two-stage arrival pipeline

**Goal:** a person can steer a turn while it generates, and the agent answers only the messages meant for it.

**Trigger:** the first multi-user session that hits single-flight in anger.

**Today a turn is single-flight.** A post that arrives mid-turn starts no turn of its own. The running turn's closing step, or the decision after it, answers it under the claims recorded on the post ([nebula-agent-posts-as-itself.md](archive/nebula-agent-posts-as-itself.md)). Larry judges that unacceptable beyond pre-alpha. Every human post also gets a turn, which costs more and is affordable with pre-alpha's few users.

**Larry's direction (2026-10-10): the agent hands long work to sub-agents and stays the chat's supervisor.** Its own turns then stay short, so a post during one waits seconds rather than minutes. A sub-agent acts under the permissions of whoever said yes to its work.

**The target is a pipeline with two stages:**

1. **Every message runs a fast classifier as it arrives**, cheap enough to block on, or in a short queue of its own. The old discriminator call was deleted on 2026-09-06, so this one is new.
2. **Only a "respond" verdict enters the codegen queue.** If the queue is empty the turn runs. If it is busy, the author is asked whether to interrupt the running turn or queue this one after it. Cancel lives on the streaming response, and must follow the container's teardown order: let the sync bracket resolve, `destroy()`, tolerate the 1006.

**Whether the agent responds — decided 2026-09-04 (Larry), deterministic first:**

1. **The agent is tagged → respond.** A tag is `@` and a participant's display name, matched case-insensitively against the chat's participants; no mention syntax exists yet. The agent's display name stays "Lumenize", and for the agent alone the matcher also accepts `luminize`, the common misspelling, and `agent` (Larry, 2026-10-07). The display name is configuration the app supplies, so it is Nebula's choice, not Mesh's.
2. **Someone else is tagged and the agent is not → do not respond.**
3. **Only the poster is present and nothing is tagged → respond.** "Present" is the chat query's live subscriber roster, which the Galaxy already holds, keyed by `sub` so a person with two tabs counts once. Personas never appear: they sign in to the preview, not to Studio's chat.
4. **Others are present and nothing is tagged → a cheap model decides**, from the roster and the last six or so messages with their bylines. It fails open to respond, since an unanswered request is the worse error in a building session.

**The classifier for case 4: start with Cloudflare's Clef** (Larry, 2026-10-10), picked over Jev as faster, more local and cheaper. The shape below was written for Jev, `typesafe/jev` (Larry, 2026-09-20), which answers typed questions about one state with a calibrated probability. It comes from [the model page](https://developers.cloudflare.com/ai/models/typesafe/jev/) and has never been run here, so check it against Clef's docs at pickup:

```ts
const { respond } = await env.AI.run('typesafe/jev', {
  state,  // the live subscriber roster + the last ~6 messages with bylines
  questions: {
    respond: {
      type: 'noul',
      instructions: 'A group chat in an app-building workspace. Nebula is the assistant.',
      criteria: {
        true: 'the newest message asks Nebula for something, or continues an exchange with it',
        false: 'the newest message is addressed to another person',
      },
    },
  },
})
// respond.noul is P(the message is for Nebula), 0-1 - branch on a threshold
```

- **Failing open becomes a threshold:** respond unless the probability is decisively low.
- **No dependency:** `env.AI` is bound already and carries the codegen model.
- **ADR-001 is not in play.** The questions say what to ask about one state, never the shape of our data.
- **Measure the calibration before trusting a threshold.** "Calibrated" is the vendor's word, and `calibration.md` §8 says a measurement outlasts a label.

## Item 10: Studio drives the preview — the model exercises the app it just wrote

**Goal:** the model runs the app it just wrote, clicking and reading it, to check its own work. Larry, 2026-09-09: *"The LLM is eventually going to need to drive actual `.dev` Star usage at some point to check its own work."* Today its whole self-check is one `build`, whose steps are the ontology, an advisory type check, the container and the preview. It has never run the app, so it cannot see whether a button works, data loads or a denial renders.

**Trigger: not until both cheaper answers have shipped and a gap remains.** Most of the motive is answered more cheaply:

- **Does the permission model behave?** Personas answer it through the data plane, with no work on the page.
- **Why is the screen blank?** The preview's error channel answers it (§ *Item 23: The preview's error channel*): the model reads the app's log tail, which probably answers "blank" better than a click driver.

If the model still cannot close a loop it should, real turns will by then say what it needs to address on the page.

**The topology has to be re-derived first.** The research below assumed a preview on Studio's own origin, where Studio's page reaches the frame's document through `iframe.contentDocument` and nothing is injected into the app. Since 2026-10-04 the preview runs on the dev Star's own host ([nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md)), so Studio cannot reach it. The engine would have to run inside the preview page, shipped with the scaffold, with the mesh carrying commands where Chrome's DevTools protocol would. The model wrote the app it would be driving, so that is a trust surface, not merely a capability.

**Buy the engine, don't build it.** Playwright's selector engine addresses an element as `role=button, name="Add todo"`, the notation the model knows from training.

- **`@vitest/browser`'s `./locators` packages it for use in a page**, MIT, and is already a transitive devDependency. Its `getBy*` queries and `filter` and `nth` run synchronously in the page; its actions, such as `click` and `fill`, hand off to Playwright, which a page does not have. It also exports `convertElementToCssSelector`, which turns an element into a stable selector.
- **Take the engine, not `@vitest/browser`.** That module imports the vitest runner's browser context and pins vitest exactly, which would make a vitest bump a product change. `ivya` is the same engine published on its own, and the likely buy; its license, size and pins need a spike.

**What is not free:**

- **Actions.** Hand-rolled dispatch, or `@testing-library/user-event` (MIT), since a naive `.click()` misses focus and pointer events and ignores `disabled`.
- **Knowing the app has settled.** `@testing-library/dom`'s `waitFor`, which polls with a MutationObserver.
- **Screenshots.** Page script cannot rasterize a document, so this needs `snapdom`, `modern-screenshot` or `html2canvas` (all MIT), which approximate. Decide first whether "blank screen" can be answered from structure alone.
- **The glue:** the mesh continuation, the loop tool and its guard, and the policy on what the model may address.
- **Not axe-core**, whose MPL-2.0 license is not on `workflow.md`'s permissive list.

Every dependency here needs Larry's approval. Selector generation in the style of `@medv/finder` is well under 1,000 lines, so it is copied with attribution rather than installed. All of it would ship in the preview's bundle rather than the Worker's, and whether it ships only on `.dev` is part of the re-derivation.

## Item 11: An R2 archive replaces the deps baked into the build-box image

**Goal:** the image stops carrying dependencies. It holds the toolchain only, Debian, Node, computerd and the compiler under `/build`, and changes only when the toolchain does. A Galaxy's whole `node_modules` is one `tar.zst` in R2, named by the hash of its lockfile, and the build box unpacks it to `/node_modules` before vite runs.

**Trigger: fired, and nothing blocks it.** The experiment behind this design ran on `apps/nebula`'s own wrangler and compatibility date. The next step is the task file, drafted with `/write-task`. [experiments/container-deps-r2/RESULTS.md](../experiments/container-deps-r2/RESULTS.md) holds every number below and is the authority until then. The outline at the end of [experiments/container-snapshot-deps/RESULTS.md](../experiments/container-snapshot-deps/RESULTS.md) still holds for what gets deleted, with the archive in place of the snapshot.

**How it works:**

- **The archive is named by what it holds:** `deps/<platform>-<lockfile hash>.tar.zst`, where the platform is the Node major and the architecture. Every Galaxy that has added no package shares the scaffold's archive, and Galaxies that added the same packages at the same versions share one too. An image change that keeps the platform invalidates nothing.
- **The container reaches R2 through the Worker, never the internet.** `interceptOutboundHttp` sends requests for a made-up host to a WorkerEntrypoint holding the R2 binding, registered before every start. The build keeps `enableInternet: false`, and no credential enters the container.
- **The download starts with the box.** The turn's first `write_file` already starts the container, and the fetch starts with it, so generation covers it. Measured turns ran 7.5–38 s from the first write to the build, and the whole tree fetched and unpacked in about 5 s. A `buildNow` with no turn in front of it waits those 5 s.
- **A lockfile with no archive yet is installed once.** A container that can reach the registry runs `npm ci`, and the build goes on with that tree. Packing and uploading follow once `dist` has gone back, so nobody waits on them. That install is the only step that reaches the registry.

**What it buys:**

- **No curated dependency list baked into `apps/nebula/container/Dockerfile`.**
- **A generated app can import a package the scaffold does not carry.** Today it can import only `vue`, `lucide-vue-next` and `@lumenize/resources/frontend`, because the build job installs nothing, and `apps/nebula/platform/AGENTS.md` § *Rules for the code you write* tells the model so. That line goes when this lands (Larry, 2026-11-17: keep the ban until then).
- **Extras install once per lockfile change, not once per build.** On vite 8 the install is the largest term in a build with extras (`experiments/computer-vfs-build/RESULTS.md` § *ROUND 5*).
- **The `@lumenize` frontend packages arrive through npm instead of a `COPY` into the image.** That needs no release to npmjs.org: npm installs from a tarball URL our own Worker serves, and the package then sits in the lockfile like any other, so it is part of the archive's name.
- **A deploy that changes the image leaves every Galaxy's dependencies valid.** A snapshot would have restored the old image until each Galaxy made a new one.

**What the design has to handle:**

- **Offline, a DNS lookup hangs 56 s before it fails.** Any step in the build that resolves a hostname waits a minute, with nothing in its output to say why. npm's update notifier did, through `npx`; Nebula's job spawns `vite` directly. A package a user-developer adds that looks up a host would do the same.
- **An install inside a deployed container runs after `/` is handed back to root.** Otherwise swc's postinstall cannot load its native binding and installs `@swc/wasm` as a fallback.
- **The intercept is registered on `ctx.container` before `@cloudflare/computer`'s backend starts it.** The experiment drove `ctx.container` directly, so how the two meet is unverified.
- **Each new lockfile's upload is container egress**, about 65 MB, inside the 1 TB a month the plan includes. Downloads cost no egress, and intercepted calls are not Worker requests.
- **Nothing deletes an archive no Galaxy uses any more**, so the bucket needs an R2 lifecycle rule.
- **The scaffold has no committed lockfile** (`tasks/backlog.md`, the row on the container app's missing lockfile), and the archive is named by one.

**Rejected:**

- **Container snapshots, one shared and one per Galaxy**, this item's plan until Larry moved it to the archive on 2026-11-18. A Galaxy's own snapshot restored in 0.5 s and built in 6.5 s, against 10.9 s for the archive. But a snapshot carries its image, so after every deploy that changes the image it restores the old one until each Galaxy makes a new snapshot. It also needs a handle and an image digest per Galaxy, expires 30 days after its last restore, and has no announced price past the beta.
- **An R2 FUSE mount of `node_modules`.** A build on an s3fs mount was killed at 15 minutes, against about 5 s on local disk, because a build makes thousands of filesystem lookups and each one became a round trip to R2.
- **Only the extras from R2, over a baked scaffold.** It unpacks in about 2 s and uploads a third as much. But npm places an extra's own dependencies by the tree it was installed into, so its archive is valid only over that exact scaffold, and the curated set stays in the Dockerfile. It is the optimization to add if the whole-tree download ever shows in a measured turn or in `buildNow`.

## Item 12: `cf` and `cloudflare.config.ts` replace `wrangler` and `wrangler.jsonc`

**A toolchain move with a deadline, added 2026-10-08.** Cloudflare launched `cf` in open beta on 2026-09-28 ([launch post](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)). When the beta ends, Cloudflare ships a last wrangler major that points at `cf`, then maintains wrangler for 18 months. Until a task file exists, `cf`'s source is the authority (`cloudflare/cf`, `packages/cli/src/commands/`).

**Goal:** `apps/nebula` declares its Worker in a typed `cloudflare.config.ts`, and our scripts, the `/live` harness and the vitest-plugin lane all read it instead of `wrangler.jsonc`.

**Trigger: a deadline, not demand.** The 18 months start when the beta ends. The first step is one spike, any time after pre-alpha: build `apps/nebula`'s Worker in `experiments/` with the Cloudflare Vite plugin and `unplugin-swc`, then call a `@mesh()`-decorated method on it. If the decorators survive, what is left is cost.

**What it buys:**

- **`apps/nebula/scripts/local-config.mjs` goes away.** It builds a local stack's config by commenting `routes` out of `wrangler.jsonc` with a regex, and `containers` too for a boot without Docker. Inside `defineConfig(({ mode }) => …)` each is a check on `mode`.
- **The config type-checks.** Bindings come from typed helpers such as `bindings.durableObject(…)`, so an agent editing the file gets the language server's errors: ADR-001's bet, applied to config.
- **Every operation in Cloudflare's API becomes a command**, about 3,000 against wrangler's 280, with JSON output by default and `cf cli search` to find one from a sentence.

**What blocks it (checked 2026-10-08, `cf` 1.0.0-beta.13 and wrangler 4.147.0): our `@mesh()`-decorated methods under the Vite build.** `cf` builds with the Cloudflare Vite plugin, and Rolldown passes TC39 decorators through untransformed while still exiting 0; Oxc's transform is still an open issue, oxc-project/oxc#9170. Both UI surfaces already carry `unplugin-swc` for this, but nobody has measured it on the Worker's build. Until someone does, `cf` hands a Worker that needs esbuild back to wrangler for dev and deploy, which is the path the 18 months run out on.

**What it costs:**

- **The `/live` harness is built on `wrangler dev`.** `drive.ts` boots one per scenario, reads its output, and fingerprints the tree it reloads on save. A Vite dev server changes all of that, so the switch ends with a `drive.ts all` sweep and a deployed pass.
- **A second package pins `miniflare` exactly.** On 2026-10-08 `cf` pinned `5.20261006.0-alpha` and `@cloudflare/vitest-plugin` pinned `5.20261001.0-alpha`. From then on the two are chosen together, or local dev and the vitest-plugin lane run different workerd builds (`packaging.md` § *Toolchain bumps*).
- **`critical.md` is written against wrangler.** Its `Env`, compatibility-date and secrets rules name `wrangler types`, `wrangler.jsonc` or its `vars`, and each changes with the format.

**Not blockers, though both were reported as blockers at launch:**

- **Type generation.** `cf workers types` writes `.cloudflare/types/index.d.ts` from `cloudflare.config.ts` alone, runtime types included, so `npm run types` has a direct replacement.
- **Secrets.** `wrangler secret put --name <worker>` needs no config, and `deploy-test.sh` already passes `--name test-nebula`; only the hint `deploy.sh` prints leaves it out. `cf` writes Worker secrets too, through its generated `workers secrets update` and `bulk` commands (cloudflare/cf#6).

`cf` cannot delete a Durable Object namespace, so `workflow.md` § *Experiments* keeps its rule to delete experiment Workers from the dashboard. That touches experiment cleanup, not adopting `cf`.

## Item 13: A person with no name is asked for one

**Goal:** someone whose Profile has never been written is told their name is missing, and asked for it. Moved here from pre-alpha on 2026-10-09 (Larry), because nobody in pre-alpha reaches it. A never-written Profile answers with the empty profile and a fixed never-written `eTag`. A page watching it subscribes again at its next new socket, or at once after its own write ([archive/mesh-gateway-routes-client-calls.md](archive/mesh-gateway-routes-client-calls.md), its D5 and D7).

**Triggers, either one:**

1. **Shared pages lets an app run its own login page that collects no nickname** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *Shared pages*). Real people then reach a generated app without passing our consent card, and the rare case becomes the common one. That item could instead require a nickname on that path, which keeps this one dormant.
2. **A pre-alpha user sees a blank name.**

**Who can reach a never-written Profile today, and what covers each:**

- **A real person names themselves before their first session.** Both consent surfaces, `MagicLinkScreen` and `ConsentModal`, keep Accept disabled until a nickname is filled in (`canAccept` in `apps/nebula-studio-ui/src/auth/home-logic.ts`). Both run on the platform host, so a tenant user of a generated app passes one too.
- **A person whose display-name write failed at consent** is asked again by the next consent card they see. `settleAcceptance` logs the failure and carries on, and the next card reads the empty Profile and holds Accept until a nickname is typed. That card comes at their next magic-link login, within the refresh cookie's 30 days, or with their next invite.
- **A persona is named from its own tab:** the agent asks that tab to set its Profile's name ([archive/nebula-personas-are-real-members.md](archive/nebula-personas-are-real-members.md) § *Design intent*). A persona never sees Studio, only the generated app.
- **The harness accepts with a nickname**, as the consent screen does. The personas build carries that change.

**The design, as far as it got:**

- **Studio:** on finding its own profile never written, it opens the profile form, with *Remind me later*, which asks again on a later visit. Saving it is the first write. The person's own page shows it at once, and another page watching that profile picks it up at its next new socket or reload.
- **Generated apps: undecided, on purpose.** Either the guidance teaches the model to ask, or the scaffold ships the prompt as our code. Since 2026-11-14 `website/docs/nebula/api-reference.md` documents the write, `client.patchMyProfile`, and `define-the-cast` uses it to name a persona. Nothing yet has a generated app ask a real person for a name.
- **If an empty byline is ever reported, write the Profile earlier**, before anyone else reads it. Studio could require a name on the way into the chat rather than offer *Remind me later*, and the codegen model could then be taught the same. A Client that re-asks on a timer was weighed and declined (Larry, 2026-10-09).

## Item 14: A change travels as a merge patch, not a full value

**Goal:** the org tree's fanout and a resource's reads send a patch from the version the client holds, where today they send the whole value. The stored format it needs was built on 2026-10-14 ([archive/structured-clone-patches-small-and-exact.md](archive/structured-clone-patches-small-and-exact.md)): Larry made the format a pre-alpha must-have and sending patches fast-follow. The plan, the version chain it keys on and its open questions are in [on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md), which becomes this item's task file when it goes active.

**Trigger:** a full resend that costs something a user notices, such as a large org tree on every grant, or a resource read that usually comes back unchanged. A third consumer is the MCP Events prototype on [backlog.md](backlog.md)'s MCP Events row, which would deliver a resource change as one patch.

**The protocol carries `diff`'s answers** ([archive/structured-clone-patches-small-and-exact.md](archive/structured-clone-patches-small-and-exact.md) § *Design intent*, rule 8): nothing changed, a list of patches applied in order, or the full value, which goes out as the existing full-snapshot message. A patch does not keep a plain object's key order, so a patched copy and a fresh read can order its keys differently.

**A stored value can travel without being decoded and re-encoded (Larry, 2026-10-14).** Today a read decodes `Snapshots.value`, wraps it with the snapshot's `meta`, and Mesh re-encodes the whole message, once per subscriber on a broadcast. Measured in Node on a 41 KB value: 0.12 ms to decode and 0.18 ms to re-encode per message, against about 0.001 ms to splice the stored text in. The direction is a structured-clone tag marking a nested encoding whose `$ref` pointers are rooted at itself, which the format task made true of every stored value. The server then passes the stored text through, and only the client decodes it. `JSON.rawJSON` cannot do the splice, since it accepts only primitive JSON text. The same stored text is what an MCP Events payload would carry as an opaque value.

**A broadcast is encoded once, and every subscriber gets the same frame (Larry, 2026-10-14).** Resources already sends every reader of a resource one continuation (`#broadcast` in `packages/resources/src/resources.ts`). Mesh's `broadcastShared` then makes one `lmz.call` per target, and each call runs `preprocess` on its own chain, so the same snapshot is encoded once per subscriber. Encoding the chain once and handing every target the result is a Mesh change. A subscription assumes its client is current: a client whose version does not match the base of what arrives sends a read with its last version, and gets back a patch bridging the versions it missed. Every write is a snapshot, so the base a lagging client names is stored while it is in hot storage.

**Consider: an order column, so the org tree rebuilds in creation order** (deferred here by Larry, 2026-10-14). `#buildState` in `packages/resources/src/org-tree.ts` reads `Nodes`, `Edges` and `Permissions` with no `ORDER BY`, so rows arrive in primary-key order and a new random `nodeId` lands mid-Map. A patch keeps a Map's order ([archive/structured-clone-patches-small-and-exact.md](archive/structured-clone-patches-small-and-exact.md) § *Decisions*), so each new node then sends the full tree. What was weighed:

- **The column.** A monotonic ULID from `ulidFactory({ monotonic: true })`, which Larry approved adding to `packages/resources` as a dependency. It needs no read on insert and survives a Star being cloned or imported. `seq = MAX(seq) + 1` and ordering by `rowid` were weighed and rejected.
- **The catch.** Ordering `Permissions` rows by their own column leaves the outer `permissions` Map following each node's earliest surviving grant, so revoking that grant can reorder it and resend the whole tree. The state wants reshaping too, for example one flat Map keyed by `nodeId:sub`, as edges already are.
- **It may not be needed.** If the tree becomes one Resource row (Option A in [on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md)), the column is never read.

**Answered: SQLite's `json_patch` against our `applyMergePatch`** where the server applies a patch it receives (asked by Larry 2026-10-14, measured deployed 2026-11-15). `json_patch` applies a narrow patch about twice as cheaply, but the lead is gone once the write needs the merged value back in JavaScript to validate or broadcast it, and a wide patch is far slower in SQLite. `diff` stays in JavaScript. [on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md) § *Applying and building a patch* has the conclusions, and `experiments/merge-patch-sql/RESULTS.md` the tables.

## Item 15: The wake check — a post no turn took up is answered on wake

**Goal:** when a Galaxy wakes and finds a person's post that no agent message answers, it schedules a turn that reads the thread and takes the post up, without waiting for someone to post again. The turn can do the work, because a post is stored with the claims its write carried and a turn runs under them ([nebula-agent-acts-on-a-posts-record.md](archive/nebula-agent-acts-on-a-posts-record.md)). [nebula-agent-posts-as-itself.md](archive/nebula-agent-posts-as-itself.md) specifies it as its item 6; the question that bounds it, that file's Q3, is the list below, and it moved here on 2026-11-11 (that file's D19).

**Trigger:** evictions that leave posts waiting long enough for someone to notice during pre-alpha. Larry, 2026-11-11: if it proves a problem, it moves to the top of this list.

**Until then:** an evicted turn's post shows as waiting in Studio, and the decision after the next post's turn can take it up and work it.

**What the turn-stored build settled, for a turn that has a row** ([archive/nebula-turn-stored-round-by-round.md](archive/nebula-turn-stored-round-by-round.md)). The Galaxy's `onStart` continues a turn an eviction cut off, whatever runs its constructor: a Studio reconnecting, a page load, an alarm, a teardown. A turn that cannot go on ends in a line of ours. Our own code writes the post that ends a turn whose run passed the deadline or threw, and ends a turn whose model call was cut off twice at one round. The deadline frees the latch by ending the turn and deleting its row.

**What is left:**

- **A post no turn had taken up** when the Galaxy went away, a decision an eviction cut off between turns among them. It waits until someone posts again.
- **A cut-off turn on a Galaxy nothing reaches** waits until something runs its constructor; an alarm could continue it sooner.
- **What reconciles on wake.** An eviction skips the run's `finally`, so a build box can outlive its build. On wake, destroy any running container no build owns, and name the Workspace's uncommitted changes against the last commit, so the next turn, or the person, starts from something named.

**A restart does nothing for a half-finished Workspace** (Larry, 2026-09-06). What makes one survivable is that the commits in the Galaxy's git and the messages in the chat are both durable, so the person can say "fix it" and the model sees what landed and what did not.

## Item 16: Studio replies to a message, and never edits one

**Goal:** a person who wants to correct or build on an earlier chat message replies to it, and Studio shows the reply with the message it answers. Studio offers no way to edit a message, its author's own included (Larry, 2026-11-12).

**Why not editing.** Any chat member may `put` any message, since a `put` needs only `write` on `chat`. An edit of an agent message makes it the editor's post by its record: it stops answering what it named, so that post waits again, and the edited message starts a turn under the editor's claims ([nebula-agent-posts-as-itself.md](archive/nebula-agent-posts-as-itself.md) § *Build notes*, and `waitingPosts` in `apps/nebula/src/participants.ts`). That is traceable and gives nobody claims they lack, but a typo fix re-runs work.

**Today:** Studio has no edit control, so an edit comes only from code calling the client API. A message already carries `replyTo`, which the agent's messages set.

**Also fixes:** the original poster's page hanging on *Studio is thinking…* after such an edit. `postAnswered` turns false again when the answer's snapshot stops recording the agent, and `App.vue`'s watch handles only the change to true.

**Open:** whether the affordance is a reply, which sets `replyTo` on the new post, or a quote, which copies the earlier message's text into it. Larry leaned toward the reply.

**Not this item:** refusing the edit below Studio. `tasks/backlog.md` § *Nebula* has that row, *Only a message's author, or nobody, can change it*.

## Item 18: The superuser join scenario

**Goal:** one `/live` scenario that chains a superuser's login, Home, a pre-alpha user's host, and impersonating that user there. That chain is a coaching session: Larry signs in as himself, opens a user's app, and sees it as they do.

**Trigger:** a coaching session that cannot get from Home to a user's host as that user, or a change that touches both login and impersonation.

**A coach's post runs its tab code in the user's own Studio, never the coach's.** `run_in_tab` finds a tab by the `sub` its post records, which under impersonation is the user's, and the coach's impersonating client shows no preview. So the agent builds a cast or sample data for a coach's post only while the user has Studio open, and is told there is no tab otherwise (`run-in-tab.test.ts`). If the coach should watch it run, this item decides what "Me" is in a coach's Studio and how a post finds the tab that wrote it, which nothing records today.

**Each half is already driven.** `superuser-front-door.ts` drives the front door, where a superuser arrives through the ordinary login with no scope, and `impersonation-lifecycle.ts` drives impersonation. Nothing yet proves the two compose. If the scenario turns up gaps, they earn a task file then.

**Moved here from [nebula-pre-alpha.md](nebula-pre-alpha.md) on 2026-11-12 (Larry).** Until it lands, the first coaching session is the first run of the whole chain.

## Item 19: The feedback loop

**Goal:** Larry hears what pre-alpha users run into without asking each of them, so the near-daily conversations start from what they actually did. Moved here from [nebula-pre-alpha.md](nebula-pre-alpha.md) on 2026-11-12 (Larry), with the rest of the work that waits for users.

**Trigger:** the first invite.

**In rough build order:**

- **Inbound `claude@lumenize.io` lands in a durable store**, R2 or a Durable Object, readable through the Cloudflare MCP. It is the first real use of [nebula-outside-world.md](nebula-outside-world.md)'s inbound email.
- **An in-Studio feedback button, v0**: "this broke" or "I wish", written into the same store. The store also records when a user undoes or abandons a turn, once Studio has an undo. A turn the user corrected or abandoned feeds the platform's own guidance too ([on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md) § *Part B*). The app's own conventions need no such signal, because the transcript in the prompt lets the model see a correction as it arrives.
- **A daily digest by 7:30am, v1.** A cron gathers yesterday's turns and behavioural signals, a judge model scores them, and the result lands in the store. A scheduled morning Claude Code session then writes the digest for Larry, with a spend line and suggested prompt changes that are reviewed and never applied automatically. Build it only after reading turns by hand (pre-alpha's ③) shows what is worth automating.

**Open: how the digest is phased.** Manual inspection first and the automated digest later, which is the lean, or the 7:30am pipeline up front.

## Item 21: A query names the node it reads under, and its permission check is one look at that node

**Goal:** every query carries a required node, and the plane checks `read` on that node once, before it reads anything. Permissions flow downward in an orgTree, so a caller with `read` there has it on every descendant, and no result's node needs a look of its own. Larry built this in an earlier orgTree system and optimized it hard there (2026-11-18).

**Today:** `QueryDescriptor` is `{ typeName, filter, allowScan? }` and names no node. `#evaluateQuery` in `packages/resources/src/resources.ts` runs the filter over every resource of the type on the host, and `OrgTree.evaluatePermissions` then climbs the tree for each result's node. [archive/nebula-turn-stored-round-by-round.md](archive/nebula-turn-stored-round-by-round.md) § *Phase 1* makes that one climb per distinct node, and stops there.

**It is a breaking change, which is why it is an item and not a backlog row.** A required field changes `QueryDescriptor`, the query hash, every query a generated app has written, and the docs the model reads (`website/docs/nebula/resources.md`, embedded as `.platform/docs/`).

**The query itself has to change, not only the check.** A query under a node must return only what sits at that node or below it. It can do that either way:

- **Add the descendants to the query's own clause.** The older system found every descendant node, up to a limit set by how long an `OR` clause its database allowed, and added that list to the provided query. Past the limit it could not answer.
- **Run the query once for each descendant.** Larry's lean for an embedded database such as SQLite, where a query is a local call and not a round trip. It has no clause limit to hit.

**What running it per descendant has to settle:**

- **An index that leads with the node.** `Snapshots` has `idx_Snapshots_current` on `(resourceId, validTo)` and nothing on `nodeId`. A query per descendant is cheap only if each one can look its node up.
- **Order and the cap across the per-node results.** Today one statement orders by `validFrom` and stops at `QUERY_RESULT_CAP`. Many statements have to be merged into that order, which is the same work sort, paging and limits need. That is why this item starts with them.
- **How many bound parameters one statement may carry on a Durable Object**, if adding the descendants to the clause is weighed at all. Not checked.
- **What becomes of `deniedNodes`.** ADR-008 has a subscriber told which nodes hold results it cannot read. A query scoped to a node the caller can read has none to report, and one scoped to a node it cannot read is refused whole. Whether a caller with `read` on only part of a subtree asks at each part, or is told what it missed, is the open question.

**Trigger:** the work on a query's sort, paging and limits ([backlog.md](backlog.md) § *Nebula*), so that a query's shape breaks once.

## Item 22: The model reports what misled it

**Goal:** a codegen tool, `report_finding`, that the model calls when a doc misled it or an API misbehaved. The finding rides the turn's agent `Message`, so it joins the turn record pre-alpha's ③ reads. It stays inside the tenant, the digest removes duplicates, and a person reads it before anything reaches a public tracker.

**Trigger:** the daily digest (Item 19), which files what a person approves. Moved here from pre-alpha's ③ on 2026-11-18: the same doc gaps recur, so a few weeks unrecorded lose little.

- **It never files a GitHub issue from inside a tenant's Galaxy.** That would cross the tenant boundary carrying text someone may have injected, and its likeliest failure is pasting a user-developer's ontology into a public issue.
- **Its parts have different homes.** The record field rides the `Message`. The filing a person approves belongs to the digest. The instruction telling the model when to report is guidance, and goes where `studio-guidance.md` places it.
- **A broken link in the platform guidance is not its job.** That tree's generator resolves every link at build time and fails on a bad one.

## Item 23: The preview's error channel

**Goal:** a user-developer says "the preview screen is blank", and the model's first move is to read the app's log tail. Its first consumer was the personas work ([archive/nebula-personas-are-real-members.md](archive/nebula-personas-are-real-members.md)), where a denied persona tab and a broken one look the same without logs. That work built `run_in_tab`, the tool the model reads a tab with, so this item keeps a buffer and adds no tool of its own.

**Trigger:** the first invite. Moved here from pre-alpha's ③ on 2026-11-18.

- **`@lumenize/debug` gains a second callback: filtered by `DEBUG`, and added to console output.** `setDebugSink` exists, but it is for tests: it bypasses the `DEBUG` filter and replaces console output. Production wants the opposite of both. A second slot beats a flag, since neither behaviour is then re-derived at the call site and no sink has to repeat the filter.
- **The client factory installs it**, as it already starts `answerRunRequests` (`packages/resources/src/frontend/create-nebula-client.ts`). The factory is vendored into the build-box image, so every build takes the current one, and an app created before this lands gets the hook at its next build. The scaffold's `nebula.ts` is written once per app, so a hook installed there would never reach an earlier app.
- **An entry carries the persona slug, decided before the buffer is written.** Several previews can be open at once, so an untagged tail is several streams interleaved. Tagging is cheap at the write and cannot be recovered afterwards.
- A later tool that lets the model widen its own `DEBUG` filter adds to this and is not owed now.

## Item 24: Visitors read what anyone may

**Goal:** someone who never logs in reads what an app grants to `anyone`. Jennifer wants people to see her app's calendar from a link, with no login (raised 2026-10-02). An app's own login page needs the same thing to show the app's name and picture before anyone signs in. Moved here from [backlog.md](backlog.md) on 2026-11-18.

**Trigger:** Jennifer's app needs a reader who never logs in.

**What it builds on.** [nebula-accounts-and-apps-have-names.md](nebula-accounts-and-apps-have-names.md) adds `anyone` as a grantee, which covers every caller with passage into the host. A visitor is a caller with passage and no membership, so this item widens who `anyone` covers and adds no second kind of grant. That file's D5 says why `anyone` is neither a permission tier nor a visitor's `sub`.

**What it has to answer:**

- **The token.** Minted with no login, so the mint stays off the singleton (ADR-018) and resists being farmed. Its `aud` is the scope its host spells, as ADR-022's is, and it never carries `scopeAdmin`. Passage then runs upward from the host, as for any plain member, and dominion is none. Its `sub` names its kind, the way the agent's `agent:lumenize` does, and is random per visitor so visitors stay apart in rate limits and traces.
- **Read-only by construction.** A visitor holds no grant of its own and no dominion, and `anyone` holds only `read` (the names file's D7). If every write a mesh call can make passes a grant or dominion, a visitor writes nothing and the door needs no check of its own. Confirming that claim comes first.
- **The tree.** A tree subscription checks only passage today (`subscribeTree` adds no check of its own), and ADR-008 opens the tree to members. A visitor has passage, so the tree's read needs a check that the caller is a member.
- **Profiles.** ADR-012's trust rests on its clause that the mesh admits no anonymous caller. Decide whether a visitor holding a `profileId` reads its public fields, and rewrite the ADR either way. Every logged-in caller already can, so the Profile needs no `anyone` grant, only this decision.
- **Who `anyone` covers, said where it is granted.** The names file lets an admin grant `anyone` `read` at any node (its D7), and its guidance says who that covers (its DI12). Once visitors exist, `anyone` includes people who never logged in, and that guidance has to say so.
- **Abuse.** No mesh call is rate limited today (`archive/nebula-scope-moves-to-subdomain.md` § *Decisions*), on the premise that every caller holds a token naming them. A visitor breaks that premise. A visitor only reads, and a read costs a thousandth of a write, so the risk is load on one Star's object more than a bill: one object serves on the order of a thousand requests a second (ADR-018).
- **Where they connect.** A visitor's socket sits on the Star its page's host names, beside every member's, and adds to that Star's load (2026-10-06, `nebula-clients-connect-to-their-scope`).

## Item 25: The build checks templates

**Goal:** the build's type check catches a mistake in a generated app's template, and in the props one component passes another, the way `vue-tsc` does. Today `checkVueSfc` (`apps/nebula/container/compiler/sfc-check.ts`) runs tsc over each `.vue` file's `<script setup>` and nothing else, and types every imported `.vue` as `any`.

On 2026-11-20 a copy of the scaffold got these mistakes: `{{ name.toUpperCas() }}`, a click handler handed the event where it takes options, a string bound to a `number` prop, and a required prop left out. `checkVueSfc` reported none of them, though it did report a type error put in the script block. `vue-tsc` 3.3.14 reported every one. Studio's own `.vue` files are checked with `vue-tsc` in `npm run type-check` since `71f9912`.

**Trigger:** a preview breaks on a template mistake the build's check let through.

**What it has to answer:**

- **Only the app's own files report.** On the unchanged scaffold, `vue-tsc` reports 190 errors, every one in Mesh's or Resources' server source, because the build box has no Workers types. Today's check keeps to the model's file with `reportFor`, and the new one needs the same.
- **A false finding holds back a correct app.** A build with type findings stays off `.dev` unless the model passes `{ "preview": true }`, so what the docs and the platform skills teach the model to write goes through the new check before it lands.
- **It replaces Pass 2 rather than running beside it.** What Pass 1's template compile is still for, once `vue-tsc` reads templates, is part of the work.
- **It changes the image.** The tooling goes in `apps/nebula/container/compiler/package.json`, which the image installs, so the change ends with a deployed pass (`live.md`).

## Item 20: Data-bound generation

**Goal:** the model builds better data-bound apps, by a loop measured against real turns. Moved here from [nebula-pre-alpha.md](nebula-pre-alpha.md) on 2026-11-12 (Larry), with the rest of the work that waits for users. It brings back [on-hold/nebula-offline-prompt-harness.md](on-hold/nebula-offline-prompt-harness.md) and [on-hold/nebula-skills.md](on-hold/nebula-skills.md), and is the first step of [on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md), which Larry names as the next big track once usage is dense enough.

**Trigger:** invited users building data-bound apps, and the prompt loop getting slow enough by hand that the replay harness pays for itself.

It is exploratory in both of its halves, and neither can be specified up front:

- **The prompt.** Iterate the system prompt against the compile gate and, later, a judge model, driven by capture, inspection and the replay harness. Its output is checks that can fail and captured findings, never a spec to transcribe.
- **The persona UI.** Prototype and react. The tight loop is Larry's own use: switching personas, several tabs, and the preview tabs.

**Iterating the prompt must not need a deploy, because the prompt is content.** The tight loop is the offline replay harness: the model and the gate, in seconds, with no preview. Live checks run on local `wrangler dev` with Docker. Deploy only to check where users live, or realistic multi-tab, auth and impersonation behaviour. The platform layer is `apps/nebula/platform/`: edit it, run `node scripts/gen-platform.mjs`, and `wrangler dev` picks it up.

**Ontology annotations come with it:** `@title`, `@description` and `@inverse`, which data-bound generation needs. They add to `extractTypeMetadata` and change nothing that exists.

### A hand-driven turn, traced from its record (2026-11-16)

Larry asked a new app for shopping lists that a user shares with others, read-only or with write access. The turn ran 13 minutes and stopped at the 32-round cap with its last edit unbuilt. Its record is the agent's stored message in the Galaxy: 50 tool calls, with each `run_in_tab`'s code and result.

- **The agent planned a node per list and did not build one.** Its `docs/permissions.md` said a sharee is granted a tier "directly on the list node". Its `App.vue` attached every list to the owner's node and never called `createNode` for a list. `access-control.md` drew the lists as boxes in the tree and never said in words that a list is a node.
- **`meta.nodeId` was missing on a resource the page had just created.** The store painted a create's value and `validFrom` only, so the share read `undefined`. `api-reference.md` said the field is on every snapshot. This was a defect in the client, and a generated app's own Share button would have met it.
- **A run that failed halfway left its first half behind.** The agent ran it again, found four lists where it wanted two, and wiped the dev Star, which meant building the cast again. It did that twice, so the cast was built three times.
- **A put built from a store value could not be cloned.** `{ ...list, members }` holds the store's proxies for `list`'s nested arrays, and `structuredClone` refused them. Also a defect in the client.
- **It kept a `members` array in each list**, a second record of who has access beside the tree's grants, and a `nodeId` field in the list's value.
- **It built four times before any data existed,** once on an unchanged tree only to land it. Its last build landed with four type findings, by asking for the preview.
- **Its closing message was "I couldn't finish cleanly — see the thought process"**, which says nothing of what is left to do. Not addressed.
- **Each full `App.vue`, about 15 KB, took about two and a half minutes to write,** and nothing streams while a tool call's arguments are generated. That is the silence in T4 of [small-ui-tweaks-from-driving.md](small-ui-tweaks-from-driving.md). Not addressed.

Changed the same day:

- **The client:** a create's `meta` holds the `nodeId` and `typeName` its op named, and an op's value is detached from the store before it is cloned. A create or move with no `nodeId` is refused by name; before, it read "Node undefined not found".
- **`access-control.md` § *Every box in that tree is a node*** says the rule, with code a test runs: a node for the list, the list attached to it, a grant on that node, and the roster read back from the tree.
- **The `wire-a-view` skill** gives the node rule at the create handler, and forbids a `members` field and a node id kept in a value.
- **The `define-the-cast` skill** asks for a node for each thing shared on its own, small runs that return what they made, a look before a failed run is repeated, and no wipe unless asked.

**The same request, run five times against the real model that evening.** The scenario `shared-lists-turn` posts Larry's words to a new app and reports what the turn built. It gates only on an answer arriving. Each run's record is under `apps/nebula/harness/.artifacts/`.

| Run | Rounds, minutes, stop | What it built | What it showed |
|---|---|---|---|
| 1 | 21, 10.7, ended itself | A node per list. Sharing wrote a `Share` record and granted nobody anything. No cast. | The ontology skill is read first, and nothing there said access is not a type. Two 15 KB file writes were cut off by a 4,096-token reply cap and reported as malformed arguments. |
| 2 | 32, 7.3, step limit | Lists and items only, a node per list, a Share control that grants, a cast of three. | It invited all three personas onto the node they share, as the skill's example did, then found Bob could rename Sally's list and repaired the grants. Its last build was clean and its reply said it could not finish. |
| 3 | 5, 1.4, ended itself | Nothing: it asked whether a write collaborator may change shares, and where a shared list shows. | Asking is the ontology skill's own judgment, so the scenario now answers and reads the turn that builds. |
| 4 | 45, 10.4 with the question, completed | All of run 2's, with each person on a node of their own from the start. Walter, with write, added an item, and Ron, read-only, read it. | Six of its seven builds had type findings, nearly all on a reference: the interface says `list: ShoppingList` and the stored value is the id. |
| 5 | 22, 6.0, completed | The same app and a cast of two, with the store typed from the ontology. | Two builds, where run 4 took seven: one round of findings, none on a reference. A node's slug ran past 30 characters, and the agent ran the whole script again, which failed on the node the first run had made. |

Changed between runs:

- **Access stays out of the ontology.** The `define-ontology` skill names `Share`, `owner` and `members` as what not to write and sends a sharing request to `define-the-cast` before any view. The platform's `AGENTS.md` says so in a sentence, and the cast skill's description names sharing.
- **A reply may run to 8,192 tokens,** and the error for cut-off tool arguments says the reply reached its limit and to write a smaller file.
- **The step limit is 48, up from 32.** Run 4 used 45 and completed. Larry had settled 32, so this is his to confirm.
- **A turn stopped at the step limit says where its work stands,** in place of "I couldn't finish cleanly".
- **The cast skill's example invites each person onto their own node,** and says a grant on a shared parent reaches everyone's. It also says never to retype an id, and that several tab runs go in one step.
- **A call given no node id is refused by name.**
- **The store is typed from the ontology (Larry, 2026-11-16).** The build's type check fills the client's `LumenizeOntology` from the interfaces `src/ontology.d.ts` exports, so a value read from the store has its type and a reference reads as a `string`. `coding-your-ui.md` had told the reader to cast at the read site, which made every reference a type error; it no longer does. Run 5 is the one run on it.

Still open:

- **Nothing streams while a file is written.** T4 of [small-ui-tweaks-from-driving.md](small-ui-tweaks-from-driving.md).
- **A failed run is still repeated whole.** Run 5 did it despite the cast skill's line against it.
- **One request, five different turns.** The model's choices vary run to run, so five runs show what can happen and not how often.

### Findings — the model in the loop, observed

One line per observation, appended and never edited: `date · limb · pass|fail · one sentence`. The limbs are the `/live` scenarios that watch the real model: `studio-guidance-loop` reports (a) (b) (c) (d) (f), `four-party-chat` reports (e), and `first-app-built` reports (g). A limb never gates a sweep. A fail is a finding for capture and for the platform file's next edit, and this item's loop restarts from the last line here. The log is appended now, before any invite, by every sweep that runs the model.

**Where the log stood on 2026-11-11:**

- **(a) A turn sometimes writes nothing and asks nothing**, ending `no-tool-calls` after a few rounds. Seen on 09-05, 10-11, 10-15 and 11-11, and never traced to a wording change.
- **(c) The reply sometimes fails to name `AGENTS.md`.** It failed in two of the three runs since `TOOL_CONTRACT` began asking the reply to say whose authority it used, which is worth a look before calling it variance.
- **(d) is fixed**: the skill descriptions were made disjoint on 09-06, and `define-ontology` has been read first since.
- **The discriminator's warm-up hint was deleted on 09-06**, after every measured interval beat the cold start.

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
- 2026-10-11 · (g) · fail · after `define-ontology`'s step 6 was rewritten to ask for a reset rather than an Apply, one `first-app-built` build turn wrote nothing (stop=no-tool-calls, rounds=3); the next runs wrote the ontology and the page and built twice. One sample against three passes, the 09-05 variance shape, not traced to the edit
- 2026-10-11 · (g) · fail · one sweep run's build turn ended on a Workers AI REST 400 from the model after it wrote `src/ontology.d.ts`; the rerun passed. Provider-side, not a guidance outcome
- 2026-10-14 · (g) · pass · the first sweep after builds with type findings were held back from `.dev`: the build turn ended `loop-detected` after 23 rounds and 5 builds, its last build held back for findings the manifest did not yet record; the reply carried the Galaxy's "The preview was not updated" line, and the scenario's preview-anyway landed it
- 2026-10-15 · (g) · pass · second sweep, after the build tool's prose came to say a build not previewed is served nowhere and the SFC contract gained the client surface `api-reference.md` documents: the turn completed in 17 rounds and 5 builds, its last landing clean with no findings. n=2 with both changes made at once, so neither is credited
- 2026-10-15 · (a) · pass · with the build tool's new preview prose, the wishlist's `App.vue` reads and writes through `store` / `client.resources`
- 2026-10-15 · (b1) · pass · the next turn's output honoured "no countdown timers"
- 2026-10-15 · (b2) · pass · after ten further turns the rule is still in `AGENTS.md` (556 bytes)
- 2026-10-15 · (c) · pass · the convention landed in `AGENTS.md`, and the reply named the file
- 2026-10-15 · (d) · pass · the turn read `define-ontology` before `wire-a-view`, then the three docs, the ontology and the source
- 2026-10-15 · (f) · pass · asked what was requested first, the reply named the rule
- 2026-10-15 · (e) · pass · four-party "what does this app do so far?" named the blank shell, its one `Item` type and the placeholder `App.vue`, and invented nothing
- 2026-10-15 · (a) · fail · third sweep, after `TOOL_CONTRACT` and `mark_complete` stopped restating how to preview a build and point at the build tool: no `App.vue` was written and nothing was asked (stop=no-tool-calls, rounds=3), the no-write shape of 2026-09-05's second pass and 2026-10-11; the two sweeps before it, on the longer wording, passed. n=3, so not attributed
- 2026-10-15 · (b1) · fail · third sweep: not exercised, no `App.vue` that turn
- 2026-10-15 · (c) · pass · third sweep: the convention landed in `AGENTS.md`, and the reply named the file
- 2026-10-15 · (b2) · pass · third sweep: after ten further turns the rule is still in `AGENTS.md` (556 bytes)
- 2026-10-15 · (d) · pass · third sweep: the turn read `define-ontology`, the three docs, `AGENTS.md`, `docs/vision.md` and the source
- 2026-10-15 · (f) · pass · third sweep: asked what was requested first, the reply named the rule
- 2026-10-15 · (g) · pass · third sweep: the build turn completed in 9 rounds and 2 builds, its last landing clean with no findings
- 2026-10-15 · (a) · pass · two further local runs on the shorter `TOOL_CONTRACT` and `mark_complete` wording each wrote an `App.vue` reading and writing through `store` / `client.resources`; with the third sweep's fail, 2 of 3 on that wording, the variance shape of 09-05 and 10-11
- 2026-10-15 · (b1) (b2) (c) (d) (f) · pass · the same two runs passed every other limb
- 2026-10-15 · (g) · pass · deployed on the final tree: the build turn completed in 8 rounds and 2 builds, its last landing clean with no findings, and its reply was the fallback `Updated the preview.`
- 2026-11-11 · (a) (b1) · fail then pass · two local sweeps a commit apart, the second on the `TOOL_CONTRACT` that gained the several-people rules, the held-posts block and post ids in the history: the first wrote no `App.vue` and asked nothing (`no-tool-calls`, 6 rounds), the second wrote one reading and writing through `store` / `client.resources`. One run each, so it reads as the variance the 2026-10-15 lines show, not as the wording's doing
- 2026-11-11 · (g) · fail then pass · on that same second tree `first-app-built`'s build turn ended `no-tool-calls` after 3 rounds with no build and an empty reply, then on a rerun with nothing changed completed in 7 rounds and 2 builds with a clean landing: a flake, and a second sample of the same variance
- 2026-11-11 · (c) (d) (b2) (e) (f) · pass · unchanged across both sweeps
- 2026-11-11 · (c) · fail · a third local run that day, after the closing step landed: the convention reached `AGENTS.md` and the reply did not name the file. That turn's prompt is the one the second sweep passed on, since a closing step's request is sent only when a post arrives mid-turn, so this too is variance
- 2026-11-11 · (a) (b1) (b2) (d) (e) (f) (g) · pass · the same run
- 2026-11-11 · (c) · fail · a fourth local run that day, on the tree that added the `invite` tool: again the convention reached `AGENTS.md` and the reply did not name the file. Two fails in the three runs since `TOOL_CONTRACT` began asking the reply to say whose authority it used, which may be crowding the file's name out of a two-sentence reply; worth a look before reading it as variance
- 2026-11-11 · (a) (b1) (b2) (d) (e) (f) (g) · pass · the same run
- 2026-11-15 · `cast-from-a-tab` limb 3 · fail then pass · a collaborator asks "Wipe the test data. Change no code." On the first `define-the-cast` wording, which listed building the cast again as the wipe's second step, the turn wiped and rebuilt in 3 of 4 runs; the fourth read the skill, wiped and stopped. The section now opens by saying a wipe is not finished until the cast is built again, and that a request naming only the wipe asks for both: 6 of 6 runs rebuilt.
- 2026-11-15 · `cast-from-a-tab` limb 3 · note · in 1 of those 6 the turn's reply was "Done — no changes." after wiping and rebuilding, though the skill asks it to say what it did. The limb gates on the wipe and records the rebuild, since nothing but the skill asks for it.
- 2026-11-18 · (a) (b1) · fail · the deployed pass of the turn-stored build, on the define-the-cast skill that reads another persona's records with `client.resources.query`: no `App.vue` was written and nothing was asked (`no-tool-calls`, 6 rounds), the shape of 2026-09-05, 2026-10-15 and 2026-11-11. The same tree's local closing sweep passed both, so one run, not attributed
- 2026-11-20 · (a) (b1) (b2) (c) (d) (e) (f) (g) · pass · first run on GLM-5.3 (`reasoning_effort: 'high'`, `max_tokens` 32768), after Workers AI deprecated Kimi K2.7 Code: every limb passed in a 79-of-79 local sweep. At GLM's default reasoning, `max`, `first-app-built`'s build round spent all 8192 tokens thinking and ended `length` with no tool call
