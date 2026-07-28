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

**Boundary:** only the PUBLIC fields are open. `privateNotes` (and any future protected-class field) stays behind `requireOwnerOrAdmin` (owner via the JWT `profileId` claim; **super-admin** via the `pattern === '*'` short-circuit). The pushed/subscribed `Snapshot.value` carries public fields ONLY — the private blob never rides it.

**A profile is never an authz input.** A `Profile` is purely display: it is never an input to an admin or any other permission decision **outside the Profile DO itself**, and conversely no *scope-derived* authority confers rights over a profile. Concretely, `requireOwnerOrAdmin` qualifies **only** the owner and a super-admin; the original scoped-admin branch — pass if the caller is admin of any scope in `getScopesForProfile(profileId)` — is **retired**, and with it the reverse `profileId → scopes` lookup as an authz input (`getScopesForProfile` survives only as a non-authz utility, if at all).

Three independent reasons, any one sufficient:
1. **Direction.** A `profileId` is global and scope-free by this ADR's own decision; a scope admin's authority is scope-local (ADR-015: authority flows strictly downward *within a scope tree*). Deriving authority over a global object from a scope-local grant is a category error — and it points *sideways*, across the tree, which no ADR licenses.
2. **Reach.** One profile per person means a profile touches **every scope that person belongs to** — so the retired branch handed every admin of every one of those scopes the ability to read `privateNotes` and rewrite that person's global name and picture.
3. **Scope authority over a profile can be MANUFACTURED — so it bounds nothing.** Universe self-signup is open *by design*, and `issueInvites` mints the invitee's membership immediately (`emailVerified=0`, **no acceptance required**). Because `profileId` hangs off the email row, *"same email, any scope → same `profileId`"* is a structural fact. So **anyone** can claim a Universe, invite any address, and thereby become "an admin of a scope that person's profile touches" — unilaterally, in seconds, for a stranger. Any rule of the form *admin-of-a-scope-the-profile-touches ⇒ rights over the profile* therefore grants those rights to **everyone**, not to a trusted population. This is the reason that survives contact with the open-signup product decision, and it is why no *amount* of narrowing the scope predicate can rescue the branch.

**A delegated token is not the owner.** The same manufacture defeats any bound keyed on impersonation eligibility. `/mint-narrower-token` mints a token whose `sub` — and whose `profileId` claim — are a member's, and the owner branch is a zero-read equality on that claim, so it would fire. The caller can manufacture the eligibility that lets them mint (claim a Universe, invite the address), so the owner branch must additionally require that the token is **not** delegated:

```typescript
if (claims?.profileId && claims.profileId === profileId && !claims.act) return;
```

⚠️ This is the **one** place where the presence of `act` changes an authz outcome, and it is a deliberate exception to `security.md`'s read-side rule rather than an application of it. The exception is licensed by *global*: for scope-tree resources an impersonating token is correctly treated as the subject, because a manufactured scope contains nothing of the victim's. A global object is the only thing an attacker can drag into a scope they invented.

**Blast radius, stated so the severity is not overread:** the profile holds display fields plus `privateNotes` and nothing else — never Universe/Galaxy/Star contents. This is a correctness boundary, not a data-plane one.

**Accepted cost:** a Galaxy admin cannot fix a member's bad display name; moderation escalates to super-admin. **Bonus:** the write path loses its one registry read (and the fail-closed complexity around it), so it is gate-free like the read path.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Scope-intersection reach gate** on the profile read | Breaks cross-scope resolution — the roster/attribution case is the norm, not the exception. This is the designated **fallback if this ADR is ever un-ratified**; the profile-store build's capable-of-failing tests pin exactly which paths would flip. |
| **Guessable slug** (`/profiles/{username}`) | Enumerable → the handle stops being the capability. The opaque UUID (ADR-010) is load-bearing. |
| **Per-scope profile copies** | Re-introduces the stale-copy / re-key problem [ADR-013](013-identity-profileid-resolution.md) exists to avoid, and defeats "one profile a person edits once." |
| **Keep the scoped-admin write branch** | Makes a global object writable from scope-local authority — see § Decision. Gating it on `emailVerified=1` instead does not save it: that closes only the pre-acceptance window, leaves a legitimately-joined co-scope admin able to rewrite a global identity, and conflates the *write gate* with the question of how a person's identities relate to one another, which is a separate concern. |

## Consequences

### Positive
- `sub → display` resolves uniformly wherever a handle is legitimately held; the hot path is gate-free (zero registry reads on read/subscribe).
- **Open-resolution ≠ enumeration** — you can only act on a `profileId` you legitimately obtained, and it is unguessable.

### Negative / mitigations
- The trust rests on the `profileId` staying **unguessable + non-enumerable** (ADR-010) and on the **public/private field split being enforced at the DO** — the DO builds the pushed `value` from the public subset, never handing out the stored record (which holds `privateNotes`).
- A future *protected-class public field* would need its own gate — the open read is public-fields-**only** by construction, not a blanket "the Profile DO is open."
