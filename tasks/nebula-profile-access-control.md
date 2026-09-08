# Profile access control — the same door as everything else

**Status:** DRAFT 2026-09-08, Pass 1 awaiting Larry's read. Gates ② personas; gated by nothing; `deploy`-gated, since nothing here changes storage. Pinned 2026-09-07/08 (Larry): personas ride `impersonate()`, and no `synthetic` column lands.

**Objective — an impersonation token is the person it names at the Profile exactly as it is everywhere else, because acceptance is enforced where the token is born.**

**Three goals, in the order they matter:**

1. **An admin impersonating someone has exactly that person's access to their own Profile.** Today an impersonation token is refused as the owner outright, because the owner branch requires the `act` chain to be absent. Nebula-the-agent is untouched either way: it never rides a token, only the attribution record ([auth.md](../docs/vision/auth.md) § *When Nebula is the actor*).
2. **The bad actor's path stays closed, at the mint.** Today the narrower-token mint issues a token over a membership nobody accepted. After: it refuses, so no token carrying a person's `profileId` exists unless that person took the membership up.
3. **The mint's decision is explicit, and a test can tell it from every other refusal.** The acceptance conjunct sits in the mint handler beside the dominion check, and the Registry read it rests on returns the acceptance flag, so the decision cannot be made without seeing it. [ADR-012](../docs/adr/012-global-profile-visibility.md) already argues that only a taken-up membership confers authority; this extends that from the Profile's admin branch to the token's birth.

## Relationships

- **② personas** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *② Personas*) waits on these three goals and on nothing else here. Each persona is a real account that accepts like anyone and is then impersonated; goal 1 is what lets it own its profile. Provisioning is ②'s.
- **④ every Resources guard lives in the plane** ([nebula-data-plane-owns-its-guards.md](nebula-data-plane-owns-its-guards.md) § *The Profile — the first host whose guard is not a grant*) takes the Profile's move onto the Resources plane, with the facts this design settled for it. The Profile's storage does not change here, which is why this file is `deploy`-gated and ④ carries the `data`-gated change. Until ④ lands, an impersonated profile write records nobody; both precede the one deploy, so no user meets that gap.
- **Amends [ADR-012](../docs/adr/012-global-profile-visibility.md).** Every passage resting on `!claims.act` goes — the § *Decision* code block, the *A narrower token is not the owner* paragraph that argues for it, the *licensed class is global objects* sentence `security.md` already retired, the ⚠️ saying the clause guards the owner branch only, and the § *Context* cross-reference to ADR-013. The retired clause joins its Alternatives table with the reason below. The acceptance predicate on the scoped-admin branch is untouched, and § *Consequences* keeps its requirement that a test reds when that predicate is dropped.
- **Amends [ADR-013](../docs/adr/013-identity-profileid-resolution.md) and [auth.md](../docs/vision/auth.md).** ADR-013 loses its two sentences saying the `act` pair's presence is what ADR-012 tests, and gains nothing: where a membership is inert until accepted belongs in ADR-012, which already argues acceptance, not in the ADR about what may key on a `profileId`. `auth.md` is `accepted`, and three passages change: § *Profiles*' owner sentence, § *Impersonation*'s *the one case today is profile ownership*, and its *`act` means impersonation and nothing else*, which is re-derived on attribution rather than deleted (§ *Design intent*).
- **Amends the rules.** `security.md` rule (1) keeps its one test and its worked case moves to `router.ts`'s `forwardWithSubject`; rule (2) gains the acceptance conjunct. `workflow.md`'s ADR-012 one-liner follows. Both ADR headers read Accepted and neither has been read through in place; ratification of every ADR is deferred past launch (master plan § *ADR hand-review*), so amending them is an ordinary edit.

## Context and current state

Today, the most consequential place in the system where an `act` chain is taken into account for a permission decision is when deciding who can edit the public fields and access the private fields of a Profile. Two smaller ones stay as they are: the scope-summary route refuses an impersonation token, because the list it answers is every tenancy the subject holds, and the mint refuses to narrow a token that already carries `act`. Everywhere else, we only consider the principal `sub`; `act` chains only serve as a record of the impersonator or agent acting on their behalf. Months ago, when we added Profiles, we were forced to temporarily add an `!act` clause to the gate for Profile because it was possible for a bad actor to gain permissions they should not have using steps like these:

1. A bad actor uses self-signup for a Universe
2. They create a Galaxy
3. They invite a target user's email to be a collaborator in the Galaxy
4. Even before the target user accepts the invitation, the bad actor can now access private fields and modify all fields of the target user's Profile

