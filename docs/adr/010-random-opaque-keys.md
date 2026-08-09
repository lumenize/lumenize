# ADR-010: Random Opaque Keys

**Date**: 2026-07-08
**Status**: Accepted
**Deciders**: Larry
**Evidence**: `tasks/archive/nebula-auth-surrogate-sub.md` (the email-as-cross-DO-FK failure) and `tasks/archive/dag-client-supplied-nodeid.md` (the ROWID→client-`resourceId` migration) — the two prod-wipe failures that motivated this; ADR-006 (reference-by-id).

## Context

Natural keys and auto-incrementing keys are troublesome in the best of times, but particularly so in highly distributed systems like those built on Cloudflare Workers/DOs:

- **Natural keys can change.** `@lumenize/nebula-auth` used an **email string** as a foreign key spanning the singleton auth registry and the per-scope NebulaAuth DOs. Emails change — acquisition/domain change, legal name change. Re-keying a natural key across N independently-versioned DOs is intractable: there is no cross-DO transaction, cascade, or `ALTER`. That's the classic **natural-key-as-a-foreign-key** anti-pattern. **Result**: We had to wipe production and re-deploy a new version of the Nebula app. This was only possible because we had no users yet. If we had, that would have been much more difficult.
- **Auto-incrementing keys can only be generated in one place, the DB server.** The Nebula Resources data-plane was originally built using SQLite's built-in auto-incrementing ROWID. When we went to add transaction support to Resources, we realized that if the client could generate the actual resourceId key, we wouldn't need an additional round trip or the complexity of having an additional coordinating key. **Result**: Again, we had to wipe production to make the switch.

We made roughly the same mistake twice and got lucky that we could resolve before we had users whose data we would need to preserve. Without this ADR, a fresh contributor or LLM would reach for the convenient natural key (email, slug, display name) as an identifier within their first week; it reads as simpler right up until the re-key bill comes due.

## Decision

Every key — primary or foreign, within a store or across a boundary — is a **random opaque key**, statistically guaranteed to be unique without requiring coordination. Never key off a natural or mutable attribute (email, slug, display names can change). Never key off an auto-incrementing counter (restricts where it can be generated).

Two types are recommended:

- A **UUID** for unordered keys. A native UUID v4 generator is currently available in Cloudflare Workers.
- A **ULID** when creation-order sortability is advantageous. The package and parameters (must be monotonic on Cloudflare to avoid the clock-stops problem) for generating these on Cloudflare Workers are specified in [`coding-style.md`](../../.claude/rules/coding-style.md) § IDs, not this ADR. If UUID v7 support is ever natively added to Cloudflare Workers, that will become the recommended format for new key fields. Both ULIDs and UUID v7s have a timestamp prefix that makes them sortable and a significant enough random tail that statistically guarantees uniqueness without coordination.

**Companion invariant — the replication rule.** Because keys act as immutable surrogates for the rows they are the key for, they may be **replicated freely** — copied into tokens, caches, denormalized rows — with no drift risk. A **mutable** attribute (email, `scopeAdmin`) has **exactly one authoritative source** (the authority that owns it); any other copy is a **cache that must be kept convergent** by an explicit mechanism — read-through, push-on-change, or a **short-lived** token whose expiry bounds the staleness. Denormalizing a mutable value is thus a **deliberate, mechanism-backed** choice, not a free one (e.g. the planned registry→NebulaAuth push for `scopeAdmin`). What's forbidden is the copy that can't be reconciled: a mutable value in a token whose TTL is large in comparison to the expected frequency of change, or a second store with no propagation plan — drift with no path back to truth.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Natural key as PK/FK** (email, slug, name) | The status quo that failed. Cannot re-key across DOs after data exists; recycles identity on mailbox reuse; every consumer of the key re-breaks when the natural value changes. |
| **Auto-incrementing / rowid counters** | Require **coordination** — only the one authority owning the sequence can mint the next value, forcing a round-trip and blocking offline + idempotent creation; also guessable, enumerable, and cross-DO-colliding. The Resources data-plane hit exactly this (Context). (A time-ordered **ULID** is *not* this — its random tail makes it coordination-free; the taboo is the counter, not sortability.) |
| **A `.claude/rules/` convention instead of an ADR** | It spans packages (auth, ontology, mesh), survives mechanism swaps (UUID lib, DO storage engine), and a fresh contributor/LLM re-violates it in week one (it just did, with email). It must be caught at `/review-task`, where ADRs are read. |

## Consequences

### Positive
- The re-key-across-DOs failure class is closed; identity survives an email change as a one-row update, orphaning nothing (tokens/grants are opaque-key-anchored).
- The coordination-free principle is now named and always-loaded, so the next boundary reaches for a random opaque key by construction — precluding both the email-as-FK and the ROWID re-key failures.
- The replication rule makes "what may I cache / denormalize / put in a token?" answerable by construction: immutable keys freely; a mutable attribute only behind a convergence mechanism (read-through / push-on-change / short-TTL token), never as an un-reconcilable copy.

### Negative / mitigations
- **Opaque keys aren't human-readable** — debugging and ad-hoc joins need a lookup. *Mitigation:* keep a single indexed natural-attribute **query path** (e.g. the registry's `email` index → `sub`), explicitly a lookup, never a key.
