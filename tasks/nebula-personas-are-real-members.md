# Personas are real members of the dev Star

**Status:** Larry answered the open questions on 2026-11-14 and asked for the build to run to completion on its own, as the query work did. One fact found since changes Pass 1: Cloudflare gives a catch-all rule only to a zone's own name, so a persona's address is at a mail domain each deployment names, not at `personas.lumenize.io` (D17). It replaces [nebula-testing-with-personas.md](archive/nebula-testing-with-personas.md), whose build was reverted on 2026-11-13 and is kept under the tag `personas-v1-built`. It is item ② of [nebula-pre-alpha.md](nebula-pre-alpha.md).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `Q` an open question, and `D` a decision. D7 is the seventh decision made, wherever its row sits.

## Objective

**A user-developer tests their app as each kind of person who will use it, and each of those people is a real member of the app's dev Star.**

Take the app `acme.crm`, with a cast of Mary, the account's admin, and Sally and Gerry, two salespeople. When this lands:

| | |
|---|---|
| Gerry's address | `gerry--dev.crm.acme@lumenize.dev` |
| Gerry's membership | an ordinary accepted one at `acme.crm.dev`, made by an ordinary invite |
| Gerry's tab in Studio | `https://gerry--dev.crm.acme.lumenize.dev/`, holding a token for the member Gerry |
| Who invited him | whoever asked for the cast, from their own tab on the dev Star |

## Context

The reverted design made a persona a special kind of user. Gerry had no address and no membership, and his id was computed from his host's name. Each shortcut then needed a rule to contain it. The build added a second place to refuse a persona's admin bit after the first missed one, and its seeding could not put a resource where a real member's app looks. Larry, 2026-11-13: *"The less it is 'special', the better… with the exception that it's more steps to seed the Star for testing."*

So a persona now arrives the way any member does: someone invites an address, an email goes out, and the invite is accepted. What is left that is particular to personas is small, and all of it is about the dev Star being a workshop.

These things in today's tree belong to the old design:

- **B1.** `handleRefreshToken`'s persona branch (`packages/mesh/src/auth/worker-token.ts`) mints a token for `personaId(hostScope, persona)`, an id nobody holds a membership under.
- **B2.** ADR-022 § *A persona's host*, and the persona sentences in ADR-010, ADR-013, ADR-016 and ADR-025, describe a persona with no address and no membership.
- **B3.** `docs/vision/auth.md` § *A Galaxy's `.dev` Star* says a persona's token rests on no membership, and that provisioning writes there as the cast.
- **B4.** The scaffold's `docs/personas.md` and the `define-the-cast` skill teach a `mint` step and an address composed when the cast is provisioned.
- **B5.** The Worker has no `email()` handler, and no zone routes mail to it.

The rest of this file says how a persona becomes a member, how its tab gets a token, how the agent gets persona work done, and what stays particular to the dev Star.

## Goals

- **A persona meets every check a person meets.** Today a persona's token is minted by a branch only personas reach, so a rule that binds members can miss them. After this, Gerry's token is the one any impersonated member gets.
- **One way to do persona work, for an admin and a collaborator alike.** Austen, a collaborator, is admin of the dev Star and a plain member of the Galaxy. The agent acts from her post, which she made on the Galaxy's page, and from there nothing of hers reaches down into the dev Star. So the agent asks her own tab to do the work.
- **The server acts for nobody at the dev Star.** No claims are built there, and no node is another node's admin on its own say-so.
- **Nothing here is taught twice.** The agent does persona work by writing the client calls the app's own code makes, so there are no step types to define, validate or document.

## Relationships

