# A query names the node it reads under, and sorts, pages and limits what it answers

**Status:** Pass 1, drafted 2026-11-19 for Larry's hand review; phases are not written. `/task-management` routed it docs-first: `QueryDescriptor` is what every generated app writes its queries against. The docs the model reads are drafted in place and uncommitted, with the recommended answers to Q1, Q3 and Q4 (DI11). The embed is not regenerated, so `apps/nebula`'s `npm test` fails its drift check until they are committed or reverted. It takes [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 21* and the [backlog.md](backlog.md) row *A query cannot sort, page or limit*, so the descriptor breaks once. It lands before the first invite (§ *Relationships*).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, and `Q` an open question. C4 is the fourth claim raised, wherever it sits. A gap is an item removed or answered.

## Objective

**A query names the orgTree node it reads under, is checked against `read` there, and can sort, page and limit what it answers, in one change to `QueryDescriptor` that the docs and every caller take at once.**

```ts
const newest = {
  typeName: 'Message',
  nodeId: MESSAGES_NODE_ID,         // reads at this node and beneath it
  filter: { chat: DEFAULT_CHAT_ID },
  sort: [{ $validFrom: 'desc' }],   // the spelling is Q3
  limit: 50,
};
// Studio's chat thread: the newest page, kept live
const thread = client.resources.subscribeQuery(newest);
// the page before it, read once as the person scrolls up
const older = await client.resources.query({ ...newest, after: thread.next });
```

| Reader | Today | After |
|---|---|---|
| The Galaxy's round store | every `Round` naming the message, then keeps those at `turns` | the `Round`s under `turns` |
| Studio's tool-call marks | every `Round` naming the message, then keeps those the agent last wrote | the `Round`s under `turns` |
| The Galaxy's waiting posts | the oldest 1,000 `Message`s, each read again to check `read` | the newest `Message`s under `messages` |
| Studio's thread | the oldest 1,000 `Message`s | the newest page, and older pages as the person scrolls |
| Studio's landed build | the last of the oldest 1,000 `ServedBuild`s | the newest `ServedBuild` |

## Context

**A query names a type and a filter, and answers the matches anywhere on the host.** Studio's marks ask `{ typeName: 'Round', filter: { message: id } }`, built by `roundsOf` in `participants.ts`. The plane runs that filter over every current `Round` the Galaxy holds, then climbs the tree once for each distinct node a result sits under, to find the ones the reader may see.

**Because a query cannot say where it reads, our own readers filter afterwards.** A member who can post at `messages` can also write a `Round` there naming a running turn, so the round store in `galaxy.ts` keeps only the rounds at `TURNS_NODE_ID`. Studio's `toolCallMarks` keeps only rounds whose current snapshot `agent:lumenize` wrote. The Galaxy's `#thread()` reads every `Message` with no check, then reads each one again and skips any its read is refused. Each is a second check beside the tree, which ADR-025 rules out, and the marks' test is the one `calibration.md` § 16 names: reading who wrote a resource to decide whether to trust it. `access-control.md` § *Drawing the tree: a node for each audience* teaches user-developers the same thing, and our own readers do not follow it yet.

**A query also answers in one fixed order and stops at 1,000.** It orders by each result's latest write, oldest first, and keeps the first `QUERY_RESULT_CAP` with `more` set. So a list that grows keeps its oldest entries and drops its newest. In a Galaxy whose chat passes 1,000 messages, the agent stops seeing new posts (C4). Nothing goes red when that happens, and nothing has reached the cap yet.

**Item 21 and the backlog row break the same descriptor, so they go together.** A required node changes `QueryDescriptor`, the query's hash, every query a generated app has written, and the docs the model reads. Sort, paging and limits change the same things. Larry built node-scoped queries in an earlier orgTree system and optimized them hard there (2026-11-18): it found a node's descendants and added them to the query as an `OR` clause, up to the length its database allowed.

What stands in the way today:

- **B1. `QueryDescriptor` names no node.** It is `{ typeName, filter, allowScan? }` in `query-hash.ts`, so `#evaluateQuery` in `resources.ts` reads the whole type, and `#readableNodes` resolves `read` for each distinct node of the results, per subscriber, per push.
- **B2. No descriptor field sorts, pages or limits.** `#evaluateQuery`'s one statement ends `ORDER BY validFrom, resourceId LIMIT 1001`.
- **B3. `Snapshots` has no index that leads with `nodeId`.** Its one fixed index, `idx_Snapshots_current`, is on `(resourceId, validTo)`, and every query index an `@index` declares leads with a field of the value.
- **B4. A change to the tree reruns no live query.** `#rerunQueriesForCommit` runs on a commit of resources, and its JSDoc says a permission change reruns nothing; the client re-asks for whatever it was denied at the next tree change.

The sections that follow state what the descriptor becomes, the claims that design rests on, and the questions Larry decides before phases are written.

## Goals

1. **A reader sees what the tree puts under its node, and filters nothing itself.** Today the round store, the marks and the Galaxy's thread each filter what a query answered.
2. **A reader who holds the query's node is checked once.** A grant at a node reaches everything beneath it, so `read` there covers every result. Today the plane looks up every result's node, for each subscriber on each push (B1).
3. **A list longer than the cap shows the entries its reader wants.** Newest first, a page at a time, as many as the page asks for. Today it shows the oldest 1,000 (B2), which quietly stalls the agent in a long chat (C4).

## Relationships

- **After [archive/nebula-turn-stored-round-by-round.md](archive/nebula-turn-stored-round-by-round.md)**, built and archived on 2026-11-19. Its round store and `toolCallMarks` are readers this changes, and its hand-off left their filters open and pointed at Item 21.
- **Before the first invite in [nebula-pre-alpha.md](nebula-pre-alpha.md)**, as a `deploy` row. After the first invite, every invited user's app holds queries in today's shape, so the break costs them a rebuild (C9), and C4's stall can reach their Galaxy.
- **Before [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Denied access in generated apps*.** That item renders a query's `deniedNodes`, and Q1 decides what a node-scoped query puts there.

## Current state

Built already:

- **`QueryDescriptor` and `canonicalQueryHash`**, in `query-hash.ts`, isomorphic, so the client computes a query's hash before it sends anything. *Adapted:* the descriptor gains the node, the sort, the limit and the page boundary, and the hash covers each (DI9).
- **The query engine** in `packages/resources/src/query/`: `compileWhere` turns a filter into SQL with bound values, `compileQuery` refuses a filter no index can look up, and `compileIndex` builds an `@index`. *Carried over:* the sort reuses the SQL expression `resolveField` gives each field, as an index does (DI5).
- **`#evaluateQuery`**, the one place a query reads `Snapshots`. *Adapted:* it reads under the node, in the query's order, from its page boundary, to its limit (Q2).
- **`#readableNodes` over `OrgTree.evaluatePermissions`**, called by `doQuery` and `#broadcastQueries`. *Adapted:* a query's push looks at its node once (DI2), and Q1 decides the case where that look fails. `evaluatePermissions` stays for single-resource pushes.
- **`#rerunQueriesForCommit` and `#touches`.** *Adapted:* both take the query's node into account, and a tree change reruns queries too (DI8).
- **`findCurrent(typeName, filter)`**, host code with no check of its own, read by the node invite's `_InviteStatus` lookup and the Galaxy's `#thread()`. *Adapted:* it takes a whole descriptor, node included (DI4).
- **`MAX_LIVE_QUERIES_PER_TYPE`**, the most distinct live queries one type may have on a host. *Carried over unchanged* (DI9).
- **The client's `subscribeQuery` and `query`**, in `client-resources.ts`, and `#askAgain`, which re-subscribes whatever was denied at each tree change. *Adapted:* `#askAgain` stops re-asking for queries (DI8).
- **The roster's store path**, `store.lmz.querySubscribers.<typeName>.<field>[value]`, which `trackQuerySubscribersRead` in `create-nebula-client.ts` turns into `{ typeName, filter }`. *Adapted:* the path gains the node, and the roster belongs to the list (DI13).
- **Our own readers:** the round store's `read` in `galaxy.ts`, `toolCallMarks` and `roundsOf` in `participants.ts`, `#thread()` in `galaxy.ts`, and Studio's `openChatThread`, `openServedBuilds` and marks in `App.vue`. *Adapted* (DI4, DI10).
- **The docs the model reads**, `website/docs/nebula/` embedded as `.platform/docs/`, and the `define-the-cast` skill's query. *Adapted:* drafted docs-first (DI11).
- **The `/live` scenarios and tests that query**, which `grep -rln 'subscribeQuery\|resources.query(' apps/nebula/harness/scenarios apps/nebula/test` lists, `query-by-filter` among them. *Adapted* mechanically.

## Design intent

- **DI1. Every query names a node, and answers what sits at that node or beneath it.** `nodeId` is required on `QueryDescriptor`, beside `typeName` and `filter`, and is spelled as a create op spells it. "Beneath" follows every path of the DAG, so a list with two parents is under both. `{ typeName: 'Round', nodeId: TURNS_NODE_ID, filter: { message: id } }` answers that message's rounds at `turns` and nothing a member wrote at `messages`. A query over the whole tree names `ROOT_NODE_ID`. A node the tree does not hold refuses the query, as a filter the engine refuses does.
- **DI2. A caller with `read` at the named node is checked once, there.** It reads every result, since a grant reaches every node beneath it (C1), so no result's own node is looked at. The look reads the caller's live claims on a one-time read, and the verdict stored on the subscription row on a push, as today. Dominion over the host passes it as it passes any check.
- **DI3. A caller without `read` at the node is told, not refused.** A subscription still registers, and a one-time read still answers, as every query does today. What the answer then holds is Q1. A malformed query is refused, as today.
- **DI4. No reader filters what a query answered.** Each names its node and keeps everything it gets back:
  - The round store reads under `turns`, as the agent, and drops its `meta.nodeId` test. A `Round` planted at `messages` then never reaches a turn, which is what the test was for.
  - Studio's marks read under `turns` and drop the test of who wrote each round. A `Round` at `turns` is the turn's whoever last wrote it, since the tree says who may write there (C6), and a write by anyone else is recorded under their claims on its snapshot (ADR-016).
  - The Galaxy's `#thread()` asks `doQuery` under `messages`, as the agent, instead of `findCurrent` and a read of each `Message`.
  - `findCurrent` takes a descriptor, so the `_InviteStatus` lookup names the node its rows sit at (C7).
- **DI5. A sort is a list of fields, each ascending or descending.** It is a list because a query's hash sorts an object's keys (C2), so `{ amount: -1, title: 1 }` would hash as the same query as `{ title: 1, amount: -1 }`.
  - **A sort names any field a filter can compare,** and orders a union of string literals by the order the ontology declares, as `$gt` does.
  - **A resource whose sort field holds no value comes after every one that holds one, in either direction.** "The ten largest deals" then never fills with deals that have no amount.
  - **The order is total:** every sort ends in `resourceId`, which keyset paging needs (DI7).
  - **With no sort, the order is today's:** latest write, oldest first. A sort can also name the latest write, since a type such as `ServedBuild` carries no timestamp of its own.
  - **A sort needs no index.** SQLite sorts what the filter's lookup found, which reads no more rows than today's order does.
- **DI6. A limit is 1 to `QUERY_RESULT_CAP`, and the cap when absent.** `more` keeps its meaning: there are results past this answer.
- **DI7. Paging is by keyset.** An answer with `more` carries `next`, which names the last result's sort values and id, and a query that passes it as `after` answers from the result after it. An offset would read and bill every row it skips, and would shift when a write lands between pages. `next` is built with the shared `stringify`, so a `Date` sort value survives (ADR-002). It holds only values from a row its reader was shown, so a generated app may put it in a URL (ADR-017).
- **DI8. A live query reruns whenever its answer can change.** That answer depends on what sits under its node, and on whether each subscriber reads that node. So:
  - **A write touches a query only under its node.** A `move` op enters one subtree and leaves another, and `#touches` counts both.
  - **A tree change reruns a query when it changes an edge beneath the query's node, or a grant at or above it.** A new parent can bring a whole subtree into a list without any resource being written.
  - **The client stops re-asking for a denied query.** Its `#askAgain` exists only because a tree change reran nothing, and each ask costs the host a billed write (C10). Resource subscriptions keep it.
- **DI9. Every field of a query is part of its hash.** Two subscriptions that differ only in their limit or page are two live queries, and each counts toward `MAX_LIVE_QUERIES_PER_TYPE`. A page subscribes to its first page and reads older ones once with `query`, which holds no live query. The docs teach that, and Studio's thread does it (DI10).
- **DI10. Our own lists read newest first, to a limit.** The Galaxy's `#thread()` reads the newest messages, so C4's stall goes. Studio's thread subscribes to its newest page and reads older pages as the person scrolls up. Studio's landed build asks for the newest `ServedBuild` with a limit of one.
- **DI11. The docs say where to query.** `resources.md`, `api-reference.md` § *`client.resources.subscribeQuery`* and § *`client.resources.query`*, and `coding-your-ui.md` § *Data several people share: query it* show `nodeId`, `sort`, `limit` and `after`. `access-control.md` § *Drawing the tree: a node for each audience* gains the rule that a list is queried at the node its resources are created under. The platform's `AGENTS.md` says every query names its node, and the `define-the-cast` skill's query names the root. All of it is drafted in place, uncommitted. Each block is `@skip-check` until a phase makes it real and then `@check-example`, and the embed is regenerated when the docs land (`studio-guidance.md`).
- **DI12. The old shape is refused, by a message naming the missing `nodeId`.** Nothing accepts both shapes. A generated app's build catches it before its page runs (C9).
- **DI13. A query's roster belongs to its list, whatever page each person holds.** `subscribeQuerySubscribers` and the store's path answer everyone subscribed to the same type, node and filter, so a person reading page three is in the roster of a person reading page one. The path gains the node: `store.lmz.querySubscribers.Message[CHAT_NODE_ID].session[sessionId]`. Today the path spells `{ typeName, filter }`, and the roster is keyed by the whole query's hash, so a person holding a sorted page would be missing from a roster the path asks for.

Claims the design rests on:

- **C1.** A grant at a node reaches every node beneath it: `getEffectivePermission` in `org-ops.ts` climbs every ancestor path from the node it is asked about and keeps the highest grant, so the query's node is on a path from every result.
- **C2.** `canonicalQueryHash` sorts a plain object's keys at every depth and keeps a list in order (`sortedKeys` in `query-hash.ts`).
- **C3.** One statement binds at most 100 values (`MAX_BOUND_PARAMS` in `query/where.ts`, held against the running limit by `test/query/query-sqlite.test.ts`), and a filter's `$in` lists spend them. Item 21 records that limit as unchecked; the query engine checked it. `json_each` is on workerd's allow-list for a Durable Object's SQLite, so a subtree bound as one JSON array spends one value however many nodes it lists.
- **C4.** Past 1,000 `Message`s, the agent answers no new post. `#thread()` reads `findCurrent('Message', { chat })`, whose statement keeps the 1,000 with the earliest latest write, and `waitingPostIds` and `#decisionFor` find the waiting posts in what it returns. A new post has the latest write, so it is the first one left out.
- **C5.** Studio's landed build stops changing at `.dev`'s 1,000th `ServedBuild`, because `openServedBuilds` renders the last id of an oldest-first list.
- **C6.** Whoever can write a `Round` at `turns` is the agent, through its protected `write` at `chat`, a holder of dominion over the Galaxy, or someone an admin granted `write` at `chat` or `turns`. An invite to the conversation grants `read` at `chat` (`GALAXY_TREE_SEED`'s `inviteAlso`), never `write`.
- **C7.** Our own code knows each query's node as a constant: `MESSAGES_NODE_ID` and `TURNS_NODE_ID` in `chat-constants.ts`. An `_InviteStatus` row is created at the node it records.
- **C8.** The plane holds the whole tree in memory, in `OrgTree`'s cached view, so finding a node's subtree reads no storage.
- **C9.** A generated app's queries are type-checked against the client's `QueryDescriptor` when it builds, so an app written before this lands fails its next build with an error naming `nodeId`, and the model reads that error in the same turn.
- **C10.** `#askAgain` in `client-resources.ts` re-subscribes a denied query because the host reruns nothing on a tree change, and its JSDoc says each re-subscribe costs the host a billed write.
- **C11.** The only stored query descriptors are live subscription rows in `subscriptions.ts`, which a page registers again when it reconnects, so no stored shape changes and the change is `deploy`-gated.

## Constraints

- **[ADR-001](../docs/adr/001-typescript-as-schema.md)**: the descriptor, the sort and the page boundary are TypeScript types, validated as the filter is.
- **[ADR-002](../docs/adr/002-structured-clone-everywhere.md)**: `next` carries a sort value of any type a field holds.
- **[ADR-003](../docs/adr/003-continuation-messaging.md)**: the client computes the hash of every new field before it sends, so `subscribeQuery` still returns at once.
- **[ADR-004](../docs/adr/004-snodgrass-temporal-resources.md)** and **[ADR-011](../docs/adr/011-iso-timestamps.md)**: the latest write is the current snapshot's `validFrom`, an ISO string.
- **[ADR-008](../docs/adr/008-full-org-tree-visibility.md)**: the tree stays visible to every member, so a page can always find the node to query at, and `deniedNodes` is always disclosed.
- **[ADR-017](../docs/adr/017-the-url-is-the-view-state.md)**: in a generated app, a list's sort and page are view state.
- **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)**: the tree is a node's one fine-grained control, so a reader's own filter is the second store it rules out.
- **`durable-objects.md`** § *SQLite write-cost optimization*: an index on `Snapshots` adds rows to every write of every type (Q2).
- **`live.md`**: each reader's change and the paging are driven in `/live` first, in `query-by-filter` and the scenarios that read rounds and the thread.
- **`studio-guidance.md`** and **`documentation.md`**: the docs ship as the model's reference, regenerated into the embed, every block `@check-example`.
- **`workflow.md`** § *Releases*: nobody builds on the published package, so the break needs no release note and no deprecation.

## Beyond this task

- ⚠️ Design consideration: **a total ("page 3 of 12") is a separate read.** Keyset paging answers no count, and a count costs a read of every match.
- ⚠️ Design consideration: **an index that serves the filter and then the sort lets SQLite stop at the limit** instead of sorting every match. An `@index` on the filter's field and then the sort's field is that index; add it when a measured list needs it.
- **Single-resource subscriptions could rerun on a tree change too**, which would retire `#askAgain` entirely.
- **Item 24's visitors** read a node granted `anyone`, which the one look passes like any grant.

## Open questions

- **Q1. What a caller without `read` at the query's node is answered.** Item 21's goal is one look, and it expected a node the caller cannot read to be refused whole. [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Denied access in generated apps* records Larry's 2026-09-28 call that a partial answer beats refusing the whole subscription: Bob, who reads 20 of a project's 21 tasks, would otherwise lose all 20. Under a node-scoped query, Bob is that caller: grants only reach downward, so he reads the nodes of his 20 tasks and not the project's.
  - **(a) One look, always.** The answer holds no results and `deniedNodes: [nodeId]`. An app then queries Bob's list at the nodes he reads, which the tree shows (ADR-008). An app that queries at the project shows him nothing.
  - **(b) One look when it passes; otherwise the part he reads.** The answer holds the results under nodes he reads, and `deniedNodes` names the nodes beneath holding results he cannot, as today, by today's look at each result's node.
  - **Recommendation: (b).** It keeps the September call, which the denied-access item builds on. A list queried at its audience's node, as DI11 teaches, passes the one look, so the per-node check runs only where the tree and the query disagree. Every reader in DI4 reads at a node it holds, so each drops its filter under either answer. And the `define-the-cast` skill checks what a persona sees by querying at the root, which under (a) shows a persona with no grant there nothing.
- **Q2. How the query reads only its node's subtree.** The choice is internal, so changing it later breaks no caller.
  - **(a) One statement, with the subtree bound as one JSON array:** `nodeId IN (SELECT value FROM json_each(?))`. The plane knows the subtree without reading storage (C8), it spends one bound value (C3), and SQLite orders, pages and limits, so nothing merges results. Rows read are what the filter's index finds across the whole type.
  - **(b) (a), plus an index on `Snapshots(nodeId, typeName)` over current rows.** Rows read are only those under the node, and a filter of `{}` stops being a scan. Every write of every type pays one more index row, and one more when it closes the row before it.
  - **(c) One statement per node of the subtree, merged in the plane.** Larry's lean in Item 21, formed against an `OR` clause's limit, which (a) does not have. It needs (b)'s index to be cheap, and its merge does in JavaScript what `ORDER BY` and `LIMIT` do in (a).
  - **Recommendation: (a)**, measured with `EXPLAIN QUERY PLAN` and rows read in the phase that builds it, with (b) added only if a measured query reads far more rows than it answers.
- **Q3. The spelling of the new fields.** `nodeId` matches the create op. For the rest:
  - **Sort:** `sort: [{ amount: 'desc' }, { title: 'asc' }]`, which is Prisma's `orderBy` shape under MongoDB's name, against `[['amount', 'desc']]`. MongoDB's own `{ amount: -1 }` is ruled out by C2.
  - **The latest write in a sort:** `$validFrom`, the meta field's own name. A filter already reads a top-level `$` key as an operator, so no field a query can compare is spelled that way.
  - **Paging:** `limit`, and `after` taking the previous answer's `next`. `skip` is ruled out by DI7.
  - **The roster's path:** `store.lmz.querySubscribers.<typeName>[nodeId].<field>[value]`, the node after the type, in the descriptor's order.
  - **Recommendation:** the spellings above.
- **Q4. How a page knows the id of the node it queries.** A required node means a page needs that id before it can query, as a create already does. The cast is built today with node ids from `crypto.randomUUID()`, and the `define-the-cast` skill finds a node again by its slug in `store.lmz.orgTree`.
  - **(a) Find it by slug in the tree.** It works today. The page waits for the tree before it queries, a slug is unique only among its siblings, and an admin's rename silently stops the query, since it is keyed on a name that changes (ADR-010).
  - **(b) A constant in the app's source for each node its code names, created at that id.** `createNode` takes the caller's id and is idempotent, so creating it again is harmless, and our chat does exactly this with `CHAT_NODE_ID`. The page queries as soon as it loads. The `define-the-cast` skill then creates those nodes at the ids the source declares.
  - **A node made for one record is that record's `meta.nodeId`** under either answer, as `coding-your-ui.md` § *Lists with `v-for`* already does for a list's todos.
  - **Recommendation: (b).** It keys every query on an id rather than a name, and the drafted docs use it.

## Edits other files owe

Other sessions may hold uncommitted edits in these files, so this file lists the edits rather than making them:

- **[nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md):** Item 21 keeps its goal and a pointer here, per that file's convention, and its row leaves § *The items, by when they start*, since it now lands before the first invite. Its note that a statement's bound-value limit is unchecked is answered by C3.
- **[backlog.md](backlog.md):** the row *A query cannot sort, page or limit, so it returns its oldest `QUERY_RESULT_CAP` results (2026-11-18)* points here, and is deleted when this is built.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md):** a `deploy` row in *Before the first invite*, ahead of § *Denied access in generated apps*.
- **[archive/nebula-turn-stored-round-by-round.md](archive/nebula-turn-stored-round-by-round.md):** its open item on the readers' filters points at fast-follow's Item 21, which this file builds, and records Larry asking on 2026-11-19 whether to pull it forward. The file is archived, so the pointer stays at Item 21.
