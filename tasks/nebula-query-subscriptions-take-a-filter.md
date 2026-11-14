# Query subscriptions take a filter

**Status:** built and closed on 2026-11-14, in `358dfa4` and the commit after it. Larry read Pass 1, answered its open questions and asked for the build to run to completion. § *Build notes* has what he should know, and § *Closing evidence* what was run. It wires the engine of [nebula-query-engine.md](nebula-query-engine.md) into the Resources plane, and it gates [nebula-personas-are-real-members.md](nebula-personas-are-real-members.md).

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `Q` an open question, and `D` a decision. D3 is the third decision made, wherever its row sits.

## Objective

**An app subscribes to the resources of one type that match a filter, and sees the ones its person may read.**

Sally and Gerry both use the app `acme.crm`. Sally creates two Deals. Gerry holds `read` on the node one of them sits under.

```ts
using open = client.resources.subscribeQuery({
  typeName: 'Deal',
  filter: { stage: 'open', amount: { $gt: 1000 } },
});
```

Gerry's page receives "Acme renewal" and is told a node holds a result he may not read. When Sally closes that deal, it leaves his list without his asking again.

## Context

A query subscription today answers one question: the resources of a type whose to-one relationship names a given parent, such as the Messages of a chat. So an app finds a resource only by an id it already knows, or as a child of one. The docs teach one starting point, a container keyed by the person's own `sub`, which makes every generated app a single-user app: nothing one person makes can be found by another.

The engine that compiles a filter to SQL is built and tested, and nothing calls it. This file is the wiring.

These things in today's code stand in the way:

- **B1.** `QueryDescriptor` in `packages/resources/src/query-hash.ts` carries `field` and `value` and nothing else to match on, and `#validateQuery` refuses any `queryType` but `parentChild`.
- **B2.** `Snapshots.enumerateCurrentByField` answers a query by loading every current row of the type and parsing each one in JavaScript.
- **B3.** `#rerunQueriesForCommit` reruns every live query of a type on every write to that type, and pushes each its whole result again.
- **B4.** `OntologyVersionRow` carries `relationships` and no field kinds, so a Star cannot compile a filter.
- **B5.** Nothing declares an index, and nothing creates one.
- **B6.** A write is not checked for the values a query would read wrongly.

The rest of this file says what a query is, where its indexes come from, what a write does to live queries, and what bounds the cost.

## Goals

- **One kind of query.** Today's parent-and-child query is a filter with one equality. After this, it is written as one, and the code that answers only it is gone.
- **A query's cost follows what it finds.** Today every query reads every current resource of its type. After this, it looks up a key in an index, or it is refused, or its author allowed the scan on purpose.
- **A write disturbs only the queries it touches.** Today a write reruns every live query of its type. After this, it reruns the ones whose result the written resource entered, left, or sits in.
- **Indexes are declared where the types are.** The ontology file is the schema, so an index is declared there and a Star creates it when it installs that version.
- **Nothing reaches a person that they may not read.** The per-resource check and the told denial are as they are today.

## Relationships

- **[nebula-query-engine.md](nebula-query-engine.md)** is what this wires in. Its decisions on what a filter means are settled there.
- **[nebula-personas-are-real-members.md](nebula-personas-are-real-members.md)** waits on this. Its open question on seeding closes when this lands.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md)** does not list this work. It belongs ahead of item ②, and that file is another session's to edit.
- **[nebula-orm-and-queries.md](on-hold/nebula-orm-and-queries.md) § *Part C*** keeps what this leaves out: nested reads across relationships, join tables and aggregates.

## Current state

**Built already:**

