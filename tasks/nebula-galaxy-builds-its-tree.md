# The Galaxy builds its own tree in `onStart`, and the tree seed goes

**Status:** Pass 1, drafted 2026-11-21, split from [nebula-app-lifecycle-hooks.md](nebula-app-lifecycle-hooks.md) on 2026-11-22, and reshaped the same day by two `/review-task` Stage 1 passes. Larry read Pass 1 in full on 2026-11-23, the phases were written that day, and `/review-task` Stage 2 then raised Q17 to Q19, which Larry answered that day as D19 to D21. Routed task-file-first, though `/task-management`'s question, whether this changes how a developer uses the package, answers yes (D10, D12, D13): the signatures are pinned here with their alternatives weighed, and the docs that carry them change in the phase that builds each. It comes before nebula-query-upgrade.md, and nebula-app-lifecycle-hooks.md gives an app its hooks after that task (§ *Relationships*).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `D` a decision Larry made, and `Q` an open question. C4 is the fourth claim raised, wherever it sits. A gap is an item removed or answered. Items raised before the split keep their numbers, so a gap may also be an item that moved to nebula-app-lifecycle-hooks.md.

## Objective

**The Galaxy creates `chat`, `messages` and `rounds` in its `onStart`, on every start, and writes the agent's `write` at `chat` back when an admin has removed or lowered it. It does both as `system:acme.crm`, the Galaxy's own principal, which holds dominion over the Galaxy's scope as an admin of it does, so no grant is written for it. It reaches the tree through the calls a page makes, each checked as a page's is. `GALAXY_TREE_SEED` and protected grants go. Two calls change with them: an invite names every grant it gives, so the `read` at `chat` that an invite at `messages` brings today is named in the call and checked, and `createNode` becomes the one create, leaving a node that already exists as it stands.**

The tree it builds. A turn is one run of the agent in answer to a post, stored at `rounds` as one `Round` for each response of the model, with the calls that response made:

```text
root
└─ chat          where the agent holds `write` and a collaborator `read`, over both below
   ├─ messages   each post, a `Message`, and each landed build, a `ServedBuild`
   └─ rounds     each turn's `Round`s, which the agent writes
```

```ts
// apps/nebula/src/galaxy.ts — on every start, before the Galaxy answers any call
override async onStart() {
  // ...the Workspace and the Resources plane, as today, with no seed
  // Acts as system:acme.crm, which Mesh derives from this node's own name.
  // Mesh holds the claims in AsyncLocalStorage, as it holds a call's, so they
  // cover what this block runs and nothing after it
  this.lmz.asSystemPrincipal(() => {
    const tree = this.#resources.requests.orgTree;
    // Each step is caught by itself and logged at error, so one that throws leaves
    // the rest to run. An uncaught throw would fail every call to this Galaxy (C23)
    const step = (run: () => void) => {
      try { run(); } catch (error) {
        debug('nebula.Galaxy.onStart').error('tree setup failed', { error });
      }
    };
    // Each creates its node only where it is absent, answering { outcome: 'created' | 'existing' | 'differs' }
    step(() => tree.createNode(CHAT_NODE_ID, ROOT_NODE_ID, 'chat', 'Chat'));
    step(() => tree.createNode(MESSAGES_NODE_ID, CHAT_NODE_ID, 'messages', 'Messages'));
    step(() => tree.createNode(ROUNDS_NODE_ID, CHAT_NODE_ID, 'rounds', 'Rounds'));
    // The agent's `write` at `chat`, written only when it is missing or lower
    step(() => this.#writeAgentGrantBack(tree));
  });
  // As today: continues a turn that an eviction or a deploy cut off, detached
  // under waitUntil. It is outside the block, so that turn runs as the agent
  this.#wake();
}
```

What happens over a Galaxy's life, for the Galaxy `acme.crm`:

1. Its first construction runs `onStart` before it answers anything. The plane writes the root, and `onStart`, acting as `system:acme.crm`, creates `chat`, `messages` and `rounds`, then writes the agent's `write` at `chat`.
2. An admin renames `messages`. Every later start finds each node in place and leaves the rename as the admin left it.
3. An admin revokes the agent's `write` at `chat`, which dominion allows. The next post finds the grant missing and writes it back before the agent reads the thread, as the Galaxy's next start would.
4. The agent invites Gerry as a collaborator. The invite names `write` at `messages` and `read` at `chat`, and the door checks the inviter's `admin` at each. Today the read comes from the seed, with no check.
5. A later deploy adds a node to `onStart`. Each existing Galaxy creates it at its next start, unless an admin already uses its slug under that parent, which that start logs as an error until someone resolves it.

## Context

**Our Galaxy creates its nodes a way no app can.** `GALAXY_TREE_SEED` declares `chat`, `messages` and `turns`, which this file renames `rounds` (D18), at fixed ids and reaches `OrgTree` through a `Resources` constructor option. `#ensureSeed` writes them with `INSERT OR IGNORE` and no permission check, on every construction. `mesh.md` § *Nebula reaches its resources the way an app does* forbids this, and lists it under *Today's code differs*.

**The seed also writes grants no call names, and keeps one from every admin.** Today an owner who revokes the agent's `write` at `chat` is refused with `ProtectedGrantError`, which the `galaxy-seeds-its-chat` scenario asserts. And an invite at `messages` also grants `read` at `chat`, through the seed's `inviteAlso`, though the invite named only `messages`.

**Install code is the obvious place for the creates, and it fails for the Galaxy.** An app's nodes will be created when its Star installs a version (nebula-app-lifecycle-hooks.md), and the Galaxy's could be too. But a tree call carries no version, so one made before the first install would find no `messages` (C22). And a node added in a later deploy would reach no existing Galaxy, since the chat ontology's version changes only when the ontology does. `onStart` runs before any call on every construction, and the Galaxy's chat ontology changes only with a deploy, which constructs the Galaxy again (C21).

**The code that creates the nodes has to act as someone the tree admits.** A person's admin acts through the dominion bypass and holds no grant in the tree. The Galaxy's own code can act the same way, as `system:acme.crm`, with dominion over its scope worked out from that name. A grant at the root would have to be written, restored when revoked, and shown to every member as an admin nobody can ask.

What stands in the way today:

- **B5. `createNode` refuses a node an admin has renamed or moved.** It replays only for the same id, slug and parent, and throws `NodeIdCollisionError` otherwise (C8). Called at every start, it would fail in any tree whose admin had changed a node.
- **B6. The seed writes with no check, and protects a grant from every admin.** `#ensureSeed` writes its nodes and grants with no permission check, and `#protectedTier` refuses to revoke or lower a grant the seed marks protected (C6).
- **B7. An invite gives each invitee one tier at one node.** `invite(nodeId, invitees)` checks `admin` once at `nodeId`, and the seed's `inviteAlso` is the only way an invite grants at a second node, with no check (C16).
- **B8. A node cannot act as itself before its first call, and never with dominion.** `lmz.asLocalPrincipal` takes the name the first call stamps and refuses when there is none, though a named object knows its name from construction (C20). It never builds `scopeAdmin` (C29).

The sections that follow say what changes, the claims it rests on, and the decisions behind it.

## Goals

1. **Every node the Galaxy's pages name exists before the Galaxy answers any call,** in a new Galaxy and an old one alike, a node a later deploy adds included. Today the seed writes them at every construction.
2. **An admin's change to a node survives every later start,** except that the next post or start restores the agent's `write` at `chat` (DI11). Today the seed refuses any change to the agent's grant.
3. **The Galaxy reaches its tree only as a page can,** through the calls a page makes, each checked as a page's is, and its invite does too (D3, D10). Today the seed writes nodes and a paired grant with no check.

## Relationships

- **Before [nebula-query-upgrade.md](nebula-query-upgrade.md)** (Larry, 2026-11-22), so our Galaxy drops its seed before that task is built, and nothing more is built on the seed. Its claims that describe the seed, a protected grant or `createNode`'s throw are rewritten when this file closes.
- **Before [nebula-app-lifecycle-hooks.md](nebula-app-lifecycle-hooks.md)**, which comes after nebula-query-upgrade.md and gives an app `onStart` and `onNewOntologyVersion` exports, run in a facet. It builds on D4, D6, D8 and D9 here, and defines the object an app's hook receives, which its DI4 cites from this file today. That file is rewritten to say so when this file closes. It confirms who an app's code runs as, and D17 expects its Galaxy's `system:{scope}`, with dominion over every tenant Star, which Larry accepts as asking for diligence in that code. It is also where such a principal first writes a record a page could show, so a Profile is due there (D13).
- **Changes [nebula-accounts-and-apps-have-names.md](nebula-accounts-and-apps-have-names.md)**, whose `meta` node and its grant to `anyone` come from every scope's seed in its design. Under D3 and D11 each host's `onStart` creates them, and that file is rewritten to say so when this file closes. Its `anyone` is a grantee key that is neither a person's nor an agent principal's (D15), and no principal can be named `anyone`, since each builder accepts only its own prefix (D21).
- **Changes [tasks/on-hold/nebula-request-access.md](on-hold/nebula-request-access.md)**, which is rewritten when this file closes: a climb and its count of admins consider only a person's grant (DI16). A node's own principal acts through the dominion bypass as a person's admin does, so it adds nothing to the tree a climb reads.
- **Settles `tasks/backlog.md`'s row on a create answered wrong on repeat, for `createNode`** (D12). Whether creating and deleting a scope repeat the same way stays open there.

## Current state

Built already:

