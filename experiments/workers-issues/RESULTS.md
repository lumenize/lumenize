# Workers Issues against `@lumenize/debug`'s JSON lines

**Question.** Does Workers Issues pick up the errors Nebula logs, and how does it group them? `@lumenize/debug` writes every level, errors included, as one pretty-printed JSON string through `console.debug`, and its 66 `log.error` call sites pass `e.message` rather than the `Error`. The Issues docs say a logged error counts when it is "written at error level or containing an `Error` object or stack trace", and say nothing about grouping.

**Setup.** `experiment-workers-issues`, deployed 2026-10-13 at compatibility date 2026-10-01 with `observability.issues.enabled` and Workers Logs off, as Nebula's config has it. Each route in `src/index.ts` is one way an error can leave a Worker or a Durable Object. `scripts/drive.sh` hit each route three times, `n = 1..3`, with a `wrangler tail --format json` capture running.

## What the runtime records (from the tail)

This is what Issues has to work with, before any grouping.

| Route | What it does | What the runtime recorded |
|---|---|---|
| `a` | `@lumenize/debug`'s `error()`, as Nebula does today | level `debug`, one string argument |
| `b0` | our JSON through `console.error`, byte-identical each hit | level `error`, one string |
| `b` | the same, timestamp and data varying | level `error`, one string |
| `b2` | the same, a varying id in the message | level `error`, one string |
| `c` | our JSON, then the `Error` as a second argument | level `error`; `errorInfo[1]` holds the Error's `name`, `message` and `stack` |
| `d` | our JSON with the Error's stack serialized inside it | level `error`, one string, no `errorInfo` |
| `e` | `console.error(message, dataObject)` | level `error`; the second argument stays an object |
| `f` | a bare `Error` from one site, message varying | level `error`; `errorInfo[0]` with the stack |
| `g` | our JSON through `console.warn` | level `warn` |
| `h` | an uncaught throw, message varying | outcome `exception`, `exceptions[]` filled, status 500 |
| `i` | a 500 with nothing logged | outcome `ok`, status 500 |
| `j` | our JSON through `console.error`, inside a Durable Object | the object's own event, level `error` |
| `k` | a Durable Object method throws; the Worker catches it | the object's event has outcome `ok` and no exception; the Worker's is `ok`, 200 |
| `l` | the object catches its own throw and returns it, as Mesh does | nothing |
| `n1`, `n2` | one Error message logged from two different functions | level `error`; `errorInfo` stacks differ (`siteOne` vs `siteTwo`) |

Three things follow before Issues is even consulted:

1. **The level comes from the console method.** `a` carries `"level": "error"` inside its JSON and is still recorded at `debug`.
2. **An `Error` passed as its own argument is lifted into `errorInfo`, stack included.** A stack written into the JSON string, as in `d`, is not; there it is only text.
3. **A Durable Object method that throws is not a failed invocation.** `k`'s object event reads `outcome: ok` with no exception, because the throw travels back to the caller. A Mesh node, which catches and returns errors as values (`l`), leaves no trace at all unless something logs.

## What Issues made of it (from the dashboard)

Round 1 was the routes above. Route `a` was detected, which the tail had suggested it would not be, so round 2 added controls to separate the JSON's `level` field from the words in its message, and to find where a stack inside the JSON is read. Issues showed each round's issues within a minute of the drive.

