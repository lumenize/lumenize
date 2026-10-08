# ADR-016: Destructive and Authority-Changing Actions Record the Full Acting Principal

**Date**: 2026-07-28
**Status**: Proposed — ratification deliberately **deferred past pre-alpha** (Larry, 2026-08-05). *(Formerly reviewed together with [ADR-019](019-derived-artifacts-record-observations.md), its read-side mirror — withdrawn 2026-08-26.)* ⚠️ This supersedes the general ratification gate in [README.md](README.md) § *The ratification gate* for it — do **not** ratify at `/build-task`. `Proposed` is the working state, not a backlog item: cite it, build against it, and **amend it from what that work finds — that is the intended path, not an override.**
**Deciders**: Larry
**Evidence**: the registry's destructive/authority ops and what each recorded when this was written — `executeScopeDeletion` (`Scope deleted { target, callerSub }` — a caller identity, but the subject only), `createGalaxy` (`callerAccessId: authScope` — a *scope*, not an identity), `claimUniverse`/`claimStar` (`email`, no `sub`), `setIdentityAdmin` (**no record at all**), `revokeRefreshToken` (`Logout` with no `sub` and no actor), `#invalidateRefreshTokensForSub` (**nothing at all**); the one path that already carries the chain, `apps/nebula/src/snapshots.ts` `#buildActingToken` → `Snapshots.actingToken`; `.claude/rules/security.md` delegation rule (1); [ADR-008](008-full-org-tree-visibility.md), which names an audit log as load-bearing but not-yet-built; the impersonation design in `tasks/archive/nebula-mint-narrower-token.md`. ⚠️ **Cited by SYMBOL, never by line number** — a symbol survives every edit a line number does not, and the line numbers this list once carried had already rotted before anyone noticed.

## Context

Delegation is real in this system. Impersonation mints a token whose top-level `sub` is one person and whose `act` chain names another. Authorization reads the subject (`sub` and its `access`) and never the `act` chain (`security.md` rule (1)), so an impersonating admin acts *with the subject's authority*, which is the whole point of the capability.

The mint goes further. It issues a deliberate **mirror** of the subject — the same `sub`, the subject's `scopeAdmin` bit, the subject's scope — so that an admin sees exactly what that person sees. **`act` is therefore the only field distinguishing an impersonated token from one the subject minted themselves.**

Which is exactly why the **record** cannot key off `sub` alone. The subject is the only identity the acting code naturally has in hand, so a record built from it names **the person acted upon as the person who acted**. That record is not incomplete but affirmatively wrong, and worse than none, because it will be believed.

Deferring this until there is somewhere durable to write gets it backwards. **The mechanism is replaceable; the contents are not retrofittable.** A Tail Worker, a durable table or a structured log can be swapped in later, but none of them can reconstruct an actor nobody captured at the time.

Scoping the rule to *irreversible* actions is a loophole. Reversibility is a property of the mechanism, not of the need for a record, and **a reversible action nobody reverses is indistinguishable from an irreversible one**.

## Decision

**Every action that destroys or removes state, and every change to a principal's authority, records the FULL verified claims of the acting token**: the subject `sub`, the **complete `act` chain**, `profileId`, the `access` entry (`authScope` and `scopeAdmin`), and `aud`, the call's `activeScope` — the scope of the page that started it. The record is **write-time-pinned and immutable**.