- **The engine,** `@lumenize/resources/query`: `compileQuery`, `compileWhere`, `compileIndex`, `assertQueryable`. Carried over unchanged.
- **`extractTypeMetadata().fields`,** each field's kind. Carried over, and extended to read index declarations.
- **A query subscription's lifecycle:** `subscribeQuery` and `unsubscribeQuery` on the plane's `requests`, the `Subscriptions` rows, the client's `QuerySubscription` handle, the roster of a query's subscribers, and the reaper. Carried over unchanged.
- **`#broadcastQueries`,** which checks each subscriber's `read` on each result and sends the ids they may read with the nodes they may not. Carried over unchanged.
- **`canonicalQueryHash`.** Adapted to hash a filter.
- **`#validateQuery` and `#evaluateQuery`.** Adapted to compile and run the filter.
- **`#rerunQueriesForCommit`.** Adapted to test each written resource against each live query first.
- **`Snapshots.enumerateCurrentByField`** and the plane's `enumerateByField`. Left behind.
- **The callers of today's query:** Studio's chat thread and its served builds in `App.vue`, the Galaxy's own `chatQuery`, and the frontend factory's `children` helper. Adapted to the filter form.
- **`apps/nebula/src/ontology-compile.ts`,** which compiles a version's row. Adapted to carry `fields` and the indexes.

**Missing:**

1. A query descriptor that carries a filter.
2. Index declarations in the ontology file, read by the extractor.
3. A Star creating and dropping indexes when it installs a version.
4. A write refused when it holds a value a query would read wrongly.
5. A write tested against each live query of its type.
6. Bounds on the live queries of a type and on a result's size.
7. Guidance that teaches a filter, an index, and when to allow a scan.

## Design intent

### What a query is

- **DI1. A query is a type and a filter.** `{ typeName: 'Deal', filter: { stage: 'open' } }`, with `allowScan: true` when its author means to read every Deal. The filter's meaning is the engine's, and a filter the engine refuses is refused to the subscriber in the engine's words.
- **DI2. Today's query becomes a filter.** The Messages of a chat is `{ typeName: 'Message', filter: { chat: chatId } }`. `queryType` leaves the descriptor, and so does the code that answered `parentChild` alone.
- **DI3. Two queries that mean the same share one subscription.** The hash is taken over the type, the filter with its keys in a fixed order, and `allowScan`. The order of the entries in an `$and` list still counts.
- **DI4. A result is ordered as it is today,** by each resource's latest write. Ordering by a field waits (§ *Beyond this task*).

### Where indexes come from

- **DI5. An index is declared in the ontology file.** A field's own JSDoc declares an index on it, and a type's JSDoc declares one over several fields in order:

  ```ts
  /** @index stage, amount */
  interface Deal {
    /** @index */
    owner: Person;
    stage: 'lead' | 'open' | 'won';
    amount?: number;
  }
  ```

  The extractor returns them beside `fields`, and refuses a declaration the engine would.
- **DI6. A version's row carries its fields and its indexes,** so a Star compiles a filter with no second trip to the Galaxy.
- **DI7. A Star makes its indexes match the version it installs.** It reads the names of its query indexes from the catalogue, creates each one the version declares and drops each one it does not, in the same stretch as the install.
- **DI8. No index is created that nobody declared.** A to-one relationship gets one only when its field says `@index`. Each index adds a row to every write of its type, and a write costs a thousand times a read.

### What a write does

- **DI9. A write holding a value a query would read wrongly is refused,** with the validator's other refusals and in the same shape: a number field holding `Infinity`, an invalid `Date`, an object stored twice.
- **DI10. A write is tested against each live query of its type.** For each resource a commit wrote, and each distinct live query on that resource's type, the Star asks whether the new snapshot matches the query's clause, and whether the one it replaced did. A query is rerun when either answers yes. Each test reads one row by its key.
- **DI11. A rerun sends what it sends today:** to each subscriber, the ids they may read and the nodes they may not. A subscriber replaces its list with what arrives.

### What bounds the cost

- **DI12. A query no index can look up is refused,** unless its descriptor allows the scan. The Star logs each query that scans, with its type, so the ones worth an index can be found.
- **DI13. The live queries of one type are bounded,** because DI10 costs two reads for each of them on every write. A subscribe past the bound is refused by a message that names it. The bound is 200 distinct queries for each type until C4 is measured deployed.
- **DI14. A result is bounded.** A push carries at most 1,000 ids, the first by the result's order, with `more: true` when the query matched more.

