# Nebula Pre-Alpha Fast-Follow

**Status**: Drafted, not started — the **parent index** for the reactive "next" horizon: platform capabilities the first real user-developer apps will demand beyond the core codegen + data + chat loop. Not a build commitment; each item is `/review-task`'d before "go" and picked up **as user demand surfaces**. Linked from [`nebula-pre-alpha.md`](nebula-pre-alpha.md). Real child task files are spun **one at a time** when an item goes active — never pre-created as stubs. (Item 3 already has its own file; Items 1–2 are homed here until they go active.)

**Provenance**: Items 1–2 surfaced 2026-07-02 from the first user-developer spec — Jennifer's [Luminize Almanac vision/requirements/data-model](https://docs.google.com/document/d/1P_YF2qVwQSAFYvg43qCvj3Nc170zBkpBboG8kcjdBGc/edit) and her companion [UX brief](https://docs.google.com/document/d/10UZ5KaZJXG2MdaHTwA2UPGrFKM_daGDdJaSbg6wGeFo/edit). Review lens was "what does this spec teach Nebula," not spec QA (see the `nebula-pitch-deck` memory for the full findings).

## Objective

Close the platform gaps that stand between the current live loop and real user-developer apps existing and thriving — picked up reactively, in demand order.

## Item 1: User-app media storage (photos/blobs)

> ⚠️ **Placement open — may be table-stakes, not fast-follow.** The Almanac's atomic unit (`Entry`) *requires* photos ("the app cannot exist without this"), so media may belong **earlier** — Invite-gated or Wave-2 in [`nebula-pre-alpha.md`](nebula-pre-alpha.md) — rather than in this reactive post-core bucket. Decide at `/review-task`.

**Goal**: A user-developer's generated app can accept, store, and serve end-user-uploaded media (photos first), governed by the same ReBAC/DAG access control as every other resource.

**Why now-ish**: The Almanac's atomic unit (`Entry`) *requires* one or more photos — the app cannot exist without this. Media is likely table stakes for a large share of domain-expert apps (the persona thinks in photos, documents, and artifacts, not rows).

**Shape (to be designed, not pinned)**:
- R2-backed blob storage surfaced as a platform capability, not raw R2 access (homogeneity: no per-app infrastructure divergence).
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

**Success criteria (sketch)**:
- [ ] A user-developer can name and style their app's assistant from the Studio.
- [ ] Persona config cannot widen data access or override platform-level chat guards (capable-of-failing test: a persona instruction attempting to read out-of-scope data does nothing).
- [ ] Behavioral constraints from the spec (tone, no-gamification-style rules) demonstrably shape chat output.

## Item 3: Outside-world connectivity (`fetch` / email / search / webhooks / cron)

**Full design + phased build plan lives in its own file**: [`nebula-outside-world.md`](nebula-outside-world.md).

The **substrate-not-primitives** thesis: Nebula builds a thin secure substrate (secrets vault, app-server facet runtime, egress broker, ingress router, scheduler, security stdlib) and the Studio agent writes integrations (email, payments, Slack, search) as ordinary app code. Spikes proven + mutation-checked; gated on `/review-task`. Demand order **`fetch` → email → search → secrets-last**. Also homes the Wave-3 inbound `claude@` email exercise noted in [`nebula-pre-alpha.md`](nebula-pre-alpha.md).

## Item 4: The prod ontology install path

**Placed here 2026-08-21**, out of [`nebula-galaxy-collapse-and-chat.md`](nebula-galaxy-collapse-and-chat.md), which had deferred it *to itself* and then scheduled no phase for it. Not pre-alpha: the only Stars in the pre-alpha loop are `.dev` Stars, which the **dev push** (`Star.setOntology`) already installs to, and a Star the Galaxy never pushed to exists only once an app is published or a tenant signs up — the publish path, which the staging ladder puts in **alpha**.

**Demand trigger:** the first pre-alpha user who wants to show their app to someone.

**Goal**: an ontology reaches a Star the Galaxy did not push to, without a bespoke per-Star install step.

