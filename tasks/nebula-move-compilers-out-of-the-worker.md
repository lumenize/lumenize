# Move the compilers out of the Worker

**Status:** Drafted 2026-08-28 — **Pass 1 only (design intent), hand-reviewed with Larry 2026-08-28; every decision settled. Phases wait on a second `/review-task` Stage 1 — the first reshaped the design.** Not built. Nothing gates this; it gates everything else.

## Relationships

- **[nebula-pre-alpha.md](nebula-pre-alpha.md)** — the batched wipe+redeploy gate cannot run until this lands. Its wipe item carries superseded numbers and a stale "no task file yet"; trim both to target-shape plus a pointer here, in this task.
- **[nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)** — its deploy-staged criteria (the build-box FUSE limbs, the `ui-smoke` codegen test, preview-survives-redeploys) are the work this unblocks finishing and archiving.
- **[backlog.md](backlog.md)** — its row restates these measurements and claims the async ripple reaches "a module-scope constant" in `chat-ontology.ts`, which this file refutes (it is a function). Collapse the row to a one-line pointer HERE, in this task, rather than at build: success criterion 2 re-measures the numbers, so every copy is falsified on build day.
- **[nebula-ontology-history-file.md](nebula-ontology-history-file.md)** — condemns the KV registry and four mesh methods; this task pulls exactly one of them forward (§ *Decisions*). Its tabled question, *where compiled validator bundles live*, stays ITS to settle — but where the compile runs, decided here, constrains the answer.
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

⚠️ **`apps/nebula`'s own barrel does the same thing, so the package split is only half the cut.** `ontology-compile.ts` imports the compile half, `galaxy.ts` imports and re-exports it, `src/index.ts` re-exports that, and `src/worker.ts` — the `main` entry — imports `./index`. The section's own logic applies verbatim to our barrel: an app-side cut has to land in the same task, and the test apps that compile in-Worker today need a compiled row handed to them instead.

⇒ **the compiler follows the facet wherever the compiling goes.** Splitting the package's runtime surface from its compile surface is the load-bearing half of this task; without it, moving the compile into the container buys 1.5 MB and leaves the deploy just as blocked.

**The split is easier than it sounds, because the runtime side already has no compiler in it.** `getParserValidatorFacet` (`facet-helper.ts`) takes a `WorkerLoader` and loads the **generated** validator module into a facet — the source it loads is stored on the ontology row. It never calls tsc. So the two halves are already disjoint in fact; they are only joined by the barrel.

### Every tsc call site in the Worker, and what becomes of each

**The inventory is a construct, not a count.** `grep -rn 'compileOntologyVersion(\|generateParseModule(\|extractTypeMetadata(\|checkTypeScript(' apps/nebula/src` returns six call sites (2026-08-28), and a seventh appearing later inherits the same obligation rather than falsifying a tally:

| site | what it compiles | becomes |
|---|---|---|
| `codegen-gate.ts:196` | `checkTypeScript` — the SFC semantic pass | the `typeCheck` step of `build` |
| `codegen-gate.ts:220` | the `.d.ts` branch's full `compileOntologyVersion` | the `ontology` step of `build` |
| `galaxy.ts:527` `appendWorkspaceOntology` | the Workspace `.d.ts`, at the Apply click | the `ontology` step of `build` — already `async` |
| `galaxy.ts:428` `appendOntologyVersion` | a caller-supplied types string | **deleted**, see § *Decisions* |
| `chat-ontology.ts:33` `chatOntologySeedRow` | the constant `CHAT_MESSAGE_TYPES` | a precompiled data literal |
| `galaxy.ts:1417` `#ensureToolArgsFacet` | the constant `TOOL_ARGS_TYPES` | a precompiled data literal |

**The last two compile source that never varies.** Neither takes user input, neither varies by tenant, and both emit the same bytes in every Galaxy forever — so they should stop being runtime compiles rather than move anywhere. Sending them to the container would put a cold start on a Galaxy's first chat message and on the loop's first tool call, both interactive.

