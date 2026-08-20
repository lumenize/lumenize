# Profile DO — conform to the accepted-membership gate

**Status:** small task, next after [nebula-invite.md](nebula-invite.md) (now in `/build-task`). Created 2026-08-05; re-scoped against code 2026-08-19 — one missing test, one stale-prose sweep, one cross-file correction.

**Objective — the Profile DO matches [ADR-012](../docs/adr/012-global-profile-visibility.md) (Accepted) with nothing left describing the design it replaced**, in test prose or in sibling task files.

## The contract — conform to it, don't rebuild it

Admins curating a member's private fields is a wanted capability, so the Profile's scoped-admin branch **stays** — what makes it safe is that only an **accepted** membership counts. `#requireOwnerOrAdmin` ([profile.ts](../packages/nebula-auth/src/profile.ts)) passes when `scopes.some(s => hasDominionOver(claims.access, s))` over `getScopesForProfile(profileId)`, and `getScopesForProfile` counts only `Memberships.acceptedAt IS NOT NULL` — pinned registry-side by the manufacture test in [identity-mint-point.test.ts](../packages/nebula-auth/test/identity-mint-point.test.ts) and behaviour-side by [profile-do.test.ts](../apps/nebula/test/test-apps/baseline/profile-do.test.ts)'s never-accepted arm plus the `/live` scenario `profile-takeover-refused.ts`. Ungated, that authority is **manufacturable**: claim a Universe (unauthenticated, Turnstile only) → invite any address you can guess → you now administer a scope that stranger's profile touches. Acceptance closes it because the marker is written only by the login verify path, reachable solely by consuming a link delivered to the address. ADR-012 carries the full reasoning and the two accepted residuals — read it rather than this summary.

- A `profileId` is a property of the **address**, spanning every scope — so inviting a known address hands the invitee that person's **real** `profileId` ([nebula-invite.md](nebula-invite.md) § *Mint-time writes* states the same fact from the invite side, and warns that "the invite mints a distinct profile" would be asserting a bug). Inviting an address is inviting a person.
- ⚠️ **Impersonation reaches the private fields, by design.** The **owner** branch requires `!claims.act`, so a narrower token is never the owner ([archive/nebula-mint-narrower-token.md](archive/nebula-mint-narrower-token.md)). But an admin whose own dominion covers a scope the profile accepted reaches those fields through the **scoped-admin** branch regardless — impersonation means what it says; the owner-branch clause does not close it, and must not be "fixed" to (§ *Decisions*).

## Acceptance criteria (input to a phases pass, not yet decomposed)

1. **A new private field is private without being named.** The public set is the `PUBLIC_FIELDS` allow-list and the pushed snapshot is built **from** it (`#publicSnapshot`'s `field IN (…)` SELECT), never by subtracting known-private keys. No test pins that: seed a field appearing in neither list straight into `ProfileFields` (no API writes one — itself the point; `runInDurableObject` is this file's established seam) and assert it never rides `read()`/`subscribe()`. *Reds against a snapshot built by subtraction — mutate the SELECT to exclude-known-private and the test must red.*
2. **No test prose still describes a superseded model.** `profile-do.test.ts`'s narrower-token comment says *"Independent of ADR-012's pending amendment"* (ADR-012 is Accepted) and *"the mirrored `admin` bit"* (the claim is `scopeAdmin`). Fix both; instrument: `grep -n 'pending amendment\|mirrored' apps/nebula/test/test-apps/baseline/profile-do.test.ts` returns nothing (it returns one hit today, so the instrument can fail). ⚠️ Sweep by superseded CLAIMS, not by the retired test's title — the comment above the accepted/never-accepted pair deliberately quotes that title to record the reversal, so a title grep flags correct prose.
3. **The collapse file's write-authz bullet is re-worded over behaviour.** [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) § *Preserved*'s *Nebula gets its own `Profile`* bullet still authorizes via the deleted `'*'` literal, carries drifted `profile.ts` line anchors, and calls the reserved-profile denial "the scoped-admin branch's Registry miss fails closed" — the miss actually resolves to zero scopes and denies with the does-not-cover refusal; the fail-closed catch is for a registry **throw**, a different path. Its conclusion (super-admin edits it; everyone else denied) survives — restate it over behaviour so the collapse review doesn't trip on it. [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Status* sequences this task before that review for exactly this edit.
4. **Cost, stated:** the Profile DO keeps its one registry read and the fail-closed complexity around it, so the write path is not gate-free like the read path. The reverse lookup that read needs is `idx_Emails_profileId`, already in the schema.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **The scoped-admin branch stays** (ADR-012's two capability levels) | Retiring it (owner + super-admin only — the design the old skipped test encoded): admin curation of a member's private fields is a wanted capability; what makes the branch safe is the acceptance predicate, not its absence. |
| **The gate is the MEMBERSHIP's acceptance (`acceptedAt`)** | `emailVerified` — a property of the **address**: a victim who proved their mailbox in any other scope already carries it, so a manufactured, never-taken-up membership would pass. ADR-012's own tripwire; the in-lane arm's mutation note pins it. |
| **Private-by-default is DERIVED from the `PUBLIC_FIELDS` allow-list** | Subtracting known-private keys — a newly added field would ride the snapshot by omission; derived means a new field is private without anyone deciding (ADR-012). |
| **Impersonation reaching the private fields is accepted, not fenced** | An `act`-presence check on the scoped-admin branch — fails `security.md`'s default-deny test: the admin already holds the dominion, so blocking the impersonated route withholds nothing they lack. The owner branch's `!claims.act` stays the one licensed presence check (ADR-012). |
| **Scope authority resolves LIVE, at the one registry read** | A token- or storage-carried scope set — ADR-013: authz scope-sets resolve live; a stored one is a security bug. The accepted cost is criterion 4. |
| **`readPrivateNotes`/`writePrivateNotes` keep bespoke signatures** | A generic field-keyed private API now — `privateNotes` is the first private field, not the last, but no second exists; generalize when one actually arrives. |

## Relationships

- **Modifies shipped code** — touches [archive/nebula-profile-store.md](archive/nebula-profile-store.md)'s Phase-2 tests (adds one, edits comments).
- **Sequenced after** [nebula-invite.md](nebula-invite.md) by preference, not dependency — this work is in `profile.ts`, not on the invite path.
- **Owns one edit in** [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) — § *Preserved*'s *Nebula gets its own `Profile`* bullet (criterion 3).
- **Constrained by** [ADR-012](../docs/adr/012-global-profile-visibility.md) and [ADR-013](../docs/adr/013-identity-profileid-resolution.md).
