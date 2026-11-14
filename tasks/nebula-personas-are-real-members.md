# Personas are real members of the dev Star

**Status:** Pass 1, written 2026-11-14 for Larry's hand review; no phases yet. It replaces [nebula-testing-with-personas.md](archive/nebula-testing-with-personas.md), whose build was reverted on 2026-11-13 and is kept under the tag `personas-v1-built`. It is item ② of [nebula-pre-alpha.md](nebula-pre-alpha.md).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `Q` an open question, and `D` a decision. D7 is the seventh decision made, wherever its row sits.

## Objective

**A user-developer tests their app as each kind of person who will use it, and each of those people is a real member of the app's dev Star.**

Take the app `acme.crm`, with a cast of Mary, the account's admin, and Sally and Gerry, two salespeople. When this lands:

| | |
|---|---|
| Gerry's address | `gerry--dev.crm.acme@personas.lumenize.io` |
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
- **B5.** The Worker has no `email()` handler, and `personas.lumenize.io` is not an Email Routing subdomain.

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

- **DI1. A persona's address is its host's own labels at the persona mail domain.** The host `gerry--dev.crm.acme.lumenize.dev` gives `gerry--dev.crm.acme@personas.lumenize.io`. Nothing stores the pairing, so nothing can drift from it.
- **DI2. The Worker's mail handler accepts a persona's invite, in plain code.** It reads the invite link from a message sent to the persona domain and accepts it, as the consent screen would, with the persona's slug as its nickname. It acts only when the invite is into the Star the address spells, and only for an environment Star such as `dev` ([ADR-021](../docs/adr/021-every-scope-has-its-own-host.md)). It keeps no cookie. A login link sent to a persona's address is dropped, so nobody signs in as one.
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

- **Q1. Does this task teach seeding at all?** The tool can create a resource from a persona's tab, and since the query work an app can find it: asked of Sally's tab, the tool creates Sally's Deal as Sally, and Gerry's page finds it by a filter. So seeding needs no mechanism beyond DI5's tool. What is open is whether this task's guidance teaches it.
  - *Options:* teach none, and leave seeding to a later task; teach per-person data only, such as each persona's own list; teach team data too, each record made from the tab of the persona who would have made it.
  - *Recommendation:* teach team data too. A cast with nothing to find in each other's work shows little of a shared app, and each record then carries the right author. It costs a section of guidance and one limb of a scenario: Sally's tab makes a Deal, and Gerry's page lists it.
- **Q2. How does a stack other than production receive a persona's mail?** `personas.lumenize.io` routes to one Worker. The test deploy and a local `wrangler dev` each send invites of their own, whose links point at their own hosts.
  - *Options:* a persona mail domain for each deployment, with a local stack's mail arriving at the test mailbox and the harness passing the raw message to the local Worker's mail handler; or persona scenarios that run deployed only.
  - *Recommendation:* a domain for each deployment, and the relay for local runs. The handler's own code runs in every venue, and only the delivery differs. `live-scenarios.md` forbids a helper that makes up for the environment, so this needs Larry's yes.
- **Q3. What does `docs/personas.md` hold?** The agent rebuilds the cast from it after a wipe.
  - *Options:* the cast and the steps in plain words, with the agent writing the code each time; or the code itself.
  - *Recommendation:* plain words. The file is read by people too, and the client API can change under stored code.
- **Q4. Does a wipe rebuild the cast's grants, or wait to be asked?**
  - *Options:* Studio asks the agent to rebuild after every wipe; or the person asks.
  - *Recommendation:* the person asks, and the agent's guidance tells it to offer when it sees a wiped Star with a cast.

## Decisions

Settled with Larry on 2026-11-13 and 14.

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | A persona is a real member of the dev Star. | A persona with no address or membership, the reverted design: each shortcut needed a rule to contain it. |
| D2 | Each persona keeps a host of its own. | One host for every tab: the tabs would share browser storage, and an unmodified app could not tell whose token to ask for. |
| D3 | A persona's address is at a domain we receive mail for, and the Worker accepts its invite. | The user-developer's own plus-addresses: a click for each persona, and each Accept leaves that persona's cookie in their browser, so Home lists it as theirs. A membership born accepted: a second way to accept. |
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
