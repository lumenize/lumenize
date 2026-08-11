# The invite mechanism — per-invitee admin, and a client method

**Status:** Active child, **fourth and last** in the passage/dominion sequence — after [nebula-dominion-vocabulary-rename.md](nebula-dominion-vocabulary-rename.md), [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md) and [nebula-registry-route-guards.md](nebula-registry-route-guards.md). **Rescoped 2026-08-11: this file now owns WHO MAY INVITE**, not only what an invite carries (§ *The openness question*). `/invite` can currently issue one flat batch of non-admin memberships under an admin-only gate; this makes it say what *each* invitee gets, return the `sub` it minted, be reachable from app code, and be open to the right people. No collapse dependency.

> 📐 **`/write-task` Pass 1 — design intent is below, phases are NOT written.** From here: `/review-task` **Stage 1** on this phase-less file → resolve and edit → write phases → **Stage 2**. § *Acceptance criteria* is Pass-2 input: it says what must be true, deliberately not in what order. ⚠️ **The 2026-07-25/26 Stage-1 passes do not carry** — they reviewed a file with a different scope, a different Profile decision, and a pre-split storage layer.

> 🔄 **Rescoped twice.** (1) **2026-08-05**, reversing a pinned business decision: this file used to be *"invite a peer who becomes a Galaxy admin"*, with `collaborator = admin at the invited scope` pinned 2026-07-19. Retired — reasoning in § *Decisions*; three concerns moved out (§ *Non-goals*). (2) **2026-08-11**, in the four-way split of the passage/dominion pile: **the openness question landed here.** [nebula-registry-route-guards.md](nebula-registry-route-guards.md) places `/invite`'s guard in the route pipeline at **today's verdict** and changes no caller's outcome; **this file decides what that guard becomes.** The two files previously both reached for the rule, which is what the split was diagnosing.
>
> ✅ **The wire-field naming question is UNPARKED.** This file used to leave `invitees[].isAdmin`-vs-`Memberships.scopeAdmin` undecided because *"deciding it here would be designing this endpoint from another task's cleanup."* That cleanup is now [nebula-dominion-vocabulary-rename.md](nebula-dominion-vocabulary-rename.md) and lands **first**, so the answer is a one-line consequence rather than a cross-task negotiation — and § *Reach and authority* below no longer has to hedge it.

**Objective — `/invite` expresses what each invitee gets, returns the identity it minted, and is reachable from app code.** Today it takes `{ emails: string[] }`, hardcodes `isAdmin=false`, returns emails only, and has no client method — so no caller can say "make this one an admin," and no caller can act on the identity that was created.

## Context and current state

**Built already** — each claim re-verified against disk 2026-08-04:

- **`/invite`** → [`handleInvite`](../packages/nebula-auth/src/worker-token.ts) → [`issueInvites`](../packages/nebula-auth/src/nebula-auth-registry.ts): an admin issues invites into a scope — mints the invitee's membership, inserts a single-use hashed `InviteTokens` row, and emails an `accept-invite` link (test mode returns the raw link). Admin-over-scope is gated in `handleInvite` (`if (verifiedAccess.admin !== true) return errorResponse(403, 'forbidden', …)`), after the router's JWT verify + `matchAccess(payload.access.authScopePattern, instanceName)` → 403 `insufficient_scope` ([router.ts](../packages/nebula-auth/src/router.ts)).
- **`accept-invite`** and **magic-link** both funnel through `consumeAndLogin` — a real login per ADR-009, a bodiless 302 plus a refresh cookie — and both reach [`getAndVerifyIdentity`](../packages/nebula-auth/src/nebula-auth-registry.ts), the one place control of a mailbox is established.
- **The identity schema is split** ([archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md), built 2026-08-04): `Emails` holds the address, its `profileId` and `emailVerified`; `Memberships` holds `sub` (PK), `emailId`, scope, `isAdmin`, `acceptedAt`. [`schemas.ts`](../packages/nebula-auth/src/schemas.ts) is the authority for every write shape.
- **`setIdentityAdmin`** flips `Memberships.isAdmin` **and** converges the denormalized copy into every live KV refresh record, re-applying each record's original absolute expiry. ✅ **Checkable claim:** it has **zero production callers** today, and this task adds the first (`grep -rn 'setIdentityAdmin' packages apps --include='*.ts' | grep -v test`).
- **ADR-016 records are already routed.** [`projectActingToken`](../packages/nebula-auth/src/access-claims.ts) is exported from the package root, and `issueInvites`, `setIdentityAdmin` and `changeEmail` each take **required** verified claims and record through it. `issueInvites(universeGalaxyStarId, emails, origin, callerClaims)` and `handleInvite(request, env, instanceName, callerClaims)` both already carry the **full** verified payload.

