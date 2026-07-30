# Custom client dependencies resolve in the browser, not in the build

**Status**: Designed 2026-07-30 (conversation with Larry, this session). **NOT reviewed — `/review-task`
Stages 1 and 2 are deliberately deferred as premature**, and the `/write-task` intent gate was skipped at
Larry's direction; read *Design intent* first when this goes active. On-hold: designed, paused, expected to
resume when a user-developer needs a package outside the baked set. **Pinned business decision (2026-07-30):
the dependency set is OPEN — any npm package is fair game, with warnings and no curation.** Fires the trigger
on [`use-lumenize-dev-domain-and-support-custom-domains.md`](use-lumenize-dev-domain-and-support-custom-domains.md)
(see *Relationships*).

**Objective — a user-developer's generated app can use any client-side npm package, without the build ever
installing it: the browser resolves it from an ESM CDN at page load.**

## Context and current state

**Built already:**

- **The DevContainer bakes a curated dep set and installs nothing at runtime.** `apps/nebula/container/app/package.json`
  pins `vue` / `daisyui` / `lucide-vue-next` plus the build chain (`vite`, `@tailwindcss/vite`,
  `@vitejs/plugin-vue`, `typescript`); the Dockerfile's `RUN npm install && npm cache clean --force` bakes them
  into the image layer. Both files carry the same standing note — a **non-baked** package *"is the only thing
  that would need runtime egress (deferred; deps are fully baked for the demo)."*
- **The preview is a vite dev server behind the DO proxy.** `vite.config.ts` reads `PREVIEW_BASE` into `base`;
  the container's command-server owns the vite child and can restart it.
- **A container-free compile gate runs per codegen turn.** `codegen-gate.ts`'s two-pass SFC gate transpiles with
  `@vue/compiler-sfc`, then semantically type-checks `<script setup>` with `checkTypeScript` against the
  synthesized `NEBULA_API_DTS`. It runs in the Worker, with no container and no AI binding.
- **The shell HTML already has a serve-time `<head>` injection seam.** `injectScopeMeta` does
  `html.replace('<head>', …)` and is pure so the injection is unit-testable.
- **Pushed source is guarded by path *shape* only.** `assertSafeRelPath` rejects an absolute path and any `..`
  segment; it does **not** restrict which files the app layer may write.

**Missing:**

1. Any path by which a generated app can use a package outside the baked set.
2. A resolution story for a dependency that is not in `node_modules` — in the vite dev preview *and* in the
   `vite build` that runs at publish.
3. Compile-gate handling for an import the gate cannot resolve; today it is a hard `ok: false`.
4. Studio-LLM guidance for emitting a conforming import, and for the footguns a user-developer cannot see by
   testing.
5. A recorded position on third-party script origins in the generated app's page.

## Design intent, constraints, and future state

**The contract: a user-developer's *runtime* dependencies are resolved by the browser from an ESM CDN, and the
build never installs them. *Build-time* dependencies stay platform-owned and baked into the image.**

The split is at build-time-versus-runtime, and that is the invariant — not a judgement about which packages are
safe. **Build-time code executes with container privileges; runtime code executes inside the generated app's own
browser trust boundary, which is the boundary the user-developer already owns.** So a vite plugin or a postcss
transform is the platform's to decide and bake, while a charting library is the user-developer's to choose. An
open runtime set follows from where the code runs, not from a curator's confidence in it.

Load-bearing claims, stated so review can falsify them:

- **vite leaves `http(s)://` imports alone.** In dev its import analysis does not resolve or pre-bundle them, so
  the browser fetches directly with no configuration; at build, rollup externalizes them and warns. A **bare**
  specifier does not have this property — it resolves from `node_modules` and hard-fails when absent.
- **The container therefore needs no egress for dependencies.** Its `node_modules` is frozen at the baked set,
  permanently rather than for the demo, and the deferred `interceptHttps`/CA-trust work is not needed for this.
