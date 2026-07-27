# Lumenize Project Context

Lumenize is two things:
1. A de✨light✨ful suite of MIT-licensed packages any developer can use on Cloudflare's Workers Development Platform, with particular focus on Durable Objects.
2. A SaaS platform, Nebula, for solopreneurs and intrapreneurs to agenticly build products that are secure by default. Nebula's **user-developers** (always this term — never "vibe-coder") are domain experts who may not be experienced coders. Opinionated where it matters, flexible where it counts; no foot-guns — even when we let you break a rule, you're loudly warned. Nebula code is `UNLICENSED` until external launch.

Nebula is the **only app** and the packages' **first consumer** — building Nebula is dogfooding Mesh and friends. When Nebula code fights a package API (missing capability *or* awkward ergonomics), that's product feedback for the package: surface it (backlog item, or extend the package), don't quietly work around it in Nebula.
 
For both, the guiding principles are quality and great LLM DX. Prioritize clear patterns and guard against footguns. Security is on by default. Test coverage targets: Branch >80%, Statement >90%.

---

## Vocabulary — "standing guidance" vs "design intent"

**Standing guidance** = everything that reaches your session context from a source *other than* this conversation's prompts or the code you read for the task at hand. It is durable, applies until countermanded, and is loaded whether or not anyone asked for it. Concretely:

| Source | Holds |
|---|---|
| `CLAUDE.md` (this file) | the index, the vocabulary, project framing |
| `.claude/rules/*.md` | conventions — always-loaded ones, plus path-scoped ones for files you touch |
| `.claude/rules/calibration.md` | **known training biases and their corrections** — not conventions |
| `.claude/skills/*/SKILL.md` | multi-step procedures, loaded when invoked |
| `docs/adr/*.md` | repo-shaping commitments (full text in `/review-task`; one-liners always) |
| `docs/vision/*.md` | product strategy + the `/review-task` product lens |
| agent memory | durable facts about the user, project, and past decisions |
| JSDoc + code comments | local invariants, contracts, and warnings at the site |

So *"where in standing guidance should this go?"* is a routing question, and the table answers it. Rough rule: **a commitment** → ADR · **a convention** → the matching rule · **a bias to correct** → `calibration.md` · **a procedure** → a skill · **a durable fact** → memory · **a local invariant** → JSDoc at the site · **project-scoped, dies with the project** → the task file's Decisions table, not here.

**Design intent** is different and narrower: what a *specific piece of work* is trying to achieve and why — the constraints it must honour and the future state it is heading toward. It lives in a task file (see `/write-task`), gets hand-reviewed before the phases are written, and is archived with the project. Standing guidance outlives any one task; design intent does not.

## How conventions are organized

Detailed conventions live in **`.claude/rules/`** (auto-discovered — no reference needed). Rules without a `paths:` glob load **every session**; rules with one load **only when you touch matching files**. This file is the index:

| Rule | Loads when | Covers |
|---|---|---|
| `critical.md` | always | non-negotiable guardrails (npm, sync storage, generated `Env`, compat date, secrets, docs `.md`) |
| `calibration.md` | always | **known training biases + corrections** — privacy overweighting, hardening-vs-deleting, tests-are-not-an-oracle, expired justifications. Not conventions; read it as "you are biased toward X". |
| `workflow.md` | always | task files, ADR index, sequential implementation (no parallel worktrees), no-build-in-dev, experiments, dependencies, releases, semantic search |
| `live.md` | always | drive the *running* system to explore (ground before acting) / verify (before done) / debug user-facing Studio/Nebula work — the `/live` harness; exploration, distinct from `testing.md` |
| `coding-style.md` | editing `*.ts` | TS-types-as-schema, imports, IDs, optional-over-nullable, JSDoc |
| `workers-projects.md` | `packages/**`, `apps/**` `*.ts` | **layer map** — which of the three DO files below apply, by layer (utility / raw-DO infra / mesh framework / mesh lib / Nebula) |
| `durable-objects.md` | `packages/**`, `apps/**` `*.ts` | *writing a DO* (every layer, incl. Nebula): storage, persist-before-`abort`, initialization (`onStart`), sync methods, no instance state, IDs, billing, DO class registration, Worker Loader, SQL naming + write costs |
| `containers.md` | `packages/mesh`, `apps/nebula` `*.ts`, `**/Dockerfile` | *a DO with a Container attached*: the companion-DO-is-the-hub model, container/DO state machines, the `running`×`status` trap, cold ⊋ stuck, what's only verifiable deployed, local dev, base-owned `alarm`/`onStart` |
| `mesh.md` | `mesh`, `fetch`, `nebula-frontend`, `apps/nebula` | *talk on Mesh*: `lmz.call`/`ctn` over raw RPC, routing rule, two-one-way, multi-hop, result handler, alarms, structured-clone errors + typed-error design, Gateway, Nebula-never-raw, dep direction |
| `raw-comm.md` | `auth`, `nebula-auth`, `testing`, `ts-runtime-parser-validator`, `mesh` | *talk without Mesh*: `fetch()` routing, raw Workers RPC gotchas + error behavior, hibernation WS, raw alarms |
| `testing.md` | test files, `vitest.config.*` | integration-first philosophy, capable-of-failing, `it.skip` for deferrals, debug-sink log assertions, mesh pyramid, for-docs mini-apps, `vi.waitFor`, initiators vs public API, browser same-origin proxy |
| `packaging.md` | `package.json`, `wrangler.jsonc`, `tsconfig*`, `vitest.config.*`, `.dev.vars*` | package structure, global `Env`, env vars/secrets, self-ref bindings, cross-platform `cloudflare:workers` |
| `security.md` | auth + nebula `*.ts` | secrets, test-mode flags, JWT/scope, permission checks, parameterized SQL, trust boundaries |
| `documentation.md` | `website/**`, `*.mdx`, for-docs | hand-written docs, `@check-example`, skip-check annotations, admonitions, sidebars |
| `ui-theming.md` | `apps/nebula-studio-ui/**`, generated-app scaffold, `*.vue` | color goes through the daisyUI theme on **both** surfaces; change the theme not the markup; warn-and-proceed, never refuse. ⚠️ mechanism only — design/taste is deliberately deferred |

**Skills** (multi-step procedures you invoke) live in `.claude/skills/`. The task-file pipeline is **`/task-management`** (route: docs-first vs task-file-first) → **`/write-task`** (draft: design intent first, hand-reviewed, *then* phases) → **`/review-task`** (fan out a reviewer panel before "go") → **`/build-task`** (implement phase-by-phase, then fan out verifiers checking each phase against its own success criteria). Plus `/refactor-efficiently`, `/release-workflow`. **Permissions** in `.claude/settings.json` (committed) and `.claude/settings.local.json` (gitignored, wins).

---

## Reference

- `.dev.vars.example` — env var template
- `tasks/README.md` — task templates and conventions
- `docs/adr/` — architecture decision records (repo-shaping commitments; one-liner index in the `workflow.md` rule, full files read during `/review-task`)
- Cloudflare MCP — direct access to CF APIs and documentation search
- https://lumenize.com — published docs (single source of truth for user-facing content)
