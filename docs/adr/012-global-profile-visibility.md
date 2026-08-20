# ADR-012: Global Cross-Scope Profile Visibility via an Unguessable Handle

**Date**: 2026-08-04
**Status**: Accepted
**Deciders**: Larry
**Evidence**: the Profile DO (`packages/nebula-auth/src/profile.ts` — open `read()`/`subscribe()`, `requireOwnerOrAdmin` gates public writes + the private fields); the registry's acceptance predicate (`getScopesForProfile`, and the capable-of-failing manufacture test in `packages/nebula-auth/test/identity-mint-point.test.ts`); the `NebulaClientGateway` PROFILE-fence (`onBeforeCallToClient`); ADR-008 (intra-Star tree visibility); ADR-010 (random opaque keys); design + capable-of-failing tests in `tasks/archive/nebula-profile-store.md`.

## Context

A person's public profile (`name`/`nickname`/`picture`) must resolve from a bare `sub` wherever it is encountered — a chat roster, `actingToken` attribution, the org tree — and those encounters routinely cross scope/Star/Universe boundaries (a roster in scope X references a `sub` whose profile lives in scope Y). The `profileId` is a random opaque registry UUID (ADR-010): unguessable and non-enumerable, but **not scarce** — the mesh hands it out wherever display resolution is legitimate (the bearer's own JWT claim, [ADR-013](013-identity-profileid-resolution.md)'s attribution stamps on every snapshot, rosters, URLs per ADR-017), so holding one is ordinary, not evidence of anything.

ADR-008 established "identity is not confidential" but is **explicitly intra-Star** and disclaims cross-tenant visibility, so it does not by itself license a global read. The reflex a fresh contributor reaches for is a scope-intersection **reach gate** on the profile read — which breaks exactly the cross-scope resolution the feature exists for.

⚠️ **Not to be confused with [ADR-013](013-identity-profileid-resolution.md), its same-day sibling** — the two are constantly mistaken for each other because both are about `profileId`. **This ADR is AUTHZ: who may read and write a profile.** ADR-013 is the **DATA MODEL: where the `profileId` lives, and what may key on it.** When the question is *"may this caller see or change it?"* it is answered here; when it is *"where is it stored, may I copy it, may I key or FK on it?"* it is answered there. They meet wherever one of ADR-013's licensed copies feeds an authz check — the owner short-circuit reads the JWT `profileId` claim, and the `act` pair's guaranteed presence is what this ADR's `!claims.act` tests.

## Decision

**Public profile fields (`name`/`nickname`/`picture`) are readable and subscribable by ANY authenticated caller that holds the `profileId`** — across scope/Star/Universe boundaries. No reach gate, no registry read on the read/subscribe path; the Gateway's authN is the only check. **Holding the `profileId` is the whole ADDRESSING story — it is not a secret, and unguessability is not what carries the trust** (re-weighted 2026-08-20; the original *"holding it IS the capability"* phrasing is `calibration.md` §1's recorded trigger — it misdrafted ADR-017). What makes the open read safe, in order: (1) the Gateway's **authN** — no anonymous caller reaches a Profile at all; (2) the **`PUBLIC_FIELDS` allow-list** at the DO — the read reveals only public display fields, so it would be safe **even if handles were guessable**; (3) the **acceptance predicate** on the scoped-admin branch, for everything past the public set. Unguessability buys exactly one thing on top: an authenticated caller cannot **enumerate** the platform-wide directory of display fields. Weight it accordingly. ⚠️ **The analogy is a public GitHub profile with an unguessable handle instead of a slug — and it stops there.** A GitHub profile is readable **logged out**; this is not, and never was: the Gateway's authN is a real requirement, so an anonymous holder of a `profileId` reaches nothing. There is also no HTTPS surface to reach — the Profile DO has no `fetch()` handler and no route, so a Profile cannot be curled, crawled, or linked to from outside. Reading it is a mesh call on an already-authenticated connection. Do not read the analogy as licensing logged-out access; that misreading was live in `docs/vision/auth.md` until 2026-08-05.

This **generalizes** ADR-008's principle from within-a-Star to a global public-address handle; because it exceeds ADR-008's intra-Star scope, it is its own commitment.