⚠️ **These are the consumers the ablation's stubs hid.** § *The prize, measured* reached 2,294 KiB by stubbing the compile surface, so nothing forced any of these six to resolve. Move only the gate and the deploy stays blocked by the rest.

### Keeping a precompiled artifact honest

**The precompiled module is checked in as source, generated by a one-shot script, and kept honest the way the scaffold seed already is.** `apps/nebula`'s `scripts/gen-scaffold.mjs` is the pattern to copy outright: it embeds `container/app/` into a committed `src/scaffold-seed.ts`, its header states the same no-build-in-dev reasoning, and `gen-scaffold.mjs --check` runs in the `test` script **ahead of vitest**. Nothing in the dev loop builds; the Worker imports a data literal.

**Three layers verify a generated artifact, and they catch different things** — `scripts/generated-artifact-hook.sh`'s header carries the argument, so read it there rather than re-deriving: a `PostToolUse` hook fires on an edit to a generator's INPUT, the package `test`-script `--check` catches staleness from any cause including a dependency bump no hook sees, and CI is the authority that depends on neither local state nor anyone reading a report. ⚠️ **The hook dispatches through a per-path `case` list, so registering the new generator there is a step, not an inheritance** — an unregistered generator silently gets no hook coverage, which is the enumeration-goes-stale failure this file warns about one sentence later. ⚠️ **A check must REBUILD, never stamp its inputs** — a stamp lists the inputs someone thought of, and goes quiet the moment an input nobody listed changes.

⚠️ **The `--check` belongs in the `test` script, not in a new vitest project.** `apps/nebula`'s test script enumerates projects positively (`--project unit --project frontend …`), so a new project does not run under `npm test` until someone adds it — the silent-drop `scripts/test-code.sh`'s own header records as a past false green. A `--check` ahead of `vitest` cannot be skipped that way. The regenerator needs no workerd either: `ontology-compile.ts` is already Node-safe by construction, its header pinning the no-mesh, no-`cloudflare:workers` rule so the `/live` harness can import it.

⚠️ **`build.command` cannot be the mechanism — `vitest-pool-workers` does not run it.** Measured 2026-08-28 with a sentinel that appends to a marker file: `wrangler deploy --dry-run` ran it, `vitest run` did not, and the suite passed regardless. Statically, the wrangler API pool-workers calls — `unstable_getMiniflareWorkerOptions` — never references `runCustomBuild`, which lives on the deployment-bundle and dev-watcher paths. ⇒ an artifact produced only by a custom build is present at deploy and **stale or absent under vitest**, which greens the suite against a validator the deploy does not have.

### Where the compiling should happen

**Both branches of the gate drag tsc, so both leave the Worker.** `compileSource` (`codegen-gate.ts`) dispatches `*.vue` to a two-pass check whose second pass is `checkTypeScript`, and `*.d.ts` to a full `compileOntologyVersion`. `checkTypeScript` reaches `ts` through `virtual-ts-host.ts`; `compileOntologyVersion` reaches `ts` and `typiaTransform` through `generate-parse-module.ts`. Leave either branch in the Worker and the 8.91 MB bundle stays with it. There is no half-move that unblocks the deploy.

**So `write_file` becomes a pure write, and `build` does the checking.** The only reader of `errorTail` has always been the model, and `build` already returns tool results to that same reader. Moving the check there costs the loop nothing it was using and buys the model a complete findings list per round instead of one file's errors at a time. Write rounds get cheaper, not dearer: they stop compiling at all.

⚠️ **This supersedes the MECHANISM of `nebula-galaxy-collapse-and-chat.md` § *The build-box contract*'s 🔒 pin, and preserves its PURPOSE** (decided with Larry 2026-08-28). That pin reads *"each `write_file` still compiles in-DO … so iteration stays container-free"*. In-DO compiling is what has to go, because it is what holds tsc in the Worker. Iteration stays container-free by the stronger route — a write does no work at all — and the pin's own routing of build outcomes back to the model in-turn is what carries the check. Record the supersession there when this lands.