- **[nebula-pre-alpha.md](nebula-pre-alpha.md)** lists this as item ②. Its uncommitted edit still describes the reverted design in a few lines, and links the archived file at its old path.
- **[nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md)** has an item on the model's first move when the preview is blank. The tool in DI5 lets the agent read a tab, so the two are to be lined up before either is built.
- **[nebula-query-subscriptions-take-a-filter.md](archive/nebula-query-subscriptions-take-a-filter.md)** was built on 2026-11-14, so an app can now find what a teammate made. Gerry's page subscribes to `{ typeName: 'Deal', filter: { stage: 'open' } }` and holds the open Deals he may read, Sally's among them, with the nodes he may not read named. A field the ontology marks `@index` can be filtered on, and a stage declared `'lead' | 'open' | 'won'` compares in that order, so `{ stage: { $gte: 'open' } }` is `open` and `won`. Q1 is rewritten on that footing.

## Current state

**Built already:**

- **The invite, its email and its consent.** `AuthFacade`'s invite, the Resources plane's `invite(nodeId, invitees)`, the client's `invite`, and `handleAcceptMembership`. Carried over unchanged; a persona's invite is one of these.
- **The impersonation mint,** `mintImpersonationToken` behind `AuthFacade.impersonate`. Carried over unchanged, and given a second caller, the refresh on a persona's host.
- **Persona hosts.** `parseHost` reads `gerry--dev.crm.acme` as a persona and its Star, and `hostOrigin` spells one. Carried over unchanged.
- **The refresh's persona branch** (B1). Adapted: it keeps its checks on who may open the page, and mints through the impersonation mint.
- **`personaId`** in `packages/mesh/src/auth/hosts.ts`. Left behind.
- **A Galaxy invite also makes its invitee admin of the dev Star.** Carried over unchanged. It is what lets a collaborator open a persona's tab.
- **Studio's dev tab,** its frame on `dev.crm.acme.lumenize.dev`, with `decidePreviewFrame` and the `lumenize:reload` message between Studio and the frame. Adapted: it becomes the "Me" tab of a strip, and the channel gains one message.
- **The agent's tools** in `apps/nebula/src/codegen-loop.ts`. Adapted: one tool is added.
- **`Star.resetDevData`** and Studio's Wipe button. Carried over unchanged.
- **The login helpers' nickname,** restored on 2026-11-13. Carried over unchanged.

**Missing:**

1. A persona's address, and the Worker's mail handler that accepts an invite sent to one.
2. The refresh on a persona's host minting for the member that address names.
3. A way for the agent to run code in a tab, and to get its result back.
4. Studio's strip of tabs: "Me", and one for each persona.
5. Guidance that teaches the cast this way: the scaffold's `docs/personas.md`, the `define-the-cast` skill, and the platform docs.
6. The ADR and vision text of B2 and B3, rewritten.

## Design intent

### A persona is a member with an address we receive

- **DI1. A persona's address is its host's own labels at the deployment's persona mail domain.** The host `gerry--dev.crm.acme.lumenize.dev` gives `gerry--dev.crm.acme@lumenize.dev`. Nothing stores the pairing, so nothing can drift from it. The domain is a zone whose catch-all rule sends its mail to the Worker, named once in the deployment's `PERSONA_MAIL_DOMAIN`.
- **DI2. The Worker's mail handler accepts a persona's invite, in plain code.** It reads the invite link from a message sent to a persona's address and accepts it, as the consent screen would, with the persona's slug as its nickname. It acts only when the invite is into the Star the address spells, and only for an environment Star such as `dev` ([ADR-021](../docs/adr/021-every-scope-has-its-own-host.md)). It keeps no cookie. A login link sent to a persona's address is dropped, so nobody signs in as one.
- **DI3. A user-developer may give a real address in place of a persona's.** Its owner clicks their own Accept and signs in as themselves, and no tab in the strip opens as them.

### A persona's tab holds that member's token

