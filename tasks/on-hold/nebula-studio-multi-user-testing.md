# Testing from inside the Studio — test users, test Stars, and who founds a pre-created Star

**Status:** ⏸️ **ON HOLD (2026-08-17)** — parked until we design how testing actually works from inside the Studio. Nothing here blocks pre-alpha; the questions were surfaced while reviewing [nebula-registry-route-guards.md](../nebula-registry-route-guards.md) and are parked here so they are decided once, together, instead of ad-hoc per endpoint.

**The favored default, stated first: multi-user testing happens ON the `.dev` Star, not on pre-created tenant Stars.** Multiple test users, rendered as a **tab interface where the single preview iframe sits today — each tab its own iframe, one per test user**. This adjoins the master plan's synthetic-subjects thread ([nebula-pre-alpha.md](../nebula-pre-alpha.md) — *"provision + grant into `.dev`"*; *"(c) the SYNTHETIC subjects — below, still unowned"*). Once that works smoothly, revisit whether a real use case for admin-created tenant Stars exists at all.

## What is true today, and stays true while this is parked

- **`/create-star`'s one live caller is `NebulaClient.createDevWorkspace`** (App.vue, onboarding + the `develop()` lazy repair), provisioning the `.dev` workspace. ⚠️ **Scheduled to end**: the master plan bundles that INSERT into `createGalaxy` — see the retirement note under open question 2.
- **A pre-created tenant Star is recoverable, not stuck**: `create-star` mints no identity, so a slug consumed by mistake is freed by `delete-scope` (the cascade deletes the `Scopes` row) and the real founder claims it fresh via open `claim-star`.
- **An empty Star is a designed-for state**, not an anomaly — `SCOPES_SCHEMA`'s JSDoc: *"a parent-managed child scope has a row here and zero members."*

## Decided while parking (so they are not re-derived)

| Decision | Rejected alternative — why |
|---|---|
| **`claim-star` MUST NOT adopt a member-less `Scopes` row** | Open adoption — it lets **anyone who learns the slug** found a Star an admin pre-created for a specific person: first-come-first-served capture, the exact hole `claimStar`'s reserved-slug reject exists to close for `.dev` (*"without it, a stranger founds the user-developer's own `.dev` Studio"*), generalized to every pre-created tenant Star. |
| **The safe founding of a pre-created Star is an INVITE carrying `scopeAdmin` into the empty scope** | A new adoption/founding mechanism — [nebula-invite.md](../nebula-invite.md)'s planned shape (per-invitee `scopeAdmin`, membership minted into a named scope) already covers it; the empty-scope state is designed-for. No mechanism needed, only (eventually) a test that invite-into-zero-member-scope works. |
| **Visiting a production-bound Star before its founder stays a UI WARNING** | An authorization refusal — ADR-015: downward dominion is total and non-vetoable; restraint for destructive/placement-sensitive actions is a warning, never a refusal. |

## Open questions for when this resumes

1. **`/create-star-for-testing`, open to any member of the parent Galaxy (not only `scopeAdmin`)** — proposed 2026-08-17. ⚠️ The design problem it must solve: `create-*` deliberately **mints no identity** (the claim/create split in `router.ts`'s own comment), so a plain member who creates a Star receives no membership in it and cannot enter what they just made. Either the endpoint mints a membership — breaking the split — or it pairs creation with a self-invite. Also open: quotas/abuse bounds for non-admin creation, who may delete what a member created, and whether the tab-iframe default retires the need entirely.
2. **Does anything still need admin-created tenant Stars once `.dev` multi-user tabs work?** If yes, `/create-star` (or a successor) gets its real second consumer; if no, `/create-star` retires outright: [nebula-pre-alpha.md](../nebula-pre-alpha.md) § *Invite-gated* now bundles the `.dev` INSERT into `createGalaxy` (decided 2026-08-17), so once that lands — and post-wipe kills `develop()`'s legacy repair — the endpoint has zero production callers.
3. **How test users are minted for the `.dev` tabs** — the synthetic-subjects thread; act-as vs real invited identities; what the Studio UI shows per tab.

## Relationships

- **Adjoins** [nebula-pre-alpha.md](../nebula-pre-alpha.md)'s synthetic-subjects thread (unowned as of 2026-08-17).
- **Consumes, when it resumes:** [nebula-invite.md](../nebula-invite.md)'s per-invitee `scopeAdmin` (the founding path above).
- **Does not touch** [nebula-registry-route-guards.md](../nebula-registry-route-guards.md) — `create-star`'s table row is unaffected.
