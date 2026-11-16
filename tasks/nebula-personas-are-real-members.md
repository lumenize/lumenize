# Personas are real members of the dev Star

**Status:** built on 2026-11-14, in a run Larry asked to go to completion on its own, and waiting for him to evaluate it. Nothing is pushed. No question is open, and § *Build notes* says what each phase decided without him. It replaces [nebula-testing-with-personas.md](archive/nebula-testing-with-personas.md), reverted on 2026-11-13 and kept under the tag `personas-v1-built`, and is item ② of [nebula-pre-alpha.md](nebula-pre-alpha.md). D1 to D18 are Larry's. D20 onward are the builder's, made without him, and § *Design intent* carries each one he would see in the product. Q5 and Q6 are answered, as D33 and D32, and built.

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

- **[nebula-pre-alpha.md](nebula-pre-alpha.md)** lists this as item ②.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md) § *The preview's error channel*** plans a tool for the model to read a blank preview's log. DI5's tool is how the agent reaches a tab, so that section keeps its log buffer and uses this tool to read it (D30). [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 10* builds on the same tool.
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

- **DI1. A persona's address is its host's own labels at the deployment's persona mail domain.** The host `gerry--dev.crm.acme.lumenize.dev` gives `gerry--dev.crm.acme@lumenize.dev`. Nothing stores the pairing, so nothing can drift from it. The domain is a zone whose catch-all rule sends its mail to the Worker, named once in the deployment's `PERSONA_MAIL_DOMAIN`:

  | Deployment | Gerry's host | Gerry's address | Who hands the Worker his mail |
  |---|---|---|---|
  | production | `gerry--dev.crm.acme.lumenize.dev` | `gerry--dev.crm.acme@lumenize.dev` | Cloudflare, by the zone's catch-all rule |
  | the test deploy | `gerry--dev.crm.acme.lumenize-test.dev` | `gerry--dev.crm.acme@lumenize.io` | Cloudflare, the same way |
  | a local stack | `gerry--dev.crm.acme.lumenize.localhost` | `gerry--dev.crm.acme@lumenize-test.dev` | a relay the stack starts, from the test mailbox (D29) |

  A mailbox name may hold 64 characters, and the mail provider refuses a longer one (C9). So where the labels run past 64, the app's two labels are replaced by 16 hex characters of their SHA-256: `gerry--dev.5f0c2a9be1d47c33@lumenize.dev` (D27).
- **DI2. The Worker's mail handler accepts a persona's invite, in plain code.** It reads the invite link from a header of a message sent to a persona's address (D20) and accepts it, as the consent screen would, with the persona's slug as its nickname. It trusts nothing in the message: the Registry must say the link is an unspent invite, issued to that very address, into the Star whose persona that address is. It keeps no cookie. A login link sent to a persona's address is dropped, so nobody signs in as one. Mail for an address that is no persona's is rejected, so its sender hears there is no such mailbox (D21).
- **DI3. A user-developer may give a real address in place of a persona's.** Its owner clicks their own Accept and signs in as themselves, and no tab in the strip opens as them: the host's address has no member behind it, so it answers 401.

### A persona's tab holds that member's token

- **DI4. A persona's host holds a session of its own, opened through the impersonation mint.** The first refresh derives the address from the host, asks the Registry who holds it at that Star, and mints for that member with the opener in `act`. It records a session for the persona that names the opener, and sets its cookie on the platform host, `__Host-refresh-token.acme.crm.gerry--dev`. Each later refresh reads that session and the opener's own from Workers KV, as any member's refresh does (D36). The opener needs dominion over the Star, which a Galaxy invite gives every collaborator (C2). A host whose address nobody holds, or whose invite is not yet accepted, answers 401.

  ```
  { sub: <Gerry's sub>, aud: 'acme.crm.dev', access: { authScope: 'acme.crm.dev' },
    act: { sub: <Austen's sub>, profileId: <Austen's profileId> } }
  ```

  Mary's token carries `scopeAdmin: true` because her membership does. No check reads `act` ([ADR-016](../docs/adr/016-record-the-acting-principal.md) § *`act` is recorded, and never decides what a call may do*), so each tab behaves as that member's own page would. The one accepted difference is that Mary's tab cannot impersonate.
- **DI14. Logging out of a persona's tab ends that tab and nothing else.** Its session was opened from the opener's, and the logout route ends every session a browser holds, so its logout disconnects it, as an impersonated client's does (`security.md`, the derived-session rule). The opener's sessions are untouched. The opener's own logout ends the persona sessions that browser holds.

### Studio shows the cast as tabs

- **DI12. The tabs come from `docs/personas.md`.** The Galaxy reads the cast's lines from the file, and Studio shows "Me" and then a tab for each slug. A cast line opens with the slug in backticks:

  ```
  - `mary` — Mary Manager. Runs the account, and sees every deal.
  - `gerry` — Gerry Salesperson. Works his own deals.
  ```

  A tab whose persona is not yet a member says so, where its page would be.

### The agent asks a tab to do persona work

- **DI5. One tool runs code in a tab.** The agent names a tab, "me" or a persona's slug, and gives code. The Galaxy hands it to one Studio tab of the poster's, Studio hands it to that tab's frame, loading the frame first if it is not open, and the frame runs it with the app's own `client` and `store` in scope and returns plain data or the error.

  ```
  run_in_tab({ tab: 'me', code: "const tree = await client.orgTree.getState(); return tree.root" })
    → { ok: true, value: 'root-node-id' }
    → { ok: false, error: 'PermissionDeniedError: …' }        the code threw
    → a tool error                                             nothing ran it, and the error says where it stopped
  Studio → frame:  { type: 'lumenize:run', id, code }
  frame → Studio:  { type: 'lumenize:ran', id, ok: true, value } or { …, ok: false, error }
  ```

  D31 has the time each leg may take and what each failure says.
- **DI13. The page spells a persona's address.** `await client.personaAddress('gerry')` answers Gerry's address from the page's own host, so no file and no model composes one.
- **DI6. The "Me" tab builds the cast.** It is the poster on the dev Star's host, holding their own token there. From it the agent invites each persona and sets each one's grants, with the calls an app would make. A persona's own tab then sets its full name on its Profile.
- **DI7. The channel exists only where it is safe.** A page answers the run-code message only when the server told it that it is a dev Star's page, it is framed by Studio, and the message comes from Studio's origin. A tenant's page never has it.
- **DI8. The agent's request is the trace.** A record names the person whose tab acted, or the persona with that person in `act`, and never the agent. The agent's own post in the chat says what it asked for. Larry, 2026-11-14: *"That's actually more honest."*
- **DI9. Nothing asks the person to confirm.** Studio carries out the agent's request when it arrives.

### What the dev Star keeps

- **DI10. The dev Star keeps what makes it a workshop.** It is born with its Galaxy under a reserved slug, a Galaxy invite makes the invitee its admin, it runs the last landed build ([ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)), and it is the one Star a wipe may touch. A persona lives only in a Star with no real users. Today that is `dev` alone, named once in `PERSONA_STAR_SLUGS`, which the host parser reads (D28).
- **DI11. A wipe keeps the cast.** A membership lives in the Registry, so after a wipe Mary, Sally and Gerry are still members, with no grants and no data. `docs/personas.md` holds what the agent needs to rebuild both from the "Me" tab. The agent's wipe builds both again in the same turn (D33).

### Claims this rests on

- **C1. No code reads `act` to decide what a call may do.** Checked 2026-11-14: the readers are the mint's root-identity gate and its client mirror. The build added a client's logout, which reads only whether `act` is there and decides no access. `run_in_tab`'s refusal of an impersonated post, which read it too, was removed 2026-11-15 (D25).
- **C2. A collaborator's `.dev` membership carries the admin bit.** Checked in the Registry's invite, which mints the sibling with `scopeAdmin` set.
- **C3. An address differing only in its local part is its own identity.** Checked: `normalizeEmail` lowercases and trims, nothing more.
- **C4. From the Galaxy's page, a plain collaborator's claims reach nothing in the dev Star.** Derived from `hasPassageInto`, and seen in Studio's own Wipe, whose comment says a collaborator is refused (D32).
- **C5. A token minted for Gerry may write Gerry's own Profile.** ADR-012 says the owner branch fires for an impersonation token. Phase 5's scenario runs it.
- **C6. A dev Star's page may run code handed to it.** Checked 2026-11-14: the page step sets `frame-ancestors` and no other content security policy (`framed` in `apps/nebula/src/entrypoint.ts`).
- **C7. A local stack can run the mail handler.** Checked 2026-11-14 in Cloudflare's docs: `wrangler dev` answers `POST /cdn-cgi/local/email` with a raw message by running the Worker's `email` handler. Phase 2's scenario runs it.
- **C8. A node can call a Studio tab and be told its answer,** with a failure when the tab has no socket or stays silent for 30 s. `mesh.md` says so. `run-in-tab.test.ts` runs both, the silent one over a real 30 s.
- **C9. A mailbox name longer than 64 characters cannot be sent to.** Measured 2026-11-14 through Resend to the test mailbox: 64 arrived, with the link header intact, and 70 and 97 were refused with a 422 before sending.