However, since 2026-08-04 we required that all invites be accepted before they are considered "active" — for login, and for the Profile's own scoped-admin branch. The invitee is told not to accept unless they know the inviter and the purpose of the invitation. One site still treats an unaccepted membership as live: the narrower-token mint behind `impersonate()`, which reads the membership but never asks whether it was accepted, so the bad actor above can still mint a token that carries the target's `profileId`. Making that mint refuse a subject whose membership is not accepted closes the last door. Then an `act`-bearing token can only ever exist over a membership the person accepted, and the gating for Profile can match the rest of the system by only keying off of the `sub` claim.

Where the Profile keeps its data — a key-value table with last-writer-wins, no history and no record of who wrote — is ④'s to change. The rest of this file gives the code each part lands in, the contract the phases must meet, and the alternatives it rejected.

**Built already, and what becomes of each part:**

- **`#requireOwnerOrAdmin` in `packages/nebula-auth/src/profile.ts`** gates the public write and the private read and write through four branches: the owner, the token's `profileId` being this profile with no `act`; a bare `scopeAdmin` test that rejects a non-admin with no read; the platform root; and the scoped admin, which makes the guard's one registry read, `lookupProfileScopes`, and asks `hasDominionOver` of each scope the person accepted. **Adapted:** the owner branch becomes `claims.profileId === profileId` and nothing else changes. The class stays in `nebula-auth` with its raw registry read; ④ decides its move.
- **The narrower-token mint, `mintNarrowerToken` in `worker-token.ts`,** issues `sub`, `authScope` and `scopeAdmin` as the subject's, the caller in `act`, the subject's `profileId` on the token, and refuses a subject the caller does not administer through `canMintFor`. A subject that does not exist and one the caller may not act for get the same 403, and the comment at that refusal says why the order is a disclosure decision. **Adapted:** after that check succeeds it refuses a subject whose membership is not accepted, with a 403 that names acceptance. The collapsed 403 stays exactly as it is.
- **`getIdentityScope` in `nebula-auth-registry.ts`** resolves a `sub` to its scope, admin bit and `profileId`, and it is the mint's only membership read. Its other callers exist to run the login and consent flows, and the consent screen's name prefill reads a membership that is pending by definition, so none of them may be filtered. **Adapted:** it returns `accepted` as a required field, and the mint is the one caller that refuses on it. **Carried over:** `getScopesForProfile`, which already counts accepted memberships only, and every other caller, unchanged in behaviour.
- **The two other `act`-presence sites** — `forwardWithSubject` in `router.ts`, which refuses the scope-summary and expand-scope views under impersonation, and the mint's root-identity gate. **Carried over unchanged.** The first becomes rule (1)'s worked case.
- **Comments that cite the owner guard as their reason** — `prependActor`'s *never a token* warning and the conditional `profileId` spread beside it in `access-claims.ts`, and the self-narrow refusal in `worker-token.ts`. **Adapted:** each is re-derived on attribution (§ *Design intent*), none is deleted.
- **`apps/nebula/src/impersonation.ts`** treats every 4xx from the mint as terminal by status, and matches `/root identity/i` on the description for one purpose only: to log that a refusal which should be unreachable after a successful first mint means the mint path is broken. **Carried over unchanged.** The acceptance refusal is an ordinary terminal 403, and its `error_description` already reaches the caller verbatim; how a persona tab renders it is ②'s.
- **Tests that pin today's refusal.** `profile-do.test.ts`'s *a NARROWER token is NOT the owner* inverts; its owner-zero-reads, scoped-admin-one-read and manufactured-membership tests carry over unchanged. **No in-lane fixture impersonates an unaccepted subject today** — `createSubject` invites, clicks the link and calls `acceptMembershipVia`, and `createInvitedClient` accepts again through `browserLogin` — so the mint refusal has no existing negative to invert. **Missing:** a helper that invites without the accept, which is the fixture every criterion for goal 2 rests on. `identity-mint-point.test.ts`'s manufacture test carries over. The live `profile-takeover-refused` scenario gains the mint limb; `impersonation-lifecycle` and `impersonation-expiry` accept their subjects already and carry over unchanged.

## Design intent, constraints, and future state

**The contract, in three parts.**

