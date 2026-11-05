# Nebula Pre-Alpha Fast-Follow

**Status**: Drafted, not started — the **parent index** for the reactive "next" horizon: platform capabilities the first real user-developer apps will demand beyond the core codegen + data + chat loop. Not a build commitment; each item is `/review-task`'d before "go" and picked up **as user demand surfaces**. Linked from [`nebula-pre-alpha.md`](nebula-pre-alpha.md). Real child task files are spun **one at a time** when an item goes active — never pre-created as stubs. (Item 3 already has its own file; Items 1–2 are homed here until they go active. Item 9 is a **defect** rather than a capability, and it says so at the top of the item.)

**Provenance**: Items 1–2 surfaced 2026-07-02 from the first user-developer spec — Jennifer's [Luminize Almanac vision/requirements/data-model](https://docs.google.com/document/d/1P_YF2qVwQSAFYvg43qCvj3Nc170zBkpBboG8kcjdBGc/edit) and her companion [UX brief](https://docs.google.com/document/d/10UZ5KaZJXG2MdaHTwA2UPGrFKM_daGDdJaSbg6wGeFo/edit). Review lens was "what does this spec teach Nebula," not spec QA (see the `nebula-pitch-deck` memory for the full findings).

## Objective

Close the platform gaps that stand between the current live loop and real user-developer apps existing and thriving — picked up reactively, in demand order.

## Item 1: User-app media storage (photos/blobs)

> ⚠️ **Placement open — may be table-stakes, not fast-follow.** The Almanac's atomic unit (`Entry`) *requires* photos ("the app cannot exist without this"), so media may belong **earlier** — before the wipe, or with the data-bound work, in [`nebula-pre-alpha.md`](nebula-pre-alpha.md) § *What remains* — rather than in this reactive post-core bucket. Decide at `/review-task`.

**Goal**: A user-developer's generated app can accept, store, and serve end-user-uploaded media (photos first), governed by the same ReBAC/DAG access control as every other resource.

**Why now-ish**: The Almanac's atomic unit (`Entry`) *requires* one or more photos — the app cannot exist without this. Media is likely table stakes for a large share of domain-expert apps (the persona thinks in photos, documents, and artifacts, not rows).

**Shape (to be designed, not pinned)**:
- R2-backed blob storage surfaced as a platform capability, not raw R2 access (homogeneity: no per-app infrastructure divergence).
  - ✅ **First tenant landed 2026-09-03 — profile pictures.** One platform bucket (`nebula-blobs`, binding `BLOBS`; the test worker gets `nebula-blobs-test`), keyed `profile-pictures/{uuid}.{ext}`; `PUT /pictures` is bearer-gated and sniffs the bytes, `GET /pictures/{key}` is public and immutable because `picture` is a public field an `<img>` loads with no credential. `apps/nebula/src/profile-pictures.ts`. Not yet a capability an app can call — that is still this item.
