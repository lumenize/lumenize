# ADR-012: Global Cross-Scope Profile Visibility via an Unguessable Handle

**Date**: 2026-07-15
**Status**: Accepted
**Deciders**: Larry
**Evidence**: the Profile DO (`packages/nebula-auth/src/profile.ts` — open `read()`/`subscribe()`, `requireOwnerOrAdmin` gates writes + `privateNotes`); the `NebulaClientGateway` PROFILE-fence (`onBeforeCallToClient`); ADR-008 (intra-Star tree visibility); ADR-010 (random opaque keys); design + capable-of-failing tests in `tasks/archive/nebula-profile-store.md`.

## Context

A person's public profile (`name`/`nickname`/`picture`) must resolve from a bare `sub` wherever it is encountered — a chat roster, `changedBy` attribution, the org tree — and those encounters routinely cross scope/Star/Universe boundaries (a roster in scope X references a `sub` whose profile lives in scope Y). The `profileId` is a random opaque registry UUID (ADR-010): unguessable and non-enumerable, obtained only by legitimately resolving a `sub`/handle you already hold.

ADR-008 established "identity is not confidential" but is **explicitly intra-Star** and disclaims cross-tenant visibility, so it does not by itself license a global read. The reflex a fresh contributor reaches for is a scope-intersection **reach gate** on the profile read — which breaks exactly the cross-scope resolution the feature exists for.

## Decision

**Public profile fields (`name`/`nickname`/`picture`) are readable and subscribable by ANY authenticated caller that holds the `profileId`** — across scope/Star/Universe boundaries. No reach gate, no registry read on the read/subscribe path; the Gateway's authN is the only check. **Holding the `profileId` IS the capability** (the public-GitHub-profile model, minus the guessable slug).

This **generalizes** ADR-008's principle from within-a-Star to a global public-address handle; because it exceeds ADR-008's intra-Star scope, it is its own commitment.

**Boundary:** only the PUBLIC fields are open. `privateNotes` (and any future protected-class field) stays behind `requireOwnerOrAdmin` (owner via the JWT `profileId` claim; scoped-admin via a live registry scope-check). The pushed/subscribed `Snapshot.value` carries public fields ONLY — the private blob never rides it.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Scope-intersection reach gate** on the profile read | Breaks cross-scope resolution — the roster/attribution case is the norm, not the exception. This is the designated **fallback if this ADR is ever un-ratified**; the profile-store build's capable-of-failing tests pin exactly which paths would flip. |
| **Guessable slug** (`/profiles/{username}`) | Enumerable → the handle stops being the capability. The opaque UUID (ADR-010) is load-bearing. |
| **Per-scope profile copies** | Re-introduces the stale-copy / re-key problem [ADR-013](013-identity-profileid-resolution.md) exists to avoid, and defeats "one profile a person edits once." |

## Consequences

### Positive
- `sub → display` resolves uniformly wherever a handle is legitimately held; the hot path is gate-free (zero registry reads on read/subscribe).
- **Open-resolution ≠ enumeration** — you can only act on a `profileId` you legitimately obtained, and it is unguessable.

### Negative / mitigations
- The trust rests on the `profileId` staying **unguessable + non-enumerable** (ADR-010) and on the **public/private field split being enforced at the DO** — the DO builds the pushed `value` from the public subset, never handing out the stored record (which holds `privateNotes`).
- A future *protected-class public field* would need its own gate — the open read is public-fields-**only** by construction, not a blanket "the Profile DO is open."
