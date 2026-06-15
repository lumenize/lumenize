# Critical Rules

Non-negotiable and repo-wide. These load every session — obey them and self-check your own work against them. Detail for each lives in the path-scoped rule for its domain.

- **npm only** — never pnpm or yarn. Never install globally. Ask before adding any dependency.
- **Synchronous storage only** — `ctx.storage.kv.*` or `ctx.storage.sql.*` (or `this.svc.sql` in mesh DOs). Never the legacy async API (`await ctx.storage.get/put/delete`).
- **Never hand-write `Env`** — run `npm run types` (`wrangler types`) and use the generated global `Env` from `worker-configuration.d.ts`. No `interface Env`, no `MyEnv`/`AuthEnv`. (Intersection-widening on the generated `Env` — `Env & { X?: T }` — is allowed for source compiled under multiple packages' programs; see `packaging.md`.)
- **`compatibility_date: "2026-03-12"`** or later in every `wrangler.jsonc`.
- **Secrets never committed** — they live only in the gitignored root `.dev.vars` (auto-symlinked via `postinstall`). Never in source, `wrangler.jsonc`, `tsconfig.json`, or any committed file. Test-mode flags (e.g. `LUMENIZE_AUTH_TEST_MODE`) go in vitest `miniflare.bindings`, never in `wrangler.jsonc` `vars`.
- **Docs live in `/website/docs/`** — `.md` by default; `.mdx` only with explicit human approval. Never create temp docs elsewhere. (When `.mdx` is justified → `documentation.md`.)