- **`MeshDO.onStart`, which the Galaxy and the Star override.** *Carried over:* the Galaxy's gains the creates and the write-back (DI8, DI11), and the Star's is unchanged. The Universe composes no Resources plane and has no tree.
- **`lmz.asLocalPrincipal`**, which builds claims with the principal as `sub`, the node as `aud`, and never `scopeAdmin`, and refuses an empty or UUID-shaped principal and a node with no stamped name. *Adapted:* renamed `lmz.asAgentPrincipal`, which takes only a `sub` of the form `agent:name` (D21), and takes the node's name from `ctx.id.name` when none is stamped (DI15). `lmz.asSystemPrincipal` joins it beside (DI5).
- **`OrgTree.#ensureSeed`, `TreeSeed`, `#protectedTier` and `ProtectedGrantError`.** *Adapted:* `#ensureSeed` writes only the root (DI11). `TreeSeed`, the `seed` option on `Resources`, `#protectedTier`, `ProtectedGrantError` and `deleteNode`'s note about protected grants go (D3, D7, D10).
- **`Resources`' host-name thunk, `lmz.instanceName`, which `OrgTree.requirePermission`'s dominion bypass reads.** *Adapted:* it reads `ctx.id.name` when no name is stamped, so `system:acme.crm`'s dominion holds on the first start (DI15, C29).
- **`GALAXY_TREE_SEED` in `chat-constants.ts`.** *Removed* (D3, D7, D10). `CHAT_NODE_ID`'s JSDoc, which links to it, is *Adapted*.
- **`TURNS_NODE_ID`, which `index.ts` and `client-index.ts` export, with the node's slug `turns` and label `Turns`.** *Adapted:* `ROUNDS_NODE_ID`, `rounds` and `Rounds`, at the same id (D18).
- **`createNode`, the Client's call to it in `client-resources.ts`, and `api-reference.md` § `createNode` with the pages that call it**: `access-control.md`, `coding-your-ui.md` and the `define-the-cast` skill. *Adapted* (D6, D12, D16): its answer is no longer the id it was given, so the tests that keep that id change too (C26). `NodeIdCollisionError` goes, and the refusal of a taken slug becomes `SlugTakenError`.
- **`setPermission`**, which upserts (C15). *Carried over unchanged:* writing a grant back reads it first, and calls `setPermission` only when it is missing or lower.
- **`NEBULA_SUB`**, the constant holding `agent:lumenize` in `packages/mesh/src/auth/types.ts`, which `@lumenize/mesh/client` exports. *Carried over;* the predicate DI16 names joins it there. A node's own principal has no constant, since Mesh derives it (D4).
- **The guidance on who holds a grant:** `access-control.md` § *Permissions table and resolution*, which says a grant's key is a person's `sub`, a bare UUID (C25), and its § *Every box in that tree is a node*, which reads a list's grants back as whom it is shared with; `api-reference.md`'s orgTree preamble; and the `wire-a-view` skill's rule that the tree is the only record of sharing. *Adapted* (DI16).
- **`inviteAlso`, `writeInviteAlsoGrants` and `#writeInviteAlso`**, which add the read at `chat` when an invite at `messages` comes back from the facade (C16). *Removed* (D10).
- **`Resources.invite` and its JSDoc's one `nodeId` per call, `ResourcesResults.onInviteResult(nodeId, tiers, result)`, `NodeInviteOutcome { nodeId, sent, failed }`, the Client's `resources.invite`, `NodeInvitee` and `_InviteStatus`,** and the guidance that teaches the call: `api-reference.md`, `access-control.md`, and the `wire-a-view` and `define-the-cast` skills. *Adapted:* each invitee names its grants (DI14).
- **`Galaxy.invite` and `#onNodeInviteOutcome`.** *Adapted:* one invite names both grants (DI14).
- **Standing guidance that states the seed's model, or that a local principal never holds dominion:**
  - `docs/vision/auth.md`, which is accepted. § *How the claims travel* names `agent:lumenize` as the first local principal and says a node builds claims itself in that one case, § *Why downward is generous for admins* says nobody can revoke the agent's seeded grant, and § *The data plane and fine-grained access control* says an invite at `messages` brings `read` at `chat`. *Adapted* with D7, D10 and D17, a change to accepted vision prose.
  - ADR-025, which says a local principal holds grants in one tree and nothing else, and protects the agent's grant; ADR-015's "a tree's skeleton excepted", which keeps the root only; and both their lines in `workflow.md`'s index. *Adapted* with D7 and D17: a node's own principal holds dominion over its scope, beside the grants-only local principal, which D21 renames the agent principal.
  - `security.md`: its list of the claims Mesh builds, whose `lmz.asLocalPrincipal` entry says never `scopeAdmin`, gains `lmz.asSystemPrincipal`; and its bullet saying the agent's reply and a landing's `ServedBuild` are checked against a protected grant changes with D7.
  - `mesh.md` § *Nebula reaches its resources the way an app does*. Its bullet on where our nodes come from was corrected to D11 on 2026-11-22, and the seed sentences of its *Today's code differs* block are *Removed* when the seed goes.
- **Tests that assert the seed's model**: the `galaxy-seeds-its-chat` scenario, whose limbs 2 and 3 expect `ProtectedGrantError` and whose limb 4 waits on the paired read; `packages/resources/test/tree-seed.test.ts` and the protected grant its `test-worker.ts` seeds; and `turn-rounds.test.ts`'s `inviteAlso` mutation. *Adapted* or removed with D3, D7 and D10. Limb 4 finds the collaborator by the `sub` their own login carries rather than by counting new grantees, which settles that limb's line in `tasks/backlog.md`'s row on `/live` limbs weaker deployed. The scenarios and tests that invite at `messages` change mechanically, naming both grants.

## Design intent

- **DI5. A node's own code acts as `system:{scope}`, holding dominion over its scope as an admin of it does** (D4, D17).
  - **Mesh derives the principal and its claims from the node's own name,** in `lmz.asSystemPrincipal(fn)`: for the Galaxy `acme.crm`, `sub` and `profileId` are `system:acme.crm`, `aud` and `authScope` are `acme.crm`, and `scopeAdmin` is true. ADR-015's predicates then give it dominion over `acme.crm` and every Star beneath it, and passage, not dominion, into its Universe.
  - **No grant is written for it,** so none is revoked, restored or shown in the tree. It acts through `requirePermission`'s dominion bypass, as a person's admin does (C19).
  - **Its claims stay in the node in this task, since nothing here calls another node as itself.** A call made inside the block starts a fresh chain with no claims, as one made under `lmz.asAgentPrincipal` does, and the node it reaches treats the Galaxy as a plain member of `acme.crm` (C30).
  - **Nothing argues for keeping them there for good, and a later task is expected to carry them across a call.** ADR-025 keeps an agent principal's claims in its node, and that principal holds grants in the one tree and nothing anywhere else, so it has nothing to reach outside it. `system:acme.crm` holds dominion over every Star beneath it, and using it means acting in another node. The far node already works out the starting node's scope from the chain Mesh stamps (C30), so it can build `system:acme.crm`'s claims itself, with nothing carried to trust. What is missing is a way for a call to say it was made inside `asSystemPrincipal`, and the first call that needs one settles it (§ *Beyond this task*).
  - **It never acts for a person,** which `agent:lumenize` does, under the claims recorded on a post. The agent stays an agent principal that holds grants and no dominion.
- **DI6. `createNode` leaves an existing node as it stands, so the Galaxy can call it at every start without undoing an admin's change** (D6).
  - **It writes the node, its edge and its starting grants in one transaction, and only when the node is absent.** An admin's rename, move or revoke therefore survives.
  - **It checks `write` at the parent, and puts each starting grant through the checks `setPermission` makes,** for a page's call and the Galaxy's alike.
  - **Starting grants are for a grant written once, when its node is created,** so a revoke stands and no eviction can leave the node without it: nebula-accounts-and-apps-have-names.md's `read` for `anyone` at `meta` is the first. They are a fifth argument, `[{ sub, tier }]`, the shape an invite's grants take with the grantee in place of the node. The Galaxy passes none, since the agent's grant is restored whenever it is found missing instead (DI11).
  - **It answers `{ outcome }`: `'created'`, `'existing'` when the node is there under that slug and parent, or `'differs'` when it is there renamed, moved or deleted** (D12, D16). A change to the label alone answers `'existing'`. An object, so a caller that kept the old answer as a node id fails to compile.
  - **A new node whose slug a sibling already holds is refused with `SlugTakenError`,** a typed error a page tells from a permission refusal by its name. Two nodes cannot share a slug under one parent, since a slug rides a URL, so this is a conflict someone resolves, not a change to leave alone.

    ```ts
    tree.createNode(MESSAGES_NODE_ID, CHAT_NODE_ID, 'messages', 'Messages');
    // { outcome: 'created' } the first time, 'existing' after, 'differs' once an admin renames it 'thread'
    ```

- **DI8. Our Galaxy's chat nodes come from its own `onStart`, on every start, as `system:acme.crm`** (D3, D11). It creates `chat`, `messages` and `rounds` through `createNode`, the call a page makes (`mesh.md` § *Nebula reaches its resources the way an app does*), so a start after the first writes nothing, and then restores the agent's `write` at `chat` (DI11). An invite to the conversation names its own `read` at `chat` (DI14). The Star creates no nodes here.
- **DI11. Each of the Galaxy's starts restores the agent's `write` at `chat`, and so does a post that finds it missing** (D8, D19).
  - **The grant is written when it is missing or below `write`, and otherwise left alone.** The write reads the grant first, since `setPermission` writes a row even for a grant already in place (C15).
  - **The restore runs after the creates, as `system:acme.crm`, through `setPermission`,** whose `admin` check its dominion passes.
  - **The plane writes only the root at every construction,** with no check, as tree bookkeeping no one person asked for (ADR-025), and again after a `.dev` wipe's rebuild (C9).
  - **The restore logs one record at `info`, naming the grant and `system:acme.crm`'s claims** (D14). A start or a post that finds the grant in place logs nothing.
  - **A post restores it before the trigger reads the thread as the agent.** `#onChatCommitted` runs the same restore as `system:acme.crm`. With the grant in place that costs one read of the tree held in memory. The post that found it missing then starts its turn.
  - **A throw from a create or the restore is caught by itself in `onStart` and logged at `error`, which raises a Workers Issue, and every later step runs, the restore included.** A `SlugTakenError` raises one at every start until someone moves one of the two nodes. An uncaught throw from `onStart` fails every call to the Galaxy, since each call constructs it again and the throw repeats (C23).
