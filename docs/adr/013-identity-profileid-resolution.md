# ADR-013: `sub` Is the Only Key — `profileId` Hangs Off the Address and Is Never Keyed On

**Date**: 2026-08-04
**Status**: Accepted
**Deciders**: Larry
**Evidence**: the `Emails.profileId` column + `idx_Emails_profileId`, reached from a `sub` through its `Memberships` row (`packages/nebula-auth/src/schemas.ts`); the `sub`-keyed grants/snapshots (`apps/nebula`); the JWT `profileId` claim riding the KV refresh record; ADR-010 (keys + the replication rule); design in `tasks/archive/nebula-profile-store.md`.

## Context

`sub` is **per-membership** — the same address in two scopes mints two `sub`s. `profileId` is the **global public display handle**. The mapping is single-valued in the direction that matters: many `sub`s → one `profileId`, each `sub` → exactly one. Two reflexes a fresh contributor reaches for: a `sub`↔`profileId` **join table**, and **copying `profileId` onto resource records** "so we don't resolve it every time."

## Decision

**`profileId` is a column on the `Emails` row — a property of the ADDRESS, not of any one membership.** A `sub` resolves to it through its membership's `emailId`. There is no join table: a `sub` maps to exactly one address and an address to exactly one `profileId`, so there is no n:m and no per-link metadata to carry.

⚠️ **That placement is what makes "one human, one profile" a STRUCTURAL FACT rather than an emergent one.** Held per-membership, it would be a property of N rows agreeing — which yields derived canonical-ness (some "first" row wins), a first-mover race between two paths that see the same address, and a re-point that must update N copies in lockstep. One address, one row, one `profileId` has none of those failure modes to defend against.

**Every churny resolution keys off `sub`** (stable, never re-keyed); `profileId` is **never a key, an FK, or an authz input** — grants and snapshots key on `sub` only. That is what keeps a future person-unification **additive**: re-pointing is a one-row `UPDATE`, not a re-key across every resource record.

Denormalization follows ADR-010's replication rule: the immutable handle may be denormalized **only where it self-heals or is permanently frozen** — two cases, both licensed, and nothing else:

- **Self-healing:** the JWT and the KV refresh record carry the *bearer's own* `profileId` (ephemeral, re-minted on refresh; a re-point mutates it and joins `isAdmin`'s convergence re-put).
- **Write-time-pinned and permanently immutable:** `profileId` MAY be stamped on a snapshot's **attribution metadata**, captured from the writer's verified JWT claim at write time. ⚠️ **HARD INVARIANT: the stamped value NEVER changes.** It is history, not a cache — a future unification re-point does **not** re-point historical snapshots, so each record keeps the handle its author held at write time. There is therefore no staleness and no re-key: the immutability that makes a *mutable* copy dangerous is here the point. It stays **display-only**, never read as a key, FK, or authz input. (Motivated by resolving a **departed** author's display name, which the roster cache cannot cover because it holds only active subscribers.) Live resolution remains the path for the *current* name: an active participant's name still updates off the roster/Profile subscription, while the stamp answers only "who authored this, at the time".

⚠️ **authZ scope-sets are resolved live, never stored** — a stored scope-set goes stale on a re-point or a scope teardown, and stale authz is a security bug.

**Owner authorization short-circuits off the JWT** (`claims.profileId === the Profile DO's instance name` — a direct equality, server-minted and signature-verified, so unforgeable), with the registry read reserved for the scoped-admin branch, which additionally requires an **accepted** membership ([ADR-012](012-global-profile-visibility.md)).

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **`sub`↔`profileId` join table** | Earns its keep only for true n:m or per-link metadata — neither exists; the plausible "canonical `sub`" case is answered by the Profile DO, not link metadata. |
| **`profileId` on the membership row** | The shape this ADR originally specified, and it makes "one human, one profile" emergent rather than structural — see § Decision. It was also defended on write cost ("a column is one fewer row + index write per mint"), which is **true and not decisive**: the address row costs one extra row + index write *once per person*, and every subsequent membership is then a write **cheaper**, because the address is not re-copied. |
| **Copy `profileId` onto grants/snapshots as a KEY or a mutable field** | Makes future `sub`-unification a re-key across every resource record; keying on `sub` keeps it additive. A stored copy of a resolved value also goes stale. (The write-time-pinned attribution stamp in § Decision is the one carve-out, and it is immutable and display-only.) |
| **Store the resolved authz scope-set** | Goes stale on a re-point or scope teardown — stale authz is a security bug. Resolve it live on the one path that needs it. |

## Consequences

### Positive
- Person-unification (pointing many `sub`s at one `profileId`) is **additive** — a one-row `UPDATE`, no re-key, no stale copies, no "person layer above". Every existing `sub → …` lookup is unchanged.
- "Same address, any scope → same `profileId`" needs no mechanism at all: the schema cannot express anything else.

### Negative / mitigations
- Resolving a `sub` to its `profileId` is now a **join** (`Memberships` → `Emails`) rather than a single-row read. Mitigated by stamping `profileId` alongside `sub` at write time (from the JWT claim) so consumers already hold it, reducing the live hop to the cold case.
- `profileId` in the JWT/KV is a **deliberate self-healing denormalization** (ADR-010), not a free copy — a re-point must converge those records.
