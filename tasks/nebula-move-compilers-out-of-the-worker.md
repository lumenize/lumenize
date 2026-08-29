# Move the compilers out of the Worker

**Status:** Pass 1 (design intent) — hand-reviewed with Larry and taken through three `/review-task` Stage-1 panels, 2026-08-28/29. Every decision settled; phases not yet written. Not built. Nothing gates this; it gates everything else.

## Relationships

- **[nebula-pre-alpha.md](nebula-pre-alpha.md)** — the batched wipe+redeploy gate cannot run until this lands. Its wipe item carries superseded numbers and a stale "no task file yet"; trim both to target-shape plus a pointer here, in this task.
- **[nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)** — its deploy-staged criteria (the build-box FUSE limbs, the `ui-smoke` codegen test, preview-survives-redeploys) are the work this unblocks finishing and archiving.
- **[backlog.md](backlog.md)** — its row restates these measurements and claims the async ripple reaches "a module-scope constant" in `chat-ontology.ts`, which this file refutes (it is a function). Collapse the row to a one-line pointer HERE, in this task, rather than at build: success criterion 2 re-measures the numbers, so every copy is falsified on build day.
- **[nebula-ontology-history-file.md](nebula-ontology-history-file.md)** — condemns the KV registry and four mesh methods; this task pulls exactly one of them forward (§ *Decisions*). Its tabled question, *where compiled validator bundles live*, stays ITS to settle — but where the compile runs, decided here, constrains the answer.
- **[on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md)** — its § *The folded shape* pins the `codegen` record this task reshapes. Per-write gate results end; `codegen.gate` becomes `codegen.build`, carrying `typeCheck.checked` + `findings`, and the chat-seed literal regenerates. Capture is irreversible, so this lands in THIS task's trim, not afterwards.

## Context

**`apps/nebula` does not deploy.** `wrangler deploy` is rejected by the Cloudflare API before upload:

```
Script startup exceeded CPU time limit [code: 10021]
```

That blocks the batched wipe+redeploy gate, and with it every deploy-only criterion the Galaxy collapse staged behind it — a real FUSE build, `dist` surviving a redeploy, the `ui-smoke` codegen test. It is the pre-alpha critical path.

Nobody knew, because prod has not been redeployed since 2026-07-04. The first deploy attempt after that is what surfaced it — along with a second blocker already fixed on the way in: `kv_namespaces` carried a literal `REPLACE_WITH_REAL_KV_NAMESPACE_ID_AT_PHASE_4`, so every deploy had been dying on `code: 10042` before it ever reached the startup check.

The sections that follow take it in order: what is actually in the bundle and what ablating it buys · why the package split and the move are one task · every compiler call site and what becomes of each · how a precompiled artifact stays honest · where the compiling runs, what `build` returns, and how the compiler reaches the container · how a lane with no compiler installs an ontology · and what happens in the environments that have no container at all.

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

The split is two subpath exports, replacing the single `"." → ./src/index.ts` the package has today:

```jsonc
"exports": {
  "./runtime": { "import": "./src/facet-helper.ts", "types": "./src/facet-helper.ts" },
  "./compile": { "import": "./src/index.ts",        "types": "./src/index.ts" }
}
```

**The split is easier than it sounds, because the runtime side already has no compiler in it.** `getParserValidatorFacet` (`facet-helper.ts`) takes a `WorkerLoader` and loads the **generated** validator module into a facet — the source it loads is stored on the ontology row. It never calls tsc. So the two halves are already disjoint in fact; they are only joined by the barrel.

### Every compiler call site in the Worker, and what becomes of each

