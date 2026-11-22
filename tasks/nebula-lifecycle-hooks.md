# Our hosts' lifecycle hooks replace the tree seed

**Status:** Pass 1, drafted 2026-11-21, revised and split on 2026-11-22 for Larry's hand review; phases are not written. It comes before [nebula-query-upgrade.md](nebula-query-upgrade.md), and [nebula-app-lifecycle-hooks.md](nebula-app-lifecycle-hooks.md) gives an app the same hooks after that task (§ *Relationships*).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `D` a decision Larry made, and `Q` an open question. C4 is the fourth claim raised, wherever it sits. A gap is an item removed or answered. Items raised before the split keep their numbers, so a gap may also be an item that moved to nebula-app-lifecycle-hooks.md.

## Objective

**Our hosts create the orgTree nodes their pages name, and write back the grants the platform's own principals need, through lifecycle hooks, with no tree seed and no protected grant. `onNewOntologyVersion` is a new method beside Mesh's `onStart`: the plane calls it from `#install` when a host moves onto a new ontology version, before the host answers any call at that version, and `onStart` runs whenever the constructor runs. Both run in-process, and what they write to the tree they write as `system:lumenize`, through the operations a page calls.**

```ts
// apps/nebula/src/galaxy.ts — our host's hooks, in-process, with no facet
onNewOntologyVersion({ orgTree }) {
  // Synchronous, inside the install, before the row is recorded
  orgTree.createNode(CHAT_NODE_ID, ROOT_NODE_ID, 'chat', 'Chat', [{ sub: NEBULA_SUB, tier: 'write' }]);
  orgTree.createNode(MESSAGES_NODE_ID, CHAT_NODE_ID, 'messages', 'Messages');
  orgTree.createNode(TURNS_NODE_ID, CHAT_NODE_ID, 'turns', 'Turns');
}
// onStart already exists. It gains one step: write the agent's grant at chat back
// when an admin has removed it
```

What happens over a Galaxy's life:

1. The first call at the chat ontology's version finds nothing installed, so `#install` runs the Galaxy's `onNewOntologyVersion` as `system:lumenize`. It creates `chat`, `messages` and `turns`, with the agent's grant on `chat`, then the row is recorded and the call is answered.
2. An admin renames `messages`. When the chat ontology's version next changes, `onNewOntologyVersion` runs again, finds each node in place, and leaves the rename as the admin left it.
3. An admin revokes the agent's `write` at `chat`, which dominion allows. The agent cannot post until the Galaxy's next start, whose `onStart` finds the grant missing and writes it back.

## Context

**Our Galaxy creates its nodes a way no app can.** `GALAXY_TREE_SEED` declares `chat`, `messages` and `turns` at fixed ids, and reaches `OrgTree` through a `Resources` constructor option. `#ensureSeed` writes them with `INSERT OR IGNORE` and no permission check, on every construction. `mesh.md` § *Nebula reaches its resources the way an app does* now forbids this outright, and lists it under *Today's code differs*.

**The seed also protects the agent's grant at `chat`, so no admin can revoke it.** `protected` came in on 2026-11-11 for that one grant. Larry decided on 2026-11-22 to remove it, since dominion exists so an admin can maintain a tree (D7).

**Larry made the lifecycle hooks parallel on 2026-11-22 (D9).** Each hook has an in-process form for our hosts and a facet form for an app. This file builds ours, so the Galaxy drops its seed before nebula-query-upgrade.md builds on it, and nebula-app-lifecycle-hooks.md hands the same call to an app's code later.

What stands in the way today:

- **B2. Nothing runs between receiving a version and answering at it.** `#install` is synchronous and records the row in one write (C1), so the first call at a new version is answered at once.
- **B5. `createNode` refuses a node an admin has renamed or moved.** It replays only for the same id, slug and parent, and throws `NodeIdCollisionError` otherwise (C8). A hook that called it at every version would fail in any tree whose admin had changed a node.
- **B6. The seed writes with no check, and protects a grant from every admin.** `#ensureSeed` writes its nodes and grants with no permission check, and `#protectedTier` refuses to revoke or lower a grant the seed marks protected (C6).

The sections that follow say what the hooks do, the claims that design rests on, and the question Larry decides before phases are written.

## Goals

1. **Every node our hosts' pages name exists before the first call at the version that names it.** Today the seed writes it on every construction, with no check.
2. **An admin's change to a node survives every later version.** A node renamed, moved or re-granted stays as the admin left it. Today `#ensureSeed` holds this for a seed's nodes, and `createNode` would throw on it (B5).
3. **The hooks do only what a page can do, and their writes say who made them.** They call the operations a page calls, each checked as a page's call is, and each write records the principal it ran as (ADR-016).
4. **Our Galaxy creates its nodes as an app does** (D3). Today it seeds them through a constructor option no app has, with no check.
5. **No grant refuses an admin's dominion** (D7). Today the agent's grant at `chat` does.

