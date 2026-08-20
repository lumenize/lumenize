# The collaborator — a person granted less than a scope admin

**Status:** ⏸️ **ON HOLD, and out of pre-alpha entirely — paused 2026-08-09 by Larry.** Still the only home for the collaborator: [archive/nebula-invite.md](../archive/nebula-invite.md) ships the invite *mechanism* and names no role. Design pinned with Larry 2026-07-18/19; endpoint placement pinned 2026-08-05; not built.

**Why it is paused, in his words: the design mixes the Registry domain and the mesh domain, and that is tricky enough to be worth not thinking hard about until after pre-alpha unless forced.** That mixing is not incidental — it is what §§ *Where the endpoint lives* and *The carried context payload* exist to resolve, since the registry structurally cannot pre-stage a DAG grant and Nebula structurally cannot mint a membership. **Pre-alpha pays for the pause with training or a code workaround for its handful of users** (accepted, same date); the interim shape is the one [nebula-galaxy-collapse-and-chat.md](../nebula-galaxy-collapse-and-chat.md) already carries — a collaborator enrolls as a Galaxy admin via the scope-admin bypass, which is broader than this file's bundle and deliberately so.

🔄 **The reason for the pause weakened on 2026-08-11 — re-read this before resuming, and before assuming the pause still holds.** It was paused because the design mixes the Registry and the data plane: *"the registry structurally cannot pre-stage a DAG grant and Nebula structurally cannot mint a membership."* [`docs/vision/auth.md`](../../docs/vision/auth.md) § *Grants* (`accepted`) now says **anyone may invite a non-admin at their own scope** — so the second half of that sentence is no longer true, and a data-plane `admin` holding no `scopeAdmin` can cause a membership directly. ⚠️ **This does not un-pause the file** — the collapse gate still stands and the grant-bundle carrier is still unbuilt — but it removes the structural obstacle that made the mixing feel intractable, and it likely simplifies §§ *Where the endpoint lives* and *The carried context payload*. Two use cases Larry raised the same day (a node-level data-plane admin onboarding a teammate; the same person issuing a short-lived share link) are what this file should be re-scoped around.

🔄 **2026-08-19 — the mixing obstacle is RESOLVED, not merely weakened; re-scope on resume.** The invite work ([archive/nebula-invite.md](../archive/nebula-invite.md)) did the tricky thinking this pause deferred: every invite enters mesh-side; a mesh-speaking facade owned by nebula-auth carries the Registry half (pattern in `mesh.md` § *Nebula platform code never drops to raw primitives*; model in `docs/vision/auth.md` § *Grants in both planes*); and **both planes are written at invite time, which deletes § *The carried context payload* for the invite flow** — the `sub` exists at issue time, so there is nothing to stage, apply at first touch, or clean up. The carrier idea survives only for self-signup (no admin present at redeem). What remains this file's: the named-role grant **bundle** (multi-node grant sets — the invite method deliberately takes one `nodeId` per call), the valid-combinations UI question, the self-signup redeem hook, and the enterprise consumer.

⚠️ **The collapse gate is unchanged and is NOT what paused this** — it still needs the collapse to make the Galaxy a `DagTree` host. Resuming is a scheduling decision, not a dependency one: when the collapse has landed *and* an external-launch consumer exists ([`docs/vision/enterprise.md`](../../docs/vision/enterprise.md) § *The invitation is the land motion* is the first), this comes back. ⚠️ Its vocabulary predates [nebula-passage-dominion-from-scope.md](../archive/nebula-passage-dominion-from-scope.md) in at least three places (the ADR-015 constraint bullet, the first acceptance criterion, § *Two memberships*); that file's sweep criterion now names this path explicitly, so do not assume a clean grep means clean prose.

> 📐 **`/write-task` Pass 1 — design intent is below, phases are NOT written.** ⚠️ **Paused before Stage 1, so no review has run on this file at all.** On resume the path is `/review-task` **Stage 1** → resolve and edit → write phases → **Stage 2**; § *Acceptance criteria* is Pass-2 input, saying what must be true and deliberately not in what order. **Re-read § *Context and current state* against disk first** — its claims were verified 2026-08-05 and the pause is open-ended.