### Claims this rests on

- **C1. Every caller of today's query is on the list in § *Current state*.** Checked 2026-11-14 by a grep for `subscribeQuery(` and `queryType:` over the source trees.
- **C2. `#install` is the one place a version becomes a Star's installed one.** Read, not proven: two call sites reach it.
- **C3. SQLite here creates an index on an expression, uses it, and drops it.** Checked in the vitest-plugin lane, and deployed: § *Closing evidence*.
- **C4. Testing one snapshot against a clause by its key costs tens of microseconds.** `durable-objects.md` gives 9 to 20 µs for a point read. Deployed, each test read one row; its CPU time is not measured, since a trace span for a Durable Object's SQL reads 0 ms.
- **C5. Creating an index on a Star that already holds resources finishes inside one request.** It did deployed, on Stars holding a handful of resources. Not measured on a large one.

## Constraints

- **[ADR-001](../docs/adr/001-typescript-as-schema.md).** An index is declared in the TypeScript types, by a JSDoc tag, and nowhere else.
- **[ADR-002](../docs/adr/002-structured-clone-everywhere.md).** A filter crosses the wire whole, a `Date` in it included.
- **[ADR-003](../docs/adr/003-continuation-messaging.md).** `subscribeQuery` stays void, and its results arrive as pushes.
- **[ADR-004](../docs/adr/004-snodgrass-temporal-resources.md).** A query reads current snapshots. DI10 reads the one a write replaced, which history keeps.
- **[ADR-008](../docs/adr/008-full-org-tree-visibility.md).** A subscriber is told which nodes hold results they may not read.
- **[ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md).** Indexes belong to an ontology version and change when the installed version does.
- **`durable-objects.md` § *SQLite write-cost optimization*.** It is why DI8 creates no index unasked.
- **`live.md`.** The behaviour is covered by a `/live` scenario with real members, and ends with a deployed pass, since C3 and C5 can only show there.

## Beyond this task

- **Comparing a union of string literals by its declared order.** ⚠️ Design consideration: Larry designs it. The extractor already keeps the order, and the engine refuses the comparison until then.
- **Ordering a result by a field, and paging it.** ⚠️ Design consideration: the SQL is another pure function in the engine, since an `ORDER BY` must use an index's own expressions to be served by it.
- **"Array contains", a lookup inside `$or`, and a filter as an index's own WHERE.**
- **Rebuilding indexes on a tenant Star that holds real data.** ⚠️ Design consideration: after pre-alpha, a migration (C5).
- **Reads across relationships in one call.** The on-hold file's Part C.

## Decisions

Larry's answers of 2026-11-14 to the questions Pass 1 asked, and what the builder settled writing the phases.

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | The filter form replaces the parent-and-child query outright, with no period where both are answered. (Larry: "this will deprecate our current parent-child approach?" Yes.) | Answering both: nothing published uses the old form, and code that answers only it would sit beside its successor. |
| D2 | `queryType` leaves the descriptor. (was Q1) | Keeping it with one value: a second kind of query can add a field when one exists. |
| D3 | An index is declared by `@index`, on a field or on a type. (was Q2) | A separate list, or a tool the agent calls: the tag keeps an index beside the field it serves, in the one file that is the schema. |
| D4 | The live queries of one type are bounded at a fixed number, 200 until the cost is measured deployed. (was Q3) | No bound with the cost logged: each live query costs every write of its type two reads. |
| D5 | A result carries its first 1,000 ids and a flag when there are more. Paging is not built here. (was Q4; Larry left the call to the builder.) | Paging now: ordering by a field comes first and is its own design, which the Resource Events work may shape. A refusal over the size would break a page that worked yesterday. |
| D6 | The model declares `@index` on each relationship it queries by. (was Q5) | Indexing every to-one relationship unasked: each index adds a row to every write of its type. |
| D7 | A version's row whose compile predates this carries no fields. A Star holding one refuses every query by a message saying the app needs a build. | Compiling fields in the Star: the compiler never runs in a Worker. |
| D8 | The platform's own types declare their indexes the same way: `Message.chat`, `ServedBuild.chat` and `_InviteStatus.node`. | Allowing their scans: the chat's Messages are the largest type a Galaxy holds. |
| D9 | A wipe drops a Star's query indexes with its data, and the next install creates them again. | Keeping them: the wipe records no installed version, so nothing would say which indexes are right. |

