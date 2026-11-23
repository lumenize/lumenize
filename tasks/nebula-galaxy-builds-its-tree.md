# The Galaxy builds its own tree in `onStart`, and the tree seed goes

**Status:** Pass 1, drafted 2026-11-21, split from [nebula-app-lifecycle-hooks.md](nebula-app-lifecycle-hooks.md) on 2026-11-22, and reshaped the same day by two `/review-task` Stage 1 passes; phases are not written, and every question is decided. Routed task-file-first, though `/task-management`'s question, whether this changes how a developer uses the package, answers yes (D10, D12, D13): the signatures are pinned here with their alternatives weighed, and the docs that carry them hold [nebula-query-upgrade.md](nebula-query-upgrade.md)'s uncommitted drafts, so they change in a phase once those drafts are set aside. It comes before nebula-query-upgrade.md, and nebula-app-lifecycle-hooks.md gives an app its hooks after that task (§ *Relationships*).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `D` a decision Larry made, and `Q` an open question. C4 is the fourth claim raised, wherever it sits. A gap is an item removed or answered. Items raised before the split keep their numbers, so a gap may also be an item that moved to nebula-app-lifecycle-hooks.md.

## Objective

**The Galaxy creates `chat`, `messages` and `turns` in its `onStart`, on every start, and writes the agent's `write` at `chat` back when an admin has removed or lowered it. It does both as `system:acme.crm`, the Galaxy's own principal, which holds dominion over the Galaxy's scope as an admin of it does, so no grant is written for it. It reaches the tree through the calls a page makes, each checked as a page's is. `GALAXY_TREE_SEED` and protected grants go. Two calls change with them: an invite names every grant it gives, so the `read` at `chat` that an invite at `messages` brings today is named in the call and checked, and `createNode` becomes the one create, leaving a node that already exists as it stands.**

The tree it builds. A turn is one run of the agent in answer to a post, stored at `turns` as one `Round` for each response of the model, with the calls that response made:

```text
root
└─ chat          where the agent holds `write` and a collaborator `read`, over both below
   ├─ messages   each post, a `Message`, and each landed build, a `ServedBuild`
   └─ turns      each turn's `Round`s, which the agent writes
```

```ts
// apps/nebula/src/galaxy.ts — on every start, before the Galaxy answers any call
override async onStart() {
  // ...the Workspace and the Resources plane, as today, with no seed
  try {
    // Acts as system:acme.crm, which Mesh derives from this node's own name.
    // Mesh holds the claims in AsyncLocalStorage, as it holds a call's, so they
    // cover what this block runs and nothing after it
    this.lmz.asSystem(() => {
      const tree = this.#resources.requests.orgTree;
      // Each creates its node only where it is absent, answering { outcome: 'created' | 'existing' | 'differs' }
      tree.createNode(CHAT_NODE_ID, ROOT_NODE_ID, 'chat', 'Chat');
      tree.createNode(MESSAGES_NODE_ID, CHAT_NODE_ID, 'messages', 'Messages');
      tree.createNode(TURNS_NODE_ID, CHAT_NODE_ID, 'turns', 'Turns');
      // The agent's `write` at `chat`, written only when it is missing or lower
      this.#writeAgentGrantBack(tree);
    });
  } catch (error) {
    // An uncaught throw would fail every call to this Galaxy (C23)
    debug('nebula.Galaxy.onStart').error('tree setup failed', { error });
  }
  // As today: continues a turn that an eviction or a deploy cut off, detached
  // under waitUntil. It is outside the block, so that turn runs as the agent
  this.#wake();
}
```

What happens over a Galaxy's life, for the Galaxy `acme.crm`:

1. Its first construction runs `onStart` before it answers anything. The plane writes the root, and `onStart`, acting as `system:acme.crm`, creates `chat`, `messages` and `turns`, then writes the agent's `write` at `chat`.
2. An admin renames `messages`. Every later start finds each node in place and leaves the rename as the admin left it.
3. An admin revokes the agent's `write` at `chat`, which dominion allows. The agent cannot post until the Galaxy next starts, after an idle eviction or a deploy, and that start writes the grant back.
4. The agent invites Gerry as a collaborator. The invite names `write` at `messages` and `read` at `chat`, and the door checks the inviter's `admin` at each. Today the read comes from the seed, with no check.
5. A later deploy adds a node to `onStart`. Each existing Galaxy creates it at its next start, unless an admin already uses its slug under that parent, which that start logs as an error until someone resolves it.