- **Dependency count leaves the codegen loop entirely.** Nothing installs, and rollup does not bundle an
  external — so neither half of the growth from one dependency to many (the install, *or* the build, which is
  70–90% of the time) scales with how many packages the user-developer adds. The loop stays on the `dep=0` path
  at any count. This is the claim the task rests on, and it is qualitatively different from saving seconds: it
  removes a variable rather than shrinking one. ⚠️ The cost moves to the end user's page load — paid once per
  browser and then cached, but real. The old model *disciplined* dependency count by making it painful, so
  removing the pain removes the discipline; that is why payload guidance (Phase 4) matters more here, not less.
- **The compile gate is the only surface that hard-fails a CDN import** — not vite, which is the permissive one.
- **Third-party runtime code in the page is attacker-authorable**, because anyone may publish to npm. The
  containment for that is **origin separation**, not CSP: an origin-allowlist CSP naming a public CDN is close to
  `script-src *` in practice, since these CDNs serve arbitrary files from any package, repo, or gist.
- **A CDN import is the same trust decision as `npm install`**, so it earns no more ceremony than `npm install`
  got. The one respect in which it is genuinely weaker: an **unpinned** URL has no lockfile equivalent and its
  bytes can change under a deployed app. A version-pinned URL closes that gap.

**Constraints:**

- The `nebula-governance-practices-not-gates` memory binds the posture: warn with decision-grade information and
  proceed; only the substrate is non-overridable. This task adds no approval step and no allowlist.
- `.claude/rules/ui-theming.md` binds the styling interaction: a CDN library shipping its own colors fights the
  daisyUI theme, so guidance should prefer headless or self-styled libraries — as advice, not enforcement.
- `.claude/rules/containers.md` describes the container surface this freezes.
- **An ADR is owed at implementation, not now** (see *Phase 5*). It would carry an always-loaded one-liner in
  `workflow.md`, and a commitment about unbuilt work taxes every session that loads it.

**Future state:**

- ⚠️ **Design consideration:** a Nebula-hosted proxy that fetches once and pins bytes would buy reproducible
  builds, byte integrity, and independence from a third party's uptime. It is deliberately not built — but emit
  the CDN origin through **one constant**, so adopting it later is a single edit plus a regeneration, never a
  sweep through generated app source.
- ⚠️ **Design consideration:** esm.sh returns an `X-TypeScript-Types` header pointing at a package's real `.d.ts`.
  That would upgrade the gate from permissive-shim to genuine checking **on an open set, with no curation**. Shape
  the gate's shim path so that swap does not require re-deciding the gate's structure.
- ⚠️ **Design consideration — CF Container disk snapshots may reopen this, and settling it needs an experiment,
  not a reading of the announcement.** Snapshots (announced in CF Discord #containers-beta 2026-06-18, unshipped
  as of 2026-07-20 — see the row in `tasks/backlog.md`) persist a container's disk across sleep/wake, which would
  make a user's `node_modules` survive and reduce `npm install` to once per dependency change rather than once
  per cold start. That kills the *conditional* half of the rejection above. **It does not touch the durable
  half:** dependencies must be installed *somewhere* before there is anything to snapshot, so container egress is
  still required, and an installed dependency still gets bundled by rollup. Nobody can predict the shape from the
  announcement, so an experiment must answer: is persistence per-directory or whole-disk; does a **baked-image
  bump invalidate a snapshot** (if so, every user-developer re-installs on every platform deploy); what does
  restore cost at a *realistic* tree — 200 MB+, not the 84 MB curated one; is there **per-tenant storage
  billing**, which the browser-resolved path does not have at all; and does any of it engage under local
  `wrangler dev` (the question `experiments/container-egress-catrust` had to ask about interception, with the
  same stakes for the dev loop). ⚠️ **Re-measure the build share on the current toolchain before running any of
  that** — the 70–90% figure is Vite 6 + Rollup, the container is still pinned at `vite ^6.0.7`, and a Rust
  bundler moves the registry pull to the long pole, which is precisely the term snapshots address. Get that
  number first or the snapshot comparison is run against a stale baseline. ⚠️ Then re-derive rather than
  reverting on reflex: a snapshot restores *state*, and what this task rests on is that dependency count leaves
  the loop — restoration does not deliver that, and the egress surface stays either way.
