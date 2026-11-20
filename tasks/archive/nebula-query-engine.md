# The query and index engine

**Status:** the engine is built and tested, 2026-11-14, as pure functions, and [nebula-query-subscriptions-take-a-filter.md](nebula-query-subscriptions-take-a-filter.md) wired it into query subscriptions the same day. It gates [nebula-personas-are-real-members.md](../nebula-personas-are-real-members.md), whose personas need data one member makes and another finds.

## Conventions

`D` is a decision, numbered in the order made and never reused. D3 is the third decision, wherever its row sits. Larry asked for the build in one prompt and left the isolated calls to the builder, so every row here is the builder's unless it names him, and each is reversible.

## What it is

**A filter and an ontology go in, and SQL comes out.** The filter is MongoDB-style, after Larry's [sql-from-mongo](https://github.com/lmaccherone/sql-from-mongo). For the type `Deal`:

```
{ stage: 'open', amount: { $gt: 1000 } }
```

compiles to a clause over the snapshot's `value` column, with both values bound:

```
(json_extract(value, '$.stage') = ?
 AND (json_extract(value, '$.amount') > ? AND json_type(value, '$.amount') IN ('integer', 'real')))
```

It lives in `packages/resources/src/query`, exported as `@lumenize/resources/query`:

- **`compileWhere` and `compileQuery`** turn a filter into a WHERE clause. The first gives the clause alone, to test one snapshot by its key. The second adds the type's current rows, takes the host's indexes, and refuses a filter none of them can look anything up for.
- **`compileIndex`** turns `{ type: 'Deal', fields: ['stage', 'amount'] }` into `CREATE INDEX` and `DROP INDEX`. The index is on the same expressions a filter compares, limited to the type's current rows.
- **`findUnqueryable` and `assertQueryable`** name the values in a resource a query would read wrongly, from its stored text.

The ontology they take is `fields`, a new part of what `extractTypeMetadata` returns: each field's kind, read from its declared type.