## Context

**Our Galaxy creates its nodes a way no app can.** `GALAXY_TREE_SEED` declares `chat`, `messages` and `turns` at fixed ids and reaches `OrgTree` through a `Resources` constructor option. `#ensureSeed` writes them with `INSERT OR IGNORE` and no permission check, on every construction. `mesh.md` § *Nebula reaches its resources the way an app does* forbids this, and lists it under *Today's code differs*.

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
2. **An admin's change to a node survives every later start,** except that the next start restores the agent's `write` at `chat` (DI11). Today the seed refuses any change to the agent's grant.
3. **The Galaxy reaches its tree only as a page can,** through the calls a page makes, each checked as a page's is, and its invite does too (D3, D10). Today the seed writes nodes and a paired grant with no check.

## Relationships

- **Before [nebula-query-upgrade.md](nebula-query-upgrade.md)** (Larry, 2026-11-22), so our Galaxy drops its seed before that task is built, and nothing more is built on the seed. Its claims that describe the seed, a protected grant or `createNode`'s throw are rewritten when this file closes.
- **Before [nebula-app-lifecycle-hooks.md](nebula-app-lifecycle-hooks.md)**, which comes after nebula-query-upgrade.md and gives an app `onStart` and `onNewOntologyVersion` exports, run in a facet. It builds on D4, D6, D8 and D9 here, and defines the object an app's hook receives, which its DI4 cites from this file today. That file is rewritten to say so when this file closes. It confirms who an app's code runs as, and D17 expects its Galaxy's `system:{scope}`, with dominion over every tenant Star, which Larry accepts as asking for diligence in that code. It is also where such a principal first writes a record a page could show, so a Profile is due there (D13).
- **Changes [nebula-accounts-and-apps-have-names.md](nebula-accounts-and-apps-have-names.md)**, whose `meta` node and its grant to `anyone` come from every scope's seed in its design. Under D3 and D11 each host's `onStart` creates them, and that file is rewritten to say so when this file closes. Its `anyone` is a grantee key that is neither a person's nor a local principal's (D15), and when it lands, Mesh should require a local principal's name to take the form `kind:name`, so that none can be named `anyone`.
- **Changes [tasks/on-hold/nebula-request-access.md](on-hold/nebula-request-access.md)**, which is rewritten when this file closes: a climb and its count of admins consider only a person's grant (DI16). A node's own principal acts through the dominion bypass as a person's admin does, so it adds nothing to the tree a climb reads.

## Current state

Built already:

