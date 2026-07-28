# ADR-016: Destructive and Authority-Changing Actions Record the Full Acting Principal

**Date**: 2026-07-28
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: the registry's destructive/authority ops and what each records today — `nebula-auth-registry.ts:888` (`Scope deleted { target, callerSub }` — a caller identity, but the authority principal only), `:501` (`Galaxy created { callerAccessId: authScopePattern }` — a *pattern*, not an identity), `:346`/`:426` (universe/star claimed — `email`, no `sub`), `setIdentityAdmin:827` (**no record at all**); the one path that already carries the chain, `apps/nebula/src/resources.ts:164` `#buildChangedBy` → `Snapshots.changedBy`; `.claude/rules/security.md` delegation rule (1); [ADR-008](008-full-org-tree-visibility.md), which names an audit log as load-bearing but not-yet-built; the impersonation design in `tasks/nebula-mint-narrower-token.md`.

## Context

Delegation is real in this system: `/mint-narrower-token` mints a token whose top-level `sub` is one person and whose `act` chain names another. The read-side invariant is deliberate and correct — **authz decisions read the authority principal (`sub` + its `access`) and never the `act` chain** (`security.md` rule (1)). An impersonating admin therefore acts *with the subject's authority*, which is the whole point of the capability.

That endpoint goes further: it mints a deliberate **mirror** of the subject — same `sub`, the subject's `admin` bit, the subject's reach — so that an admin sees exactly what that person sees. **`act` is therefore the only field distinguishing an impersonated token from one the subject minted themselves.** Every other field is identical by design.

Which is exactly why the **record** cannot key off `sub` alone. When authz keys off the subject, the subject is the only identity the acting code naturally has in hand — so a record built from it names **the person who was acted upon as the person who acted**. That is not an incomplete record; it is an affirmatively wrong one, and it is worse than no record, because it will be believed. Drop `act` and the two sessions are indistinguishable by construction, forever.

The reflex is to treat this as an audit-mechanism problem and defer it until there is somewhere durable to write. That gets it backwards. **The mechanism is replaceable; the contents are not retrofittable.** A Tail Worker, a durable table, or a structured log can all be swapped in later — but none of them can reconstruct an actor that was never captured at the time. History has one chance.

A separate reflex is to scope the rule to *irreversible* actions. That is a loophole: whether an action is reversible is a property of the mechanism, not of the need for a record, and **a reversible action that nobody reverses is indistinguishable from an irreversible one**.

## Decision

**Every action that destroys or removes state, and every change to a principal's authority, records the FULL verified claims of the acting token** — the authority `sub`, the **complete `act` chain**, `profileId`, and the `access` entry (`authScopePattern` + `admin`) — as a **write-time-pinned, immutable** record.

