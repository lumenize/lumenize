# Working in This Repo

## Task files
Work is tracked in `tasks/`:
- `tasks/backlog.md` — small tasks and ideas
- `tasks/[project-name].md` — active multi-phase projects
- `tasks/on-hold/` — designed but paused, expected to resume
- `tasks/icebox/` — parked indefinitely, no planned return (colder than on-hold)
- `tasks/archive/` — completed projects + point-in-time decision/research records (`decision-*.md`). **Frozen on entry — never update an archived file** (no link fixups, no terminology syncs, no code-drift corrections); sole exception: a dated superseded banner at the top. See `tasks/README.md`.

Use `/task-management` to choose docs-first vs task-file-first when starting a project. When the plan changes mid-stream from what you learn in earlier steps, propose updates to the task file, and summarize what changed after each step. **Not every change needs a task file** — process/organizing tweaks (editing rules, moving content) can be done directly. See `tasks/README.md` for templates.

## Design-first: diagrams before prose when the design is tangled
When a multi-node/mesh design gets tangled — or when task files have drifted into mutual contradiction — **lead with sequence diagrams (a participant/cast model + per-flow diagrams), not prose.** Prose hides contradictions; a diagram's participants + ordering + gating force precision and make the drift visible (this is what the Phase-3.5 review kept surfacing, and what `tasks/nebula-dev-flows.md` was built to fix — Larry: "my mind works better with sequence diagrams than prose"). Nail the cast + naming + flows *with the user* first, **then** rewrite the prose/task files to conform. Proactively offer this when you sense the design space is tangled. Mermaid traps: no `;` in `Note` text (statement separator → parse error); solid `->>` = call/request, dashed `-->>` = response/return/push. **After every Mermaid write/edit, run the mechanical render-safety check before considering it done** — knowing the traps is NOT enough on its own (this guidance was already in place when the `;`-in-`Note` bug got *reintroduced right after being fixed*; you can't visually render from here, so verify with the grep, then have the human eyeball the actual render). Extract the fenced `mermaid` blocks and grep for the killer `;` — it should print nothing:

```sh
awk '/[`][`][`]mermaid/{m=1;next} /[`][`][`]/{m=0} m' <file> | grep ';' || echo "clean"
```

(Applies equally to Mermaid in `website/**` docs — see `documentation.md`.)

**Stray invisible characters (U+00A0 non-breaking space, U+0000 NUL):** two vectors, same class of bug — a byte you can't see in the rendered diff. (1) Some WYSIWYG markdown editors (e.g. Typora) silently insert **NBSP** on edit; they break exact-match string edits (the `Edit` tool can't match an "identical" line) and can break rendering. (2) An **agent `Edit`/`Write` can inject a NUL** into a string literal that reads as a space in the diff — it compiles and runs (NUL is a valid string char), so it passes type-check *and* tests; the `/build-task` verifier panel caught one as the separator inside a `` `${a} ${b}` `` dedup key. After editing any file (source too, not just markdown a human has open), grep should print nothing — `grep -nP '[\xc2\xa0\x00]' <file>` — and strip with `perl -i -pe 's/\xc2\xa0/ /g; s/\x00/ /g' <file>`.

## Evaluating alternatives: weigh the unlearning tax, not just build cost
When you compare options and **recommend** one (interim-vs-target, build order, scope cut, design choice), make the **unlearning tax** an explicit criterion alongside build cost — and usually the deciding one. The bottleneck is **reviewer time**, not lines of code. A known-temporary artifact ("interim") that lands in a surface re-read every session — code, docs, task files, agent memory — gets re-anchored on as "the model" and must be **unlearned, repeatedly, at the reviewer's expense.** (Empirically the single largest drain on pre-alpha review time has been unlearning the `acme.app.dev` interim — see the `interim-unlearning-tax` memory.)

Score each candidate on this, and say so when you recommend:
- **Interim cost ≈ (how many re-read surfaces reflect it) × (its lifetime) × (sessions over that life)** — paid in the bottleneck reviewer's correction time, *not* in build size. An option that is cheaper to *build* but seeds a durable, widely-reflected interim is usually the **more expensive** choice. Recommend accordingly, and name this tax in the trade-off.
- **Prefer building the target over a lean interim _when the target is pinnable now_.** A half-pinned "final" becomes its own interim and costs the same tax → the move is **pin → purge → build**, not rush-to-final. Don't over-pin either: pin only what the current step needs to stop describing the model wrongly; leave genuinely-later mechanics as clearly-fenced "not yet built" pointers (not interims).
- **When an interim is genuinely unavoidable, minimize its tax:** single-source it (one constant, not scattered), label it `TEMP → target=X` at every site, and record it (memory / task file) as a **dead interim, model is X** — never as the model. Task files state the **target in present tense**; the interim is a fenced, dated exception.
- **Self-check before trusting current code:** reading any default / scope / identity / config value, ask "**target or interim?**" — don't assume the current code is the model.