**Objective — an admin can invite someone who gets exactly the access they need and no more.** Concretely: a person who can work on the app and test it, without authority over the tenant Stars beneath it, and without the ability to invite others or manage the app.

## Context and current state

**Built already:**

- **The scope-admin bypass** — `hasDominionOver(access, <this node's instance name>)` short-circuits `requirePermission` on the node it runs in, so a scope admin needs no DAG grant. Confined per ADR-015.
- **DAG grants** — `Permissions(nodeId, sub, permission)` over `'admin' | 'write' | 'read'`, resolved by climbing every ancestor path and taking the highest grant found (`getEffectivePermission`).

**Missing:**

0. **The invite mechanism itself** — per-invitee admin bit, and the minted `sub` in the response ([archive/nebula-invite.md](../archive/nebula-invite.md), **not built; buildable now**). Step 3 below consumes that `sub`, and there is no other address→`sub` path. ⚠️ This bullet used to sit under *Built already*, which was simply false — that file is the thing that builds it. Numbered `0` because the three below are append-only handles.
1. **A permission surface on the Galaxy.** ✅ **Checkable claim:** `DagTree` is composed by `star.ts` and `dev-studio.ts` only (verified 2026-08-05) — so `write@Galaxy-root` cannot be granted, because there is no Galaxy orgTree to grant on. [nebula-galaxy-collapse-and-chat.md](../nebula-galaxy-collapse-and-chat.md) creates it. **This is what gates the file.**
2. **A carrier for grants chosen at invite time.** An invite mints a membership; nothing carries the inviter's per-node choices from the invite to the moment the invitee first arrives.
3. **An orchestrating endpoint.** Nothing applies a membership and a grant bundle as one bounded, validated operation.

## Design intent, constraints, and future state

### What a collaborator is

**The minimum useful collaborator (Larry, 2026-07-19):** `admin@.dev-Star` — create test users, run test ops — plus `write@Galaxy-root` — edit the app's files. Not full Galaxy-admin: inviting others and managing the app stay the owner's. This is a **bundle of DAG grants**, not the `isAdmin` bit, which is why it needs the carrier below rather than a flag.

Everyone in a chat can hold **different** permissions; the inviter's UI offers only the combinations valid for the situation.

**Make the bundle DATA, not code.** A named role whose definition lives in one place beats an endpoint with grants hardcoded — otherwise a second role means a second endpoint. The generic *carrier* (arbitrary per-person bundles) costs materially more and stays deferred; a named role that is one table row does not.

### Where the endpoint lives — Nebula, not nebula-auth

The registry must not know about Nebula's orgTree, so a `nebula-auth` endpoint **structurally cannot** pre-stage a DAG grant. The collaborator endpoint is a `@mesh()` method in `apps/nebula`, on the post-collapse Galaxy, orchestrating in order:

1. Verify the caller's admin-over-`{u}.{g}` at the door.
2. Validate each intended grant ⊆ what the caller's own server-derived scope covers — the one point the inviter's admin JWT is present and verified.
3. Call the registry's `/invite` to mint the membership, and take the `sub` from the response.
4. Pre-stage the DAG grants keyed by that `sub`; applied idempotently at the invitee's first authenticated touch, then cleared.

This is the shape [`docs/vision/auth.md`](../../docs/vision/auth.md) § *Grants* describes: data-plane grants are initiated by application endpoints, which make the registry calls they need.

### The carried context payload

The inviter's UI composes a JSON payload of `(node, tier)` grants; **auth carries it opaquely and never interprets it**; **Nebula reads and applies it.**

- **Store — reuse the flow's token as the key.** A generic `Contexts(tokenHash → payload, expiresAt)` table in auth, keyed by the hash of the flow's already-minted token. Invite keys on `invite_token`; self-signup keys on its verify token; one table serves every flow. Possession of the unguessable token *is* the capability (ADR-010/012), so no access control around the lookup.
- **Attach:** the payload rides the `POST /invite` **body**; auth writes `Contexts[invite_token_hash]` beside the `InviteTokens` row. Nothing rides email but the token itself — the payload never touches a URL or an email body.
- **Apply:** grants land **Nebula-side**, pre-staged at issue time. The generic primitive both flows share is *a pending grant recorded Nebula-side, keyed by `sub`, applied idempotently at first touch* — only the authorizer differs (invite = the inviting admin's bounded choice; self-signup = the scope's policy).
- **Cleanup:** piggybacks on the single-use invite token — the `DELETE FROM InviteTokens` on accept also deletes `Contexts[hash]`; `INVITE_TTL` is the backstop.