## Constraints

- **[ADR-012](../docs/adr/012-global-profile-visibility.md).** The mint needs the subject's membership accepted, so a persona's tab opens only after the handler has accepted.
- **[ADR-015](../docs/adr/015-passage-and-dominion.md) and [ADR-022](../docs/adr/022-every-session-lives-on-the-platform-host.md).** The host rule is unchanged, and it is what confines the code a tab is asked to run.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md).** A client cannot name its own actor, which is why DI8 leaves the agent off the record.
- **[ADR-003](../docs/adr/003-continuation-messaging.md).** The Galaxy's call to a Studio tab names a result handler and holds no Promise across the hop. The turn that made the call waits in memory for that handler, as it waits for the model, held by `ctx.waitUntil` (D23).
- **[ADR-021](../docs/adr/021-every-scope-has-its-own-host.md).** Persona hosts cost no certificate.
- **`live-scenarios.md`** forbids a helper that makes up for the local stack differing from production. The local mail relay is that kind of difference, and Larry said yes to it on 2026-11-14. It is safe because it rewrites nothing: it hands the local Worker's own `email` handler the message exactly as the test mailbox received it. It belongs to the local stack, which starts it, and no scenario calls it (D29).
- **`live.md`.** A scenario's persona is invited and accepted by the same handler production uses.
- **Pre-alpha has one wipe gate,** so this file need not leave the system deployable between phases.

## Beyond this task

- **Seeding at scale,** hundreds of Deals to try a list's paging or a slow query. ⚠️ Design consideration: the tool creates data one transaction at a time from a tab, which suits a cast's few records. A bulk path is its own design.
- **Personas in another Star with no real users,** `staging` say. ⚠️ Design consideration: `PERSONA_STAR_SLUGS` is the one place that says which, and the Galaxy serves a page only for `dev` today.
- **A published app's content security policy.** ⚠️ Design consideration: the run-code channel evaluates code, which a strict policy forbids. It exists only on a dev Star's page (DI7), so a published tier may set one.

## Open questions

None is open. Q5 became D33 and Q6 became D32, both on 2026-11-15.

## Decisions

