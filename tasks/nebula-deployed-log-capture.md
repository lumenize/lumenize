# Deployed `/live` runs read the Worker's own log lines

## Objective

A deployed `/live` run now captures `test-nebula`'s log lines through `wrangler tail`, so a scenario that reads the stack's logs runs unchanged in both venues. It was built on 2026-10-13/14 in the Workers Issues session and is not yet committed. With it, 13 of the 23 log-reading scenarios pass deployed and 10 do not. The same runs turned up two defects in the code, which this file also holds until each has a home.

It absorbs three `tasks/backlog.md` rows, deleted when the capture lands: *`drive.ts` starts a `wrangler tail` beside every deployed sweep*, its sub-bullet about a capture going quiet, and *`/live` on a deployed target cannot read the Worker's own markers*.

The rest of this file is the state on disk, then the pending items in the order to work them.

## How the capture works

- **`drive.ts` starts one tail per scenario.** With `HARNESS_TARGET_URL` set, `withDeployedLogs` runs `wrangler tail test-nebula --format json` through `lib/tail.ts` and hands the scenario `DevStack.logs`, the same reader the local venue has. The tail pings `/_version?sha=tail-probe` every 2 s until an event arrives, for up to 90 s.
- **The capture is in arrival order, not logged order.** Cloudflare delivers an invocation's lines when that invocation ends: up to 19 s late for a request, measured, and 171 s inside a build turn. So a scenario compares two lines with `loggedAfter` (the line's `timestamp`, then its index), never by index alone.
- **Waits are venue-sized.** `LOG_WAIT_MS` in `lib/stdio.ts` is 240 s deployed and 20 s local.
- **`test-nebula` logs `lmz.mesh` on top of production's `DEBUG`.** `TEST_DEBUG_ADDED` in `apps/nebula/scripts/test-deploy-config.mjs`, asserted by its selftest; `test-nebula` is deployed with it.
- **A failure keeps the whole capture.** `drive.ts` writes it to `$TMPDIR/lumenize-<scenario>-<iso>.log` and prints the path. The 2026-10-14 runs' captures are still there.

Uncommitted, all mine: `apps/nebula/harness/lib/tail.ts` (new), `drive.ts`, `lib/harness.ts`, `lib/stdio.ts`, 11 scenarios under `harness/scenarios/`, `apps/nebula/scripts/test-deploy-config.mjs` and its selftest, plus `experiments/depth-chain/` with its root `workspaces` entry and lockfile.

## Pending, in order

1. **Name the chain on a fire-back failure.** `packages/mesh/src/lmz-api.ts` logs `fire-back transport to __handleResponse failed` with only the error. Add the inbound `callChain` and its length, so the next `Subrequest depth limit exceeded` names the nodes it went through. Small and independent of the rest.
2. **Find why lines never reach the tail.** The 10 deployed failures, from the last run, each with the line it waited for:

   | Scenario | Never saw |
   |---|---|
   | `certificate-wake` | the already-accepted acceptance |
   | `claim-lifecycle` | the acceptance answering accepted, with 3 markers |
   | `client-routes` | the Gateway's line for `routes-5` (routes-12 in a rerun, missing from three tails at once) |
   | `galaxy-cap` | both refused acceptances' completion lines |
   | `scope-teardown` | the create's completion line |
   | `scope-hosts-its-clients` | the Star's start and accept lines, limbs 2 and 4 |
   | `logout-ends-every-host` | the logout's revocations: an empty list |
   | `studio-codegen-rest` | 229 chunks reached the tab, 44 deliveries logged |
   | `impersonation-lifecycle` | the Star never came to hold the impersonated tab |
   | `dev-star-follows-the-build` | 2 of 16 properties |

   Most are a line the Worker should have written and the capture never got. Two hypotheses, neither checked. First, `wrangler tail` drops events in sampling mode under load and says so only on stderr, which `lib/tail.ts` keeps only for its startup error. Second, an invocation that never ends never delivers its lines: the `client-routes` socket stayed open. Check the first by recording stderr through the run. Then decide each remaining failure as harness or code; a code defect gets fixed here.
3. **Land the capture.** Keep it on for every deployed run, or opt in per scenario with `export const deployedLogs = true` for the 13 that pass. Then run the local sweep, `drive.ts all --fast`, since 11 scenarios changed, and commit.
4. **Rules.** `live-scenarios.md` § *Reading the local stack's logs* now covers both venues: compare with `loggedAfter`, wait with `LOG_WAIT_MS`, guard a fresh-stack check with `HARNESS_TARGET_URL === undefined`, and note the synthesized access lines and the truncation marker. `live.md`'s sentence that a deployed sweep SHOULD run beside a `wrangler tail` becomes a fact the harness does.
5. **Backlog.** Delete the three absorbed rows. `first-app-built`'s pairing limb, the subject of the third, already runs deployed.
6. **Delete the guards for a venue without logs.** Once the capture runs everywhere, the "not observable deployed" branches are dead, and `DevStack.logs` can become required.
7. **Move `deleted-on-cloudflare.ts` onto `lib/tail.ts`.** It has its own copy of the event parser.
8. **Find the depth error's real chain.** `experiments/depth-chain/RESULTS.md` refuted the first suspect: a Client's answer resets the depth, so the Gateway's held promise is innocent. The remaining candidate is a Client delivery that ends with no answer, which fires back from the invocation that started it. Item 1's `callChain` is the evidence to wait for.
9. **Seal the continuation the Gateway holds in memory.** The Gateway keeps a node's continuation in `#pendingCalls`, so evicting the Gateway loses the call. `tasks/archive/mesh-calls-to-and-from-clients.md` accepted that risk. The long-term fix is a sealed continuation sent down to the Client, with a memory copy kept only for the timeout. It gets its own task file through `/write-task`.
10. **`handler threw: cannot subscribe before create`, ten times at error level.** Resources' `doSubscribe` throws it. Decide whether it is a race in the code or an expected refusal that belongs at `warn`.
11. **Commit `experiments/depth-chain/`** with its results, workspace entry and lockfile.

The MCP Events design talk is deferred to another session; its backlog row under Lumenize Mesh holds it.