- ⚠️ **Design consideration:** the whole reason a container exists is `node_modules` and the build chain. This
  removes dependency egress and per-tenant mutation from that list, which sharpens the "stateless build-box"
  direction in the `keep-container-native-tide` memory. Do not build toward container removal here; just avoid
  re-coupling deps to the container.

**Open questions** (each gates something below):

- **OQ-1 — where is the CDN URL minted?** The conversation converged on two things that are in tension: *the LLM
  emits imports and never touches build config* (so app source carries the full URL), and *peer-dedup must live in
  the platform, never in the model's head* (so something other than the model must add `?external=vue`). Two
  candidates: **(a)** the model emits a declarative dep list and the platform mints URLs plus an import map, with
  app source keeping bare specifiers; **(b)** the model emits full URLs and the platform **normalizes them at the
  push boundary** — pinning the version, adding externals for every baked peer. (a) costs a per-app vite config
  and a restart; (b) rewrites user-visible source, which is more surprising. **Gates Phase 3's shape.**
- **OQ-2 — which CDN is the default emitted origin?** esm.sh (converts CJS to ESM, so coverage is effectively all
  of npm) versus jsDelivr `/+esm` (also serves GitHub). Both resolve sub-dependencies, which is the property that
  matters. **Gates Phase 1.**
- **OQ-3 — does this ship before or after the `lumenize.dev` origin move?** Shipping first puts attacker-authorable
  code in a page on the control plane's registrable domain, which is the cookie-tossing vector that file exists to
  close. **Gates the whole task's placement in the milestone, not any single phase.**

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| Runtime deps resolve in the browser from an ESM CDN | `npm install` in the container. **Durable reason:** it needs runtime egress (`interceptHttps` + CA trust + an npm-registry allow-list), which is a security surface and a maintenance surface, not a speed one. **Durable in direction, shrinking in magnitude:** an installed dependency still gets **bundled**, and an external does zero work — but the *"bundling is 70–90% of the time"* figure measures Vite 6 + Rollup, and a Rust bundler (Rolldown) compresses it, so do not carry that number forward as if it were an invariant. **Conditional:** CF containers have no persistent volume today, so every cold start pays the full cold path — ⚠️ expires if disk snapshots ship (see *Future state*) |
| The set is open — any npm package | A curated catalog — friction against a surface the user-developer already trusts at npm's level; per-package curation does not scale, and a user-developer tests before publishing |
| esm.sh or jsDelivr `/+esm` as the source | cdnjs — a curated ~4k list (narrower than npm, so *worse* for an open set) that serves files verbatim, leaving an ESM file's bare-specifier sub-dependencies unresolvable in the browser |
| ESM imports | `<script>` tags with UMD globals — forces per-package global names into the model's head, and `window.X` is untyped, so the gate checks none of the least-familiar code |
| A third-party CDN origin, allowlisted in CSP if a CSP is ever added | A Nebula-hosted proxy — real gains (byte pinning, reproducibility, uptime independence) but they are deferrable, and the migration later is one origin constant |
| CSP widening, when it happens, is **data-plane only** | One CSP policy across both planes — `nebula.lumenize.com` (Studio, auth, gateway) stays strict; the allowlist question only ever applies to the origin serving generated apps |
| A version is required in every emitted URL | An unpinned or `@latest` URL — no lockfile equivalent, so bytes can change under a deployed app; this is the one axis where a CDN is weaker than npm |
| The model emits imports only, never build config | Letting the model edit `vite.config.ts` or `index.html` — those carry `base`, the `#app` mount point, and the literal `<head>` that `injectScopeMeta` replaces; breaking any of them yields a blank preview, which reads as a platform failure rather than a dependency mistake |
| Build-time deps stay baked and platform-owned | Letting user-developers add vite/postcss plugins — they execute with container privileges, outside the trust boundary the user-developer owns |
| Peer-dedup is minted by the platform | Trusting warnings for it — a duplicate Vue instance breaks reactivity intermittently and is the one footgun a user-developer's own testing does not reliably surface |