**Missing:**

1. **`/invite` cannot say "make this one an admin", nor answer per person.** Its body is `{ emails: string[] }` (`let body: { emails?: string[] }` … `if (!Array.isArray(body.emails))`) — a flat batch with no discriminator.
2. **`issueInvites` mints `isAdmin=false`,** via a hardcoded `#mintIdentity(email, universeGalaxyStarId, /* isAdmin */ false)`.
3. **The flag alone would be a silent no-op for anyone already minted.** `#mintIdentity` is find-or-create at both levels; its membership half early-returns an existing `(emailId, scope)` row — `if (existing.length > 0) return existing[0].sub` — without touching `isAdmin`.
4. **The response discards the `sub` it just minted.** `{ invited: string[], errors, links? }` is keyed by email, so a caller who wants to *do* something with the new identity has no handle for it — and there is no other path from an address to a `sub` (`discover(email)` returns `{ universeGalaxyStarId, isAdmin }`, and a member holding no DAG grants appears nowhere in the org tree).
5. **`client.scopes` has no `invite`.** Every sibling is there (`list`, `createGalaxy`, `createDevWorkspace`, `deletePlan`, `delete`); `invite` is the lone gap, so the harness hand-builds an `Authorization` header instead ([nebula-client.ts](../apps/nebula/src/nebula-client.ts)).

## Design intent, constraints, and future state

### What this endpoint sets, and what it does not

> ✅ **The three files ahead of this one have landed by the time this builds, so the vocabulary below is the TARGET, not a translation.** A token carries the member's scope; `dominion` is `scopeAdmin ∧ scope-at-or-above` and `passage` is the boundary verdict; there is no derived pattern. ⚠️ **The tier table that used to sit here was written in the deleted grammar** — a `Minted pattern` column of `{u}.{g}.*` and `'*'` — and is gone rather than translated, because a criterion phrased over a pattern string would red on correct code.

This endpoint sets two things and only two: the **scope** (from the URL path) and the **admin bit** (per invitee entry). It never widens beyond the invited scope. **The mint invariant:** the identity lands at the **path** scope, and what is minted never exceeds the inviter's own standing there. No self-elevation, at any tier — the mechanism is uniform across tiers, so a star-, universe- or platform-tier invite each lands a membership at the scope named in the path, and the resulting token reaches exactly what the dominion rule says it should.

**Authentication happens at the Universe; a Galaxy is named in `activeScope`.** No membership row can exist at a 2-segment scope by claim — `create-galaxy` mints no identity and there is no `claim-galaxy` — so a Galaxy membership arises only from an invite.

### The openness question — THIS FILE'S SUBJECT, and it is not yet decided

🔓 **Larry, 2026-08-11: *"We want it to be more open, but combined with everything else, it's hard to know if we are opening it up the right amount or the right way."*** That is the decision this file exists to make, and it is deliberately **not** made here yet.

**Where it stands.** [`docs/vision/auth.md`](../docs/vision/auth.md) § *Grants* is `status: accepted` and already describes a target:

> Two bounds hold it there, both structural rather than checks a caller could talk past:
> - **"Their own scope" is an identity test, never a hierarchy one.** Passage answers *yes* upward, so a Star member gated on passage could invite into the Universe — the one shape this rule must never take.
> - **`scopeAdmin` is derived from the inviter's own dominion, never requested.**
>
> What is left is abuse, not escalation: a member can mail invites where they choose. That is rate-limiting and attribution.

⚠️ **Accepted does not mean calibrated.** That section fixes the *shape* of the answer — an identity test plus a derived bit — and it is a blocker to contradict. What it does not settle is the **amount**: whether every member may invite, whether an unaccepted membership may, what the abuse bound actually is in numbers, and how this composes with open Star self-signup (a **pinned** business decision — never propose an admin gate on it), F&F invites, super-admin invitability, and the collaborator design that is on-hold. ⚠️ **Its own gap blockquote says both halves are unbuilt**, so nothing in the running system has ever exercised it.

**What the panel got wrong, for the record.** A Stage-2 conformance pass framed the own-scope path as a *collision* between two task files and offered "pick one owner" — which is true about ownership and wrong about direction; it read the widening as a risk to be resolved rather than as the goal. It is the goal. The open question is calibration, not whether.

⚠️ **Do not answer this by translating the accepted prose into a guard.** The four surfaces above pull in different directions, and the reason this is its own file is that answering it needs them in one place.
### The `/invite` contract

```jsonc
// POST {NEBULA_AUTH_PREFIX}/{u}.{g}.{s}/invite   ← the SCOPE rides the PATH, never the body
{ "invitees": [
    { "email": "austen@example.com", "isAdmin": true },  // admin at this scope
    { "email": "bob@example.com" }                       // omitted → plain member
] }

// response — `sub` is what a caller needs to act on the new identity
{ "invited": [ { "email": "austen@example.com", "sub": "…", "isAdmin": true } ],
  "errors": [], "links": { } }
```

- **`emails: string[]` → `invitees: Array<{ email: string; isAdmin?: boolean }>`.** The entries are no longer emails, so the name changes with the shape. Clean break, no dual-shape alias.
- **One field is the shared invite/collaborator discriminator.** An omitted `isAdmin` keeps every plain and F&F invite a non-admin member, so the same endpoint serves both populations.
- **The flag is inert on its own.** It is parsed only *after* the router's scope-match and the admin gate pass, so it selects an outcome and never grants authority.
- **The Worker gate passes a clean typed array onward, never the raw parsed body.** `handleInvite` maps into `{ email: string; isAdmin: boolean }[]` via `entry.isAdmin === true`. `request.json()` is an unchecked cast, so this **is** the field's validation (ADR-001, validate at the boundary): `"false"`, `"0"` and `1` must never mint an admin. Validate `Array.isArray(body.invitees)` and that each entry is an object with a string `email`; a malformed entry joins the existing `errors` array rather than failing the batch.
- **`invited` carries the minted `sub`.** `#mintIdentity` already returns it and `issueInvites` already holds it. Returning it is the difference between an endpoint that *notifies* someone and one a caller can build on — see § *Future state*.
- **Defense in depth: `issueInvites` re-asserts admin-over-scope in-method.** Dropping the hardcoded `false` turns a member-minting RPC into an admin-minting one, so its safety must not rest on a single Worker line — this matches `createGalaxy`/`createStar`, which both re-check in-method. It **throws** on violation: that is an invariant breach, not the expected client error the Worker gate routes throw-free (`raw-comm.md`).

### The accepted cost of a galaxy-tier admin, stated loudly