D1 to D15 were settled with Larry on 2026-11-13 and 14, and D16 to D18 are his answers to the open questions. From D20 on the builder decided alone, while writing the phases and building them, and each is reversible. D19 went back to being a question, Q5.

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | A persona is a real member of the dev Star. | A persona with no address or membership, the reverted design: each shortcut needed a rule to contain it. |
| D2 | Each persona keeps a host of its own. | One host for every tab: the tabs would share browser storage, and an unmodified app could not tell whose token to ask for. |
| D3 | A persona's address is at a domain we receive mail for, and the Worker accepts its invite. D17 says which domain. | The user-developer's own plus-addresses: a click for each persona, and each Accept leaves that persona's cookie in their browser, so Home lists it as theirs. A membership born accepted: a second way to accept. |
| D4 | The mail handler accepts in plain code. | The agent reading the mail: the step needs no judgment, and inbound mail is a place for text to steer a model. |
| D5 | The host finds its member by deriving the address. | A cast record on the Galaxy: a second copy that can go stale, and a Galaxy wake on every refresh. A lookup by nickname: mutable and not unique. |
| D6 | A persona's tab gets its token from the impersonation mint, at the refresh that opens its session (D36). | A mint of its own for personas: the branch only personas reach is what drifted. |
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
| D17 | Each deployment names its persona mail domain, a zone whose catch-all rule sends mail to that deployment's Worker: `lumenize.dev` in production, `lumenize.io` for the test deploy, and `lumenize-test.dev` for a local stack, whose mail a relay hands on (D29). (was Q2; Larry said yes to the relay.) | `personas.lumenize.io`, Larry's first choice: Cloudflare gives a catch-all rule only to a zone's own name, and a subdomain takes one rule for each address. A rule made for each persona: an API token in the Worker and a rule to reap. The test mailbox's Worker passing mail on to the test deploy: production's code would carry an entry only test code calls. |
| D18 | `docs/personas.md` holds the cast and the steps in plain words. Each persona's line opens with its slug in backticks, which Studio reads for its tabs. (was Q3) | Stored code: the client API can change under it, and people read the file too. |
| D20 | The handler reads the link from a header the sender stamps on every message that carries a link: `X-Lumenize-Auth-Link: https://platform.lumenize.dev/auth/magic-link?token=…`. | Parsing the body: it needs a MIME parser in the Worker, and breaks when a provider changes how it encodes the HTML. |
| D21 | Mail to an address that is no persona's is rejected, so its sender hears there is no such mailbox. Mail to a persona's address that carries no invite into that persona's Star is dropped. | Dropping everything: a person who mistypes an address at the domain would never learn it. |
| D22 | On a persona's host the refresh hands the impersonation mint the claims it would have minted for the opener on that host, built from the opener's cookie record. The refresh keeps no rule of its own about who may open the page. | A second authorize step written for cookies: the mint's own check is the one every impersonation meets, and a mutation showed the refresh's own rule changed no outcome. |
| D23 | The Galaxy's call to a Studio tab names a result handler, and the handler wakes the turn, which waits in memory as it does for the model. A turn whose Galaxy is evicted is lost as before. The wait is temporary (Larry, 2026-11-14): its target is a turn stored round by round, where the handler continues the loop from storage ([backlog.md](backlog.md) § *Other Nebula backlog*). | A turn that can resume after eviction, built here: a task file of its own. A sentence in ADR-003 allowing the wait: an ADR describes the target, which has no wait. The transcript carried in the handler: it is large, and the rounds belong in storage. |
| D24 | The page spells a persona's address with `client.personaAddress('gerry')`, from its own host and a mail domain the served page names. | An address written into `docs/personas.md` or composed by the model: a mistyped scope is a different person. |
| D25 | The tool runs in one Studio tab of the poster's: the first by address among the tabs this Galaxy hosts that are subscribed to the chat under the poster's `sub`. A tab that ran nothing, being gone or showing no preview, is passed over for the next. One that stayed silent is not, since the code may still run there. A post written while impersonating runs the same way, in the impersonated person's own Studio, and no check reads `act` (Larry, 2026-11-15). | The tab that posted: nothing records it, and any of the person's tabs holds the same session. Every tab: the code would run once in each. A new Mesh call listing a host's connected Clients: the chat's subscriber rows already name every Studio tab. Refusing a post written while impersonating, built 2026-11-14 and removed the next day: the mint already requires dominion over the subject's whole scope, so the refusal withheld nothing. |
| D26 | A persona's tab logs out by disconnecting, wherever it is open, because a client whose token carries `act` holds a derived session. In Studio's frame it also tells Studio. | Ending the opener's sessions from a persona's tab: `security.md` forbids a derived session logging out through the one it came from. |
| D27 | Where a persona's host labels run past 64 characters, the address replaces the app's two labels with 16 hex characters of their SHA-256, and the handler checks an address by spelling it forward from the Star the Registry names, never by reading it back. | Refusing personas to an app with long names. A digest always: the common address would stop being readable. A hash that is not cryptographic: someone could name an app to collide with another's persona address. |
| D28 | Which Stars hold personas is said once, in `PERSONA_STAR_SLUGS`, which holds `dev`. The host parser reads it, so a persona's host under any other Star is no host at all. | Every reserved Star slug, as before: `prod` is one, and a persona there is a test user beside real ones (D15). A check in the refresh: a second place to say it. |
| D29 | The local mail relay is part of the local stack: `npm run dev` and the harness both start it with the stack, and it hands each message for a persona's address to the local Worker's `email` handler as it arrived. | A step a scenario calls: a scenario would then differ between venues, and a stack run by hand would never accept an invite. |
| D30 | `run_in_tab` is how the agent reads a tab, its log included. The preview's error channel in [nebula-pre-alpha.md](nebula-pre-alpha.md) keeps its buffer and drops its own tool. | A second tool for reading a tab: one page reached by a second way. |
| D31 | Each leg of a run has a bound, and each failure says where it stopped. Studio gives the frame 20 s, which covers loading it, and answers "the tab `gerry` did not answer in 20 s" or "`gerry` is not a member of the dev Star yet". The Galaxy's call to Studio is under the 30 s every call to a Client has, and says that the person has no Studio tab open, or that a tab stayed silent and the code may still run. Code that throws is `{ ok: false, error }`, which is a result and no tool error. | One bound for the whole trip: the agent could not tell a closed Studio from a slow page. |
| D32 | A collaborator may wipe the dev Star, and a wipe always goes through the agent: Studio's Wipe button goes, and the agent wipes from the asker's "Me" tab, where a collaborator is admin (was Q6; Larry, 2026-11-15). The one line he holds for a collaborator is that they see no real tenant Star's data, which `collaborator-reaches-no-tenant-star` drives. | The button asking the "Me" tab: Larry wants the agent involved in every wipe. An admin's button: a collaborator already is the dev Star's admin, and only the page the button sits on refused them. |
| D33 | A wipe's turn builds the cast and its sample data again from `docs/personas.md`, unasked, and says what it did. A turn that changes the file applies its own change (was Q5; Larry, 2026-11-15). The `define-the-cast` skill is what asks it, so the model's following it is measured and never gated: 6 of 6 runs on 2026-11-15. | Wipe only, with the cast built again on request: every persona's tab would open on an app that refuses them. Wipe, then ask: a second turn every time. |
| D34 | The wipe is `client.resources.resetDevData()`, which the agent runs in the asker's "Me" tab. It is a member of the plane's request surface and checks dominion over its host itself, so the Star's own `resetDevData` entry is gone. | A loop tool of its own: a second wait in memory on a Studio tab, which `mesh.md` refuses. The client calling the Star's entry: a host's method the library's client would have to name. The raw mesh call in the guidance: a binding name the model has no other use for. |
| D35 | After a wipe Studio no longer moves each frame to the Star's root. A frame left on a URL that names a deleted record shows what the app shows for any deleted record. | Keeping it: Studio does not hear of a wipe a tab ran, and reloading the frames mid-turn would cut off the runs that build the cast again. |
| D36 | A persona's tab holds an ordinary session: a cookie on the platform host, backed by a KV record, that lasts a day or until its opener's session ends. The first refresh opens it through the impersonation mint, and each later one reads it and the opener's own record from Workers KV, with no read of the Registry (Larry, 2026-11-15). | Two Registry reads on every refresh, as built on 2026-11-14: the one refresh that read the singleton, on a path that grows with open persona tabs (ADR-018). A KV record of a kind only personas have, or one read in place of two: each kept a persona apart from a member. |
| D37 | A session's record names who opened it, as `actor` on the Registry's index row, and every token minted from the record carries that actor as `act`. | Taking `act` from whichever admin cookie the browser sends: the session's value under the Star's own cookie name would then mint the persona's token naming nobody else. |
| D38 | A held session answers only the opener it names, and only while that opener's own record holds dominion over the Star. Another admin's browser opens a session of its own. | Checking the opener only when the session opens: a demoted or logged-out opener's persona tabs would last the day. |
| D39 | A tab run's value is carried whole. The page encodes it with `@lumenize/structured-clone`, Studio decodes it, the mesh and the record keep it, and only the model's copy is text, made in one place for every tool's result (Larry, 2026-11-15). | JSON made at the page, as built on 2026-11-14: the mesh and the stored record then carried a projection meant for a model (ADR-002). Waiting for the rounds rework: it moves only the line that writes the record, and it needs the stored value to rebuild a model's messages. |
| D40 | A value whose text for the model runs past 20,000 characters is recorded as the start of that text and a note. | Recording the long value whole: it goes into every later request of the turn and into a record every chat subscriber receives. |
| D41 | A local stack serves no built pages: its config reads an assets directory that is always empty, so a page is vite's, from source. | Reading `nebula-studio-ui/dist`: it holds what a deploy or a hand build last left, and a page loaded from it ran that old Studio against today's Worker with nothing to say so. |
| D42 | A profile is written by `client.patchMyProfile(patch)`, a merge patch by RFC 7396's rule: a field given a string is set, a field given `null` is removed, and a field left out is kept. A field given `undefined` is refused, as is a key that is no public field. `updateMyProfile` and the Profile's `writeProfile` are gone (Larry, 2026-11-15: merge in place, and name the method for it). | Replacing every field under a name that says update: the skill's first use erased a nickname. `undefined` removing a field: `{ picture: maybe }` removes one by accident. `undefined` read as left out, as JSON has it: a caller who meant to remove a field gets no error and no change. Moving the Profile onto the Resources plane now: the license line and the plane's access model still stand between them. |
| D43 | An invite that sends a persona's address anywhere but the Star it spells is refused for that invitee, at `AuthFacade.invite`, and makes no membership (Larry, 2026-11-15). | Removing the pending memberships when the mail handler drops the mail: it repairs what the invite should not have made. Leaving it: a persona could become an admin of the dev Star by a plain invite, and every permission test run as them would pass. |
| D44 | No check reads `act` to decide what a call may do, its presence included: ADR-016's presence-only exception is removed (Larry, 2026-11-15). A call that answers for a person across scopes reads the session's cookies, as Home's summary does. | Keeping the exception refused until argued: its test was last met by the retired scope summary, which now reads cookies, and it was reached for on `run_in_tab` where it withheld nothing. |

## Phases

Each phase ends with its tests mutation-checked and its notes in § *Build notes*. Nothing replaced survives beside its replacement: `personaId`, `PERSONA_NAMESPACE`, the refresh's own persona mint and the `mint` verb in the cast's procedure all go in the phase that replaces them.

1. **A persona's host mints for the member its address names.** Built in `618eba9`. `personaAddress` in `hosts.ts`; a Registry read from an address and a Star to the accepted member's `sub`; the refresh's persona branch through `mintImpersonationToken` (DI4, D22). `personaId` and `PERSONA_NAMESPACE` are deleted.
   - **Success criteria:** on Gerry's host, a browser holding an admin cookie over the Star gets a token whose `sub` is Gerry's membership's, with the opener in `act` and Gerry's own admin bit; a plain member's cookie gets 401; a host whose address nobody holds, or holds unaccepted, gets 401 (DI3); no source names `personaId`.
   - **Mutation note:** minting the opener's own `sub`; skipping the acceptance read; the opener's claims built as an admin's whatever its cookie says.
2. **The Worker accepts a persona's invite by mail.** The sender's link header (D20); `acceptPersonaInvite` beside the other acceptance writers, with `mail` as its credential; the Worker's `email` export (DI2, D21); the address's long form (D27) and `PERSONA_STAR_SLUGS` (D28); `PERSONA_MAIL_DOMAIN` in each deployment's config; the local relay (D29).
   - **Before its scenario can pass, in this order:** the test mailbox Worker is redeployed keeping each message as it arrived (done 2026-11-14, proved by C9's probe); the local relay is started by the stack. For the deployed venue: `deploy-test.sh` deploys the Worker with its `email` handler and then points `lumenize.io`'s catch-all at it, and its self-check matches `HEAD`.
   - **Success criteria:** an invite into `acme.crm.dev` sent to Gerry's address is accepted, with `gerry` as nickname and no session recorded; a login link sent there is dropped and stays unspent; an invite into another scope sent to Gerry's address is dropped; mail for an address that is no persona's is rejected; a second delivery of the same message changes nothing; a persona whose labels pass 64 characters is invited at its short address and accepted.
   - **Scenario:** `persona-host`, rewritten: a real invite to Gerry's address, accepted by the Worker's own `email` handler in both venues, then his host's refresh from an admin's browser and from a plain member's.
   - **Mutation note:** accepting without spelling the address forward from the link's Star; accepting for an address other than the link's; a spent link accepted; the link left unspent.
3. **The standing text describes a persona as a member.** B2 and B3, done here so that every later phase is checked against text that agrees with it. What changes, wherever it is said:
   - a persona has an address and an accepted membership, and its id is a member's, random like any other (ADR-010 and ADR-013's persona sentences, both `workflow.md` index lines, ADR-025);
   - a persona's token is an impersonation token, with its opener in `act` (ADR-022 § *A persona's host*, whose *Alternatives* now rejects this very design, and `auth.md` § *A Galaxy's `.dev` Star*, § *How the claims travel*, § *Identity and membership*, § *Impersonation*);
   - nothing writes to the dev Star "as the cast" on the server (`auth.md` § *When the agent acts*);
   - ADR-016 loses only its *Today's code differs* note on personas;
   - `security.md`: the refresh's persona branch among the callers of the mint, the mail handler as a third acceptance writer, and a client holding an `act` token among the derived sessions;
   - the sibling files that describe the reverted design: the persona lines of [nebula-pre-alpha.md](nebula-pre-alpha.md) and [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md), and the backlog's `persona-host` row.
   - **Success criteria:** `grep -rnE '\bpersonas?\b' docs/adr docs/vision .claude/rules CLAUDE.md` holds no sentence saying a persona has no membership, no address, a token without `act`, or an id spelled from its host; each bullet above names a diff.
