---
title: Access control
description: "Nebula's org/permission tree — how resources attach to nodes, how grants cascade additively, and the two ways to share: a grant vs. a second parent."
---

# Access control

Every resource is attached to a node in your app's **org/permission tree**. The attachment happens at create time: `OperationDescriptor.create` carries a `nodeId: string` field naming the node the new resource lives under. After creation, the attachment can be changed with `op: 'move'`.

## What "org" means here

"Org tree" pulls in two directions:

1. **Mimicking your organization's structure.** For an internal HR or project-management tool, the tree might literally mirror your business: company → divisions → teams → individuals. People in higher-up subtrees get grants that cascade to everything below.
2. **Organizing data for permissioning.** Equally common: the tree has nothing to do with your business and is just a way to group resources so permissions can be granted in bulk. A consumer SaaS app might use it to give every user their own subtree, with no real-world "org" anywhere in sight.

Both uses get the same mechanics. The "org" in "org tree" reads more as a verb (to organize) than a noun.

## Permissions table and resolution

Each node carries a permissions table — `sub` → `'admin' | 'write' | 'read'`. A grant's key is one of two things: a person's `sub`, the subject claim from their JWT, which is a bare UUID minted by Mesh's auth layer; or a key that names what holds the grant, as `agent:lumenize` does for Lumenize's own agent. `isPersonSub`, imported from `@lumenize/resources/frontend`, tells them apart. Grants are matched by exact string equality against the caller's `sub`. Effective permission for `(sub, nodeId)` is the **highest grant found on any ancestor path** from the resource's attached node up to root.

```typescript @skip-check
// Conceptual — actual API surface lives on client.orgTree. A person's key is a
// bare-UUID JWT sub (aliceSub etc. shown as variables for readability).
node.permissions = new Map([
  [aliceSub, 'admin'],
  [bobSub,   'write'],
  ['agent:lumenize', 'write'],   // not a person: the key names what holds the grant
]);
```

Three properties follow:

- **Permissions cascade additively.** A grant on a parent applies to every descendant. Lower nodes can grant more, never less. To narrow access, attach the resource to a deeper node where only the right users have grants on the ancestors.
- **The whole tree — structure *and* the full permissions table — is universally visible.** Every connected client gets the entire tree at `store.lmz.orgTree.value`, including every node's grants (`sub → tier`). Visibility isn't restricted because the permission UX wants every client to resolve, locally, *who to ask*: climb from a node you can't reach to the nearest ancestor with an `admin` grant and request access from them — no server round-trip. Resource **values** are still gated by permission at every read and write; the **structure and the grant table** are universal.
  - **A person's grant key is an opaque user ID** — their `sub` is a bare UUID, not a name or email — so the table exposes *who-can-do-what by ID*, not by identity. Mapping a `sub` to a person needs a separate lookup the tree doesn't carry. A key that is not a person's says what it is, as `agent:lumenize` does.
  - **Every node's `label`/`slug` is visible to every client** — the whole node set ships to everyone, not just nodes you can reach (it has to: requesting access to a node you *can't* reach means seeing what it is). So labels, not the opaque grant keys, are the real identity surface — a node labeled `user-alice` whose admin grant is some `sub` lets anyone deduce who that `sub` is. **Accepted known risk:** higher-permissioned users are discoverable, and the protection relied upon is **tenant segmentation** (members already share an organization). Apps that want to reduce it further can use opaque per-person slugs and render human names only to those who should see them — but that's optional hardening, not required.
  - **The `permissions` map shows DAG grants only — it is not the complete admin picture.** Galaxy- and Universe-level scope admins have effective admin on the whole tree, but that's a property of their JWT (`claims.access.scopeAdmin`), not a node grant, so they do **not** appear in the map. Treat the map as "who was explicitly granted what," and check `claims.access.scopeAdmin` separately for scope admins (see [Coding your UI § Gating admin-only UI](./coding-your-ui.md#gating-admin-only-ui)).
- **Permission checks run on every transaction.** The server resolves the effective permission for the calling user against each affected resource's attached node before applying any op. A failed check returns `{ kind: 'permission-denied' }` for that resource in the per-type [`onTransactionResourceResolution`](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler) handler. Tier by op: `create` needs `write` on the target `nodeId`; `put` / `delete` need `write` on the resource's attached node; `move` needs `write` on **both** the source and destination nodes; `read` needs `read` on the attached node. A subscription is the exception: it is told what it cannot read rather than refused (next bullet).
- **A subscriber is checked on every update, and told what it cannot read rather than refused.** A subscribe never fails for permission. Each update carries what the subscriber can read, and `deniedNodes` names the nodes it cannot: a resource subscriber's `.snapshot` resolves `null` and its store entry holds `deniedNodes` with no `value`, and a query subscriber gets only the ids it can read. A revoked grant shows at the next update to what the subscriber watches, with nothing from the resource in it. A new grant shows at the next org-tree change for a client watching the tree, as every `createNebulaClient` client does, since that client re-subscribes whatever was denied; any other client sees it at the next update. See [`client.resources.subscribe`](./api-reference.md#resourcessubscribe).