## Relationships

- **Before [nebula-query-upgrade.md](nebula-query-upgrade.md)** (Larry, 2026-11-22), so our Galaxy drops its seed before that task is built, and nothing more is built on the seed to be unlearned later.
- **Before [nebula-app-lifecycle-hooks.md](nebula-app-lifecycle-hooks.md)**, which comes after nebula-query-upgrade.md and hands the same call to an app's code through a facet. It builds on D4, D6, D8 and D9 here.
- **Changes [nebula-accounts-and-apps-have-names.md](nebula-accounts-and-apps-have-names.md)**, whose design adds a `meta` node and its grant to `anyone` through every scope's seed. Under D3 they come from each plane's in-process `onNewOntologyVersion`, so that file's DI1, DI2 and C1 change with it.

## Current state

Built already:

- **`Resources.#install`**, which records a row in one write, drains what a replaced version invalidates, matches indexes and, on `.dev`, counts rows the new validator refuses. *Adapted:* it calls the host's `onNewOntologyVersion` as `system:lumenize`, synchronously, before it records the row (DI2).
- **`ScopedMeshDO.onStart`, which the Galaxy and the Star override.** *Carried over:* the Galaxy's gains the step that writes the agent's grant back (DI11), and the plane gains `onNewOntologyVersion` beside it (DI12).
- **`OrgTree.#ensureSeed`, `TreeSeed`, `#protectedTier` and `ProtectedGrantError`.** *Adapted:* `protected` goes, with `#protectedTier`, `ProtectedGrantError` and `deleteNode`'s note about protected grants (DI13). The plane writes the root and `system:lumenize`'s grant there, the Galaxy's nodes leave the seed (D3), and Q8 settles the rest.
- **`GALAXY_TREE_SEED` and its JSDoc in `chat-constants.ts`.** *Adapted* (D3, D7, Q8).
- **`createNode`, and the Client's call to it in `client-resources.ts`.** *Adapted:* it leaves an existing node as it stands, writes a new node's starting grants with it, and answers whether it created the node (D6).
- **`setPermission`**, which upserts (C15). *Carried over unchanged:* writing a grant back reads it first, and calls `setPermission` only when it is missing or lower.
- **`lmz.asLocalPrincipal`**, which builds claims with the principal as `sub`, the node as `aud`, and never `scopeAdmin`. *Carried over unchanged:* it refuses only a name shaped like a UUID, and nothing keys on the `agent:` prefix.
- **`NEBULA_SUB`**, the constant holding `agent:lumenize` in `packages/mesh/src/auth/types.ts`. *Carried over;* `system:lumenize` gets a constant beside it (D4).
- **`inviteAlso` and `#writeInviteAlso`**, which add the read at `chat` when an invite at `messages` is accepted (C16). *Adapted* (Q8).
- **ADR-025's paragraph on the agent's protected grant, and the protected grant in ADR-015's line in `workflow.md`'s index.** *Adapted:* both go with D7.

## Design intent

- **DI2. Our hosts run `onNewOntologyVersion` inside `#install`, synchronously, before the row is recorded, and answer no call at that version until it is recorded** (D9). No other event runs in between, and an eviction mid-run makes the next call run the install again, which DI6 makes safe.
- **DI5. Our hosts' hooks run as one local principal, `system:lumenize` (D4), which holds `admin` at the root of every host's tree.** The plane writes the grant, so every host has it by composition (ADR-007). It is an ordinary grant an admin can revoke, as dominion allows (ADR-015), and the plane writes it back (DI11). Each write records the principal (ADR-016), and the tree shows its grant to every member (ADR-008). It runs the code the platform calls, an app's included once nebula-app-lifecycle-hooks.md lands, and never acts for a person, which `agent:lumenize` does.
- **DI6. `createNode` leaves an existing node as it stands, so a hook can run at every version without undoing an admin's change** (D6).
  - **It writes the node, its edge and its starting grants in one storage write, and only when the node is absent.** An admin's rename, move or revoke therefore survives, as a seed's does today.
  - **It answers whether it created the node,** so a hook can do more for a node it just made.
  - **It checks `write` at the parent, and each grant as `setPermission` would,** for a page's call and a hook's alike.
  - **Within one install run, a second call that names an id with another slug or parent is refused, naming both.** No admin's change can cause that within a run, so two constants given the same id fail loudly instead of sharing one node and its grants.
