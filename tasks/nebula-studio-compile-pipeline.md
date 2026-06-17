# Nebula Studio — Client-bundle Compile/Deploy Pipeline (build-seq #1)

**Status**: Ready for `/review-task` → `/build-task`. Plan derived from the Kimi-UI-gen-viability investigation (2026-06-16).
**Phase**: Studio build-seq #1 (first — unblocks the rest of Studio).
**App**: `apps/nebula/` — **Mesh platform layer**: never raw primitives; solve raw needs via a mesh hook (`.claude/rules/mesh.md`, `durable-objects.md`).
**Parent**: `tasks/nebula-studio.md` (§ *Build sequencing* #1, § *Dev-mode Star*, § *Architecture*).

**Prerequisites (built):**
- dev Star — `tasks/dev-star.md`: `DevStar extends Star` with `deployToDev()` (eager ontology apply) + `resetDevData()`.
- Galaxy ontology version registry (`appendOntologyVersion` / `getLatestOntologyVersion`, `compileOntologyVersion`) + the Star lazy cache-miss apply path (`star.ts` `#installState` / `applyFetchedState`).

**Proven groundwork (Stage A of the viability spike):** `apps/nebula/spike/sfc-devstar-loop/src/compile-module.ts` — `compileSFCToModule()` (`@vue/compiler-sfc` macro resolution → `typescript` transpile → module assembly), tested in `test-node/compile-module.test.ts` (mutation-checked). The spike also holds the `@vue/compiler-sfc` compile + hibernating-WS reload-broadcast pattern to port (see its `RESULTS.md`).

## Goal

Wire the Studio dev loop's compile→bundle→deploy path: compile `.vue` SFCs in the **dev Star** → publish the compiled UI bundle to the **Galaxy, versioned alongside the ontology** → lazy-pull to Stars via the **same cache-miss mechanism the ontology already uses**. This wires the compile→bundle into the Galaxy/Star deploy path that nebula-frontend §5.3.7-v5 punted to "Studio's deploy work."

## Hard constraint (carry into every phase)

Raw `import ts from 'typescript'` **crashes the workerd isolate** ("Worker exited unexpectedly") — verified in the spike. So the transpile step cannot import tsc directly inside a DO. **Bundle tsc for workerd via the validator's proven pattern** — `packages/ts-runtime-parser-validator/scripts/bundle-tsc.mjs` (its header is the canonical doc; emits `dist/deps.bundle.mjs`). The `compileSFCToModule` logic is identical regardless of where tsc runs — only the import path changes. (`@vue/compiler-sfc` itself runs fine in workerd — proven by the spike's kill-criterion test.)

## Phases

### Phase 1 — Productionize the compile pipeline into `DevStar`
Port the proven compile logic + the spike's reload-broadcast into `apps/nebula` and run it in the dev Star DO.
- Port `compileSFCToModule` into `apps/nebula` (a helper module `DevStar` imports), with **tsc bundled for workerd** (bundle-tsc pattern). `@vue/compiler-sfc` + `typescript` become `apps/nebula` deps.
- Add the compile method on `DevStar` (`@mesh()` so Studio's client calls it via `lmz.call`); port the hibernating-WS reload-broadcast (preview clients subscribe to a reload signal; compile triggers broadcast via the existing Subscriber/`svc.broadcast` machinery — no separate WS pool).
- **Success criteria:** a `.vue` SFC (incl. `lang="ts"`) compiles to a runnable ESM **inside the DevStar DO** (pool-workers test), residual TS stripped; a reload broadcast reaches a subscribed preview client. The tsc-in-workerd bundling that crashed on raw import is verified working.

### Phase 2 — Galaxy bundle versioning
Publish the compiled UI bundle to the Galaxy, versioned in lock-step with the ontology.
- Extend the Galaxy append-only registry to store the compiled bundle alongside each ontology version (parallel to `appendOntologyVersion`, or a combined app-version record). `getLatest*` returns the bundle with the ontology version.
- **Success criteria:** publishing version N stores ontology + bundle atomically under N; `getLatest` returns both; version numbers stay in lock-step.

### Phase 3 — Star lazy-pull + serve
Stars pick up the bundle via the same cache-miss→getLatest path as the ontology, and serve it.
- The bundle rides the existing cache-miss continuation (`star.ts` → `getLatestOntologyVersion` → `applyFetchedState`); extend `#installState` to also install the bundle.
- Serve the bundle (web-server-like: MIME types, CSP allowing `unsafe-eval` for template compilation, routing). Decide the serving surface (Galaxy- vs Star-hosted — see nebula-studio.md § *Studio UI hosting*, an open question).
- **Success criteria:** a Star with no cached bundle pulls version N on first request and serves it; a newly published version is picked up lazily.

### Phase 4 — Wire the dev loop (`deploy_to_dev`)
- `deploy_to_dev`: (1) publish ontology+bundle to the Galaxy registry; (2) `DevStar.deployToDev()` eager-applies (exists); (3) compile + reload-broadcast to the preview.
- **Success criteria:** an end-to-end dev cycle — edit a `.vue` → compile in DevStar → preview reloads — under the ~3 s target; the dev Star serves the freshly-compiled bundle.

### Phase 5 — Spike teardown
Once the pipeline is ported and green:
- Delete `apps/nebula/spike/sfc-devstar-loop/`; delete `tasks/archive/spike-sfc-dev-cycle.md`; remove the spike from the root `package.json` `workspaces`; `wrangler delete --name spike-sfc-galaxy-loop`.
- **Success criteria:** spike removed; `npm install` clean; no references to the spike remain.

## Out of scope (this build)
- Per-app Tailwind JIT (DaisyUI **precompiled** bundle only for the demo — post-demo).
- The agentic generation loop (Studio proper) — this is the deploy/compile substrate it rides on.
- T3 "runs/reacts" full preview against the live reactive store (frontend-factory integration) — here the compiled module is verified structurally + via the reload broadcast.

## References
`tasks/nebula-studio.md` (§ Build sequencing, § Dev-mode Star, § Architecture); `tasks/dev-star.md`; the viability spike `apps/nebula/spike/sfc-devstar-loop/` (`RESULTS.md`, `src/compile-module.ts`); `packages/ts-runtime-parser-validator/scripts/bundle-tsc.mjs` (the tsc-in-workerd bundling pattern).