- **`MeshDO.onStart`, which the Galaxy and the Star override.** *Carried over:* the Galaxy's gains the creates and the write-back (DI8, DI11), and the Star's is unchanged. The Universe composes no Resources plane and has no tree.
- **`lmz.asLocalPrincipal`**, which builds claims with the principal as `sub`, the node as `aud`, and never `scopeAdmin`, and refuses an empty or UUID-shaped principal and a node with no stamped name. *Carried over* for `agent:lumenize`, taking the node's name from `ctx.id.name` when none is stamped (DI15). `lmz.asSystem` joins it beside (DI5).
- **`OrgTree.#ensureSeed`, `TreeSeed`, `#protectedTier` and `ProtectedGrantError`.** *Adapted:* `#ensureSeed` writes only the root (DI11). `TreeSeed`, the `seed` option on `Resources`, `#protectedTier`, `ProtectedGrantError` and `deleteNode`'s note about protected grants go (D3, D7, D10).
- **`Resources`' host-name thunk, `lmz.instanceName`, which `OrgTree.requirePermission`'s dominion bypass reads.** *Adapted:* it reads `ctx.id.name` when no name is stamped, so `system:acme.crm`'s dominion holds on the first start (DI15, C29).
- **`GALAXY_TREE_SEED` in `chat-constants.ts`.** *Removed* (D3, D7, D10). `CHAT_NODE_ID`'s JSDoc, which links to it, is *Adapted*.
- **`createNode`, the Client's call to it in `client-resources.ts`, and `api-reference.md` § `createNode` with the pages that call it**: `access-control.md`, `coding-your-ui.md` and the `define-the-cast` skill. *Adapted* (D6, D12, D16): its answer is no longer the id it was given, so the tests that keep that id change too (C26). `NodeIdCollisionError` goes, and the refusal of a taken slug becomes `SlugTakenError`.
- **`setPermission`**, which upserts (C15). *Carried over unchanged:* writing a grant back reads it first, and calls `setPermission` only when it is missing or lower.
- **`NEBULA_SUB`**, the constant holding `agent:lumenize` in `packages/mesh/src/auth/types.ts`, which `@lumenize/mesh/client` exports. *Carried over;* the predicate DI16 names joins it there. A node's own principal has no constant, since Mesh derives it (D4).
- **The guidance on who holds a grant:** `access-control.md` § *Permissions table and resolution*, which says a grant's key is a person's `sub`, a bare UUID (C25), and its § *Every box in that tree is a node*, which reads a list's grants back as whom it is shared with; `api-reference.md`'s orgTree preamble; and the `wire-a-view` skill's rule that the tree is the only record of sharing. *Adapted* (DI16).
- **`inviteAlso`, `writeInviteAlsoGrants` and `#writeInviteAlso`**, which add the read at `chat` when an invite at `messages` comes back from the facade (C16). *Removed* (D10).
- **`Resources.invite` and its JSDoc's one `nodeId` per call, `ResourcesResults.onInviteResult(nodeId, tiers, result)`, `NodeInviteOutcome { nodeId, sent, failed }`, the Client's `resources.invite`, `NodeInvitee` and `_InviteStatus`,** and the guidance that teaches the call: `api-reference.md`, `access-control.md`, and the `wire-a-view` and `define-the-cast` skills. *Adapted:* each invitee names its grants (DI14).
- **`Galaxy.invite` and `#onNodeInviteOutcome`.** *Adapted:* one invite names both grants (DI14).
- **Standing guidance that states the seed's model, or that a local principal never holds dominion:**
  - `docs/vision/auth.md`, which is accepted. § *How the claims travel* names `agent:lumenize` as the first local principal and says a node builds claims itself in that one case, § *Why downward is generous for admins* says nobody can revoke the agent's seeded grant, and § *The data plane and fine-grained access control* says an invite at `messages` brings `read` at `chat`. *Adapted* with D7, D10 and D17, a change to accepted vision prose.
  - ADR-025, which says a local principal holds grants in one tree and nothing else, and protects the agent's grant; ADR-015's "a tree's skeleton excepted", which keeps the root only; and both their lines in `workflow.md`'s index. *Adapted* with D7 and D17: a node's own principal holds dominion over its scope, beside the grants-only local principal.
  - `security.md`: its list of the claims Mesh builds, whose `lmz.asLocalPrincipal` entry says never `scopeAdmin`, gains `lmz.asSystem`; and its bullet saying the agent's reply and a landing's `ServedBuild` are checked against a protected grant changes with D7.
  - `mesh.md` § *Nebula reaches its resources the way an app does*. Its bullet on where our nodes come from was corrected to D11 on 2026-11-22, and the seed sentences of its *Today's code differs* block are *Removed* when the seed goes.
- **Tests that assert the seed's model**: the `galaxy-seeds-its-chat` scenario, whose limbs 2 and 3 expect `ProtectedGrantError` and whose limb 4 waits on the paired read; `packages/resources/test/tree-seed.test.ts` and the protected grant its `test-worker.ts` seeds; and `turn-rounds.test.ts`'s `inviteAlso` mutation. *Adapted* or removed with D3, D7 and D10. Limb 4 finds the collaborator by the `sub` their own login carries rather than by counting new grantees, which settles that limb's line in `tasks/backlog.md`'s row on `/live` limbs weaker deployed. The scenarios and tests that invite at `messages` change mechanically, naming both grants.

## Design intent

