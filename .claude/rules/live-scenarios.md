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
`apps/nebula/scripts/local-config.mjs` strips `routes`, and the Gateway stamps the upgrade's origin
into `callContext.originRequest` so a mesh-borne facade mints from it rather than the issuer. ⇒
**Every emailed link is now followed AS SENT in every lane**, which is the property to defend: a new
host-rewriting helper is a regression of this rule, whatever its JSDoc says.

## Reading the local stack's logs

**A scenario that reads the local stack's stdio (`DevStack.logs`) MUST guard on its presence, and
MUST report that half as not observable on a deployed target.** The capture does not exist under
`HARNESS_TARGET_URL`. An unguarded read asserts over an empty string and reds every deployed run.
Bit 2026-09-05 on `first-app-built`'s marker-pairing limb, caught by a verifier panel rather than a run.

**A limb that COUNTS log lines MUST first wait for a line its own request logs after the thing it
counts.** The stack's stdio reaches the harness late and in bursts, so a count read too soon passes on
a tree where the failure it looks for happened. Bit 2026-09-27: `display-names-reach-subscribers`
passed one run in two under the mutation it was written to catch, until it waited for the accept
request's own access-log line, which wrangler prints after the Worker's warnings. That line arriving
also shows the capture works. A facade call prints no access-log line, so its markers carry an
`operationId` the call mints, and the limb waits for that call's completion line instead
(`waitForDebugLines`, `harness/lib/stdio.ts`).

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