- **DI14. An invite names every grant it gives** (D10).

  ```ts
  // Galaxy.invite: one invite, one email, both grants
  await this.#resources.invite([{ email, grants: [
    { nodeId: MESSAGES_NODE_ID, tier: 'write' },  // to post
    { nodeId: CHAT_NODE_ID, tier: 'read' },       // to read each turn's rounds as well as the thread
  ] }]);
  ```

  - **Each invitee names its own grants,** so one call can give two people different tiers, as `persona-tabs` gives Gerry `write` and Sally `read` today. Each address still gets one facade invite and one email (C18).
  - **An invite at `messages` grants only what it names,** so the callers C16 names pass both grants.
  - **The door checks `admin` once at each node the grants name,** before any side effect. That replaces the one check per call that licensed a whole batch at one node.
  - **The result handler writes each grant with `setPermission` under the inviter's claims, and only where it raises what the invitee holds,** so re-inviting someone who holds `admin` at `chat` leaves it, as the paired read does today (C16). No invite writes a grant with no check.
  - **`_InviteStatus` keeps one row per address and node, one for each grant,** written in the invite's one transaction, so a query by `node` reads it as today (C17).
  - **`Galaxy.invite` still refuses a caller without dominion over the app first,** and dominion passes `admin` at every node (C19).
- **DI15. A node acts as itself from its first construction.** A first construction has no stamped name, so `lmz.asSystemPrincipal` and `lmz.asAgentPrincipal` take the node's name from `ctx.id.name` (C20), and so does the host name `requirePermission`'s dominion bypass reads, which grants nothing on an absent one (C29). The Galaxy's first `onStart` then runs its creates with dominion.
- **DI16. A person's grant is told from any other by its key's shape** (D13, D15).
  - **`@lumenize/mesh/client` exports `isPersonSub(sub)`,** true for a UUID-shaped key such as `3f2a9c1e-…` and false for `agent:lumenize`, `system:acme.crm` or `anyone`. A person's `sub` is a UUID that Mesh's auth layer mints, which Mesh already relies on (C24). `@lumenize/resources/frontend` re-exports it, since that is the one Lumenize entry a generated app imports.
  - **The guidance says what a page does with a key that is not a person's:** a request-access climb and a count of an app's admins consider only persons, and a view that lists grants shows any other key as what it names, never as a person.
  - **A node's own principal gets no Profile here,** since nothing in this file shows a record it wrote.

Claims the design rests on:

- **C6.** `#protectedTier` reads protected grants from the seed the host passed in, so a grant is protected only by a host's declaration, and no operation can make one.
- **C8.** `createNode` checks `write` at the parent, replays for the same id, slug and parent, throws `NodeIdCollisionError` for the same id under another slug or parent, and then refuses a slug a sibling already holds.
- **C9.** A `.dev` wipe drops the tree's tables and rebuilds the plane's parts, so `OrgTree`'s constructor, which writes the root, runs again (`#wipe` and `#build` in `resources.ts`).
- **C15.** `setPermission` writes with `INSERT … ON CONFLICT DO UPDATE`, so calling it for a grant already in place still writes a row.
- **C16.** `Galaxy.invite`, behind the agent's `invite` tool, is the only call in `apps/nebula/src` that invites at a node: `#resources.invite(MESSAGES_NODE_ID, [{ email, tier: 'write' }])`. The pairing fires on every invite at `messages`, though, and several `/live` scenarios invite there directly through `ctn<Galaxy>().resources.invite`. Its read at `chat` is written when the facade answers, at invite time and to the `sub` the mint returns, by `writeInviteAlsoGrants`, with no permission check, no second email, and leaving a grant already held there as it is.
- **C17.** `_InviteStatus` holds one row per address and node, and its only readers query it by `node`: `node-invite.test.ts` and the `node-invite-roundtrip` scenario. No Studio screen reads it.
- **C18.** Each node invite is a facade invite of its own, so a pending invitee invited at two nodes in two calls gets `invite-new` twice, the second carrying a fresh link (`invite-entry.ts`'s JSDoc). The shared-lists app a turn generated on 2026-11-20 shares a list that way, `read` at the list and `write` at its items.
- **C19.** `requirePermission` admits a caller holding dominion over its host at any node, through `hasDominionOverHost`, and `Galaxy.invite` refuses a caller without dominion over the app before it invites. `hasDominionOver` asks for `aud`, `authScope` and `scopeAdmin`, and that `aud` is at or above the target.
- **C20.** A named Durable Object's `ctx.id.name` is set from construction, while `lmz.instanceName` is the name the first call stamps. The Profile's `onStart` reads `ctx.id.name` for that reason, and the Galaxy's logs it. `asLocalPrincipalShared` takes `instanceName` and throws when it is absent.
- **C21.** The Galaxy's ontology source answers with `chatOntologySeedRow()`, the committed precompiled row, so its version changes only with a deploy, and a deploy constructs the Galaxy again. Its one override is a test subclass's, in `test-apps/baseline/index.ts`.
- **C22.** Tree calls carry no version: `requests.orgTree` and `subscribeTree` skip `#gateClientOp`, and `requireChatFloor` reads the tree with no install first.
- **C23.** A throw from `onStart` fails the call that constructed the object and every call after it, since each constructs the object again and the throw repeats: `mesh-do.test.ts`'s "propagates errors from onStart()", and the deployed repro in `tasks/archive/onstart-throw-isolate-hang.md`. `MeshDO`'s catch around `blockConcurrencyWhile` only logs `onStart() failed`.
- **C24.** `requireLocalPrincipalName` refuses a local principal named like a UUID, and `actForRecord` refuses a record whose `sub` is not shaped like one, both by `UUID_SHAPE` in `lmz-api.ts`.
- **C25.** `access-control.md` says a grant's key is "a bare UUID minted by Mesh's auth layer", and that grant keys are opaque user ids. No Studio screen reads the tree's grants, and coding-your-ui.md's admin check asks only about the viewer's own `sub`.
- **C26.** Several tests keep the id `createNode` returns as a node id, `query-once.test.ts`, `plane-wipe.test.ts` and `org-tree.test.ts` among them. A string-literal answer would type-check there as a `string`.
- **C27.** `anyone` is a grantee written in `Permissions.sub` in nebula-accounts-and-apps-have-names.md's design (its DI2), and it is not shaped like a person's id.
- **C28.** No tree write records the claims it ran under: `org-tree.ts` neither logs nor calls `toRecordedClaims`. The invite's records go only to the debug log, and a durable trail is deferred past pre-alpha (`tasks/backlog.md`'s row on a queryable ADR-016 trail).
- **C29.** `asLocalPrincipalShared` builds claims with no `scopeAdmin`, by a comment that says never. `Resources` hands `OrgTree` its host name as `lmz.instanceName`, and `requirePermission`'s bypass grants nothing when that name is absent.
- **C30.** `asLocalPrincipalShared` runs its block through `runWithCallContext`, which is `AsyncLocalStorage.run` in workerd (`lmz-api-context.workerd.ts`), and marks the context with a symbol no wire carries. `buildOutgoingCallContext` starts a fresh chain, with no claims, for a call made under that mark. `claimsForPassage` in `scoped-mesh-do.ts` gives a chain with no claims the scope of the node that started it, `callChain[0]`, as a plain member with no `scopeAdmin`.

## Constraints

- **[ADR-007](../docs/adr/007-shared-node-security-core.md)**: Mesh derives every node's own principal, so the Galaxy and the Star each have one by composition, with nothing written.
- **[ADR-015](../docs/adr/015-passage-and-dominion.md)** and **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)**: dominion runs downward and can revoke any grant. ADR-025 is amended so a node's own principal holds dominion over its scope, while an agent principal such as `agent:lumenize` still holds grants in one tree and no membership (D17).
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)**: only the restore logs a record (D14). Every other tree write records no claims until the tree keeps history (C28).
- **`mesh.md`** § *Nebula reaches its resources the way an app does*: our own code reaches the plane only as an app can (D3). § *Nebula platform code never drops to raw primitives* asks why no existing lifecycle method does a new hook's job, and D11 adds no hook.
- **`security.md`**: `lmz.asSystemPrincipal` joins the claims Mesh alone builds, and no other code writes `originAuth`.
- **`durable-objects.md`**: a start after the first writes nothing when every node and grant is in place, and nothing depends on the Galaxy staying awake.
- **`live.md`**: the `galaxy-seeds-its-chat` scenario is adapted, and renamed `galaxy-builds-its-tree`, rather than joined by a second one. It finds the chat nodes and the agent's grant on a new Galaxy, revokes the agent's grant as its admin and reads the tree without it, posts and finds the grant back, and invites a collaborator with one invite naming both grants. A lane test resets the Galaxy with `ctx.abort()`, which keeps storage, to see a start restore it (§ *Phase 4*).

## Beyond this task

- ⚠️ Design consideration: **a member holding `write` at a node can create a child there under any id, a fixed one our code has yet to use included** (Stage 2, 2026-11-23). A node a later deploy adds would then answer `'differs'` at every start and never land under its parent. The Galaxy's nodes here have no such window, since they exist before its first call. It matters first for a node added later and for an app's nodes, so nebula-app-lifecycle-hooks.md settles it.
- **A node's own principal acting across a call** (Larry, 2026-11-22): a Galaxy acting in one of its Stars as `system:acme.crm`, where it holds dominion, or calling its Universe, where it holds passage only. The far node builds the claims from the starting node's name (DI5), once a call can say it was made inside `asSystemPrincipal`.

## Decisions

