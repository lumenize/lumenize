# Deployed `/live` runs read the Worker's own log lines

## Objective

A deployed `/live` run captures `test-nebula`'s log lines, so a scenario that reads the stack's logs runs unchanged in both venues. It was built on 2026-10-13/14 in the Workers Issues session. The same runs found a Mesh defect, the subrequest-depth error, now fixed, and a product gap, a turn that dies with its Galaxy, now a backlog row.

The rest of this file is how the capture works, then what is left.

## How the capture works

- **Two channels, one append-only text.** `drive.ts`'s `withDeployedLogs` runs `lib/deployed-logs.ts`: a `wrangler tail test-nebula --format json` through `lib/tail.ts`, filled in by Workers Logs polled through `lib/workers-logs.ts`. Neither delivers every line, and in `experiments/tail-abort/RESULTS.md` no line was lost by both. Whichever channel delivers a line first appends it, and the other's copy is left out, so a line never moves once read.
- **Arrival order, not logged order.** An invocation's lines arrive when it ends, a WebSocket upgrade's when its socket closes, and a line only Workers Logs holds up to about ten minutes late. A scenario compares lines with `loggedAfter` and waits with `LOG_WAIT_MS`, eleven minutes deployed.
- **The test target keeps more than production.** `scripts/test-deploy-config.mjs` adds `lmz.mesh` to `DEBUG` and turns on Workers Logs and traces, each asserted by its selftest.
- **A failure keeps the whole capture,** written to `$TMPDIR/lumenize-<scenario>-<iso>.log`, with a note for each invocation that ended other than `ok`.

`live-scenarios.md` § *Reading the Worker's logs* is the rule a scenario follows.

## Pending

1. **`dev-star-follows-the-build` deployed.** It passes locally with its install-line wait; its last deployed run predates the append-only capture. A deployed run is going.
2. **A node's call to its own name stays in place too (Larry, 2026-10-14).** The fix for the depth error routes a node's answer to itself in place; the request leg still sends a node's call to its own name by RPC. One predicate for both legs makes "a message for this node never crosses Workers RPC" the whole rule.
3. **Delete the guards for a venue without logs.** About 25 scenarios still branch on `stack.logs` being absent or say "not observable on a deployed target". The capture runs in both venues now, so each guarded limb runs deployed once its branch goes, and `DevStack.logs` can become required. Each needs a deployed run as it changes.
4. **Seal the continuation the Gateway holds in memory.** The Gateway keeps a node's continuation in `#pendingCalls`, so evicting the Gateway loses the call. `tasks/archive/mesh-calls-to-and-from-clients.md` accepted that risk. The long-term fix is a sealed continuation sent down to the Client, with a memory copy kept only for the timeout. It gets its own task file through `/write-task`.

The MCP Events design talk is deferred to another session; its backlog row under Lumenize Mesh holds it.
