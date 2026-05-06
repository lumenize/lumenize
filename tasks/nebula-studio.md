# Nebula Studio

**Phase**: 9
**Status**: Active — end-of-line goal for the demo
**App**: `apps/nebula/` (Studio is the authoring experience for vibe coders)
**Depends on**: Phase 5 (Resources + dev-mode lazy migrations + dev-mode branching), Phase 7 (Nebula Client subscribe), `@lumenize/ui` (Phase 8)
**Master task file**: `tasks/nebula.md`

> Was previously titled "Nebula Vibe Coding IDE." Renamed during the demo-focus refactor (see `tasks/nebula-task-files-refactor.md`). Drop the "vibe coding IDE" wording — it's just **Studio** now.

## Goal

The conversational interface where Nebula users describe what they want, the AI generates their product (ontology + UI), and the result runs live in DWL isolates with real access control. Studio is the wow moment for the demo — investors see "I want to build X" → working app on screen.

The vibe coder never opens a code editor. They describe in natural language, the AI generates, the preview updates, they iterate. The IDE provides the feedback loop: describe → generate → preview → adjust.

> **Demo-narrative detailing is deferred** — fill in the storyboard after the prerequisite work (Resources, subscribe, `@lumenize/ui`, Studio cold-start spike) is in motion. We don't want to over-invest in narrative before the spike validates the conversational UX.

## Studio-Generated Artifacts

The Studio AI generates two kinds of artifacts:

1. **Ontology** — a `.d.ts` file with TypeScript types plus annotations (validation today, ORM later). Uploaded to Nebula; upload and processing already works (Phases 5.2.x).
2. **UI** — HTML and JavaScript files that operate within Nebula's resources constraints (access control, real-time subscriptions, queries). Resources work Firebase-style — mostly client-side capable.

Both artifacts must stay coherent: the UI must reference entity names, field names, and access patterns that match the current ontology exactly.

## Architecture

- **Galaxy hosts Studio-generated artifacts and chat session state.** Per-session rows (chat history, working state for that session) and shared rows (current ontology, accumulated memory, documentation references, patterns learned across sessions) all live in Galaxy.
- Galaxy is lightly loaded; years of session history fit comfortably under 10GB. We refactor if we approach that.
- Abandoned apps cost essentially nothing; active apps stay well under any practical DO limits.
- Each chat session works against the **dev-mode Star** (single-Star, in-place lazy migration — see `tasks/dev-mode-branching.md` and `tasks/nebula-5.5-dev-mode-migrations.md`). Cross-Star prod-to-branch isolation is post-demo.

### Studio UI hosting (open — needs spike)

Two candidate mechanisms for hosting Studio's own HTML/JS:

- **Cloudflare Workers Assets** — official static asset serving.
- **Dogfood the artifact-serving path from a Galaxy fork** — same mechanism we'd use for serving generated apps.

HTTP from a DO has to go through a Worker-hosted fetch router; that's fine — we already do it for auth and NebulaAuth on a hot path. The real question is whether we use the **same** mechanism for Galaxy-hosted generated apps and for Studio itself, or **different** mechanisms. Decide via spike. (Spike is captured in `tasks/nebula-task-files-refactor.md`.)

### Versioning and Branching

- Resources have versioning baked in.
- Dev-mode branching (single Star, in-place) covers session isolation for now. Production-grade prod→branch data migration is on hold.
- Migrations use DWL so generated code can ship its own migrations. Critical-path subset in `tasks/nebula-5.5-dev-mode-migrations.md`.
- Each chat session works against the dev-mode Star. AI generates changes → tested in place → "deploys" via the preview mechanism. No iterating against production schema/data.

## Code Generation

- Language model generates `ResourcesWorker` subclasses (resource config, guards, validation, migrations).
- Language model generates Nebula UI components (the end-user facing UI), built on `@lumenize/ui`.
- Generated code is TypeScript strings deployed to DWL isolates.
- Schema validation via tsc-in-DWL (already shipped as `@lumenize/ts-runtime-parser-validator`).

### Nebula API Schema Definitions for LLM Context

The Nebula API surface (resource operations, DAG tree operations, permission model, subscription patterns) is documented as TypeScript type definitions (`.d.ts` files) provided to Studio's language model as context. The LLM gets precise method signatures, operation descriptors, return types, and error conditions in the language it already understands.

This reuses the Phase 5.2 tsc-in-DWL capability (`docs/adr/001-typescript-as-schema.md`) — the same TypeScript types that validate data at runtime also serve as API documentation for the code-generation model. Single source of truth: the types ARE the documentation.

## Editor / Preview

- In-browser editing environment for reviewing and tweaking generated code (or the chat-only equivalent if we cut the editor for v1).
- **Live preview with auto-refresh.** Specifically: a perpetual preview URL with a hot/auto/push refresh mechanism. Don't reinvent Vite HMR — pick the lightest mechanism that works.
- Auto-refresh is also needed in production: UI and ontology versions are deployed lock-step, and we already specified browser refresh on version change. That refresh is lazy in production but **hot/push** in Studio. Same plumbing might generalize — open question.
- "Deploy" in Studio is **not** `wrangler deploy`. It's our own deploy-to-dev process that updates the dev-mode Star's DWL bundle and pushes the auto-refresh signal.

## Iteration Loop

The developer iterates. The AI must see what's broken to fix it.

### Remote Debug Tail

- Extend `@lumenize/debug` to support remote tailing into the chat.
- Debug is already namespace-scoped throughout Lumenize code.
- The AI controls which namespaces it subscribes to — it focuses on the suspect part instead of drowning in hundreds of messages per transaction.
- This is the primary signal channel for the AI to understand runtime failures.