The mechanism is uniform across tiers, so it can mint a galaxy-tier admin, and that grant is large: a `{u}.{g}` membership plus the bit is **dominion over**  **read and write of end-user data in every current *and future* Star under that Galaxy** (including production tenant Stars, which ADR-008's boundary explicitly disclaims); `create-star` and `delete-scope`; the ability to **invite further admins**; and **no way to undo it short of DB surgery**.

Per ADR-015 clause 1, restraint here is a **UI warning carrying decision-grade information, never a refusal in the authorization layer**. There is no invite affordance in `apps/nebula-studio-ui/src` yet, so **whoever builds the first one owns that warning**.

### Making super-admin invitable is deliberate

Adding a coach today needs an env-var change plus a redeploy (`NEBULA_AUTH_BOOTSTRAP_EMAIL`), and the coach loop is the conversion layer — it must not require ops. The stranger-self-join path stays closed: the bootstrap gate in `requestMagicLink` is untouched.

This is not an audit-trail improvement. The env-var path leaves a git commit *and* a deploy record; the invite path leaves an ADR-016 log line and nothing queryable. A **queryable** trail is deferred ([backlog.md](backlog.md) § Nebula Auth).

### Constraints

- **[ADR-015](../docs/adr/015-passage-and-dominion.md)** — authority flows downward only; the bare `admin` bit is never authority; restraint is a UI warning, never an authz refusal.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)** — an authority change records the acting token's full verified claims, through the one shared projection.
- **[ADR-009](../docs/adr/009-real-auth-path.md)** — assert through a real login where a criterion can.
- **ADR-001** — validate at the boundary; TypeScript types are the schema.
- **`raw-comm.md`** — expected client errors are gated Worker-side before the RPC, because custom error own-properties are dropped across raw Workers RPC.
- **Pre-alpha milestone** — no per-task deploy gate, so this file need not be independently deployable.

### Future state

- **The per-entry envelope is the extension point.** A named role later replaces the boolean (`{ email, role }`) with no second reshape of the envelope.
- **The returned `sub` is what makes an orchestrator possible.** A Nebula-side endpoint that invites a person *and* pre-stages their data-plane grants needs a handle on the identity the registry just minted; that is [nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md), and this is the field it consumes.
- **F&F invites ride the same `/invite`** ([nebula-pre-alpha.md](nebula-pre-alpha.md) § Invite-gated), flag omitted.
- ⚠️ **Design consideration:** a demote endpoint is a thin admin-gated wrapper over `setIdentityAdmin(sub, false, callerClaims)`, which already converges KV and already records its acting principal. Shape and a last-super-admin guard are pinned in [backlog.md](backlog.md) § Nebula Auth. This task must not foreclose it; it also must not build it.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| 🔄 **This file ships the MECHANISM, not a collaborator.** It makes `/invite` per-invitee and returns the `sub`; *who gets what* is a caller's decision. | **`collaborator = admin at the invited scope`** — pinned with Larry 2026-07-19, **reversed 2026-08-05**. Two reasons, and the second is the deciding one. (1) It is not the narrowest thing that works: inviting at `{u}.{g}.dev` with `isAdmin` yields an **exact-star** pattern, which reaches that Star and nothing else, needs zero grant machinery, and today holds everything a collaborator touches — strictly narrower than a Galaxy admin, who gets every tenant Star. (2) **Interims cost more than they save here.** Larry: *"I struggle with interims. They consume too big a part of my brain. I have to constantly remind myself that we'll fix it later."* A named-but-wrong collaborator would be re-read every session until it was fixed (`workflow.md` § *unlearning tax*), so the cheaper move is to ship no collaborator at all and let the real one land post-collapse. |
| The admin flag rides **per invitee entry** | One flag per call — silently elevates everyone in a batch sent for one person. |
| Scope rides the **URL path** | In the body — it would need re-verifying against the JWT, and two scopes can disagree. The path is what the router already matched, so there is only one scope and it cannot diverge from the verified one. |
| **Works at every tier**, no tier check | Restricting to one tier — a point solution. The mint invariant is uniform across tiers, and so is reach. |
| Promotion is **promote-only** | Demoting on an `isAdmin:false` re-invite — a plain or F&F invite must never strip someone's existing admin. |
| **The response returns the minted `sub`** | Keeping the response email-keyed. There is no other address→`sub` path (`discover` returns no `sub`; a grant-less member is absent from the org tree), so discarding it forces every future caller to invent a lookup. |
| **No revocation path here** — an accepted gap, bounded to mis-grants rather than escalation, since an inviter can never grant beyond their own reach | Building a demote endpoint. It is a thin wrapper over machinery that already exists → backlog. |
| `handleInvite` and `issueInvites` take the **full verified payload** | Narrowing to `access` at the Worker edge — ADR-016 needs the `act` chain, and a `sub`-only record names the person acted *upon* as the person who acted. |
| `#mintIdentity`'s `profileId` behaviour is **untouched** — thread `isAdmin` through its four callers and change nothing else | Joining a human's profiles here. That moved to the identity data model, which then **dissolved** the join: one address holds one row holding one id. |
| `InviteTokens` keeps the **bare address**, never an `emailId` | Keying it on `emailId` — resolving by address is what makes a stale invite fail **closed** after an address change; an `emailId` never goes stale, so the link would still mint a full session as the person's *current* identity. The DDL carries this warning at the site. |
| `client.scopes.invite` lands **with this task**, which is what defines its signature | Building it earlier — the body and response both change here, so a method written first would be written against a contract this task immediately rewrites. |

