# Every account and app has a name, a picture and a description

**Status:** Pass 1, redrafted on 2026-11-18, with no question left open; phases are not written. Larry chose a Resource on a node of the tree over the root label (D4), moved naming to after a claim is accepted (D9), and split visitors who never log in into [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 24: Visitors read what anyone may* (D6). Nothing here changes a stored shape that a later deploy cannot reach (C1, C6), so it can land before or after the wipe. It follows [archive/nebula-turn-stored-round-by-round.md](archive/nebula-turn-stored-round-by-round.md), which edited `galaxy.ts` and was built on 2026-11-19. Where its `meta` node comes from is out of date since 2026-11-22 (§ *Relationships*).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `Q` an open question, and `D` a decision. D3 is the third decision made, wherever its row sits. A gap is an item removed or answered.

## Objective

**A person names their account and each app on the first page that can write the name, adds a picture and a description whenever they like, and sees them wherever Lumenize shows a slug today.**

| Where | Today | After |
|---|---|---|
| Universe Signup | *Account name:* `northwind-traders-intl` | *Account address:* `northwind-traders-intl`.lumenize.dev |
| After accepting the emailed link | the link's page counts up the app's certificate, then Studio | the account's page asks for the account's and the app's names while it counts up, then Studio |
| Studio, upper left | `northwind-traders-intl.crm` | the app's picture, **Customer Tracker**, and *Northwind Traders International* beneath |
| The browser tab | the host | Customer Tracker |
| The account's page | each app's slug | each app's picture, name and description |

## Context

**A Universe, Galaxy or Star has no human name anywhere, so its slug does two jobs.** It is the scope's identity, spelled into its host, and it is the only thing a page can show the person who made it. Every slug is capped at 30 characters, because a persona and a Star share one 63-character DNS label ([the domain-allocation record](archive/decision-domain-allocation.md) § *C — nested scope labels*), so a person whose business is "Northwind Traders International" is told their name is too long.

**Larry asked for the names in Studio on 2026-11-18** ([small-ui-tweaks-from-driving.md](small-ui-tweaks-from-driving.md), T1): the app's name large in the upper left, the account's name beneath it, and the app's name as the tab's title. The same day he asked for room for a logo and a description, readable by anyone who reaches the account or app. Eventually that includes a visitor with no login, which Jennifer's public calendar needs.

**A name is asked for where it can be written.** Nothing derives "Northwind Traders International" from `northwind-traders-intl`, which is why this was once `data`-gated (Larry, 2026-09-29). A page that finds no name asks the next admin who opens it, so a scope created before this lands is named the same way as a new one, and pre-alpha's users are provisioned by Larry, who picks each name ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *Where pre-alpha sits*).

What stands in the way today:

- **B2. The Universe has nothing to hold a name in.** `universe.ts` is a `setUniverseConfig`/`getUniverseConfig` pair over an untyped KV blob, with no Resources plane and so no org tree.
- **B3. Studio shows slugs.** The upper left shows the scope's id, `UniverseView.vue` lists apps by slug, and nothing sets `document.title`.
- **B4. A grant names one person.** `Permissions` is keyed `(nodeId, sub)`, and `resolvePermission` looks up the caller's own `sub`. A collaborator on an app's page has passage into its Universe and holds no grant there, and a tenant's member is in the same position in the app's Galaxy.

## Goals

1. **A name is asked for by a page that can write it.** A new founder names the account and its first app on the account's page, while the app's certificate is issued, and Galaxy create's form names each later app. Today nothing asks for a name, and Signup labels the slug the account's name.
2. **Name, picture and description show wherever a person looks for them.** Studio's upper left, the tab's title, and the account's page. Today they show the slug, or nothing (B3).
3. **Whoever may change the scope changes them.** Today there is nothing to change (B2).
4. **Everyone who reaches the scope reads them.** A collaborator reads the account's, and a tenant's member reads the app's. Today neither holds a grant that would let them (B4).
5. **The Universe is a host like the other two.** It composes the Resources plane and exposes the same door and results gate as the Galaxy and the Star, and the untyped config pairs leave all three. Today the pairs are each host's only methods besides the door, and nothing in the product calls them (C3).

## Relationships

- **After [nebula-galaxy-builds-its-tree.md](nebula-galaxy-builds-its-tree.md), whose D3 and D11 this file's design follows.** The platform's own nodes come from each host's own code, never a seed, so the `meta` node and its grant to `anyone` come from each host's `onStart`, which creates them through `createNode` as the host's system principal. That file built it for the Galaxy's `chat`, `messages` and `rounds`, and removed the seed.
- **After [archive/nebula-turn-stored-round-by-round.md](archive/nebula-turn-stored-round-by-round.md)**, built and archived on 2026-11-19. It edited `galaxy.ts` too; this one adds a type to the chat ontology and deletes the config pair there.
- **Before [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 24: Visitors read what anyone may*.** The `anyone` grantee lands here, and Item 24 widens who it covers.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md) § *Shared pages*** carries this as a `deploy` row, and its § *Scope full names* points here.
- **Takes T1** from [small-ui-tweaks-from-driving.md](small-ui-tweaks-from-driving.md).

## Current state

Built already:

- **A host creates its own nodes in `onStart`, on every start.** The Galaxy's `#buildTree` calls `createNode` for `chat`, `messages` and `rounds` inside `lmz.asSystemPrincipal`. `createNode` leaves an existing node as it stands and writes a new node's starting grants in the node's own write. A node added there therefore reaches every existing tree at its next start. *Adapted:* each host's `onStart` creates `meta` with `read` for `anyone` as its starting grant (DI1, DI2, C1).
- **The Galaxy's own types are an ontology built from code.** `#chatOntologySource()` answers `chatOntologySeedRow()`, which `scripts/gen-validator-seeds.ts` regenerates. *Adapted:* the Galaxy's gains the `About` type, and the Universe gets one of its own (DI4, C6).
- **The chat has a fixed Resource id and fixed node ids.** `DEFAULT_CHAT_ID`, `CHAT_NODE_ID` and `ROUNDS_NODE_ID` in `chat-constants.ts` are constants client and server agree on, so a client reads the thread with no lookup. *Carried over:* the new Resource and its node get the same (DI1).
- **The root node's label is `'Root'`.** *Carried over unchanged:* the name lives in a Resource beneath it (D4).
- **The claim and Galaxy create take slugs only.** `claimUniverse(slug, appSlug, email, origin)` in `auth-registry.ts`, and `AuthFacade.createGalaxy(universeGalaxyId)`. *Carried over unchanged:* a name never rides either (D9).
- **A claim's link returns the founder to the first app's Studio.** `claimUniverse` stores `#scopeHome(galaxy, origin)` as the link's return, and `MagicLinkScreen` counts up the app's certificate before going there; a ticket claim accepted on Home waits on the same count-up. *Adapted:* both land on the account's page instead (DI7).
- **The account's page counts up a newly created app's certificate** before entering Studio (`HostWait`, from `App.vue`). *Carried over:* a founder names the account and the app during the same count-up (DI7).
- **The Galaxy and the Star compose `Resources`** with an ontology source. *Carried over:* the Universe composes it the same way (DI4).
- **Profile pictures.** `PUT /pictures` takes an authenticated upload, `GET /pictures/{key}` serves it publicly and immutably, and the stored value is the relative path (`apps/nebula/src/profile-pictures.ts`). *Adapted:* an account's or app's picture uses the same route under a key prefix of its own (DI5).
- **The three config pairs**, on `Universe`, `Galaxy` and `Star`. *Left behind:* deleted, with every test and scenario that probed through them re-pointed (DI9).

Missing:

1. A founder's landing on the account's page after accepting, the prompt for a missing name there and in Studio, and the name field on Galaxy create's form.
2. The `meta` node, the `About` type, and the grantee `anyone`.
3. A plane on the Universe.
4. Name, picture and description in Studio and the tab's title, and the controls to change them.

## Design intent

- **DI1. An account's or app's name, picture and description are one Resource, at a fixed id, on a node of its tree.** The id is a constant, as `DEFAULT_CHAT_ID` is, so Studio reads the Resource with no lookup wherever its node sits. Each host's `onStart` creates a node slugged `meta` beneath the root, at a fixed node id as the `chat` node's is, and the Resource is created there. The node is a convention and reserves nothing: an admin may rename it or change its grants, as with any node. Its type, `About` (D10), has a `name`, and an optional `picture` and `description`; a later field, a tagline say, is one more optional field. A change keeps its history (ADR-004) and reaches open pages through the Resource's subscription.
- **DI2. A grant to `anyone` at a node lets everyone who reaches the scope read what the node holds.** `anyone` is a grantee, written in `Permissions.sub` like any `sub`, and `resolvePermission` checks it after the caller's own `sub`. `createNode` writes `read` for `anyone` at `meta` as the node's starting grant, an ordinary grant an admin can change and one a later start does not write back. Every call that reaches a plane has passed the host's passage check (C2), so `anyone` covers exactly the callers with passage. A visitor with no login is Item 24's. An admin may grant `anyone` at any node, and only `read` (D7): `setPermission` refuses `write` or `admin` for it, with a message that says why. Every write is therefore made by someone an admin named, or under dominion.
- **DI3. Whoever may change the scope writes it.** That is dominion over the host, through the plane's bypass, or a `write` grant at `meta` that an admin gives. A Universe admin may change the account and every app beneath it; a Galaxy admin may change the app and not the account, since dominion runs downward only (ADR-015).
- **DI4. The Universe composes the Resources plane** and exposes the same `@mesh()`-decorated `resources` getter, and the same `resourcesResults` getter with no `@mesh()`, as the Galaxy and the Star. Its ontology is Nebula's own and built from code, as the Galaxy's chat ontology is, and holds `About` alone. The chat ontology gains `About`, from the same TypeScript declaration.
- **DI5. A picture is a path from the picture route,** `/pictures/{key}`, under a prefix of its own, and is served publicly as a profile picture is.
- **DI6. A scope with no name shows its slug.** Nothing is written until someone types a name, so a scope created before this lands has no such Resource. Every page treats its absence, and a refused read, as "show the slug".
- **DI7. A page that may write a name, and finds none, asks for one** (D9). The person types it there and writes it with their own token (D8). After accepting a claim, the founder lands on the account's page, whose token holds dominion over the account and its first app. They name both while the page counts up the app's certificate, and the page enters Studio once the app's host answers. Galaxy create's form, on the same page, asks for the app's name and writes it once `createGalaxy` returns. A tab closed before a name is written, and every scope created before this lands, is asked on an admin's next visit.
- **DI8. A name is for display only.** It is never in a URL, never unique, never compared and never looked up. Otherwise a scope has two identifiers, which capping the slug rather than hashing it was chosen to avoid. A persona's name already follows this rule.
- **DI9. The config pairs leave all three hosts.** A test or scenario that probed passage through a `get…Config` reads the new Resource instead, and one that probed dominion through a `set…Config` writes it. Each still tells a refusal apart by its message, so no limb loses its control.
- **DI10. Studio shows them.** On an app's page the upper left shows the app's picture and its name large, with the account's name beneath, and the tab's title is the app's name. On the account's page the header shows the account's, and each app in its list shows its picture, name and description. Whoever may change them sees editable fields; anyone else sees text.
- **DI11. Universe Signup asks for addresses, and Galaxy create for a name first.** Signup asks for the account's and the app's address, each shown as the host it spells (`northwind-traders-intl.lumenize.dev`), so the 30-character cap reads as a URL rule. Galaxy create's form asks for the name and derives the address from it as the person types (lower case, hyphens, cut at 30 characters), editable. The slug's rules and the cap are unchanged.
- **DI12. Wherever `anyone` can be granted, the guidance says who it covers.** No Studio page sets a grant, so the warning sits in the guidance the model reads, beside `setPermission` in `api-reference.md`. In a Star it covers the Star's members. In a Galaxy it covers every member of every tenant Star, and in a Universe every member of every app's Stars, so a grant on a Galaxy's chat node would show tenants the app's Studio conversation. From Item 24 it covers visitors too.

Claims the design rests on:

- **C1.** A host's `onStart` runs whenever its constructor does, and `createNode` writes a node's starting grants only when it creates the node, answering `'existing'` and writing nothing for a node already there. The `meta` node and its grant therefore reach a tree created before this lands, where the node is new.
- **C2.** Every call that reaches a scoped node's plane has passed `requirePassage` there first, so a grant to `anyone` reaches no caller without passage.
- **C3.** Nothing in `apps/nebula/src`, `packages/resources/src` or `apps/nebula-studio-ui/src` calls a config pair; every caller is a test or a `/live` scenario. `grep -rln 'UniverseConfig\|GalaxyConfig\|StarConfig' apps packages` lists them.
- **C4.** The creation teardown finishes before any page can write a name, on both paths: `settleAcceptance` runs it before answering the Accept, and `createGalaxy` before it returns. A name written afterwards is never wiped.
- **C5.** A Galaxy collaborator's call reaches the Universe, since an app's host is beneath its account's and passage runs upward.
- **C6.** A change to an ontology built from code is a new version the plane installs at its next start, and a Resource already written stays valid under a type that only gains optional fields.
- **C7.** `anyone` matches no person by accident: a person's `sub` is a UUID, and an agent or system principal's names its kind (`agent:lumenize`, `system:acme.crm`).
- **C8.** A Resource is read by its id and checked at the node it sits on, so a reader needs no node id to find it, and renaming the node changes nothing for a reader.
- **C9.** A grant a caller chose is written by `setPermission` or as one of `createNode`'s starting grants, so the refusal of a tier for `anyone` sits in the check both share. An invite writes only the invitee's own `sub`.
- **C10.** The account's host answers as soon as the account exists, since `*.lumenize.dev` covers one label (ADR-021) and no certificate is ordered for it.

## Constraints

- **[ADR-004](../docs/adr/004-snodgrass-temporal-resources.md)**: the Resource keeps every change.
- **[ADR-008](../docs/adr/008-full-org-tree-visibility.md)**: the tree stays visible to members. A grant to `anyone` covers what its node holds, and leaves the tree's own visibility unchanged.
- **[ADR-015](../docs/adr/015-passage-and-dominion.md)**: changing follows dominion, downward only.
- **[ADR-017](../docs/adr/017-the-url-is-the-view-state.md)** and **[ADR-021](../docs/adr/021-every-scope-has-its-own-host.md)**: the host spells the scope, and the name never enters a URL.
- **[ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md)**: nothing here is stored on or read from the Registry, since every page that shows a name would read it.
- **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)**: the grant to `anyone` is a grant in the tree, checked by the same check, and our own server code never skips that check on its own say-so for work a person sees. A name is written by a person (D8), so no server code writes one.
- **`ui-theming.md`** and **`ui-routing.md`** for the Studio change; the tab's title is derived from what the page shows. Studio says *account* and *app*, never *scope*.