**`build` returns per-step outcomes, never a global `ok`.** One boolean would force every step to fold into it, and folding in the type check means deciding whether a finding is fatal — which is the judgement this design hands to the model. A per-step report never has to decide:

```ts
type StepResult =
  | { ran: true;  ok: true }
  | { ran: true;  ok: false; tail: string }      // bounded RAW output, not a summary
  | { ran: false; why: string }        // skipped — stated, never absent
type BuildReport = {
  container: StepResult                // !ok ⇒ infra; retry the same code
  ontology:  StepResult                // ran:false when no .d.ts changed
  typeCheck: { ran: boolean; findings: Finding[] }   // no `ok` — advisory by construction
  bundle:    StepResult                // !ok ⇒ no dist, so nothing to publish
  publish:   { done: boolean; why: string }          // a non-publish always says why
}
```

Three properties are deliberate. **`typeCheck` carries no `ok`**, so nothing can read it as a gate — the policy lives in the type rather than in someone's memory. **A skipped step says `ran: false` rather than being absent**, because an absent key reads as "fine". **`publish` always carries a `why`**, so a preview that did not refresh is never silent. Adding `run_tests` later is then a new key rather than a renegotiation of `ok`. This replaces `BuildOutcome` (`codegen-loop.ts`), whose `retryable` flag is really a different STEP failing rather than a different kind of failure — 10 references, 8 in `src/`, all mechanical.

**Publishing the preview is the model's call.** A type finding may be a real bug a user would hit, or a value the checker cannot see is safe; that judgement is the model's to make, the way a developer makes it. So the reload fires by default on a clean build — `galaxy.ts`'s `#buildAndAnnounce` does this today — and the model MAY override to publish alongside findings it judges harmless. It cannot publish when `bundle` failed, because there is no `dist`: that is structural, not policy. ⚠️ **Say so in `STUDIO_LOOP_SYSTEM_PROMPT`, not only in the tool schema** — a model trained to leave everything green will fix rather than judge unless told that shipping with a reasoned findings list is a legitimate outcome. The `build` tool description (`codegen-loop.ts`) teaches the old three-way outcome and is rewritten with it.

**The bundle is the package's DISTRIBUTION format, so the container builds one too — from source, in the image.** `dist/deps.bundle.mjs` is not a workerd workaround: `prepare-for-publish.sh` rewrites `files` from `src/**` to `dist/**`, so the bundle is what every external consumer of the published package actually gets, and it is the only form in which the vendored typia fork travels. `bundle-tsc.mjs`'s header pins why it must be one pass — typia's transformer does `instanceof` against `ts.Node`, so two `typescript` instances silently return `false`. Running that same bundler during the image build, over source copied into the build context, keeps the container current with the tree by construction: a Docker `COPY` layer invalidates when its source changes, so editing the package or a fork rebundles on the next image build with no manual step to forget. ⚠️ **Prove `bundle-tsc.mjs` runs unmodified in the image rather than reasoning about it** — it resolves `typescript/package.json` and reads its `lib/` off disk, which works in a normal tree and should be demonstrated in the image.

⚠️ **Design consideration: this keeps the virtual host, and gives up cross-file checking.** The compile still runs against `createVirtualHost` with `NEBULA_API_DTS` mounted as a virtual module, so the SFC pass type-checks one file against a hand-authored contract rather than resolving the generated app's real imports in `/workspace`. A real `CompilerHost` would catch cross-file errors this cannot. That is today's behaviour either way, so it is not a regression — revisit it once the forks' fate is settled.

### Where there is no container

Three environments have none, and the answer is the same in each: **the constraint is that tsc stays out of the WORKER's import graph, never that tsc must not run somewhere cheap.**

