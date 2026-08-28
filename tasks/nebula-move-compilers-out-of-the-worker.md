# Move the compilers out of the Worker

**Status:** Drafted 2026-08-28 — **Pass 1 only (design intent). No phases yet; they wait on Larry's hand review.** Not built. Nothing gates this; it gates everything else.

## Relationships

- **[nebula-pre-alpha.md](nebula-pre-alpha.md)** — the batched wipe+redeploy gate cannot run until this lands.
- **[nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)** — its deploy-staged criteria (the build-box FUSE limbs, the `ui-smoke` codegen test, preview-survives-redeploys) are the work this unblocks finishing and archiving.
- **[backlog.md](backlog.md)** — the row that recorded the blocker, with the same measurements; delete it when this file is built.
- **[on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md)** — the codegen loop is what the SFC gate serves; a latency change is felt there first.

## Context

**`apps/nebula` does not deploy.** `wrangler deploy` is rejected by the Cloudflare API before upload:

```
Script startup exceeded CPU time limit [code: 10021]
```

That blocks the batched wipe+redeploy gate, and with it every deploy-only criterion the Galaxy collapse staged behind it — a real FUSE build, `dist` surviving a redeploy, the `ui-smoke` codegen test. It is the pre-alpha critical path.

Nobody knew, because prod has not been redeployed since 2026-07-04. The first deploy attempt after that is what surfaced it — along with a second blocker already fixed on the way in: `kv_namespaces` carried a literal `REPLACE_WITH_REAL_KV_NAMESPACE_ID_AT_PHASE_4`, so every deploy had been dying on `code: 10042` before it ever reached the startup check.

### What is actually in the bundle

Every byte of the shipped bundle attributed to its esbuild module banner, 2026-08-28:

| module | MB | % |
|---|---:|---:|
| `ts-runtime-parser-validator` (the pre-bundled tsc) | 8.91 | 70.4 |
| `@vue/compiler-sfc` | 1.50 | 11.8 |
| `@cloudflare/computer` | 0.83 | 6.6 |
| `isomorphic-git` | 0.32 | 2.5 |
| `apps/nebula/src` | 0.30 | 2.4 |
| `@platformatic/vfs` · `pako` · `capnweb` · rest | 0.74 | 6.3 |

**The two compilers are 82% of it.** The Galaxy collapse's whole build stack — computer, git, VFS, pako, capnweb — is about 1.5 MB, so it is not what broke this. It was the last straw on a Worker that had been carrying a 9 MB compiler all along.

⚠️ **Size is the symptom; the cost is work at module scope.** The startup profile Cloudflare writes on rejection is `workflow.md` § *Startup cost is the criterion*'s signature exactly: ~25% garbage collection, ~45% anonymous top-level init, 4.3% inside `__name` wrappers. tsc builds its scanner, keyword and diagnostic tables when the module is evaluated, and a static import puts that in the startup phase.

### The prize, measured

Ablating both compilers and re-measuring:

| | bundle | local startup |
|---|---:|---:|
| today | 12,957 KiB | 362 ms (210 samples) |
| both compilers gone | **2,294 KiB** | **51 ms (16 samples)** |

So the fix is entirely about the compilers, and it clears the limit with room to spare rather than squeaking under it.

### Why moving the compile is not enough on its own

Moving only the compile-time call sites reduced the bundle size by only **1.5 MB** because tsc stayed. The reason tsc stayed is the shape of the package:

- `galaxy.ts` and `star.ts` import **`getParserValidatorFacet`** — the RUNTIME validator, on the request path — from the same module specifier that carries the compiler.
- `resources.ts` and `resource-data-plane.ts` import only types, which are erased and cost nothing.
- `@lumenize/ts-runtime-parser-validator` has exactly one export: `"." → ./src/index.ts`.