- **DI4. The refresh on a persona's host mints through the impersonation mint.** It derives the address from the host, asks the Registry who holds it at that Star, and mints for that member with the opener in `act`. The opener needs dominion over the Star, which a Galaxy invite gives every collaborator. A host whose address nobody holds, or whose invite is not yet accepted, answers 401.

  ```
  { sub: <Gerry's sub>, aud: 'acme.crm.dev', access: { authScope: 'acme.crm.dev', scopeAdmin: false },
    act: { sub: <Austen's sub> } }
  ```

  Mary's token carries `scopeAdmin: true` because her membership does. No check reads `act` ([ADR-016](../docs/adr/016-record-the-acting-principal.md) § *`act` is recorded, and never decides what a call may do*), so each tab behaves as that member's own page would. The one accepted difference is that Mary's tab cannot impersonate.

### The agent asks a tab to do persona work

- **DI5. One tool runs code in a tab.** The agent names a tab, "Me" or a persona's slug, and gives code. Studio hands it to that tab's frame, which runs it with the app's own `client` and `store` in scope and returns plain data or the error. The agent's tool waits on the answer through the poster's Studio tab, and a tab that is closed or does not answer in time is a failure the agent reports.
- **DI6. The "Me" tab builds the cast.** It is the poster on the dev Star's host, holding their own token there. From it the agent invites each persona and sets each one's grants, with the calls an app would make. A persona's own tab then sets its full name on its Profile.
- **DI7. The channel exists only where it is safe.** A page answers the run-code message only when the server told it that it is an environment Star's page, it is framed by Studio, and the message comes from Studio's origin. A tenant's page never has it.
- **DI8. The agent's request is the trace.** A record names the person whose tab acted, or the persona with that person in `act`, and never the agent. The agent's own post in the chat says what it asked for. Larry, 2026-11-14: *"That's actually more honest."*
- **DI9. Nothing asks the person to confirm.** Studio carries out the agent's request when it arrives.

### What the dev Star keeps

- **DI10. The dev Star keeps what makes it a workshop.** It is born with its Galaxy under a reserved slug, a Galaxy invite makes the invitee its admin, it runs the last landed build ([ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)), and it is the one Star a wipe may touch. Persona hosts and the mail handler's acceptance exist only for it.
- **DI11. A wipe keeps the cast.** A membership lives in the Registry, so after a wipe Mary, Sally and Gerry are still members, with no grants and no data. `docs/personas.md` holds what the agent needs to rebuild both from the "Me" tab.

### Claims this rests on

- **C1. No code reads `act` to decide what a call may do.** Checked 2026-11-14: the readers are the mint's root-identity gate and its client mirror.
- **C2. A collaborator's `.dev` membership carries the admin bit.** Checked in the Registry's invite, which mints the sibling with `scopeAdmin` set.
- **C3. An address differing only in its local part is its own identity.** Checked: `normalizeEmail` lowercases and trims, nothing more.
- **C4. From the Galaxy's page, a plain collaborator's claims reach nothing in the dev Star.** Derived from `hasPassageInto`, not run.
- **C5. A token minted for Gerry may write Gerry's own Profile.** ADR-012 says the owner branch fires for an impersonation token. Not run for this path.
- **C6. A dev Star's page may run code handed to it.** Not checked: a content security policy on the served page could forbid it.
- **C7. A local stack can run the mail handler.** Not checked. Q2 depends on it.
- **C8. A node can call a Studio tab and wait for its answer,** with a failure when the tab has no socket or stays silent for 30 s. `mesh.md` says so; not run for this use.

## Constraints

- **[ADR-012](../docs/adr/012-global-profile-visibility.md).** The mint needs the subject's membership accepted, so a persona's tab opens only after the handler has accepted.
- **[ADR-015](../docs/adr/015-passage-and-dominion.md) and [ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md).** The host rule is unchanged, and it is what confines the code a tab is asked to run.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md).** A client cannot name its own actor, which is why DI8 leaves the agent off the record.
- **[ADR-003](../docs/adr/003-continuation-messaging.md).** The tool's wait is a call with a result handler, never a held Promise.
- **[ADR-021](../docs/adr/021-every-scope-has-its-own-host.md).** Persona hosts cost no certificate, and personas live only in environment Stars.
- **`live.md`.** A scenario's persona is invited and accepted by the same handler production uses.
- **Pre-alpha has one wipe gate,** so this file need not leave the system deployable between phases.