4. **A page can be asked to run code.** The dev page's meta names the persona mail domain; `client.personaAddress` (DI13); the factory answers a run request from Studio's origin, on a dev Star's page, in a frame, and nowhere else (DI5, DI7); a client holding an `act` token logs out by teardown (DI14, D26).
   - **Success criteria:** code handed to a framed dev page runs with `client` and `store` and its value comes back; a throw comes back as `{ ok: false, error }` with its message; a page that is top-level, or not a dev Star's, or asked from another origin, runs nothing; `logout()` on a client whose token carries `act` navigates nowhere.
   - **Mutation note:** each of DI7's conditions removed in turn; the value returned without waiting for the code's Promise; the `act` check in logout removed.
5. **Studio shows the cast as tabs and carries a run request to one.** The Galaxy reads the cast from `docs/personas.md` (DI12); the strip of tabs, "Me" first; `StudioClient.runInTab`, which loads the tab's frame if need be, posts the request and answers with the page's answer inside its bound (D31).
   - **Success criteria:** the strip lists each slug the file names; a persona's frame holds that member's token; a run request for a tab the cast does not name, or whose page stays silent, answers with the failure D31 words.
   - **Scenario:** `persona-tabs`, in a browser, with no model: the "Me" frame is asked, as Studio asks it, to invite Gerry with `client.personaAddress` and grant him a node; Gerry's tab then opens with his token, sets his Profile's name (C5), and writes a resource whose record names Gerry with the opener in `act` (DI8).
   - **Mutation note:** the request posted to the wrong frame; a silent page answered as success.
6. **The agent has one tool that runs code in a tab.** `run_in_tab` in the loop; the Galaxy's entry, which finds the poster's Studio tab among the chat's subscribers (D25) and waits on its answer (D23).
   - **Success criteria:** a turn's `run_in_tab` reaches the poster's own Studio tab and no other person's, and the code's value is the tool's result; with no Studio tab open the tool fails within its bound and says so (C8); the Galaxy's entry has no `@mesh()`.
   - **Scenario:** `cast-from-a-tab`, with the real model, gating only on what holds whatever the model chooses. The tool's own choices gate in the lane, behind the real commit path, with the model's output scripted (`live.md`).
   - **Mutation note:** picking a tab of another person's; resolving the wait without the handler; the bound removed.
7. **The guidance teaches the cast this way.** The scaffold's `docs/personas.md` in DI12's form, the `define-the-cast` skill, the tool's description, and the reference docs (D16, D18). The procedure's `mint` step goes, and so does every line saying the cast is provisioned outside the chat.
   - **Success criteria:** the generators' checks pass; `grep -rnE 'Mint `|mint, node|provision' apps/nebula/platform apps/nebula/container/app/docs` finds nothing; the `/live` guidance scenarios this touches still pass.
8. **The closing pass.** A second sweep of phase 3's text against the built tree; the whole scenario registry locally; then a deployed pass: `deploy-test.sh` ends `matches HEAD`, the catch-all rule names the test Worker, `persona-host`, `persona-tabs` and `cast-from-a-tab` pass deployed, and the test Worker's Issues since the pass began hold nothing new.

## Non-goals

- **Seeding at scale.** § *Beyond this task*.
- **The agent acting as a persona on the server.** D14.
- **Production's mail routing.** `scripts/deploy.sh` turns Email Routing on for `lumenize.dev` and points its catch-all at the Worker when production is next deployed, at pre-alpha's wipe gate. Turning it on adds MX records and an SPF record at the zone's own name.

## Build notes

### Phase 1: a persona's host mints for the member its address names

- **For Larry.** The refresh no longer has a rule of its own that only an admin opens a persona's page. It picks the opener as it picks any page's member, and the impersonation mint refuses a plain one, by its own message. A mutation showed the old rule changed no outcome once the mint was behind it.
- **For Larry.** The `dev`-only check on a persona's host is gone too. `parseHost` already confines a persona to an environment Star, and a host with no member behind its address answers 401.
- **Retro.** `getAcceptedSubAt` asks for the membership at the host's own Star. That is for picking the right row when an address holds several, not for safety: the mint refuses a subject whose scope is not the host's.
- **Retro.** Each persona refresh costs the Registry two reads, the address's member and the mint's own read of that member. A tab refreshes every 15 minutes, and only dev tabs do this.
- **Close-out.** `personaId` and `PERSONA_NAMESPACE` are deleted. The `/live` scenario `persona-host` still describes the old token and is rewritten with phase 2, where the mail handler gives it a real member.

### Phase 2: the Worker accepts a persona's invite by mail

- **For Larry.** `lumenize.io`'s catch-all rule now belongs to the test deploy. It was disabled before, so no mail is lost, and the one literal rule there, `claude@lumenize.io`, still wins. `deploy-test.sh` sets it on every deploy. To put it back: `wrangler email routing rules update lumenize.io catch-all --enabled false --action-type drop`.
- **For Larry.** The test mailbox Worker, `email-test`, was redeployed. It now keeps each message's bytes, which the local relay hands on.
- **For Larry.** `npm run dev` now starts the relay beside `wrangler dev`, so a stack run by hand accepts a persona's invite too. It needs `TEST_TOKEN` in `.dev.vars` and says so when it is missing.
- **Retro.** C9's probe changed the design mid-phase. An address is no longer read back into a Star. The handler spells it forward from the Star the Registry names and compares, so the short form for long names needed no second code path in the handler.
- **Retro.** Mutations removed two checks the first cut had: the invite's `invited` flag, since a pending membership at a dev Star is always an invite's, and a re-check after the consume, since acceptance is idempotent. A third, the mailbox proof, had no reader anywhere, and is kept so a persona's row is in the state any member's is, with a test that now reads it.
- **Retro.** The whole mail round trip, send to acceptance, took under two seconds in every local run. The scenario runs in 8 s.
- **Not driven.** A rejected message's bounce is not asserted anywhere. The lane tests cover the handler's answer, and the Worker's one line that turns it into a rejection is untested.
- **Close-out.** `persona-host` is rewritten and passes locally with a mutation caught at each of its first five limbs. Its deployed pass is phase 8's.

### Phase 3: the standing text describes a persona as a member

- **For Larry, to read in his own voice.** ADR-022 § *A persona's host* is rewritten, and its *Alternatives* now rejects the design it first chose. ADR-010 loses its persona exception, and ADR-013, ADR-021 and ADR-025 each lose or change a sentence. ADR-016 loses its *Today's code differs* note. In `auth.md`: § *A Galaxy's `.dev` Star*, § *How the claims travel*, which now has one case of a node building claims, § *Identity and membership*, § *Impersonation*, which gains a paragraph on a persona's tab, and § *When the agent acts*.
- **For Larry.** [nebula-pre-alpha.md](nebula-pre-alpha.md) and [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) carry the other session's uncommitted edits. Their persona lines are updated in place and left uncommitted with the rest, as he asked.
- **Rules, the builder's to own.** `workflow.md`'s index lines for ADR-010 and ADR-022, and `security.md`: the refresh on a persona's host is the mint's second caller and adds no rule of its own.
- **Left for the closing pass.** `auth.md` § *When the agent acts* still says in its *Today's code differs* note that an invite is the one thing the agent does that changes who can do what. Phase 6's tool makes that false, so the note is rewritten there.
- **Routing by config.** Wrangler's own command cannot point a catch-all rule at a Worker, so the rule is declared: `addresses` in `wrangler.jsonc`, which a deploy applies. The test deploy's was applied on 2026-11-14, and `persona-host` then passed against the deployed Worker with mail routed by Cloudflare, in 169 s.

