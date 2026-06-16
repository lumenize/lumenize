# Kimi UI-Gen Viability (Studio generation gate)

**Status**: Active — the generation-viability gate; a prerequisite to planning Studio. This is an exploratory spike — expect the approach to deviate as we learn; not for hand-review.

**Context**: revives the de-risk the dropped "Claude Code drives the loop" pre-Studio milestone was meant to clear, now with the chosen model (Think + Kimi 2.7 — `tasks/nebula-studio-llm-strategy.md`). The Think-vs-CMA bake-off proved **ontology + typed-data** generation only; **UI generation was the explicitly-deferred gate** ("when the SFC substrate ships"). That substrate is now near (frontend merged; files-as-resources + SFC compile = build-seq #1 in `tasks/nebula-studio.md`).

## Goal

Find out whether Kimi 2.7, given `website/docs/nebula/coding-your-ui.md` + the current ontology + the Nebula API `.d.ts` as context, can generate **working `.vue` SFCs + `.d.ts` ontology** that:
- compile in the dev Star (`DevStar.compileSFC`),
- run in preview,
- with reactivity and access control intact.

This is the single biggest "is Studio even viable" question. If Kimi can reliably produce working ontology + UI against the live platform, Studio is a wrapper around a proven loop. If it can't, no chat-UI polish saves it.

## Loose approach (will evolve)

- Drive Kimi through the three small apps already named as the stop-point (todo / kanban / simple CRM), UI + ontology, via the proven in-DO shim / Think harness (or a thinner harness if that's faster to iterate).
- Run the iteration loop, not just cold-gen: add a field, change behavior, an ontology edit, a deliberately-broken step.
- **Fold in a real error tail** — wire `get_recent_errors` / the debug-tail (`tasks/nebula-studio.md` § Remote Debug Tail); the bake-off had nothing for the agent to read. See whether Kimi self-corrects from it.

## Dependencies / sequencing

Needs build-seq #1 (files-as-resources + SFC compile in `DevStar`). Can start **thin** against the existing spike (`apps/nebula/spike/sfc-devstar-loop/`) before the full pipeline lands.

## Open questions (resolve by doing)

- Prompt shape + how much hand-holding Kimi needs for SFCs vs. the (already-good) ontology gen.
- Does codemode generalize from data ops to UI gen, or does UI want a different tool surface?
- Is the error-tail signal good enough for self-correction, or does it drown the model?
- Quality bar: "compiles + runs + feature present + access control enforced" as the completed-gate (not a quality score).