⇒ **the compiler follows the facet wherever the compiling goes.** Splitting the package's runtime surface from its compile surface is the load-bearing half of this task; without it, moving the compile into the container buys 1.5 MB and leaves the deploy just as blocked.

**The split is easier than it sounds, because the runtime side already has no compiler in it.** `getParserValidatorFacet` (`facet-helper.ts`) takes a `WorkerLoader` and loads the **generated** validator module into a facet — the source it loads is stored on the ontology row. It never calls tsc. So the two halves are already disjoint in fact; they are only joined by the barrel.

### Two more compiles hide behind the two obvious ones

`codegen-gate.ts` and `ontology-compile.ts` are not the only tsc call sites in the Worker. Two more reach `generateParseModule`, and both compile source that never varies:

- **`chatOntologySeedRow()`** (`chat-ontology.ts`) compiles the constant `CHAT_MESSAGE_TYPES` at a constant version label, lazily on a Galaxy's first chat touch via `#ensureChatFacet`, then durable in KV.
- **`Galaxy.#ensureToolArgsFacet`** compiles `TOOL_ARGS_TYPES` for the codegen loop's tool-args validator, under a `TOOL_ARGS_BUNDLE_ID` its JSDoc deliberately shares across tenants.

Neither takes user input, neither varies by tenant, and both emit the same bytes in every Galaxy forever. ⇒ **They do not belong in the container either — they should stop being runtime compiles.** Precompiling both at publish and shipping the result as a data literal (for the chat seed, the whole `OntologyVersionRow`) removes the last tsc reference from the Worker. Sending them to the container instead would put a cold start on a Galaxy's first chat message and on the loop's first tool call, both interactive.

⚠️ **These are the consumers the ablation's stubs hid.** § *The prize, measured* reached 2,294 KiB by stubbing the compile surface, so nothing forced these two to resolve. Move only the two named compiles and tsc stays in the bundle for these, with the deploy still blocked.

**The precompiled module is checked in as source, generated by a one-shot script, and kept honest exactly the way the scaffold seed already is.** `apps/nebula`'s `scripts/gen-scaffold.mjs` is the pattern to copy outright — it embeds `container/app/` into a committed `src/scaffold-seed.ts`, its header states the same no-build-in-dev reasoning, and it is enforced twice: `gen-scaffold.mjs --check` runs in the `test` script **ahead of vitest**, and `test/scaffold-seed-drift.test.ts` reds inside the suite. Nothing in the dev loop builds; the Worker imports a data literal. `bundle-tsc.mjs --check` now carries the same shape for the tsc deps bundle (2026-08-28), so every generated artifact in the repo is verified by one mechanism: rebuild into a scratch dir, byte-compare, red on difference. ⚠️ **The check must REBUILD, never stamp its inputs** — a stamp is an enumeration, and it goes stale silently the moment an input nobody listed changes.

⚠️ **The `--check` belongs in the `test` script, not in a new vitest project.** `apps/nebula`'s test script enumerates projects positively (`--project unit --project frontend …`), so a new project does not run under `npm test` until someone adds it — the silent-drop `scripts/test-code.sh`'s own header records as a past false green. A `--check` ahead of `vitest` cannot be skipped that way. The regenerator needs no workerd either: `ontology-compile.ts` is already Node-safe by construction, its header pinning the no-mesh, no-`cloudflare:workers` rule so the `/live` harness can import it.

⚠️ **`build.command` cannot be the mechanism — `vitest-pool-workers` does not run it.** Measured 2026-08-28 with a sentinel that appends to a marker file: `wrangler deploy --dry-run` ran it, `vitest run` did not, and the suite passed regardless. Statically, the wrangler API pool-workers calls — `unstable_getMiniflareWorkerOptions` — never references `runCustomBuild`, which lives on the deployment-bundle and dev-watcher paths. ⇒ an artifact produced only by a custom build is present at deploy and **stale or absent under vitest**, which greens the suite against a validator the deploy does not have.