- **DI8. Our Galaxy's chat nodes come from its own `onNewOntologyVersion`** (D3), a method on `Galaxy` that receives the same object an app's hook will (`mesh.md` § *Nebula reaches its resources the way an app does*). The agent's `write` at `chat` is a starting grant of `chat`, written with the node (C5), and an ordinary grant, which `onStart` writes back (DI11). The invite pairing is Q8.
- **DI11. Each start writes back the grants the platform's own principals need** (D8).
  - **The plane writes `system:lumenize`'s `admin` wherever it writes the root,** with no check, as tree bookkeeping no one person asked for (ADR-025). That is every start, and the rebuild after a `.dev` wipe (C9).
  - **The Galaxy's `onStart` writes the agent's `write` at `chat` back,** as `system:lumenize`, once `chat` exists.
  - **A grant found in place is not written** (C15), so a start writes nothing unless an admin removed something.
  - **A throw is logged at `error`, which raises a Workers Issue, and the start goes on,** since writing a grant back only restores what an admin removed.
- **DI12. Each lifecycle hook has an in-process form for our hosts, which this file builds, and a facet form for an app** (D9).
  - **`onStart` is Mesh's existing method, which the Galaxy and the Star already override. `onNewOntologyVersion` is a new method beside it, which the plane calls from `#install`.** It is a new hook because no lifecycle method a node already has does the job (`mesh.md` § *Nebula platform code never drops to raw primitives*): `onStart` runs only when the constructor runs, and a new version arrives while a node is running.
  - **A hook receives one object: `orgTree`, holding the tree's methods, and `resources`, holding `transaction`, `read` and `query`.** These are the one-time operations a page calls through `client.orgTree` and `client.resources`. A subscription has no page to push to, and an invite would send mail at every version.
  - **The object holds plain methods over structured-clone values and closes over no local state,** so nebula-app-lifecycle-hooks.md can hand the same object across a facet.
  - **Ours are synchronous, as in-process tree operations are.** An app's answer across the facet, so they are async.
- **DI13. No grant refuses an admin** (D7). `protected`, `#protectedTier`, `ProtectedGrantError` and `deleteNode`'s note about protected grants go. A grant the platform's own principals need is written back instead (DI11).

Claims the design rests on:

- **C1.** `#install` records a row in one `transactionSync` and returns nothing to wait on. Its callers are `#settle`, which every Client op's gate reaches, and `#onOntologyPulled`, a fire-back handler.
- **C5.** `Permissions.nodeId` references `Nodes`, so a grant at `chat` cannot be inserted before `chat` exists.
- **C6.** `#protectedTier` reads protected grants from the seed the host passed in, so a grant is protected only by a host's declaration, and no operation can make one.
- **C8.** `createNode` checks `write` at the parent, replays for the same id, slug and parent, and throws `NodeIdCollisionError` for the same id under another slug or parent.
- **C9.** A `.dev` wipe drops the tree's tables and rebuilds the plane's parts, so `OrgTree`'s constructor, which writes the root, runs again (`#wipe` and `#build` in `resources.ts`).
- **C15.** `setPermission` writes with `INSERT … ON CONFLICT DO UPDATE`, so calling it for a grant already in place still writes a row.
- **C16.** `Galaxy.invite`, behind the agent's `invite` tool, is the only call in `apps/nebula/src` that invites at a node: `#resources.invite(MESSAGES_NODE_ID, [{ email, tier: 'write' }])`. The pairing's read at `chat` is written when the invite is accepted, by `#writeInviteAlso`, which leaves a grant already held there as it is.

## Constraints

- **[ADR-007](../docs/adr/007-shared-node-security-core.md)**: the install step and the grant write-back are the plane's, so every host runs them by composition.
- **[ADR-015](../docs/adr/015-passage-and-dominion.md)** and **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)**: dominion can revoke any grant, and a local principal holds grants in its node's tree and no membership. ADR-025's paragraph on the agent's protected grant goes with D7, as does the protected grant in ADR-015's line in `workflow.md`'s index.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)**: every write a hook makes records the claims it ran under.
- **`mesh.md`** § *Nebula reaches its resources the way an app does*: our own code reaches the plane only as an app can (D3). Its section on adding a hook asks why no existing lifecycle method does the job, which DI12 answers.
- **`durable-objects.md`**: a start writes nothing when every grant is in place, and nothing depends on a host staying awake.
- **`live.md`**: a `/live` scenario creates a Galaxy, finds its chat nodes and the agent's grant, revokes the agent's grant as its admin, sees the agent refused, and finds the grant back after the Galaxy's next start.

## Beyond this task

- ⚠️ Design consideration: **a host could restart itself when it finds a grant its own principals need missing** (Larry, 2026-11-22, for a later day if it is ever seen). Under D7 a revoke lasts until the next start, and `ctx.abort()` is the restart Cloudflare itself uses.