## Architecture commitments (ADRs)
`docs/adr/` holds the few repo-shaping commitments — decisions that span packages and survive mechanism swaps (`docs/adr/README.md` has the bar; adding an ADR means adding its one-liner here). `/review-task` reads the full files; these one-liners are the always-loaded constraints:
- **ADR-001** — TypeScript types ARE the schema language; never introduce a second schema language (Zod, JSON Schema, …). The mechanism is typia now; the principle is the commitment.
- **ADR-002** — every surface (wire, storage, validation, diff/patch, history) round-trips the full structured-clone value space, incl. cycles, aliases with identity, Errors, Web API types. A JSON-only surface is never acceptable.
- **ADR-003** — mesh flows are one-way messages + continuations; nothing depends on request/response across hops (the per-hop awaited Workers RPC is transport, not architecture). No RpcTarget/Cap'n Web sessions.
- **ADR-004** — resources are Snodgrass-style snapshot sequences; history is the substrate. No destructive writes; "current" queries honor the `END_OF_TIME` sentinel.
- **ADR-005** — optimistic concurrency: forward-only eTags prove currency AND provide idempotency (`newETag` replay detection); no locks, no dedupe ledger; non-monotonic checks (permissions, not-found) stay inside the transaction.
- **ADR-006** — resources reference each other by id (FK), never by embedding; a field typed as another ontology type is a relationship rewritten to `string`/`string[]` in the write shape. Related resources are separate ops in one atomic transaction (client supplies every id). Nesting is composition *within* one resource's value only. Embedding an object in a reference field is a loud error. FK referential integrity is deferred (intra-Star, same-transaction scope).
- **ADR-007 (Accepted)** — every Lumenize node type shares one **narrow comms + guards core** — `lmz.call` (receive), `lmz.ctn` (outgoing), `callContext`, `onBeforeCall`, `@mesh()` — by **composition**, never reimplemented. Storage (`lmz.sql`)/alarms/`onStart`/`fetch` are **per-node-type capabilities, NOT the invariant** (a node takes only what it needs — Worker and the container node take neither alarms nor `onStart`). New types compose it regardless of base class. Mechanism = `executeEnvelope`/`EnvelopeExecutorNode`, now realized by **3 of 4** types (`LumenizeDO`/`LumenizeWorker`/`LumenizeContainer`); the `LumenizeClient` hand-rolls a parallel path — classified as justified browser/Node compat (no ALS), not consolidated. Accepted 2026-06-17 (Q5 spike GOed + the 4th type — `LumenizeContainer`/`NebulaContainer` — landed).
- **ADR-008 (Accepted)** — within a Star, the full org/permission tree (nodes, edges, grants, **admin identity**) is visible to every member; **visibility ≠ capability** — enforcement is at the point of action, never secrecy of the tree (which was never a control). Org structure is **not confidential by design** within a Star, so it's not a leak to mitigate. **No per-subtree hiding** — need invisibility? use a separate Star. The denied-node set is **always disclosed** (drives request-access; a query caller already named those nodes). Hard dependency: enforcement at the point of action — this relaxes no access-control requirement. Reopen **only** on a new attack class rooted in tree visibility. Accepted 2026-06-30.

## Related skills
- `/task-management` — docs-first vs task-file-first
- `/refactor-efficiently` — incremental API changes with the `.only` pattern
- `/release-workflow` — publish packages to npm

## Key npm scripts (from repo root)
- `npm install` — install + `postinstall` (symlinks `.dev.vars` and `cloudflare-test-env.d.ts` into packages)
- `npm run types` — generate `worker-configuration.d.ts` for all packages; **run before writing code that uses `Env`**
- `npm run type-check` — TypeScript check across packages
- `npm test` — code tests + doc-example validation; `npm run test:code` — vitest only; `npm run test:doc` — validate doc code examples

