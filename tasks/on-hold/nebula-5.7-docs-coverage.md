# Documentation & Coverage

**Status**: On Hold — mostly overcome by events (the discrete "Phase 5.7" deliverable no longer exists; remaining work is tracked in its real homes, below)

**Depends on**: Phases 5.1–5.6 (API stable)

> De-numbered from "Phase 5.7" 2026-06-15. The original scope was a single doc-and-coverage phase gated on a stable resources API. Most of it shipped as part of the frontend/docs work; what remains is continuous, not a gating phase.

## What shipped

- **Resources doc written** — `website/docs/nebula/resources.md` exists (as `.md`, not the originally-planned `.mdx`), alongside the rest of the hand-written `website/docs/nebula/` set (`coding-your-ui.md`, `api-reference.md`, `ontology.md`, `auth-flows.md`, `nebula-client.md`, `resources.md`, `access-control.md`).
- **Sidebar updated** — the nebula docs are wired into `website/sidebars.ts`.
- **`@check-example` Phase 1** — 23 runtime doc blocks are backed by real-Star + real-chromium tests (see `tasks/archive/nebula-frontend.md` § @check-example Phase 1). The remaining `@skip-check` → `@check-example` conversion is tracked there (§5.3.8 for-docs probe backlog) and driven by the `/doc-example-audit` + `/convert-doc-examples` skills — not by this file.

## What remains (tracked elsewhere, not here)

- **Remaining `@skip-check` conversion** — `tasks/archive/nebula-frontend.md` §5.3.8 (for-docs probes) + the Studio-bootstrap example, which stays `@skip-check` pending a human `@skip-check-approved`.
- **Coverage targets (branch >80%, statement >90%)** — a standing repo-wide goal stated in `CLAUDE.md`, applied per-package as code lands. Not a one-time Phase-5 deliverable.

## Notes

- The nightly backlog (`tasks/nightly/backlog.md`) still has a few LOW-priority review items tagged to this file (audit `@skip-check`, verify examples, check the sidebars entry, coverage gap analysis). Those are fine to keep as nightly-shaped review passes; they don't represent a blocking phase.
