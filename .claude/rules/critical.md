# Critical Rules

Non-negotiable and repo-wide. These load every session — obey them and self-check your own work against them. Everything here is a **MUST**; the path-scoped rule for each domain carries the detail and the reasoning.

- **npm only** — pnpm and yarn MUST NOT be used, and nothing MAY be installed globally. You MUST ask before adding any dependency.
- **Synchronous storage only** — a DO MUST use `ctx.storage.kv.*` or `ctx.storage.sql.*` (or `this.svc.sql` in mesh DOs). The legacy async API (`await ctx.storage.get/put/delete`) MUST NOT be used.
- **`Env` MUST NOT be hand-written** — run `npm run types` (`wrangler types`) and use the generated global `Env` from `worker-configuration.d.ts`. `interface Env`, `MyEnv`, and `AuthEnv` MUST NOT appear. (Intersection-widening on the generated `Env` — `Env & { X?: T }` — MAY be used for source compiled under multiple packages' programs; see `packaging.md`.)
- **Every `wrangler.jsonc` MUST declare `compatibility_date: "2026-03-12"`** or later.
- **Secrets MUST NOT be committed** — they MUST NOT appear in source, `wrangler.jsonc`, `tsconfig.json`, or any other committed file, and live only in the gitignored root `.dev.vars` (auto-symlinked via `postinstall`). Test-mode flags (e.g. `LUMENIZE_AUTH_TEST_MODE`) MUST go in vitest `miniflare.bindings`, and MUST NOT go in `wrangler.jsonc` `vars`.
- **Docs live in `/website/docs/`** — `.md` by default; `.mdx` MAY be used only with explicit human approval. Temp docs MUST NOT be created elsewhere. (When `.mdx` is justified → `documentation.md`.)
