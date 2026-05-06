---

---

# Nebula Task Files Refactor

## Context

Lumenize Nebula is an agentic product development platform targeting solopreneurs and intrapreneurs. The core experience: a product developer (not coder) chats with an AI that generates their product. The conversational UI we'll call **Studio**.

## Demo Priority

Investors are asking for a demo. Restructure plans around proving the conversational product-building experience ASAP. Track what we skip so we can flesh it out later (likely post-funding).

## Critical-path scope (MUST-HAVE for demo)

Each item below is non-negotiable for the demo and stays in the active queue.

### 1. Resources fundamentals (Phase 5.1, 5.2, 5.3)
- Storage engine, parse/validate, single-resource subscriptions.
- **Access control stays fully wired** — guards on read, write, and subscribe. Our valuation thesis is that we make it harder to be insecure than secure; we will not ship a demo that violates that.

### 2. Migrations (in-place, dev-mode only)
- Lazy / "copy-on-read" migrations on a single dev-mode Star — no cross-Star data migration from production to a branch.
- Studio's iteration loop requires this: "I added a field" must not blow away the running prototype. Without lazy migration, every ontology change resets the data.
- Production polish (eager write-back tuning, cross-resource migration callback design, error-handling UX, version-skew handling) is deferred — see "On hold" below.

### 3. Dev-mode branching (single dev-mode Star, in-place)
- Each Studio chat session works against a dev-mode Star. The branching mechanic carries the ontology version forward; the lazy migrations from item 2 apply on read.
- Cross-Star branch isolation (prod → branch with copy-on-read across DOs) is **out of scope**. One dev-mode Star, all session state inside it.

### 4. Nebula Client subscribe (single-resource)
- `subscribe()` wrapper with eTag cache, BroadcastChannel-style fan-out, auto-resubscribe on reconnect. Multi-resource subscriptions and large-fanout architecture deferred.

### 5. `@lumenize/ui` (new MIT package, ported from JurisJS)
- **Decision: standalone package**, not inlined. Worth the structural cost.
- Must keep:
  - `getState()` / `setState()`
  - The "object DOM" / template pattern where a function-valued slot is reactive but a value-valued slot is evaluated once.
- Pre-port inventory required: what else in JurisJS is so deeply tangled with those primitives that it has to come along, and what do we want regardless for the year ahead. Cutting room floor: registration glue and integrations to non-JurisJS frameworks (React, Svelte, etc.) — we don't need them for Nebula and don't want to maintain them.
- Wire subscribe straight into `@lumenize/ui` so a synced piece of state and a local piece of state differ only by config/naming.

### 6. Studio (Phase 9, renamed)
- Active end-of-line goal. Includes:
  - Cold-start interview producing a draft ontology.
  - Pinned-ontology context strategy.
  - Tool surface: ontology fetch, debug-namespace subscribe, query-recent-errors, ontology+UI deploy-to-dev (NOT `wrangler deploy`).
  - HTML/JS UI generation hosted somewhere (see hosting spike below).
- Deferred for now: detailed Studio narrative, demo storyboard. We'll write that out after the prerequisite work is in place.

### Spikes to schedule (after prereqs are underway, not before)

- **Studio cold-start spike (1 day)**: Claude API + fixed system prompt + manual ontology validation. Tells us whether the conversational UX even produces usable output before we build the surrounding infra.
- **Studio hosting spike**: Cloudflare Workers Assets (Artifacts) vs. dogfooding artifact serving from a Galaxy fork. HTTP from a DO has to go through a Worker-hosted fetch router — that's fine (we already do it for auth/NebulaAuth on a hot path). Question is whether we use the same mechanism for Galaxy hosting and Studio hosting, or different mechanisms. Decide via spike.
- **`@lumenize/ui` extraction inventory**: 1-day surface-area pass on JurisJS — what comes along with `getState`/`setState` + the reactive-template pattern. We don't need to time-box the *port*; we need the inventory before committing to the port.
- **Preview URL with auto-refresh**: Needed for the iteration loop and also for production (UI/ontology version is lock-step). Lazy refresh-on-version-change is already specified for production, but Studio needs hot/auto/push refresh. Don't reinvent Vite HMR — pick the lightest mechanism that works.