**Exactly two capability levels — no finer-grained model.** (1) **Read the public fields** — any authenticated caller holding the `profileId`, per the paragraph above. (2) **Read and write the private fields, and write the public ones** — the owner, a super-admin, and an admin holding dominion over a scope in which this profile holds an **accepted** membership. Anyone who can read a private field can also write it and write every public field; do not introduce per-field roles or a permission matrix.

**Private-by-default, DERIVED not enumerated.** The public set is an allow-list (`PUBLIC_FIELDS` — `name`/`nickname`/`picture`); **every other field is private by construction**. `privateNotes` ("what the LLM knows about you") is simply the first of them. A newly added field is therefore private without anyone deciding, and **cannot leak into a snapshot by omission** — the pushed/subscribed `Snapshot.value` is built from the allow-list, never by removing known-private keys from the stored record.

**Scope authority over a profile requires an ACCEPTED membership.** `requireOwnerOrAdmin` qualifies the owner (JWT `profileId` claim), a super-admin (the reserved platform scope is the ROOT of the tree — `isPlatformScope`), and a scoped admin with dominion (`hasDominionOver`) over a scope returned by `getScopesForProfile(profileId)` — which counts **only memberships the person actually took up**. Acceptance is what makes that branch safe, and it is not a tidy-up:

- **Without it, the authority is MANUFACTURABLE and therefore bounds nothing.** Universe self-signup is open *by design*, and `issueInvites` mints the invitee's membership immediately. Once `profileId` hangs off the email row, *"same email, any scope → same `profileId`"* is a structural fact — so **anyone** could claim a Universe, invite any address they can guess, and thereby become "an admin of a scope that stranger's profile touches", unilaterally and in seconds. A rule of that shape grants its rights to *everyone*.
- **Acceptance closes it because it is proof of the MAILBOX.** The only writer of the accepted marker is the login verify path, reachable solely by consuming a magic link or invite delivered to the address. An attacker cannot forge it for someone else's address, and an invited-but-never-accepted membership confers nothing.
  - ⚠️ **The marker is the MEMBERSHIP's acceptance — NOT `emailVerified`.** The reflex is to reuse the verified-email flag, and it reopens the hole: proving a mailbox is a property of the **ADDRESS**, so a victim who proved it in any *other* scope already carries `emailVerified=1`, and an invite mints their membership immediately and un-taken-up. The flag would therefore be satisfied by someone who never touched the invitation. What must be per-membership is *"was this invitation taken up?"* — conflating the two hands the attacker exactly the authority acceptance exists to deny.

⚠️ **Two consequences are ACCEPTED here, not answered — say so rather than rediscovering them:**
1. **Direction.** A `profileId` is global and scope-free by this ADR's own decision, while a scope admin's dominion is scope-local (ADR-015: dominion flows strictly downward *within a scope tree*). This branch therefore points **sideways**, across the tree. Acceptance bounds *who* can point sideways to people who genuinely joined; it does not make the direction downward.
2. **Reach.** One profile per person means it touches **every scope that person belongs to**, so an admin of any one of them reaches a *global* object — including for someone whose profile also spans Stars that admin has nothing to do with.

Both are the price of admins being able to curate a member's private fields at all, which is the capability this branch exists for. **Scope-keyed private fields are the answer if it ever bites** — see § *Alternatives considered*; that change makes the object scope-local, at which point the authority points downward and the residual disappears.

**A narrower token is not the owner.** The same manufacture defeats any bound keyed on impersonation eligibility. `/mint-narrower-token` mints a token whose `sub` — and whose `profileId` claim — are a member's, and the owner branch is a zero-read equality on that claim, so it would fire. The caller can manufacture the eligibility that lets them mint (claim a Universe, invite the address), so the owner branch must additionally require that the token carries **no `act` chain**:

```typescript
if (claims?.profileId && claims.profileId === profileId && !claims.act) return;
```

⚠️ This exception is licensed by *global*: for scope-tree resources an impersonating token is correctly treated as the subject, because a manufactured scope contains nothing of the victim's. A global object is the only thing an attacker can drag into a scope they invented. **The licensed class is global objects, not this one call site** — an `Emails` row keyed to a person across every scope is the same shape, and a read-side `act`-presence test on one inherits the same license for the same reason. It tests presence only, never *who* the actor is.

