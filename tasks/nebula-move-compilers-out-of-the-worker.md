# Move the compilers out of the Worker

**Status:** Drafted 2026-08-28 — **Pass 1 only (design intent). No phases yet; they wait on Larry's hand review.** Not built. Nothing gates this; it gates everything else.

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

Ablating only the compile-time call sites moved the bundle **1.5 MB** — tsc stayed. The reason is the shape of the package, not the placement of the work:

- `galaxy.ts` and `star.ts` import **`getParserValidatorFacet`** — the RUNTIME validator, on the request path — from the same module specifier that carries the compiler.
- `resources.ts` and `resource-data-plane.ts` import only types, which are erased and cost nothing.
- `@lumenize/ts-runtime-parser-validator` has exactly one export: `"." → ./src/index.ts`.

⇒ **the compiler follows the facet wherever the compiling goes.** Splitting the package's runtime surface from its compile surface is the load-bearing half of this task; without it, moving the compile into the container buys 1.5 MB and leaves the deploy just as blocked.

**The split is easier than it sounds, because the runtime side already has no compiler in it.** `getParserValidatorFacet` (`facet-helper.ts`) takes a `WorkerLoader` and loads the **generated** validator module into a facet — the source it loads is stored on the ontology row. It never calls tsc. So the two halves are already disjoint in fact; they are only joined by the barrel.

### Where the compiling should happen

Two compile jobs, and they are not the same shape:

- **The SFC gate** (`codegen-gate.ts` — `@vue/compiler-sfc` plus a tsc type-check pass) runs **once per codegen round**, feeding `errorTail` back to the model for self-correction. It is latency-sensitive in aggregate but only in aggregate.
- **The ontology compile** (`ontology-compile.ts` — `extractTypeMetadata` + `generateParseModule`) runs when a version is installed, which is rare, and produces the module the runtime facet later loads.

The Galaxy already drives a container that runs vite, and **vite contains both tsc and the Vue compiler**. The container is warm during a codegen turn (`warmBuildBox` fires at the discriminator's verdict), and an exec against a warm box is ~30 ms ([[agent-channel-container-exec]]). So the container is the obvious home for the SFC gate.

The ontology compile has a second candidate the SFC gate does not: **`worker_loaders: [{ binding: "LOADER" }]` is already bound** in `wrangler.jsonc`. The compile could run in a dynamically-loaded Worker — off the main bundle, still in Workers, no container start on the install path. ⚠️ Its `bundleId` cache is per-Worker-project and shared across DO instances, so any id must be scoped by tenant (`durable-objects.md` § *Dynamic Worker Loader cache*).

⚠️ **`Star` has no container.** Only `Galaxy` declares one, so a container-hosted compile is reachable from the Galaxy alone. That is fine for the paths that exist — `Star.setOntology` receives an already-compiled row — but it is a constraint any design here must not quietly violate.

### The refactor ripple, sized

Making the compile remote or lazy makes it async, and that propagates. Measured by attempting it 2026-08-28: `compileOntologyVersion` → `compileOntologyGate` → `compileSource`, plus `chatOntologySeedRow()` and its handful of `galaxy.ts` call sites. **`chatOntologySeedRow` is a function, not a module-scope constant**, so the change is `await` at four call sites rather than a lazy-initialisation redesign. The probe's error list looked worse than the work is.

### What this task deliberately does NOT do

**Vite 8 is not in scope** (decided with Larry 2026-08-28). It would not remove tsc from anything — the ontology compile goes through typia/tsc in our own parser-validator, which is a different path from vite's transform — so it buys build *speed* inside the container for a speed problem nobody has measured. `workflow.md`'s toolchain rule is the stronger reason: independent axes move separately, or a red is unattributable. Deferring also costs nothing later, since the `rolldown-no-tc39-decorators` trap is about our decorated source and a generated app has no decorators. The backlog's *Move to vite 8* row keeps it.

## Constraints

- **`workflow.md` § *Startup cost is the criterion*** — the gate is work at module scope, never byte count; measure with `wrangler deploy --dry-run --outfile` then `wrangler check startup --workerBundle`, and read self-time plateaus.
- **A DO pays for its whole Worker's import graph.** A subpath export helps only once *nothing* in the Worker imports the heavy half — which is why the split and the move are one task, not two.
- **ADR-001** — TypeScript types are the schema language. Wherever the compile runs, it stays a TS compile producing the same validator; no second schema language enters.
- **`durable-objects.md`** — a Worker Loader `bundleId` is cached per-Worker-project across DO instances and must be scoped by tenant.
- **`containers.md`** — the container is a general compute platform, and adding a capability is a new job inside the existing container, never a new node.
- **Pre-alpha carries no per-task deploy gate**, but this task's whole point is that the batched one currently cannot run.

## Decisions to settle in review

These are the questions Pass 2 needs answered; the recommendation after each is mine, not a decision.

| Question | Recommendation, and what argues against it |
|---|---|
| **Where does the SFC gate compile?** | **The container.** It already holds vite (hence both compilers), it is warm during a codegen turn, and this is the roadmap direction anyway. Against: it adds a per-round round trip to the self-correction loop, and the loop is the product's inner loop. |
| **Where does the ontology compile run — container or Worker Loader?** | **Worth splitting from the SFC answer rather than assuming they match.** The Loader avoids a container start on the install path and the binding already exists; the container avoids a second mechanism. Against the Loader: it keeps a tsc-carrying bundle in the account, just not in this Worker's graph. |
| **How is `@lumenize/ts-runtime-parser-validator` split?** | **Subpath exports** — a runtime entry (`facet-helper` + types, no compiler) and a compile entry. Against: it is a published package, so the split is a public API change and every consumer's import moves. |
| **Does the SFC gate's latency budget need pinning as a criterion?** | **Yes** — measure the per-round cost before and after, and state the number. Against: nobody has complained about loop latency, so this may be ceremony. |
| **Does anything still need tsc inside the Worker after this?** | **Expected no** — the ablation reached 2,294 KiB with both compilers gone and nothing else broke at type-check. Against: the ablation stubbed rather than rewired, so a real cut may surface a consumer the stubs hid. |

## Success, stated so it can fail

- **`npm run deploy:test` completes and the self-check reports `match:true`.** That is the whole point; everything else is a means.
- **The bundle and startup numbers are re-measured and recorded**, against the 12,957 KiB / 362 ms baseline above — not asserted as "smaller".
- **The deploy-only scenarios finally run**: `HARNESS_TARGET_URL=<url> npx tsx apps/nebula/harness/drive.ts build-box` reaches the FUSE world (limb 1 decides `world: 'fuse'`, not `'shim'`), which no local run can do.
- **The runtime path is untouched** — a Galaxy and a Star still load the generated validator through the facet, and the resource suites stay green without changes to what they assert.

## Relationships

- **[nebula-pre-alpha.md](nebula-pre-alpha.md)** — the batched wipe+redeploy gate cannot run until this lands.
- **[nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)** — its deploy-staged criteria (the build-box FUSE limbs, the `ui-smoke` codegen test, preview-survives-redeploys) are the work this unblocks.
- **[backlog.md](backlog.md)** — the row that recorded the blocker, with the same measurements; delete it when this file is built.
- **[on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md)** — the codegen loop is what the SFC gate serves; a latency change is felt there first.