- **The offline replay harness** (`on-hold/nebula-offline-prompt-harness.md`, which scores model output with `compileSource`) is a Node process, and `virtual-ts-host.ts` has no workerd-only imports — so it imports the compile half directly and stays seconds-fast with no Docker. `nebula-pre-alpha.md`'s "model + gate, seconds" tight loop is unaffected.
- **pool-workers tests** keep testing the compile functions directly; a test Worker may carry tsc because it never deploys. What changes is that `codegen-gate.test.ts`'s 10 tests cover a function the Worker no longer calls on its request path, and `codegen-loop.test.ts` (23 tests, zero `compileSource` references) is untouched.
- **Local `wrangler dev`** has no kernel FUSE mount, so the shim world serves an empty `/workspace` and a container build cannot be driven there at all. That is today's situation, not a regression: it is why the build-box criteria are deploy-only.

### The refactor ripple, sized

Making the compile remote makes it async, and that propagates. Measured by attempting it 2026-08-28, before the precompile decision: `compileOntologyVersion` → `compileOntologyGate` → `compileSource`, plus `chatOntologySeedRow()` and its handful of `galaxy.ts` call sites. **`chatOntologySeedRow` is a function, not a module-scope constant**, so even then the change was `await` at four call sites rather than a lazy-initialisation redesign. The probe's error list looked worse than the work is.

⚠️ **Precompiling shrinks that ripple rather than riding it.** A precompiled chat seed and tool-args validator call no compiler, so they need no `await` and those four call sites stay synchronous — the async propagation is confined to the two compiles that genuinely move to the container. The measurement above is the pre-decision upper bound, kept because it is the number someone will otherwise re-derive.

### What this task deliberately does NOT do

**Vite 8 is not in scope** (decided with Larry 2026-08-28). It would not remove tsc from anything — the ontology compile goes through typia/tsc in our own parser-validator, which is a different path from vite's transform — so it buys build *speed* inside the container for a speed problem nobody has measured. `workflow.md`'s toolchain rule is the stronger reason: independent axes move separately, or a red is unattributable. Deferring also costs nothing later, since the `rolldown-no-tc39-decorators` trap is about our decorated source and a generated app has no decorators. The backlog's *Move to vite 8* row keeps it.

## Constraints

