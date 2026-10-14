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

1. **Delete the guards for a venue without logs.** About 25 scenarios still branch on `stack.logs` being absent or say "not observable on a deployed target". The capture runs in both venues now, so each guarded limb runs deployed once its branch goes, and `DevStack.logs` can become required. Each needs a deployed run as it changes.
The MCP Events design talk is deferred to another session; its backlog row under Lumenize Mesh holds it.