⚠️ **`!claims.act` guards the OWNER branch only, and does not fence impersonation out of the profile.** An admin impersonating someone who holds an accepted membership in a scope that admin covers reaches the private fields through the **scoped-admin branch, by their own authority** — which follows from impersonation meaning what it says, and is not a gap in the owner check. Do not read the `!claims.act` clause as though it closed that path.

**Blast radius, stated so the severity is not overread:** the profile holds display fields plus the private set and nothing else — never Universe/Galaxy/Star contents. This is a correctness boundary, not a data-plane one.

**Accepted cost:** the scoped-admin branch keeps the Profile DO's one registry read and the fail-closed complexity around it, so the write path is **not** gate-free like the read path. That read is on an authz path, so it wants an index on the reverse `profileId` lookup rather than a scan.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Scope-intersection reach gate** on the profile read | Breaks cross-scope resolution — the roster/attribution case is the norm, not the exception. This is the designated **fallback if this ADR is ever un-ratified**; the profile-store build's capable-of-failing tests pin exactly which paths would flip. |
| **Guessable slug** (`/profiles/{username}`) | Enumerable → any authenticated caller can crawl the whole display-fields directory. That bulk-enumeration bound is all unguessability buys (§ Decision, re-weighted 2026-08-20) — a slug spends it for nothing. |
| **Per-scope profile copies** | Re-introduces the stale-copy / re-key problem [ADR-013](013-identity-profileid-resolution.md) exists to avoid, and defeats "one profile a person edits once." |
| **Retire the scoped-admin branch entirely** (owner + super-admin only) | It was the decision here until 2026-08-04, on the grounds that scope-local authority over a global object points sideways and can be manufactured. The manufacture half is answered by requiring an **accepted** membership; the sideways half is real and is accepted above. What settles it is that admins curating a member's private fields is a **wanted capability**, not an oversight — retiring the branch removes it with no replacement short of super-admin, and the read it deletes is a cost worth paying for the capability. |
| **Per-scope (scope-keyed) private fields** | ⏳ **Deferred, not rejected — and it is the designated answer if the sideways residual bites.** Keying the private set by scope makes the object scope-local, so an admin reaching it is ordinary downward authority (ADR-015) and the residual disappears structurally rather than by gate. Declined for now because it adds a dimension to a field set with **no production consumers yet**, and because one person holding many scopes — the case that makes it hurt — does not exist at this population. ⚠️ Distinct from *per-scope profile copies* below: that duplicates the same value N times; this **partitions** a field set that was never meant to be one global value. |
| **Per-field roles / a permission matrix** on the private set | Two levels is the decision (see § Decision). Anyone who can read a private field can write it and write the public ones; a finer model buys nothing today and is a surface every future field has to be classified against. |

## Consequences

### Positive
- `sub → display` resolves uniformly wherever a handle is legitimately held; the hot path is gate-free (zero registry reads on read/subscribe).
- **Open-resolution ≠ enumeration** — a caller can only resolve handles the mesh actually handed them; there is no directory to crawl.

### Negative / mitigations
- The trust rests on the **public/private field split being enforced at the DO** — the pushed `value` is built from the public **allow-list**, never by subtracting known-private keys from the stored record — and on the Gateway's authN. Unguessability (ADR-010) additionally bounds enumeration; it is a crawl bound, not a confidentiality control (§ Decision, re-weighted 2026-08-20).
- **An admin of one intersecting scope reaches a global object.** Accepted above, bounded by requiring an accepted membership, and answered structurally by scope-keying if it ever bites. The mitigation that matters meanwhile is that acceptance requires mailbox proof, so the population holding this is people the person actually joined — not anyone who can guess an address.
- **The acceptance predicate is load-bearing AUTHZ, and it lives in a query rather than a gate** — a place nobody expects to find a security control. It must be pinned by a test that reds when it is dropped — the manufacture test in `packages/nebula-auth/test/identity-mint-point.test.ts`; acceptance lives on its own `Memberships.acceptedAt` column and the predicate is its `IS NOT NULL` inside `getScopesForProfile`.
- A future *protected-class public field* would need its own gate — the open read is public-fields-**only** by construction, not a blanket "the Profile DO is open."
