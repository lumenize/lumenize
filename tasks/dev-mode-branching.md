# Dev-Mode Branching (single Star, in-place)

**Status**: Active — critical path for the demo
**Depends on**: `tasks/nebula-5.5-dev-mode-migrations.md` (in-place lazy / copy-on-read migrations)
**Companion**: `tasks/nebula-studio.md` (each chat session works against the dev-mode Star)

## Objective

Give Studio's iteration loop a sane home: each Studio chat session works against a **single dev-mode Star** that carries the ontology version forward and lazy-migrates existing data on read. The vibe coder can change their ontology mid-session without blowing away the running prototype.

The target audience writes TypeScript interfaces — they should not have to manage local D1/KV/R2 bindings, ports, or wrangler configs. Dev-mode is the model that hides all of that.

## Scope (demo critical path)

- **One dev-mode Star per session** (or per vibe coder, depending on session model — TBD during Studio work).
- **In-place lazy migration** on the dev-mode Star — when the ontology version advances, existing snapshots migrate on first read using the runner from `nebula-5.5-dev-mode-migrations.md` (eager write-back).
- **Session lifetime** tied to the Studio chat session. TTL or explicit teardown via the Studio UI.
- **No `wrangler dev`** — the dev loop is: Studio chat → AI generates → DWL bundle compile → push to dev-mode Star → preview auto-refresh.

## Out of scope (deferred)

- **Cross-Star data migration** — copy-on-write from a production Star to a branch Star. The original sketch had this; it's been moved to post-demo. The dev-mode Star starts empty, populated by the session.
- **Multi-dev namespacing across shared infrastructure** — solve when we have more than one vibe coder per deployment.
- **ORM relationship traversal write-back isolation** — moot when there's no read-through to production data.
- **Branch lifetime / cleanup heuristics beyond simple TTL** — keep simple for demo.

## Design points to pin down

- **Star naming / instance addressing** for dev-mode Stars (some convention that makes them clearly distinct from production Stars and easy for Studio to pick up where it left off across sessions).
- **Teardown trigger** — explicit "reset session" in Studio UI, idle TTL, or both?
- **Subscription routing** during dev-mode — the same NebulaClient subscribe path works against the dev-mode Star, just routed to a different instance. Verify nothing in the subscribe wiring assumes a single Star type per universe.
- **Auto-refresh signal** when the DWL bundle changes — pushed from the dev-mode Star to the connected Studio preview client. See `nebula-studio.md` § Editor / Preview.

## Notes

- This file used to be a stub focused on copy-on-write across Stars. It's been retargeted to the demo-required minimum: single Star, in-place. The cross-Star branching design is preserved in the original commit history if/when we revisit post-demo.
- Originally targeted dev experience for vibe coders writing TS interfaces. That target hasn't changed — but Studio is the UI that wraps it, so most of the dev-loop UX questions answer themselves once Studio is designed.
