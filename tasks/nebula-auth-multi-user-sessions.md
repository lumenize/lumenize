# Multi-user sessions

**Status:** Pass 1, 2026-09-09 — design intent only, no phases. Drafted as the prerequisite [nebula-testing-with-personas.md](nebula-testing-with-personas.md) discovered it needed; that file is the first consumer, not the reason. **Gated on a hand review of the [ADR-012](../docs/adr/012-global-profile-visibility.md) amendment in § *Design intent*, which is an amendment to an ACCEPTED ADR and therefore blocks everything below it.**

## Context

One browser, one session per scope. That is the assumption `refresh-token` was built on, and it is written into the cookie: one fixed name at `Path=/auth/{scope}`, so a second login at the same scope overwrites the first. The overwrite is not even loud — `handleAcceptMembership` resolves whatever cookie it finds through the registry to *its own* membership rather than to the scope named in the URL, so two sessions at one scope read as a silent identity swap rather than a refusal.

That assumption holds for a person. It stops holding the moment someone wants to look at their app as several of its users at once — which is the whole of [nebula-testing-with-personas.md](nebula-testing-with-personas.md), and is not peculiar to it: a support agent viewing as a customer, or a developer comparing two roles, wants the same thing.

The second problem arrives with the first. A real session begins with a link sent to a mailbox, and that is deliberate — [ADR-012](../docs/adr/012-global-profile-visibility.md) makes mailbox proof the thing that stops an inviter manufacturing an accepted membership for someone else's address. But a cast of eight synthetic users has eight mailboxes nobody reads, and routing real mail to them to fish the link back out is a delivery pipeline built to move a value the sender already holds.

This file changes both, and the two are one change: **several real sessions in one browser needs cookies that do not collide, and a way to obtain each session's link that does not need a mailbox.**

## Objective and goals

**Objective — one browser holds several concurrent real sessions, and the platform can hand a session's link to whoever owns the identity's namespace, without weakening what mailbox proof protects.**

**Goals:**

1. **Per-session refresh cookies.** Two logins at one scope coexist; neither overwrites the other, and every existing single-session flow behaves exactly as it does today.
2. **A restricted way to obtain a platform-issued identity's invite link**, safe enough to state as an invariant rather than defend as a guard.
3. **The namespace grammar goal 2 rests on**, enforced rather than asserted.

## Design intent

### The cookie: derive the name, do not add a second one

Today the cookie IS the identifier — the server hashes whatever arrives and looks the session up, so it never has to know *which* user. With several sessions at one path that stops working: the browser sends them all, and the server has to pick.

**The name carries the discriminator, and the caller says which one it wants.** Every read goes through `extractCookie(…, 'refresh-token')` and every write through one of two cookie builders, so the literal has exactly one definition point per direction — make both derive the name and every site inherits it, with no site-by-site sweep to get wrong.

⚠️ **Letting the caller name the cookie is not a widening, and this is the first thing a reader will doubt.** The cookie remains the credential; naming which of your own cookies to read grants nothing, because the browser only ever sends cookies it already holds and each resolves to its own session by hash. A caller naming a cookie it does not hold gets nothing back. What the name buys is disambiguation, not authority.

**Not per-origin.** Separate origins give separate jars for free and are strictly stronger isolation, but they need the origin split in [on-hold/use-lumenize-dev-domain-and-support-custom-domains.md](on-hold/use-lumenize-dev-domain-and-support-custom-domains.md), which is after-GA (Larry, 2026-09-09) and which as designed gives one origin **per galaxy** — so every session in a galaxy would still share a jar and the collision would survive it. A derived cookie name is a rename; that is a domain model.

### The link: what licenses issuing one instead of delivering it

An invite URL is a **bearer credential for the identity it names**. Following it places a session for that membership and lets the follower accept it — and acceptance is load-bearing far beyond the scope it was issued in, because one address is one Profile globally ([ADR-013](../docs/adr/013-identity-profileid-resolution.md)) and ADR-012's owner branch keys on the `profileId` the token carries. So anyone handed the link for an address they invited could accept it and then own that person's Profile everywhere. That is why the URL is fenced today and stripped before any caller sees it.

**What makes issuing one safe is not the caller's authority. It is that the address belongs to a namespace no human can hold.** Dominion is the wrong axis and ADR-012 says so directly — a `profileId` is global and scope-free while dominion is scope-local, so an admin's dominion cannot bound what a taken-over identity reaches. What bounds it is that there is no one to take over: an address on a domain we operate, whose local part encodes the issuing scope, which the platform alone ever issues.

**The rule, in three clauses, each closing a different attack:**

| Clause | What it stops |
|---|---|
| The address's domain is one we operate for this purpose — `personas.lumenize.io` | Targeting a **human**. Dominion cannot do this; the attacker's own scope is a legitimate place to invite anyone. |
| The address's local part parses to the caller's own `{u}.{g}` | Targeting **another tenant's** synthetic identity — `acme.crm~mary@personas.lumenize.io` passes the domain check and belongs to someone else. |
| The caller holds dominion over that scope | A **same-galaxy escalation**: a collaborator at the chat floor taking over an identity that carries `scopeAdmin` at `.dev`. |

⚠️ **The clauses are not redundant and none is defence in depth** — each is the only thing standing between an attacker and a different outcome. A change that drops one is a change to the invariant, not a simplification.

### The ADR-012 amendment — the gate on this whole file