## Beyond this task

- **Seeding at scale,** hundreds of Deals to try a list's paging or a slow query. ⚠️ Design consideration: the tool creates data one transaction at a time from a tab, which suits a cast's few records. A bulk path is its own design.
- **The agent reading a tab** reaches past personas: it can see what a page rendered and logged. ⚠️ Design consideration: keep the tool's result general enough for that.
- **Personas in other environment Stars,** `test` or `staging`. ⚠️ Design consideration: DI2 and DI7 name "an environment Star", not `dev`.

## Open questions

None are open. Q1 to Q4 were answered on 2026-11-14 and are D16 to D19.

## Decisions

D1 to D15 were settled with Larry on 2026-11-13 and 14, and D16 to D19 are his answers to the open questions. From D20 on the builder decided alone, during the build Larry asked to run on its own, and each is reversible.

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | A persona is a real member of the dev Star. | A persona with no address or membership, the reverted design: each shortcut needed a rule to contain it. |
| D2 | Each persona keeps a host of its own. | One host for every tab: the tabs would share browser storage, and an unmodified app could not tell whose token to ask for. |
| D3 | A persona's address is at a domain we receive mail for, and the Worker accepts its invite. D17 says which domain. | The user-developer's own plus-addresses: a click for each persona, and each Accept leaves that persona's cookie in their browser, so Home lists it as theirs. A membership born accepted: a second way to accept. |
| D4 | The mail handler accepts in plain code. | The agent reading the mail: the step needs no judgment, and inbound mail is a place for text to steer a model. |
| D5 | The host finds its member by deriving the address. | A cast record on the Galaxy: a second copy that can go stale, and a Galaxy wake on every refresh. A lookup by nickname: mutable and not unique. |
| D6 | A persona's tab gets its token from the impersonation mint. | A mint of its own for personas: the branch only personas reach is what drifted. |
| D7 | `act` is recorded and never decides what a call may do, in ADR-016. | Leaving it a rule in `security.md` alone: persona tabs now depend on it. |
| D8 | An admin persona's tab cannot impersonate. Accepted. | Letting a token with `act` mint: a chain of actors would grow past one person acting for another. |
| D9 | A Galaxy's chain has no exception into its dev Star. Deleted from ADR-015 and `auth.md`. | Keeping it: no code implemented it, and nothing in this design uses it. |
| D10 | A Galaxy invite still makes its invitee admin of the dev Star. | Making every invitee a Galaxy admin: a Galaxy admin holds dominion over every tenant Star. |
| D11 | The agent asks a tab to do persona work, for everyone. | The agent acting under the poster's claims: a plain collaborator's reach nothing in the dev Star. Claims built on the server for her `.dev` membership: one more exception to how claims are made. |
| D12 | The tab is the app's own page. | A page of ours at a reserved path: a broken app is fixed first either way. |
| D13 | One tool that runs code, not a list of calls. | A fixed list: more to build, and it cannot read the page. Security and the record matter little in the dev Star (Larry). |
| D14 | The agent acting as a persona on the server is not built. | It needs a new way to build claims, and a persona's own tab does the same work as a real Client. |
| D15 | The dev Star keeps its workshop rules and loses its identity ones. | Dropping the wipe: a breaking change to the data would have no clean way out. Personas in tenant Stars: test users beside real ones. |
| D16 | The guidance teaches seeding, team data included: each record is made from the tab of the persona who would have made it. (was Q1) | Per-person data only: a cast with nothing to find in each other's work shows little of a shared app. |
| D17 | Each deployment names its persona mail domain, a zone whose catch-all rule sends mail to that deployment's Worker: `lumenize.dev` in production, `lumenize.io` for the test deploy, and `lumenize-test.dev` for a local stack, whose mail the harness passes on. (was Q2; Larry said yes to the relay.) | `personas.lumenize.io`, Larry's first choice: Cloudflare gives a catch-all rule only to a zone's own name, and a subdomain takes one rule for each address. A rule made for each persona: an API token in the Worker and a rule to reap. The test mailbox's Worker passing mail on to the test deploy: production's code would carry an entry only test code calls. |
| D18 | `docs/personas.md` holds the cast and the steps in plain words. Each persona's line opens with its slug in backticks, which Studio reads for its tabs. (was Q3) | Stored code: the client API can change under it, and people read the file too. |
| D19 | The dev Star is kept matching `docs/personas.md` without the person asking twice. A wipe from Studio's button is followed by a post, in the person's name, asking the agent to rebuild the cast as the file has it. A turn that changes the file applies the change in that turn. (was Q4; Larry: it depends on whether the cast changes. This is the builder's reading of that, and the first thing for him to check.) | Rebuilding only when asked: an unchanged cast needs no decision, so asking is a step with no answer. |
| D20 | The handler reads the link from a header, `X-Lumenize-Auth-Link`, which the sender stamps on every message that carries a link. | Parsing the body: it needs a MIME parser in the Worker, and breaks when a provider changes how it encodes the HTML. |
| D21 | Mail to an address that is no persona's is rejected, so its sender hears there is no such mailbox. Mail to a persona's address that carries no invite into that persona's Star is dropped. | Dropping everything: a person who mistypes an address at the domain would never learn it. |
| D22 | On a persona's host the refresh hands the impersonation mint the claims it would have minted for the opener on that host, built from the opener's cookie record. | A second authorize step written for cookies: the mint's own check is the one every impersonation meets. |
| D23 | The tool's call to the poster's Studio tab names a result handler, and the handler wakes the turn, which waits in memory as it does for the model. A turn whose Galaxy is evicted is lost as before. | A turn that can resume after eviction: a larger change to the loop than this task. |
| D24 | The page spells a persona's address with `client.personaAddress('gerry')`, from its own host and a mail domain the served page names. | An address written into `docs/personas.md` or composed by the model: a mistyped scope is a different person. |
| D25 | The tool runs in one Studio tab of the poster's, the first by id among those connected. | The tab that posted: nothing records it, and any of the person's tabs holds the same session. Every tab: the code would run once in each. |
| D26 | A persona's tab opened outside Studio logs out as any page does, ending the opener's sessions in that browser. | Teardown only, as an impersonated child does: the page holds the opener's cookies, and they are the opener's to end. |

## Phases

Each phase ends with its tests mutation-checked and its notes in § *Build notes*. Nothing replaced survives beside its replacement: `personaId`, `PERSONA_NAMESPACE`, the refresh's own persona mint and the `mint` verb in the cast's procedure all go in the phase that replaces them.

1. **A persona's host mints for the member its address names.** `personaAddress` and its inverse in `hosts.ts`; a Registry read from an address and a Star to the accepted member's `sub`; the refresh's persona branch through `mintImpersonationToken` (DI4, D22). `personaId` and `PERSONA_NAMESPACE` are deleted.
   - **Success criteria:** on Gerry's host, a browser holding an admin cookie over the Star gets a token whose `sub` is Gerry's membership's, with the opener in `act` and Gerry's own admin bit; a plain member's cookie gets 401; a host whose address nobody holds, or holds unaccepted, gets 401; no source names `personaId`.
   - **Mutation note:** minting the opener's own `sub`; skipping the acceptance read; reading the admin bit from the opener; accepting a plain member as opener.
2. **The Worker accepts a persona's invite by mail.** The sender's link header (D20); `acceptPersonaInvite` beside the other acceptance writers, with `mail` as its credential; the Worker's `email()` export (DI2, D21); `PERSONA_MAIL_DOMAIN` in each deployment's config; the test mailbox keeps each message as it arrived, and the harness passes a local stack's on (D17).
   - **Success criteria:** an invite into `acme.crm.dev` sent to Gerry's address is accepted, with `gerry` as nickname and no session recorded; a login link sent there is dropped and stays unspent; an invite into another Star sent to Gerry's address is dropped; mail for an address that is no persona's is rejected; a second delivery of the same message changes nothing.
   - **Mutation note:** accepting without comparing the link's scope with the address's Star; accepting a login link; recording a session; accepting for an address other than the link's.
3. **A page can be asked to run code.** The dev page's meta names the persona mail domain; `client.personaAddress` (D24); the factory answers a run request from Studio's origin, on an environment Star's page, in a frame, and nowhere else (DI5, DI7).
   - **Success criteria:** code handed to a framed dev page runs with `client` and `store` and its value comes back; a throw comes back as an error with its message; a page that is top-level, or not an environment Star's, or asked from another origin, runs nothing.
   - **Mutation note:** each of DI7's conditions removed in turn; the value returned without waiting for the code's Promise.
4. **Studio shows the cast as tabs and carries a run request to one.** The Galaxy reads the cast from `docs/personas.md` (D18); the strip of tabs, "Me" first; `StudioClient.runInTab`, which loads the tab's frame if need be, posts the request and answers with the page's answer (DI5).
   - **Success criteria:** the strip lists each slug the file names; a persona's frame holds that member's token; a run request for a tab the cast does not name, or whose page stays silent, answers with a failure that says which.
   - **Mutation note:** the request posted to the wrong frame; a silent page answered as success.
5. **The agent has one tool that runs code in a tab.** `run_in_tab` in the loop; the Galaxy's entry, which finds the poster's Studio tab (D25) and waits on its answer (D23); the Mesh addition that lists a host's connected Clients.
   - **Success criteria:** a turn's `run_in_tab` reaches the poster's own Studio tab and no other person's, and the code's value is the tool's result; with no Studio tab open the tool fails within its bound and says so; the record of what the code wrote names the tab's person, or the persona with that person in `act`, and never the agent (DI8).
   - **Mutation note:** picking any connected tab; resolving the wait without the handler; the bound removed.
6. **The guidance teaches the cast this way.** The scaffold's `docs/personas.md`, the `define-the-cast` skill, the tool's description, and the reference docs (D16, D18). The `mint` verb goes.
   - **Success criteria:** the generators' checks pass; no guidance names `mint` or a provisioning step outside the chat; the `/live` guidance scenarios this touches still pass.
7. **A wipe is followed by the cast's rebuild** (D19).
   - **Success criteria:** Studio's Wipe, on an app whose file names a cast, leaves a post asking for the rebuild; on an app with no cast it leaves none.
   - **Mutation note:** posting when the file names no cast.
8. **The standing text describes a persona as a member.** B2 and B3: ADR-022 § *A persona's host*, the persona sentences of ADR-010, ADR-013, ADR-016 and ADR-025, `docs/vision/auth.md`, and the rules that quote them. It is the last phase because every phase before it changes what these describe.
   - **Success criteria:** `grep -rniE 'persona' docs/adr docs/vision .claude/rules CLAUDE.md` holds no sentence saying a persona has no membership, no address or an id spelled from its host.

**Scenarios.** `persona-host` is rewritten on phase 1 and 2: a real invite, accepted by the handler, then the host's refresh. `persona-tabs` drives phases 3 and 4 in a browser. `cast-from-a-tab` drives phase 5 with the real model, gating only on what holds whatever the model chooses, and the tool's own choices gate in the lane behind the real commit path (`live.md`). The build closes with a deployed pass of all three, since mail, tokens and frames are what only a deploy shows.

## Non-goals

- **Seeding at scale.** § *Beyond this task*.
- **The agent acting as a persona on the server.** D14.
- **Personas outside environment Stars, and pages for an environment Star other than `dev`.** The Galaxy serves only `dev`.
- **Production's mail routing.** Email Routing on `lumenize.dev` is turned on at the production deploy; § *Build notes* has the steps.

