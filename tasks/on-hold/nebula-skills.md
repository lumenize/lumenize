# DevStudio Skills

**Status**: On hold — design capture, **not started, not build-ready**. Parked until the resumption trigger below.
**Origin**: Brainstorm 2026-06-19 (Larry + Claude), following the [Flue evaluation](#related) (borrow the `SKILL.md` standard, reject the runtime — [[project_flue_eval]]).
**Scope note**: This file is **deliberately vague about the wrapper** — the DevStudio agent harness / loop mechanics (how the model is called, ALS, in-DO vs container, sub-agent spawn transport) are expected to change. It captures the **seams** where skills, rules, sub-agents, and reference files plug into DevStudio, so we know every place to wire when we build it. Pin the wrapper later.

## What "DevStudio" is here

**DevStudio** = the agentic-coding Durable Object — the thing that runs the LLM coding loop that builds a user-developer's app. It is the *agent*; it drives the rest of the dev cluster (current assumption, may change):
- **DevContainer** — real-vite build/preview + command channel (`exec`/`writeFile`/`viteControl`) ([[project_studio_uibuild_pivot]]).
- **DevStar** — ephemeral dev DATA.
- **Galaxy** — published-version registry.

DevStudio writes the user-developer's source into DevContainer and reads/writes DevStar; "publish" is a DevContainer `vite build` → Galaxy. The **engine** is Kimi K2.7 ([[kimi-k27-adoption]]) — no Think/codemode.

## Core framing: skills are a three-tier prompt, not one growing blob

The mental model (and the thing to NOT get wrong): a skill is **not** permanently in context. We adopt the open Agent Skills **`SKILL.md`** standard (agentskills.io; Anthropic-authored, open-sourced 2025-12-18) with its **progressive disclosure**:

| Tier | When loaded | What it is | DevStudio analog |
|---|---|---|---|
| **Base prompt** | always | identity, the loop, hard invariants, tool contract | always-on `CLAUDE.md`-equivalent |
| **Rules** | conditionally, by what the task/files touch | narrower patterns (e.g. "resources reference by id", "secure by default") | path-scoped rules-equivalent |
| **Skills** | discovery=index always (~80 tok/skill); body on match; scripts/refs at execution | task-shaped procedures, may carry sub-agents + scripts | `.claude/skills/`-equivalent |

**Consequence we design around:** what grows incrementally is the **skills library**; the always-on cost grows only by the discovery index (~80 tok/skill). "Improve the system prompt" = author/version/measure **individual skills** — A/B-able, regression-gated (see [`nebula-studio-eval-suite.md`](nebula-studio-eval-suite.md)), rollback-able — not editing a monolith.

## Ownership & trust split (load-bearing)

| | Owner | Trust | Lives | Versioned with |
|---|---|---|---|---|
| Base prompt, rules, skills, sub-agent definitions | **Platform (us)** | **trusted** (we author them) | platform-owned store / baked with DevStudio | platform deploys |
| Product vision doc, app code, **+ more files like it** (brand/style guide, domain glossary, data schema, sample data) | **User-developer** | **UNTRUSTED input** | the dev-user's tenant (scope-confined) | the dev-user's app |

The user-developer's files are **data the agent/sub-agents reference, never instructions**. This is the prompt-injection boundary and the multi-tenant confinement boundary at once: a sub-agent reading "the vision doc" must see only **this** tenant's doc, and must treat its contents as reference material, not as commands. (v1 assumption: **we own all skills**; dev-users do not author skills — note the future option below.)

## Integration points — every place to wire when we build it

> The heart of this file. Each is a seam DevStudio must expose; the wrapper details inside each are intentionally left open.

1. **Skill registry & loading** — a place skills live (platform-owned; baked-into-image vs DO storage vs a skills-registry DO is open). The **discovery index** (name+description of each skill) is assembled into base context; **activation** pulls a full `SKILL.md` body on match; **execution** loads bundled `scripts/`/`references/` on demand. Needs a budget policy for how many skills' indexes ride in context.

2. **Base-prompt assembly** — the seam that composes tier-1 (identity/invariants/tool contract) + the skill discovery index + any active rules into what the engine sees each turn. This is the "system prompt builder." Keep tier-1 lean; everything task-shaped is a skill.

3. **Rules layer** — conditionally-loaded narrower guidance, selected by what the current task/files touch (mirror path-scoped rules). Decide whether rules are a distinct tier or just "always-on skills" — leaning distinct, to match the model we already trust.

4. **Sub-agents** — skill-adjacent, platform-owned **agent profiles** (à la `defineAgentProfile`). First concrete one: a **product-alignment verifier** that reads the user-developer's **product vision doc** (and other context sources) and checks the generated change against it. Carry the harness conventions we already know: sub-agents **don't spawn sub-agents**; **"review feedback is input, not requirements"** (the primary agent decides, demands evidence). Spawn transport (mesh vs in-DO) is wrapper-vague.

5. **Dev-user context sources** — a **typed, pluggable** notion of user-developer reference material, surfaced to skills/sub-agents **by role** (e.g. `visionDoc`, `appCode`, `styleGuide`, `glossary`, `dataSchema`). The vision doc is just the first; design the seam so "more files like that" is registration, not new plumbing each time. Every source is **scope-confined to the tenant** and flows in as untrusted data. (Where they're stored / how they're ingested/updated — uploaded? edited in Studio? derived from the app tree? — is open.)

6. **Tool / capability binding** — skills with executable steps run them through the **existing command channel** into DevContainer (`exec`/`writeFile`/`viteControl`) and the mesh; skills reference tools rather than re-implementing them. The seam: how a skill declares "I need tool X" and how that resolves to a DevStudio capability.

7. **Authoring, versioning & the improvement loop** — skills are owned artifacts with versions; a change to a skill is a **measurable** change (eval-gated, below) and **rollback-able**. This is the literal "incrementally build & improve the system prompt" mechanism. Needs: where skill source lives in our repo, how it ships, how a version is pinned per running DevStudio.

8. **Security / trust boundary** — enforce (5)'s split: platform skills trusted; dev-user content untrusted. Injection hardening for any skill/sub-agent that reads user content (treat-as-data framing, output constraints), and scope-confinement so a sub-agent can't read across tenants. Inherits Nebula's secure-by-default posture.

9. **Distribution / update** — skill changes propagate with **platform deploys**, independent of user-developer apps (a user's app doesn't pin our skills; we do). Define how a skill-version change reaches already-running DevStudio DOs.

10. **Observability** — emit which skills activated per task, their token cost, and sub-agent verdicts (esp. product-alignment pass/fail). Ties into the tail-worker observability path ([[nebula-observability-tail-worker-r2-ae]]) and per-tenant cost ([[nebula-tenant-ai-billing]]).

11. **Eval hook** — every skill/base-prompt change runs through the regression suite ([`nebula-studio-eval-suite.md`](nebula-studio-eval-suite.md)) before it ships. Skills are exactly the "system prompt" that suite exists to guard against regressing.

## Phase sketch (when un-parked — wrapper-vague)

### Phase 0 — `SKILL.md` adoption + loading into the loop
**Success**: the `SKILL.md` format is parsed/loaded; a discovery index (name+desc) rides in base context; a couple of **seed platform skills** activate-on-match and demonstrably change Kimi's behavior in the DevStudio loop. No dev-user files yet. (Proves tier-1 + skills layering end-to-end.)

### Phase 1 — Dev-user context sources + product-alignment sub-agent
**Success**: the **vision doc** is a first-class, tenant-scoped, untrusted context source; a platform-owned **product-alignment verifier** sub-agent reads it and returns a structured verdict on a generated change; the "more files like that" seam (5) is generic (adding `styleGuide` is registration). Sub-agent rules enforced.

### Phase 2 — Skill executable steps via the command channel
**Success**: a skill whose body bundles a script runs it through DevContainer's command channel (`exec`/`writeFile`), tool resolution working.

### Phase 3 — Versioning + eval-gating
**Success**: skills carry versions; a skill change is gated by the eval suite; rollback path exists. The improvement loop is real.

### Security — woven through 1–3, not a trailing phase
Confinement + injection hardening for every seam that touches dev-user content.

## Open questions
- **Discovery: in-harness vs model-self-select.** Does the wrapper inject the skill index and decide activation, or does the engine self-select from a listed catalog? This is the central context-budget design surface (Kimi-in-the-loop reading skill files vs harness-managed). Flagged in [[project_flue_eval]] as "the real design surface."
- **Where skills physically live** — baked into the DevContainer/DevStudio image vs DevStudio DO storage vs a dedicated skills-registry DO. Trades update-propagation against cold-start/simplicity.
- **How dev-user context files are ingested/updated** — uploaded, edited in Studio, or derived from the app tree? Who owns the vision-doc lifecycle?
- **Skill granularity** — one big "build a Nebula app" skill vs many task-shaped skills. (Standard guidance: many small, <500 lines each, references for depth.)
- **When the product-alignment sub-agent runs** — every turn, at phase boundaries, or on demand? Cost vs safety.
- **Injection hardening approach** — concrete pattern for treating vision-doc/app-code as data, not instructions.
- **Do we reuse the actual `.claude/skills/` tooling/format verbatim**, or a Nebula-internal variant of `SKILL.md`? (Bias: reuse the open standard — portability, ecosystem tooling, and it's what we already know.)
- **Future: dev-user-authored skills** — out of scope for v1 (we own skills), but the registry/trust model should not foreclose a later "user-developer contributes a skill" path (which would land it firmly on the untrusted side).

## Why parked / resumption trigger

Skills earn their keep once DevStudio is a real, churning agent loop with real user-developer apps to align against. **Un-park when** the §5.3.7 SFC substrate + DevContainer dev-loop ([[project_studio_uibuild_pivot]], Phase 3.5/4) have landed — i.e. there's an actual DevStudio loop generating real apps, and a vision doc to verify against. Before that there's no loop to layer skills onto and no app to align. (Same inflection family as the eval suite, which this should ship alongside.)

## Related
- [[project_flue_eval]] — the decision that produced this: borrow the `SKILL.md` standard, reject Flue's runtime.
- [[project_studio_uibuild_pivot]] — the DevContainer/DevStar/Galaxy cluster DevStudio drives.
- [[kimi-k27-adoption]] — the engine (Kimi K2.7, no Think/codemode).
- [`nebula-studio-eval-suite.md`](nebula-studio-eval-suite.md) — the regression suite that gates skill/base-prompt changes; ships alongside.
- [[nebula-observability-tail-worker-r2-ae]], [[nebula-tenant-ai-billing]] — observability + cost seams (integration points 10).