## Decisions

D1, D2 and D5 moved to nebula-app-lifecycle-hooks.md with the split.

| Decision | Alternatives weighed |
|---|---|
| **D3. The platform's own nodes come from install code too, and `mesh.md`'s rule that Nebula reaches its resources as an app does is absolute** (Larry, 2026-11-22; was Q2). What today's code still does differently sits in that section's *Today's code differs* block | The seed keeps declaring the platform's nodes, and install code creates only an app's: a split by whose node it is, with no requirement behind it, since the platform needs no node before its first install |
| **D4. The install principal is `system:lumenize`** (Larry, 2026-11-22; was Q3). Kubernetes reserves `system:` for its own control-plane users and groups, and Windows' SYSTEM account is its highest-privilege local principal, as a root `admin` held on every host is here. The name still fits once a migration export runs as the same principal | `installer:lumenize`: wrong once a migration hook runs as it. `platform:lumenize`: `PLATFORM_SCOPE`, `_platform` and `isPlatformScope` name the root scope and `platform.lumenize.dev` the session host, so a record would read as one of those. `app:onNewOntologyVersion`: our Galaxy's install code would need a second principal. `agent:lumenize`: a node an app's code made would read as the agent's work, and the agent would hold `admin` at every root |
| **D6. `createNode` is the one create, and idempotent: it leaves an existing node as it stands, writes a new node's starting grants in the node's own write, and answers whether it created the node** (Larry, 2026-11-22; was Q4). Within one install run, naming an id with two slugs or parents is refused | A second method, `ensureNode`, beside a `createNode` that keeps throwing: the throw guards only a page's creates, which mint ids with `crypto.randomUUID()` and do not collide, and the model would choose between two methods. Install code reading the tree and skipping the ids it holds: every app carries the check, and a grant written after its node is lost to an eviction between them |
| **D7. `protected` is removed: a grant the platform's own principals need is written again when found missing, never refused to an admin** (Larry, 2026-11-22; was Q7). Dominion exists so an admin can maintain a tree, and a grant only one principal could change would veto it. A revoke lasts until the next start writes the grant again | Install code marking a grant protected, changeable only by `system:lumenize`: that principal would veto every admin's dominion. Protection kept for the agent's grant alone: it guards a revoke the product cannot undo today, at the cost of a mechanism dominion has to step around. The grant left in the Galaxy's seed: a standing exception to D3 |
| **D8. Each start writes back the grants the platform's own principals need, then runs an `onStart` export as `system:lumenize`** (Larry, 2026-11-22; was Q9). Our Galaxy's `onStart` runs in-process, with no facet, and an app's runs in its facet, which a Star loads at start only when `index.ts` exports `onStart`. A grant found in place is not written, and a throw is logged while the start goes on | At every install only: a revoked agent grant would stay revoked until the chat ontology's next version, which is rare. From a list each host declares, read at every start: the declarative seed D3 moved away from |
| **D9. Each lifecycle hook has an in-process form for our hosts and a facet form for an app, and our hosts' half is built first** (Larry, 2026-11-22). `onNewOntologyVersion` joins Mesh's `onStart` as a method our hosts implement, and the plane calls it from `#install`, synchronously, before the row is recorded. An app's exports get the same names and the same object later, through a facet | Only the facet form, for our code and an app's alike: our Galaxy would wait on the folder, the facet and the build box before it could drop the seed, and its hooks would pay a facet load for code that lives in our own Worker |

## Open questions

- **Q8. What becomes of the invite pairing.** After D3, the seed still holds this line:

  ```ts
  // Whoever is invited at messages, to post, also gets read at chat,
  // so they read the turns as well as the thread
  inviteAlso: [{ at: MESSAGES_NODE_ID, grant: { nodeId: CHAT_NODE_ID, tier: 'read' } }],
  ```

  `invite(nodeId, invitees)` gives each invitee one tier at one node, and the pairing adds the read when the invite is accepted. Nothing an app calls declares a pairing.
  - **(a) A hook declares a pairing through a tree method,** stored in the tree. A hook only adds, so a pairing a later version drops stays until something removes it.
  - **(b) An invite carries every grant it gives,** `invite(grants, invitees)`, and `Galaxy.invite`, the only call that invites at `messages`, passes both grants (C16). Nothing is stored to keep in step with the code, and any app can invite to more than one node. `_InviteStatus` keys on one row per address and node today, so its shape changes.
  - **(c) The pairing stays in the Galaxy's seed,** and `mesh.md`'s block names it for good.
  - **Recommendation:** (b). It deletes the pairing rather than moving it, and widening one parameter is the general form.
