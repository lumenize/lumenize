# Working in This Repo

## Task files
Work is tracked in `tasks/`:
- `tasks/backlog.md` — small tasks and ideas
- `tasks/[project-name].md` — active multi-phase projects
- `tasks/on-hold/` — designed but paused, expected to resume
- `tasks/icebox/` — parked indefinitely, no planned return (colder than on-hold)
- `tasks/archive/` — completed projects + point-in-time decision/research records (`decision-*.md`). **Frozen on entry — never update an archived file** (no link fixups, no terminology syncs, no code-drift corrections); sole exception: a dated superseded banner at the top. See `tasks/README.md`.

Use `/task-management` to choose docs-first vs task-file-first when starting a project. When the plan changes mid-stream from what you learn in earlier steps, propose updates to the task file, and summarize what changed after each step. **Not every change needs a task file** — process/organizing tweaks (editing rules, moving content) can be done directly. See `tasks/README.md` for templates.

## Architecture commitments (ADRs)
`docs/adr/` holds the few repo-shaping commitments — decisions that span packages and survive mechanism swaps (`docs/adr/README.md` has the bar; adding an ADR means adding its one-liner here). `/review-task` reads the full files; these one-liners are the always-loaded constraints:
- **ADR-001** — TypeScript types ARE the schema language; never introduce a second schema language (Zod, JSON Schema, …). The mechanism is typia now; the principle is the commitment.
- **ADR-002** — every surface (wire, storage, validation, diff/patch, history) round-trips the full structured-clone value space, incl. cycles, aliases with identity, Errors, Web API types. A JSON-only surface is never acceptable.
- **ADR-003** — mesh flows are one-way messages + continuations; nothing depends on request/response across hops (the per-hop awaited Workers RPC is transport, not architecture). No RpcTarget/Cap'n Web sessions.
- **ADR-004** — resources are Snodgrass-style snapshot sequences; history is the substrate. No destructive writes; "current" queries honor the `END_OF_TIME` sentinel.
- **ADR-005** — optimistic concurrency: forward-only eTags prove currency AND provide idempotency (`newETag` replay detection); no locks, no dedupe ledger; non-monotonic checks (permissions, not-found) stay inside the transaction.
- **ADR-006** — resources reference each other by id (FK), never by embedding; a field typed as another ontology type is a relationship rewritten to `string`/`string[]` in the write shape. Related resources are separate ops in one atomic transaction (client supplies every id). Nesting is composition *within* one resource's value only. Embedding an object in a reference field is a loud error. FK referential integrity is deferred (intra-Star, same-transaction scope).

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
- **New experiment**: create `experiments/<name>/` (own `package.json`, `wrangler.jsonc`, etc.), add `"experiments/<name>"` as an **individual** entry (not a glob) to the root `package.json` `workspaces` list, then `npm install` at the repo root. Individual entries are load-bearing — `experiments/*` would break `npm install` the moment one experiment references a renamed/deleted package.
- **Broken old experiment**: remove its entry from `workspaces` (or delete the dir if results are captured elsewhere). Do **not** make it run again.
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