## Beyond this task

- **A Star's name and picture** would be the same Resource in its own tree. A Star's ontology is its app's, so `About` would have to join every app's ontology. No page creates a tenant Star in pre-alpha.
- **A generated app showing its app's name and picture**, in a title bar or on its login page, reads the Galaxy's Resource by its fixed id, with the passage its pages already have. A login page shown before login needs Item 24's visitor.
- **Search across accounts and apps by description** is an index fed from each one's Resource, a cache of it under ADR-010's replication rule. It lives wherever search lives then, never on the Registry.
- **A favicon per scope** (T1's later half) can be its picture.

## Open questions

None are open.

## Decisions

Only what is settled; Pass 2 adds the rest.

| ID | Decision | Rejected alternative — why |
|---|---|---|
| D1 | **Galaxy create asks for a name, and a new founder is asked on the account's page** (Larry, 2026-09-11; the founder's half changed 2026-11-18, D9). | Signup only, with Galaxy create showing the slug: every later app would be named by its slug. |
| D2 | **The names show in Studio's upper left and as the tab's title** (Larry, 2026-11-18, T1). | Capture now, display later: pre-alpha's plan until T1. |
| D3 | **Nothing here is stored on the Registry's `Scopes`** (2026-09-29, restated 2026-11-18). | A column there, for one place to search descriptions: every page that shows a name would read the singleton (ADR-018), and search is better served by an index fed from each scope. |
| D4 | **The name, picture and description are one Resource at a fixed id, on a node slugged `meta`, which is a convention and reserves nothing** (Larry, 2026-11-18; was Q1). | The root's label: no history, no room for a picture, and members alone see the tree (ADR-008), so a visitor could read it only by a second visibility rule. A field on every node: the same limits, on every node, nearly always empty. A reserved `_meta` slug: the fixed Resource id already finds it, the grant makes it readable, and `_meta` fails the slug rule (`SLUG_RE` in `parse-id.ts`). |
| D5 | **`anyone` is a grantee, never a permission tier, and never a visitor's `sub`** (2026-11-18). | A fourth tier: it mixes who with what. A visitor whose `sub` is `anyone`: the check needs `anyone` for logged-in callers anyway, and every visitor would share one identity. |
| D6 | **Visitors who never log in are a task of their own** (Larry, 2026-11-18). | One file for all `anyone` work: the names would wait on the visitor token's security design, which nothing here needs. |
| D7 | **An admin may grant `anyone` at any node, and only `read`** (Larry, 2026-11-18; was Q3). `anyone` reaches people no admin chose. Through open Star self-signup, anyone with an email address is a tenant's member, with passage up into the app's Galaxy and the account's Universe, and from Item 24 a visitor needs no address at all. | Any tier: a write under `anyone` would let any address store what it likes. ADR-004 keeps every snapshot, so spam outlives its deletion, and it can push one object toward its 10 GB ceiling, which is an outage rather than a bill. Only at `meta`: it hard-codes a convention. |
| D8 | **A person writes the name they typed, with their own token, never `agent:lumenize`** (Larry, 2026-11-18). Naming is a person's act with a timing gap, not agent work, and the record names them. | The creation hook writing it as `agent:lumenize`, holding `write` at `meta`: one mechanism that always lands, but the record would name Lumenize's principal for a person's choice, and that principal is kept for the agent's own writes. |
| D9 | **A name is asked for on a page that may write it, whenever that page finds none, and a founder lands on the account's page after accepting a claim** (Larry, 2026-11-18; was Q2). | Typed at signup and stored on the new node until a page that may write moves it: the claim and the creation hook both change, and the account's name still waits for the account's page, since Studio holds no dominion over the account. The creator's page at Galaxy create beside a stored name at signup: two mechanisms for one job. Asked on the link's page at Accept: it runs on the platform host, which can write into no account. |
| D10 | **The type is `About`** (Larry, 2026-11-18; was Q4). It says what a reader finds inside, who this account or app is in its own words, as GitHub's About box does for a repository. | `Settings`: the word for admin configuration, so it invites fields such as a webhook URL or a billing contact onto a record anyone may read, and adding a field to the type publishes it with no grant changed. It suits the page where a person edits these, as Studio's App settings does, and stays free for an admin-only type on a node with no `anyone` grant. `Brand`: fits a name and a logo, a description less well. `Meta`: repeats the node's slug and says nothing. `Scope`: Studio never says it. |

