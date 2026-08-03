# ADR-018: The Global Singleton Is the Scarce Resource

**Date**: 2026-08-03
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: measured ceilings for a single Durable Object (below); a design review that proposed routing every destructive action in the system through a per-action audit table in the identity registry; a token-refresh path deliberately moved to edge KV to keep the registry off the highest-volume authenticated path, which a later miss-fallback quietly put back on it while an always-loaded rule went on asserting the registry was never there; a registry table that exists only as a by-subject enumeration index for revocation, which edge-KV prefix listing can serve instead.

## Context

Some state genuinely requires a single authority: global uniqueness (one slug, one address, one owner) and strongly-consistent reads at the moment of decision. Those are real needs, and today one Durable Object — the identity registry — carries them.

A single DO is also a **hard ceiling that does not shard**:

| | Measured |
|---|---|
| Storage | **10 GB**, per object, full stop |
| Sustained requests, worst case (all writes) | **~410 rps** |
| Sustained requests, no database reads | a little **above 1000 rps** |
| Sustained requests, one indexed row read | a little **below 1000 rps** |

The ceiling is not a tuning knob. There is no replica to add, no shard key to introduce, no instance count to raise. Passing it means **re-architecting the authority model itself** — deciding what uniqueness actually requires a single writer, splitting it, and migrating live identity data. That is a project, not a fix, and it arrives as an outage rather than a warning.

This asymmetry is the whole point: **everywhere else scales horizontally and this does not.** Edge KV, per-entity DOs, and Workers all absorb load by multiplying. The singleton absorbs load by running out.

What makes it worth writing down is that the pressure is **incremental and always locally reasonable**. Nobody proposes overloading the registry. They propose one audit table, one index, one convenience read — each cheap on its own, each landing on the one surface where cheap things accumulate against a wall. Three such proposals arrived within two weeks of each other, from people and reviewers who did not know the numbers, and each had to be re-argued from scratch.

## Decision

**State and requests default to OFF the singleton. Landing either on it requires a reason no other placement satisfies — and the only qualifying reasons are global uniqueness and strong consistency at the moment of decision.**

Three consequences follow, in preference order when placing anything new:

1. **Derive it.** State that can be recomputed from what already exists does not need a home.
2. **Put it where it scales** — edge KV, a per-entity DO, or the requesting Worker. Accept eventual consistency and design for it explicitly; that is the price of scaling, and it is usually payable.
3. **The singleton, only when 1 and 2 genuinely fail.** "It is convenient there" and "it is a small table" are not reasons — smallness is what makes the accumulation invisible.

Two standing obligations for whatever does qualify:

- **Never on a per-request path that scales with user activity.** A path taken once per session is different in kind from one taken on every request; the second converts user growth directly into singleton load. When a hot path is moved off, keep it off — a fallback that reaches back on a miss is the same path wearing a different name, and it will be described as "rare" by whoever adds it.
- **Bounded lifetime, stated.** Anything stored must have a sweep, a TTL, or an argument that its row count is bounded by something that itself cannot grow without limit (the number of scopes, say, rather than the number of logins). "Stale rows are harmless" answers correctness, not the 10 GB ceiling — the two questions are separate and both must be answered.

⚠️ **This constrains design, never correctness.** It is not a licence to weaken a guarantee to save a request. If uniqueness or strong consistency is genuinely required, the singleton is the right answer and the ADR is satisfied by saying so.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Shard the registry** | The uniqueness guarantees are *why* it is a singleton; sharding them away is the re-architecture this ADR exists to postpone, not a way to avoid it. Worth doing when a measured trend demands it — not speculatively. |
| **Treat the ceilings as a future problem** | The failure mode is not degradation, it is a rewrite under production load. The cost of respecting the limit now is a design constraint; the cost of discovering it later is an outage plus a migration of live identity data. |
| **Leave it to per-component judgment** | Tried implicitly, and it failed three times in two weeks — each proposal locally reasonable, none aware of the numbers. The information a reviewer needs is exactly the thing no component-level document carries. |
| **A cache in front of the singleton** | This *is* option 2, described as if the singleton were still the source of truth. Stating it that way keeps the singleton on the hot path in every miss case, which is how the refresh path regressed. Place the state where it scales and treat the singleton as the exception. |
| **A numeric budget (rps/GB quotas per component)** | Precision the measurements do not support and nobody would maintain. The shape — justify what lands there — survives re-measurement; a quota table does not. |

## Consequences

### Positive
- A rejection becomes one sentence with a citation instead of a re-derivation, and the reviewer proposing the table learns the constraint at the moment it applies.
- It gives a **placement question** a default answer, which is what most of these decisions actually need.
- Designs that respect it tend to be more available anyway: work spread across KV and per-entity DOs has no single point of saturation.

### Negative / mitigations
- **Some designs get harder.** Replacing an indexed table with edge-KV prefix listing trades a strongly-consistent query for an eventually-consistent one, which then needs an explicit answer for the race — a second sweep, a bounded window, or an accepted exposure. That work is real and this ADR makes it mandatory rather than optional.
- **Eventual consistency has to be reasoned about at every such site,** and reasoned about honestly: the failure mode matters more than the window. A miss that is permanent and silent is not the same risk as one that is bounded and self-correcting, even when both are "eventually consistent."
- **The numbers will drift.** They are evidence, not the commitment — re-measure them freely; the decision does not move when they change. It moves only if a single object stops being a hard ceiling.