- **DI5. A node's own code acts as `system:{scope}`, holding dominion over its scope as an admin of it does** (D4, D17).
  - **Mesh derives the principal and its claims from the node's own name,** in `lmz.asSystem(fn)`: for the Galaxy `acme.crm`, `sub` and `profileId` are `system:acme.crm`, `aud` and `authScope` are `acme.crm`, and `scopeAdmin` is true. ADR-015's predicates then give it dominion over `acme.crm` and every Star beneath it, and passage, not dominion, into its Universe.
  - **No grant is written for it,** so none is revoked, restored or shown in the tree. It acts through `requirePermission`'s dominion bypass, as a person's admin does (C19).
  - **Its claims stay in the node in this task, since nothing here calls another node as itself.** A call made inside the block starts a fresh chain with no claims, as one made under `lmz.asLocalPrincipal` does, and the node it reaches treats the Galaxy as a plain member of `acme.crm` (C30).
  - **Nothing argues for keeping them there for good, and a later task is expected to carry them across a call.** ADR-025 keeps a local principal's claims in its node, and that principal holds grants in the one tree and nothing anywhere else, so it has nothing to reach outside it. `system:acme.crm` holds dominion over every Star beneath it, and using it means acting in another node. The far node already works out the starting node's scope from the chain Mesh stamps (C30), so it can build `system:acme.crm`'s claims itself, with nothing carried to trust. What is missing is a way for a call to say it was made inside `asSystem`, and the first call that needs one settles it (§ *Beyond this task*).
  - **It never acts for a person,** which `agent:lumenize` does, under the claims recorded on a post. The agent stays a local principal that holds grants and no dominion.
- **DI6. `createNode` leaves an existing node as it stands, so the Galaxy can call it at every start without undoing an admin's change** (D6).
  - **It writes the node, its edge and its starting grants in one transaction, and only when the node is absent.** An admin's rename, move or revoke therefore survives.
  - **It checks `write` at the parent, and puts each starting grant through the checks `setPermission` makes,** for a page's call and the Galaxy's alike.
  - **Starting grants are for a grant written once, when its node is created,** so a revoke stands and no eviction can leave the node without it: nebula-accounts-and-apps-have-names.md's `read` for `anyone` at `meta` is the first. The Galaxy passes none, since the agent's grant is restored at every start instead (DI11).
  - **It answers `{ outcome }`: `'created'`, `'existing'` when the node is there under that slug and parent, or `'differs'` when it is there renamed, moved or deleted** (D12, D16). A change to the label alone answers `'existing'`. An object, so a caller that kept the old answer as a node id fails to compile.
  - **A new node whose slug a sibling already holds is refused with `SlugTakenError`,** a typed error a page tells from a permission refusal by its name. Two nodes cannot share a slug under one parent, since a slug rides a URL, so this is a conflict someone resolves, not a change to leave alone.

    ```ts
    tree.createNode(MESSAGES_NODE_ID, CHAT_NODE_ID, 'messages', 'Messages');
    // { outcome: 'created' } the first time, 'existing' after, 'differs' once an admin renames it 'thread'
    ```

- **DI8. Our Galaxy's chat nodes come from its own `onStart`, on every start, as `system:acme.crm`** (D3, D11). It creates `chat`, `messages` and `turns` through `createNode`, the call a page makes (`mesh.md` § *Nebula reaches its resources the way an app does*), so a start after the first writes nothing, and then restores the agent's `write` at `chat` (DI11). An invite to the conversation names its own `read` at `chat` (DI14). The Star creates no nodes here.
- **DI11. Each of the Galaxy's starts restores the agent's `write` at `chat`** (D8).
  - **The grant is written when it is missing or below `write`, and otherwise left alone.** The write reads the grant first, since `setPermission` writes a row even for a grant already in place (C15).
  - **The restore runs after the creates, as `system:acme.crm`, through `setPermission`,** whose `admin` check its dominion passes.
  - **The plane writes only the root at every construction,** with no check, as tree bookkeeping no one person asked for (ADR-025), and again after a `.dev` wipe's rebuild (C9).
  - **The restore logs one record at `info`, naming the grant and `system:acme.crm`'s claims** (D14). A start that finds the grant in place logs nothing.
  - **A throw from a create or the restore is caught in `onStart` and logged at `error`, which raises a Workers Issue, and the rest of `onStart` runs.** A `SlugTakenError` raises one at every start until someone moves one of the two nodes. An uncaught throw from `onStart` fails every call to the Galaxy, since each call constructs it again and the throw repeats (C23).