## Phases

1. **A generated app uses a CDN-resolved package, in the preview and through publish.** Resolve OQ-2, emit the
   origin through a single constant, and drive one real package end-to-end.
   - **Success criteria (capable of failing):** the preview renders a component whose `<script setup>` imports a
     package by absolute URL; the `vite build` at publish completes and its output bundle does **not** contain
     that package's code while the emitted module graph still carries the absolute URL.
   - **Mutation note:** change the import to a bare specifier — dev resolution fails and the preview goes blank,
     reddening the first criterion; the second reddens if the dep is bundled instead of externalized.

2. **The compile gate accepts an unresolvable URL import without going blind.**
   - **Success criteria (capable of failing):** an SFC importing a URL specifier and *using* the binding returns
     `ok: true`; the same file with a genuine Nebula-API misuse (the `op: 'set'` class) still returns `ok: false`
     with a usable `errorTail`.
   - **Mutation note:** drop the ambient shim and the first criterion reds (TS2307). Widen the shim to blanket the
     whole file as `any` and the **second** reds — that pair is what stops the fix from being "type-check less."

3. **The platform, not the model, encodes the footguns a user-developer cannot see.** Resolve OQ-1, then mint or
   normalize URLs so every emitted dependency is version-pinned and externalizes every baked peer.
   - **Success criteria (capable of failing):** an app declaring a Vue-wrapper package resolves to a URL carrying
     an external/`deps` marker for `vue`, and the running preview reports exactly one Vue instance; an unpinned
     declaration is either pinned or surfaced as a warning carrying the resolved version.
   - **Mutation note:** remove the peer-externalization step — the one-instance assertion reds. Remove the pin
     step — the unpinned case passes through silently.