### Where the compiling should happen

Two compile jobs, and they are not the same shape:

- **The SFC gate** (`codegen-gate.ts` — `@vue/compiler-sfc` plus a tsc type-check pass) runs **once per codegen round**, feeding `errorTail` back to the model for self-correction. It is latency-sensitive in aggregate but only in aggregate.
- **The ontology compile** (`ontology-compile.ts` — `extractTypeMetadata` + `generateParseModule`) runs when a version is installed, which is rare, and produces the module the runtime facet later loads.

**Both go to the container, and the SFC gate is folded into the build rather than added beside it.** The image already bakes what each job needs at `/node_modules` — `typescript@^5.9.2` outright, `@vue/compiler-sfc` as `vue`'s own dependency — so neither compiler is a new baked dep. Today the container runs one job, `vite build` (`container/app/package.json`). Wrapping that job so it type-checks first and builds only on a clean check gives one exec, returning `{ ok, errorTail }` on failure and `{ ok, dist }` on success.

⇒ **This REMOVES an operation rather than adding one.** A codegen turn today is N in-Worker gate calls plus one build exec; wrapped, it is N execs whose last one produces `dist` — the build the turn needed anyway. A warm exec is ~30 ms ([[agent-channel-container-exec]]) against a model round measured in seconds, and `warmBuildBox` already fires at the discriminator's verdict, so the box is warm when the first round lands. ⚠️ **The wrapper type-checks first and builds only on a clean check** — building on a failing round pays a full vite build for an `errorTail` the type-check already produced.

**The container also deletes machinery the gate needs only in workerd.** `checkTypeScript` runs tsc against a virtual host today: `NEBULA_API_DTS` is synthesized as a virtual module and `TS_LIB_FILES` ships the lib files, because workerd has no filesystem. In the container tsc gets a real one — write the `.d.ts` into `/workspace` and ordinary resolution finds it, and the baked `typescript` brings its own libs.

**`worker_loaders: [{ binding: "LOADER" }]` is bound in `wrangler.jsonc` and stays unused for this.** A dynamically-loaded Worker would keep the ontology compile off the main bundle with no container start, but it is a second mechanism for a job the container already hosts, and it needs the tsc deps bundle shipped to the Loader as a module — plumbing the container gets free from `/node_modules`. The install path is rare enough to pay a cold start (~3.2 s) when the box is cold. ⚠️ If it is ever reconsidered, its `bundleId` cache is per-Worker-project and shared across DO instances, so any id must be scoped by tenant (`durable-objects.md` § *Dynamic Worker Loader cache*).

### The refactor ripple, sized

Making the compile remote or lazy makes it async, and that propagates. Measured by attempting it 2026-08-28: `compileOntologyVersion` → `compileOntologyGate` → `compileSource`, plus `chatOntologySeedRow()` and its handful of `galaxy.ts` call sites. **`chatOntologySeedRow` is a function, not a module-scope constant**, so the change is `await` at four call sites rather than a lazy-initialisation redesign. The probe's error list looked worse than the work is.

### What this task deliberately does NOT do

**Vite 8 is not in scope** (decided with Larry 2026-08-28). It would not remove tsc from anything — the ontology compile goes through typia/tsc in our own parser-validator, which is a different path from vite's transform — so it buys build *speed* inside the container for a speed problem nobody has measured. `workflow.md`'s toolchain rule is the stronger reason: independent axes move separately, or a red is unattributable. Deferring also costs nothing later, since the `rolldown-no-tc39-decorators` trap is about our decorated source and a generated app has no decorators. The backlog's *Move to vite 8* row keeps it.

## Constraints