- **(a) The mint refuses an unaccepted subject, after dominion and with its own message.** The order inside `mintNarrowerToken` becomes: the root-identity gate, the self-narrow refusal, the dominion check with its collapsed 403 unchanged, then `403 forbidden — the subject has not accepted their membership`, then the `aud` validation. The new refusal tells the caller a fact they are entitled to: they hold dominion over the subject's scope, and who has and has not taken up a membership in a scope is that scope's admin's ordinary knowledge under [ADR-008](../docs/adr/008-full-org-tree-visibility.md)'s visibility principle. The not-found collapse is untouched, so the route is no more of an existence oracle than today.
- **(b) The owner branch is `claims.profileId === profileId`.** What makes that safe is (a). An `act`-bearing token exists only over a membership the person accepted; acceptance needs the mailbox and an explicit act behind the consent modal (ADR-012 § *Decision*); so an admin impersonating someone arrives at exactly the profiles that admin already reaches by dominion, and the token is that person there as everywhere else.
- **(c) `security.md` rule (2) gains the conjunct; rule (1) keeps its one test.** A read-side `act`-presence check is still legitimate only where impersonation would otherwise grant the actor something they could not already do, and `forwardWithSubject` is the worked case: it withholds the subject's tenancy list, which spans scopes the admin may not reach.

**`act` on an access token still means impersonation and nothing else, and after this task two live refusals are what hold it there.** Today `auth.md` grounds the invariant on the owner branch: prepend an actor into a session's token and the person loses their own profile. That ground goes with the clause, and the record cannot replace it, because the record legitimately carries a non-impersonation actor — `agent:nebula`, prepended server-side on every turn Nebula writes. What remains is authorization. A token carrying `act` is refused the tenancy summary at `forwardWithSubject`, and refused re-narrowing at the mint's root gate. Prepend an actor into someone's own session token and they lose both, for a reason nobody intended. `prependActor` therefore stays record-only, and its JSDoc says so on those two grounds.

**Every load-bearing assumption, stated so review can falsify it:**

- The mint's only membership read is `getIdentityScope`, and the mint is the only caller that may refuse on acceptance. (`worker-token.ts` reaches it at the mint and through `profileForSub`, whose two callers are the accept handler — which runs after the flip — and the consent screen's name prefill, which by definition reads a pending membership.)
- A filtered read would break the consent flow. (`handleAcceptMembership` resolves its cookie through `getRefreshRecord` *because* the session is unaccepted; its comment says so.)
- The accept endpoint is credentialed by the membership's own path-scoped refresh cookie, placed by consuming the link. (`worker-token.ts`'s accept handler.)
- Every helper that produces a subject accepts its membership: `createSubject` ends with `acceptMembershipVia`, `browserLogin` calls it too, and `provisionStarAdmin`, `provisionAndLogin` and `acceptInviteAndLogin` each call `acceptMembership`. (`apps/nebula/test/test-helpers.ts`, `apps/nebula/test/lib/email-login.ts`.)
- `#buildActingToken` reads the token's `act` into the record. (`resources.ts`, the one call to `projectActingToken`.)
- `impersonation.ts` classifies a mint failure by matching `error_description`, so a new refusal message needs a class or lands in the generic bucket.

**Constraints.** [ADR-012](../docs/adr/012-global-profile-visibility.md) binds the open read, the two capability levels and the acceptance predicate on the scoped-admin branch, which this task keeps. [ADR-013](../docs/adr/013-identity-profileid-resolution.md): the owner check reads the JWT's `profileId` claim and nothing keys on it. [ADR-015](../docs/adr/015-passage-and-dominion.md)'s `hasDominionOver` stays the only scope verdict, and `canMintFor` stays the only place it is asked at the mint. `security.md` rules (1) and (2) as amended above. ADR-012 § *Consequences* requires the acceptance predicate to be pinned by a test that reds when it is dropped — `identity-mint-point.test.ts` and `profile-do.test.ts` carry that today, and the mint's conjunct owes one of its own. `live.md` makes the scenario the default tier, matching the refusal's message rather than its boolean.