| Decision | Alternatives weighed |
|---|---|
| **D3. The platform's own nodes are created by our hosts' own code, through the calls a page makes, as an app's are, and `mesh.md`'s rule that Nebula reaches its resources as an app does is absolute** (Larry, 2026-11-22; was Q2). What today's code still does differently sits in that section's *Today's code differs* block | The seed keeps declaring the platform's nodes, and only an app's come from its code: a split by whose node it is, with no requirement behind it |
| **D4. A node's own code acts as `system:{scope}`: `system:acme.crm` for the Galaxy `acme.crm`, `system:acme.crm.tenant1` for one of its Stars** (Larry, 2026-11-22; was Q3, the scope form from Q16). Mesh derives it from the node's name, so no constant names it. The full scope is unique anywhere and already says the tier, and the `system:` prefix keeps a record from reading as a bare scope, as Kubernetes reserves `system:` for its own control plane | `system:lumenize`, one principal for every host: a record could not say which node acted, and it needed an `admin` grant at every root. `{tier}:{slug}`, such as `galaxy:crm`: a slug is unique only among siblings, so a Star named in its Universe's tree is ambiguous. `app:crm`: "app" is Studio's word, and Mesh's middle tier may have other uses. `platform:lumenize`: `PLATFORM_SCOPE`, `_platform` and `isPlatformScope` name the root scope and `platform.lumenize.dev` the session host. `agent:lumenize`: a node our code made would read as the agent's work |
| **D6. `createNode` is the one create, and idempotent: it leaves an existing node as it stands, and writes a new node's starting grants in the node's own write** (Larry, 2026-11-22; was Q4). What it answers is D12 | A second method, `ensureNode`, beside a `createNode` that keeps throwing: the throw guards only a page's creates, which mint ids with `crypto.randomUUID()`, and the model would choose between two methods. The caller reading the tree and skipping the ids it holds: every app carries the check, and a grant written after its node is lost to an eviction between them |
| **D7. `protected` is removed: the agent's `write` at `chat` is restored when found missing or lowered, never refused to an admin** (Larry, 2026-11-22; was Q7). Dominion exists so an admin can maintain a tree, and a grant only one principal could change would veto it. A revoke lasts until the next post or start restores the grant (D19) | A grant marked protected, changeable only by the node's own principal: that principal would veto every admin's dominion. Protection kept for the agent's grant alone: it guards a revoke the product cannot undo today, at the cost of a mechanism dominion has to step around. The revoke standing until an admin grants it again: the agent could never hear the request to restore its own grant. The grant left in the Galaxy's seed: a standing exception to D3 |
| **D8. Each of the Galaxy's starts restores the agent's `write` at `chat`, and an app's `onStart` export runs after the restores, as the principal nebula-app-lifecycle-hooks.md confirms** (Larry, 2026-11-22; was Q9). Our Galaxy's `onStart` runs in-process, and an app's runs in its facet, which a Star loads at start only when the app exports `onStart`. A grant found in place is not written, and a throw is logged while the start goes on | Only when a version is installed: a revoked agent grant would stay revoked until the chat ontology's next version, which is rare. From a list each host declares, read at every start: the declarative seed D3 moved away from |
| **D9. An app's lifecycle hooks run in a facet, and the Galaxy's work runs in-process in its own `onStart` (D11), built first** (Larry, 2026-11-22) | Only the facet form, for our code and an app's alike: our Galaxy would wait on the folder, the facet and the build box before it could drop the seed, and its creates would pay a facet load for code that lives in our own Worker |
| **D10. An invite names every grant it gives, each invitee naming its own: `invite([{ email, grants: [{ nodeId, tier }] }])`** (Larry, 2026-11-22; was Q8). `Galaxy.invite` names `write` at `messages` and `read` at `chat`, each checked at the door, where today the read comes from the seed unchecked. It ends `Resources.invite`'s rule of one `nodeId` per call, whose reason was that one check licensed the batch, since the door now checks `admin` at each node named before any side effect. Nothing is stored to keep in step with the code. The one-email gain is an app's (C18): the Galaxy's paired read already came with no second email | A hook declaring a pairing through a tree method, stored in the tree: it moves the rule rather than deleting it, and since a hook only adds, a pairing a later version drops stays until something removes it. The pairing kept in the Galaxy's seed: the seed this file removes stays, and `mesh.md`'s block names it for good. One grant list every invitee shares, `invite(grants, invitees)`: giving two people different tiers takes two calls |
| **D11. The Galaxy creates its nodes in `onStart`, on every start, and never at install** (Larry, 2026-11-22, from Stage 1). `onStart` runs before any call, and the Galaxy's version arrives only with a deploy, which constructs it again (C21), so every node exists before the first call, in a new tree and an old one. `createNode`'s idempotence (D6) makes a start after the first cost reads only | `onNewOntologyVersion` on the Galaxy, called from `#install`: § *Context* says why it fails, and the plane, which holds no reference to its host, would need a seam to call it. Both, install for versions and start for code: one idempotent routine run twice on a host whose version changes only at a deploy |
| **D12. `createNode` answers `'created'`, `'existing'` or `'differs'`** (Larry, 2026-11-22; was Q11; its shape is D16). `'existing'` is the node there under the slug and parent asked for, and `'differs'` is the node there renamed, moved or deleted. Its id stays the caller's, a constant in source for a node code names: the id names the node's role, and the slug and label are what a person sees and may change, as a Windows known folder keeps its `FOLDERID_Documents` when a user renames it | The node as it stands, slug, label, parents and `deleted`: a node can have more than one parent, and every member can read the tree already. The throw kept for a mismatch, caught by the Galaxy around each create: an admin's rename reads as an error at every start. `created` alone: a copied id reads as a harmless retry. The id minted by `createNode` and the node found by its slug: an admin's rename of `messages` would make the next start create a second one and split the chat (ADR-010), and without the slug each host would store its own id, which a page would have to look up before it queried |
| **D13. A page tells a person's grant from any other by the key's shape, and a node's own principal gets no Profile until something shows a record it wrote** (Larry, 2026-11-22; was Q12). D15 names the predicate. The guidance tells a view to show any other key as what it names, and a climb or a count of admins to skip it | A Profile for the node's principal now, seeded as the agent's is: nothing reads one, since what it writes here is tree changes and the tree records no author. Pages comparing against a list of constants: a list every page carries, wrong the day another principal appears |
| **D14. Only the restore of the agent's grant logs an ADR-016 record, at `info`, since it is written back at a start nobody caused** (Larry, 2026-11-22; was Q13). Every other tree write records no claims until the tree keeps history, where each node, edge and grant would be a row carrying the claims that wrote it (`tasks/on-hold/wire-merge-patch-sync.md` § *Option B with the tree's rows as resources*), which is undecided until that task is picked up after pre-alpha | Every tree mutation logging one record now: lines deleted once the rows carry their claims, for writes a page makes in a call that a person can account for. None logging: a restore nobody asked for would leave no trace when someone asks why the agent's grant came back |
| **D15. The predicate is `isPersonSub(sub)`, true for a UUID-shaped key, exported from `@lumenize/mesh/client`** (Larry, 2026-11-22; was Q14). A climb and a count of admins ask whether a grantee is a person, and a person's `sub` is the one key shape Mesh guarantees. `anyone` (nebula-accounts-and-apps-have-names.md) is then neither a person nor an agent principal, and a view shows it as what it names | `isLocalPrincipal(sub)`, true for any key not shaped like a UUID: true for `anyone` too, so the guidance would have a view hide a public `read` and a climb skip it. `isLocalPrincipal` testing for a colon in a required `kind:name`: every page still handles `anyone` apart. A Client helper that answers a node's grantees already sorted: more than any caller asks today, and it presupposes `anyone` |
| **D16. `createNode` answers an object, `{ outcome }`, whose outcome is `'created'`, `'existing'` or `'differs'`, and refuses a slug a sibling holds with `SlugTakenError`** (Larry, 2026-11-22; was Q15). A caller that kept the old answer as a node id fails to compile (C26), and a slug our code needs held by another node stays loud until someone resolves it | A bare string: `'created'` is a string, so every line that kept the id compiles and passes it on as a node id. A taken slug answering `'differs'`: a conflict someone has to resolve would read as an admin's harmless rename, and our node would silently never exist. A fourth outcome, `'slug-taken'`: the Galaxy would ignore it with the others unless it logged that one apart |
| **D17. `system:{scope}` holds dominion over its scope and passage above it, worked out from its name as for an admin of that scope, with no grant written anywhere; ADR-025 is amended for it** (Larry, 2026-11-22; was Q16). A Galaxy's own code may act freely in its child Stars, as the Galaxy's admins may. Its claims stay in the node in this task, and nothing argues against a later task carrying them across a call (DI5). An app's code is expected to run as its Galaxy's `system:{scope}`, which nebula-app-lifecycle-hooks.md confirms: it then holds dominion over every tenant Star, and Larry accepts that this asks for diligence in that code | `system:lumenize` with `admin` granted at every root: a grant to write at every construction, restore when revoked, and show every member as an admin nobody can ask. Dominion always denied, the node a plain member of its own scope: every create would need a grant written first. An app's code under a principal of its own, narrower than dominion: a second root grant in every Star, for the same power over its tree |
| **D18. The node that holds each turn's `Round`s is named `rounds`, its constant `ROUNDS_NODE_ID`, and its id stays** (Larry, 2026-11-23). `messages` is named for the `Message` type stored there, and this node stores only `Round`s: a turn is a KV row on the Galaxy while it runs, never a Resource. A Galaxy made before the rename keeps the slug `turns`, so its `createNode` answers `'differs'` until pre-alpha's wipe, and rounds still land there by id | `turns` kept: the node reads as holding a `Turn` type that does not exist, and Larry asked twice what it held. A new id with the new name: every stored `Round` would sit at a node no code names |
| **D19. A post that finds the agent's `write` at `chat` missing restores it before the agent reads the thread** (Larry, 2026-11-23; was Q17). No UI revokes the grant, so only code on a Client reaches that state, and the check is one read of the tree held in memory | Catch the refused read, restore and retry: `doRead` logs each refusal at `error` before the catch sees it, so every message in the thread raises a Workers Issue first. One `warn` and no turn: the poster waits for a start nobody can cause. The Galaxy aborting itself: a restart for what one write does |
| **D20. An invite and the restore compare a grant against the tier that reaches the node through its ancestors** (Larry, 2026-11-23; was Q18). Gerry holds `admin` at `chat` and is invited with `write` at `messages`: no row is written, and a revoke at `chat` ends his posting too. `checkPermission` answers it, read for every grant before the invite writes any | The grant at the node itself: Gerry gets a `write` row at `messages` that changes nothing until a revoke at `chat` leaves him posting, and it needs a reader `OrgTree` lacks |
| **D21. The prefix of a `sub` says which kind of principal it is, and each kind has its own builder** (Larry, 2026-11-23; was Q19). `lmz.asSystemPrincipal(fn)` builds `system:acme.crm` from the node's name, and `lmz.asAgentPrincipal(sub, fn)` takes only a `sub` of the form `agent:name`, such as `agent:lumenize`. A system principal is a node's own, with dominion and no grant. An agent principal holds grants and no dominion, and is what ADR-025 called a local principal, renamed there and wherever the term is used, since the agent is its one case. Another kind, a webhook's say, gets its own prefix and builder when one is needed | `system:` refused by `asLocalPrincipal`: a list of one name to refuse, where the prefix can say the kind outright. Any `kind:name` accepted with the term kept: the prefix would say only that the principal is no node. `local:lumenize`: the `sub` would name our mechanism, not what the principal is |