### Phase 4: a page can be asked to run code

- **For Larry.** The frame condition in DI7 is carried by one fact, where the page learns Studio's origin: the factory reads it from the page's meta only in a frame. A mutation showed a second frame check beside it changed nothing, so there is one.
- **For Larry.** A value the browser cannot copy to another window, a Vue proxy from the store say, comes back as an error telling the agent to return plain data. The channel does not convert for it.
- **Retro.** The listener waits for the client's `ready`, so code handed to a page with no session answers with the login's own reason, and a test uses that answer to show a page is listening at all.
- **Not covered here.** `client.personaAddress` and the meta that feeds it are first exercised by phase 5's scenario, on a real page. Its refusals have no test yet.
- **Close-out.** `security.md`'s derived-session rule now names both places `logout()` enforces it.

### Phase 5: Studio shows the cast as tabs and carries a run request to one

- **For Larry.** The strip, its URL parameters and their tests are the reverted build's, applied as a patch, with the cast's source changed. It now comes from `docs/personas.md` through `Galaxy.readCast`, which stores nothing.
- **For Larry.** Studio reads the cast again after every agent message, and reloads the persona frames it holds. It cannot tell which message changed the file or accepted an invite, and reading again costs one call.
- **For Larry.** An uninvited persona's tab says "sally is not a member of the workspace yet. Ask in the chat for the cast to be built."
- **Retro.** What Studio does with a run request is a class of its own, `TabRunner`, with the frames behind a small port, so its arms are unit tests and App.vue only loads, posts and listens. A page with no session now says so in its answer, which is how the runner knows to load it again later and not report a failure.
- **Retro.** Two mutations deleted code: a check that an echo of a reload request is no fresh load, since either means a client is there, and the factory's own frame check (phase 4).
- **Not driven here.** `persona-tabs` posts the run request from Studio's own page, as `TabRunner`'s port does. The path from a turn to that post, `StudioClient.runInTab` and App.vue's wiring of the runner, is phase 6's scenario, which needs the model.
- **Close-out.** `persona-tabs` passes locally in 22 s, with a mutation caught at each of its seven limbs. C5 holds on a real page: Gerry's tab wrote his own Profile.


### Phase 6: the agent has one tool that runs code in a tab

- **For Larry.** `run_in_tab` makes no chat-floor check of its own, unlike the source tools. The code runs in the poster's own Studio with their own session, and writes none of the app's source, so the check stopped nothing they could not do from the tab themself. A mutation showed no test depended on it.
- **For Larry.** With no Studio open, the tool's error is written for the model: "The person this turn is working for has no Studio tab open, so there is no tab to run code in. Say so, and ask them to open Studio and ask again." D31's "no Studio tab of yours is open" addressed the person, who does not read a tool error.
- **For Larry.** A value whose text for the model runs past 20,000 characters is replaced by the first 20,000 of that text and a note (D40). The value goes into every later request of the turn and into a record every chat subscriber receives.
- **For Larry.** A Studio tab's answer is read as data: one in neither of the page's forms is a tool error. The tab is the person's own browser, and an answer passed on unread would skip the clip.
- **Retro.** Phase 5 was committed with surface tests red: `readCast` joined the chat floor, and the inventories in `galaxy-resource-surface`, `scope-isolation` and `resources-door` did not list it. I had run the files I touched and not the suite. This phase's full run found them, and the closing run in phase 8 is the whole suite for that reason.
- **Retro.** A closed tab's subscriber row is usually reaped by the next push before a tool could meet it. The lane test closes the tab while the turn is thinking, when nothing is pushed, and asserts the row is still there before the tool runs.
- **Not driven here.** `cast-from-a-tab` is written with phase 7, since what it asks of the model is the skill phase 7 writes. C8's silent arm, a tab that holds its socket and answers nothing for 30 s, is `mesh.md`'s and has no test of this phase's.
- **Close-out.** The lane test `run-in-tab.test.ts` and the loop's unit test hold the criteria, with eleven mutations caught. The tool-args bundle is `v8`.

### Phase 7: the guidance teaches the cast this way

- **For Larry.** A reloaded page never asked for its org tree, and this phase fixes that in Mesh's client. A reload keeps the tab's id, so inside the grace period the host reports nothing lost, and the client went by that report on a load's first connection too. Now a load's first connection always establishes its subscriptions, which is what the client's docs already said. `persona-tabs` limb 6 reads the tree in a reloaded tab and reds without the fix. Any generated app's page had this on an ordinary reload.
- **Decided with Larry, 2026-11-15.** A run's value was built to come back as JSON, projected at the page for the model. It is now carried whole, and only the model's copy is text (D39).
- **For Larry.** The page waits up to 5 s for the org tree before it runs code. The tree arrives one round trip after the connection, and Studio posts a run as soon as a fresh tab says it is loaded. I argued the need from that order and did not observe it apart from the reload bug.
- **For Larry.** The skill carries code to copy: creating a node and inviting from "me", naming a persona and writing a record from its own tab, and reading through another's. The tool's description says to read the skill before the first run of a turn, and that `ok: true` does not mean a write landed.
- **For Larry.** The API reference gained `client.resources.invite`, `client.invite`, `client.updateMyProfile` (since renamed `patchMyProfile`, D42) and `client.personaAddress`. None was documented, and the model reads that file. Their blocks are `@skip-check`, as that file's others are.
- **For Larry.** The website's `auth-flows.md` § *A persona's page* still described a derived id and a token with no `act`. Phase 3's sweep covered the ADRs, the vision doc and the rules and missed it. It is rewritten.
- **Retro.** What the real model did set the changes. Asked for a deal as Gerry with the skill unread, it guessed the tree's shape, wrote TypeScript, and used all thirty-two rounds. With the description's firmer pointer it reads the skill first and finishes in a few runs.
- **Retro.** My first prompt said "do not build the app" beside a skill that said to build before the first run, and the model stopped to ask. The skill now says an app built before is ready.
- **Driven here.** The skill teaches an admin persona's invite, `client.invite(client.claims.aud, [{ email, scopeAdmin: true }])`, so `persona-tabs` gained limb 8: Manny's tab opens with the admin bit his membership holds. It also gained the reloaded tab's tree read in limb 6.
- **Not handled.** A client of the person's that is subscribed to the chat and shows no preview answers `run_in_tab` with an error, and the next tab is not tried. Studio always shows one, so only a script's client is like that; the scenario's watcher showed it under a mutation.
- **Close-out.** `grep -rnE 'Mint `|mint, node|provision' apps/nebula/platform apps/nebula/container/app/docs` prints nothing, and printed the old template's lines before. `cast-from-a-tab` passes locally in about two minutes.

### Phase 8: the closing pass

The verifier panel read phases 1 to 7 and passed none of them. Every blocker and major it raised is fixed below unless a line says otherwise. The sweep it ran beside found one more.