- **Reversibility is not an exemption.** The trigger is *destroys/removes state* or *changes authority*, not *cannot be undone*.
- **The stored `access` entry is what the bearer ASSERTED at that moment.** It is immutable history and **must never be read back as an authz input** — doing so would be a stored-scope-set, which [ADR-013](013-identity-profileid-resolution.md) rejects as a security bug. It answers "what authority was claimed here," never "what authority does this principal have."
- **`profileId` rides along** — both the subject's and the actor's (`act.profileId`). It is display-only, immutable, and write-time-pinned: the [ADR-013 amendment](013-identity-profileid-resolution.md#amendment-2026-07-18--the-immutable-metadata-attribution-stamp-is-a-blessed-exception) carve-out exactly. This is what lets a record name a **departed** actor without a live registry hop.
- **Mechanism is deliberately unspecified.** Debug log, durable table, Tail Worker, R2 — all are conformant, and the choice may change without reopening this ADR. What is recorded is the commitment; where it goes is not.

### Corollary — where a record is also a dedup key, DERIVE the key; never narrow the record

There is **no carve-out**. The rule above is uniform, including for resource writes. What varies is that some records double as a **same-actor comparison key**, and that comparison must key on **identity only — the `sub` plus the complete `act` chain** — never on a stringification of the stored record.

`resources.ts:212`'s `JSON.stringify(current.meta.changedBy) === changedByJson` is the live instance. It works today only because `#buildChangedBy` stores `{ sub, act }` and nothing else, so the record and the identity key happen to coincide. Widen the record without splitting the key and coalescing breaks: the window is **1 hour** (`resources.ts:107`) while `ACCESS_TOKEN_TTL` is **15 minutes**, so a single window spans several tokens with distinct `jti`/`iat` — the same person's hour-long editing session would stop coalescing, multiplying snapshot rows on the highest-volume write path.

Split them and there is **no behavioural change at all**: a key derived from (`sub`, `act`) is *identical* to today's stringify, because those are already the only fields present. The widening is therefore breaking on disk and inert in behaviour.

**Excluded from the key, deliberately:** `profileId` (derived from `sub`, so it adds nothing and would spuriously split on a future unification re-point) and `access` (asserted authority — see above; a snapshot must not split because someone's admin bit changed mid-window).

⚠️ **Resources is not conformant yet.** `changedBy` is persisted history, so widening it is a breaking storage change — tracked as item 6 of the schema-surgery batch in `tasks/nebula-pre-alpha.md` § Remaining → Invite-gated, gated on the pre-alpha wipe window. Until then `changedBy` remains `{ sub, act }`, which names the actor correctly and is a *subset* of this ADR, not an exception to it. A related consequence to check at that time: with both parties' `profileId` on the record, the parallel `{sub → profileId}` `Snapshot.meta` map planned in `tasks/nebula-galaxy-collapse-and-chat.md` may be redundant.

### In scope today

Scope deletion (`executeScopeDeletion`) · identity-authority changes (`setIdentityAdmin`) · scope/data wipes (`resetDevData` and any teardown) · scope creation and claim (`claimUniverse`/`claimStar`/`createGalaxy`/`createStar` — creation is an authority event: it mints a founder). Anything later that deletes, wipes, or moves authority joins by construction.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Record the `sub` only** (status quo) | Under impersonation this names the wrong human, with no marker that it did. `:888` does exactly this today. |
| **Record `sub` + `act.sub`, nothing else** | Fixes the wrong-person defect but loses *what authority was asserted*, which is the question a post-incident reader actually has ("how was this permitted?"). It also forces a live registry hop to render a departed actor's name — the case the `profileId` stamp exists for. |
| **Widen `changedBy` while leaving `JSON.stringify(changedBy)` as the coalesce key** | The naive route to uniformity, and it silently breaks coalescing: the 1-hour window spans several 15-minute tokens, so `jti`/`iat` differ and the same person's editing session stops coalescing. The fix is to derive the key, not to narrow the record — see the Corollary. |
| **Exempt resource writes permanently** (a standing carve-out) | Leaves two record shapes and two rules to keep in sync forever, for a reason that is an implementation conflation rather than a real constraint. Rejected 2026-07-28: derive the key and the exemption disappears. |
| **Defer until an audit mechanism exists** | Inverts what is replaceable. A mechanism can be swapped in at any time; an actor not captured at write time is gone. This is also how the gap arose — every site reached for a debug log, and no two agreed on what a "caller" is. |
| **Scope it to *irreversible* actions** | A loophole: reversibility is a property of the mechanism, and an un-reversed reversible action is indistinguishable from an irreversible one. Explicitly rejected 2026-07-28. |

## Consequences

### Positive
- An impersonated destructive action is attributable to the human who ran it — the capability `/mint-narrower-token` makes real becomes safe to *operate*, not just safe to mint.
- One answer to "what does a caller mean here," replacing four mutually inconsistent shapes in one file.
- Mechanism-independent: the observability work (`tasks/on-hold/nebula-observability-tail-worker-r2-ae.md`) and the denied-attempt audit log ADR-008 calls for can both consume these records without renegotiating their contents.

### Negative / mitigations
- **Nothing enforces this mechanically yet.** Until a shared helper exists, it is a convention each site must follow — and the sites disagree today, which is the evidence it needs writing down. A single `recordActingPrincipal(claims)` helper is the obvious consolidation (ADR-007's composition principle) when the mechanism lands.
- Records grow by roughly a claims object per destructive event. Negligible at these volumes, and destructive events are rare by nature.
- The stored `access` is a snapshot of asserted authority and **will go stale as authority changes** — which is correct for history and dangerous if read back. The "never an authz input" clause above is the guard; it belongs in a comment at every read site.