## Worked example: sharing in a todo-list app

Suppose you're building a todo app. Each user has many lists; some are private; some get shared with other users. The natural starting tree:

```mermaid
graph TD
  root([root])
  alice([user-alice])
  bob([user-bob])
  carol([user-carol])
  shopping[list-shopping]
  work[list-work]
  personal[list-personal]
  trips[list-trips]
  root --> alice
  root --> bob
  root --> carol
  alice --> shopping
  alice --> work
  bob --> personal
  carol --> trips
```

Alice has `admin` on `user-alice`; that grant cascades to both her lists and to every todo attached under them. Bob has `admin` on `user-bob` only — by default he can't see anything in Alice's subtree.

### Every box in that tree is a node

The lists are nodes, as the users are. A grant is made on a node and reaches everything beneath it, so a thing someone may share on its own needs a node of its own. Were Alice's lists resources attached straight to `user-alice`, the only node to grant Bob anything on would be `user-alice`, and he would get every list she has.

So creating a list is two steps: make the list's node under its owner's, then attach the list resource to that node. Its todos attach there too.

```typescript @check-example('apps/nebula/test/test-apps/baseline/for-docs.test.ts')
// A list someone may share on its own gets a node of its own, under its owner's.
const listWorkNodeId = crypto.randomUUID();
await client.orgTree.createNode(listWorkNodeId, userAliceNodeId, 'list-work', 'Work');

// The list, and everything in it, attaches to that node.
const listWorkId = crypto.randomUUID();
await client.resources.transaction({
  [listWorkId]: { op: 'create', typeName: 'todoList', nodeId: listWorkNodeId, value: { items: [] } },
});

// Sharing this one list is a grant on its node, which the list's own meta names.
const listNodeId = store.resources.todoList[listWorkId].meta.nodeId;
await client.orgTree.setPermission(listNodeId, bobsSub, 'read');

// Who the list is shared with is read back from the tree, never kept in the list's value.
// A grant's key is a person's `sub`, or names what holds it, as `agent:lumenize` does.
const sharedWith = computed(() =>
  [...(store.lmz.orgTree.value.permissions.get(listNodeId)?.keys() ?? [])].filter(isPersonSub));
```

- **The tree is the only record of who has access.** Keep no `members` or `sharedWith` field in a resource's value. A second copy drifts from the grants, and it is the grants that are enforced.
- **A grant's key is a person's only when `isPersonSub` says so.** A view that lists a node's grants shows any other key as what it names, the agent for `agent:lumenize`, and never looks it up as a profile. A count of admins skips it, and so does a climb to the nearest admin to ask for access, since nobody reads a request sent there.
- **`meta.nodeId` is on every store entry**, a resource the page has just created included, so the page never stores a node's id in a value either.
- **When you have a person's address and not their `sub`**, `client.resources.invite([{ email, grants: [{ nodeId, tier }] }])` makes the same grant, and makes them a member of the app first if they are not one. One invite can name several nodes for one person, `read` on a list and `write` on its items say, and sends one email.

Now Alice wants to share `list-shopping` with Bob. There are **two ways** to express that — each illustrates a property of the underlying structure.

### Approach 1: Grant a permission on the shared node — for limited-access sharing

This is the right approach when Alice wants to give Bob **limited** access — typically read-only. She grants `bob: read` (or `write` — her choice) on the `list-shopping` node:

```mermaid
graph TD
  root([root])
  alice([user-alice])
  bob([user-bob])
  shopping["list-shopping<br/><i>bob: read</i>"]
  work[list-work]
  personal[list-personal]
  root --> alice
  root --> bob
  alice --> shopping
  alice --> work
  bob --> personal

  style shopping fill:#ffe4b5,color:#000
```

Bob's effective permission on `list-shopping` is now exactly the tier Alice picked — independent of whatever rights he has on his own subtree. The list stays in Alice's subtree; Alice remains the owner; Bob has the narrow access she granted him.

**Use this when:**
- You want to share **read-only** — let someone view but not edit.
- You want to share `write` while keeping `admin` (control over deletion, sharing, etc.) to yourself.
- The relationship is asymmetric: one clear owner, one collaborator with limited rights.

**Tradeoff:** the shared list stays in the owner's subtree, so the sharee's UI has to surface it via a "shared with me" view that pulls from outside their natural subtree.

### Approach 2: Add a second parent — for co-ownership

This is the right approach when Alice and Bob should be **true co-owners** of `list-shopping`: `user-bob` becomes a second parent of the list.

Adding a parent edge is an access grant in structural clothing — everyone with grants on or above the new parent gains cascaded access to the child's subtree — so `addEdge` requires `write` on the new parent **and `admin` on the child** (the same tier `setPermission` demands). Neither party holds both (Alice has no `write` on `user-bob`; Bob starts with no `admin` on the list), and that's the point: co-ownership takes both the owner's consent and the recipient's acceptance. The flow is a two-step share-accept:

1. **Alice offers** — grants Bob `admin` on the list (Approach 1 mechanics, at the top tier): `setPermission(listShoppingId, bobSub, 'admin')`.
2. **Bob accepts** — adds the edge into his own subtree: `addEdge(userBobNodeId, listShoppingId)`. He holds `write` on `user-bob` and, since step 1, `admin` on the list.
3. **Optional cleanup** — the direct grant is now redundant (Bob's `admin` on `user-bob` cascades to the list through the new edge): `revokePermission(listShoppingId, bobSub)` keeps the permissions table minimal.

```mermaid
graph TD
  root([root])
  alice([user-alice])
  bob([user-bob])
  shopping[list-shopping]
  work[list-work]
  personal[list-personal]
  root --> alice
  root --> bob
  alice --> shopping
  alice --> work
  bob --> personal
  bob -. "2nd parent" .-> shopping

  style shopping fill:#ffe4b5,color:#000
```

After cleanup, no direct grant on `list-shopping` remains. Effective-permission resolution climbs **all** ancestor paths and takes the maximum: Bob has `admin` via `user-bob`, Alice via `user-alice`. **Both users have full admin over the list.**

The flexibility to give one node multiple parents is what makes the underlying structure technically a **DAG** (directed acyclic graph) rather than a strict tree. The "tree" in "org/permission tree" is a friendly shorthand; the actual graph type is a DAG, with all the extra modeling power that brings.

**Co-ownership is real, not nominal.** If Alice later "removes the list from her account" — which in UI terms means deleting her parent edge — the list doesn't disappear:

```mermaid
graph TD
  root([root])
  alice([user-alice])
  bob([user-bob])
  shopping[list-shopping]
  work[list-work]
  personal[list-personal]
  root --> alice
  root --> bob
  alice --> work
  bob --> personal
  bob --> shopping

  style shopping fill:#ffe4b5,color:#000
```

`list-shopping` still exists under `user-bob`, who retains full admin. Symmetric: if Bob removes his edge instead, Alice keeps full admin. **Either party can leave; the other keeps everything.**

**Use this when:**
- You want both parties to have the same rights — e.g., a shared household to-do list both partners can edit and reshare equally.
- You want either party to be able to leave the relationship without disrupting the other.
- You want the shared item to appear in the second user's natural subtree, with no "shared with me" framing.
- You want to give a whole group access by attaching a single edge — e.g., add `team-eng` as a second parent of every team project, and every member's grants on `team-eng` cascade in automatically.

**Tradeoffs:**
- You can't grant narrower-than-admin access this way. The sharee gets whatever they have on their own subtree, which is usually admin. For read-only sharing, Approach 1 is the right tool.
- Mental model is harder: the same node appears in two places.
- Cycles are still forbidden — if Alice tried to make `list-shopping` a parent of `user-bob`, the cycle detector at [org-ops.ts](https://github.com/lumenize/lumenize/blob/main/packages/resources/src/org-ops.ts) would reject it.

### When to use which

| Goal | Approach 1 (grant) | Approach 2 (second parent) |
|---|---|---|
| Read-only sharing | ✓ the right tool | ✗ — sharee gets full admin |
| Share `write` while keeping `admin` for yourself | ✓ the right tool | ✗ |
| True co-ownership (both have admin, either can leave) | awkward to express | ✓ the right tool |
| Either party can leave without taking the resource with them | ✗ — owner's delete is the resource's delete | ✓ — leaving = deleting only your edge |
| Resource appears in sharee's natural subtree | ✗ | ✓ |
| Grant to a whole group via a single edge | ✗ — per-resource grants | ✓ — one parent edge per resource |

The two approaches **compose freely** — a real app uses both. Grants for "show this list read-only to my accountant"; second-parent edges for "this shared household list belongs to all the roommates equally."

See [Coding your UI § Worked example: rendering the built-in tree](./coding-your-ui.md#worked-example-rendering-the-built-in-tree) for the client-side patterns that render this structure (including the **multi-parent rendering** case — a node with two parents shows up under each one in the tree view).

## Drawing the tree: a node for each audience

A grant gives one tier to everything beneath its node, so the tree's shape decides which grants you need. Draw it from its **audiences**: who reads a set of things, and who writes each of them.

Say a sales team reads every deal and every forecast, its reps write deals, and only its managers write forecasts. Reading is shared across both and writing is not, so the shared audience gets a node over both:

```mermaid
graph TD
  root([root])
  sales["sales<br/><i>team: read</i>"]
  deals["deals<br/><i>reps: write</i>"]
  forecasts["forecasts<br/><i>managers: write</i>"]
  root --> sales
  sales --> deals
  sales --> forecasts
```

- **Grant each tier once, at the node whose audience it is.** Everyone on the team gets `read` at `sales`, which reaches `deals` and `forecasts`. A rep gets `write` at `deals`, and a manager `write` at `forecasts`.
- **Each change is then one grant.** Taking a rep off deals is the `write` at `deals`, and they still read both. Taking them off the team is the `read` at `sales`.
- **When two grants have to agree, the tree is missing a node.** Code that keeps them in step is a second permission system the server never enforces: a revoke that also revokes elsewhere, a permission worked out from another node's grant, a check of who wrote a resource before trusting it. Add the node over the things that share an audience instead, and grant there.