- **DI14. An invite names every grant it gives** (D10).

  ```ts
  // Galaxy.invite: one invite, one email, both grants
  await this.#resources.invite([{ email, grants: [
    { nodeId: MESSAGES_NODE_ID, tier: 'write' },  // to post
    { nodeId: CHAT_NODE_ID, tier: 'read' },       // to read the turns as well as the thread
  ] }]);
  ```

  - **Each invitee names its own grants,** so one call can give two people different tiers, as `persona-tabs` gives Gerry `write` and Sally `read` today. Each address still gets one facade invite and one email (C18).
  - **An invite at `messages` grants only what it names,** so the callers C16 names pass both grants.
  - **The door checks `admin` once at each node the grants name,** before any side effect. That replaces the one check per call that licensed a whole batch at one node.
  - **The result handler writes each grant with `setPermission` under the inviter's claims, and only where it raises what the invitee holds,** so re-inviting someone who holds `admin` at `chat` leaves it, as the paired read does today (C16). No invite writes a grant with no check.
  - **`_InviteStatus` keeps one row per address and node, one for each grant,** written in the invite's one transaction, so a query by `node` reads it as today (C17).
  - **`Galaxy.invite` still refuses a caller without dominion over the app first,** and dominion passes `admin` at every node (C19).
- **DI15. A node acts as itself from its first construction.** A first construction has no stamped name, so `lmz.asSystem` and `lmz.asLocalPrincipal` take the node's name from `ctx.id.name` (C20), and so does the host name `requirePermission`'s dominion bypass reads, which grants nothing on an absent one (C29). The Galaxy's first `onStart` then runs its creates with dominion.
- **DI16. A person's grant is told from any other by its key's shape** (D13, D15).
  - **`@lumenize/mesh/client` exports `isPersonSub(sub)`,** true for a UUID-shaped key such as `3f2a9c1e-…` and false for `agent:lumenize`, `system:acme.crm` or `anyone`. A person's `sub` is a UUID that Mesh's auth layer mints, which Mesh already relies on (C24).
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
- **[ADR-015](../docs/adr/015-passage-and-dominion.md)** and **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)**: dominion runs downward and can revoke any grant. ADR-025 is amended so a node's own principal holds dominion over its scope, while a local principal such as the agent still holds grants in one tree and no membership (D17).
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)**: only the restore logs a record (D14). Every other tree write records no claims until the tree keeps history (C28).
- **`mesh.md`** § *Nebula reaches its resources the way an app does*: our own code reaches the plane only as an app can (D3). § *Nebula platform code never drops to raw primitives* asks why no existing lifecycle method does a new hook's job, and D11 adds no hook.
- **`security.md`**: `lmz.asSystem` joins the claims Mesh alone builds, and no other code writes `originAuth`.
- **`durable-objects.md`**: a start after the first writes nothing when every node and grant is in place, and nothing depends on the Galaxy staying awake.
- **`live.md`**: the `galaxy-seeds-its-chat` scenario is adapted rather than joined by a second one. It finds the chat nodes and the agent's grant on a new Galaxy, revokes the agent's grant as its admin and sees the agent refused, finds the grant back after the Galaxy's next start, and invites a collaborator with one invite naming both grants. How it restarts the Galaxy is settled in the phases: a redeploy, as `deploy-cuts-a-turn` does deployed, or the vitest-plugin lane's `ctx.abort()`, which keeps storage.

## Beyond this task

- ⚠️ Design consideration: **the Galaxy could `ctx.abort()` itself when a post finds the agent's `write` at `chat` missing,** so the next start restores it at once (Larry, 2026-11-22, for a later day if it is ever seen). Under D7 a revoke lasts until the next start.
- **A node's own principal acting across a call** (Larry, 2026-11-22): a Galaxy acting in one of its Stars as `system:acme.crm`, where it holds dominion, or calling its Universe, where it holds passage only. The far node builds the claims from the starting node's name (DI5), once a call can say it was made inside `asSystem`.

## Decisions

