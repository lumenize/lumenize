# ADR-013: Identity Resolution — `profileId` Resolved Live off `sub`, Never Copied

**Date**: 2026-07-15
**Status**: Accepted (amended 2026-07-18 — see Amendment: immutable-metadata attribution stamp)
**Deciders**: Larry
**Evidence**: `Identities.profileId` column + `idx_Identities_profileId` (`packages/nebula-auth`); the `sub`-keyed grants/snapshots (`apps/nebula`); the JWT `profileId` claim riding the KV refresh record; ADR-010 (keys + the replication rule); design in `tasks/archive/nebula-profile-store.md`.

## Context

`sub` is **per-scope** — the same email in two scopes mints two `sub`s. `profileId` is the **global public address**. The mapping is single-valued: many `sub`s → one `profileId`, each `sub` → exactly one `profileId` (the substrate for a future "one person, many `sub`s" unification). Two reflexes a fresh contributor reaches for: a `sub`↔`profileId` **join table**, and **copying `profileId` onto resource records** (grants/snapshots) "so we don't resolve it every time."

## Decision

`profileId` is a **plain column on the `Identities` row** — not a join table (there is no n:m; a `sub` maps to exactly one `profileId`). **Every churny resolution keys off `sub`** (1:1, stable); `profileId` is **resolved LIVE off the `Identities` row and NEVER copied onto resource records** — grants and snapshots key on `sub` only.

Denormalization follows ADR-010's replication rule: the immutable surrogate may be denormalized **only where it self-heals** — the JWT and the KV refresh record carry the *bearer's own* `profileId` (ephemeral, re-minted on refresh; a P2 re-point mutates it and joins `isAdmin`'s convergence re-put). **authZ scope-sets are resolved live, never stored** (a stored scope-set goes stale on a re-point/teardown — stale authz is a security bug).

**Owner authorization short-circuits off the JWT** (`claims.profileId === the Profile DO's instance name` — a direct equality, server-minted + signature-verified, unforgeable), reading the registry scope-set live ONLY for the scoped-admin case.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **`sub`↔`profileId` join table** | Earns its keep only for true n:m or per-link metadata — neither exists; the plausible "canonical `sub`" case is answered by the Profile DO, not link metadata. A column is one fewer row + index write per mint. |
| **Copy `profileId` onto grants/snapshots** | Makes future `sub`-unification a re-key across every resource record; keying on `sub` keeps it **additive** (re-point = a one-row `UPDATE`). A stored copy of a resolved value also risks going stale. |
| **Store the resolved authz scope-set** | Goes stale on a re-point or scope teardown — stale authz is a security bug. Resolve it live on the one path (scoped-admin) that needs it. |

## Consequences

### Positive
- Future person-unification (point many `sub`s at one `profileId`) is **additive** — a one-row `UPDATE`, no re-key, no stale copies, no "person layer above." Every existing `sub → …` lookup is unchanged.

### Negative / mitigations
- A live resolution per display where the holder lacks the `profileId` — **mitigated** by stamping `profileId` alongside `sub` at write time (from the JWT claim) so consumers already hold it (the roster / attribution path), reducing the live hop to the cold case.
- `profileId` in the JWT/KV is a **deliberate self-healing denormalization** (ADR-010), not a free copy — a re-point must converge those records.

## Amendment (2026-07-18) — the immutable-metadata attribution stamp is a blessed exception

Motivated by the Galaxy chat "name-resolution off *all-time* authors" need ([nebula-galaxy-collapse-and-chat.md](../../tasks/nebula-galaxy-collapse-and-chat.md)): resolving a **departed** author's display name off `sub` alone forces a per-author registry hop the roster cache can't cover (the roster holds only *active* subscribers). The original "never copied onto snapshots" rejection assumed a **mutable** copy that goes stale on a `sub`-unification re-point. This amendment carves out the **immutable** case:

- **`profileId` MAY be stamped on a snapshot's ATTRIBUTION METADATA** (`Snapshot.meta`, alongside `changedBy`) as a **write-time-pinned, permanently immutable historical record**, captured from the writer's verified JWT claim at write time.
- **HARD INVARIANT: the stamped value NEVER changes.** It is history, not a cache. A future `sub`→`profileId` re-point (unification) **does NOT re-point historical snapshots** — each message keeps the `profileId` its author held *at write time*. So there is **no staleness and no re-key**: the immutability (ADR-004) that made a *mutable* snapshot-copy dangerous is here the *point* — attribution is meant to be frozen.
- **The core rule is UNCHANGED for KEYS/FKs/authz:** grants and snapshots still **key on `sub` only**; the metadata stamp is **never read as a key, FK, or authz input** — display-only. The Alternatives-table rejection of "copy `profileId` onto records" **still stands** for any *keying or mutable* use; this exception is **display-metadata + immutable** only.
- **Live resolution remains the path for the *current* name:** the name shown for an **active** participant still updates live off the roster/Profile subscription. The immutable stamp answers only "who authored this message, at the time" — a consumer wanting "the author's name **as of now**" resolves live via `profileId`→Profile.

Mechanism (task file): a `{sub→profileId}` map on `Snapshot.meta`, kept **outside** the `changedBy` same-actor coalesce compare; the server-supplied `actAs` carries `{ sub, profileId }` (both unforgeable, from the JWT).