## Decisions

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | A clause reads a field where it is stored, with `json_extract`. No field is pulled out into a column. (Larry and the builder, 2026-11-14.) | Columns for indexed fields: an `ALTER TABLE` in every Star for each indexed field, a backfill, and a rule for two types sharing a field name. The write cost of the index is the same either way. |
| D2 | One file, `fields.ts`, knows how each kind of value is stored, and both compilers build on it. A test pins each stored shape against the serializer. | Each compiler writing its own paths: a query's expression and its index's would drift, and SQLite matches them by their text. |
| D3 | Every clause is evaluated in SQLite, on a field with an index or without one. Nothing is filtered afterwards in JavaScript. D15 says which filters may run. | A second evaluator in JavaScript: the two could disagree on the edges, and the same clause already tests one snapshot by its key. |
| D4 | A field holds a value when it is present with a value of its declared type. Absent, `null` and `undefined` all count as no value: `{ f: null }` and `$exists: false` select those. | Telling `null` from absent: the stored forms differ, and the repo's convention is an optional field over a nullable one. |
| D5 | `$ne`, `$nin`, `$not` and `$nor` also match a resource whose field holds no value, as MongoDB's do. | SQL's own rule, where a comparison with NULL drops the row: a filter written for one store would mean something else here. |
| D6 | An ordering operator matches only a field that holds a value, by a type guard in the clause. | No guard: SQLite sorts a wrapped `null` above every number, so `amount > 1000` would match it. |
| D7 | `Infinity`, `-Infinity`, `NaN` and `-0` in a number field are refused at the write, by `assertQueryable`, with an invalid `Date` and an object stored twice. Larry: fail loudly, as an implied constraint of the ontology. | Storing them and never matching: quiet, and D6 already keeps them out of every comparison. `-0` is included because it is stored wrapped like the others. |
| D8 | The extractor keeps a union of string literals' values in declared order. The engine at first refused an ordering comparison on one; D16 replaced the refusal. | Comparing them as strings: a string sort is what would have had to be unlearned. |
| D9 | Arrays, `Set`, `Map` and bigint cannot be filtered or indexed, and a filter naming one is refused by what it is. | A partial "array contains": it cannot use an index in SQLite, and its shape is Larry's to choose. The way in later is `json_each`. |
| D10 | A filter's value is checked against the field's kind and bound. A `Date` field takes a `Date`, an enum one of its values. | Passing values through: a typo'd stage would select nothing and say nothing. |
| D11 | A string compares by its UTF-8 bytes, so `"Zeta" < "alpha"`. `$startsWith` is a key range, which an index serves. | `LIKE`: case-insensitive for ASCII, and a Durable Object caps its pattern at 50 bytes. |
| D12 | A type's name and the end-of-time sentinel are literals in the SQL, and a field's name must be a plain identifier. Every other value is bound. | Binding the type: an index's WHERE takes no parameters, and the two texts are kept identical. |
| D13 | One query binds at most 100 values, the limit SQLite enforces here. | No check: the statement would fail in SQLite with its own message, after the compile. |
| D15 | A query must give an index something to look up: equality, `$in`, a range or `$startsWith` on the first field of one of the type's indexes, at the filter's top level or inside a top-level `$and`. `compileQuery` refuses any other filter, and `{}` is the one exception, as the request for every resource of the type. A caller may pass `allowScan: true`, for a type that will only ever hold a few resources, and the answer's `scans` says which queries read them all. (Larry, 2026-11-14: fail loudly where a query would otherwise scan, with an override, since an index costs a row on every write.) | Letting an unindexed filter scan, as D3 first allowed: `$ne`, `$exists: false` and `null` can never be looked up, so alone each reads every current resource of the type. Beside a lookup they test only the rows it found. |
| D14 | An index's name is `idx_Snapshots_q_Deal:stage,amount`, its type and fields in order. | A hash: the same specification must name the same index, and a reader should see what it covers. |
| D16 | An ordering comparison on a union of string literals becomes the list of values on that side of the operand, in declared order: with `'lead' \| 'open' \| 'won'`, `{ stage: { $gt: 'lead' } }` compiles to `stage IN ('open', 'won')`. A side with no values compiles to `0 = 1`. (Larry, 2026-11-14, after his Rally lookback API.) | A `CASE` expression giving each value its rank: no index could serve it, where `IN` on an indexed field is a lookup each. |
| D17 | `@deprecatedValues qualified, stalled` on a field names the values no longer offered for a new choice. They stay in the union at their place in the order, valid to store and to query, and the field's info gains `deprecated`. (Larry, 2026-11-14.) | `@deprecated` on the field: TypeScript reads it as the whole field. A comment on the union member: TypeScript attaches it to nothing. A wrapper type `Deprecated<'qualified'>`: a global type the model must know. |

## What the tests found

- **Every statement runs in the SQLite a Durable Object has,** in the vitest-plugin lane: `json_extract`, `json_type`, `instr`, `substr`, `IS NOT TRUE`, an index on expressions and a partial one. `sqlite_version()` is not allowed there, so the version is unread.
- **SQLite looks a key up in the index** for a string, a number, a Date, a dotted path and a prefix, read from `EXPLAIN QUERY PLAN`.
- **A partial index is used even when the query binds the type.** The builder expected otherwise and wrote a test for it, which failed. The literals stay for D12's reason.
- **`EXPLAIN` asked twice in the same words answers with its first plan after a `DROP INDEX`.** The index is gone from `sqlite_master`, so the test reads the drop there.
- **The 100-value limit is real:** 100 bind and 101 are refused.
- **Every filter `compileQuery` accepts is looked up,** read from the plan for ten of them, negatives and `$and` among them. A lookup inside `$or` does not count yet, though SQLite can serve one from several indexes; that is a later widening.

## Not built

- **Wiring, index declarations and the per-write test** were built by the file the status line names.
- **Ordering and paging a result.**
- **Anything that reads `deprecated`.** A generated app writes its dropdown options by hand, so `website/docs/nebula/ontology.md` § *A field with a fixed list of values* tells the model to leave deprecated values out, and no client call returns the list.
- **A deployed run of the engine alone.** The wiring's deployed pass ran its SQL on a deployed Durable Object.
- **`sql-from-mongo`'s licence** reads "free for evaluation and non-commercial use". The engine is a fresh implementation that follows its operators, so it copies no code, and the header of `where.ts` credits it. Larry owns both.