## On hold (move to `tasks/on-hold/`)

These are temporarily skipped in favor of the demo focus. They are not iceboxed — we *will* return to them, likely after funding.

- `nebula-5.4-capability-tickets.md`
- `nebula-5.6-http-transport.md`
- `nebula-5.7-docs-coverage.md`
- `nebula-5.2.5-multi-resource-queries.md`
- `typia-visit-tracking.md`
- `mesh-resilience-testing.md`
- `release-process-improvements.md`
- `nebula-release-process.md`
- `mesh-post-release-part-2.md` (verify content first)
- `skills-and-agents.md` (fully held — could eat days; not on the demo critical path)
- `skills-agents-architecture-guardian.md`

**Production migration polish stays on hold too** — only the dev-mode lazy migration path (item 2 above) ships in the demo. Most of `nebula-5.5-schema-evolution.md` should move to `on-hold/`, with a small extracted critical-path doc covering just the dev-mode in-place lazy migration. Decide on extraction vs. partial-skip when we open 5.5.

## Files staying active (for reference)

- `nebula.md` — master, will get an "On Hold — demo focus" status added to held phases plus a fixed link for the (now-archived) `nebula-dag-tree.md`.
- `nebula-5-resources.md` — overall design, includes the `getNodeByPath` carry-over from DAG Phase 3.x.
- `nebula-5.2-tsc-validation.md` and its sub-files — parse/validate.
- `nebula-5.3-subscriptions.md` — single-resource subscribe.
- `nebula-7-client.md` — subscribe wrappers, ticket cache (latter when 5.4 unfreezes), proactive refresh, discovery login.
- `lumenize-ui.md` — package design (will be expanded with the JurisJS inventory).
- `dev-mode-branching.md` — promote from stub. Tighten scope to single dev-mode Star + in-place lazy migration.
- `nebula-studio.md` — **NEW**, formed by renaming `nebula-9-vibe-coding-ide.md` and folding `docs/nebula-studio-musings.md` into it. Drop "vibe coding IDE" terminology in favor of "Studio."
- `nebula-scratchpad.md`, `backlog.md` — leave alone; they're reference catchers.

## Mechanics: how we do the move

1. Create `tasks/on-hold/` directory.
2. Move the files listed under "On hold" into it.
3. Rename `tasks/nebula-9-vibe-coding-ide.md` → `tasks/nebula-studio.md`. Fold `docs/nebula-studio-musings.md` content into the renamed file. Delete the original musings file.
4. Update `tasks/nebula.md`'s phase table:
   - Mark held phases with status "On Hold — demo focus" and update paths to `on-hold/<file>`.
   - Fix the stale `nebula-dag-tree.md` link (it's archived).
   - Rename Phase 9 row to "Nebula Studio."
   - Add a short "Demo Roadmap" section above the table that mirrors this file's "Critical-path scope."
5. Update `dev-mode-branching.md` from stub to active task with the tightened scope (single dev-mode Star, in-place lazy migration).
6. Update `lumenize-ui.md` with a "Pre-port inventory" placeholder section to fill in during the spike.
7. Leave this refactor doc itself as the live plan until the moves above are done; archive when complete.

## Open questions still on the table

1. **Preview URL implementation**: Worker-served from R2/Assets, or DO-served via a fetch router? Tied to the hosting spike.
2. **Where Studio's chat session DO lives**: Galaxy hosts session rows alongside artifacts (per A5). Confirmed — sized for years of session history under 10GB; we refactor if we approach that.
3. **What of `nebula-5.5-schema-evolution.md` ships with the demo**: The dev-mode in-place lazy migration runner is needed; the production-polish surface (eager write-back, cross-resource callback, version-skew handling) is not. Decide whether to extract a small critical-path file or annotate sections within the existing one.
4. **`@lumenize/ui` inventory**: deferred to the spike. Output should be a pinned list of "definitely keeping," "definitely cutting," and "keep just in case."