- **For Larry.** Phase 5 deleted Studio's Wipe button. The strip came in as a patch from the reverted build, whose design had no wipe, and I did not read what the patch removed. `dev-star-follows-the-build` found it in the sweep. The button and its call are back, and a wipe now sets every loaded frame's address.
- **Decided with Larry, 2026-11-15.** `run_in_tab` was built refusing a post written while impersonating, as the first use of the one reading of `act` ADR-016 allows. The refusal is removed. The impersonation mint requires dominion over the subject's whole scope, so code running in that person's tab gives the impersonator nothing they lack, and `act` stays attribution only. Such a post now runs in the impersonated person's own Studio, or finds no tab when theirs is closed, and the tool call's record names both people. The exception itself went later the same day, as D44.
- **Decided with Larry, 2026-11-15.** A collaborator may wipe the dev Star, through the agent and never a button (D32). What he holds for a collaborator is that they see no real tenant Star's data. No test had a real collaborator try, so `collaborator-reaches-no-tenant-star` now does, from `.dev`'s host, the app's page and the tenant Star's own host, with one mutation caught per limb.
- **Decided with Larry, 2026-11-14.** The Galaxy waits in memory on a Studio tab's answer (D23), which `mesh.md` forbade for any node. The wait stays as a temporary one, marked TEMP in `mesh.md` and at `#tabAnswers`, until a turn is stored round by round. ADR-003 is unchanged.
- **For Larry.** A persona's refresh reads the Registry twice on every refresh, where ADR-022, `raw-comm.md` and the website said a KV hit reads nothing. Each now names the exception. ADR-018 asks that no per-request path on the singleton scale with user activity: this one scales with developers' open persona tabs, each refreshing every fifteen minutes.
- **Decided with Larry, 2026-11-15.** `client.updateMyProfile` replaced all three public fields, so the skill's `updateMyProfile({ name })` erased the nickname the acceptance set. The write is now a merge patch under a name that says so (D42).
- **For Larry.** ADR-012 and `auth.md` said a membership is taken up only by a clicked Accept. Each now names a persona's as the case with no click, and why it reaches nobody else's profile. ADR-022 no longer says the refresh is the only way to a persona's token: an admin of the Star can impersonate him as any member.
- **For Larry.** A persona's tab logged out the opener's sessions on a second click. `logout()` read `act` from a token its first call had dropped. The client now remembers that it held one.
- **For Larry.** `deploy.sh` could not read `PERSONA_MAIL_DOMAIN`: macOS `sed` leaves `\s` unmatched, so it handed back the whole line and would have asked Cloudflare to enable Email Routing on it. No run had reached that line. Fixed and run by hand.
- **Fixed, Studio's tab runner.** A frame whose page last had no session was never loaded again by a later run, so "invite it, then try again" could not work within a turn. A page that had no session and then had a client was still blamed on a missing membership. A request posted to a page that then loaded afresh waited out its bound; it now fails at once and is not posted twice.
- **Fixed, the Galaxy's entry.** A tab that held its socket and stayed silent was passed over like a gone one, so code could run twice; Mesh's `ClientDisconnectedError` now says which it was. A client showing no preview is passed over. Only a tab this Galaxy hosts is asked. An error's text is cut as a value is. The record first kept a value as its JSON has it, and now keeps the value itself (D39).
- **Fixed, smaller.** `scope-hosts-its-clients` limb 4 opened a persona's host nobody had invited; it now invites Manny first. The factory asks for the frame by name again, with a test whose config names a parent origin at top level. A returned `Error` reaches the model with its name and message. `readCast` throws on any failure but a missing file. Stale comments in a dozen files, and the `act` reader list in `security.md`.
- **Fixed on 2026-11-15 (D43).** An app invite sent to a persona's address by mistake was dropped, and left a pending admin membership of the dev Star that a later plain invite then took up.
- **Not fixed.** A link spent before its acceptance settles needs a fresh invite if the handler dies between the two: a row in `backlog.md`, recorded 2026-11-15. A re-claimed scope name would give a new persona the old one's Profile, since an address row is never deleted: a row in `backlog.md` beside the email-reuse one, by Larry's choice on 2026-11-15. `entrypoint.ts`'s bounce of a message for no persona was driven nowhere, and `persona-mail-bounce.test.ts` now holds it (2026-11-15).
- **Retro.** I ran the files I touched and not the registry, twice: phase 1 broke a scenario and phase 5 deleted a button, and both waited for phase 8's sweep. `live.md` says to sweep after changing what another scenario depends on, and the refresh's persona branch was that.
- **Retro.** The panel's tab-runner findings and its Galaxy ones were all state at a boundary: a page's last word outliving the page, a request outliving its document, a silent socket read as a closed one. None was in a test I wrote, because each test started from the state I had in mind.
- **Retro.** Mutations for phase 1 were run and not written down: minting the opener's `sub`, skipping the acceptance read, and building the opener as an admin each reddened a test of `persona-host-refresh.test.ts`. `cast-from-a-tab` has one per limb: asking another person's Studio, and Studio running a persona's request in "me". `persona-tabs` limb 8 has the mint dropping the subject's admin bit.
- **Close-out, local.** The whole registry passed on the final tree: 75 of 76 in one sweep, and `grant-reveals-denied` on the rerun. That one is a flake and no fault of its own: the harness's check that Docker is reachable failed once in 2.3 s, with Docker running. The suites ran after the last edit: Mesh 1086, Resources 253 with the new `persona-address.test.ts`, the test mailbox 25, Nebula 1206.
- **Close-out, deployed.** `deploy-test.sh` ended "Test worker live and matches HEAD" at `eab02f9`, with `PERSONA_MAIL_DOMAIN` `lumenize.io`. Against it, `persona-host`, `persona-tabs`, `cast-from-a-tab` and `scope-hosts-its-clients` each passed. In `cast-from-a-tab` the model read the skill and built the cast in three runs, then made Gerry's deal in one. The test Worker's Issues since the pass began hold nothing new: `scope-deleted`, which is standing, and `teardown failed` on a Durable Object reset by the deploy, first seen on 2026-10-14.
- **For Larry, found on the way and not this build's.** `npm run audit:ui-copy` fails on `ConfirmDelete.vue`, which says "scope" in its confirmation, and has since before this build.

### After the phases: a wipe goes through the agent (2026-11-15)

Built the day after the phases, from Larry's answers to Q5 and Q6.

- **For Larry.** Studio's preview no longer returns to the app's first page after a wipe (D35). The button's handler did that, and the button is gone.
- **For Larry.** `client.resources.resetDevData()` is on every app's client, since the plane's request surface is one surface. It refuses any Star but `.dev`, and a caller with no dominion there.
- **For Larry.** The UI smoke lane's teardown clicked Wipe, best effort. It now wipes nothing, since its global setup starts from an empty store. That lane is outside `npm test` and was not run.
- **Retro.** The request surface is frozen in three tests, one of which asks for a written reason a descendant Star may reach each member. All three failed on the new member, which is what they are for.
- **Retro.** `cast-from-a-tab`'s new limb has the real model wipe and build the cast again from a collaborator's "Wipe the test data". It read `define-the-cast`, ran the reset in `me`, and built the cast again in three more runs. That it does so unasked is the model's choice, gated as that scenario's other limbs gate theirs.
- **Close-out.** `security.md` and `mesh.md` named `Star.resetDevData`, as did two backlog rows, two comments in Mesh's auth layer and the smoke test. Each now names the plane's member. `dev-star-follows-the-build` limb 4 drives a collaborator's wipe from their own "Me" tab in place of the button.

### After the phases: a persona's tab holds a session of its own (2026-11-15)

Built from Larry's answer to the two Registry reads per persona refresh: "This feels like we're going back to the situation where personas are too special. What would it take for it to have a cookie?"

- **For Larry.** ADR-022 and `auth.md` describe the session, for your pen. ADR-022 was at its size budget, so the sentence "An admin of the Star can impersonate him too." went, and the rejected alternative is in D36 here and not in the ADR.
- **For Larry.** The Registry's `RefreshTokenIndex` gains two columns, in migrations 26 and 27. The test target and production get them at their next deploy.
- **For Larry.** A developer's browser holds a cookie for each persona it opened that day, in the jar every refresh cookie shares.
- **Retro.** Three conditions on a held session could not be made to fail and were removed. The Star's name: dominion is read from the host asked on, which covers its own Star alone. Acceptance: a session opens only for an accepted member. The opener's root identity: the mint required it at the open.
- **Retro.** The Registry composed a KV record in three places, each carrying fields by hand. They are one function now, `#recordOf`, so no writer can drop the actor.
- **Retro.** Two `persona-mail` tests counted a persona's sessions after a page had opened one. Each now counts before.
- **Not driven.** Nothing ran deployed. A refresh at a colo that has not yet received the session's KV record reads the Registry once and heals, as any member's does, and no test here makes that happen.
- **Close-out.** ADR-022's exception, `raw-comm.md`, `security.md`, the website's `auth-flows.md` and `workflow.md`'s ADR-022 line each said a persona's refresh reads the Registry. None does now. `persona-host` limb 7 and `persona-tabs` limb 3 drive the session, the second in a real browser.

### After the phases: a tab run's value is carried whole (2026-11-15)

Built from Larry's answer on the run value: "we don't want to get on that slippery slope of allowing any JSON in. We want to keep using our rich type support from @lumenize/structured-clone."