**Current state**: `getLatestOntologyVersion` exists on `Galaxy` but has **no `src/` consumer**, and `Star` makes no `lmz.call('GALAXY', …)` at all. `Star.setOntology` is `@mesh(requireDominionHere)` and is the one built install path.

⚠️ **Do not build a pull first — the shape is genuinely open, and that is the reason this is not scheduled rather than an excuse for leaving it vague.** Once one `Galaxy` owns both the ontology store and the install path, **push-on-append from the node that already holds the row may beat a pull** (Larry, 2026-07-25). Decide that before writing either.

**A candidate shape, carried over intact** — it was reasoned out at length and should not be re-derived from scratch:

- 💡 **Candidate shape — git as the transport (Larry, 2026-07-25).** Pull it into the container with **git** rather than shipping bundles: **commit per codegen turn**, the Galaxy's *shipped* version is a **tag**, and a **triggered pull** promotes the dev version into the `.dev` Star at the end of each LLM response. Deltas instead of whole artifacts, and "which version is live" becomes a git ref rather than bespoke state. Fits what is already here — `isomorphic-git`/Workspace ops are named as on-DO-thread work below, and `@cloudflare/shell` + isomorphic-git are proven to run under pool-workers ([[shell-isomorphic-git-pool-workers]]).
  - **Repo-to-repo git, if we want it, is CONTAINER-side.** Real git on real Linux does local-path remotes, so `git clone /workspace/app /workspace/build` + `git -C /workspace/build pull ../app` needs nothing external. ⚠️ **Host-side `file://` is permitted but unproven** — `git/cli.ts`'s `isSupportedTransport` allows it and the docs claim it, but `git/network.ts` passes `http:` to isomorphic-git for every network op and **no test anywhere mentions `file://`**; upstream isomorphic-git has no local transport. Treat it as broken until measured. ⓘ **MOUNTS are BUILT, with one provider — corrected 2026-08-03 against the installed package.** `docs/01_vfs.md` marks the whole mount subsystem **(planned)**, but `@cloudflare/computer@0.1.1` ships `WorkspaceOptions.mounts`, `Workspace.mounts()` and `ensureMountsIndexed()`, and the vendor's own container example mounts a bucket at `/workspace/r2`. **`R2Bucket(binding)` is the only shipped provider** (read-only — writes under the root reject `EROFS`), plus a `MountFactory` seam for custom ones; there is no git/GitHub provider. ⚠️ **Their docs lag their code — verify against the installed `.d.ts`, not the doc.**
  - ⏳ **What Artifacts would still buy (none on this task's critical path; still closed beta 2026-08-03):** (1) history **off the DO** — the repo currently sits in Galaxy's SQLite, under ADR-018's 10 GB ceiling and the cold-start-scales-with-size worry below; (2) a **real remote for BYO-agent** (`archive/nebula-studio.md` § *Enterprise BYO-agent*) — the one case that genuinely needs a git server; (3) **`fork`** on a repo handle, which makes scaffold provisioning a server-side op that carries the scaffold's *history*, so a later scaffold upgrade is a **merge** rather than a bespoke diff-and-patch (⚠️ **undocumented whether `fork` is copy-on-write or a byte copy** — decides whether N tenants each bill against 10 GB/repo, 1 TB/account; ask on the beta form); (4) **export** as a clone URL. Consistent with `reference/nebula-dev-flows.md` **Decision 6** (Artifacts as an optional future optimization behind the same free seam).
  - ❓ **Still open:** the Star consumes a *compiled validator bundle*, not source — so decide whether git carries the source (Star or container rebuilds) or the built artifact.

**Six tests are skipped on this, and they should NOT wait for it.** Five browser benchmarks plus `chromium/conflict-modal` fail only because a fresh `uniqueStar()` has no ontology installed — not because they need a *pull* specifically. Their skip comments say "Un-skip when the prod lazy-pull lands", which fused two different problems. `apps/nebula/src/index.ts` already advertises helpers that apply an ontology via `Star.setOntology` **without a Galaxy round-trip**, and `setOntology` is reachable by an admin-scoped caller — so their setup can install one directly. ⚠️ Confirm first that `conflict-modal` merely *needs* an ontology present rather than testing `ontology-stale` behaviour itself; its own comment says the verdict contract "is unaffected", which reads as the former. Tracked separately in [`backlog.md`](backlog.md) § *Testing & Quality*.


## Item 5: The published-tier serve — shipped-tag `dist` for `/app/{u}.{g}.{s}/*`

**Placed here 2026-08-24**, out of the collapse's § *Serving* route table (its one ⏭️ deferred row). **Never in doubt — only deferred.** The same Galaxy `fetch` handler and `serve.ts` that serve `.dev`'s working-tree `dist/` serve every other star **`dist-prod/`** — **one published copy for all tenant stars** (a star slug is a tenant, e.g. `acme.invoicing.northwind-co`; per-star staged rollout is deliberately NOT a thing). Publish **copies** `dist/` to `dist-prod/` and commits (Larry's split-`dist` shape, 2026-08-24), so the serve path never reads through git and both tiers ride the same `getFile` seam; **the publish commit — and the shipped ref pointing at it — is provenance, not the serving mechanism**. Nothing extra rides the copy: the artifact **self-describes** — the ontology label is baked into the build (`serve.ts` does no templating, so serve-time injection is not even possible), and publishing is deterministic Galaxy code, so no write-guard is needed on `dist-prod/` (the LLM's `write_file` scope is the app source — a different risk class from the ontology history file, which the LLM must edit). *(The earlier tag-lookup serve was superseded by this — reading blobs at a ref on every request was the complexity this deletes.)*

**Demand trigger:** the same as Item 4's — the first pre-alpha user who wants to show their app to someone — and the two land together: a published Star needs its ontology (Item 4) and its `dist` (this) at the same moment.

⚠️ **If user-dev source-privacy demand appears, the gate design restarts HERE, under two recorded constraints** (Larry, 2026-08-24): **no cookies**, and browsers send no `Authorization` on document or sub-asset loads — which together likely mean the serve itself is never gated (a published app's END USERS need `index.html` before they can log in), and privacy comes from something else if it comes at all.

⚠️ The **scale** mechanisms — edge cache, the release herd, R2 as an escalation — are NOT this item's: they are decided by measured experience, and live in [backlog.md](backlog.md) § *Future bigger things*.

## Item 6: Mid-generation chat UX — the two-stage arrival pipeline

**Moved here from the backlog 2026-08-24** (it is near-term, with a demand trigger — not a someday row). Pre-alpha the codegen trigger is **single-flight** and a mid-generation post just sits in the thread (collapse Phase 4); Larry judges that unacceptable UX beyond pre-alpha.

**Demand trigger:** the first multi-user session that hits the single-flight floor in anger.

**Target sketch:** a **two-stage arrival pipeline**. Stage 1 — EVERY message runs the fast **discriminator** (the collapse's two-LLM-calls Decisions row) on arrival: cheap enough to block on, or its own short queue. Stage 2 — only a "Nebula must respond" verdict enters the **codegen queue**: empty → run; busy → prompt the author — *"interrupt Nebula's thinking, or queue this for after?"* **Cancel lives on the streaming response.**

**Couplings:** the respond-or-not policy + `@`-mention control ride the same classifier and land with this; cancel must ride the container teardown order — let the sync bracket resolve, `destroy()`, tolerate the 1006 — and release the residency hold (both pinned in the collapse's Phase 3).

## Notes

- A third finding from the same Jennifer analysis — **cross-document spec-drift detection** (her two docs contradict each other: photo-first-required vs text-first capture) — is deliberately *not* an item here: it's a Studio/coach-loop capability question that needs its own framing, and the coach loop covers it manually during alpha. Revisit when the Studio eval suite resumes.
- None of these jump the queue: the active pre-alpha branch work (per [`nebula-pre-alpha.md`](nebula-pre-alpha.md)) remains the priority; these are picked up reactively on user demand.
