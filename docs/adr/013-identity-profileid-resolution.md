# ADR-013: `sub` Is the Only Key — `profileId` Hangs Off the Address and Is Never Keyed On

**Date**: 2026-08-04
**Status**: Accepted
**Deciders**: Larry
**Evidence**: the `Emails.profileId` column + `idx_Emails_profileId`, reached from a `sub` through its `Memberships` row (`packages/nebula-auth/src/schemas.ts`); the `sub`-keyed grants/snapshots (`apps/nebula`); the JWT `profileId` claim riding the KV refresh record; ADR-010 (keys + the replication rule); design in `tasks/archive/nebula-profile-store.md`.

## Context

`sub` is **per-membership** — the same address in two scopes mints two `sub`s. `profileId` is the **global public display handle**. The mapping is single-valued in the direction that matters: many `sub`s → one `profileId`, each `sub` → exactly one. Two reflexes a fresh contributor reaches for: a `sub`↔`profileId` **join table**, and **copying `profileId` onto resource records** "so we don't resolve it every time."

⚠️ **Not to be confused with [ADR-012](012-global-profile-visibility.md), its same-day sibling** — the two are constantly mistaken for each other because both are about `profileId`. **This ADR is the DATA MODEL: where the `profileId` lives, and what may key on it.** ADR-012 is **AUTHZ: who may read and write a profile.** When the question is *"where is it stored, may I copy it, may I key or FK on it?"* it is answered here; when it is *"may this caller see or change it?"* it is answered there. They meet wherever one of this ADR's licensed copies feeds an authz check — the owner short-circuit below reads the JWT `profileId` claim, and the `act` pair's guaranteed presence is what ADR-012's `!claims.act` tests.

## Decision

**`profileId` is a column on the `Emails` row — a property of the ADDRESS, not of any one membership.** A `sub` resolves to it through its membership's `emailId`. There is no join table: a `sub` maps to exactly one address and an address to exactly one `profileId`, so there is no n:m and no per-link metadata to carry.

⚠️ **That placement is what makes "one human, one profile" a STRUCTURAL FACT rather than an emergent one.** Held per-membership, it would be a property of N rows agreeing — which yields derived canonical-ness (some "first" row wins), a first-mover race between two paths that see the same address, and a re-point that must update N copies in lockstep. One address, one row, one `profileId` has none of those failure modes to defend against.

**Every churny resolution keys off `sub`** (stable, never re-keyed); `profileId` is **never a key, an FK, or an authz input** — grants and snapshots key on `sub` only. That is what keeps a future person-unification **additive**: re-pointing is a one-row `UPDATE`, not a re-key across every resource record.

Denormalization follows ADR-010's replication rule: the immutable handle may be denormalized **only where it self-heals or is permanently frozen** — two cases, both licensed, and nothing else:

- **Self-healing:** the JWT and the KV refresh record carry `profileId` claims (ephemeral, re-minted on refresh; a re-point mutates them and joins `scopeAdmin`'s convergence re-put). An ordinary token carries the *bearer's own*; a narrower (impersonation) token carries **two** — the SUBJECT's at top level and the ACTOR's inside `act: { sub, profileId? }` (amended 2026-08-20: the actor pair is minted server-side from the caller's own verified claims and dies with the token, so it rides this same license, not a third case). Both claims are optional in shape — an identity can predate the profile store — and the `act` copy is display/attribution only, never an authz input (`security.md` reads only `act` *presence*). The build site (`access-claims.ts`) notes why `act` itself is never conditionally spread even when the actor's `profileId` is — ADR-012's presence guard depends on `act` surviving.
- **Write-time-pinned and permanently immutable:** an attribution record MAY carry the acting identity **as of the event**. That means the `profileId` handle — and, where the surface reading the record back has no live-resolution path, the **resolved display value** beside it. The handles are captured at write time from verified claims. A display value may instead be the actor's own assertion. Display values are self-asserted at their source already, so assertion-provenance subtracts nothing. The verified-claims handles beside it keep the record honest. ⚠️ **HARD INVARIANT: a stamped value NEVER changes.** It is history, not a cache. A future unification re-point does **not** re-point historical records, and a later rename does not rewrite what a record said at the event. The immutability that makes a *mutable* copy dangerous is here the point. Every stamp stays **display-only**, never read as a key, FK, or authz input. Live resolution remains the path wherever *current* is the meaning. A stamped display value is licensed only where the record answers "who, at the time", or where the reading surface cannot resolve live.

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