- **For Larry.** The model reads what it read before, a `Map` as an array of its entries, from one function that now renders every tool's result. Two things it reads differently: a number JSON has no word for is `"NaN"`, and an object met inside itself is `"[cycle]"`, where a cycle used to fail the run.
- **For Larry.** A local stack no longer serves built pages (D41). `cast-from-a-tab`'s collaborator took the invite link at the Worker's own port, so that browser's Studio was `nebula-studio-ui/dist`, which that day held a build I had made at 09:06. It ran the old runner against the new page and dropped every value. The scenario now sends the invite from Studio's own page, as `dev-star-follows-the-build` does.
- **For Larry.** The sweep at `29e0708` passed 76 of 77. `cast-from-a-tab` failed once on a local Durable Object reset, two minutes after another session ran `npm install` in this checkout, and passed alone with nothing changed: a flake.
- **For Larry.** In one run the model wiped twice and built the cast twice in a turn, then closed with "Done — no changes." Recorded, not gated.
- **Retro.** A page from a build made before values came encoded sends none. Studio's runner fails that run and says to build again, where it would have read `undefined`.
- **Retro.** Two harness scenarios each carried a copy of the helper that asks a frame to run code. They share `lib/ask-frame.ts` now, which decodes as Studio does.
- **Not driven.** Nothing ran deployed.
- **For Larry.** The sweep at `b54a314` passed 76 of 77, and `cast-from-a-tab` failed again, for a new reason: the model read the skill, wiped, and stopped without building the cast again. That had happened in 1 of 4 clean runs on the first wording. The skill's section now opens with "A wipe is not finished until the cast is built again", and 6 of 6 runs rebuilt. The limb gates on the wipe and records the rebuild, and `nebula-pre-alpha-fast-follow.md` § *Item 20: Data-bound generation* has the findings line.
- **The closing sweep.** At `4092542`, the local sweep passed 77 of 77 in 42.9 minutes, with `redeploy-strands-no-client` parked as it runs only deployed. The wipe's turn built the cast again in that run too. Nothing from 2026-11-15 has run deployed.

### After the phases: a profile write is a merge patch (2026-11-15)

Built from Larry's answer: "Merge in place but name the method for it. Also, think about undefined vs null vs either. Maybe consider matching json merge patch semantics."

- **For Larry.** What matching RFC 7396 implies, and what I chose. `null` is the patch's word for "remove", so `null` can never be stored through this call: fine for a profile, whose fields are strings, and a profile without a picture has no `picture` at all, as the house style has it. The RFC is written over JSON, which has no `undefined`. Our wire carries one, so the call had to say what it means, and I made it an error. Read as "left out" it turns a mistaken removal into nothing at all, and read as "remove" it removes a field whenever a variable happens to be empty. That rule is one line in `changesOf` if you would rather it kept the field.
- **For Larry.** The repo already had these semantics one level down. `@lumenize/structured-clone`'s `applyMergePatch` is RFC 7396 over the codec's encoding, where a stored `null` is a tag and a bare `null` means delete. So a Profile moved onto Resources would keep this call's meaning.
- **For Larry.** A patch that changes nothing writes nothing and pushes nothing, so the same patch sent twice costs one write.
- **For Larry.** Studio's editor now removes an emptied full name with `null`, and sends a picture only when it holds one. `signup-to-first-app` limb 8 drives it.
- **Retro.** A scripted rename moved the old names in thirteen files, and three sentences around them still described the replace: the skill's step, the uploader's comment and the reference entry. Each is rewritten.

### After the phases: a persona's address is invited only into its own workspace (2026-11-15)

- **For Larry.** The check is in the facade, in the Worker, before the Registry is asked, so a refused invitee costs the singleton nothing. The other invitees in the same call are invited as before.
- **For Larry.** `persona-host` could no longer make a persona pending through the real system, which was the state its login-link limb used. That limb now mails the link while nobody holds the address, and the limb after it shows the workspace's invite making Sally a plain member.
- **For Larry.** The sweep at `8fa4d6c` passed 76 of 77. `agent-invites` failed on its last check, which I wrote on 2026-11-12: it counted every invite on the message that answered Austen's post. In that run the message answering Austen's post was the one reporting Jennifer's three invites, so they were counted as Austen's. I read that from the message's text and did not trace the turn: it is what a turn still working for Jennifer writes when it answers a later post in its closing message. The check now counts only the invites that acted for Austen's post, and two runs passed with her invite refused.
- **Retro.** A branch that skipped the Registry when every invitee was refused could not be made to fail, since the Registry logs nothing for an empty call. It is not there.
- **The closing sweep, again.** At `a89d298`, with the refusal in, the local sweep passed 77 of 77 in 42.9 minutes, with `redeploy-strands-no-client` parked. Nothing from 2026-11-15 has run deployed.

### After the phases: no check reads `act` (2026-11-15)

- **For Larry.** ADR-016's paragraph allowing a check on whether `act` is present now says there is no exception, and a row in its *Alternatives considered* holds the retired one. The wording is yours to change.
- **For Larry.** I told you the exception's test could not be met and that it had been used twice. Both were incomplete. `security.md` recorded an earlier use, the retired `scope-summary`, which answered a token with every tenancy its subject holds. There an impersonator did get more than their own dominion reaches. Home's summary replaced it and is authenticated by cookies, which an impersonation token cannot present, and the ADR and the rule now say a call of that kind reads cookies.
- **Close-out.** `security.md` § *Delegation* lost the test, its default-deny bullet and its presence-only bullet, and its reader list now says a read-side reader of `act` is a defect. No code changed. That rule's grep finds nine readers of `act` on this tree, and I read each: every one records or displays who acted, or is the mint's own gate or the client's mirror of it.

### After the phases: the day's work, deployed (2026-11-15)

- **The deployed pass.** `deploy-test.sh` deployed the test target and its self-check matched `c273550`. The scenarios this day's work wrote or touched then ran against it one at a time, and all passed: `persona-host`, `collaborator-reaches-no-tenant-star`, `signup-to-first-app`, `agent-invites`, `persona-tabs`, `cast-from-a-tab` and `dev-star-follows-the-build`. That covers the persona's session cookie, the Registry's new columns, the wipe through the agent, the run value carried whole, `patchMyProfile` and the invite refusal.
- **Workers Issues since the pass began.** One, `scope-deleted`, which `scripts/issues.mjs` lists as standing: it is every teardown's ordered abort.
- **Not run deployed.** The full sweep, which stays at the wipe gate.

### After the phases: found at the retro (2026-11-16)

Found while answering Larry's questions on the retro, with a local stack up for him to try. The `auth-flows.md` items were fixed later that day, on his word, and the bullets say what was done. The registry's sweep those edits owe waits until he is done driving, since a sweep stops his stack.

- **`auth-flows.md` § *A persona's page* contradicts itself.** One bullet says the first refresh sets Gerry a cookie on the platform host. The last says his tab "holds no cookie of its own", which was true until the session of 2026-11-15. The comment above `logout()` in `mesh-client.ts` gives the same retired reason. Derived again, what the tab does is still right, for another reason: the platform's logout ends every session the browser holds, the opener's included. The doc, both comments in `mesh-client.ts`, two in `worker-token.ts` and `security.md`'s derived-session rule now give that reason.
- **A claim-by-claim check of `auth-flows.md` against the code found more, all now fixed.** A read-only agent did it on 2026-11-16. I read the code behind each before changing the doc, and every one held:
  - The intro still says a persona's host makes two Registry reads on every refresh. Only the refresh that opens its session reads the Registry.
  - A persona's tab's logout never calls the platform's logout, so its session cookie stays until it lapses or the opener logs out. A reload of his page therefore signs him back in, which the doc now says. I read that from the code and did not drive it.
  - The invite bullet says an admin invites and the membership is minted `scopeAdmin=false`. A plain member may invite a peer into their own Star or Universe, the bit is set when an inviter with dominion asks, and an app invite also mints the `.dev` admin membership.
  - The first-login diagram has the link spent last and the KV put after acceptance. The code spends it inside `recordSessions` and puts the record before `acceptMembership`.
  - The same diagram's claim posts `cf-turnstile-response`, which the login page does not send.
  - Home is said to list the memberships the browser's cookies hold, each linking to its host. It lists every membership of each person the cookies name, and a row with no cookie in this browser goes through login.
  - "Every call passes through five security layers" is true only of a call sent on to another scoped node. A call to the client's own host node skips the Gateway's route check, and `PROFILE` and `AUTH_FACADE` have no passage step.
  - "Login never mints a membership" has one exception, the configured bootstrap address's platform membership.
  - Smaller: the routes run in the `PlatformHost` entrypoint, not the default Worker; a login sets at most 24 cookies; on a KV miss the Worker, not the Registry, puts the record back.