ADR-012 is **Accepted**, and it states the property this design bends: *acceptance needs the mailbox and an explicit act*, its writer *"authenticated by the cookie a click on mail to that address placed."* The accept endpoint is untouched here — it still demands that cookie. What the amendment licenses is a **second restricted way for a link to reach a legitimate holder**:

> A link may be issued to a caller rather than delivered to a mailbox **only for an address in a namespace no human can hold** — a domain we operate, local part encoding the issuing scope, issued only by the platform, as `{u}.{g}~{slug}@personas.lumenize.io` is — and only to a caller holding dominion over that scope. For every human-holdable address, mailbox proof is unchanged.

That preserves what ADR-012 protects by a different mechanism: nobody manufactures acceptance for *someone else's* address, because in this namespace there is no someone else. ⚠️ **Drafted for Larry's hand review, never for ratification** — no ADR is ratified before pre-alpha launches, and this one is his to read.

**[ADR-009](../docs/adr/009-real-auth-path.md) needs a clause too, and a smaller one.** Its ladder has no rung for a real link, platform-issued and platform-consumed, in production: rung 1 is a mailbox read and rung 2 is `LUMENIZE_AUTH_TEST_MODE`, which is test-only. The clause to add is that for a platform-issued synthetic identity there is no human path being shortcut, so this is not a rung drop — and that real invite mail may still be sent, because nothing depends on reading it.

## Relationships

- **Prerequisite for [nebula-testing-with-personas.md](nebula-testing-with-personas.md)**, which is the first consumer and supplies the namespace: its cast, its address grammar, and its `.dev` scope. That file keeps everything about the cast, the procedure, seeding, the tab strip and the guidance; this one keeps only what `packages/nebula-auth` must change.
- **Does NOT include `readAcceptance`**, which that file pins. Asking whether a persona has accepted is a provisioning question reached by the Galaxy, not a session one, and it belongs with the executor that calls it.
- **Leaves [backlog.md](backlog.md) § *Lumenize Mesh*'s warning intact.** That row forbids making `refresh` public on `LumenizeClientConfig`; nothing here proposes it, because a seat holds its own real session rather than a handed-over renewal closure.
- **Not blocked by the origin split** — see § *Design intent*. If that work ever lands per-identity origins, the derived cookie name becomes redundant rather than wrong.

## Verified on disk — so it need not be re-derived

- **The cookie name has one definition point per direction.** Every read is an `extractCookie(…, 'refresh-token')` in `worker-token.ts`; every write is one of its two cookie builders, one setting and one clearing. So a derived name is a change to those helpers, not a sweep — and the logout path's inline clear is the one site that does not go through a builder.
- **The accept endpoint resolves the cookie, never the URL.** `handleAcceptMembership` reads the refresh cookie, resolves it through the registry to that session's own membership, and accepts *that* — which is why a colliding cookie is an identity swap and why the endpoint needs no change once names stop colliding.
- **A browser cannot present as a Durable Object.** The Gateway builds `callChain[0]` from the WebSocket attachment with the node type hardcoded, replacing whatever the client sent, so caller provenance is available to a guard and is not forgeable. `lumenize-worker.d.ts` documents reading it. ⚠️ Only `callChain[0]` — later hops are preserved from the client unvalidated.
- **`NebulaAuthFacade` exposes exactly one `@mesh()` method today** (`invite`), and its header states the discipline any second one inherits: verdicts compute from `originAuth`, identity is never hand-threaded, and the call's shape is validated at that boundary (ADR-001).
- **`isValidSlug` is already exported** from the package root, wrapping a private regex with the checks the regex does not carry. Goal 3 is a reserved-word list beside it, not an export.
- **The invite URL exists server-side at mint time.** `issueInvites` returns it to the entry, which uses it to build the letter, and the caller-facing summary is what strips it. So goal 2 is a fence decision, not a plumbing one.

## Criteria — what a phase must satisfy

- **Two real logins at one scope coexist in one browser, and each reaches its own identity.** Mutation: revert the cookie name to the shared literal, and the second login silently becomes the first — which is the defect this file exists to remove, and it must be asserted as an identity check rather than a "still logged in" check.
- **Every existing single-session flow is unchanged.** The full `/live` registry sweep is the evidence, because login, accept, refresh and logout are what most scenarios open with.
- **The three-clause rule refuses each attack separately.** A mutation per clause, not per rule: drop the domain check and a human address is issuable; drop the prefix check and another tenant's identity is; drop the dominion check and a chat-floor collaborator can take a `scopeAdmin`-bearing identity. ⚠️ Match the refusal MESSAGE — three refusals that are the same boolean are indistinguishable, and telling them apart is the point.
- **The reserved-word list refuses its members**, and the refusal names which word — so the caller learns what to change rather than that something was wrong.
- **Issuing a link records the acting principal**, since it establishes a session ([ADR-016](../docs/adr/016-record-the-acting-principal.md)), through the one shared projection rather than a bespoke record.

## Constraints Pass 2 inherits

- **[ADR-013](../docs/adr/013-identity-profileid-resolution.md) is what makes the namespace argument true**, and it is a dependency rather than a citation: one address is one Profile globally, so the safety of issuing a link rests entirely on the address being one no human holds. A change that let two scopes share a synthetic address would break this file's invariant without touching its code.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md) binds both halves.** Establishing a session is an authority event, so the link issuance and the accept both record the full verified claims.