### Tool Use (Agentic Surface)

The AI has tools it can call, not just text generation:

- `get_current_ontology` — fetch the pinned schema.
- `subscribe_debug_namespace(namespace)` — focus the debug stream.
- `unsubscribe_debug_namespace(namespace)` — drop noise.
- `deploy_to_dev(artifacts)` — push generated code to the dev-mode Star's DWL bundle (renamed from "deploy_to_test_branch" — branching is in-place via dev-mode, no separate branch concept).
- `get_recent_errors(namespace?, since?)` — pull validation/runtime failures.
- *(Future)* `propose_migration(from_version, to_version)` — exists in v1 form via the dev-mode lazy migration runner.

This turns the AI from a code-generating chatbot into something that drives the loop.

## Conversation Flow

Cold-start interview is the demo wow moment. Optimize for it.

### Interview Pattern

- Start with the **core entity** — what is this product fundamentally about?
- Then relationships, then workflows, then access patterns.
- Build understanding progressively. Reflect back what's been learned.
- Generate a **draft ontology early**, even if incomplete. Use it as a live conversation artifact the developer can correct, extend, and react to. Visual anchor during the demo.

### Tone

- Thoughtful product manager, not a form.
- Make assumptions and flag them: "I'm assuming each walk has a single walker — tell me if that's wrong." Don't ask about every detail.
- Confidence with humility plays well in the demo and in real use.

### Wizard-Style Authoring Flow

The IDE guides vibe coders through a structured flow, not a blank canvas:

1. **Ontology first** — Define the data model (resource types, fields, relationships, DAG tree structure) before touching UI. Wizard validates the ontology is coherent before proceeding.
2. **Migration validation gate** — When evolving the ontology, the vibe coder must write (or have the LLM generate) migration code that passes before moving to UI changes. No skipping ahead with a broken data model.
3. **UI second** — Build the end-user UI against the validated ontology.

Not strictly linear — nobody gets the data model right on the first try. The wizard supports back-and-forth while still enforcing the validation gate: ontology change → migration validated → UI can use the new fields.

## Context Window Strategy

- The current ontology stays **permanently pinned** in context. Everything the AI generates centers on it. Dropping it from context makes the AI useless.
- Refresh the pinned ontology whenever it changes.
- Annotation documentation (already written for humans) is provided to the AI as reference.
- Plan for context pressure across long iteration sequences — strategic archival of older turns will eventually matter, but not for demo.

## Model and Orchestration

- Use the Anthropic API directly. Roll the orchestration ourselves on Workers + Durable Objects — frameworks like LangChain add overhead we don't need.
- Mix models by task: heavier model (Opus) for ontology generation and complex UI generation; lighter model (Sonnet) for small iterations and debug interpretation.
- Look up current model identifiers and capabilities before wiring this up — don't assume from training data.

### Language Model Strategy

- **Short term**: Prompt engineering against general-purpose models (Claude, GPT) with Nebula-specific system prompts and few-shot examples.
- **Medium term**: Fine-tuned small model specialized for Nebula UI and Nebula Resources patterns.
- **Training data**: Nebula's own documentation, example apps, the `ResourcesWorker` API surface, Nebula UI component library.

## Out of Scope (For Demo)

- Server-side ORM enforcement of relationships (UI handles relationships client-side for now).
- Production migration polish (cross-resource callbacks, version skew, error UX) — see `tasks/on-hold/nebula-5.5-schema-evolution.md`.
- Cross-Star prod→branch data migration.
- Long-term session archival/cleanup strategy.
- Fine-tuned Nebula-specialized model.

## Open Questions

- Demo narrative shape: full cold start vs. jump-in partway? Leaning cold start for impact. Confirm during storyboard work after prereqs.
- Does the pinned ontology view live in the UI alongside the chat?
- Editor component: Monaco, CodeMirror, custom, or no code editor at all (pure natural language)?
- How much generated code should the vibe coder see vs. be hidden behind the natural language interface?
- When does session context get archived/summarized vs. kept verbatim?
- Hosting decision (Workers Assets vs Galaxy-served): see hosting spike in `tasks/nebula-task-files-refactor.md`.
- **UI asset storage & versioning**: Galaxy manages UI versions, but the backend could be Galaxy's own SQLite, Workers KV, R2, or Cloudflare Artifacts (git-compatible versioned storage built on DOs — announced April 2026, beta). Artifacts' git interface is attractive: the IDE agent could use native git (commit, branch, tag releases, diff, rollback) with Galaxy orchestrating publish-to-edge via KV/R2 for fast serving. Design Galaxy's version management API without coupling to a specific backend so this decision can be deferred. An Asset Worker is needed regardless to set MIME types, CSP headers, etc.

## Follow-On Work (post-demo)

See `tasks/nebula-scratchpad.md` § "Vibe Coding IDE Follow-On" for the full list (training pipeline, prompt engineering, code validation pipeline, version control for vibe-coded apps, collaboration features, marketplace/templates).

## Success Criteria

Rough shape — refine during storyboard work:

- [ ] Vibe coder can describe a data model in natural language and get a working `ResourcesWorker`
- [ ] Generated code deploys to dev-mode Star and passes schema validation
- [ ] Preview shows live UI components backed by real Resources
- [ ] Edit → regenerate → preview cycle is under 5 seconds
- [ ] Cold-start interview produces a usable draft ontology in under 5 minutes (demo target)