## Open questions

None open. Stage 2's Q17 to Q19 are D19 to D21.

## Phases

Each phase leaves the suites green, and a doc changes in the phase that changes what it teaches. `/review-task` Stage 2 reviewed these on 2026-11-23, and what it left for Larry is answered as D19 to D21.

### Before the first phase

- **nebula-query-upgrade.md's doc drafts are out of the tree** (Larry, 2026-11-23). They sat uncommitted in `website/docs/nebula/*.md` and the `define-the-cast` skill, and failed `apps/nebula`'s embed drift check. That file's § *Doc drafts* now holds them as diffs, so this build edits and embeds the docs as they are built.
- **Every phase ends the same way:**
  - `npm run type-check` passes, and so does `npm test` in each package the phase touched. In `apps/nebula` that is `npm test`, never a bare vitest run.
  - A phase that edits `website/docs/nebula/` or `apps/nebula/platform/` runs `node scripts/gen-platform.mjs` in `apps/nebula`, commits the embed with the edit, and runs `npm run test:doc`.
  - A test written in the vitest lane says in its header why it needed no running system (`live.md`).
  - No task-file handle ships in source: the grep in `workflow.md` § *Referring to things across files* prints none over the changed files.
  - Each prose file edited passes `node scripts/check-prose.mjs`, and each file edited passes the byte count for NUL and NBSP.
  - The phase is committed by pathspec.
- **The grep criteria read one set of trees.** Each was run against today's tree on 2026-11-23, where it prints what its phase removes. The suites and the scenarios were not run.

  ```sh
  # Source, tests, scenarios, docs and standing guidance: an array, so zsh splits it
  SRC=(apps/nebula/src apps/nebula/platform apps/nebula/test apps/nebula/harness/scenarios \
    apps/nebula/harness/lib packages/*/src packages/*/test website/docs docs/adr \
    docs/vision .claude/rules)
  ```

### Phase 1: a node acts as itself, with dominion over its scope

**Goal:** Mesh builds `system:{scope}`'s claims for a scoped node from its first construction, names each kind of principal by its prefix, and exports the test that tells a person's key from any other (DI5, DI15, DI16, D21).

- **`lmz.asSystemPrincipal<T>(fn: () => T): T` joins `asAgentPrincipal`** on `LmzApi` and on both implementations in `packages/mesh/src/lmz-api.ts`. For a node named `acme.crm` it runs `fn` through `runWithCallContext` under `sub` and `profileId` `system:acme.crm`, `aud` and `authScope` `acme.crm`, and `scopeAdmin: true`. The scope is `parseId(name).raw`.
- **`asLocalPrincipal` becomes `asAgentPrincipal`, and takes only `agent:name`** (D21). `requireLocalPrincipalName` becomes `requireAgentPrincipalName` and refuses any `sub` that is not `agent:` and a name, which covers the empty and the UUID-shaped ones it refuses today. `asLocalPrincipalShared` and the context kind `'local-principal'` are renamed with it, the kind to `'agent'`. The rename is checked as `workflow.md` § *Symbol renames* says, every changed comment line is read, and one grep proves it:

  ```sh
  # Prints only ADR-025's Terminology line, which names the term it replaced
  grep -rniE 'local[ -]principals?|LocalPrincipal' "${SRC[@]}"
  ```

- **It marks its context with a kind of its own, `'system'`.** `buildOutgoingCallContext` starts a fresh chain with no claims for any context that carries a kind, and `CONTEXT_KIND`'s JSDoc says that nothing reads which kind yet.
- **It throws for a node with no scope of its own, decided by the node's kind and never by what its name parses as.** A `MeshWorker` has no name. An `UnscopedMeshDO` is refused by `doInstance[UNSCOPED_NODE]`, even one constructed under a name shaped like a scope. `parseId` refuses every other name that is no scope, the platform root's included.
- **Both methods take the node's name from `ctx.id.name` when none is stamped,** in the Durable Object implementation: `this.instanceName ?? ctx.id.name`, with JSDoc at the site saying why (C20).
- **`isPersonSub(sub: unknown): boolean` sits beside `NEBULA_SUB`** in `packages/mesh/src/auth/types.ts`, exported from `index.ts` and `client-index.ts`, and `packages/resources/src/frontend-index.ts` re-exports it. It answers false for anything that is not a string. `UUID_SHAPE` moves there, and `actForRecord` calls the predicate, so one test decides the shape (C24).
- **The guidance that says where claims come from changes here:**
  - `security.md`'s list of the claims Mesh builds gains `lmz.asSystemPrincipal`: what it builds, that a call made inside starts a fresh chain, and when our code may use it. A block under `asSystemPrincipal` runs only the node's own bookkeeping, which no person asked for. It never runs work that a caller's call asked for, or work whose result is shown as someone's (DI5).
  - ADR-025 renames the local principal the agent principal, in its title and its Terminology, which names what the term replaced as ADR-015's does. It gains the system principal beside it, a node's own, with that same rule. `system:{scope}` holds dominion over its scope, worked out from its name, and no grant. The ADR says a call made under its claims starts a fresh chain, and does not say they never leave the node (DI5). What it said of a local principal stays true of an agent principal.
  - Every other file that says local principal follows: ADR-015, ADR-016, `security.md`, `mesh.md`, `docs/vision/auth.md` and `workflow.md`'s index.
  - `workflow.md`'s index line for ADR-025 says both halves, and its ADR-010 line names `system:acme.crm` beside `agent:lumenize`.
  - ADR-015 § *Predicate pair* names a node's own principal among the sources of `scopeAdmin`, in its list and its code block, reworded to stay inside the ADR's 13 KB. `hasDominionOver`'s JSDoc in `parse-id.ts` says the same.
  - `mesh.md` § *Passing data to the callee* says claims are built by the builders `security.md` lists, in place of naming `lmz.actFor` and the builder this phase renames.
  - `docs/vision/auth.md` § *How the claims travel* names the second case in which a node builds claims. Its § *The data plane and fine-grained access control* says `scopeAdmin` comes from a membership or, for a node's own principal, from Mesh.

**Success criteria (capable of failing):**

- In `packages/mesh/test/claims-forms.test.ts`, on a scoped node named `acme.crm`, the claims inside the block are exactly those above. `hasDominionOver` holds over `acme.crm` and `acme.crm.tenant1`, and fails over `acme` and over `acme.crm2`. `hasPassageInto` holds into `acme`.
- A call made inside the block reaches its callee with no claims and with the caller as `callChain[0]`. Code after the block sees the context it had before it.
- A node whose `onStart` calls `asSystemPrincipal`, and one whose `onStart` calls `asAgentPrincipal`, each store the claims it ran under at its first construction, before any call has stamped a name. Both name the scope `ctx.id.name` spells.
- An `it.each` covers the refusals, each asserting its own message: a `MeshWorker`, an `UnscopedMeshDO` constructed under the name `acme.crm` through a raw stub, and a scoped node named for the platform root.
- An `it.each` over what `asAgentPrincipal` refuses, each with a message naming the form it wants: `system:acme.crm`, `webhook:stripe`, `lumenize`, `agent:`, the empty string and a UUID. `agent:lumenize` runs its block.
- `isPersonSub` answers true for a v4 UUID in either case. It answers false for `agent:lumenize`, `system:acme.crm`, `anyone`, the empty string, and an object whose string form is a UUID.

**Mutation notes:** drop `scopeAdmin` and the dominion assertions fail. Read `instanceName` alone and both `onStart` cases throw. Start a fresh chain for `'agent'` alone and the callee sees `system:acme.crm`'s claims. Decide the refusal by the parse and the unscoped node under `acme.crm` runs its block. Derive the scope without `parseId` and the platform-root row runs its block. Have `isPersonSub` test for a missing colon and `anyone` answers true. Accept any `kind:name` in `asAgentPrincipal` and the `system:acme.crm` row runs its block.

### Phase 2: `createNode` is the one create

**Goal:** a create leaves a node that exists as it stands and says what it found, so code can call it at every start, and the plane knows its host's name from construction (DI6, DI15).

- **`OrgTree.createNode(nodeId, parentNodeId, slug, label, grants?)` answers `{ outcome }`,** in `packages/resources/src/org-tree.ts`, and writes only when the id is absent:
  - `'existing'` when the id is there, not deleted, under that slug, with an edge from that parent. A different label still answers `'existing'`.
  - `'differs'` when the id is there renamed, moved or deleted.
  - `'created'` when the id was absent. The node, its edge and its starting grants go in one transaction.
- **The checks run before the id is looked up:** the parent exists, and the caller holds `write` there. When `grants` is non-empty the caller also passes what `setPermission` checks, asked at the parent, whether or not the node exists. Both methods call one private check for that, so a rule added to one binds the other. An absent or empty `grants` asks only `write`.
- **`grants` is `Array<{ sub: string; tier: PermissionTier }>`, checked for shape before any write,** each refusal with its own message: it is an array, each `sub` is a non-empty string, and each tier is in the vocabulary. None of it is written for a node that exists.
- **Each starting grant is a plain `INSERT` inside the node's transaction,** so a `sub` named twice fails the whole write, with a message naming it, and creates no node.
- **A slug a sibling holds is refused with `SlugTakenError`,** a typed error in `errors.ts`, exported as `PermissionDeniedError` is. `checkSlugUniqueness` throws it, so a rename or a move into a taken slug answers the same error. `NodeIdCollisionError` goes, with its exports.
- **`Resources` reads its host's name in one private place, `this.#lmz().instanceName ?? this.#ctx.id.name`,** which it hands the tree and `Subscriptions` as their thunk and calls in `doQuery` (C29).
- **The Client's `orgTree.createNode` in `client-resources.ts`** takes the fifth argument and resolves to `{ outcome }`.
- **Every caller that kept the answer as a node id mints the id first.** `npm run type-check` names each (C26): tests under `apps/nebula/test` and `packages/resources/test`, the harness's scenarios, and `test-apps/baseline/index.ts`.
- **Docs:** `api-reference.md` § `client.orgTree` gives the signature, the outcomes and `SlugTakenError`, and loses `NodeIdCollisionError`. `access-control.md`, `coding-your-ui.md` and the `define-the-cast` skill change wherever an example reads the answer, and `for-docs.test.ts` changes with the blocks checked against it.
- **The `galaxy-seeds-its-chat` scenario gains a limb for the create,** since a page's call is where `{ outcome }` and `SlugTakenError` are read.