## Phases

Each phase ends with its package's suite green and its mutations caught. The whole file has one deployed gate, at the end.

1. **The extractor reads index declarations.** `extractTypeMetadata` returns `indexes`, a list of `{ type, fields }`, from `@index` on a field and `@index a, b` on an interface.
   - **Success criteria:** each form is read; a type may declare several; a declaration naming a field the type lacks, an object, an array, a field twice, or nothing is refused at extraction by a message naming the type; `@index` with text on a field is refused.
   - **Mutation note:** drop each refusal in turn, and return a field's index under another type.

2. **A version's row carries its fields and indexes.** `OntologyVersionRow` gains both, `compileOntologyVersion` fills them, and the platform's types declare their indexes (D8). The committed validator seeds are regenerated.
   - **Success criteria:** a compiled row holds the fields of an app's type and of `_InviteStatus`, and each declared index; `gen-validator-seeds.ts --check` passes; the chat's row declares an index on `Message.chat`.
   - **Mutation note:** leave `fields` off the row, and the Phase 4 query on that Star is refused by D7's message.

3. **A Star makes its indexes match what it installs.** On install it creates the indexes the row declares and drops the query indexes it does not, and a wipe drops them all (D9).
   - **Success criteria:** after an install, the catalogue holds exactly the declared indexes; after a second version that drops one and adds one, exactly the new set; after a wipe, none, and after the next install, the set again. Read from `sqlite_master` on a real host.
   - **Mutation note:** skip the drop, skip the create, and skip the wipe's drop, each alone.

4. **A query is a type and a filter.** The descriptor, its hash, the plane's validation and evaluation, the client's `subscribeQuery`, the factory's `children` helper, Studio's two subscriptions and the Galaxy's own query all take the filter form. `enumerateCurrentByField` and the plane's `enumerateByField` are deleted, and every test that named the old form is rewritten.
   - **Success criteria:** a subscribe with a filter delivers the matching ids a subscriber may read and the nodes they may not; a filter the engine refuses rejects the handle with the engine's message; a query no index serves is refused unless it allows the scan; two filters that differ only in key order share one subscription; `grep -rn "parentChild\|queryType\|enumerateCurrentByField" packages apps --include='*.ts' --include='*.vue'` prints nothing outside `platform-embed.ts`.
   - **Mutation note:** evaluate without the filter's clause; drop the permission partition; hash without sorting keys; answer a refused filter with an empty result.

5. **A write holding a value a query would read wrongly is refused.** The transaction runs `assertQueryable` on each value it is about to store, and a failure is a validation refusal carrying the engine's message.
   - **Success criteria:** a create holding `Infinity` in a number field ends as today's validation refusal does, names the field, and writes no row; the same value in a `Map` field is written.
   - **Mutation note:** skip the check; run it on the value before defaults are filled.

6. **A write is tested against each live query of its type.** For each written resource and each distinct live query of its type, the Star tests the new snapshot and the one it replaced, and reruns the query when either matches.
   - **Success criteria,** each read from what a subscriber is sent: a write that enters a query's result reruns it; one that leaves it reruns it; one that stays in it reruns it; a write of the same type that matches neither before nor after sends that query's subscribers nothing; a delete of a matching resource reruns it.
   - **Mutation note:** test only the new snapshot, and the leaving case sends nothing; test only the old, and the entering case sends nothing; rerun always, and the unrelated write sends a push.