- **The delete confirmation counts what goes by kind (Larry, 2026-11-16).** It said "deletes 11 scopes", a word the UI never uses, and counted each app's `.dev` workspace. `deletionSentence` in Studio's `delete-summary.ts` now composes it: "this account, its 2 apps and their 6 tenants". `npm run audit:ui-copy` passes.
  - **Checked:** five mutations of the function each failed its test in `test/frontend/delete-summary.test.ts`. On Larry's running stack the app's and a tenant's confirmations showed their sentences. The account's was not driven.
  - **Not yet run:** `studio-app-settings` limb 2 now asserts both sentences. A scenario run wipes the local store, so it waits with the sweep until Larry is done driving.
- **ADR-021's landing page at the apex stays the target (Larry, 2026-11-16).** The ADR says `lumenize.dev`'s apex is a landing page for user-developers, and the code redirects it to the platform host. The redirect is now labelled TEMP in `entrypoint.ts`, `auth-flows.md` says it is for now, and `backlog.md` § *Nebula* has the row for the page.
- **That file is also agent guidance.** `apps/nebula/scripts/gen-platform.mjs` embeds every `website/docs/nebula/*.md` into the platform layer the model reads, so a stale sentence there misleads the agent as well as a reader of the website. The embed is regenerated with the fix.
- **Home offers a lone superuser nothing to do on an empty stack.** Larry signed in locally with the platform admin's address and saw his address and an unclickable `_platform` row. Home has no link to create an account and no log-out control; both are reached only by typing `/auth/login` or `/auth/logout`. Both are now T1 and T2 of [small-ui-tweaks-from-driving.md](small-ui-tweaks-from-driving.md).

## Phase Retro

Written on 2026-11-16 from the notes above, for Larry's read before the archive move.

1. **What did we learn?**
   - **A persona needed no rule of its own once it was a member.** Each special rule the first cut carried could not be made to fail, and was removed: the refresh's rule that only an admin opens a persona's page, the `dev`-only check on its host, the invite's `invited` flag, and three conditions on a held session. The mint, `parseHost` and acceptance already decided each one. The two Registry reads per refresh went the same way, once a persona's tab held a session cookie as any member's does.
   - **A reloaded page never asked for its org tree.** Mesh's client went by the host's report that nothing was lost, on a load's first connection too. Any generated app's page had this on an ordinary reload. A persona tab's reload found it, and the fix is in Mesh's client.
   - **What the real model did set the guidance.** With the skill unread it guessed the tree's shape and used all thirty-two rounds. With a firmer pointer in the tool's description it reads the skill first and finishes in a few runs. After a wipe it stopped without building the cast again in 1 of 4 runs, until the skill's section opened with that instruction, and then 6 of 6 rebuilt.
   - **A local stack served a Studio built hours earlier.** A browser that took an invite link at the Worker's own port got `nebula-studio-ui/dist`. That build ran the old runner against the new page and dropped every value. A local stack no longer serves built pages (D41).
   - **A catch-all mail rule reaches a Worker only by config.** Wrangler's command cannot set it, so `wrangler.jsonc` declares it and a deploy applies it. The mail round trip, send to acceptance, took under two seconds in every local run.
   - **Merge-patch semantics were already in the repo one level down**, in `@lumenize/structured-clone`'s `applyMergePatch`. `patchMyProfile` does not call it: a Profile is three string columns, and `changesOf` in `profile.ts` reads a patch over them by the same rules. A Profile moved onto Resources would keep the call's meaning. No production code calls `applyMergePatch` or `diff` yet.
2. **What did we struggle with?**
   - **Breaks found late.** Phase 1 changed what a persona's host answers to someone nobody invited, and `scope-hosts-its-clients` limb 4 opened such a host. Phase 5 applied the reverted build's strip as a patch, and the patch deleted Studio's Wipe button, which I did not read. Both waited for phase 8's sweep, because I ran the files I touched and not the registry. Phase 5 was committed with surface tests red for the same reason.
   - **A record outliving what it describes.** The verifier panel passed none of phases 1 to 7. Its findings in Studio's tab runner and the Galaxy's entry were of one kind: a page's last answer kept after the page loaded afresh, a request kept after its document was replaced, a silent socket read as a closed one. Each of my tests began from the state I had in mind, so none saw them.
   - **Standing text had one more home than the sweep covered.** Phase 3 rewrote the ADRs, `auth.md` and the rules, and missed the website's `auth-flows.md`, which still described a derived id. Phase 7 found it.
   - **Two things were built and then rebuilt after Larry's answers.** A run's value came back as JSON and is now carried whole (D39). `run_in_tab` refused a post written while impersonating, as the one allowed reading of `act`, and that refusal and then the exception itself were removed (D44).
   - **What I told Larry about the `act` exception was incomplete.** I said its test could not be met and that it had been used twice. `security.md` recorded an earlier use, where an impersonator did get more than their own dominion reaches.
   - **The Galaxy waits in memory for a Studio tab's answer**, which `mesh.md` forbade for any node. It stays, marked TEMP, until a turn is stored round by round.
3. **Did any tests fail unexpectedly?**
   - **The surface inventories** in `galaxy-resource-surface`, `scope-isolation` and `resources-door` failed on `readCast`, and the tests that freeze the plane's request surface failed on `resetDevData`. That is what they are for. The first time, I had committed before running them.
   - **`dev-star-follows-the-build`** failed on the deleted Wipe button, and `scope-hosts-its-clients` limb 4 on the uninvited persona's host, both above.
   - **`cast-from-a-tab` failed in three sweeps, for three causes.** The stale built Studio above. A local Durable Object reset two minutes after another session ran `npm install` in this checkout, which passed alone with nothing changed: a flake. And the model stopping after a wipe, above.
   - **`agent-invites`** failed on its last check, which I wrote on 2026-11-12. It counted every invite on the message that answered Austen's post, and in that run the message also reported Jennifer's. It now counts only the invites that acted for Austen's post.
   - **`grant-reveals-denied`** failed once and passed on the rerun: a flake. The harness's check that Docker is reachable failed in 2.3 s with Docker running.
   - **Two `persona-mail` tests** counted a persona's sessions after a page had opened one. Each now counts before.
4. **Impact on follow-on work?**
   - **A turn stored round by round** removes the wait in memory at `#tabAnswers`. Its Pass 1 is [nebula-turn-stored-round-by-round.md](nebula-turn-stored-round-by-round.md), waiting for Larry's read.
   - **`backlog.md` gained rows** for a link spent before its acceptance settles, and for a re-claimed scope name giving a new persona the old one's Profile.
   - **The ADR and `auth.md` edits the notes above list** are Larry's to read in his own voice. None is ratified.
   - **The Registry's migrations 26 and 27 migrate nothing in production.** Its next deploy is the wipe, where a fresh database runs the whole list from empty. The test target has applied both.
   - **Not run:** the full deployed sweep, which stays at the wipe gate, and the UI smoke lane, which is outside `npm test`.
   - **`npm run audit:ui-copy` failed on `ConfirmDelete.vue`**, as it did before this build. Larry chose the wording on 2026-11-16 and the audit passes; § *After the phases* has it.
   - **The sweep's own cost**, which Larry raised at this retro. The registry took 42.9 minutes locally at `a89d298`, and a sweep before each phase's commit, below, pays that per phase. `backlog.md` § *Testing & Quality* has the row.
5. **Process changes?** Judged by `calibration.md` §9: prevention goes to the failures that stayed green. A few are made and a few dropped.
   - **Made, in `/build-task` § *Implement*:** before a phase's commit, run the whole suite of each package it touched, and sweep the registry when it changed source a sweep fingerprints. `live.md` already required the sweep. The skill's "narrowest tests for the files you touched" read as the whole of a phase's testing, and I followed it.
   - **Made, in `/build-task`'s walk for what a diff displaced:** read every deleted line, and treat a deletion the task file did not ask for as a finding. The Wipe button left in a patch whose additions I read and whose deletions I did not.
   - **Made, in `/build-task`'s retirement grep:** it covers `website/docs` too, where `auth-flows.md` kept the retired design.
   - **Made, in `testing.md` § *Tests must be capable of failing*:** where a class records something about another party, a test changes that party after the record is made. The panel had found the same kind on 2026-10-06, and its prompt hunts it by name, so it was caught both times by the panel and by no test of the builder's.
   - **Dropped:** a rule for `sed` patterns that macOS reads differently. `deploy.sh`'s `\s` sat on a line no run had reached, which §9 counts as quiet. No rule loads when a shell script is edited, and the line has now been run by hand.
   - **Dropped:** writing each phase's mutations down. The skill asks for it already, and phase 1's were run.