## Criteria to carry into the phases

A draft, for Pass 2. Each criterion needs a fixture, a mutation and a positive control.

- **A founder who accepts a real claim lands on the account's page, names the account and the app there, and both names are recorded under them**; Studio then shows both. Mutation: return the link to Studio, and no page the founder reaches can write the account's name.
- **An admin who opens an account or app with no name is asked for one, and one with a name is not.** A plain member sees the slug and no prompt. Mutation: drop the absence check, and a named app asks again.
- **A collaborator reads the account's name, and a tenant's member reads the app's, with no grant of their own.** Mutation: drop `anyone` from `resolvePermission`, and both are refused.
- **A change reaches another open page without a reload.** Mutation: stop the Resource's fan-out, and the second page keeps the old name.
- **A grant of `write` to `anyone` is refused**, matched by message, and a tenant's member then cannot write at that node. Mutation: drop the tier check, and the grant lands and the write passes.
- **A Galaxy admin cannot change the account's**, matched by message. Mutation: let the write pass on passage, and it lands.
- **A tree created before the `meta` node existed gains it, and its grant, at its next start.** Mutation: create it only in a tree with no other node, and the read finds no node.
- **A collaborator still reads the name after an admin renames the `meta` node.** Mutation: find the Resource by its node's slug, and the read after the rename finds nothing.
- **The Universe exposes one door.** Its mesh entries, derived with `meshEntries(Universe)` (`apps/nebula/test/test-apps/mesh-surface.ts`), are exactly the `resources` getter. `resourcesResults` has no `@mesh()`, read off the property's descriptor, since reading the getter itself throws.
- **No limb lost its control when the config pairs went.** `drive.ts all` passes, and each re-pointed limb still reds under its own mutation.