7. **The bounds.** A subscribe that would make a type's distinct live queries exceed the bound is refused by name; a push carries at most 1,000 ids and `more: true` past that; each query that scans is logged with its type.
   - **Success criteria:** the subscribe at the bound succeeds and the next distinct one is refused, while one more subscriber to an existing query is admitted; a result of 1,001 sends 1,000 ids and the flag, and one of 1,000 sends no flag; the client's handle exposes the flag; an allowed scan logs one line.
   - **Mutation note:** count subscribers where queries are meant; cap at 1,001; drop the flag.

8. **The running system shows it.** A `/live` scenario with two real members of one Star: Sally creates two Deals under two nodes, and Gerry, who may read one node, subscribes with a filter.
   - **Success criteria,** each limb reddened alone: Gerry receives the Deal he may read and is told of the node he may not; Sally's edit moving that Deal out of the filter removes it from his list without his asking; a filter on an unindexed field is refused by the engine's message, and admitted with `allowScan`; a Deal written with `Infinity` is refused.
   - **Mutation note:** one for each limb, as Phase 4 to 6 name them, run against the scenario.

9. **The guidance teaches it.** The Nebula docs teach a filter, `@index`, and when to allow a scan and when to add an index, and the platform embed is regenerated.
   - **Success criteria:** `gen-platform.mjs --check` passes; the docs' examples pass the example checker; no doc teaches `queryType`.

10. **Close-out.** Every affected suite, the whole scenario registry, then a deployed pass of the new scenario and a reading of the test Worker's Issues. C4 and C5 are measured there or recorded as unmeasured.

## Non-goals

- **Ordering by a field and paging.** § *Beyond this task*.
- **Comparing a union of string literals by declared order.** Larry's to design.
- **Reads across relationships, join tables and aggregates.** [nebula-orm-and-queries.md](on-hold/nebula-orm-and-queries.md) § *Part C*.
- **Rebuilding indexes on a tenant Star with real data.** After pre-alpha.

## Build notes

### For Larry

- **The new doc examples are `@skip-check`.** The filter table, the `@index` example and the shared-data section in `website/docs/nebula` sit beside older `@skip-check` blocks for the same API. `documentation.md` wants each converted to a checked example or approved by you before the docs are published.
- **A JSDoc block on the same line as its field declares nothing,** because TypeScript attaches it to nothing: `{ /** @index */ owner: Person }`. The extractor now refuses a file whose written `@index` tags outnumber the ones it read, and the docs say to put each block on a line of its own. `@default` has the same blind spot and is not checked.
- **The result cap is applied before the permission check.** A push carries the first 1,000 matches, then each subscriber's readable ones among those. A member who may read few of them sees fewer than 1,000 and `more: true`, and may be missing readable results past the cap. Paging is where that is fixed.
- **A roster's place in the store exists only for a one-equality filter.** `store.lmz.querySubscribers.<type>.<field>[value]` spells one field and one value. A roster for any other filter reaches its own handle and nothing in the store.
- **The chat's ontology is `chat-message-v4`,** since its types gained their index declarations.
- **`studio-guidance-loop.ts` has one line of this build in it,** its chat query. That file carries the other session's uncommitted edits, so only that line was committed.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md) does not list this work,** and is the other session's to edit.

### What was built, by phase

