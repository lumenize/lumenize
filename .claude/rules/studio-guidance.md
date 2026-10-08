---
paths:
  - "apps/nebula/platform/**"
  - "apps/nebula/src/codegen-loop.ts"
  - "apps/nebula/src/galaxy.ts"
  - "apps/nebula/container/app/**"
  - "website/docs/nebula/**"
---

# Studio Guidance — one home per kind of guidance, and every other place points

Every Studio turn assembles a tree of guidance for the model: the tool contract, the platform layer we ship in code, the app's own `AGENTS.md` in its Workspace, the chat history, then the ontology, the source and the request. The design is `tasks/archive/nebula-guidance-file-tree.md` § *Design intent*; this file is the convention that survives it — where each kind of guidance lives, so the next fact lands in its home instead of beside it. The tool contract was once stated three times, and two copies disagreed on what to do after a timeout; the table is what stops the next drift.

## The placement table

**Each kind of guidance MUST live in exactly one of these homes, and a second copy MUST NOT be written — point at the home instead.**

| Kind | Example | Home |
|---|---|---|
| Identity | "You are Studio, an assistant that builds one user-developer's web app…" | `TOOL_CONTRACT`'s first line, `apps/nebula/src/codegen-loop.ts` |
| Tool mechanics — what a tool does and when to pick it over its sibling | `edit_file` for a change, `write_file` for a new file or a rewrite; `read_file` names `.platform/` | that tool's `description` in `CODEGEN_TOOLS`, sent as `tools` every round |
| State-dependent result reading | "likely the build timeout; retrying the same code will time out again" | the build report itself, on the step that failed (`galaxy.ts`, `#buildOnce`) |
| Cross-turn harness policy | findings are advisory and the model judges; tools, not prose; every file, then one build | `TOOL_CONTRACT`, beside `CODEGEN_TOOLS` — the first system bundle |
| Reporting | a doc misled the model, or an API misbehaved | `TOOL_CONTRACT` — the line lands with the capture tool the master plan's ③ builds |
| Platform conventions and the tree | resources are the only data home; styling; the layer order; the declared files; the skills catalog | `apps/nebula/platform/AGENTS.md` |
| Procedures | interview the user-developer about the ontology; wire a view to a resource | `apps/nebula/platform/skills/<name>/SKILL.md` |
| Reference | the resources API, the store in a component | `website/docs/nebula/*.md`, embedded as `.platform/docs/` |
| App conventions | "only the organizer sees the draw" | the Workspace's `AGENTS.md`, seeded from `apps/nebula/container/app/AGENTS.md` |
| App declarations | vision, personas, permissions | the Workspace's `docs/`, seeded from `apps/nebula/container/app/docs/` |
| Org practices | later | `.universe/AGENTS.md` — reserved; no Universe layer exists yet |

The self-correction message after a failed build says "Fix and call build again." and nothing else — except when the CONTAINER step failed, where the message says the box did not run and not to build again this turn, because the model's code cannot fix that (a second failed container step ends the turn `build-unavailable`). How to read a failed step lives on the step; how to override the preview lives on the `build` tool; a "simplify" instruction MUST NOT be added to either, because a partial build is a product gap (`tasks/backlog.md` § *Other Nebula backlog*), not prompt text.

## How the homes ship

- **The platform layer is generated, never hand-edited in `src/`.** `apps/nebula/scripts/gen-platform.mjs` embeds `apps/nebula/platform/` and `website/docs/nebula/*.md` into `src/platform-embed.ts` and renders the skills catalog from each `SKILL.md`'s frontmatter into the one marker line in `platform/AGENTS.md`. After editing either source you MUST run it and commit the embed; `--check` in the package `test` script reds on drift, and `test/platform-embed-drift.test.ts` reds on a hand-edited catalog or a dangling `.platform/` path. A skill's catalog line MUST NOT be hand-written — its `description` is the line.
- **The Galaxy seed rides the scaffold.** A file added under `apps/nebula/container/app/` reaches every new Workspace through `scripts/gen-scaffold.mjs`; the same regenerate-and-commit rule applies, and `test/scaffold-seed-drift.test.ts` pins the file set.
- **The docs ship as-is.** `website/docs/nebula/*.md` is already the model's reference; an "LLM edition" MUST NOT be forked from it. A doc edit is a platform-layer change: regenerate the embed.
- **The Workspace files are the user-developer's.** `AGENTS.md` and `docs/*` are written by the model on their turn under the poster's own claims, at the chat floor (`security.md`), through `edit_file`. Platform prose MUST NOT be copied into the seed — the seed carries headings and a "write this when" line, and the platform layer is read first on every turn.

## Naming the model sees

- `preview` is the build tool's flag and report step — whether the `.dev` preview refreshed. `publish` is the product's shipped tag served to tenant Stars, which is not built; the two words MUST NOT be swapped in the tool path.
- Reserved paths: a `.platform/` or `.universe/` path is a mount, `.nebula/` is machine-owned, and the write rule in `assertModelPath` refuses every leading-dot first segment except `.agents/`. A new reserved prefix MUST be added there, not in a tool.

## Changing what the model is told

There is no procedure yet for judging a guidance change, because "did this change help" is not answerable until the eval exists (`tasks/on-hold/nebula-studio-self-improvement.md`). Until then the steps are the generator, the drift tests, and the `/live` criteria — `studio-guidance-loop`, `four-party-chat`, `first-app-built` — which `/build-task` already runs; a change that moves a limb's outcome MUST be recorded in `tasks/nebula-pre-alpha.md` § *Data-bound generation* as a dated findings line.