- **Reversibility is not an exemption.** The trigger is *destroys or removes state* or *changes authority*, never *cannot be undone*.
- **`access` and `aud` together are the authority the bearer asserted.** Dominion reads the host's scope with the membership's `scopeAdmin` ([ADR-015](015-passage-and-dominion.md)). Without `aud`, a record could not tell a universe admin deleting a tenant from the universe's page from the same admin doing it on the tenant's own page, where the app's code runs.
- **What was asserted is history, never an authz input.** Reading a stored `access` or `aud` back to decide anything is a stored scope-set, which [ADR-013](013-identity-profileid-resolution.md) rejects as a security bug. The record answers "what authority was claimed here," never "what authority does this principal have." [ADR-019](019-derived-artifacts-record-observations.md), withdrawn 2026-08-26, was the read-side mirror: *what was read*, always re-checked, where this is *who acted*, never re-read.
- **`profileId` rides along**, the subject's and the actor's (`act.profileId`). It is display-only and write-time-pinned, exactly the [ADR-013 amendment](013-identity-profileid-resolution.md#amendment-2026-07-18--the-immutable-metadata-attribution-stamp-is-a-blessed-exception) carve-out. It lets a record name a **departed** actor without a live registry hop.
- **An actor may be token-attested or server-composed, never client-supplied.** The primary case is an action under a verified token, whose claims the record stores whole. The second is the platform prepending itself when an agent writes for a person: Studio's agent turn records `{ sub: <the human>, act: { sub: 'agent:lumenize' } }`, composed server-side inside the human's own call by `prependActor`. That actor holds no authority; the write carries the human's. A client able to name its own actor would defeat this ADR, so the trust boundary is server-stamped against client-supplied. Keep a server-composed id self-describing and not shaped like a person's, so the two provenances stay apart at audit time.
- **An action that establishes a session has no acting token, and its record says so.** The magic-link and invite consume, and a claim made with a signup ticket, authenticate by the credential they carry. So the record names the address that credential proved and every membership it opened, and carries no `actingToken`.
- **One shared projection produces every record, and no site assembles its own.** A caller passes verified claims and receives the record; it never picks fields. A hand-assembled record diverges silently the moment the contents grow, and a divergence here is unrecoverable history. Today the projection is `projectActingToken`, exported from `@lumenize/nebula-auth` and its Node-safe `/claims` subpath. **Conformance is stated structurally**: every site that emits a record routes through the projection, and one that assembles fields inline is non-conformant by definition. To check it, re-run `security.md` § *Delegation*'s instrument (`grep -rn '\.act\b'`) and confirm each hit either routes through the projection or is not a record site.
- **What is recorded is the commitment; where it goes is not.** The choice is two-way: the log stream, or a durable table the action writes itself. A Tail Worker and R2 are how a log line reaches durable storage (`tasks/on-hold/nebula-observability-tail-worker-r2-ae.md`), not a third place to put it. Today the record is a `@lumenize/debug` line at the point of action, so **this ADR imposes no storage obligation on any schema**. A consumer discharges it by logging, and must not stand up an audit table to satisfy it.

### Corollary — where a record is also a dedup key, derive the key and never narrow the record

A record that doubles as a **same-actor comparison key** keys on identity only, the `sub` plus the complete `act` chain, and never on a stringification of the record.

`snapshots.ts`'s coalescing compare is the live instance. The column stores the full record through the projection, and `identityKey` decides same-actor. The window is an hour while an access token lives 15 minutes, so a key built from the whole record would split one person's editing session at every refresh. `profileId`, `access` and `aud` stay out of the key: `profileId` is derived from `sub`, and a snapshot must not split because someone's admin bit or page changed mid-window. A wire allow-list, `WireActingToken`, keeps the asserted `access` and `aud` in the column, so a snapshot delivered to a client carries identity and display `profileId`s only.

### In scope today

Scope deletion (`executeScopeDeletion`) · identity-authority changes (`setIdentityAdmin`) · scope and data wipes (`resetDevData` and any teardown) · scope creation and claim (`claimUniverse`, `claimStar`, `createGalaxy`) · establishing a session. Creation is an authority event: a claim mints an admin identity, and an admin-gated create hands its caller a scope they administer. A login moves no authority, but it is the first thing a post-incident reader asks about, and the moment a principal starts acting. Anything later that **deletes, wipes, moves authority, or establishes a session** joins by construction.

**A resource write records on EVERY snapshot.** A chat message is none of the members above, and `Snapshots.actingToken` is written on every row anyway. The list bounds what must be added elsewhere, never what the resource plane may omit.

**Two exclusions, stated so they expire correctly.** A **token refresh** changes no authority and re-establishes nothing, since the session already exists. An **unattended sweep** of rows already inert on lookup is done on nobody's behalf, so there is no principal to record. Both rest on *"no authority moves and nobody is acted for"*. Widen a sweep to reap something a live path still reads, and its exclusion has to be re-derived rather than inherited. The refresh's persona branch is not covered: it mints a token for a principal other than the cookie's holder, who is acted for, so it records the opener.

**Where a site is a judgement call, record.** *Authority* here means what a principal may do, which is wider than dominion and takes in a data-plane grant, so real borderline cases exist. An actor never captured cannot be reconstructed, while a needless record costs a log line. This breaks ties; it does not trim the two exclusions, since a token refresh is the one high-frequency path.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Record the `sub` only** | Under impersonation this names the wrong human, with no marker that it did. |
| **Record `sub` + `act.sub`, nothing else** | Fixes the wrong person but loses *what authority was asserted*, which is the question a post-incident reader has ("how was this permitted?"). It also needs a live registry hop to render a departed actor's name. |
| **Widen the record but keep it as the coalesce key** | The naive route to uniformity, and it silently breaks coalescing, since one window spans several tokens. See the Corollary. |
| **Exempt resource writes permanently** | Two record shapes and two rules to keep in sync forever, for a reason that was an implementation conflation (2026-07-28). |
| **Defer until an audit mechanism exists** | Inverts what is replaceable. It is also how the gap arose: every site reached for a debug log, and no two agreed on what a "caller" is. |
| **Scope it to *irreversible* actions** | A loophole, per § *Context* (2026-07-28). |

## Consequences

### Positive
- An impersonated destructive action is attributable to the human who ran it, so impersonation is safe to *operate*, not just safe to mint.
- One answer to "what does a caller mean here," replacing four inconsistent shapes in one file.
- Mechanism-independent: the observability work and the denied-attempt audit log [ADR-008](008-full-org-tree-visibility.md) calls for can both consume these records without renegotiating their contents.

### Negative / mitigations
- **Enforcement is per-phase and diff-scoped, so it needs no tally.** Each piece of work carries one obligation: every method its own diff touches that § *In scope today* covers emits through the shared projection, and stripping the claims argument from any one of them must red. It has a known blind spot: a defective site no diff touches is never reached. When a piece of work finds such a site, it assigns it to the phase that opens it rather than leaving it to the general rule.
- **Name the stored field for the token, not for a role.** `actingToken.sub` reads as the token's subject, which is what it is. Every role name inverts, because `sub` is the person acted *upon*. The first site tried `actor` and then `actingClaims` before landing on `actingToken`.
- Records grow by roughly a claims object per destructive event, which is negligible at these volumes.
- The stored `access` and `aud` go stale as authority changes, which is correct for history and dangerous if read back. The never-an-authz-input rule above is the guard, and it belongs in a comment at every read site.
