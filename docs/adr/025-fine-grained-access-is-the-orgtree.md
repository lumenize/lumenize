# ADR-025: Fine-Grained Access Is the orgTree, and a Local Principal Holds Grants Only There

**Date**: 2026-10-15
**Status**: Proposed
**Deciders**: Larry
**Evidence**: `requireChatWrite` (`apps/nebula/src/galaxy.ts`), which gates the Galaxy's source and builds with `orgTree.requirePermission(CHAT_NODE_ID, 'write')`; `OrgTree.requirePermission` (`packages/resources/src/org-tree.ts`), the one fine-grained check; `TransactionOpts.pinnedAtDoor` (`packages/resources/src/snapshots.ts`), which let the platform's own writes skip that check. Decided in `tasks/nebula-agent-posts-as-itself.md` § *Decisions*, whose first draft proposed reading the chat with no check at all.

## Context

**Fine-grained access control is decided against a node's orgTree.** Grants sit on the tree's nodes in three tiers, `read`, `write` and `admin`, and trickle down to every node beneath ([`docs/vision/auth.md`](../vision/auth.md) § *The data plane and fine-grained access control*). The tree is access control, not an org chart: a node holds resources and the nodes beneath it, and the grants on it define an audience. In the Galaxy `acme.crm`, the grants on the `chat` node define an audience of the people building the app and the agent.

**Two uses of the tree were never written down, and each drew a proposal to work around it.**

- **The tree gates operations as well as resources.** Since 2026-09-05, `requireChatWrite` has gated the Galaxy's source and builds by `write` on the chat node, though no resource is involved. The vision document described the tree as gating resources, so the gate read as a borrowing, and the fix proposed was a second permission store kept equal to the tree.
- **The platform acts on its own behalf.** Studio's agent posts to the chat when no person's call is there to post in, and reads the thread to answer it. The first proposals were a server read with no check and a Registry membership for the agent, and `pinnedAtDoor` already let the platform's own writes skip the check.

The rest of this ADR commits the orgTree as a node's one fine-grained access control, and the local principal as the identity that holds grants there and nowhere else.

## Decision

### Terminology

- **Membership** — a grant in the Registry: one address in one scope, which every session rests on ([`auth.md`](../vision/auth.md) § *Identity and membership*).
- **Local principal** — an identity that holds grants in one node's orgTree and no membership. `agent:lumenize` in the Galaxy `acme.crm` is the first: it holds `write` on the Galaxy's `chat` node, and the Registry has no row for it.

**`local principal` names the pattern, not the agent.** The agent is its first case.

### The orgTree is a node's one fine-grained access control

**A node gates its resources and its own operations against the same orgTree, with the same check.** An operation gated by audience names a node and a tier in that tree: `readSource`, `writeSource` and `buildNow` require `write` on the Galaxy's `chat` node, the grant a post needs. A node keeps no second permission store beside it.

These things follow:

- **One grant cannot diverge from itself.** Whoever can post can change source, because the post and the source write read the same grant.
- **Dominion's bypass covers operations too**, since the check is the same: an admin whose dominion covers the node needs no grant ([ADR-015](015-passage-and-dominion.md)).
- **Where a grant sits is what it covers.** A grant on the root covers every node beneath it, so a grant meant for one audience goes on that audience's node, and anything with a different audience gets a node of its own beside it.

### A local principal holds grants in one orgTree and nothing else

**A local principal acts on its node's behalf through the same check as anyone.** Mesh builds its claims on the server, only server code runs under them, and every read or write it makes passes the orgTree check against its own grants. `agent:lumenize` reads the Galaxy's chat and posts there because it holds `write` on `chat`, never because a check was skipped.

These things follow:

- **Its grant is ordinary data in the tree.** It is seeded when the tree is created, visible to the tree's members like every grant ([ADR-008](008-full-org-tree-visibility.md)), and revoked by an admin like any other.
- **Coarse-grained checks never see it.** Its claims carry no admin bit and never leave its node: a call made under them starts a fresh chain, so the callee sees the node speaking for itself ([ADR-015](015-passage-and-dominion.md)).
- **It has no session to steal and no subject to impersonate.** A session rests on a membership, and the impersonation mint requires an accepted one; a local principal holds neither.
- **Its `sub` names what it is**, as `agent:lumenize` does, and is never a UUID. Built claims therefore cannot carry a person's random id or a persona's name-based one.
- **Its records name it.** Its own writes carry it as the subject. A write the agent makes in a person's turn carries the person as the subject and the agent as the actor ([ADR-016](016-record-the-acting-principal.md)).

**A persona is not a local principal.** Its tab gets a token on its own host, with its Star as `aud`, and the account's admin persona holds dominion there ([ADR-022](022-every-session-lives-on-the-platform-host.md)). Mesh builds a persona's claims the same way to seed its data, which is the mechanism the two share.

> **Today's code differs.** The agent's reply names the poster as subject and the agent as actor, the reply and each landing's `ServedBuild` skip the check through `pinnedAtDoor`, the Galaxy's chat node is its root, and nothing builds a local principal's claims or a persona's. `tasks/nebula-agent-posts-as-itself.md` makes the agent the first local principal.

## Alternatives considered

- **A second permission store for operations, kept equal to the orgTree.** It separates resources from operations cleanly. But every invite, revoke and promotion then writes two stores that must stay in step ([ADR-010](010-random-opaque-keys.md)'s replication rule), and the first drift lets someone post who cannot change source, or the reverse.
- **The platform's own reads and writes skipping the check on its own say-so.** `pinnedAtDoor` did this for writes, and the first draft of the agent's own turn would have read the chat this way. Each is a second path that every rule added to the check later skips, and the read would have been the first made on nobody's behalf whose result is then posted to people.
- **A Registry membership for the agent.** It would be a login: a token, passage and dominion to confine, and a subject an admin could impersonate. [`auth.md`](../vision/auth.md) § *When the agent acts* rejects it.
- **The agent only ever an actor on a person's write**, the model until 2026-10-10. It left the agent nothing to post as when no person's call was there: an outcome arriving in a result handler, or a turn the agent starts itself.

## Consequences

- **Positive.** One check for every identity and every gated operation, so a rule added to it binds them all. A local principal's access is visible and revocable where the tree's members already look. The next case follows the pattern instead of inventing an exception: an app's own assistant posting in a tenant's Star (`tasks/nebula-pre-alpha-fast-follow.md` § *Item 2: App-branded AI persona*).
- **Negative / accepted.** A local principal's grants pass every operation its node gates by the tree, so the agent meets the gate on source. What bounds that is which server code runs under its claims, and a source write made there is traceable and reversible, which [`_ai-security.md`](../vision/_ai-security.md) § *Reversibility, not agency, is the risk variable* says needs no gate. A grant placed too high covers too much, since grants trickle down; the remedy is a node for the audience, as the Galaxy's `chat` node is.