**Future state.** ② provisions personas as real accounts, accepts them and impersonates them; each persona then owns its profile through goal 1. ⚠️ Design consideration: any future `act`-bearing token path — the consent-delegated support session in [backlog.md](backlog.md) § *Nebula* first — inherits ownership of the subject's profile, `privateNotes` included; its consent text must say so. ⚠️ Design consideration, for ②: one address is one Profile across every app (ADR-013), so a persona address shared by two user-developers' apps would share one Profile; ② mints each persona an address unique to its Galaxy.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| Acceptance is enforced at the mint, after the dominion check, with a refusal that names acceptance. | **An acceptance arm on the owner branch** — the same fact checked at one branch instead of at the token's birth, so one `act`-presence exception stays alive and every future guard has to ask the same question. **A collapsed 403** — indistinguishable from not-found, so no test could tell the acceptance refusal from the dominion one, to hide a fact a dominion holder is entitled to anyway. |
| The mint's Registry read carries `accepted`, and the mint decides. | **An active-only read for the mint** — a pending subject would vanish into the not-found collapse, which is the untestable shape above. **A Registry-wide active-by-default convention** — the Registry has about two dozen per-site `Memberships` selects and no choke point, so a naming convention is enforced by nothing; the explicit conjunct plus a test is. |
| Personas ride impersonation over a membership they accepted like anyone, which is why goal 1 is worth its amendments. | **Per-persona cookies** — a real login per persona; the refresh cookie is one fixed name per scope path, so two personas in one scope overwrite each other. **Synthetic sessions** — a mint variant with no `act`, which is a second mint form in rule (2). **A `synthetic` column** licensing a membership created already accepted — a second door beside the mailbox one, and the daily digest that would have read it can filter on `act` naming the owner instead. |
| ADR-013 records that a membership is inert until accepted. | **The sentence as the enforcement** — a commitment nobody's code checks, which is how the mint's read went unfiltered; here the tested conjunct is the enforcement and the sentence is the record. |
| The Profile's storage is untouched here; composing the plane is ④'s. | **Composing it here** — the plane's guards are DAG-backed at five sites, so putting a non-DAG host on it changes the plane's guard model, which is ④'s subject. Two files would then decide one thing. ④ § *The Profile — the first host whose guard is not a grant* carries the mechanism. |
| No hand-written acting-principal stamp on profile writes meanwhile. | **A last-writer field in the fields table** — an interim ④ deletes, paid for twice. |

## Phases

**1. The mint refuses a subject who has not accepted.** `getIdentityScope` returns `accepted` beside the scope, bit and `profileId`, read from its existing `Memberships` join. `mintNarrowerToken` refuses on it after the collapsed dominion 403 and before the `aud` validation, with a message naming acceptance. A new `inviteWithoutAccepting` helper in `test-helpers.ts` invites and stops, which is `createSubject` minus its magic-link click and its `acceptMembershipVia` call.

- **Success criteria (capable of failing):**
  - An in-lane test impersonates a subject produced by `inviteWithoutAccepting` and is refused with a message matching `/accepted/i`; the same subject, after `acceptMembershipVia`, is impersonated successfully. Both arms, in that order, in one test.
  - The refusal is told apart from its neighbours: a subject the caller does not administer still gets `does not administer this subject`, and a `sub` that does not exist still gets that same message. Three distinct assertions on one route.
  - The consent flow stays green, which is what proves the read was widened rather than filtered: `npx vitest run mint-all-and-acceptance identity-mint-point mint-narrower-token` in `packages/nebula-auth` (three real files, checked 2026-09-08).
  - `sed -n '/getIdentityScope(sub/,/^  }/p' packages/nebula-auth/src/nebula-auth-registry.ts | grep -c acceptedAt` prints a non-zero count; it prints `0` today.
- **Mutation note:** delete the acceptance conjunct in `mintNarrowerToken` → the unaccepted arm mints and the first criterion reds. Separately, change the new 403's message to the dominion one → the second criterion reds. Widen `getIdentityScope`'s new field to a constant `true` → the first criterion reds without touching the mint.
- ⚠️ The typed cast at the mint's call site names the three fields it expects; adding a fourth to the Registry method without widening that cast compiles and silently reads `undefined`, which is falsy and would refuse everyone. The criterion that catches it is the accepted-subject arm.

**2. The Profile's owner branch drops its `act` clause.** Branch (1) of `#requireOwnerOrAdmin` becomes `claims?.profileId && claims.profileId === profileId`. Its four-paragraph comment block goes with it, and the three comments elsewhere that cite the owner guard as their reason are re-derived on the two refusals that survive: `prependActor`'s *never a token* warning, the conditional `profileId` spread beside it, and the self-narrow refusal in `worker-token.ts`.

- **Success criteria (capable of failing):**
  - `profile-do.test.ts`'s *a NARROWER token is NOT the owner* inverts into *a narrower token IS the owner*: the impersonating client writes the public fields and reads `privateNotes`, with the existing real-cookie owner control kept beside it.
  - The scoped-admin path is untouched: the owner-zero-reads, scoped-admin-one-read, manufactured-membership and fail-closed tests stay green, unedited.
  - `grep -rnE 'claims\??\.act\b' packages/nebula-auth/src/profile.ts` returns nothing; it returns five lines today.
  - `grep -rnE 'claims\??\.act\b' packages/nebula-auth/src apps/nebula/src` returns exactly six lines — three in `access-claims.ts` (two comments and the projection that copies the chain), `router.ts`'s `forwardWithSubject`, `worker-token.ts`'s self-narrow comment, and `impersonation.ts`'s pre-flight mirror. Eleven today. ⚠️ The `?` in the pattern is load-bearing: `impersonation.ts` writes `claims?.act`, so a pattern without it silently drops that site.