## Mint-time writes, by case

The cases are distinguished by **whether the address is already known**, and the only per-invitee variation is the admin bit. `profileId` is a property of the address, so it is minted once per person and reused by every later membership.

| | **A. Address new to Nebula** | **B. Already at THIS scope** | **C. Address known, new to this scope** |
|---|---|---|---|
| `Emails` | **INSERT** — new `emailId`, fresh `profileId`, `emailVerified=0` (3 row-writes: row + `email UNIQUE` + `idx_Emails_profileId`) | nothing | nothing — the row exists, so the person **keeps their existing `profileId`** |
| `Memberships` | **INSERT** — new `sub`, `isAdmin`←flag, `acceptedAt=NULL` (2 row-writes: row + `UNIQUE(emailId,scope)`) | nothing — early-return; `sub` preserved, **`isAdmin` untouched** | **INSERT** — new `sub`, `isAdmin`←flag, `acceptedAt=NULL` (2 row-writes) |
| Promote (`setIdentityAdmin`) | not needed | **`UPDATE Memberships SET isAdmin=1`** + one KV `put` per live refresh token | not needed |
| `InviteTokens` | **INSERT** — holds the **bare address**, never an `emailId` | same | same |

**Only B needs the promote step,** and it is the only case that touches KV at issue time — at a cost that scales with the invitee's live sessions (3 devices = 3 puts).

⚠️ **C hands the invitee the real person's `profileId`**, since an address owns its id across every scope. Nothing here needs changing for that — the ADR-012 acceptance predicate is what bounds it — but a criterion written as "the invite mints a distinct profile" would be asserting a bug.

**On accept:** `consumeInvite` deletes the `InviteTokens` row (single-use), calls `getAndVerifyIdentity`, inserts a `RefreshTokenIndex` row, and writes KV `refresh:{tokenHash}`. `getAndVerifyIdentity` flips `Emails.emailVerified` (proof of the mailbox, global to the address) and `Memberships.acceptedAt` (this membership taken up), each guarded on the value it changes from.

## Acceptance criteria — input to Pass 2, not yet decomposed into phases

⚠️ Grouped by surface, deliberately not ordered. Pass 2 homes each group in a phase; nothing here is built from this section directly (`/build-task` transcribes phases, not floating criteria).

### A — the per-invitee mint (auth)