**Success criteria (capable of failing):**

- In that limb the owner's create answers `'created'` and its repeat `'existing'`. After a rename the same create answers `'differs'`. A create under a slug a sibling holds is refused by the name `SlugTakenError`.
- In the lane, a repeat leaves the tree's rows as they were. After an admin moves the node under another parent, or deletes it, the same create answers `'differs'` and changes nothing. After a relabel alone it answers `'existing'`. `renameNode` into a taken slug rejects as `SlugTakenError`.
- A create with `[{ sub, tier: 'read' }]` by a caller holding `admin` at the parent writes the grant with the node. The same call by a caller holding only `write` there is refused with `PermissionDeniedError` and creates no node, and it is refused the same way for a node that exists. That caller passing `[]` creates the node.
- A repeat after the grant was revoked answers `'existing'` and does not write it back.
- An `it.each` covers the shape refusals of `grants`, each asserting its own message and that no node was created.
- A create whose `grants` name one `sub` twice rejects, and the node does not exist afterwards.
- A caller without `write` at the parent is refused whether or not the id exists.
- In `packages/resources/test`, a host whose `onStart` creates a node inside `lmz.asSystemPrincipal` finds the node on its first call. The builder adds a `doQuery` to that block if the fixture's ontology is installed by then, and otherwise records in the build notes that nothing can query before a name is stamped.
- `npm run test:doc` passes and `gen-platform.mjs --check` reports no drift.

**Mutation notes:** answer `'existing'` for every id found and the rename, move and delete cases fail. Write `grants` for a node that exists and the revoked grant comes back. Ask only `write` when `grants` is given and the `write`-only caller's node lands with its grant. Write the grants after the node's transaction and the twice-named `sub` leaves a node behind. Keep the plain error for a taken slug and the name assertions fail. Read `instanceName` alone in the plane's reader and the `onStart` create is refused.

### Phase 3: an invite names every grant it gives

**Goal:** one invite gives a person grants at more than one node, each checked at the door, and no grant is written that no call named (DI14).

- **`NodeInvitee` becomes `{ email: string; grants: Array<{ nodeId: string; tier: PermissionTier }> }`,** and the `nodeId` argument goes from `Resources.invite`, `ResourcesRequests.invite` and the Client's `resources.invite`.
- **The shape check refuses the whole call, before any side effect, each case with its own message:** invitees that are not an array, an entry with no grants, a `nodeId` that is not a string, a tier outside the vocabulary, an address named twice, and a node named twice for one address. Each duplicate check compares the address as the Registry normalizes it. A first argument that is a node id is told that the call now takes invitees naming their grants, since code written before this phase sends that. A malformed address stays one invitee's error.
- **The door calls `requirePermission(nodeId, 'admin')` once for each node any invitee's grants name,** before the first write.
- **One transaction writes a `pending` `_InviteStatus` row for each address and node,** at that node, converging on an existing row as today. One facade call carries each address once (C17, C18).
- **`ResourcesResults.onInviteResult(grants, result)` takes the grants keyed by address.** For each minted `sub` and each grant it calls `setPermission` only where the grant raises what that `sub` holds there through the node's ancestors (D20), each read with `checkPermission` before any is written, and then flips that address's row at that node.
- **A `setPermission` that throws is caught for its own grant.** Its row flips to `submission-failed` with the refusal's message, the other grants go on, and the address is reported in `failed`. An inviter who loses `admin` at one node between the door and the facade's answer is how it happens.
- **`NodeInviteOutcome` becomes `{ sent, failed }`.** An invite spans nodes, and `Galaxy.#onNodeInviteOutcome` reads only `failed`.
- **`TreeSeed.inviteAlso`, `writeInviteAlsoGrants`, `#writeInviteAlso` and the Galaxy seed's `inviteAlso` entry are deleted.** The seed's nodes and its protected grant stay until § *Phase 4*.
- **`COLLABORATOR_GRANTS` in `chat-constants.ts` holds `write` at `MESSAGES_NODE_ID` and `read` at `CHAT_NODE_ID`,** exported from `index.ts` and `client-index.ts`, as `MESSAGES_NODE_ID` is. `Galaxy.invite` passes it and its JSDoc says so, and every test and scenario that invites a collaborator at `messages` passes it too.
- **Every caller changes, and type-check does not name them all,** since some reach the door through `as any`:

  ```sh
  grep -rnE '(resources|requests|door\([a-zA-Z]+\))\.invite\(' "${SRC[@]}"
  ```

- **Docs and guidance:** `api-reference.md` § `client.resources.invite` and its summary row; `access-control.md`, whose shared-list example becomes one invite naming `read` at the list and `write` at its items; the `wire-a-view` and `define-the-cast` skills; `Resources.invite`'s JSDoc; `calibration.md` § 11's example call; and `docs/vision/auth.md` § *The data plane and fine-grained access control*, which says an invite to the conversation names its `read` at `chat`.

**Success criteria (capable of failing):**

- In `node-invite.test.ts`, one invite naming a second node for one address writes an `_InviteStatus` row at each, found by a query on its node. Once the facade answers, the invitee holds exactly those grants and both rows read `sent`. When the facade refuses, both read `submission-failed` with its message.
- An inviter holds `admin` at one node and `write` at another. Their invite, whose first invitee names the first node and whose second names the other, is refused with a `PermissionDeniedError` naming the other node. No row exists for either address.
- An inviter whose `admin` at the second node is revoked before the facade answers leaves the first grant written and its row `sent`, the second row `submission-failed`, and the address in `failed`.
- One call gives two addresses different tiers, and each holds its own.
- Re-inviting someone who holds `admin` at a node, naming `read` there, leaves `admin`. Naming `write` where they hold `read` raises it.
- An invite naming `messages` alone leaves the invitee nothing at `chat`, in `turn-rounds.test.ts`, whose note on the `inviteAlso` mutation is replaced.
- An `it.each` covers the whole-call refusals, a pair of addresses differing only in case among them. Each row asserts its own message and that no row was written, and a well-formed invite after it lands.
- In `galaxy-seeds-its-chat`, the collaborator's invite through `COLLABORATOR_GRANTS` brings one mail: the limb waits for it, then counts the mails the email-test Worker holds for that address, read where `waitForEmail` reads them, and finds one. The collaborator, granted `admin` at `messages` by the owner, is then refused by name when their own invite names `chat` too.
- `grep -rnE 'inviteAlso|writeInviteAlsoGrants' "${SRC[@]}"` prints nothing.
- `npx tsx apps/nebula/harness/drive.ts all --fast` passes locally, and so do `node-invite-roundtrip` and `persona-tabs`, the invite's own scenarios, which need a container.

**Mutation notes:** check `admin` for the first invitee's nodes only and the refused invite lands. Write every grant unconditionally and the re-invite lowers `admin` to `read`. Write only the first grant and the collaborator holds nothing at `chat`. Flip only the first node's rows and the second stays `pending`. Let a throw end the handler and the first row stays `pending`. Drop one shape check at a time and its own row lands, each duplicate check having a row of its own.

### Phase 4: the Galaxy builds its tree in `onStart`, and the seed goes

**Goal:** the Galaxy's nodes and the agent's grant come from its own `onStart`, as `system:{scope}`, and nothing in the tree is written with no check or kept from an admin (DI8, DI11, D7, D18, D19).

- **`Galaxy.onStart` runs the block in § *Objective*.** It constructs `Resources` with no `seed`, and inside `lmz.asSystemPrincipal` creates each node and then restores the grant. Each of those steps is caught by itself and logged at `error`, so one that throws leaves the rest to run. `#wake()` follows the block. The tree is `this.#resources.requests.orgTree`, the surface a page reaches.
- **`#writeAgentGrantBack` asks `tree.checkPermission(CHAT_NODE_ID, 'write', NEBULA_SUB)`,** which resolves the tier the agent holds at `chat` through its ancestors (D20). Only when that fails does it call `setPermission` and log one `info` record under `nebula.Galaxy.agentGrant`: the node, the tier, the grantee, and `toRecordedClaims` of the claims the block runs under.
- **`#onChatCommitted` restores the grant before it reads the thread.** For a batch holding a `Message` at `messages`, it runs `#writeAgentGrantBack` inside `lmz.asSystemPrincipal` once, ahead of `waitingPostIds()`, caught and logged at `error` as `onStart`'s step is.
- **`GALAXY_TREE_SEED` is deleted, and `TURNS_NODE_ID` becomes `ROUNDS_NODE_ID` at the same id,** with slug `rounds` and label `Rounds`. The JSDoc of the node constants says where the nodes come from now.
- **The plane loses the seed and protection:** `TreeSeed`, the `seed` option on `Resources` and on `OrgTree`, `#protectedTier`, `ProtectedGrantError` with its exports, and `deleteNode`'s note on protected grants. `#ensureSeed` writes only the root, under a name that says so.
- **The rename is checked as `workflow.md` § *Symbol renames* says,** and every changed comment line is read. The scenario's line reporting its first limb spells the node with no quotes and changes with the limb.

  ```sh
  grep -rn '\bTURNS_NODE_ID\b' "${SRC[@]}"   # prints nothing
  # Prints only calibration.md's dated account of how the node came to be
  grep -rnE "'turns'|\`turns\`|'Turns'|\bturns nodes?\b|\bover turns\b" "${SRC[@]}"
  ```