- **`workflow.md` § *Startup cost is the criterion*** — the gate is work at module scope, never byte count; measure with `wrangler deploy --dry-run --outfile` then `wrangler check startup --workerBundle`, and read self-time plateaus.
- **A DO pays for its whole Worker's import graph.** A subpath export helps only once *nothing* in the Worker imports the heavy half — which is why the split and the move are one task, not two.
- **ADR-001** — TypeScript types are the schema language. Wherever the compile runs, it stays a TS compile producing the same validator; no second schema language enters.
- **`durable-objects.md`** — a Worker Loader `bundleId` is cached per-Worker-project across DO instances and must be scoped by tenant. This binds the **runtime** path, not the compile: `getParserValidatorFacet` takes a `WorkerLoader` and keys on `galaxyId/version`, so the package split must leave that scoping intact.
- **`containers.md`** — the container is a general compute platform, and adding a capability is a new job inside the existing container, never a new node.
- **`Star` has no container** — only `Galaxy` declares one, so a container-hosted compile is reachable from the Galaxy alone. The paths that exist already respect this (`Star.setOntology` receives an already-compiled row, `appendWorkspaceOntology` runs on the Galaxy), but no design here may quietly violate it.
- **The compile shares ONE ephemeral container with `vite build`, and the invariant that makes that safe is stated rather than the arrangement.** Two properties hold today: the compile runs BEFORE any model-authored code executes in the instance (type-check → ontology → `vite build` → destroy), and it resolves nothing from the mount — `bundle-tsc.mjs` seals `typescript` into `deps.bundle.mjs` at image-build time, so the Dockerfile's `/workspace/node_modules` → `/node_modules` resolution walk has nothing to shadow. The emitted validator is itself loaded with `globalOutbound: null` and no `env`. ⚠️ **The tripwire is the real-`CompilerHost` change** (§ *Where the compiling should happen*'s design consideration): adopting it makes the compiler resolve from the model-writable mount, at which point the compile MUST move to its own container. Isolation is not needed now; it becomes needed then.
- **Pre-alpha carries no per-task deploy gate**, but this task's whole point is that the batched one currently cannot run.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Both branches of the gate leave the Worker: `write_file` becomes a pure write and `build` does the checking** (§ *Where the compiling should happen*, 2026-08-28) | Keeping the SFC gate in the Worker — it reaches `ts` through `checkTypeScript`, so the 8.91 MB bundle stays and the deploy stays blocked; there is no half-move. Folding the check into `vite build` as one exec, the earlier draft's shape — it assumed a turn that gates once per round, when `compileSource` runs per `write_file` and `build` is a separate model-chosen tool, so it would have put a container exec on every written file. |
| **`Galaxy.appendOntologyVersion` is deleted, not re-signatured** (2026-08-28) — its four harness callers move to `Star.setOntology` with rows compiled test-side | Giving it a pre-compiled-row signature — [nebula-ontology-history-file.md](nebula-ontology-history-file.md) already condemns it (scheme settled 2026-08-24: *"what dies … the four mesh methods `appendOntologyVersion` / `listOntologyVersions` / `getLatestOntologyVersion` / `getOntologyVersion`"*), so a new signature is an interim on a method scheduled for deletion, and its four call sites would change twice. Pulling all four forward — only this one compiles, and `getOntologyVersion` is the Star's live lazy-pull target. Sequencing behind that task — it has no phases and an open design question, while this one blocks every deploy. |
| **`build` returns per-step outcomes; there is no global `ok`** (§ *Where the compiling should happen*, 2026-08-28) | The `BuildOutcome` three-way union — one boolean forces every step to fold into it, and folding in the type check means deciding whether a finding is fatal, which is the judgement this design hands to the model. Its `retryable` flag also models a different STEP failing as a different KIND of failure. |
| **A failing step carries a bounded RAW tail of the tool's own output, never a summarized `detail`** (2026-08-28) | Prose summaries — they discard the line/column numbers, snippets and error codes a model reads fluently, and we would be deciding in advance what mattered. `codegen-gate.ts`'s existing `MAX_ERROR_TAIL = 4000` is the pattern. Replacing the structured report with logs alone — its second consumer is the SYSTEM (`#buildAndAnnounce` decides publish, the loop decides fix-round vs retry-same-code, tests and `/live` assert), and "the container never started" and "your types are wrong" are the same prose to a grep. Writing the full log to the VFS behind a `read_file` tool — deferred to `backlog.md` § *Nebula*: no present consumer has hit the 4 KB tail, and unlike the usual case the general form costs materially more (a new tool, a non-committed workspace path since `writeSource` git-commits every write, and DO storage growth). |
| **Publishing the preview is the model's call, overridable against type findings** (2026-08-28) | Publishing only on a findings-free build — a hard gate where this repo's stance is an advisory practice with an override, and it forecloses the judgement a developer makes routinely: this finding is real, that one the checker cannot see is safe. A standalone `publish` tool instead of an override — it adds a forget-to-publish path whose failure is a silently stale preview. |
| **The compile source is COPIED into the image and bundled THERE, at image-build time** (2026-08-28) — `bundle-tsc.mjs` runs inside the build, over the package's `src/` and the four vendored `forks/typia/*` declared in a container-side manifest | Copying the prebuilt `dist/deps.bundle.mjs` — nothing in the dev loop regenerates it (only publish, CI `--bundle`, or a manual `npm run bundle`), so the image would ship whatever was last bundled by hand; the `--check` added 2026-08-28 makes that staleness loud, not absent. Running the copied source directly under Node's type-stripping — the forks are namespace/enum-heavy (114/122/61/47 hits across 497 files), which is not erasable syntax. `npm install`ing the published package — the fork travels only in its `dist`, and the registry version lags the tree this task is editing. |
| **The bound `worker_loaders: [{ binding: "LOADER" }]` stays unused for compiling** (2026-08-28) | A dynamically-loaded Worker — `build` is the tool that now does the checking and `build` is a container operation, so running the type check in a Loader fragments ONE model tool call across two runtimes, and the Loader would need its own delivery of the bundle beside the image's. Its per-Worker-project `bundleId` cache still binds the RUNTIME facet either way (§ *Constraints*). |
| **`typia` is dropped from the package's devDependencies** (2026-08-28) — only `@typia/transform` and `typescript` are functional deps | Keeping it for provenance — the compile path never resolves it: `generate-parse-module.ts` mounts `TYPIA_DTS_STUB` at `/typia/lib/module.d.ts` and points `paths` there, the runtime helpers are inlined as strings, and `bundle-tsc.mjs`'s barrel bundles only `typescript` + `@typia/transform`. The version it was copied from is already recorded in `typia-runtime-helpers.ts`. Leaving it invites the "bake typia into the image" error this file already made once. |
| **`@lumenize/ts-runtime-parser-validator` splits by subpath export** — a runtime entry (`facet-helper` + the types, no compiler) and a compile entry (2026-08-28) | One barrel with the compile half tree-shaken out — esbuild cannot drop it, because `getParserValidatorFacet` and `generateParseModule` are reached through the same specifier and the compile half does its work at module scope. The split is a public API change on a published package; the emitted validator is unaffected either way, since its typia helpers are inlined as text rather than imported. |
| **No latency threshold is pinned for the check; the per-round cost is measured and recorded, not gated** (2026-08-28) | A pass/fail budget as a success criterion — an 82% bundle cut is the outcome that matters, and a threshold invented before anyone has felt loop latency is a number to argue with later rather than evidence. |
| **The precompiled chat + tool-args modules are checked in as source, kept honest by a Node-side `--check` that rebuilds and diffs, run ahead of vitest in `apps/nebula`'s `test` script** (2026-08-28) | A wrangler `build.command` — measured, `vitest-pool-workers` does not run it, so the suite would green against an artifact only the deploy has. Regeneration by convention, as `dist/deps.bundle.mjs` did before 2026-08-28 — fine for a pinned dependency version, wrong for constants someone edits by hand. |

