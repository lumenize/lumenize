# Profile DO — conform to the accepted-membership gate

**Status:** STUB, created 2026-08-05 by splitting [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md), where this rode along for historical reasons only. **Next up after that file.** The security half already landed in code; what remains is Profile-DO conformance and re-pointing tests written for a design that was reversed.

**Objective — the Profile DO matches what [ADR-012](../docs/adr/012-global-profile-visibility.md) now says**, and no test still asserts the design it replaced.

## Context and current state

**Landed 2026-08-04, independently of any task file:** `getScopesForProfile` counts only **accepted** memberships (`Memberships.acceptedAt IS NOT NULL`), pinned by a capable-of-failing manufacture test in `packages/nebula-auth/test/identity-authority.test.ts`. That closes the hole; this file is the rest.

**The rule, so the phases have a contract to conform to.** Admins curating a member's private fields is a wanted capability, so the Profile's scoped-admin branch **stays** — what makes it safe is that only an accepted membership counts. `#requireOwnerOrAdmin` ([profile.ts](../packages/nebula-auth/src/profile.ts)) passes when `scopes.some(s => matchAccess(pattern, s))` over `getScopesForProfile(profileId)`. Ungated, that authority is **manufacturable**: claim a Universe (unauthenticated, Turnstile only) → invite any address you can guess → you now administer a scope that stranger's profile touches. Acceptance closes it because the marker is written only by the login verify path, reachable solely by consuming a link delivered to the address. ADR-012 carries the full reasoning and the two accepted residuals — read it rather than this summary.

⚠️ **The stakes rose with the identity split.** A `profileId` is now a property of the **address**, spanning every scope, so inviting a known address hands the invitee that person's **real** `profileId`. Inviting an address is inviting a person.

⚠️ **Impersonation still reaches these fields, by design.** The **owner** branch requires `!claims.act`, so a narrower token is never the owner ([archive/nebula-mint-narrower-token.md](archive/nebula-mint-narrower-token.md)). But an admin impersonating someone who holds an accepted membership in a covered scope reaches the private fields through the **scoped-admin** branch, under their own authority. That follows from impersonation meaning what it says; the owner-branch clause does not close it.

**Missing — re-derived against disk 2026-08-05, and it is LESS than this file first claimed.** The identity-data-model build landed the test half in commit `d3ed807`, after the inventory this file was drafted from. Already done, do not rebuild:

- ✅ **The retired-target skip is replaced, not un-skipped.** `it.skip('SCOPED-admin covering the profile scope is REFUSED — owner + super-admin ONLY')` is gone from `apps/nebula/test/test-apps/baseline/profile-do.test.ts`, and a comment at the site records that it encoded a reversed model.
- ✅ **Both arms of the real contract exist** — *"SCOPED-admin over a scope the profile ACCEPTED is permitted"* and *"…NEVER ACCEPTED is refused — the manufactured shape"*, the second carrying the mutation note for the `emailVerified` swap.
- ✅ **A `/live` counterpart exists** — `harness/scenarios/profile-takeover-refused.ts`, cross-linked to the in-lane arm with a note on what each is blind to.

**What actually remains:** the private-by-default derivation, the super-admin short-circuit assertion, the impersonation re-point, and one stale comment (§ *Known defect* below).

## Known defect — a stale comment above the new tests

`profile-do.test.ts` carries, immediately above the replacement pair, two leftover lines from the retired design: *"⏳ SKIPPED — this asserts ADR-012's committed TARGET, which the code has not reached yet. ADR-012 retires the scoped-admin branch…"*. Both halves are false — the tests are not skipped, and ADR-012 **keeps** the branch — and they sit directly above a comment that says the opposite. `testing.md` § *stale prose is worse than no test* is explicit that a future reader takes such prose as settled intent. Delete the two lines.

## Acceptance criteria — input to a phases pass, not yet decomposed

- **A new private field is private without being named.** The public set is the `PUBLIC_FIELDS` allow-list and the pushed snapshot is built **from** it, never by subtracting known-private keys — so add a field appearing in neither list and assert it never rides `read()`/`subscribe()` and is refused to a non-qualifying caller. *Reds against a snapshot built by subtraction.* (`privateNotes` is the first private field, not the last; generalize the `read/writePrivateNotes` signatures when a second actually arrives.)
- **Super-admin (`pattern === '*'`) still short-circuits before any registry read** → platform moderation is unaffected, and the registry read stays reserved for the branch that needs it.
- **The impersonation assertion says which branch could still admit an admin.** `profile-do.test.ts`'s *"a NARROWER token is NOT the owner — the admin driving it can neither write nor read privateNotes"* passes today and will keep passing, but for a reason that no longer holds once the reader knows the branch survives. State that the admin is refused **as owner**, and name the branch that could still admit them under their own authority.
- **No prose in that file still describes the retired design** — the § *Known defect* comment is gone, and a `grep -n 'retires the scoped-admin\|owner + super-admin ONLY' apps/nebula/test` returns nothing.
- **Cost, stated:** the Profile DO keeps its one registry read and the fail-closed complexity around it, so the write path is not gate-free like the read path. The reverse lookup that read needs is `idx_Emails_profileId`, already in the schema.

## Relationships

- **Modifies shipped code** — touches [archive/nebula-profile-store.md](archive/nebula-profile-store.md) Phases 1–3 and replaces some of its tests.
- ⚠️ **Invalidates a premise in the collapse task.** [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) § *Preserved — Nebula gets its own `Profile`* argues that write-authz needs no special-casing because *"everyone else is cleanly denied (the scoped-admin branch's Registry miss **fails closed** to `Forbidden`, not a 500)"*. The conclusion survives, but its stated mechanism assumed the branch was being removed. Update that bullet when this lands.
- **Independent of** [nebula-auth-identity-mint.md](nebula-auth-identity-mint.md) — it is in `profile.ts`, not on the invite path. Sequenced after it by preference, not dependency.
- **One shared site with** [nebula-reach-from-scope.md](nebula-reach-from-scope.md) — `#requireOwnerOrAdmin`'s `scopes.some(s => matchAccess(pattern, s))` becomes the new reach predicate there. The acceptance contract this file owns is unaffected, so write the criteria over acceptance semantics and they survive either model.
- **Constrained by** [ADR-012](../docs/adr/012-global-profile-visibility.md) and [ADR-013](../docs/adr/013-identity-profileid-resolution.md).