- **The Resources package's fixtures follow.** The seeded host in `test-worker.ts` creates its nodes in `onStart` through `createNode` inside `lmz.asSystemPrincipal`, on the `ctx` that counts rows written, and `tree-seed.test.ts` is renamed for what it tests.
- **The scenario is renamed `galaxy-builds-its-tree`,** in its file and its line in `drive.ts`. It claims an app of its own with `ownApp`, since it revokes a grant every other scenario on a shared app relies on, and writes the agent's grant back as the owner in a `finally`.
- **A lane test holds what no Client can see,** in `apps/nebula/test/test-apps/baseline/`. Its header says why: it counts what a start writes, resets the Galaxy with `ctx.abort()` as `turn-wake.test.ts` does, and edits the tree's rows in storage to stand for a node a later deploy adds. A reset drops every socket, so the tree push a start sends is the scenario's to hold.
- **Standing guidance changes here, the last phase to touch what it describes:**
  - `security.md`: the agent's reply and a landing's `ServedBuild` are checked against the agent's grant at `chat`, above `messages` and `rounds`, which the Galaxy restores at each start and before a post. Its `lmz.asSystemPrincipal` entry gains the proof of where our code uses it: `grep -rnE '\.asSystemPrincipal\(' apps/nebula/src packages/resources/src` prints the calls in `Galaxy.onStart` and `#onChatCommitted`.
  - ADR-025 and ADR-015 lose the protected grant: a tree's skeleton is its root alone, and the agent's grant is restored, never refused to an admin. `workflow.md`'s index lines for both follow.
  - `docs/vision/auth.md` § *Why downward is generous for admins* says an admin can revoke the agent's grant, and that the next post or start restores it. Its § *The data plane and fine-grained access control* says `rounds` for `turns`.
  - `mesh.md` § *Nebula reaches its resources the way an app does* names `rounds`, and its *Today's code differs* block loses the seed's sentences.

**Success criteria (capable of failing):**

The `galaxy-builds-its-tree` scenario, container-free, each limb with its mutation:

- **A new Galaxy has its tree.** `chat` hangs under the root, `messages` and `rounds` under `chat`, the agent holds `write` at `chat` and nothing at the root, and no grant's key starts with `system:`. Its `.dev` Star and a tenant Star hold only a root. The Worker's logs hold no `tree setup failed` line for this Galaxy, read after a barrier line and `settleForAbsence()`.
- **One invite brings both grants,** as § *Phase 3* left the limb.
- **Only an admin can change the agent's grant.** The collaborator's `revokePermission` and `setPermission` naming the agent at `chat` are each refused as `PermissionDeniedError` for `admin` there, and the tree is unchanged. The owner's revoke at `messages` then leaves the collaborator's read at `chat`, and a revoke at `chat` ends it.
- **An admin's revoke lands.** The owner revokes the agent's `write` at `chat`, the call resolves, and the tree shows no grant for the agent there.
- **The owner's next post restores it.** The owner's client registers `onOrgTreeUpdate` before the revoke. The owner posts, and the next tree pushed shows `write` for the agent at `chat`. The Worker's logs hold one restore record after the revoke, naming `system:{scope}`, and no `handler threw` line from `doRead` for this Galaxy. The limb does not wait for the agent's reply.

The lane test, whose log sink is emptied after each setup step so a count reads one start alone:

- **A quiet start writes nothing.** With every node and the grant in place, a reset writes no row, counted across `super.onStart()` behind a probe as `rowsWrittenBySecondConstruction` counts a construction, and logs no record. The Resources package's own case asserts the same count for its host.
- **An admin's rename survives.** After `messages` is renamed `thread`, a reset leaves the slug `thread` and creates no second node.
- **The grant is restored from either state,** an `it.each` over revoked and lowered to `read`. Before the reset, `writeAsAgentForTest` answers `ok: false` with a `permission` error naming `write` at the node it wrote to. After it, the grant reads `write`, the same write answers `ok: true`, and one record was logged.
- **A post restores it with no reset.** With the grant revoked, a person's post leaves the grant at `write`, one record logged and no `handler threw` line, and the post is among `waitingPostIds()`.
- **A grant that reaches `chat` from above is enough.** With `admin` granted to the agent at the root and its grant at `chat` revoked, a reset writes no grant at `chat`.
- **A create that throws leaves the restore to run.** The owner renames `rounds` away and creates a node with the slug `rounds` under `chat`. The test deletes `ROUNDS_NODE_ID`'s rows from `Edges` and then `Nodes`, revokes the agent's grant, and resets. The `SlugTakenError` is logged at `error` on that start and the next, the Galaxy answers a call, and the agent's grant is back.
- **A node a later deploy adds is created at the next start.** With `ROUNDS_NODE_ID`'s rows deleted and its slug free, a reset creates the node again and writes only its rows.

Then the whole registry runs locally, since this phase and § *Phase 3* change what other scenarios depend on: `npx tsx apps/nebula/harness/drive.ts all`, and `--rerun` after any fix.

**Mutation notes:** keep `#protectedTier`'s refusal and the owner's revoke throws. Drop `requirePermission` from `revokePermission` and the collaborator's revoke lands. Drop the restore and the grant stays missing after the start. Drop the restore's log line and no record follows the start. Call `setPermission` at every start, with the log left conditional, and the quiet start writes a row. Ask for `read` in `#writeAgentGrantBack` and the lowered grant stays `read`. Read the grant at `chat` itself and the root-`admin` case writes one. Put the steps back under one `try` and the grant stays missing after the create throws. Remove the catch and the Galaxy fails every call. Restore after the trigger reads the thread and the post is not waiting. Drop the trigger's restore and the grant stays missing after the post. Call `asSystemPrincipal` from a third place and `security.md`'s grep prints it.

### Phase 5: the guidance says who holds a grant

**Goal:** a page the model writes treats a grant's key as a person's only when it is one (DI16).

- **`access-control.md` § *Permissions table and resolution* says what a grant's key can be:** a person's `sub`, a UUID, or a key that names what holds it, as `agent:lumenize` does. It shows `isPersonSub` imported from `@lumenize/resources/frontend`.
- **Its § *Every box in that tree is a node* says what a page does with a key that is not a person's:** a view that lists grants shows it as what it names, and a count of admins or a request-access climb skips it.
- **`api-reference.md`'s orgTree preamble, `coding-your-ui.md` where it calls `sub` a bare UUID, and the `wire-a-view` skill's rule that the tree is the only record of sharing** each say the same in a sentence and point at `access-control.md`, the one home (`studio-guidance.md` § *The placement table*).

**Success criteria (capable of failing):**

- A `@check-example` block in `access-control.md` filters a node's grants with `isPersonSub`, checked against a test in `for-docs.test.ts` in which a tree holding a person's grant and `agent:lumenize`'s lists the person alone.
- `npm run test:doc` passes, `gen-platform.mjs --check` reports no drift, and `test/platform-embed-drift.test.ts` passes.

**Mutation note:** drop the filter in the test's helper and the list holds `agent:lumenize`.

### Phase 6: the deployed pass, and the files that describe the tree agree

**Goal:** what only shows deployed has been seen there, and no file still describes the seed (`live.md` § *Two venues, one registry*).

- **Deploy with `bash apps/nebula/scripts/deploy-test.sh`,** and go on only once it prints that the test Worker matches `HEAD`.
- **Run this build's scenarios against it with `HARNESS_TARGET_URL`:** `galaxy-builds-its-tree`, and every scenario § *Phase 3* changed, the container ones included. A Galaxy made on the test target before this build keeps the slug `turns`, and its `createNode` answers `'differs'` (D18).
- **Read the target's Workers Issues since the pass began,** with `node scripts/issues.mjs --worker <name> --since <start>`. A new issue is a finding.
- **Rewrite the sibling files § *Relationships* names,** each to say what this file built:
  - nebula-query-upgrade.md: its claims about the seed, a protected grant and `createNode`'s throw, and `rounds` for `turns`.
  - nebula-app-lifecycle-hooks.md: `system:{scope}` for `system:lumenize`, its citations of this file's design intent, and the fixed id a member creates first (§ *Beyond this task*).
  - nebula-accounts-and-apps-have-names.md: each host's `onStart` creates `meta`, with `read` for `anyone` as a starting grant, which its claim that only `setPermission` writes a grant a caller chose has to admit.
  - `tasks/on-hold/nebula-request-access.md`: a climb and its count of admins consider only a person's grant.
- **Update the rows this file settles:** `tasks/backlog.md`'s row on a repeated create, its line on this scenario's fourth limb, and this file's row in `tasks/nebula-pre-alpha.md`.

**Success criteria (capable of failing):**

- The deploy's self-check matched `HEAD`, and each scenario passed deployed.
- No Workers Issue is new since the pass began.
- Neither of these prints a line:

  ```sh
  grep -rnE 'GALAXY_TREE_SEED|ProtectedGrantError|NodeIdCollisionError|TreeSeed|system:lumenize|[Ll]ocal[ -]principal|LocalPrincipal|\.asSystem\(' \
    "${SRC[@]}" tasks/nebula-*.md tasks/on-hold \
    | grep -v '^tasks/nebula-galaxy-builds-its-tree\.md:'
  grep -nE "protected grant|seeds as protected|Galaxy seeds|is seeded when the tree" \
    .claude/rules/security.md .claude/rules/workflow.md docs/adr/015* docs/adr/025* \
    docs/vision/auth.md
  ```

## Build notes

### Phase 1

**For Larry:**

- **The drafts question is unanswered, so `apps/nebula`'s suite ran without its embed drift check.** Every other step of its `npm test` chain ran. § *Phase 2* edits the drafted doc files, so it waits for the answer.
- **`docs/vision/auth.md` now says the Galaxy creates its orgTree's nodes as `system:acme.crm`,** which is true once § *Phase 4* lands, and not before.
- **`asAgentPrincipal` refuses a name it accepted before:** any `sub` without the `agent:` prefix. Mesh's own tests used `agent:test` already, and no caller changed.

**Runs:** type-check clean. Mesh 1117 passed and 4 skipped, Resources 263 passed, `apps/nebula` 1325 passed and 2 skipped without its embed check. The local `/live` sweep passed 79 of 79 with 2 parked, in 49.9 minutes.

**Retro notes:**

- All ten new tests passed on first write, so each was mutation-checked before anything else ran, and none survived.
- Mesh's test Worker gained a class, `PrincipalOnStartDO`, since no scoped node there had an `onStart`. The Durable Object binding types had to be regenerated with `npm run types` before the test compiled.
- ADR-015 sat at its 13 KB budget before this phase, so its two additions were cut to a clause each.

**Close-out notes:**

- ADR-025's title changed, to *an Agent Principal Holds Grants Only There*. Its file name did not.
- The sibling task files still say local principal; § *Phase 6* rewrites them, and its closing grep looks for the term.

**Mutations run,** each against `packages/mesh/test/claims-forms.test.ts`, each caught by the tests named:

- Drop `scopeAdmin` from the system claims: the claims test and the first-construction test.
- Read the stamped name alone: the first-construction test.
- Start a fresh chain for the `'agent'` kind alone: the test of a call made inside the block.
- Refuse an unscoped node by what its name parses as: the `UnscopedMeshDO` row.
- Derive the scope without `parseId`: the platform-root row.
- Have `isPersonSub` test for a missing colon: the `anyone` and empty-string rows.
- Drop `isPersonSub`'s `typeof` check: the object row.
- Accept any `kind:name` as an agent principal: the `system:` and `webhook:` rows.
- Skip the agent principal's name check: all six refusal rows.

### Phase 2

**For Larry:**

- **Only `api-reference.md` changed among the docs.** Every other example already mints its id and never reads `createNode`'s answer, the `define-the-cast` skill's included.
- **A `sub` named twice in `grants` is refused by a check of its own, inside the node's transaction,** so the message names the `sub`. The phase had the plain `INSERT` fail by itself, whose message would have been SQLite's.
- **`NodeGrant` and `CreateNodeResult` are exported types,** from `@lumenize/resources` and its `/client` entry, for the fifth argument and the answer.

- **The query-upgrade drafts moved into that task file's § *Doc drafts* during this phase,** on your call, after a stash held them for its doc edit. § *Phase 1* ran with them in the tree and without the embed check.
- **A full `/live` sweep no longer follows every phase,** on your call: each phase runs `--fast` and the container scenarios it touches, and one full sweep follows § *Phase 4*, with the closing one after it.

**Runs:** type-check clean. Resources 264 passed. `apps/nebula` 1333 passed and 2 skipped, with the embed in sync. `npm run test:doc` passed. Of the `/live` registry, 64 passed on this tree, the container-free ones and the container ones a stopped full sweep had reached, with `grant-reveals-denied` and `query-by-filter`.

**Flakes:** `client-routes` (a mail lost after delivery), `refresh-reads-the-host` (a WebSocket connection timeout) and `hosts-and-frames` (`write EPIPE`) each failed once in one run and passed on the rerun with nothing changed. None touches what this phase changed, and the three came together, which points at the machine under load.

**Retro notes:**

- Thirty-one callers kept the answer as the node's id, in fifteen test and scenario files. One scripted rewrite moved each to mint the id first, and the type-checker named them all, as C26 said it would.
- The baseline test client reads a create's id from `lastResult` in about seventy places. Its create initiator now keeps the id it minted there and the answer in `lastCreateOutcome`, so those tests did not change.
- A query inside the `onStart` block runs and finds nothing in the Resources fixture, whose ontology is installed by then. It cannot tell dominion from none there, since an empty plane answers nothing either way, so the create is what holds the host-name reader.
- `OrgTree.getState` asks for a caller, so a test probe called on the stub reads the tree's rows from storage instead.

**Close-out notes:**

- `tasks/backlog.md`'s row on a create answered wrong on repeat is settled for `createNode`. § *Phase 6* updates the row.
- `SelfBuildingHostDO` in the Resources test Worker creates a node in `onStart`. § *Phase 4* moves the seeded host to the same shape, and the two fixtures become one there.

**Mutations run,** against `apps/nebula/test/test-apps/baseline/org-tree.test.ts` unless named, each caught:

- Answer `'existing'` for every id found: the repeat test, at its rename case. Also caught by the scenario's new limb.
- Compare the label too: the repeat test, at its relabel case.
- Ignore the deleted flag, and ignore the edge: the repeat test, at its delete and move cases.
- Ask only `write` when grants are given: the starting-grants test.
- Write grants for a node that exists: the starting-grants test, where the revoked grant came back.
- Throw a plain error for a taken slug: the name test, and the scenario's limb.
- Drop each of the three shape checks: its own row.
- Drop the twice-named check and write with `INSERT OR REPLACE`: the twice-named test.
- Read the stamped name alone in the plane: `packages/resources/test/tree-seed.test.ts`, where the `onStart` create was refused.
- Not run as written: grants inserted after the node's transaction. The twice-named test asserts the node is absent, which is what that mutation would break.

### Phase 3

**For Larry:**

- **A status row at a node its inviter can no longer reach stays `pending`.** The phase said a refused grant's row flips to `submission-failed`. The flips run under the inviter's claims, so an inviter who has lost every grant at that node is refused the read and the write of its row too. Before this phase that one refusal ended every remaining flip, which the new test found. Each flip is now caught by itself: the other rows flip, the address is reported in `failed`, and that one row stays `pending`. Flipping it would take a write made as the host's system principal, which is a new use of `asSystemPrincipal` for a row people see, so it is yours to decide.
- **`NodeInviteGrant` is a new exported type,** `{ nodeId, tier }`, beside `NodeInvitee`.
- **`access-control.md`'s shared-list example still grants with `setPermission`,** since it has the person's `sub`. The line beside it that teaches the invite now shows one invite naming two nodes, which is what the phase wanted taught.

**Runs:** type-check clean. Resources 264 passed. `apps/nebula` 1346 passed, 2 skipped and 1 failed, which was `waiting-posts.test.ts`'s refused node invite: its fixture held `admin` at `messages` alone, and the door now asks it at `chat` too. With the fixture holding both, the file passes. `npm run test:doc` passed. `drive.ts all --fast` passed 64 of 64 after a rerun, and `node-invite-roundtrip`, `persona-tabs`, `grant-reveals-denied` and `query-by-filter` passed.

**A real red in the sweep:** `agent-invites` failed for the same reason as that test, and passes with the same fixture change.

**Flakes:** `resubscribe-when-lost`, `refresh-reads-the-host` and `studio-app-settings` (a mail lost after delivery), `claim-lifecycle` and `invites-land-on-their-host` (the mail socket closed first) and `galaxy-cap` (a WebSocket connection timeout) each failed once and passed on the rerun with nothing changed. With § *Phase 2*'s three, every flake of this build has been a lost mail or a dropped socket, and `refresh-reads-the-host` has now done it twice.

**Retro notes:**

- Twenty-one callers took the scripted rewrite, in tests, scenarios and the harness's `chat-cast.ts`. The rest were multi-line, sent a literal version or went through a test's helper, and were changed by hand, the last of them named by the type-checker.
- One mutation survived on first run: comparing duplicate addresses as they were sent. The two-cases row named the lower-case spelling first, which is already the normalized one, so the check held either way. The row now names the upper-case spelling first.
- The lost-`admin` case is made in order by sending the inviter's own revoke on the same socket, right behind the invite. The invite's door has passed by then and its facade call has not gone out.
- A facade refusal of a whole invite needs a Galaxy, where only dominion may invite, so that case lives in `turn-rounds.test.ts` beside the collaborator's grants. It reads the rows through two storage probes on the test Galaxy, `inviteStatesForTest` and `inviteFailuresForTest`.

**Close-out notes:**

- `TreeSeed` keeps its nodes and its protected grant until § *Phase 4*.
- The four model-driven container scenarios this phase's rewrite touched, `dev-star-follows-the-build`, `build-reaches-every-studio`, `shared-lists-turn` and `cast-from-a-tab`, type-check and wait for the full sweep after § *Phase 4*.

**Mutations run,** against `node-invite.test.ts` unless named, each caught:

- Check `admin` at the first node only: the refused-invite test, and the scenario's limb, where the collaborator's invite landed.
- Write every grant unconditionally: the never-lowers test.
- Write only the first grant: the two-nodes test, `turn-rounds.test.ts`'s collaborator cases, and the scenario's limb.
- Flip only the first node's rows on success: the two-nodes test. On a refusal: `turn-rounds.test.ts`'s facade case.
- Let a refused grant end the handler, and let an unflippable row end the flips: the lost-`admin` test.
- Have `Galaxy.invite` name `messages` alone: `turn-rounds.test.ts`'s `Galaxy.invite` case.
- Drop each whole-call check: its own row, with the address duplicate checked both as dropped and as compared unnormalized.
- Not run: a `read` at `chat` written with every invite at `messages`, which would mean restoring deleted code. The messages-alone case asserts the invitee's exact grants once the row reads `sent`.
- Not run: two sends for one invite. The scenario counts Resend's send ids for the address, and the lane counts the Registry's issued links.

## Non-goals

- **An app's `onStart` and `onNewOntologyVersion`,** and the facet they run in: nebula-app-lifecycle-hooks.md.
- **`system:{scope}`'s claims crossing a call:** § *Beyond this task*.
- **A Profile for a node's own principal:** nebula-app-lifecycle-hooks.md, where it first writes a record a page shows (D13).
- **A record of the claims behind every tree write:** `tasks/backlog.md`'s row on a queryable ADR-016 trail, and `tasks/on-hold/wire-merge-patch-sync.md` (D14).
- **The `anyone` grantee:** nebula-accounts-and-apps-have-names.md.
- **A tree for the Universe:** nebula-accounts-and-apps-have-names.md.
- **`ensureResource` and the `findCurrent` read,** which `mesh.md`'s *Today's code differs* block still lists after this file.
- **Moving a Galaxy made before the rename to the slug `rounds`:** pre-alpha's wipe ends those (D18).
- **Ratifying ADR-015, ADR-016 or ADR-025,** which waits for pre-alpha's launch.