- **Mutation note:** restore `&& !claims.act` → the inverted test reds. Delete the owner branch entirely → the inverted test and the zero-reads test both red, which is what distinguishes the change from a deletion.

**3. The live scenario grows the mint limb.** `profile-takeover-refused.ts` already drives a real invite the victim never accepted, and then a real acceptance. The attacker holds dominion over the universe they claimed, so the same unaccepted membership is a mint subject: the limb attempts `impersonate` on it before the accept and after.

- **Success criteria (capable of failing):**
  - Before the accept, the attacker's `impersonate` on the victim's `sub` in the attacker's universe is refused, and the refusal's message names acceptance rather than dominion.
  - After the accept, the same call succeeds, which is the positive control that keeps the refusal meaning *unaccepted* rather than *broken*.
  - `npx tsx apps/nebula/harness/drive.ts profile-takeover-refused` exits zero, and the sweep `drive.ts all --fast` stays green.
- **Mutation note:** delete the mint conjunct → the first limb greens and the scenario reds. ⚠️ Mutation-check this limb on its own: the scenario's first limbs already red under that same mutation for a different reason, so a whole-scenario red proves nothing about this one.

**4. Standing guidance, last because the phases above are what it describes.** ADR-012 loses every passage resting on `!claims.act` and gains the retired clause in its Alternatives table, keeping the acceptance predicate and its test requirement. ADR-013 loses its two sentences about the `act` pair's presence. `auth.md` § *Profiles*, § *Impersonation*'s *one case today*, and its *act means impersonation* passage are rewritten per § *Design intent*. `security.md` rule (1) keeps its one test with `forwardWithSubject` as the worked case; rule (2) gains the acceptance conjunct. `workflow.md`'s ADR-012 one-liner follows.

- **Success criteria (capable of failing), each run against the tree on 2026-09-08 and reported with what it prints TODAY:**
  - `grep -rnE 'claims\??\.act' docs/adr/012-global-profile-visibility.md` returns nothing, and its Alternatives table gains a row naming the retired clause. Three hits today.
  - `grep -rnE 'no impersonation chain|one case today is profile ownership' docs/vision/auth.md` returns nothing. Two hits today, at § *Profiles* and § *Impersonation*.
  - `grep -n 'forwardWithSubject' .claude/rules/security.md` returns a hit; it returns nothing today, which is why rule (1) would otherwise be left naming a worked case this task deletes.
  - `node scripts/check-prose.mjs` passes on every file touched. It passes today, so this one is a regression guard rather than a gate.
- ⚠️ Rule (1)'s reader list is stated structurally rather than as a count, so removing one member does not falsify it. Do not convert it to a tally while editing.

## Non-goals

- **The Profile's storage, history and acting-principal record** — ④ § *The Profile — the first host whose guard is not a grant*, which carries the injected-authorizer design and the facts this file settled for it.
- **Persona provisioning, the tab UI, and how a refused mint is rendered** — ② personas.
- **Retiring `createNebulaTestToken` from the profile lane** — [backlog.md](backlog.md) § *Immediate work backlog*; the fixtures this task touches keep the rung they have.
- **Renaming `/mint-narrower-token`** — [backlog.md](backlog.md) § *Nebula Auth*, unchanged by this work.
- **Scope-keyed private fields** — ADR-012's deferred structural answer; ④ keeps the type able to become one resource per scope.

## Relationships — completed

- **Supersedes** the 2026-09-07 owner-branch design recorded in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *② Personas*; that bullet's own 2026-09-08 refinement is the live one.
- **Invalidates two backlog rows' premises.** § *Nebula Auth*'s SELF-NARROWING row argues from `!claims.act` in the Profile guard, which goal 1 removes — its self-narrow-mints-no-`act` conclusion survives on attribution and on the mint's root gate, so the row is re-grounded rather than closed. The *LLM-writes-the-blob* row loses its blocker: an agent acting as the owner can reach `privateNotes` once goal 1 lands.
- **Un-skip obligations:** none. No `it.skip` in either package names acceptance at the mint.
- **Hands ④** the four facts this design settled and the two open questions on the stored dominion bit and the per-push recheck.