**The inventory is a construct, not a count.** `grep -rnE 'compileOntologyVersion\(|generateParseModule\(|extractTypeMetadata\(|checkTypeScript\(|compileScript\(|compileTemplate\(' apps/nebula/src | grep -v ontology-compile` returns the sites below (2026-08-29; the exclusion drops `ontology-compile.ts`'s own implementation, which is the compiler rather than a caller) — BOTH compilers, since `@vue/compiler-sfc` is 11.8% of the bundle and needs a disposition as much as tsc does, and a seventh appearing later inherits the same obligation rather than falsifying a tally:

| site | what it compiles | becomes |
|---|---|---|
| `codegen-gate.ts` → `checkTypeScript` | the SFC semantic pass (tsc) | the `typeCheck` step of `build` |
| `codegen-gate.ts` → `parse` / `compileScript` / `compileTemplate` | SFC pass 1 — `@vue/compiler-sfc`, tsc-free | **deleted**; `vite build` parses the same SFC in the same cycle |
| `codegen-gate.ts` → `compileOntologyGate` | the `.d.ts` branch's full `compileOntologyVersion` | the `ontology` step of `build` |
| `galaxy.ts` → `appendWorkspaceOntology` | the Workspace `.d.ts`, at the Apply click | the `ontology` step of `build` — already `async` |
| `galaxy.ts` → `appendOntologyVersion` | a caller-supplied types string | **deleted**, see § *Decisions* |
| `chat-ontology.ts` → `chatOntologySeedRow` | the constant `CHAT_MESSAGE_TYPES` | a precompiled data literal |
| `galaxy.ts` → `#ensureToolArgsFacet` | the constant `TOOL_ARGS_TYPES` | a precompiled data literal |

**The last two compile source that never varies.** Neither takes user input, neither varies by tenant, and both emit the same bytes in every Galaxy forever — so they should stop being runtime compiles rather than move anywhere. Sending them to the container would put a cold start on a Galaxy's first chat message and on the loop's first tool call, both interactive.

⚠️ **These are the consumers the ablation's stubs hid.** § *The prize, measured* reached 2,294 KiB by stubbing the compile surface, so nothing forced any of these six to resolve. Move only the gate and the deploy stays blocked by the rest.

### Keeping a precompiled artifact honest

**The precompiled module is checked in as source, generated by a one-shot script, and kept honest the way the scaffold seed already is.** `apps/nebula`'s `scripts/gen-scaffold.mjs` is the pattern to copy outright: it embeds `container/app/` into a committed `src/scaffold-seed.ts`, its header states the same no-build-in-dev reasoning, and `gen-scaffold.mjs --check` runs in the `test` script **ahead of vitest**. Nothing in the dev loop builds; the Worker imports a data literal. **The call site is one line, and it is what makes the runtime/compile split structural rather than incidental:** `getParserValidatorFacet`'s fourth parameter is `loadModuleSource: () => string | Promise<string>`, so `galaxy.ts`'s `() => generateParseModule(TOOL_ARGS_TYPES)` becomes `() => TOOL_ARGS_VALIDATOR_MODULE` with `TOOL_ARGS_BUNDLE_ID` unchanged — the facet never holds a compiler because the caller hands it source. ⚠️ **The emitted module is the bulky field**: `OntologyVersionRow.validatorBundle` is a whole module as a string, so record its committed size when the generator lands, against the 2,294 KiB target.

**Three layers verify a generated artifact, and they catch different things** — `scripts/generated-artifact-hook.sh`'s header carries the argument, so read it there rather than re-deriving: a `PostToolUse` hook fires on an edit to a generator's INPUT, the package `test`-script `--check` catches staleness from any cause including a dependency bump no hook sees, and CI is the authority that depends on neither local state nor anyone reading a report. ⚠️ **The hook dispatches through a per-path `case` list, so registering the new generator there is a step, not an inheritance** — an unregistered generator silently gets no hook coverage, which is the enumeration-goes-stale failure this file warns about one sentence later. ⚠️ **A check must REBUILD, never stamp its inputs** — a stamp lists the inputs someone thought of, and goes quiet the moment an input nobody listed changes.

⚠️ **The `--check` belongs in the `test` script, not in a new vitest project.** `apps/nebula`'s test script enumerates projects positively (`--project unit --project frontend …`), so a new project does not run under `npm test` until someone adds it — the silent-drop `scripts/test-code.sh`'s own header records as a past false green. A `--check` ahead of `vitest` cannot be skipped that way. The regenerator needs no workerd either: `ontology-compile.ts` is already Node-safe by construction, its header pinning the no-mesh, no-`cloudflare:workers` rule so the `/live` harness can import it.

⚠️ **`build.command` cannot be the mechanism — `vitest-pool-workers` does not run it.** Measured 2026-08-28 with a sentinel that appends to a marker file: `wrangler deploy --dry-run` ran it, `vitest run` did not, and the suite passed regardless. Statically, the wrangler API pool-workers calls — `unstable_getMiniflareWorkerOptions` — never references `runCustomBuild`, which lives on the deployment-bundle and dev-watcher paths. ⇒ an artifact produced only by a custom build is present at deploy and **stale or absent under vitest**, which greens the suite against a validator the deploy does not have.

### Where the compiling runs

**The tsc-bearing surface is `checkTypeScript` and `compileOntologyVersion`, and both leave the Worker.** `compileSource` (`codegen-gate.ts`) dispatches `*.vue` to a two-pass check and `*.d.ts` to a full `compileOntologyVersion`. Only the `.vue` branch's SECOND pass touches tsc: `checkTypeScript` reaches `ts` through `virtual-ts-host.ts`, and `compileOntologyVersion` reaches `ts` and `typiaTransform` through `generate-parse-module.ts`. Leave either in the Worker and the 8.91 MB stays with it.

**SFC Pass 1 is tsc-free, and it is DELETED rather than moved.** `@vue/compiler-sfc@3.5.34` depends on `@babel/parser`, `estree-walker`, `magic-string`, `postcss`, `source-map-js` and `@vue/*` siblings — no `typescript` — so `parse`/`compileScript`/`compileTemplate` could have stayed behind. It goes because `vite build` parses the same SFC in the same container cycle the type findings arrive in (`container/app/package.json` carries `vue ^3.5.13` and `@vitejs/plugin-vue ^6.0.8`), so a Worker-side Pass 1 would catch nothing the build will not. That removes the second compiler — 1.50 MB, 11.8% of the bundle — by not having it rather than by finding it a home.

### What `build` returns

**So `write_file` becomes a pure write, and `build` does the checking.** `build` already returns tool results to the model, so the feedback reaches the same reader through the same channel — and it arrives as a complete findings list per round rather than one file's errors at a time.

⚠️ **`errorTail` has two DURABLE non-model readers, and both change.** `galaxy.ts` composes it into the agent Message's `thought` (`compile error:\n${result.lastGate.errorTail}`), which Studio renders in its thought panel; and the Message persists `codegen.gate`, declared as `gate?: { ok: boolean; errorTail?: string }` in `CHAT_MESSAGE_TYPES`. Per-write gate results cease to exist, so `codegen.gate` holds the build's `typeCheck.findings` instead and the thought panel's compile line is written from those. ⇒ **`CHAT_MESSAGE_TYPES` changes, which regenerates the precompiled chat-seed literal this same task introduces** — the two halves of this file meet here.

**The async ripple is confined to the two compiles that move.** `compileOntologyVersion` → `compileOntologyGate` → `compileSource` becomes async and propagates; the precompiled chat seed and tool-args validator call no compiler, so their call sites stay synchronous.

⚠️ **The fix round gets DEARER, and that is the honest trade.** Today a broken `.vue` costs zero container cycles — `compileSource` is pure and synchronous — while afterwards each discover-and-fix cycle costs a full `#buildOnce` (start → probe → exec → destroy) against `maxToolDepth: 8`. Write rounds do get cheaper, but they were never the cost. What the change buys is the 8.91 MB and a findings list gathered in one pass; what it spends is container cycles on the loop's error path.

⚠️ **This supersedes the MECHANISM of `nebula-galaxy-collapse-and-chat.md` § *The build-box contract*'s 🔒 pin, and preserves its PURPOSE** (decided with Larry 2026-08-28). That pin reads *"each `write_file` still compiles in-DO … so iteration stays container-free"*. In-DO compiling is what has to go, because it is what holds tsc in the Worker. Iteration stays container-free by the stronger route — a write does no work at all — and the pin's own routing of build outcomes back to the model in-turn is what carries the check. Record the supersession there when this lands. ⚠️ **The same pin's SECOND clause survives intact** — *"each `build` call is one ephemeral container cycle … the loop's iteration cap bounds spend"* — because the checking rides the cycle that call already starts (§ *Constraints*). One `build` call still starts exactly one box, which is why `BuildReport` needs only one `container` key.

**`build` returns per-step outcomes, never a global `ok`.** One boolean would force every step to fold into it, and folding in the type check means deciding whether a finding is fatal — which is the judgement this design hands to the model. A per-step report never has to decide:

```ts
type StepResult =
  | { ran: true;  ok: true }
  | { ran: true;  ok: false; tail: string }      // bounded RAW output, not a summary
  | { ran: false; why: string }        // skipped — stated, never absent
type BuildReport = {
  container: StepResult                // !ok ⇒ infra; retry the same code
  ontology:  StepResult & { rowPath?: string }   // ran:false when no .d.ts changed; rowPath
                                       // names where the compiled row landed in the mount
  typeCheck: { ran: boolean; checked: string[]; findings: Finding[] }  // no `ok` — advisory
                                       // `checked` is what tsc actually looked at, so a file
                                       // written, checked and unimplicated is KNOWN CLEAN
                                       // Finding = one raw diagnostic line, e.g.
                                       // "src/App.vue(42,7): error TS2339: Property 'foo'
                                       //  does not exist on type 'Store'."
                                       // `checkTypeScript` already returns CheckResult.messages:
                                       // string[]; findings is that array, bounded like the tails
  bundle:    StepResult                // !ok ⇒ no dist, so nothing to publish
  publish:   { done: boolean; why: string }          // a non-publish always says why
}
```

⚠️ **This changes the codegen CORPUS, and capture is irreversible.** `galaxy.ts` writes `codegen = { model, sourceCommit, rounds, stop, appliedPaths, gate, toolCalls }` onto the durable agent Message, and [on-hold/nebula-studio-self-improvement.md](on-hold/nebula-studio-self-improvement.md) § *The folded shape* pins `gate` field by field as *"⭐ THE signal AI Gateway cannot see"*, warning that turns already written cannot be backfilled. Per-**write** granularity is traded away because that per-file verdict IS the compiler in the Worker — keeping it keeps the 8.91 MB. The field is renamed `codegen.build` in the same breath — nothing in the Worker gates anything now, so the record should not keep the name of a check that left. Per-**file** credit assignment survives: `checked` restores it at build granularity, so a written file absent from `findings` is *known clean* rather than merely *not implicated*, and the diagnostics carry file and line themselves. `rounds` still counts rounds and `toolCalls[]` still records every write. ⇒ **Tell that task's owner in this task, not after** — its pointer in § *Relationships* says latency, which is not what changes.

⚠️ **`Finding` is a `CHAT_MESSAGE_TYPES` member, not just a tool-result shape.** It replaces the persisted `gate?: { ok: boolean; errorTail?: string }`, so whatever it is must survive typia compilation under ADR-001 and rides the chat-seed regeneration this task performs. A raw diagnostic string keeps that trivial; anything structured buys a schema change in the same breath.

Three properties are deliberate. **`typeCheck` carries no `ok`**, so nothing can read it as a gate — the policy lives in the type rather than in someone's memory. That is not in tension with publishing defaulting to a findings-free build: the DEFAULT is the caller's, and the model can override it. What the missing `ok` forecloses is a *gate* — a verdict some later reader treats as final. **A skipped step says `ran: false` rather than being absent**, because an absent key reads as "fine". **`publish` always carries a `why`**, so a preview that did not refresh is never silent. Adding `run_tests` later is then a new key rather than a renegotiation of `ok`. This replaces `BuildOutcome` (`codegen-loop.ts`), whose `retryable` flag is really a different STEP failing rather than a different kind of failure — **13 references, and only 10 of them mechanical**. The eight in `src/` and two in `test-apps/baseline/index.ts` are renames. ⚠️ **`harness/scenarios/build-box.ts` is a rewrite, and it is named in § *Success*.** It declares its OWN local `type BuildOutcome`, keys shim-vs-fuse discrimination on `'buildError' in outcome` against `SHIM_SIGNATURE`, and classifies infra failures via `retryable` — none of which survives a report with no global `ok`. Because the type is local, a type sweep flags nothing: it stays green asserting a shape the system can no longer produce. Its world-discrimination limb has to be re-expressed over the `container` and `bundle` steps, and the phase must say which field carries the shim signature.

**The compiled `OntologyVersionRow` comes back through the mount, the way `dist` already does.** (The row is what compiling produces — `{ version, types, validatorBundle, relationships }` — stored by the Galaxy as one KV row and installed on a Star later.) `compileOntologyVersion` returns an `OntologyVersionRow` carrying `validatorBundle` — a whole module as a string — and `appendWorkspaceOntology` needs that row in hand to write `rowKey(row.version)` + `INDEX_KEY` inside its `transactionSync`. `runtime.exec` returns only `{status, exitCode, stdout, stderr}`, so the row rides a named path in the FUSE mount and the Galaxy reads it host-side with `ws.fs.readFile` after the exec resolves — which it already does at five sites, and which `serve.ts` calls *"the store seam — Galaxy's `ws.fs.readFile` today."* Nothing commits it: git tracks only what `git.add` is explicitly handed, which is why `dist` has never been in anyone's history. The row also stays out of the model's tool result, where a bulky emitted module has no reader. **The Galaxy keeps the append-only check, the `wipeOnInstall` write and the `transactionSync` unchanged** — only the compile moved.

**Publishing the preview is the model's call.** A type finding may be a real bug a user would hit, or a value the checker cannot see is safe; that judgement is the model's to make, the way a developer makes it. So the reload fires by default on a clean build — `galaxy.ts`'s `#buildAndAnnounce` does this today — and the model MAY override to publish alongside findings it judges harmless. It cannot publish when `bundle` failed, because there is no `dist`: that is structural, not policy. ⚠️ **Say so in `STUDIO_LOOP_SYSTEM_PROMPT`, not only in the tool schema** — a model trained to leave everything green will fix rather than judge unless told that shipping with a reasoned findings list is a legitimate outcome.

⚠️ **The loop's fix-mode machinery breaks silently unless it is re-pointed.** `codegen-loop.ts` flips `fixMode` from a `sawError` flag set at seven sites, two of which die here: the per-write gate failure, and `if (!outcome.ok) sawError = true` — which reads a global `ok` that no longer exists. Left alone, **type findings never enter fix mode at all**, so the model keeps generating at `generateParams` instead of dropping to `fixParams` (temperature 0.2). The successor is derivable and must be written down: `sawError` becomes *any* step failing or `typeCheck.findings` non-empty. `buildFixFeedback(path, content, errorTail)` also re-echoes ONE failing file's full source — a per-build findings list is not attached to one file, so it becomes a findings-plus-touched-files feedback. `codegen-loop.test.ts` is NOT untouched: it carries a *"Phase 2 — the compile error-tail round-trips into the next round"* describe block and four `r.lastGate` assertions. They exercise the real gate with zero textual `compileSource` references, which is what made the earlier "zero references" reading reassuring and wrong.

**Four prose surfaces teach the loop's contract, and all four still describe the deleted per-write compile.** `write_file`'s description (*"The file is compiled immediately; the result … is returned so you can fix it"*), `mark_complete`'s (*"all files compile cleanly"*), `build`'s three-way outcome, and three protocol lines in `STUDIO_LOOP_SYSTEM_PROMPT`. They are the contract that has to teach batch-then-build, and a cold implementer who rewrites only the tool schema leaves three of them lying.

### How the compiler reaches the container

**The bundle is the package's DISTRIBUTION format, so the container builds one too — from source, in the image.** `dist/deps.bundle.mjs` is not a workerd workaround: `prepare-for-publish.sh` rewrites `files` from `src/**` to `dist/**`, so the bundle is what every external consumer of the published package actually gets, and it is the only form in which the vendored typia fork travels. `bundle-tsc.mjs`'s header pins why it must be one pass — typia's transformer does `instanceof` against `ts.Node`, so two `typescript` instances silently return `false`. Running that same bundler during the image build, over source copied into the build context, keeps the container current with the tree by construction: a Docker `COPY` layer invalidates when its source changes, so editing the package or a fork rebundles on the next image build with no manual step to forget. ⚠️ **Prove `bundle-tsc.mjs` runs unmodified in the image rather than reasoning about it** — it resolves `typescript/package.json` and reads its `lib/` off disk, which works in a normal tree and should be demonstrated in the image.

⚠️ **Design consideration: this keeps the virtual host, and gives up cross-file checking.** The compile still runs against `createVirtualHost` with `NEBULA_API_DTS` mounted as a virtual module, so the SFC pass type-checks one file against a hand-authored contract rather than resolving the generated app's real imports in `/workspace`. A real `CompilerHost` would catch cross-file errors this cannot. That is today's behaviour either way, so it is not a regression — revisit it once the forks' fate is settled.

### Installing an ontology in a lane with no compiler

**Only one lane has no compiler.** `apps/nebula/vitest.config.js` puts `test/browser/**` on a **Node** project — its own comment reads *"Browser project — Node-side vitest tests"*, and calls the chromium project *"Distinct from the Node-side `browser` project"*. Node and workerd both carry a compiler happily, because a test Worker never deploys:

| lane | runtime | carries a compiler | what changes |
|---|---|---|---|
| `unit`, `baseline`, `dev-studio` | workerd (pool-workers) | yes | nothing; `callStarApplyOntology` keeps compiling in place |
| `browser`, `browser-bench` | **Node** | yes | imports the compile entry directly, the import `/live` already makes |
| `chromium` | real browser | **no** | the one real case |
| `frontend` | jsdom | n/a — no ontology | nothing |

⇒ **The chromium lane re-points at `StarTest.applyOntologyForTest`**, which already exists (`test-apps/baseline/index.ts`, `@mesh(requireDominionHere)`, body `this.setOntology(compileOntologyVersion(versionConfig))`) and which `test/browser/smoke.test.ts` already calls. It compiles server-side in a test app that never deploys — the case § *Where there is no container* already licenses — so the browser gets a row without ever holding a compiler. No fixture generator, no committed test rows, no keying rule.

**What is deleted rather than replaced:** `Galaxy.appendOntologyVersion`, the `callGalaxyAppendOntologyVersion` wrapper in all four clients that define it (`test-apps/baseline/index.ts`, `test/chromium/ontology-admin.ts`, `test/browser/harness-client.ts`, `test/browser/throughput-harness-client.ts`), and `star-ontology.test.ts`'s registry assertions — duplicate-label rejection, index listing, latest round-trip — which assert that method's own behaviour and cannot outlive it. Its invalid-label cases never reach a compile anyway, since `VERSION_LABEL_RE` rejects first. The benchmark and e2e call sites move to the Star initiator. `dev-studio.test.ts`'s append + lazy-pull suite and `galaxy-resource-surface.test.ts`'s surface freeze both ride `appendWorkspaceOntology`, which survives.

⚠️ **The coverage those deletions remove is accepted, then measured** (§ *Success*): the baseline is recorded, and every line that goes dark is either covered again or listed with a reason it needs nothing. `star-ontology.test.ts`'s lines going dark is the deletion working, not a regression.

### Where there is no container

Three environments have none, and the answer is the same in each: **the constraint is that tsc stays out of the WORKER's import graph, never that tsc must not run somewhere cheap.**

- **The offline replay harness** (`on-hold/nebula-offline-prompt-harness.md`, which scores model output with `compileSource`) is a Node process, and `virtual-ts-host.ts` has no workerd-only imports — so it imports the compile half directly and stays seconds-fast with no Docker. `nebula-pre-alpha.md`'s "model + gate, seconds" tight loop is unaffected.
- **pool-workers tests** keep testing the compile functions directly; a test Worker may carry tsc because it never deploys. What changes is that `codegen-gate.test.ts`'s 10 tests cover a function the Worker no longer calls on its request path, and `codegen-loop.test.ts` (23 tests, zero `compileSource` references) is untouched.
- **Local `wrangler dev`** has no kernel FUSE mount, so the shim world serves an empty `/workspace` and a container build cannot be driven there at all. That is today's situation, not a regression: it is why the build-box criteria are deploy-only.

## Constraints

- **`workflow.md` § *Startup cost is the criterion*** — the gate is work at module scope, never byte count; measure with `wrangler deploy --dry-run --outfile` then `wrangler check startup --workerBundle`, and read self-time plateaus.
- **A DO pays for its whole Worker's import graph.** A subpath export helps only once *nothing* in the Worker imports the heavy half — which is why the split and the move are one task, not two.
- **ADR-001** — TypeScript types are the schema language. Wherever the compile runs, it stays a TS compile producing the same validator; no second schema language enters.
- **`durable-objects.md`** — a Worker Loader `bundleId` is cached per-Worker-project across DO instances and must be scoped by tenant. This binds the **runtime** path, not the compile: `getParserValidatorFacet` takes a `WorkerLoader` and keys on `galaxyId/version`, so the package split must leave that scoping intact.
- **`containers.md`** — the container is a general compute platform, and adding a capability is a new job inside the existing container, never a new node.
- **`Star` has no container** — only `Galaxy` declares one, so a container-hosted compile is reachable from the Galaxy alone. The paths that exist already respect this (`Star.setOntology` receives an already-compiled row, `appendWorkspaceOntology` runs on the Galaxy), but no design here may quietly violate it.
- **`version` and `wipeOnInstall` stay HOST-computed and are passed INTO the container, never read back out.** Not as a guard: `version` is `git.hashBlob` of the source and keys the Star's Worker Loader cache, so a content-address disagreeing with its source serves a STALE validator (`durable-objects.md` § *Dynamic Worker Loader cache*), and `wipeOnInstall` is decided under a dominion check in the turn that changed the ontology. The host owns them because it is where they are known.
- **The compile shares ONE ephemeral container with `vite build`, and that is settled by TRUST, not by arrangement** (decided with Larry 2026-08-29). A tampered `validatorBundle` runs in a facet with `globalOutbound: null` and no `env`, so at worst it accepts data it should not.
- **That is a power the model already holds.** It authors the ontology those types come from, and the `App.vue` it also writes ships to real users' browsers with none of the facet's confinement — so guarding the compiler's output while handing it the app is incoherent. ⚠️ **The old invariant-and-tripwire framing is superseded; do not restore it.** The near-term direction is the model writing its own scripts and making arbitrary calls, as any coding agent does, and the question that actually bites is egress — held in `backlog.md` § *Nebula*.
- **Compiling now requires a GALAXY container, and that constrains [nebula-ontology-history-file.md](nebula-ontology-history-file.md).** Its tabled question — where compiled validator bundles live, with a Galaxy compile-cache as the candidate — stays its to settle, but a Star has no container, so any "recompile on cache miss" it designs MUST NOT sit on a Star's live request path.
- **Pre-alpha carries no per-task deploy gate**, but this task's whole point is that the batched one currently cannot run.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **The tsc-bearing surface leaves the Worker: `write_file` becomes a pure write and `build` does the checking** (§ *Where the compiling runs*, 2026-08-28) | Keeping the SFC gate in the Worker — it reaches `ts` through `checkTypeScript`, so the 8.91 MB bundle stays and the deploy stays blocked; there is no half-move. Folding the check into `vite build` as one exec, the earlier draft's shape — it assumed a turn that gates once per round, when `compileSource` runs per `write_file` and `build` is a separate model-chosen tool, so it would have put a container exec on every written file. |
| **SFC Pass 1 is deleted, not kept and not moved** (2026-08-29) — `@vue/compiler-sfc` leaves the Worker with it | Keeping Pass 1 as a container-free write-time signal — it is genuinely tsc-free and would keep syntax fix-rounds free, but it lands the bundle near ~3.8 MB, inside the wake tier `nebula-pre-alpha.md` measures at 120 ms vs 1,256 ms on an identical bundle, and it optimises feedback for the error class a model rarely produces: models write valid Vue syntax, and what they get wrong is the API misuse Pass 2 exists to catch (`codegen-gate.ts`'s JSDoc cites the invented `op: 'set'`). Paying user-visible wake latency for model-visible convenience is the wrong trade. |
| **`Galaxy.appendOntologyVersion` is deleted, not re-signatured** (2026-08-28) — its callers are re-homed per § *Installing an ontology in a lane with no compiler* | Giving it a pre-compiled-row signature — [nebula-ontology-history-file.md](nebula-ontology-history-file.md) already condemns it (scheme settled 2026-08-24: *"what dies … the four mesh methods `appendOntologyVersion` / `listOntologyVersions` / `getLatestOntologyVersion` / `getOntologyVersion`"*), so a new signature is an interim on a method scheduled for deletion, and its four call sites would change twice. Pulling all four forward — only this one compiles, and `getOntologyVersion` is the Star's live lazy-pull target. Sequencing behind that task — it has no phases and an open design question, while this one blocks every deploy. |
| **The Galaxy test-install path is DELETED, not re-homed; only the chromium lane needs a compiler-free install, and `StarTest.applyOntologyForTest` already is one** (2026-08-29) | Committed precompiled fixture rows plus a generator taking test ontologies as inputs, which an earlier draft of this row specified — it was scoped to a constraint that exists in ONE lane: `vitest.config.js` puts `test/browser/**` on a **Node** project (*"Node-side vitest tests"*), and Node and workerd both carry a compiler because a test Worker never deploys. Rejecting a server-compiling test route as *"reintroducing the capability this task removes"* — `applyOntologyForTest` lives in `test-apps/`, outside the deployed graph, which § *Where there is no container* already licenses, and `smoke.test.ts` calls it today. Porting the registry assertions onto a survivor — they assert `appendOntologyVersion`'s own behaviour, so a port keeps a suite green while it means nothing. |
| **`build` returns per-step outcomes; there is no global `ok`** (§ *What `build` returns*, 2026-08-28) | The `BuildOutcome` three-way union — one boolean forces every step to fold into it, and folding in the type check means deciding whether a finding is fatal, which is the judgement this design hands to the model. Its `retryable` flag also models a different STEP failing as a different KIND of failure. |
| **A failing step carries a bounded RAW tail of the tool's own output, never a summarized `detail`** (2026-08-28) | Prose summaries — they discard the line/column numbers, snippets and error codes a model reads fluently, and we would be deciding in advance what mattered. `codegen-gate.ts`'s existing `MAX_ERROR_TAIL = 4000` is the pattern. Replacing the structured report with logs alone — its second consumer is the SYSTEM (`#buildAndAnnounce` decides publish, the loop decides fix-round vs retry-same-code, tests and `/live` assert), and "the container never started" and "your types are wrong" are the same prose to a grep. Writing the full log to the VFS behind a `read_file` tool — deferred to `backlog.md` § *Nebula*: no present consumer has hit the 4 KB tail, and unlike the usual case the general form costs materially more (a new tool, a non-committed workspace path since `writeSource` git-commits every write, and DO storage growth). |
| **Publishing the preview is the model's call, overridable against type findings** (2026-08-28) | Publishing only on a findings-free build — a hard gate where this repo's stance is an advisory practice with an override, and it forecloses the judgement a developer makes routinely: this finding is real, that one the checker cannot see is safe. A standalone `publish` tool instead of an override — it adds a forget-to-publish path whose failure is a silently stale preview. |
| **The compile source is COPIED into the image and bundled THERE, at image-build time** (2026-08-28) — `bundle-tsc.mjs` runs inside the build, over the package's `src/` and the four vendored `forks/typia/*` declared in a container-side manifest | Copying the prebuilt `dist/deps.bundle.mjs` — nothing in the dev loop regenerates it (only publish, CI `--bundle`, or a manual `npm run bundle`), so the image would ship whatever was last bundled by hand; the `--check` added 2026-08-28 makes that staleness loud, not absent. Running the copied source directly under Node's type-stripping — the forks are namespace/enum-heavy (114/122/61/47 hits across 497 files), which is not erasable syntax. `npm install`ing the published package — the fork travels only in its `dist`, and the registry version lags the tree this task is editing. |
| **The bound `worker_loaders: [{ binding: "LOADER" }]` stays unused for compiling** (2026-08-28) | A dynamically-loaded Worker — `build` is the tool that now does the checking and `build` is a container operation, so running the type check in a Loader fragments ONE model tool call across two runtimes, and the Loader would need its own delivery of the bundle beside the image's. Its per-Worker-project `bundleId` cache still binds the RUNTIME facet either way (§ *Constraints*). |
| **`typia` is dropped from the package's devDependencies** (2026-08-28) — only `@typia/transform` and `typescript` are functional deps | Keeping it for provenance — the compile path never resolves it: `generate-parse-module.ts` mounts `TYPIA_DTS_STUB` at `/typia/lib/module.d.ts` and points `paths` there, the runtime helpers are inlined as strings, and `bundle-tsc.mjs`'s barrel bundles only `typescript` + `@typia/transform`. The version it was copied from is already recorded in `typia-runtime-helpers.ts`. |
| **`@lumenize/ts-runtime-parser-validator` splits by subpath export** — a runtime entry (`facet-helper` + the types, no compiler) and a compile entry (2026-08-28) | One barrel with the compile half tree-shaken out — esbuild cannot drop it, because `getParserValidatorFacet` and `generateParseModule` are reached through the same specifier and the compile half does its work at module scope. The split is a public API change on a published package; the emitted validator is unaffected either way, since its typia helpers are inlined as text rather than imported. |
| **No latency threshold is pinned for the check; the per-round cost is measured and recorded, not gated** (2026-08-28) | A pass/fail budget as a success criterion — an 82% bundle cut is the outcome that matters, and a threshold invented before anyone has felt loop latency is a number to argue with later rather than evidence. |
| **The precompiled chat + tool-args modules are checked in as source, kept honest by a Node-side `--check` that rebuilds and diffs, run ahead of vitest in `apps/nebula`'s `test` script** (2026-08-28) | A wrangler `build.command` — measured, `vitest-pool-workers` does not run it, so the suite would green against an artifact only the deploy has. Regeneration by convention, as `dist/deps.bundle.mjs` did before 2026-08-28 — fine for a pinned dependency version, wrong for constants someone edits by hand. |

## Phases

Ordered so the deploy stays broken until the last compile site is gone, then proven. Phases 1–3 each
remove compile sites without changing behaviour; 4 builds the replacement beside the old path; 5 cuts
over; 6 is the payoff.

1. **The package stops forcing its consumers to take a compiler.** Split
   `@lumenize/ts-runtime-parser-validator` into a runtime entry (`facet-helper` + its types) and a
   compile entry, and move each consumer to the one it needs — `galaxy.ts`/`star.ts` to runtime,
   `ontology-compile.ts`/`codegen-gate.ts` to compile.
   - **Success criteria:** a module importing only the runtime entry type-checks and its bundle
     contains no `typescript`; `npm test -w @lumenize/ts-runtime-parser-validator` stays green;
     the published `exports` map lists both entries and no bare `"."`.
   - **Mutation:** point `star.ts` back at the compile entry → the bundle check reds.
   - ⚠️ Nothing is unblocked yet — the app barrel still re-exports the compile half (phase 6).

2. **The two constant validators stop being compiled at runtime.** A one-shot generator emits the chat
   seed's `OntologyVersionRow` and the tool-args validator module as committed literals; `--check`
   rebuilds and diffs them ahead of vitest; register the generator in
   `scripts/generated-artifact-hook.sh`'s `case` list.
   - **Success criteria:** `chatOntologySeedRow` and `#ensureToolArgsFacet` contain no compiler call —
     the § *Every compiler call site* grep no longer returns them; the `--check` exits non-zero after
     editing `CHAT_MESSAGE_TYPES` without regenerating; `TOOL_ARGS_BUNDLE_ID` is unchanged, so the
     Worker Loader cache is not invalidated.
   - **Mutation:** edit one character of `TOOL_ARGS_TYPES` and run the suite → `--check` reds.
   - **Replacement obligation:** none — this phase deletes no test.

3. **The dead Galaxy test-install path goes.** Delete `Galaxy.appendOntologyVersion`, the
   `callGalaxyAppendOntologyVersion` wrapper in all four clients that define it, and
   `star-ontology.test.ts`'s registry assertions; re-point the benchmark and chromium call sites at
   `callStarApplyOntology` / `StarTest.applyOntologyForTest`.
   - **Success criteria:** `grep -rn 'appendOntologyVersion' apps/nebula` returns nothing outside this
     task file; `galaxy-resource-surface.test.ts`'s frozen mesh surface no longer lists it and the test
     is updated in the same commit; the `browser`, `browser-bench` and `chromium` lanes still install an
     ontology and stay green.
   - **Mutation:** leave one wrapper behind → the grep criterion reds.
   - **Replacement obligation:** the duplicate-label, index-listing and latest-round-trip assertions are
     **not replaced** — they assert a deleted method's own behaviour. Their lines going dark is recorded
     in phase 7's list, not repaired.

4. **The container gains a compile job, beside the old path rather than replacing it.** Copy the
   package source and the four vendored `forks/typia/*` into the image behind a container-side manifest
   that is NOT `container/app/package.json`; run `bundle-tsc.mjs` during the image build; wrap the
   container's job so it runs EVERY step and reports each — ontology compile, type check, bundle —
   returning `BuildReport` with per-step outcomes and the compiled row carried back host-side.
   ⚠️ **No step gates another.** A type finding does not stop the bundle: `@vitejs/plugin-vue`
   transpiles rather than type-checks, so a `.vue` carrying a real `TS2339` still produces a `dist`,
   and stopping there would make the model's publish override unreachable by construction — the very
   hard gate § *Decisions* rejects. Only `bundle`'s own failure means there is no `dist`.
   - **Success criteria:** an image build produces `deps.bundle.mjs` inside the image and editing a
     fork source invalidates that layer; a driven build returns a `BuildReport` whose `typeCheck.checked`
     names the files tsc looked at; **a `.vue` with a real type error yields `typeCheck.findings`
     non-empty AND `bundle: { ran: true, ok: true }` with a `dist`** — the criterion that isolates the
     no-gating property; the Galaxy reads the row back host-side and `git status` shows it untracked.
   - **Mutation:** make the bundle conditional on a clean type check → the type-erroring build returns
     no `dist` and the isolating criterion reds.
   - ⚠️ **Prove `bundle-tsc.mjs` runs unmodified in the image** rather than reasoning about it — it
     resolves `typescript/package.json` and reads its `lib/` off disk.

5. **The Worker cuts over and stops compiling.** `write_file` becomes a pure write; delete
   `compileSource` from the request path, both SFC passes with it; re-point `sawError`/`fixMode` at the
   report; rename `codegen.gate` to `codegen.build` and reshape it to `typeCheck.checked` + `findings`, regenerating the chat-seed
   literal; rewrite the four prose surfaces (`write_file`, `mark_complete`, `build`,
   `STUDIO_LOOP_SYSTEM_PROMPT`) and `harness/scenarios/build-box.ts`.
   - **Success criteria:** a codegen turn that writes a type-erroring `.vue` still reaches
     `mark_complete` — build, read findings, fix, rebuild — driven live, with rounds and container
     cycles recorded; **no compiling, type-checking or gating survives in the Worker — in code OR in
     the words that describe it**: the § *Every compiler call site* grep returns nothing under
     `apps/nebula/src`, and no tool description or system-prompt line still tells the model a written
     file "is compiled immediately" or that it should call `build` "when every file compiles cleanly";
     `build-box.ts` discriminates shim from FUSE without `'buildError' in outcome`.
   - **Mutation:** leave `sawError` unset for type findings → the loop never drops to `fixParams` and
     the live convergence criterion reds.
   - **Replacement obligation:** `codegen-loop.test.ts`'s *"compile error-tail round-trips"* block and
     its four `r.lastGate` assertions are rewritten against the build's findings, not deleted — the
     behaviour survives, only its trigger moves.

6. **The deploy works, and cannot silently break again.** Cut the app-side barrel re-exports
   (`galaxy.ts` → `index.ts` → `worker.ts`) so nothing reachable from the Worker entry imports the
   compile entry; add the import-graph tripwire; deploy; re-measure.
   - **Success criteria:** `npm run deploy:test` from `apps/nebula` completes and the self-check reports
     `match:true`; the tripwire passes and reds when a `generateParseModule` import is reintroduced
     anywhere in the entry graph; bundle and startup are recorded against 12,957 KiB / 362 ms;
     `HARNESS_TARGET_URL=<url> npx tsx apps/nebula/harness/drive.ts build-box` reaches `world: 'fuse'`.
   - **Mutation:** re-add `import { generateParseModule }` to `galaxy.ts` → the tripwire reds and the
     deploy fails again, which is the whole point.

7. **The siblings stop carrying stale copies, and what went dark is listed.** Collapse the backlog row
   to a pointer; trim `nebula-pre-alpha.md`'s wipe item 2 and decide item 3 ("no split") on the
   re-measured number; re-run coverage and account for the delta.
   - **Success criteria:** no sibling restates this task's measurements; every line dark against the
     recorded baseline is either covered again or listed with a stated reason it needs nothing.
   - ⚠️ **This phase is last on purpose** — it edits standing guidance and sibling files describing an
     end state only phases 1–6 produce, and the coverage delta is meaningless before then.

## Non-goals

- **Arbitrary in-container commands and a selective log-query tool** — `backlog.md` § *Nebula*, deferred
  with its egress-choke security question.
- **A real `CompilerHost` for cross-file type checking** — § *How the compiler reaches the container*'s
  design consideration; it is also what would force the compile into its own container.
- **The ontology history file and the KV registry's other three condemned methods** —
  [nebula-ontology-history-file.md](nebula-ontology-history-file.md); only `appendOntologyVersion` moves
  forward, because only it compiles.
- **Raising coverage to a number.** The criterion is the list (§ *Success*); some lines should stay dark.

## Success, stated so it can fail

- **`npm run deploy:test` (from `apps/nebula`) completes and the self-check reports `match:true`.** That is the whole point; everything else is a means. ⚠️ Not runnable at review time — it deploys.
- **The bundle and startup numbers are re-measured and recorded**, against the 12,957 KiB / 362 ms baseline above — not asserted as "smaller". ⚠️ **That measurement discharges the stated precondition of `nebula-pre-alpha.md`'s wipe item 3** (*"Middle-tier analysis + split decision … after item 2, re-measure the main Worker's bundle"*), whose own warning is that moving a DO class between Workers projects is cheap now and materially harder once live tenants exist. The ablation already puts the answer at 2,294 KiB — inside item 3's "cheap and stable" tier — so **item 3 is decided in this task's trim, most likely "no split"**, rather than left open behind a window that shuts at the same gate.
- **The per-round gate cost is recorded before and after, and gates nothing.** A number to look at, not a threshold to pass (§ *Decisions*).
- **The deploy-only scenarios finally run**: `HARNESS_TARGET_URL=<url> npx tsx apps/nebula/harness/drive.ts build-box` reaches the FUSE world (limb 1 decides `world: 'fuse'`, not `'shim'`), which no local run can do. ⚠️ Not runnable at review time — it needs the deployed URL. The `build-box` scenario is registered in `drive.ts` (verified 2026-08-28).
- **The blocker cannot silently return**: an import-graph tripwire asserts that **no module reachable from `src/worker.ts` imports the package's compile entry or `@vue/compiler-sfc`**. Stated over the Worker ENTRY GRAPH, never a directory and never a byte count — a directory rule reds on the intended end state, since `compileSource` and `ontology-compile.ts` deliberately survive in `src/` for the test lanes and the Node-side regenerator, and it would miss `@vue/compiler-sfc` entirely. One `import` re-blocks the deploy while greening the whole suite, which is how this stayed invisible for eight weeks; a recorded measurement is not a guard.
- **Every line that goes dark is covered again OR listed with a stated reason it needs nothing.** Baseline taken 2026-08-29 on `apps/nebula` before any deletion — 93 files, 726 passing, 1 failing (`invite-facade.test.ts`, pre-existing, `backlog.md` § *Nebula Auth*), 3 skipped:

  | | covered | CLAUDE.md target |
  |---|---|---|
  | lines | 91.87% (2622/2854) | — |
  | statements | 90.01% (2875/3194) | >90% — clears by 0.01 |
  | branches | 78.32% (1474/1882) | >80% — **already under** |
  | functions | 89.13% (525/589) | — |

  Reproduce with `COVERAGE=true npx vitest --run --coverage --coverage.reportOnFailure --project unit --project frontend --project baseline --project dev-studio --project browser` from `apps/nebula`. ⚠️ **The criterion is the LIST, never the percentage.** A number as the target buys tests that execute lines while asserting nothing, which is the defect this file's own review kept finding; and some lines *should* stay dark — `star-ontology.test.ts` covers a method that will not exist, so its going dark is the deletion working. A reviewer can check a list-and-justify; a percentage cannot tell a restored guarantee from a restored line.
- **The loop still converges, measured on both sides.** A prompt that produces a broken `.vue` reaches `mark_complete` — build, read `typeCheck.findings`, fix, rebuild — with **rounds and container cycles per turn recorded before and after**, since the error path moves from zero cycles to one per fix. Driven live (or by the `ui-smoke` codegen test this task unblocks), never asserted from unit tests: the whole change is about what the real loop does.
- **The RESOURCE path is untouched** — a Galaxy and a Star still load the generated validator through the facet, and the resource suites stay green without changes to what they assert. ⚠️ The **ontology-registry** suites do change, and saying so is the point: `star-ontology.test.ts`'s registry assertions are deleted with the method they cover, and the browser lanes install committed rows instead of compiling (§ *Installing an ontology in a lane with no compiler*).