| Decision | Alternatives weighed |
|---|---|
| **D3. The platform's own nodes are created by our hosts' own code, through the calls a page makes, as an app's are, and `mesh.md`'s rule that Nebula reaches its resources as an app does is absolute** (Larry, 2026-11-22; was Q2). What today's code still does differently sits in that section's *Today's code differs* block | The seed keeps declaring the platform's nodes, and only an app's come from its code: a split by whose node it is, with no requirement behind it |
| **D4. A node's own code acts as `system:{scope}`: `system:acme.crm` for the Galaxy `acme.crm`, `system:acme.crm.tenant1` for one of its Stars** (Larry, 2026-11-22; was Q3, the scope form from Q16). Mesh derives it from the node's name, so no constant names it. The full scope is unique anywhere and already says the tier, and the `system:` prefix keeps a record from reading as a bare scope, as Kubernetes reserves `system:` for its own control plane | `system:lumenize`, one principal for every host: a record could not say which node acted, and it needed an `admin` grant at every root. `{tier}:{slug}`, such as `galaxy:crm`: a slug is unique only among siblings, so a Star named in its Universe's tree is ambiguous. `app:crm`: "app" is Studio's word, and Mesh's middle tier may have other uses. `platform:lumenize`: `PLATFORM_SCOPE`, `_platform` and `isPlatformScope` name the root scope and `platform.lumenize.dev` the session host. `agent:lumenize`: a node our code made would read as the agent's work |
| **D6. `createNode` is the one create, and idempotent: it leaves an existing node as it stands, and writes a new node's starting grants in the node's own write** (Larry, 2026-11-22; was Q4). What it answers is D12 | A second method, `ensureNode`, beside a `createNode` that keeps throwing: the throw guards only a page's creates, which mint ids with `crypto.randomUUID()`, and the model would choose between two methods. The caller reading the tree and skipping the ids it holds: every app carries the check, and a grant written after its node is lost to an eviction between them |
| **D7. `protected` is removed: the agent's `write` at `chat` is restored when found missing or lowered, never refused to an admin** (Larry, 2026-11-22; was Q7). Dominion exists so an admin can maintain a tree, and a grant only one principal could change would veto it. A revoke lasts until the next start restores the grant | A grant marked protected, changeable only by the node's own principal: that principal would veto every admin's dominion. Protection kept for the agent's grant alone: it guards a revoke the product cannot undo today, at the cost of a mechanism dominion has to step around. The revoke standing until an admin grants it again: the agent could never hear the request to restore its own grant. The grant left in the Galaxy's seed: a standing exception to D3 |
| **D8. Each of the Galaxy's starts restores the agent's `write` at `chat`, and an app's `onStart` export runs after the restores, as the principal nebula-app-lifecycle-hooks.md confirms** (Larry, 2026-11-22; was Q9). Our Galaxy's `onStart` runs in-process, and an app's runs in its facet, which a Star loads at start only when the app exports `onStart`. A grant found in place is not written, and a throw is logged while the start goes on | Only when a version is installed: a revoked agent grant would stay revoked until the chat ontology's next version, which is rare. From a list each host declares, read at every start: the declarative seed D3 moved away from |
| **D9. An app's lifecycle hooks run in a facet, and the Galaxy's work runs in-process in its own `onStart` (D11), built first** (Larry, 2026-11-22) | Only the facet form, for our code and an app's alike: our Galaxy would wait on the folder, the facet and the build box before it could drop the seed, and its creates would pay a facet load for code that lives in our own Worker |
| **D10. An invite names every grant it gives, each invitee naming its own: `invite([{ email, grants: [{ nodeId, tier }] }])`** (Larry, 2026-11-22; was Q8). `Galaxy.invite` names `write` at `messages` and `read` at `chat`, each checked at the door, where today the read comes from the seed unchecked. It ends `Resources.invite`'s rule of one `nodeId` per call, whose reason was that one check licensed the batch, since the door now checks `admin` at each node named before any side effect. Nothing is stored to keep in step with the code. The one-email gain is an app's (C18): the Galaxy's paired read already came with no second email | A hook declaring a pairing through a tree method, stored in the tree: it moves the rule rather than deleting it, and since a hook only adds, a pairing a later version drops stays until something removes it. The pairing kept in the Galaxy's seed: the seed this file removes stays, and `mesh.md`'s block names it for good. One grant list every invitee shares, `invite(grants, invitees)`: giving two people different tiers takes two calls |
| **D11. The Galaxy creates its nodes in `onStart`, on every start, and never at install** (Larry, 2026-11-22, from Stage 1). `onStart` runs before any call, and the Galaxy's version arrives only with a deploy, which constructs it again (C21), so every node exists before the first call, in a new tree and an old one. `createNode`'s idempotence (D6) makes a start after the first cost reads only | `onNewOntologyVersion` on the Galaxy, called from `#install`: § *Context* says why it fails, and the plane, which holds no reference to its host, would need a seam to call it. Both, install for versions and start for code: one idempotent routine run twice on a host whose version changes only at a deploy |
| **D12. `createNode` answers `'created'`, `'existing'` or `'differs'`** (Larry, 2026-11-22; was Q11; its shape is D16). `'existing'` is the node there under the slug and parent asked for, and `'differs'` is the node there renamed, moved or deleted. Its id stays the caller's, a constant in source for a node code names: the id names the node's role, and the slug and label are what a person sees and may change, as a Windows known folder keeps its `FOLDERID_Documents` when a user renames it | The node as it stands, slug, label, parents and `deleted`: a node can have more than one parent, and every member can read the tree already. The throw kept for a mismatch, caught by the Galaxy around each create: an admin's rename reads as an error at every start. `created` alone: a copied id reads as a harmless retry. The id minted by `createNode` and the node found by its slug: an admin's rename of `messages` would make the next start create a second one and split the chat (ADR-010), and without the slug each host would store its own id, which a page would have to look up before it queried |
| **D13. A page tells a person's grant from any other by the key's shape, and a node's own principal gets no Profile until something shows a record it wrote** (Larry, 2026-11-22; was Q12). D15 names the predicate. The guidance tells a view to show any other key as what it names, and a climb or a count of admins to skip it | A Profile for the node's principal now, seeded as the agent's is: nothing reads one, since what it writes here is tree changes and the tree records no author. Pages comparing against a list of constants: a list every page carries, wrong the day another principal appears |
| **D14. Only the restore of the agent's grant logs an ADR-016 record, at `info`, since it is written back at a start nobody caused** (Larry, 2026-11-22; was Q13). Every other tree write records no claims until the tree keeps history, where each node, edge and grant would be a row carrying the claims that wrote it (`tasks/on-hold/wire-merge-patch-sync.md` § *Option B with the tree's rows as resources*), which is undecided until that task is picked up after pre-alpha | Every tree mutation logging one record now: lines deleted once the rows carry their claims, for writes a page makes in a call that a person can account for. None logging: a restore nobody asked for would leave no trace when someone asks why the agent's grant came back |
| **D15. The predicate is `isPersonSub(sub)`, true for a UUID-shaped key, exported from `@lumenize/mesh/client`** (Larry, 2026-11-22; was Q14). A climb and a count of admins ask whether a grantee is a person, and a person's `sub` is the one key shape Mesh guarantees. `anyone` (nebula-accounts-and-apps-have-names.md) is then neither a person nor a local principal, and a view shows it as what it names | `isLocalPrincipal(sub)`, true for any key not shaped like a UUID: true for `anyone` too, so the guidance would have a view hide a public `read` and a climb skip it. Local principals required to take the form `kind:name` now, with `isLocalPrincipal` testing for the colon: every page still handles `anyone` apart, and the guard would land before the grantee it protects against. A Client helper that answers a node's grantees already sorted: more than any caller asks today, and it presupposes `anyone` |
| **D16. `createNode` answers an object, `{ outcome }`, whose outcome is `'created'`, `'existing'` or `'differs'`, and refuses a slug a sibling holds with `SlugTakenError`** (Larry, 2026-11-22; was Q15). A caller that kept the old answer as a node id fails to compile (C26), and a slug our code needs held by another node stays loud until someone resolves it | A bare string: `'created'` is a string, so every line that kept the id compiles and passes it on as a node id. A taken slug answering `'differs'`: a conflict someone has to resolve would read as an admin's harmless rename, and our node would silently never exist. A fourth outcome, `'slug-taken'`: the Galaxy would ignore it with the others unless it logged that one apart |
| **D17. `system:{scope}` holds dominion over its scope and passage above it, worked out from its name as for an admin of that scope, with no grant written anywhere; ADR-025 is amended for it** (Larry, 2026-11-22; was Q16). A Galaxy's own code may act freely in its child Stars, as the Galaxy's admins may. Its claims stay in the node in this task, and nothing argues against a later task carrying them across a call (DI5). An app's code is expected to run as its Galaxy's `system:{scope}`, which nebula-app-lifecycle-hooks.md confirms: it then holds dominion over every tenant Star, and Larry accepts that this asks for diligence in that code | `system:lumenize` with `admin` granted at every root: a grant to write at every construction, restore when revoked, and show every member as an admin nobody can ask. Dominion always denied, the node a plain member of its own scope: every create would need a grant written first. An app's code under a principal of its own, narrower than dominion: a second root grant in every Star, for the same power over its tree |

## Open questions

None is open.
