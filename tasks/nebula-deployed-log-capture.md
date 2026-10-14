# Deployed `/live` runs read the Worker's own log lines

## Objective

A deployed `/live` run captures `test-nebula`'s log lines, so a scenario that reads the stack's logs runs unchanged in both venues. It was built on 2026-10-13/14 in the Workers Issues session. The same runs found a Mesh defect, the subrequest-depth error, now fixed, and a product gap, a turn that dies with its Galaxy, now in pre-alpha (`nebula-pre-alpha.md` § *Turn-liveness heartbeat*).

The rest of this file is how the capture works, then what is left.

## How the capture works

- **Two channels, one append-only text.** `drive.ts`'s `withDeployedLogs` runs `lib/deployed-logs.ts`: a `wrangler tail test-nebula --format json` through `lib/tail.ts`, filled in by Workers Logs polled through `lib/workers-logs.ts`. Neither delivers every line, and in `experiments/tail-abort/RESULTS.md` no line was lost by both. Whichever channel delivers a line first appends it, and the other's copy is left out, so a line never moves once read.
- **Arrival order, not logged order.** An invocation's lines arrive when it ends, a WebSocket upgrade's when its socket closes, and a line only Workers Logs holds up to about ten minutes late. A scenario compares lines with `loggedAfter` and waits with `LOG_WAIT_MS`, eleven minutes deployed.
- **Workers Logs and traces are on for production, so the test target has them too** (Larry, 2026-10-14). `scripts/test-deploy-config.mjs` keeps production's `observability` unchanged and adds `lmz.mesh` to `DEBUG`, each asserted by its selftest.
- **The backfill asks Workers Logs for `cf-worker` events only.** Every one of our lines is one; with traces on, spans are about nine in ten of the rest. Measured on the 2026-10-14 sweep's busiest fifteen minutes: one poll pulled 31,893 events, 52 MB, in 36 s with spans, and 2,288 events, 2.6 MB, in 4 s without.
- **An access line comes only from the tail**, so a limb never waits on one; it waits on a debug line its request logs last (`live-scenarios.md` § *Reading the Worker's logs*).
- **The agent can cut a wait short** (Larry, 2026-10-14). A wait says what it waits for after 30 s, `HARNESS_LOG_WAIT_MS` replaces the eleven-minute budget, and a SIGINT or SIGTERM stops the run, keeps its capture and cleans up; a sweep passes the signal to the scenarios running and starts no more.
- **A failure keeps the whole capture,** written to `$TMPDIR/lumenize-<scenario>-<iso>.log`, with a note for each invocation that ended other than `ok`.

`live-scenarios.md` § *Reading the Worker's logs* is the rule a scenario follows.

## Pending

1. **The guards are deleted and `DevStack.logs` is required; what remains is a deployed pass of the limbs the 2026-10-14 sweep reddened.** That sweep passed 53 of 65 at concurrency 2. Of the twelve failures:
   - **Six were scenarios reading a line before it could arrive**, and are fixed: `dev-star-follows-the-build` limb 9, `delete-from-its-own-page` limb 2, `scope-teardown` limb 7 and `logout-ends-every-host` limb 2 each read a line from another invocation without waiting for it, and `invite-consent` limb 6 waited on an access line the tail had dropped.
   - **Two were the platform resetting the shared app's Galaxy** at 17:10:58, dropping all fourteen sockets with 1006 under the same script version. The reconnects were rightly told to subscribe again, which `push-survives-token-lapse` limb 1 and `resubscribe-when-lost` limb 2 counted as a defect. Each now counts subscribes against what its tab was told.
   - **`resubscribe-when-lost` limb 3's reconnect left the harness six seconds late**, past the grace period, so it was rightly told `true`. The suspected cause is the backfill's 52 MB polls, now filtered; unproven.
   - **Three were a Galaxy restarting mid-turn or mid-build**, nothing recording why: `four-party-chat`, `studio-codegen-rest`, `studio-guidance-loop`. Pre-alpha now runs such a turn again once (`nebula-pre-alpha.md` § *Turn-liveness heartbeat*).
   - **`forged-continuation`** met a transient 500 when the Registry's connection dropped during `claim-universe`, and **`deleted-on-cloudflare`** the listing lag it is known for.
   Every one of these scenarios passes locally, and `display-names-reach-subscribers` and `forged-continuation` limb 2 no longer wait on an access line either. What remains is their deployed pass.
The MCP Events design talk is deferred to another session; its backlog row under Lumenize Mesh holds it.
