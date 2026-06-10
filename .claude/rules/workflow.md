# Working in This Repo

## Task files
Work is tracked in `tasks/`:
- `tasks/backlog.md` — small tasks and ideas
- `tasks/[project-name].md` — active multi-phase projects
- `tasks/decisions/` — research findings and technical decisions
- `tasks/on-hold/` — designed but paused, expected to resume
- `tasks/icebox/` — parked indefinitely, no planned return (colder than on-hold)
- `tasks/archive/` — completed projects

Use `/task-management` to choose docs-first vs task-file-first when starting a project. When the plan changes mid-stream from what you learn in earlier steps, propose updates to the task file, and summarize what changed after each step. **Not every change needs a task file** — process/organizing tweaks (editing rules, moving content) can be done directly. See `tasks/README.md` for templates.

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

## Experiments
`experiments/*` are point-in-time spikes, not maintained artifacts. Results live in the experiment's `RESULTS.md` / `FINDINGS.md` / blog post, not in keeping the code runnable. An experiment commonly breaks soon after it runs because we change the source it depended on — **that's fine; don't fix it.**
- **New experiment**: create `experiments/<name>/` (own `package.json`, `wrangler.jsonc`, etc.), add `"experiments/<name>"` as an **individual** entry (not a glob) to the root `package.json` `workspaces` list, then `npm install` at the repo root. Individual entries are load-bearing — `experiments/*` would break `npm install` the moment one experiment references a renamed/deleted package.
- **Broken old experiment**: remove its entry from `workspaces` (or delete the dir if results are captured elsewhere). Do **not** make it run again.

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