- **Assert the PERSISTED bit, never the `/invite` 200**, which is identical for `true` and `false`: (i) a net-new `isAdmin:true` yields `getIdentityScope(sub).isAdmin === true`, or stronger, drive accept→refresh and assert `access.admin` in the JWT (ADR-009); (ii) **re-inviting an existing `isAdmin=0` member with `isAdmin:true` yields an accepted JWT carrying `access.admin`** — *reds against the membership early-return*; (iii) an omitted flag, an explicit `isAdmin:false`, and a wrong-typed `isAdmin:"false"` each leave `isAdmin=0`.
- **A mixed batch** — one call with `[{a, isAdmin:true}, {b}]` mints `a` admin and `b` not. *Reds against a batch-level flag.*
- **Tier coverage** — a star-tier, a universe-tier and a platform-tier invite each land a membership **at the scope named in the path**, and the resulting token has dominion over exactly what the rule says it should. ⚠️ **Phrase this over the membership and the OBSERVED verdict, never over a pattern string** — [nebula-passage-dominion-from-scope.md](nebula-passage-dominion-from-scope.md) deletes the pattern before this builds, so a criterion asserting `{u}.{g}.*` would red on correct code.
- **The response carries a usable `sub`** — take the `sub` from an invite response and resolve it with `getIdentityScope`, or stronger, drive that person's accept→refresh and assert the JWT's `sub` matches. *Reds against a response that returns emails only.*
- 🔒 **A non-admin at the SAME scope may invite — a non-admin peer, and only that.** ⚠️ **Inverted 2026-08-11**: this criterion previously asserted that caller was *refused*, which is now exactly backwards and would have enforced the model [`docs/vision/auth.md`](../docs/vision/auth.md) § *Grants* retired. Assert both limbs, because the permission and its bound fail independently: they succeed in minting a member, **and** the minted membership carries `scopeAdmin` false however the request asks for it. *Reds against gating the endpoint on the bit alone, and against honouring a caller-supplied admin flag.*
- **Negatives, split so each is independently mutation-capable** (two disjoint gates, both 403 — assert the *body*): **(a)** a non-admin at a **different** scope than the path's is refused, body `forbidden` — *delete that line and it reds*. ⚠️ Same-scope is now the permitted case above, so this limb must be written over a scope the caller is **not** a member of, or it tests nothing; **(b)** an admin whose pattern does **not** cover the target — a *sibling* galaxy under a galaxy-scoped admin, **not** a Universe `{u}.*` admin — is refused by the router's `matchAccess` check, body `insufficient_scope` — *relax it and it reds*.
- **ADR-016 records survive the reshape.** The projection already exists and every authority-moving registry method already routes through it, so what this owes is narrow and easy to lose while changing signatures: keep threading the real caller claims through `handleInvite` → `issueInvites`, and add a record to any new authority-moving site the work introduces. ⚠️ **A required parameter only guarantees the claims are *passed*** — deleting the `actingToken` field from a record type-checks cleanly — so the criterion is the assertion, not the signature. `identity-authority.test.ts` § *an authority change records the ACTING TOKEN* already reds on that mutation for `issueInvites`; extend it if a site is added. **Never hand-assemble a second projection** — that divergence is what ADR-016 calls unrecoverable history.
- **Call-site note (not a criterion):** locate with `grep -rn "emails" --include="*.ts" packages/nebula-auth apps/nebula | grep -v node_modules` and **re-derive the set** — it is a locator, not an inventory, and most hits are prose. Also `packages/nebula-auth/README.md` (its mermaid diagrams the body shape — owes `workflow.md`'s render-safety grep) and `apps/nebula/test/test-helpers.ts` (`createSubject` — wire its currently-dead `isAdmin?` option through). `bootstrapUniverseAdmin` in `apps/nebula/test/browser/auth-bootstrap.ts` authenticates at the universe and names the Galaxy in `activeScope`; that is the correct shape and it stays unchanged. ⚠️ **Do not touch `@lumenize/auth`** — the MIT package has its own `#handleInvite` / `body.emails` and its own consumers.

### B — the client method

- **`client.scopes.invite(scope, invitees)` exists and the harness calls it.** The registry endpoints are HTTP routes off the mesh, so app code reaches them through the client's `authedFetch` — which keeps the JWT inside the client (no bearer in UI or page code) and keeps **one** token authority, so nothing snapshots a value that goes stale across a refresh.
- **Acceptance:** `apps/nebula/harness/scenarios/` contains no hand-built `Authorization` header for `/invite`, and `Driver.accessToken` ([harness.ts](../apps/nebula/harness/lib/harness.ts)) is **deleted** — this gap is its only remaining justification, and it is exactly the snapshot `authedFetch` exists to avoid.

## Non-goals

Three concerns moved out of this file on 2026-08-05. Each was here for historical reasons, none of them dependency.

- **Profile-DO conformance to the ADR-012 acceptance gate** → [nebula-profile-accepted-membership-gate.md](nebula-profile-accepted-membership-gate.md). It lives in `profile.ts`, not on the invite path, and never shared anything with this work but a file. Next up after this one.
- **The collaborator — a person granted less than a scope admin** → [on-hold/nebula-collaborator-tiers.md](on-hold/nebula-collaborator-tiers.md). Resumed 2026-08-05, then ⏸️ **paused and taken out of pre-alpha 2026-08-09** — it mixes the Registry and mesh domains, which is post-pre-alpha work; the collapse gate it also carries is not why. This file is its substrate, not its competitor, and **that is unaffected by the pause** — the orchestrator consumes the `sub` returned above whenever it resumes, so nothing here waits on it.
- **The `ui-smoke` `.dev`-login test debt** → [backlog.md](backlog.md) § Testing & Quality, which already holds the verified analysis and two candidate unblocks. It was never blocked on anything here: the lane needs a `.dev` login, and the invite-into-`.dev` premise fails for an unrelated reason (`delete-scope.test.ts` acts at galaxy tier, so `createGalaxy`'s `#hasAdminOverUniverse` gate rejects the exact-star pattern a `.dev` invite yields).

Also out of scope, and staying out:

- **A demote or revoke endpoint** → [backlog.md](backlog.md) § Nebula Auth.
- **A queryable audit trail** → [backlog.md](backlog.md) § Nebula Auth. The ADR-016 *log line* is in scope; somewhere durable to query it is not.
- **Synthetic act-as-only test subjects** — a different mechanism (no mailbox, no claim, no login), named as needed and unowned in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Provision-a-subject-into-{scope, role}*.
- **An invite affordance in the UI.** None exists; whoever builds the first one owns the ADR-015 warning above.

## Relationships

- 🔓 **Un-skip obligation transferred out.** [archive/nebula-star-founder-provisioning.md](archive/nebula-star-founder-provisioning.md) Phase 1 left `it.skip('deletes a scope WITH another user attached, showing the bounded warning')` in `apps/nebula/test/ui-smoke/delete-scope.test.ts` as an **empty stub**. It moved with the `.dev` debt to [backlog.md](backlog.md) § Testing & Quality; the body still owes: invite a second user into the target, assert the confirm screen renders *"Warning — 1 other user will lose access: …"*, that the **Delete button stays enabled**, and that the delete completes.
- **Gate released 2026-07-21** by [archive/nebula-confine-admin-bypass.md](archive/nebula-confine-admin-bypass.md) Phase 1 — the reach invariant here is unconditional because every admin check is confined to the node it runs in.
- **Builds on** [archive/nebula-identity-data-model.md](archive/nebula-identity-data-model.md) (built 2026-08-04), which owns the `Emails`/`Memberships` split, the acceptance predicate, and the dissolved `profileId` join.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md)** — F&F invites ride the same `/invite` with the flag omitted; this task is the buildable piece of *provision-a-subject-into-{scope, role}*.
