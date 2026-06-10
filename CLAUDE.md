# Lumenize Project Context

Lumenize is two things:
1. A de✨light✨ful suite of MIT-licensed packages any developer can use on Cloudflare's Workers Development Platform, with particular focus on Durable Objects.
2. A SaaS platform, Nebula, for solopreneurs and intrapreneurs to agenticly build products that are secure by default. Nebula's developer-users are domain experts but often have no coding experience. Opinionated where it matters, flexible where it counts; no foot-guns — even when we let you break a rule, you're loudly warned. Nebula code is `UNLICENSED` until external launch.

Nebula is the **only app** and the packages' **first consumer** — building Nebula is dogfooding Mesh and friends. When Nebula code fights a package API (missing capability *or* awkward ergonomics), that's product feedback for the package: surface it (backlog item, or extend the package), don't quietly work around it in Nebula.
 
For both, the guiding principles are quality and great LLM DX. Prioritize clear patterns and guard against footguns. Security is on by default. Test coverage targets: Branch >80%, Statement >90%.

---

## How conventions are organized

Detailed conventions live in **`.claude/rules/`** (auto-discovered — no reference needed). Rules without a `paths:` glob load **every session**; rules with one load **only when you touch matching files**. This file is the index:

| Rule | Loads when | Covers |
|---|---|---|
| `critical.md` | always | non-negotiable guardrails (npm, sync storage, generated `Env`, compat date, secrets, docs `.md`) |
| `workflow.md` | always | task files, no-build-in-dev, experiments, dependencies, releases, semantic search |
| `coding-style.md` | editing `*.ts` | TS-types-as-schema, imports, IDs, JSDoc |
| `workers-projects.md` | `packages/**`, `apps/**` `*.ts` | **layer map** — which of the three DO files below apply, by layer (utility / raw-DO infra / mesh framework / mesh lib / Nebula) |
| `durable-objects.md` | `packages/**`, `apps/**` `*.ts` | *writing a DO* (every layer, incl. Nebula): storage, initialization (`onStart`), sync methods, no instance state, IDs, billing, DO class registration, Worker Loader, SQL naming + write costs |
| `mesh.md` | `mesh`, `fetch`, `nebula-frontend`, `apps/nebula` | *talk on Mesh*: `lmz.call`/`ctn` over raw RPC, routing rule, two-one-way, multi-hop, result handler, alarms, structured-clone errors + typed-error design, Gateway, Nebula-never-raw, dep direction |
| `raw-comm.md` | `auth`, `nebula-auth`, `testing`, `ts-runtime-parser-validator`, `mesh` | *talk without Mesh*: `fetch()` routing, raw Workers RPC gotchas + error behavior, hibernation WS, raw alarms |
| `testing.md` | test files, `vitest.config.*` | integration-first philosophy, capable-of-failing, mesh pyramid, for-docs mini-apps, `vi.waitFor`, initiators vs public API |
| `packaging.md` | `package.json`, `wrangler.jsonc`, `tsconfig*`, `vitest.config.*`, `.dev.vars*` | package structure, global `Env`, env vars/secrets, self-ref bindings, cross-platform `cloudflare:workers` |
| `security.md` | auth + nebula `*.ts` | secrets, test-mode flags, JWT/scope, permission checks, parameterized SQL, trust boundaries |
| `documentation.md` | `website/**`, `*.mdx`, for-docs | hand-written docs, `@check-example`, skip-check annotations, sidebars |

**Skills** (multi-step procedures you invoke) live in `.claude/skills/`. The task-file cycle pair (both `/task-management` tracks converge on it): **`/review-task`** fans out a reviewer panel over a task file before "go"; **`/build-task`** implements the reviewed task file phase-by-phase then fans out verifiers checking each phase against its own success criteria. Plus `/task-management`, `/refactor-efficiently`, `/release-workflow`. **Permissions** in `.claude/settings.json` (committed) and `.claude/settings.local.json` (gitignored, wins).

---

## Reference

- `.dev.vars.example` — env var template
- `tasks/README.md` — task templates and conventions
- Cloudflare MCP — direct access to CF APIs and documentation search
- https://lumenize.com — published docs (single source of truth for user-facing content)
