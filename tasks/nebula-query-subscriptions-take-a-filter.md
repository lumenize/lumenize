# Query subscriptions take a filter

**Status:** Pass 1, written 2026-11-14 for Larry's hand review; no phases yet. It wires the engine of [nebula-query-engine.md](nebula-query-engine.md) into the Resources plane, and it gates [nebula-personas-are-real-members.md](nebula-personas-are-real-members.md).

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
- **DI13. The live queries of one type are bounded,** because DI10 costs two reads for each of them on every write. A subscribe past the bound is refused by a message that names it. Q3 sets the number.
- **DI14. A result is bounded.** Q4 says how.

### Claims this rests on

- **C1. Every caller of today's query is on the list in § *Current state*.** Checked 2026-11-14 by a grep for `subscribeQuery(` and `queryType:` over the source trees.
- **C2. `#install` is the one place a version becomes a Star's installed one.** Read, not proven: two call sites reach it.
- **C3. SQLite here creates an index on an expression, uses it, and drops it.** Checked in the vitest-plugin lane. Not run deployed.
- **C4. Testing one snapshot against a clause by its key costs tens of microseconds.** `durable-objects.md` gives 9 to 20 µs for a point read. Not measured for this statement.
- **C5. Creating an index on a Star that already holds resources finishes inside one request.** Not measured. A `.dev` Star holds little; a tenant's may not.

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

## Open questions

- **Q1. Does `queryType` leave the descriptor, as DI2 says?** It was kept as a seam for later kinds of query.
  - *Options:* drop it, so a query is a type and a filter; or keep it with `filter` as its one value.
  - *Recommendation:* drop it. Nothing published depends on it, and a second kind of query can add a field when one exists.
- **Q2. Is the JSDoc tag of DI5 the right way to declare an index?**
  - *Options:* `@index` on a field and on a type, as shown; or a separate exported list in the ontology file; or the agent creating indexes through a tool.
  - *Recommendation:* the tag. It keeps an index beside the field it serves, in the one file that is the schema.
- **Q3. What bounds the live queries of one type (DI13)?**
  - *Options:* a fixed number of distinct live queries for each type; or none, with the cost logged.
  - *Recommendation:* a fixed number, set after measuring C4. At 20 µs a test, 200 queries cost a write about 8 ms.
- **Q4. What bounds a result (DI14)?** A filter can match every resource of a type, and each rerun sends every id again.
  - *Options:* refuse a result over a fixed size; or send the first so many with a flag saying more exist; or leave it unbounded until paging is built.
  - *Recommendation:* send the first 1,000 with a flag. A refusal would break a page that worked yesterday.
- **Q5. Does a relationship a generated app queries by get its index from the model, or from us?** DI8 says the model declares it.
  - *Options:* the model declares `@index` on each relationship it queries by, taught by the guidance; or every to-one relationship is indexed without being asked.
  - *Recommendation:* the model declares it. A refused query names the missing index, so a forgotten one is found at the first run.