| Route | What it does | Issue title in the dashboard | Hits → issues |
|---|---|---|---|
| `a` | `@lumenize/debug`'s `error()` (console.debug) | A certificate pack delete failed | 3 → 1 |
| `b0` | our JSON via console.error, identical | B0 certificate pack delete failed | 3 → 1 |
| `b` | the same, timestamp and data varying | B certificate pack delete failed | 3 → 1 |
| `b2` | a UUID in the message | B2 certificate pack \<uuid\> delete failed | 3 → 1 |
| `c` | our JSON, then the Error as a second argument | C upstream 503 · at index.js | 3 → 1 |
| `d` | the stack nested at `data.error.stack` | D certificate pack delete failed | 3 → 1 |
| `e` | `console.error(message, dataObject)` | E certificate pack delete failed {"host":"h1.example","id":"\<string\>"} | 3 → 3 |
| `f` | a bare Error, message varying | F failed \<uuid\> · at index.js | 3 → 1 |
| `g` | our JSON at warn via console.warn | not detected | |
| `h` | an uncaught throw | H uncaught \<uuid\> · at index.js | 3 → 1 |
| `i` | a 500, nothing logged | HttpServerError · HTTP 500 | 3 → 1 |
| `j` | our JSON at error, in a Durable Object | J certificate pack delete failed | 3 → 1 |
| `k` | the object throws, its caller catches | not detected | |
| `l` | the object returns its error as a value | not detected | |
| `n1`, `n2` | one message from two sites | N same message from two sites · at siteOne / at siteTwo | 6 → 2 |
| `q` | plain text "…delete failed" via console.debug | not detected | |
| `r` | our JSON at level `info` via console.debug | not detected | |
| `t` | our JSON at level `error`, no failure word, via console.debug | T certificate pack deleted | 3 → 1 |
| `u` | our JSON at level `info` via console.error | { | 4 → 1 |
| `v` | our JSON at level `error` via console.log | V certificate pack delete failed | 3 → 1 |
| `w` | our JSON at `error` via console.debug, the stack in a top-level `stack` | W certificate pack delete failed · at index.js | 4 → 1 |
| `x` | the same, a top-level `error` object holding the stack | X upstream 503 · at index.js | 3 → 1 |
| `y` | our JSON via console.debug, then the Error as a second argument | Y upstream 503 · at index.js | 2 → 1 |

Each issue's page shows a **Signature** of three fields, type, error message and stack frames, and that is what groups occurrences. Logged errors show as *Handled exception*, an uncaught throw as *Unhandled exception*. With `upload_source_maps`, frames resolve to `src/index.ts` lines.

## Conclusions

1. **Issues reads our JSON line's `level` and `message`, whichever console method wrote it.** `a`, `t` and `v` were detected at `debug` and `log`, with or without a failure word; `q` and `r` were not. So Nebula's current `log.error` lines are detected with no change, titled by their `message`.
2. **Our format groups well.** The timestamp and everything under `data` stay out of the signature (`b`, `d`), and a UUID in a message becomes `<uuid>` (`b2`, `f`). A second argument that is an object is folded into the message, and its strings are not normalized, so `e` made one issue per host. Keep data inside the JSON.
3. **A top-level `stack` is the one addition that helps.** It keeps our message as the title and adds a source-mapped stack, and the top frame joins the signature (`w`). An Error passed any other way, as a second argument (`c`, `y`) or as a top-level `error` object (`x`), replaces our message with the Error's. A stack nested under `data` is ignored (`d`).
4. **Disagreeing levels break the parse.** `u` wrote `level: info` through console.error; Issues stopped reading the JSON and took its first line, `{`, as the message. A logger that matches the console method to the JSON's level never produces this, but there is no reason to change the method at all.
5. **What never reaches Issues:** warnings (`g`), a Durable Object method that throws to its caller (`k`), and an error returned as a value (`l`), which is how Mesh delivers a `@mesh()` method's throw to a result handler. Those surface only where something logs them at `error`.

## Round 3: `@lumenize/debug` after it writes Errors (2026-10-13)

The logger now writes an Error as its name, message, stack, cause and own fields, and lifts the stack of an Error in `data` to a top-level `stack`. Two routes drove the real package:

| Route | What it does | Issue title | Result |
|---|---|---|---|
| `real` | `log.error(message, { host, error: new Error(…) })` | REAL certificate pack delete failed · at real (index.js) | detected; our message is the title; the stack trace reads `src/index.ts:145` |
| `realwarn`, stack lifted | `log.warn(…)` with an Error, the stack at the top level | REALWARN certificate pack delete slow · at realwarn (index.js) | **detected**: a top-level stack makes a warning an issue |
| `realwarn`, stack nested | the same, after the logger lifted only at error level | none, after 5 hits over two minutes | not detected; the tail shows the stack nested under `data.error` |

So the logger lifts the stack only at error level, and a warning keeps its Error's stack under `data`, where the tail still shows it and Issues ignores it.