### Two memberships, two sessions

Once dominion is `scopeAdmin ∧ scope-at-or-above` ([nebula-passage-dominion-from-scope.md](../archive/nebula-passage-dominion-from-scope.md), ✅ landed 2026-08-16), a non-admin reaches **nothing beneath its own scope**, so a collaborator cannot knock on a tenant Star even to be denied there. There is nothing over-broad to disclose or decide about.

What remains is a shape, not a problem: a collaborator holds **one membership per scope she works in** — `{u}.{g}` for the app, `{u}.{g}.dev` for testing — and therefore one session each. A JWT carries `access: AccessEntry`, one entry per token, so this was always going to be two sessions; what changes is that the alternative is no longer a wider pattern.

⚠️ **That matches the surfaces anyway** (Larry, 2026-08-05): the Studio tab is pointed at the Galaxy and the app under test runs in the preview iframe or its own tab, so the two sessions correspond to two things already on screen. ✅ It also makes `discover` honest — a person's memberships become the true list of where they can work, which the scope picker can render.

⚠️ **The one friction is N invite emails**, since each membership carries its own acceptance and per-membership acceptance is load-bearing (ADR-012's manufacture defense). If it ever bites, the answer is a multi-invite-in-one-email flow; Larry's read is that it is years away.

### Constraints

- **[ADR-015](../../docs/adr/015-passage-and-dominion.md)** — dominion flows downward only; dominion is `scopeAdmin` ∧ the caller's `authScope` at or above this node; restraint is a UI warning, never an authz refusal.
- **[ADR-008](../../docs/adr/008-full-org-tree-visibility.md)** — within a Star the org tree is visible to members by design; enforcement is at the point of action.
- **[ADR-003](../../docs/adr/003-continuation-messaging.md)** — the pre-stage is a one-way `lmz.call`; no node holds a reply channel open across a hop.
- **[ADR-016](../../docs/adr/016-record-the-acting-principal.md)** — the endpoint moves authority, so it records the acting token's full verified claims.
- **`security.md`** — never grant broader than the inviter holds; the bound is server-derived, never client-supplied.
- **`mesh.md`** — `apps/nebula` → `nebula-auth` is the allowed dependency direction; the reverse is not.

### Future state

- **Self-signup is consumer #2** of the same `Contexts` carrier — don't fork it. It has no present admin, so it must use the redeem hook rather than a pre-stage.
- **The enterprise expansion is what makes this load-bearing beyond one person.** `docs/vision/enterprise.md` (*The invitation is the land motion*) has the intrapreneur growing the footprint by inviting colleagues, and "invite a teammate" cannot mean "hand them admin over your Galaxy and everything beneath it" in front of an IT buyer. That lands behind that doc's *Timing gates*.
- ⚠️ **Design consideration:** the dedicated `SESSION_NODE_ID` (child of `ROOT`, from the collapse) matters here — a collaborator granted chat participation on `SESSION_NODE_ID` must **not** get whole-app write, which a grant on `ROOT` would cascade.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **The collaborator is a grant bundle**, and this file is its only home | **`collaborator = admin at the invited scope`** — pinned with Larry 2026-07-19, **reversed 2026-08-05**. It was not the narrowest thing that worked (an exact-star invite at `{u}.{g}.dev` reaches that Star and nothing else, with zero machinery), and a named-but-wrong collaborator would be re-read every session until fixed. Larry: *"I struggle with interims. They consume too big a part of my brain. I have to constantly remind myself that we'll fix it later."* Shipping **no** collaborator beat shipping a wrong one, so the mechanism file now names none. |
| **The endpoint lives in `apps/nebula`** | In `nebula-auth` — the registry must not know Nebula's orgTree, so it structurally cannot pre-stage a grant. |
| **Grants apply Nebula-side, pre-staged at issue time** | Applying in the auth Worker at accept — accept-invite is a bodiless 302 under the *invitee's* identity: no body, no mesh, no admin authority (verified 2026-07-19). |
| **Reuse the flow's existing token as the `Contexts` key** | A separate context token — a second secret to mint, deliver and expire, for no capability the first one lacks. |
| **A named role, defined in one place** | Hardcoding the bundle in the endpoint — a second role would then need a second endpoint (`workflow.md` § *YAGNI gates capability, never generality*). |
| **The bound validated at issue time** | Validating at redeem — the inviter's admin JWT is present and verified only at issue; at redeem there is no admin to bound against. |

## Acceptance criteria — input to Pass 2, not yet decomposed into phases

- **A collaborator gets exactly the bundle and nothing else.** After invite→accept she can write app files at the Galaxy root and run admin ops in `.dev`; she **cannot** write in a tenant Star, cannot invite anyone, and cannot delete a scope. *Reds against granting the `isAdmin` bit instead of the bundle.*
- **The bundle applies exactly once, at first touch.** Accept → the first authenticated call lands the grants; a second call changes nothing and the pending record is gone. *Reds against a non-idempotent apply, and against one that never clears.*
- **An inviter cannot grant beyond what their own scope covers.** An admin of `{u}.{g}` attempting a bundle naming a node in a sibling Galaxy is refused at issue time, and **no** membership is minted. *Reds against validating at redeem.*
- **The payload never leaves the token path.** The invite email body and the invite URL contain no grant data. *Reds against putting the bundle in the link.*
- **Cleanup is tied to the single-use token.** Consuming the invite deletes the `Contexts` row; an unconsumed one is gone by `INVITE_TTL`. *Reds against a leak that outlives the invite.*
- **ADR-016** — the endpoint records the acting token's full verified claims through the shared `projectActingToken` projection. *Stripping the claims argument must red.*

## Non-goals

- **The per-invitee `isAdmin` mechanism and the returned `sub`** → [archive/nebula-invite.md](../archive/nebula-invite.md). This file consumes both.
- **A UI for composing bundles.** Which combinations are offered is an open question below; the affordance is out of scope until it is answered.
- **Self-signup** — consumer #2 of the same carrier, later.
- **Changing how the claim expresses scope** → [nebula-passage-dominion-from-scope.md](../archive/nebula-passage-dominion-from-scope.md), which owns it and ✅ landed 2026-08-16.

## Open questions

1. ✅ **Closed 2026-08-05** — *"accept tenant-Star admission, or change the claim shape?"* The claim was changed, by [nebula-passage-dominion-from-scope.md](../archive/nebula-passage-dominion-from-scope.md). Kept as a numbered handle so the remaining questions do not renumber.
2. **Pre-stage from the inviter's client, or an auth `onRedeem(scope, sub, context)` hook at accept?** Pre-stage is pinned for the invite flow; self-signup has no present admin, so it *must* use the hook. Confirm one primitive serves both before building either. *(The hook's exact signature, and where the Nebula impl runs without crossing the `nebula-auth` → `apps/nebula` dependency boundary, rides this answer.)*
3. **Which `(node, tier)` combinations does the inviter's UI offer, and how is "valid for the situation" computed?**

## Relationships

- **Gated on** [nebula-galaxy-collapse-and-chat.md](../nebula-galaxy-collapse-and-chat.md) — it lands the first `DagTree` on a non-leaf node, which is the permission surface `write@Galaxy-root` needs.
- **Built on** [archive/nebula-invite.md](../archive/nebula-invite.md) — its per-entry envelope grows into this grant spec (a pre-alpha wire break, fine), and its returned `sub` is what step 3 consumes.
- **Shares substrate with** [nebula-request-access.md](nebula-request-access.md) (the **pull** half to this **push** half) and the paused F&F invites ([nebula-pre-alpha.md](../nebula-pre-alpha.md) § Invite-gated) — one `/invite` / `accept-invite` / `InviteTokens` path, not a fork.