- ⚠️ **`BLOBS` never gets a public custom domain.** Public R2 access serves any object by key with no reader check, so one leaked key would read an access-controlled photo forever. Profile pictures are public by design and already go through the Worker's `/pictures/:key` route; if public blobs ever need direct serving, they move to a bucket of their own ([nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) § *Future state*).
- Access control must ride the existing substrate — a photo is only readable by users who can read the resource that owns it (the sharing-circle semantics in Jennifer's spec map directly onto ReBAC).
- Relationship to `resource-history-r2` outbox mechanics: same bucket family, different object class — check for shared plumbing before designing fresh.

**Success criteria (sketch)**:
- [ ] A generated app can round-trip an end-user photo upload → store → display.
- [ ] An end user who lacks read permission on the owning resource cannot fetch the photo (direct URL included).
- [ ] No per-app R2 configuration — the capability is uniform across all apps.

## Item 2: App-branded AI persona

**Goal**: The built-in end-user AI chat is presentable as *the app's own assistant* — per-app name, tone, and behavioral constraints — while remaining the same ReBAC-governed chat underneath (the "can never read what the asking user can't read" guarantee is untouched and non-overridable).

**Why now-ish**: Jennifer named her app's AI layer ("Gigi Kaizen") *unprompted, in her first spec* — user-developers evidently think of the embedded AI as part of their product, not as Nebula's chat. Her spec also imposed behavioral values on it ("always gentle, never interruptive; no urgency language; no gamification") — tone/values constraints, not features.

**Shape (to be designed, not pinned)**:
- Per-app persona config: display name, voice/tone guidance, values constraints — data the platform's chat consumes, not code the app injects (no prompt-injection surface into the governed chat; constraints are additive style, never access-expanding).
- Never surface the underlying model name (existing rule: model-agnostic naming).
- The tone and values come from the app's `docs/vision.md`, the declared file the guidance task seeds ([nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md) § *Design intent*) — a second reader of one file, never a second store; the ReBAC floor on that chat is unchanged.

**Success criteria (sketch)**:
- [ ] A user-developer can name and style their app's assistant from the Studio.
- [ ] Persona config cannot widen data access or override platform-level chat guards (capable-of-failing test: a persona instruction attempting to read out-of-scope data does nothing).
- [ ] Behavioral constraints from the spec (tone, no-gamification-style rules) demonstrably shape chat output.

## Item 3: Outside-world connectivity (`fetch` / email / search / webhooks / cron)

**Full design + phased build plan lives in its own file**: [`nebula-outside-world.md`](nebula-outside-world.md).

The **substrate-not-primitives** thesis: Nebula builds a thin secure substrate (secrets vault, app-server facet runtime, egress broker, ingress router, scheduler, security stdlib) and the Studio agent writes integrations (email, payments, Slack, search) as ordinary app code. Spikes proven + mutation-checked; gated on `/review-task`. Demand order **`fetch` → email → search → secrets-last**. Also homes the post-wipe inbound `claude@` email exercise noted in [`nebula-pre-alpha.md`](nebula-pre-alpha.md) § *What remains*.

## Item 4: The prod ontology install path

**Placed here 2026-08-21**, out of [`nebula-galaxy-collapse-and-chat.md`](archive/nebula-galaxy-collapse-and-chat.md), which had deferred it *to itself* and then scheduled no phase for it. Not pre-alpha: the only Stars in the pre-alpha loop are `.dev` Stars, which already install through the lazy pull below, and a Star with real users exists only once an app is published — the publish path, which the staging ladder puts in **alpha**.

**Demand trigger:** the first pre-alpha user who wants to show their app to someone.

**Goal**: an ontology reaches a Star the Galaxy did not push to, without a bespoke per-Star install step.

**Current state**: every Star pulls lazily. An op pinned to a version the Star has not installed asks its Galaxy for the current row with `getCurrentOntology()` and installs it, and [nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md) moved that install into the Resources plane, where the Galaxy's answer lands at `resourcesResults.onOntologyPulled` behind a getter that carries no `@mesh()`. What the Galaxy calls current is the applied row whose hash matches the Workspace's ontology file, else the most recently applied one — published or not, and reachable without an Apply, since reverting the file makes an earlier applied row current. **After [nebula-star-ontology.md](archive/nebula-star-ontology.md)** the Galaxy answers each Star by kind: the `.dev` Star gets the last landed build's row, which the Galaxy keeps in its own storage, and every other Star gets the last published one, which does not exist until this item builds it.

⚠️ **The pull is built, so the open question has moved to what a tenant Star's source answers.** A push-on-append (Larry, 2026-07-25) lost to the pull for a reason that still holds: a Star converges only when a tab asks for a version it lacks, so a Star nobody is using costs nothing.

**Tenant-Star tests come back as part of building this** (Larry, 2026-10-11). [nebula-star-ontology.md](archive/nebula-star-ontology.md) leaves a tenant Star with no ontology until something is published, so it runs no data operation, and the live witnesses of node invites and ADR-008's denied-node disclosure moved to the `.dev` Star. When `publish()` lands, add tenant-Star coverage back: a node invite and a denied-node disclosure on a tenant Star running a published version, and a tenant Star moving to a newly published one.

**A candidate migration strategy (Larry, 2026-10-11).** [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md) commits to the direction: data moves forward only, by the user-developer's migration code running sandboxed, and a publish records the order migration needs. This is the candidate mechanism. A resource migrates forward when a tab reads it at a newer version, in place, one published version at a time; every snapshot already records its `ontologyVersion`, so each resource knows where it stands. A `Deal` last written at v3, read by a tab on v5:

1. The Star runs the v3→v4 migration, then v4→v5, each in a sandboxed facet, because a migration is the user-developer's code, as the validator is.
2. It saves the result as a new snapshot, so the history keeps the v3 one ([ADR-004](../docs/adr/004-snodgrass-temporal-resources.md)), checked against the eTag it read ([ADR-005](../docs/adr/005-optimistic-concurrency-etags.md)) and retried on a conflict. A facet call is async, so the migration runs before the synchronous transaction, never inside it.
3. It returns the v5 resource.

A resource already at the tab's version is returned as it is. A tab on v2 reading the same `Deal` is behind, so it reloads; nothing migrates backwards. The `.dev` Star never migrates: it is wiped instead ([nebula-star-ontology.md](archive/nebula-star-ontology.md)).

**What `publish()` must record for that to work:**

- **An order of published versions.** A version is a content hash, and hashes do not order themselves.
- **Per published version, everything from one publish, so it stays in sync:** the types, the compiled validator, the compiled migration from the previous published version, and the app's `dist`.

**How it records them is open.** Two candidates: a git tag per published version, since a version is already the ontology file's `git.hashBlob`, so git may hold the ordered history without a second file; and a Galaxy compile-cache keyed by version for each published validator and migration, a cache rather than the truth, recompilable from the tagged source. Larry asked on 2026-10-10 whether the history needs a file of its own at all, or whether JSDoc and comments in `src/ontology.d.ts` carry the prose; if it is a file, JSONC only with a parser the Worker already has, never a dependency.

**Still to answer when it is built:**

- **Queries over resources nobody has read since a publish.** A query that filters on a field a migration adds will not see it on a row not yet migrated. The usual answer is a sweep after the install, with migration on read as the backstop.

**A publish promotes the build's validator and migration as the build compiled them,** with no second compile apart from the app's own code (Larry, 2026-10-12). [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md) § *Consequences* says why that risk is accepted.

This replaces [icebox/nebula-ontology-history-file.md](icebox/nebula-ontology-history-file.md), iceboxed on 2026-10-11.

**A reload keeps what the page had not saved, on every Star** (moved here from [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) on 2026-10-13, where Larry deferred it until it can be solved for every Star at once). Resources holds an unsaved write only in memory: a value waiting out its quiet window, 500 ms after the last keystroke and 2 s at most, a write held while disconnected, and the one transaction in flight per resource. Its write queue also forgets a write the Star refused for an old ontology version while leaving the value on screen. So a reload drops all of them, and on a Star with real users a publish that changes the types causes one. The candidate, decided for `.dev` alone on 2026-10-13 and then deferred:

- On `pagehide`, which fires for every reload, Resources writes each unsaved write to `sessionStorage` under the Client's address, `alice.9f2c41aa`: its kind and value, the eTag it was written against, and for one already sent, its `newETag`. A duplicated tab gets a fresh address, so it never reads another tab's writes.
- The next load sends them again through the ordinary write path. A write sent before the reload goes under its same `newETag`, so the replay check answers it committed if it landed.

Its reasons rested on `.dev` holding only test data, so re-derive them here. A Star with real users must migrate a carried write forward before it runs, so the carry records the ontology version each write was made at. It lands beside Mesh's durable outbox ([mesh-1-alpha.md](mesh-1-alpha.md) § *Item 11: Durable calls*), which keeps a call already sent where the carry keeps a value not yet sent, and the two must not both send one write again. A crash fires no `pagehide`. *Rejected:* the outbox as the whole answer, because it cannot hold a value still in its quiet window or a write already refused, and the draft that tried left six questions open ([on-hold/mesh-call-durable.md](on-hold/mesh-call-durable.md) § *Findings from the reload detour*). Waiting until no write is pending, then reloading, because the queue has already finished with a refused write. Widening the replay check to a resource's history, because it misses the same person's second write within the coalesce window, which overwrites the first in place.

**Two requirements, carried in from [nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md) (2026-09-28):**
- **A tenant Star's source answers the PUBLISHED version**, never the Galaxy's current row as defined above, so an unpublished breaking row never reaches a tenant.
- **A breaking version that reaches a non-`.dev` Star migrates; it is never wiped.** Until migrations exist, no breaking version reaches a non-`.dev` Star, because none is published: after [nebula-star-ontology.md](archive/nebula-star-ontology.md) every Star but `.dev` runs only a published version, and the install-time fence that file's D23 described goes with `wipeOnInstall`.

**A candidate shape, carried over intact** — it was reasoned out at length and should not be re-derived from scratch:

- 💡 **Candidate shape — git as the transport (Larry, 2026-07-25).** Pull it into the container with **git** rather than shipping bundles: **commit per codegen turn**, the Galaxy's *shipped* version is a **tag**, and a **triggered pull** promotes the dev version into the `.dev` Star at the end of each LLM response. (The `.dev` half is now [nebula-star-ontology.md](archive/nebula-star-ontology.md)'s: a build that lands becomes the `.dev` Star's current row.) Deltas instead of whole artifacts, and "which version is live" becomes a git ref rather than bespoke state. Fits what is already here — `isomorphic-git`/Workspace ops are named as on-DO-thread work below, and `@cloudflare/shell` + isomorphic-git are proven to run under vitest-plugin ([[shell-isomorphic-git-pool-workers]]).
  - **Repo-to-repo git, if we want it, is CONTAINER-side.** Real git on real Linux does local-path remotes, so `git clone /workspace/app /workspace/build` + `git -C /workspace/build pull ../app` needs nothing external. ⚠️ **Host-side `file://` is permitted but unproven** — `git/cli.ts`'s `isSupportedTransport` allows it and the docs claim it, but `git/network.ts` passes `http:` to isomorphic-git for every network op and **no test anywhere mentions `file://`**; upstream isomorphic-git has no local transport. Treat it as broken until measured. ⓘ **MOUNTS are BUILT, with one provider — corrected 2026-08-03 against the installed package.** `docs/01_vfs.md` marks the whole mount subsystem **(planned)**, but `@cloudflare/computer@0.1.1` ships `WorkspaceOptions.mounts`, `Workspace.mounts()` and `ensureMountsIndexed()`, and the vendor's own container example mounts a bucket at `/workspace/r2`. **`R2Bucket(binding)` is the only shipped provider** (read-only — writes under the root reject `EROFS`), plus a `MountFactory` seam for custom ones; there is no git/GitHub provider. ⚠️ **Their docs lag their code — verify against the installed `.d.ts`, not the doc.**
  - ⏳ **What Artifacts would still buy (none on this task's critical path; open beta since 2026-10-01):** (1) history **off the DO** — the repo currently sits in Galaxy's SQLite, under ADR-018's 10 GB ceiling and the cold-start-scales-with-size worry below; moving it frees the Galaxy's storage but cannot raise one app's ceiling, because an Artifacts repo is capped lower ([1 GB on 2026-10-01](https://developers.cloudflare.com/artifacts/platform/limits/)); (2) a **real remote for BYO-agent** (`archive/nebula-studio.md` § *Enterprise BYO-agent*) — the one case that genuinely needs a git server; (3) **`fork`** on a repo handle, which makes scaffold provisioning a server-side op that carries the scaffold's *history*, so a later scaffold upgrade is a **merge** rather than a bespoke diff-and-patch (⚠️ **the open-beta docs still do not say whether `fork` is copy-on-write or a byte copy** — it decides whether N tenant forks each bill their full size; measure it by forking one repo and reading the storage metric); (4) **export** as a clone URL. Consistent with `reference/nebula-dev-flows.md` **Decision 6** (Artifacts as an optional future optimization behind the same free seam).
  - ❓ **Still open:** the Star consumes a *compiled validator bundle*, not source — so decide whether git carries the source (Star or container rebuilds) or the built artifact.

**Six tests are skipped on this, and they should NOT wait for it.** Five browser benchmarks plus `chromium/conflict-modal` fail only because a fresh `uniqueStar()` has no ontology installed — not because they need a *pull* specifically. Their skip comments say "Un-skip when the prod lazy-pull lands", which fused two different problems. The test app's `StarTest.applyOntologyForTest` already installs one **without a Galaxy round-trip**, handing a compiled row to `resourcesResults.onOntologyPulled` the way a pulled row arrives, and an admin-scoped caller reaches it — so their setup can install one directly. ⚠️ Confirm first that `conflict-modal` merely *needs* an ontology present rather than testing `ontology-stale` behaviour itself; its own comment says the verdict contract "is unaffected", which reads as the former. Tracked separately in [`backlog.md`](backlog.md) § *Testing & Quality*.


## Item 5: The published-tier serve — shipped-tag `dist` for `/app/{u}.{g}.{s}/*`

**Placed here 2026-08-24**, out of the collapse's § *Serving* route table (its one ⏭️ deferred row). **Never in doubt — only deferred.** The same Galaxy `fetch` handler and `serve.ts` that serve `.dev`'s `/dist-dev/` serve every other star **`/dist-prod/`** — **one published copy for all tenant stars** (a star slug is a tenant, e.g. `acme.invoicing.northwind-co`; per-star staged rollout is deliberately NOT a thing). Publish **copies** `/dist-dev/` to `/dist-prod/`, beside the `.dev` Star's compiled row, so a publish ships the very build `.dev` runs, validator included (ADR-024); both copies sit outside `/workspace`, where the model cannot write and git does not reach ([nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) § *Design intent*). The publish commits the source (Larry's split-`dist` shape, 2026-08-24), so the serve path never reads through git and both tiers ride the same `getFile` seam; **the publish commit — and the shipped ref pointing at it — is provenance, not the serving mechanism**. Nothing extra rides the copy: the artifact **self-describes** — the ontology version is not baked into the build: the Galaxy writes it into each served page's `nebula-scope` meta from the row that Star runs ([ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)), and `serve.ts`'s own one serve-time rewrite is the `<base href>` injection above, which is addressing, not content, and publishing is deterministic Galaxy code, so no write-guard is needed on `dist-prod/` (the LLM's `write_file` scope is the app source — a different risk class from the ontology history file, which the LLM must edit). *(The earlier tag-lookup serve was superseded by this — reading blobs at a ref on every request was the complexity this deletes.)*

✅ **RESOLVED before it could bite (Larry's catch + decision, hand review 2026-08-26): no baked base exists to be wrong.** The one-copy serve forbids a star-keyed vite `base`, so the collapse builds the target directly: the scaffold builds with `base: './'` and `serve.ts` injects `<base href>` for whatever prefix it is serving under (`HTMLRewriter`; the collapse's vite-base bullet carries the derivation). `dist-prod/` is therefore one copy valid at every star's prefix with nothing to re-bake at publish — and the custom-domain future below needs no rebuild either: at its own origin's root the injected value is simply `<base href="/">`.

**Custom domains (further deferred, moved here from the collapse 2026-08-24):** a tenant app then moves to its **own origin at root** (truly non-prefixed); the client's origin-relative WS must reach the Gateway there (or set an explicit control-plane `baseUrl`). The `/app` prefix persists for the **dev preview**, which stays on the control-plane origin.

**Demand trigger:** the same as Item 4's — the first pre-alpha user who wants to show their app to someone — and the two land together: a published Star needs its ontology (Item 4) and its `dist` (this) at the same moment.

⚠️ **If user-dev source-privacy demand appears, the gate design restarts HERE, under two recorded constraints** (Larry, 2026-08-24): **no cookies**, and browsers send no `Authorization` on document or sub-asset loads — which together likely mean the serve itself is never gated (a published app's END USERS need `index.html` before they can log in), and privacy comes from something else if it comes at all.

⚠️ **Publish sends no reload push, and one added later would need herd control** (Larry, 2026-08-26; the reload channel it would have ridden was deleted 2026-09-28, [nebula-data-plane-owns-its-guards.md](archive/nebula-data-plane-owns-its-guards.md) D17). Prod stays lazy: the ontology version gate already guarantees correctness, and a code-only publish picked up on the next natural reload is ordinary web behavior. A push that reloaded every live client of a galaxy's stars at once would have each fetch `index.html` + assets from the one Galaxy DO, sent as O(N) calls from that same DO, so a later one ships with client-side jitter or a measurement, never blind. The dev loop's answer reaches only Studio: a build that lands reaches every Studio open on the app, through a resource it subscribes to ([nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md)), and no page outside it.

**A page outside Studio learns its build is stale by checking, on `.dev` and on every published Star** (Larry, 2026-10-12; moved here from [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) on 2026-10-13). Every page carries the build version it was served, the digest of its `index.html`, in its `nebula-scope` meta. When the page comes back into view, and when its connection comes back, it asks its own host which build it would serve now. If that differs, it reloads through the app's `onShouldRefreshUI`, once per build version, behind a `sessionStorage` guard like the ontology reload's. A persona's page in a tab of its own, such as `mary--dev.crm.acme.lumenize.dev`, is usually out of view while someone asks Studio for a build, so it moves the moment they switch to it; a tab in view keeps the old code until it is next hidden and shown. A page Studio frames leaves its build reloads to Studio, so pacing has one home. ⚠️ A check that reaches the Galaxy grows with end users' activity on one Durable Object per app, so it wants a cache in front before alpha has users. *Rejected:* the landing telling the `.dev` Star, which tells every Client it hosts. Mesh would need a way for a node to reach every Client it hosts, which today only `ClientGateway.closeAll` does, and a published Star would still need the check.

⚠️ The **scale** mechanisms — edge cache, the release herd, R2 as an escalation — are NOT this item's: they are decided by measured experience, and live in [backlog.md](backlog.md) § *Future bigger things*.

## Item 6: Mid-generation chat UX — the two-stage arrival pipeline

**Moved here from the backlog 2026-08-24** (it is near-term, with a demand trigger — not a someday row). Pre-alpha the codegen trigger is **single-flight**: a mid-generation post starts no turn of its own (collapse Phase 4), and until [nebula-agent-posts-as-itself.md](nebula-agent-posts-as-itself.md) lands it just sits in the thread. Larry judges that unacceptable UX beyond pre-alpha.

**The catch-up moved out on 2026-10-10**, to the personas task and then, when that task split, to [nebula-agent-posts-as-itself.md](nebula-agent-posts-as-itself.md): when a turn ends, posts that arrived during it get a reply from a turn the agent starts, which posts as the agent and has no tools, because the personas wipe is confirmed by a chat reply. What stays here is steering a turn while it generates, and the discriminator. Until it exists every human post gets a turn, which costs more and is affordable with pre-alpha's few users; Larry calls the discriminator a cost optimization that can come later.

**Larry's direction, 2026-10-10: the agent hands long work to sub-agents and stays the chat's supervisor.** Its own turns then stay short, so a post during one waits seconds rather than minutes, and a sub-agent acts under the permissions of whoever said yes to its work.

**Demand trigger:** the first multi-user session that hits the single-flight floor in anger.

**Target sketch:** a **two-stage arrival pipeline**. Stage 1 — EVERY message runs the fast **discriminator** (the collapse's two-LLM-calls Decisions row) on arrival: cheap enough to block on, or its own short queue. Stage 2 — only a "Nebula must respond" verdict enters the **codegen queue**: empty → run; busy → prompt the author — *"interrupt Nebula's thinking, or queue this for after?"* **Cancel lives on the streaming response.**

**Couplings:** the respond-or-not policy + `@`-mention control ride the same classifier and land with this; cancel must ride the container teardown order — let the sync bracket resolve, `destroy()`, tolerate the 1006 — and release the residency hold (both pinned in the collapse's Phase 3).

**The respond-or-not policy — decided 2026-09-04 (Larry), deterministic first.** The classifier's *codegen* verdict no longer forks anything — the guidance task ([nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md) § *Design intent*) runs one assembly on every turn and keeps the cheap call only as a container-warm hint. What is still this item's is whether Nebula answers at all, and three of the four cases need no model:

**2026-09-06 — the discriminator call is DELETED.** Its last job was a warm hint that fired the build box before the model's first write; five real turns measured every first-write to build interval above the 3.2 s cold start, so Larry dropped the call, and only the first write warms now. Stage 1 above would therefore be a NEW classifier call, decided when this item is picked up, not a survivor of the collapse's two-call design.

1. **The agent tagged in the message → respond.** Needs a mention syntax, which does not exist today: `@` followed by a participant's display name, matched case-insensitively against the chat's participants.
   - **The agent's tag (Larry, 2026-10-07).** Its display name stays "Lumenize", the name its Profile is seeded with, and the matcher also accepts two aliases for the agent alone: `luminize`, the common misspelling, and `agent`. So `@Lumenize`, `@luminize` and `@agent` all address it. The display name is configuration the app supplies ([mesh-is-built-on-the-scope-tree.md](archive/mesh-is-built-on-the-scope-tree.md) D17 and D19), so it is Nebula's choice, not Mesh's.
2. **Another participant tagged and the agent not → do not respond.** The message is for them.
3. **Only the poster is present and no tag → respond.** "Present" is the chat query's live data-subscriber roster, a table the Galaxy already holds for presence — a synchronous local read. Key it by `sub`, not by client, so a person with two Studio tabs counts once. Personas never appear: they are logged into the app preview, not into Studio's chat.
4. **Others present and no tag → the cheap model decides**, given the roster and the last six or so messages with their bylines, and failing open to *respond* — an unanswered request is the worse error in a building session. Draft prompt: *"A group chat in an app-building workspace. Nebula is the assistant. Given who is present and the last messages, reply with ONLY `{"respond": true}` if the newest message asks Nebula for something or continues an exchange with Nebula, and `{"respond": false}` if it is addressed to another person."*

Single-flight sits before all four: a message during a generation starts no turn of its own, and once [nebula-agent-posts-as-itself.md](nebula-agent-posts-as-itself.md) lands, the turn the agent starts when a generation ends answers it.

**2026-10-10 — start with Cloudflare's Clef, not Jev (Larry).** Clef is Cloudflare's own competitor to Jev, built for the same job, and Larry picks it for being faster, more local and cheaper. The shape below was written for Jev, so check it against Clef's docs at pickup.

**2026-09-20 — when case 4 is built, the classifier is Jev (Larry).** `typesafe/jev` is a Workers AI model that answers typed questions about one state and returns a calibrated probability instead of prose. Case 4 becomes a single `noul` question rather than a JSON parse of a chat model's reply. Shape is from [the Cloudflare model page](https://developers.cloudflare.com/ai/models/typesafe/jev/), read but not yet run here — re-check it against the docs at pickup:

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

- **Failing open becomes a threshold, not a catch block.** Case 4 above names the asymmetry; a probability is what makes it a number — respond unless P is decisively low.
- **No dependency, no startup cost.** `env.AI` is already bound and already carries the codegen model, so this is a second model id on a binding we have.
- **ADR-001 is not in play.** The `questions` object says what to ask about one state; it never describes the shape of our data. This is a model call, like the codegen call beside it.
- **Measure the calibration before trusting a threshold.** "Calibrated" is the vendor's word, and `calibration.md` § 8 says a measurement survives an override where a label does not.


**Consider — turn leases and wake-time reconciliation (2026-09-06, from the crash-only discussion).** Three ideas from the let-it-crash article, each prefixed "consider" on purpose: none is decided, and Larry's worry sits above all three. A fresh container does nothing for a half-finished Workspace, and a restart does nothing for a corrupt one. What makes the half-finished case survivable is that both histories are durable — the commits in the DO's git and the Messages in the chat — so the person can say "fix it" and the model sees what landed and what did not. Guidance for that grows over time, and LLM-driven testing, once it exists, makes such states obvious rather than discovered by hand.

- **Consider a lease per turn.** The human Message is durable before the model runs; if the Galaxy is evicted mid-turn the turn dies, and today the person posts again. On wake, a Message with no reply and no turn in flight is a lease that expired: restart it once, from the durable state (the commits, the history bundle), never a blind rerun, because a turn is a multi-minute model job. The idempotency key already exists — one reply per Message — so a restart that finds the reply landed is a no-op.
- **Consider an attempt cap with a parked reply.** Two attempts, then a reply that says what landed and that it stopped, where someone has to look. Without the cap a restart is the article's poison message retried forever; with it, a corrupt Workspace surfaces as a message rather than a loop.
- **Consider reconciling on wake.** An eviction skips the turn's `finally`, so a build box can outlive its build. On wake, destroy any running container no build owns, and name the Workspace's state — uncommitted changes against the last commit — so the restarted turn, or the person, starts from something named.

## Notes

- A third finding from the same Jennifer analysis — **cross-document spec-drift detection** (her two docs contradict each other: photo-first-required vs text-first capture) — is deliberately *not* an item here: it's a Studio/coach-loop capability question that needs its own framing, and the coach loop covers it manually during alpha. Revisit when the Studio eval suite resumes.
- None of these jump the queue: the active pre-alpha branch work (per [`nebula-pre-alpha.md`](nebula-pre-alpha.md)) remains the priority; these are picked up reactively on user demand.

## Item 7: Multi-persona preview tabs — testing a permission model as several users at once

**Moved to pre-alpha ② on 2026-09-08; [nebula-testing-with-personas.md](nebula-testing-with-personas.md) is the authority.** Larry's idea, 2026-08-28: a user-developer cannot test their app's permission model with one login, so Studio provisions test personas on the `.dev` Star and shows the app as each of them, one tab per persona. The mechanisms this item once weighed — mailboxes on a catch-all, impersonated tokens handed into a frame, a real login per persona — were superseded by [ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md) § *A persona's host*, and git keeps them.

## Item 8: Tell the OTHER collaborators a new build landed

**Absorbed 2026-10-13 by [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md), which is the authority.** Its list of who has the app open, the chat query's subscribers, and its two warnings, the time to drop a closed tab and no opt-in enrolment, carried over there.

## Item 9: A connected client never re-checks its token

⚠️ **A defect, not a capability — the only such item here.** It sits in this file rather than the
backlog because a session that dies while the tab is still open is what a first real user-developer
meets on an ordinary afternoon, and the fix is small.

**Today:** `#needsTokenRefresh()` ([`lumenize-client.ts`](../packages/mesh/src/lumenize-client.ts),
~:1112) is a sound predicate wired to exactly one caller — its own JSDoc says it exists to *"GATE
the await in `#connectInternal`"*. Nothing re-evaluates it while a socket is up. A client that
connects and then sits past its `exp` dispatches on the dead token, the Gateway refuses, and the
refusal never comes back as a rejection. The caller waits out `callAsync`'s 30 s timeout and
receives `TimeoutError`, which names neither the token nor the identity — the "thinking… forever"
shape ADR-003 exists to kill, wearing an abort's costume.

**How it shows:** `harness/scenarios/impersonation-expiry.ts` is the one red scenario in the
registry (`drive.ts all`, 2026-09-01: 21 of 22 green). It mints a 45 s child, waits 50 s, reads —
and both parent and child report `connectionState === 'connected'` across the lapse. Nothing in the
client's own view of the world says anything is wrong.

**Not impersonation-specific.** A child is only the fastest way to reach it: `ttlSeconds` makes the
lapse observable in 45 s, where an ordinary session takes the full `ACCESS_TOKEN_TTL` of 15 minutes.
Any idle tab crosses it.

⚠️ **The in-lane twin is green and cannot see this.**
`test-apps/baseline/impersonate-lifetime.test.ts` § *survives a GENUINE expiry* moves the clock with
`vi.setSystemTime` and drives a path that re-enters the mint. It proves the server rejects a stale
`exp` and that the re-mint works, never that a live socket notices its own token died — exactly the
split `live.md` predicts. Provenance, checked rather than assumed: no commit in the login re-order
touches `impersonation.ts`, `nebula-client.ts`, `lumenize-client.ts` or `mint-narrower-token.ts` on
this path.

**The change — two independent halves, and the second earns its keep whichever way the first goes:**

- **Re-check before dispatch**, or on a timer, so a client refreshes rather than sending a token it
  could have known was dead.
- **Deliver the Gateway's refusal as a rejection**, so a stale token fails in milliseconds carrying
  its own name instead of arriving as a timeout half a minute later.

- [ ] A client connected across a real token lapse completes its next call — `impersonation-expiry`
      goes green, on a clock nobody patched.
- [ ] An unrecoverable refusal surfaces as itself within a second rather than as `TimeoutError` at
      30 s (capable-of-failing test: suppress the re-check and assert the error's NAME, not merely
      that something threw).

## Item 10: Studio drives the preview — the model exercises the app it just wrote

**Larry, 2026-09-09,** working the persona design: *"The LLM is eventually going to need to drive actual `.dev` Star usage at some point to check its own work."* Today the model's entire self-check is one `build` — `TOOL_CONTRACT` says *"check them all with ONE build; read its per-step report"* — whose steps are `ontology`, an explicitly advisory `typecheck`, `container` and `preview: { refreshed, why }`. **The model has never run the app.** It cannot see whether a button works, whether data loads, or whether a denial renders.

### The topology, which is what makes this tractable

Every well-known driver — Playwright, Puppeteer, Stagehand, browser-use — is **outside-in**: a Node or Python process driving a browser it owns over CDP. We are the opposite, and better placed than that sounds. Studio's page holds the user-developer's live client, the preview is a **same-origin** iframe, and a DO can already push to the page: `NebulaClient` carries about six `@mesh()` methods DOs call through the Gateway (`handleResourceUpdate`, `handleOrgTreeUpdate`, `handleProfileUpdate`). So the control channel exists, and **Studio's page is the browser panel** — the model reaches the DOM the way Claude Code reaches Chrome, with mesh where CDP would be.

Same-origin also means **nothing is injected into the generated app**. `iframe.contentDocument` gives the parent `querySelector`, `.click()`, `.value =` and `dispatchEvent` outright. The missing piece is not access, it is *addressability*.

### Buy, don't build — the engine is published

⭐ **`@vitest/browser` exports `./locators`: Playwright's selector engine, MIT, packaged for in-page use** — and it is already a transitive devDependency here (`@vitest/browser@4.1.10`, pulled by `@vitest/browser-playwright`, which `apps/nebula` declares for its `chromium` project). Reading `dist/locators.d.ts`, the `Locator` class splits exactly along the seam we need:

- **Synchronous, in-page:** `getByRole` / `getByLabelText` / `getByText` / `getByTestId` / `getByTitle` / `getByPlaceholder` / `getByAltText`, plus `filter` / `and` / `or` / `nth` / `first` / `last`, and `query()` / `element()` / `elements()` / `length`. The scope is a settable `protected _container?: Element` — which is how it points at `iframe.contentDocument.body`.
- **`Promise<void>`, delegated to the provider (Playwright over vitest's socket):** `click`, `dblClick`, `fill`, `hover`, `selectOptions`, `upload`, `dropTo`, `wheel`, `clear`, `screenshot`.

The module also exports `selectorEngine` (with `QueryContext { scope: Element | Document, pierceShadow }`), the `getBy*Selector` builders, and **`convertElementToCssSelector`** — element→stable-selector, which answers the ref problem in the reverse direction. The tell that the fit is real rather than a stretch: `getIframeScale` is in the exports, because vitest browser mode itself runs tests in a parent page driving an iframe. **Same topology.**

Buying this also aligns the model with its training: it addresses elements as `role=button, name="Add todo"` — Playwright's and Testing Library's notation — instead of a tree format we invented.

⚠️ **Take the engine, not `@vitest/browser`.** `locators.js` does `import "vitest/browser"; import "vitest/internal/browser"`, so it expects the runner's browser context; and it is pinned **exact** to the vitest version, which would make a vitest bump a *product* change — the toolchain-triple hazard in `.claude/rules/workflow.md` § *Toolchain bumps*, aimed at Studio's runtime. **`ivya` is the same Playwright engine published standalone**, without the runner coupling, and is the likely buy. It is not in our tree: license, size and transitive pins need verifying first. That is a spike, not a decision.

### What is NOT free

- **The action half.** Vitest's actions round-trip to Playwright, which we do not have in-page. Either hand-roll dispatch or take `@testing-library/user-event` (MIT) for realistic sequences — a naive `.click()` misses focus and pointer events and ignores `disabled`, which is the class of problem a testing-oriented dependency exists to have already solved.
- **Quiescence.** *"Has this Vue app finished re-rendering?"* Playwright answers it with actionability checks (visible / stable / enabled / hit-target) that live provider-side. The in-page substitute is `@testing-library/dom`'s `waitFor` — MutationObserver polling, battle-tested. You cannot reach the child's `nextTick` from a parent realm.
- **Screenshots.** `Locator.screenshot()` is provider-side. Page JS cannot rasterize a child document, so this needs `snapdom` / `modern-screenshot` / `html2canvas` (all MIT). Fidelity is approximate — they re-render from computed styles — so decide whether "blank screen" is answerable from structure alone before paying for it.
- **The glue:** the mesh continuation, the loop tool and its guard, and the policy of what the model may address. ⚠️ The model wrote the app it would be driving, so this is a trust surface and not merely a capability.
- ⛔ **axe-core is out** — MPL-2.0, off `workflow.md`'s permissive list. Ruled out before anyone proposes it.

### Dependencies and dependents

The concrete ask is **one engine (`ivya` or equivalent), optionally `user-event` and a rasterizer, plus `@medv/finder`-style selector generation** — which at well under 1000 SLOC is copy-with-attribution per `workflow.md`, not a dependency. All need Larry's approval. One budget note: `workflow.md`'s startup-cost rule governs the **Worker** bundle; this ships in Studio's browser bundle, a far more forgiving budget.

⚠️ **Same-origin is load-bearing**, as it was for a persona seat handoff that ADR-022 has since replaced. If the preview moves cross-origin, both mechanisms need re-deriving together, not separately. [nebula-scope-moves-to-subdomain.md](archive/nebula-scope-moves-to-subdomain.md) moved it to the dev Star's own host (decided 2026-09-16, built 2026-10-04), so this premise has ended; re-deriving this item waits for its own trigger.

### Demand trigger — and the two cheaper things that may moot it

**Do not build this until both of the following have shipped and a real gap remains.** Larry's motive splits, and most of it is answered more cheaply:

- *Does the permission model behave?* — the **data plane**, already reachable browser-side once persona seats exist. The model can be told what a seat sees without any DOM work.
- *Why is the screen blank?* — **`nebula-pre-alpha.md` § *③ Capture live*** already scopes it: `@lumenize/debug` gains a second, filtered, console-additive callback, the scaffold installs it, and *"a loop tool reads the tail — one entry in `LOOP_TOOL_ENTRIES`."* A runtime error log probably answers "blank" better than a click driver.

If both land and the model still cannot close a loop it should be able to close, that is when this earns its keep — and by then real turns will say which addressing it actually needs.

## Item 11: Snapshots replace the deps baked into the build-box image

**Moved here 2026-09-30** from `tasks/backlog.md`, where it sat as a "don't adopt" verdict. Cloudflare shipped container snapshots that day on raw `ctx.container`, which is how the Galaxy already drives its build box, and the verdict's premises went with the announcement. **Until a child task file exists, the experiment is the authority:** [experiments/container-snapshot-deps/](../experiments/container-snapshot-deps/). Its `RESULTS.md` carries the measurements and an outline for the session that drafts the task file.

**Goal:** the image stops carrying dependencies. One shared snapshot holds the scaffold's installed tree, a per-Galaxy snapshot holds a user-developer's extras, and the image changes only when the toolchain does.

**What it buys:**
- **No curated, baked dep set.** `apps/nebula/container/Dockerfile` stops installing the scaffold's libraries, and nobody maintains the list.
- **Extras install once per lockfile change, not once per build.** On vite 8 the install is the largest term in a build with extras (`experiments/computer-vfs-build/RESULTS.md` § *ROUND 5*).
- **The `@lumenize` frontend packages arrive through npm instead of a `COPY` into the image.** That needs no npmjs.org release: npm installs a tarball URL, and our own Worker can serve one.

**What blocked it — all cleared by 2026-10-08:**
- ✅ **`@cloudflare/computer` passes an image and a snapshot through `start()` — cleared 2026-10-02 by 0.4.0.** Its launch spec takes `name`, a key into `ctx.container.images` defaulting to `app`, or `containerSnapshot`, plus the rest of `start()`'s options. It does not wrap `snapshotContainer()`; the Galaxy calls that on its own `ctx.container`.
- ✅ **The `durable_object` scheduling policy needs wrangler 4.135 or later — cleared 2026-10-04.** The move to `@cloudflare/vitest-plugin` 1.3.6 pins wrangler 4.147.0.
- ✅ **The build box runs the `durable_object` policy — built 2026-10-08 (`4c6e1d4`), still baking its deps.** Computer 0.4.1, a `build-box` entry in the containers block's `images` map, and a new container application for the test target, since a policy cannot change in place. Production gets its first Galaxy container application, under this policy, at the wipe ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *⑥ The wipe*).

The experiment turned up two more things any design has to handle. `@swc/core` 1.16.12+ refusing to load under the policy's filesystem is handled: the build job hands `/` back to root, marked TEMP. A snapshot restoring its own, older image after a deploy is this item's to design. Both are in the experiment's `RESULTS.md` § *Findings*.

**Demand trigger: fired 2026-10-02**, when computer 0.4.0 shipped the passthrough, and nothing blocks it now. The next step is the child task file, drafted with `/write-task` from the outline at the end of the experiment's `RESULTS.md`.

## Item 12: `cf` and `cloudflare.config.ts` replace `wrangler` and `wrangler.jsonc`

**Not a capability: a toolchain move with a deadline, added 2026-10-08.** Cloudflare launched `cf` in open beta on 2026-09-28 ([launch post](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)). When the beta ends, Cloudflare ships a final wrangler major that points at `cf`, then maintains wrangler for 18 months. **Until a child task file exists, `cf`'s source is the authority** (`cloudflare/cf`, `packages/cli/src/commands/`). The `test_bugs/` folder that listed its gaps was deleted on 2026-10-05 in cloudflare/cf#208, and two of those gaps were already stale on launch day; they are below.

**Goal:** `apps/nebula` declares its Worker in a typed `cloudflare.config.ts`, and our scripts, the `/live` harness and the vitest-plugin lane all read that file instead of `wrangler.jsonc`.

**What it buys:**
- **`apps/nebula/scripts/local-config.mjs` goes away.** It builds the config a local stack boots from by commenting `routes`, and for a container-free boot `containers`, out of `wrangler.jsonc` with a regex. Inside `defineConfig(({ mode }) => …)` each is a check on `mode`.
- **The config type-checks.** Bindings come from typed helpers such as `bindings.durableObject(…)`, so an agent editing the file gets the language server's errors. It is ADR-001's bet, applied to config.
- **Every operation in Cloudflare's API becomes a command**, about 3,000 against wrangler's 280, with JSON output by default and `cf cli search` to find one from a sentence.

**What blocks it today** (checked 2026-10-08 against `cf` 1.0.0-beta.13 and wrangler 4.147.0):
- **Our `@mesh()`-decorated methods under the Vite build.** `cf` builds with the Cloudflare Vite plugin, and Rolldown passes TC39 decorators through untransformed while still exiting 0; Oxc's transform is still an open issue, oxc-project/oxc#9170. Both UI surfaces already carry `unplugin-swc` for this, but nobody has measured it on the Worker's own build. Until someone does, `cf` hands a Worker that needs esbuild back to wrangler for dev and deploy, which is the path the 18 months run out on.

**What it costs:**
- **The `/live` harness is built on `wrangler dev`.** `drive.ts` boots one per scenario, reads its output, and fingerprints the tree it reloads on save. A Vite dev server changes all three, so switching to `cf` ends with a `drive.ts all` sweep and a deployed pass.
- **A second package pins `miniflare` exactly.** `cf` 1.0.0-beta.13 pins `5.20261006.0-alpha` and `@cloudflare/vitest-plugin` 1.3.6 pins `5.20261001.0-alpha`, so today they disagree. The two are chosen together from then on, or local dev and the vitest-plugin lane run different workerd builds (`packaging.md` § *Toolchain bumps*).
- **`critical.md` is written against wrangler.** Its `Env` rule runs `wrangler types` into `worker-configuration.d.ts`, its compatibility-date rule is stated per `wrangler.jsonc`, and its secrets rule names `wrangler.jsonc` and its `vars`. Each changes with the format.

**Not blockers, though both were reported as blockers on 2026-09-28:**
- **Type generation.** `cf workers types` writes `.cloudflare/types/index.d.ts` from `cloudflare.config.ts` alone, with the runtime types included by default. It has been in `cf` since its first public commit, so `npm run types` has a direct replacement.
- **Secrets.** `wrangler secret put` takes `--name <worker>` in place of reading a config, and `deploy-test.sh` already passes `--name test-nebula`; only the hint `deploy.sh` prints leaves it out. `cf` writes Worker secrets too: its generated `workers secrets update` and `bulk` commands call `PUT …/workers/scripts/{worker}/secrets`, added on launch day in cloudflare/cf#6.

`cf` can list and query Durable Object namespaces but has no command to delete one, so `workflow.md` § *Experiments* keeps its dashboard-delete rule. That touches experiment cleanup, not adopting `cf`.

**Trigger: a deadline, not demand.** The 18 months start when `cf`'s beta ends, and `cf` is moving fast: beta.13 shipped on 2026-10-07, ten days after launch. The first step is one spike, any time after pre-alpha: build `apps/nebula`'s Worker in `experiments/` with the Cloudflare Vite plugin and `unplugin-swc`, then call a `@mesh()`-decorated method on it. If the decorators survive, what is left is cost.

## Item 13: A person with no name is asked for one

**Moved here from [nebula-pre-alpha.md](nebula-pre-alpha.md) on 2026-10-09 (Larry), because nobody in pre-alpha reaches it.** A Profile nobody has written answers with the empty profile and a fixed never-written `eTag`, and a page watching it subscribes again at its next new socket, or at once after its own write ([archive/mesh-gateway-routes-client-calls.md](archive/mesh-gateway-routes-client-calls.md), its D5 and D7). This item is what would tell the person their name is missing.

**Who can reach a never-written profile, and what covers each without this item:**
- **A real person names themselves before their first session.** Both consent surfaces, `MagicLinkScreen` and `ConsentModal`, keep Accept disabled until a nickname is filled in (`canAccept` in `apps/nebula-studio-ui/src/auth/home-logic.ts`). Both run on the platform host, so a tenant user of a generated app passes one too.
- **A person whose display-name write failed at consent** is asked again by the next consent card they see. `settleAcceptance` logs the failure and carries on; the next card reads the empty Profile and holds Accept until a nickname is typed. That card comes at their next magic-link login, within the refresh cookie's 30 days, or with their next invite.
- **A persona is named by provisioning**, written as that persona ([nebula-testing-with-personas.md](nebula-testing-with-personas.md) § *Decisions*). A persona never sees Studio, only the generated app.
- **The harness accepts with a nickname**, as the consent screen does. The personas build carries that change.

**The design, as far as it got:**
- **Studio:** on finding its own profile never written, it opens the profile form, with *Remind me later*, which asks again at a later visit. Saving it is the first write: the person's own page shows it at once, and another page watching that profile picks it up at its next new socket or reload.
- **Generated apps: undecided, on purpose.** The choice is whether the guidance teaches the model to ask, or the scaffold ships the prompt as our code. Today `website/docs/nebula/api-reference.md` says only that the owner edits their profile "via a separate write path" and never names `updateMyProfile`, so no generated app writes a name.
- **If an empty byline is ever reported, write the Profile earlier, before anyone else reads it.** Studio could require a name on the way into the chat rather than offer *Remind me later*, and the codegen model could then be taught the same. A Client that re-asks on a timer was weighed and declined (Larry, 2026-10-09).

**Triggers — either one reopens it:**
1. **[nebula-pre-alpha.md](nebula-pre-alpha.md) § *Shared pages* lets an app run its own login page that collects no nickname.** Real people then reach a generated app without passing our consent card, and the rare case becomes the common one. That row could instead require a nickname on that path, which keeps this item dormant.
2. **A pre-alpha user sees a blank name.** `nebula-pre-alpha.md` § *③ Capture live* is where it would show.

## Item 14: A change travels as a merge patch, not a full value

**Added 2026-10-14 (Larry): the format is a pre-alpha must-have, sending patches is not.** [archive/structured-clone-patches-small-and-exact.md](archive/structured-clone-patches-small-and-exact.md) made stored values patch small and exact, built 2026-10-14, before ⑥ the wipe. This item is what then uses it: the org tree's fanout and a resource's reads send a patch from the version the client holds, where today they send the whole value. The plan, the eTag chain it keys on and its open questions are in [on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md), which becomes this item's task file when it goes active.

**The protocol carries `diff`'s three answers** ([archive/structured-clone-patches-small-and-exact.md](archive/structured-clone-patches-small-and-exact.md) § *Design intent*, rule 8): nothing changed, a list of patches applied in order, or the full value, which goes out as the existing full-snapshot message. A patch does not keep a plain object's key order, so a patched copy and a fresh read can order its keys differently.

**A stored value can travel without being decoded and re-encoded (Larry, 2026-10-14).** Today a read decodes `Snapshots.value`, wraps it with the snapshot's `meta`, and mesh re-encodes the whole message, once per subscriber on a broadcast. Measured in Node on a 41 KB value: 0.12 ms to decode and 0.18 ms to re-encode per message, against about 0.001 ms to splice the stored text in. The direction: a structured-clone tag that marks a nested encoding, whose `$ref` pointers are rooted at itself, which the format task makes true of every stored value. The server then passes the stored text through, and only the client decodes it. `JSON.rawJSON` cannot do the splice, since it accepts only primitive JSON text. The same stored text is what an MCP Events payload would carry as an opaque value.

**A broadcast is encoded once, and every subscriber gets the same frame (Larry, 2026-10-14).** Resources already sends every reader of a resource one continuation (`#broadcast` in `packages/resources/src/resources.ts`). Mesh's `broadcastShared` then makes one `lmz.call` per target, and each call runs `preprocess` on its own chain, so the same snapshot is encoded once per subscriber. Encoding the chain once and handing every target the result is a Mesh change. A subscription assumes its client is current: a client whose eTag does not match the base of what arrives sends a read with its last eTag and gets back a patch bridging the versions it missed. ⚠️ The coalescing window overwrites a same-actor version in place within the hour (`#writeSnapshot` in `packages/resources/src/snapshots.ts`), so the base a lagging client names may no longer be stored, and that read answers with the full value.

**Consider: an order column so the org tree rebuilds in creation order (deferred here by Larry, 2026-10-14).** `#buildState` in `packages/resources/src/org-tree.ts` reads `Nodes`, `Edges` and `Permissions` with no `ORDER BY`, so rows arrive in primary-key order and a new random `nodeId` lands mid-Map. A patch keeps a Map's order ([archive/structured-clone-patches-small-and-exact.md](archive/structured-clone-patches-small-and-exact.md) § *Decisions*), so each new node then sends the full tree. What was weighed for the fix:
- **The column.** A monotonic ULID from `ulidFactory({ monotonic: true })`, which Larry approved adding to `packages/resources` as a dependency. It needs no read on insert and survives a Star being cloned or imported; `seq = MAX(seq) + 1` and ordering by `rowid` were weighed and rejected.
- **The catch.** Ordering `Permissions` rows by their own column leaves the outer `permissions` Map following each node's earliest surviving grant, so revoking that grant can reorder it and resend the whole tree. The state wants reshaping too, for example one flat Map keyed by `nodeId:sub`, as edges already are.
- **It may not be needed.** If the tree becomes one Resource row (Option A in [on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md)), the column is never read.

**Consider: measure SQLite's `json_patch` against our `applyMergePatch` where the server applies a patch it receives (Larry, 2026-10-14).** Both apply the same standard patches, and `diff` and `applyMergePatch` are already ours, dependency-free, and exported from `@lumenize/structured-clone`. SQLite has no diff, so `diff` stays JavaScript either way. The comparison is CPU per write in a Durable Object, against a write path that may decode the merged value anyway to validate it.

**Trigger:** a full resend that costs something a user notices, such as a large org tree on every grant, or a resource read that usually comes back unchanged. A third consumer is the MCP Events prototype on [backlog.md](backlog.md)'s MCP Events row, which would deliver a resource change as one patch.