## Success, stated so it can fail

- **`npm run deploy:test` (from `apps/nebula`) completes and the self-check reports `match:true`.** That is the whole point; everything else is a means. ⚠️ Not runnable at review time — it deploys.
- **The bundle and startup numbers are re-measured and recorded**, against the 12,957 KiB / 362 ms baseline above — not asserted as "smaller".
- **The per-round gate cost is recorded before and after, and gates nothing.** A number to look at, not a threshold to pass (§ *Decisions*).
- **The deploy-only scenarios finally run**: `HARNESS_TARGET_URL=<url> npx tsx apps/nebula/harness/drive.ts build-box` reaches the FUSE world (limb 1 decides `world: 'fuse'`, not `'shim'`), which no local run can do. ⚠️ Not runnable at review time — it needs the deployed URL. The `build-box` scenario is registered in `drive.ts` (verified 2026-08-28).
- **The blocker cannot silently return**: an import-graph tripwire asserts that the compile entry of `@lumenize/ts-runtime-parser-validator` is unreachable from the Worker's entry graph, and that no value import of `generateParseModule` / `extractTypeMetadata` / `checkTypeScript` remains under `apps/nebula/src/`. Stated over the construct, never the byte count. One `import` re-blocks the deploy while greening the whole suite, which is how this stayed invisible for eight weeks; a recorded measurement is not a guard.
- **The runtime path is untouched** — a Galaxy and a Star still load the generated validator through the facet, and the resource suites stay green without changes to what they assert.