4. **Studio's LLM emits conforming imports.** Guidance into the platform-owned prompt tree and the Nebula docs
   (whose audience is Studio's LLM, per `nebula-docs-audience-is-llm`), covering: import shape, prefer headless or
   self-styled libraries, a Tailwind-classed library will render unstyled because the scanner cannot reach a CDN,
   CSS needs a `<link>` rather than an ESM import, and no tree-shaking so payload is worth a glance.
   - **Success criteria (capable of failing):** prompt fixtures asking for a charting library and for a
     Vue-wrapper library both produce imports that survive Phases 1–3 unmodified.
   - **Mutation note:** strip the dependency section from the prompt and the fixtures produce bare specifiers or
     `npm install` instructions, reddening both.

5. **Standing guidance describes the built system, and the retired plan is repointed.** Last, so nothing here is
   falsified by an earlier phase.
   - Write the ADR — **allocate the next free number at implementation time; do not pre-assign one here** — with
     *Alternatives considered* carrying both the npm-egress path and the note that
     `experiments/container-dep-install-bench`'s *"a registry proxy / R2 mirror can't win"* is about restoring
     `node_modules` container-side and does **not** apply to browser-served ESM. Add its one-liner to
     `.claude/rules/workflow.md` § Architecture commitments — an ADR without an index line is invisible.
   - Repoint the three live statements of the retired plan: the REFRAME bullet in `tasks/backlog.md`
     (*"what's missing is the decision to let a tenant container reach the npm registry"*), the out-of-scope entry
     in `tasks/nebula-galaxy-collapse-and-chat.md` (*"runtime dependency installs (gated on container EGRESS…)"*),
     and the twin comments in `apps/nebula/container/Dockerfile` and `container/app/package.json`. The
     **instruction** in those comments survives — deps stay baked — but the **reason** changes from "for the demo"
     to a standing commitment; per `calibration.md` § 4 a comment with a dead justification misleads even when its
     instruction is right.
   - Add the browser-resolved category to the baked-versus-pushed split in `tasks/reference/nebula-dev-flows.md`,
     and one pointer line in `.claude/rules/containers.md`.
   - **Success criteria (capable of failing):** no live file states that opening custom dependencies is gated on
     container egress; every ADR-conformance surface named above resolves to the new ADR rather than to a task
     file. **Do not touch** `tasks/archive/nebula-container-dev-loop.md` (archived, frozen) or any
     `experiments/*/RESULTS.md` beyond the dated pointer already added to `container-egress-catrust`.
   - **Mutation note:** revert any one repoint and the grep for the retired framing returns a live hit.

## Non-goals

- **Introducing a CSP header.** None exists today; the only trace is a `injectScopeMeta` comment reasoning about
  one. The *decision* about what a future policy allows is recorded above; writing the policy is not this task.
- **Self-hosting or proxying the CDN.** Recorded as a design consideration; deliberately deferred.
- **Build-time dependency extension** (vite/postcss plugins). Stays platform-owned by the intent's invariant.
- **The `lumenize.dev` origin move.** Owned by its own on-hold file; this task fires its trigger (OQ-3) but does
  not absorb it.
- **Container disk snapshots.** Unrelated mechanism; see *Relationships* for what this changes about that row.

## Relationships

- **[`use-lumenize-dev-domain-and-support-custom-domains.md`](use-lumenize-dev-domain-and-support-custom-domains.md)** —
  its own pickup trigger is *"we're about to host untrusted multi-tenant apps."* This task is what fires it: the
  preview page moves from code our LLM wrote to code anyone on npm wrote, while still on the control plane's
  registrable domain. Its summary calls the work "pure edge translation," so this is a dependency, not a blocker.
- **`tasks/backlog.md`** — the container-disk-snapshots row and this task point at each other, in **both**
  directions. If this ships first, that row loses its dependency-install premise and narrows to source
  persistence (it had already concluded snapshots are not worth adopting on the numbers). If **snapshots ship
  first**, they are the single most likely reason to reopen this task — so whoever picks up either one should
  read the other's *Future state* before deciding, and run the experiment described there rather than reasoning
  from the announcement. The **missing-lockfile row
  is strengthened, not obsoleted** — the baked set becomes permanent, so version float between image builds
  matters more, and the reflex reading ("deps are moving to a CDN, so who cares") is backwards.
- **`experiments/container-egress-catrust`** — kept, not deleted. This task retires only its *npm-registry*
  motivation; its real target was `*.artifacts.cloudflare.net`, so the CA-trust recipe still serves the future
  Artifacts `git pull` the Dockerfile anticipates. A dated pointer was added to its `RESULTS.md` on 2026-07-30.
- **`tasks/on-hold/nebula-offline-prompt-harness.md`** — Phase 4's fixtures are that harness's shape; check
  whether it should own them before building a parallel path.
- **`tasks/nebula-studio-self-improvement.md`** — a dependency the model reaches for and gets wrong is outcome
  signal for the scaffold; this task produces that signal but does not consume it.
- **Measurement — and the gap in it.** `experiments/container-cold-start-probe` measured on real CF that
  `vite build` is **70–90%** of every scenario, the baked path is **8–10 s**, and the user-dep path is
  **11–33 s**. ⚠️ **Every user-dep number there and in `tasks/backlog.md` is `n=1`** — the probe's `dep=1` arm
  adds a single package (`echarts`), and the backlog's 1–4 s figures are six *separate* one-dep measurements.
  **No experiment has measured a realistic multi-dependency tree.** The only multi-package anchor is
  `container-dep-install-bench`: the curated tree at **62 packages cost 20.1 s** cold at ½ vCPU — and CF has no
  persistent volume, so every cold start is that cold path, never the 5.1 s warm one. Since **package count
  beats bytes** (tiptap alone is 52 packages), a user-developer with three or four real libraries plausibly
  exceeds the whole curated tree. ⇒ **do not cite ~2–6 s as the install cost**; it is the `n=1` figure and
  understates the case this task rests on. An `n=4` arm is cheap and would replace the extrapolation with a
  number.