## Dependencies
- **Ask before installing any npm package.** Favor copy-paste-with-attribution over a dependency for <1000 SLOC (add an entry to `ATTRIBUTIONS.md` *and* a comment above the copied code).
- Permissive licenses only (MIT, Apache-2.0, BSD-3-Clause, ISC). Prefer smallest built footprint over fastest, and strongest Cloudflare Workers compatibility. Never install globally.

## Sequential implementation — no parallel worktrees
One long-running branch, implemented sequentially. Never parallelize code-writing across worktrees, parallel PRs, or concurrent write-agents — in this solo workflow, merge/conflict cost exceeds any speedup. Parallel agents are for reading and verifying (review panels, verifiers), never for writing code concurrently. Worktree isolation is fine only for self-contained experiments whose code never merges back (next section); if a worktree's code would need to come back, don't use a worktree.

Empirical confirmation (§5.3.7 Nebula-frontend, the largest single-batch build): one file (`nebula-client.ts`) was threaded through 9 of ~24 phase commits, the phases formed a strict chain (engine → client → store → subscribe → e2e → deletions, where the deletion phase depends on *all* prior phases by construction), and at least one cross-phase dependency was invisible at plan time (a later phase fixed an earlier phase's code). Parallel writers would have N-way-merged the hot file for zero wall-clock gain — each phase was minutes of transcription. The only genuinely independent phases were two leaf-utility ports, exactly the cases where parallelism saves nothing. Not even a narrow exception is worth it.

## Experiments
`experiments/*` are point-in-time spikes, not maintained artifacts. Results live in the experiment's `RESULTS.md` / `FINDINGS.md` / blog post, not in keeping the code runnable. An experiment commonly breaks soon after it runs because we change the source it depended on — **that's fine; don't fix it.**
- **Tracked by default.** `experiments/` is *not* git-ignored — just commit new experiment files like any other code (no `git add -f`). Only experiment-local generated output stays ignored (`node_modules`/`dist`/`.wrangler`/`coverage`/`__screenshots__`/`.dev.vars` via global rules, plus targeted `experiments/...` rules in `.gitignore` for any bulk-generated artifacts, as `experiments/tsgo-benchmarks/schemas/` does). (It used to be ignored — a footgun, since a `workspaces` entry pointing at a clone-absent dir breaks `npm install` on a fresh clone.)
- **New experiment**: create `experiments/<name>/` (own `package.json`, `wrangler.jsonc`, etc.), add `"experiments/<name>"` as an **individual** entry (not a glob) to the root `package.json` `workspaces` list, then `npm install` at the repo root. Individual entries are load-bearing — `experiments/*` would break `npm install` the moment one experiment references a renamed/deleted package.
- **Broken old / stale experiment**: remove its entry from `workspaces`, and once its results are captured elsewhere (task file / `RESULTS.md` / blog post) `git rm -r experiments/<name>` rather than letting it rot. Do **not** make it run again. The `workspaces` list holds only currently-active experiments; git tracks active + not-yet-pruned ones, so prune periodically.
- **Adopting a spike's result**: when a spike proves something works via specific build tooling, productionize that tooling into the real package *before* the integration phase — don't leave it in the experiment. (The tsc-bundling spike worked; the missing productionization broke every vitest-pool-workers test when Ontology was wired into Galaxy/Star. The live pattern: `packages/ts-runtime-parser-validator/scripts/bundle-tsc.mjs`, whose header is the canonical doc.)

## No build during development
Source runs directly — **never add or run a build step in the dev loop.** vitest transpiles Workers TypeScript on the fly; Node tooling is JS + JSDoc (no compile). A build happens **only at publish**. Reaching for a build during development is a recurring failure mode: it spawns doom loops chasing build caches, `dist/`-vs-`src/` confusion, and stale output. If something isn't working, the fix is never "build it."

## Releases
All packages publish together with synchronized versions (Lerna); publish scripts repoint `package.json` from `src/` to `dist/`, then revert (the only time a build runs). Favor breaking changes over technical debt — they bump major semver and need the next release flagged. Use `/release-workflow`.

## Semantic code search
For conceptual searches ("where do we validate JWTs", "what handles rate limiting"), use Probe: `npx -y @probelabs/probe search "<query>" [path]` — AST-aware, fully local, returns whole functions/classes. `Grep` stays the default for literal strings and symbols.

## Reference
- `.claude/settings.json` — permissions (committed). `.claude/settings.local.json` — personal overrides (gitignored, takes precedence).
- `.dev.vars.example` — env var template. `tasks/README.md` — task templates.
- Cloudflare MCP — direct access to CF APIs (D1, KV, R2, Workers) and documentation search.