- **Phase 1.** `extractTypeMetadata().indexes`, from `@index` on a field, a nested field and an interface. Eleven mutations, each caught.
- **Phase 2.** `OntologyVersionRow` carries `fields` and `indexes`; `compileOntologyVersion` fills them; `_InviteStatus.node`, `Message.chat` and `ServedBuild.chat` declare theirs; the seeds are regenerated.
- **Phase 3.** `Resources.#matchIndexes`, run by every install. A wipe needed no code: it drops the `Snapshots` table, and a table's indexes go with it. `plane-wipe.test.ts` reads the catalogue before the wipe, after it, and after the next install.
- **Phase 4.** `QueryDescriptor` is `{ typeName, filter, allowScan? }`. `#compile` and `#evaluateQuery` replace `#validateQuery` and the scan. `findCurrent(typeName, filter)` replaces `findCurrentByField` for host code. 74 query literals in 42 test and scenario files were rewritten, and 15 test ontologies declare their index.
- **Phase 5.** `Snapshots.transaction` runs `findUnqueryable` on each value after defaults are filled, when it is handed the ontology's fields.
- **Phase 6.** `#rerunQueriesForCommit` and `#touches`: one statement by the resource's key reads the new snapshot and the one it replaced.
- **Phase 7.** `MAX_LIVE_QUERIES_PER_TYPE`, `QUERY_RESULT_CAP` with `more`, and the `query scans` log line.
- **Phase 8.** `/live` `query-by-filter`.
- **Phase 9.** `api-reference.md` § *`client.resources.subscribeQuery`*, `ontology.md` § *Indexes*, and `coding-your-ui.md` § *Data several people share: query it*; the platform embed is regenerated.

### Retro

- **Planning a mutation showed a condition nothing needed.** The per-write test first excluded tombstones with `deleted = 0`. No mutation of it could fail a test: a delete's tombstone holds the value it replaced, so it answers as that row does. The condition was removed before the mutations ran.
- **`EXPLAIN` is no witness to a dropped index** (see the engine's file), so every index assertion reads the catalogue.
- **A scripted rewrite mangled one template literal.** The pattern stopped at the `}` of `${pipelineId}`. The harness type-check caught it, and a grep for the shape found no other.

### Closing evidence

All of it is from the tree at `358dfa4`, after the last source edit.

- **Suites:** `packages/ts-runtime-parser-validator` 21 files and 232 tests; `packages/resources` 9 files and 234; `apps/nebula` 129 files, one skipped, and 1,165 tests with 2 skipped. `npm run type-check` passes, with `audit:mesh-vocab`, `audit:dep-direction`, `audit:test-assertions`, `audit:do-http` and `audit:email-isolation`, the three generator checks and the doc example checker. Nebula's first full run after the migration had 3 failures, each a test that named the old SQL, the old row's keys or the old one-line chat types; all three were conformed.
- **Mutations:** 11 on the extractor's index declarations and 24 on the plane, each caught by a named test.
- **`/live` `query-by-filter`,** local, then under one mutation for each limb: the filter ignored and nobody denied both reddened limb 1; a write tested against its new snapshot alone reddened limb 2 with limb 1 green; the lookup rule dropped reddened limb 3; the write check dropped reddened limb 4.
- **The whole registry,** `drive.ts all`, Docker scenarios included: 74 of 74 on the first run, no flakes, with `redeploy-strands-no-client` parked as always.
- **The deployed pass:** `deploy-test.sh` ended `Test worker live and matches HEAD`, and `query-by-filter`, `node-invite-roundtrip`, `message-roundtrip` and `dev-star-follows-the-build` each passed against `https://platform.lumenize-test.dev` on the first run. `issues.mjs --worker test-nebula --since 2026-11-14T17:01:17Z` shows only `scope-deleted`, a standing one.
- **What the deployed traces show** (`scripts/do-queries.mjs`): each `CREATE INDEX` ran and wrote one row on an empty type, and eight across three runs where Deals existed; a query's statement read 2 to 11 rows where it looked up an index; and the per-write test read exactly one row on each of its 11 runs.

### Left for later

- **The bound of 200 live queries per type rests on rows, not time.** Each test reads one row, so 200 queries add 200 row reads to a write, about a fifth of what one written row costs. Its CPU time is unmeasured.
- **A deployed check of the bound and the cap themselves.** Both are held by lane tests alone.
- **`@check-example` for the new doc blocks.**

