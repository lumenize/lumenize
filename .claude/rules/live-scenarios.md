---
paths:
  - "apps/nebula/harness/**"
---

# Writing a `/live` scenario

`live.md` says when to drive the running system and why `/live` is the default tier for behavioural
coverage. This file is what a scenario, and a helper under `apps/nebula/harness/`, must and must not
do. A scenario built from real logins has no fixture to build wrong, and every rule here protects
that property.

## A `/live` scenario MUST NOT compensate for its environment (2026-09-02)

**A helper under `apps/nebula/harness/` MUST perform only steps production performs, and MUST NOT
bridge a difference between the local stack and production.** The tier is worth its cost for one
reason, stated above: a scenario built from real logins has no fixture to build wrong. A
compensating helper puts the fixture back — it is a fixture that happens to be a function.
`provisionAndLogin` is the allowed kind: every step it takes, a browser takes. `pointLinkAt` was the
forbidden kind: it re-pointed an emailed link's host at the local stack before following it.

**The tell is in the JSDoc.** A helper whose comment explains why the harness environment differs
from production is compensating by definition. Such a helper MUST be treated as a defect in the
environment or the code, never as harness plumbing: fix what differs, delete the helper, re-run the
sweep. **The re-run is the point** — it surfaces whatever the helper was hiding before Larry meets
it by hand (Larry, 2026-09-02: *"the vast majority of all bugs we find after a task file is finished
are because of helpers we used to test during the task file build"*).

**Where it bit (2026-09-02):** local `wrangler dev` inferred its host from `wrangler.jsonc`'s
`routes`, so every login link a local stack emailed pointed at **production** — 22 green scenarios,
found by one hand-driven click. Both fixes were to the environment and the code, never a helper:
`apps/nebula/scripts/local-config.mjs` strips `routes`, and a Client's host node stamps the upgrade's origin
into `callContext.originRequest` so a mesh-borne facade mints from it rather than the issuer. ⇒
**Every emailed link is now followed AS SENT in every lane**, which is the property to defend: a new
host-rewriting helper is a regression of this rule, whatever its JSDoc says.

## Reading the Worker's logs

**`DevStack.logs` holds the Worker's own lines in both venues: a local stack's stdio, or on a
deployed target a `wrangler tail` filled in by Workers Logs (`harness/lib/deployed-logs.ts`).**
Neither deployed channel delivers every line, and in `experiments/tail-abort/RESULTS.md` no line was
lost by both: the tail loses each line an abort ends on an object hosting live tabs, and Workers Logs
lags up to about ten minutes. So a limb reading the logs runs in both venues, and `DevStack.logs` is
required: a scenario MUST NOT branch on the capture being absent.

- **Lines MUST be compared by when they were logged, with `loggedAfter` (`harness/lib/stdio.ts`),
  never by position.** A deployed capture arrives one invocation at a time, when each ends, so a
  later request's lines can arrive ahead of an earlier one's.
- **A wait for a line MUST use `LOG_WAIT_MS`**: 20 s locally, eleven minutes deployed, where a line
  only Workers Logs holds can take that long. A wait returns as soon as its line is in.
- **A check that a line is ABSENT MUST wait for a barrier and then call `settleForAbsence()`
  before it counts.** The barrier is a line logged after the one that must not appear; locally that
  is enough, but deployed a line from another invocation can arrive after its barrier, so the
  settle waits 30 s there. Where the barrier comes from the same invocation as the absent line, as
  the Gateway's per-frame `route` line does for what the frame woke, no settle is needed:
  `forged-continuation`'s `frameDone` is the example.
- **A limb reading a WebSocket upgrade's own lines, the node's start and its accept, MUST read
  them after the socket closes.** Deployed, an upgrade's invocation ends only then, and so do its
  lines. `scope-hosts-its-clients` limbs 2 and 4 are the example.
- **A check that needs a fresh stack MUST be guarded on `HARNESS_TARGET_URL === undefined`.** The
  deployed Worker is long-lived and shared by every run, so "no Star of this name ever started" or
  "this file was never written" holds only on a stack the scenario booted.
- **The deployed `DEBUG` is production's plus `TEST_DEBUG_ADDED`**
  (`apps/nebula/scripts/test-deploy-config.mjs`). A namespace a scenario reads deployed MUST be in
  one of the two, as a local read needs it in `bootVars`.

The deployed capture carries lines of the harness's own too: an access line in `wrangler dev`'s
shape for each request event, `[wrangler:info] POST /auth/magic-link 200 OK`, path only, and a
`[harness tail]` or `[harness logs]` notice when an event was truncated or did not parse, when the
tail sampled, or when a Workers Logs poll failed.

**A limb that COUNTS log lines MUST first wait for a line its own request logs after the thing it
counts.** The stack's stdio reaches the harness late and in bursts, so a count read too soon passes on
a tree where the failure it looks for happened. Bit 2026-09-27: `display-names-reach-subscribers`
passed one run in two under the mutation it was written to catch, until it waited for a line the
accept request printed after the Worker's warnings. That line arriving also shows the capture works.

**That line MUST be a debug line the same invocation logs last, never the request's access line.**
`settleAcceptance` logs `accepted` after any failed display-name write, and `handlePendingMembership`
logs `card answered` after any failed read. Deployed, an access line comes only from the tail, which
drops events, and Workers Logs keeps no copy: on 2026-10-14 the tail lost all four of
`invite-consent`'s card reads, and the limb waited eleven minutes for a line that could not come. On
the shared target an access line can also be another run's. A facade call's markers carry an
`operationId` the call mints, and the limb waits for that call's completion line
(`waitForDebugLines`, `harness/lib/stdio.ts`).

**A debug entry MUST be read through `debugLines` (`harness/lib/stdio.ts`), never matched line by
line.** wrangler prints each entry as a multi-line JSON block, its `namespace` and its `data` on
different lines, so a test for both on one line is false on every tree. Bit 2026-10-06:
`scope-hosts-its-clients` asserted that a refused upgrade started no Star that way, and passed
whatever happened; only its positive control, which found no start where there plainly was one,
showed the match could not fire.

**A log added to diagnose a scenario's failure MUST have its namespace in that scenario's
`bootVars` `DEBUG`, when the scenario sets one.** That value replaces the Worker's `DEBUG` for the
boot, and `@lumenize/debug` prints only `error` outside it. So the new line prints nothing in
exactly the run it was written for, and nothing reports the drop. Check it by booting the scenario
with a fault that fires the log, then finding the line in the stack's stdio. Bit 2026-10-13: a warn
under `nebula.Galaxy.model` was added to capture a Workers AI 400 seen only in `first-app-built`,
whose `bootVars` named six other namespaces. With `nebula.Galaxy.model` added, a boot of
`studio-codegen-rest` with an invalid `WORKERS_AI_TOKEN` printed the line.

## Timing a limb against the code it drives

**A limb's page MUST act only after its connection is up, as an app waits on the factory's `ready`.** A page that acts sooner has its first ops sent twice, once queued and once by the first connection's restore, and the second copy can answer what the code under test was holding. Bit 2026-10-11: a gate's resend survived its mutation for exactly that reason.

**A limb's wait MUST sit well inside any bound the code under test has.** A backstop that fires within the limb's wait rescues the mutation it exists to catch. Bit 2026-10-12: a version gate's 30 s bound reopened a stranded gate inside a 30 s wait, so a real wedge passed; the wait is now 15 s, and the correct path answers in about half a second.

## What the harness constructs, and what each limb proves

**Check what the harness CONSTRUCTS, not only what a scenario asserts.** A helper that builds
the credential is a mock wearing a helper's name, and every scenario riding it asserts over a
shape production cannot mint — a `connectDriver` mint path that set the issuing instance from the
scope made narrowing the scope narrow the claim in lockstep, so no scenario on it could produce a
denial by narrowing, the exact denial the passage/dominion work existed to create. **`connectDriver`
now has exactly two ways in: a real login, or a `session` the server minted.** A scenario needing a
wrong-shaped token for a negative control uses `mintDegradedToken` (rung 4), which is not a login
and never reaches `connectDriver`.

⚠️ **A multi-limb scenario reddens on its FIRST failing limb, which hides every later limb's
vacuity — so mutation-check PER LIMB, not per scenario.** Bit 2026-08-16: `passage-not-dominion`
went red under the mutation it was written against, which looked like proof the whole scenario was
capable of failing. It was not — its third limb called a Galaxy method on a Star, so it was refused
for "no such method" rather than for lack of passage, and would have stayed green if that limb's own
property broke. The scenario's redness came entirely from limb 1. ⇒ **Each limb needs a mutation
that isolates IT, and a positive control proving the thing it calls is reachable at all.** And where
a refusal is the assertion, **match the MESSAGE**: a boundary refusal and a dominion refusal are
indistinguishable as booleans, which is exactly the collapse such a scenario usually exists to catch.