- **`workflow.md` § *Startup cost is the criterion*** — the gate is work at module scope, never byte count; measure with `wrangler deploy --dry-run --outfile` then `wrangler check startup --workerBundle`, and read self-time plateaus.
- **A DO pays for its whole Worker's import graph.** A subpath export helps only once *nothing* in the Worker imports the heavy half — which is why the split and the move are one task, not two.
- **ADR-001** — TypeScript types are the schema language. Wherever the compile runs, it stays a TS compile producing the same validator; no second schema language enters.
- **`durable-objects.md`** — a Worker Loader `bundleId` is cached per-Worker-project across DO instances and must be scoped by tenant. This binds the **runtime** path, not the compile: `getParserValidatorFacet` takes a `WorkerLoader` and keys on `galaxyId/version`, so the package split must leave that scoping intact.
- **`containers.md`** — the container is a general compute platform, and adding a capability is a new job inside the existing container, never a new node.
- **`Star` has no container** — only `Galaxy` declares one, so a container-hosted compile is reachable from the Galaxy alone. The paths that exist already respect this (`Star.setOntology` receives an already-compiled row, `appendWorkspaceOntology` runs on the Galaxy), but no design here may quietly violate it.
- **Pre-alpha carries no per-task deploy gate**, but this task's whole point is that the batched one currently cannot run.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Both compiles run in the container, and the SFC gate is folded into the `vite build` job rather than run beside it** (§ *Where the compiling should happen*, 2026-08-28) | A separate gate exec per round — it costs N execs *plus* a build where N execs suffice, because the clean round's build is the one the turn needed anyway. Leaving the gate in the Worker — that is the 1.5 MB half-move: tsc follows the facet and the deploy stays blocked. |
| **The ontology compile goes to the container too; the bound `LOADER` stays unused** (§ *Where the compiling should happen*, 2026-08-28) | A dynamically-loaded Worker — a second compile mechanism for a job the container already hosts, needing the tsc deps bundle shipped to it as a loadable module, to save a cold start on a path that runs at install. Its per-Worker-project `bundleId` tenant-scoping obligation returns with it if it is ever revisited. |
| **`@lumenize/ts-runtime-parser-validator` splits by subpath export** — a runtime entry (`facet-helper` + the types, no compiler) and a compile entry (2026-08-28) | One barrel with the compile half tree-shaken out — esbuild cannot drop it, because `getParserValidatorFacet` and `generateParseModule` are reached through the same specifier and the compile half does its work at module scope. The split is a public API change on a published package; the emitted validator is unaffected either way (§ *Two more compiles hide behind the two obvious ones*). |
| **No latency threshold is pinned for the SFC gate; the per-round cost is measured and recorded, not gated** (2026-08-28) | A pass/fail budget as a success criterion — an 82% bundle cut is the outcome that matters, and a threshold invented before anyone has felt loop latency is a number to argue with later rather than evidence. |
| **The precompiled chat + tool-args modules are checked in as source, regenerated and diffed by a Node-side test** (2026-08-28) | A wrangler `build.command` — measured, `vitest-pool-workers` does not run it (§ *Two more compiles hide behind the two obvious ones*), so the suite would green against an artifact only the deploy has. Regeneration by convention, as `dist/deps.bundle.mjs` does today via `ci-install.sh` — fine for a pinned dependency version, wrong for constants someone edits by hand. |

## Success, stated so it can fail

- **`npm run deploy:test` completes and the self-check reports `match:true`.** That is the whole point; everything else is a means.
- **The bundle and startup numbers are re-measured and recorded**, against the 12,957 KiB / 362 ms baseline above — not asserted as "smaller".
- **The per-round gate cost is recorded before and after, and gates nothing.** A number to look at, not a threshold to pass (§ *Decisions*).
- **The deploy-only scenarios finally run**: `HARNESS_TARGET_URL=<url> npx tsx apps/nebula/harness/drive.ts build-box` reaches the FUSE world (limb 1 decides `world: 'fuse'`, not `'shim'`), which no local run can do.
- **The runtime path is untouched** — a Galaxy and a Star still load the generated validator through the facet, and the resource suites stay green without changes to what they assert.

