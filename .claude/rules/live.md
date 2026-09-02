# Drive the Running System (explore / verify / debug)

For anything a user actually perceives — a Studio flow, a rendered change, a reconnect/reload behavior,
a permission effect — **you MUST ground yourself in the RUNNING system, not just the code and green
suites.** Code and runtime diverge (the chat-history capability was fully present in code but never
wired into the UI); a green vitest run is necessary, not sufficient, for what a user sees.

- **Explore first.** Before acting on a UI/behavior request, you MUST pull up the running app to confirm
  you understand what the user means and what the current behavior actually IS — the runtime analogue of
  reading the file before editing it (and stronger for UI, since the code can look wired when it isn't).
- **Verify before done.** After a user-facing change, you MUST drive the affected flow and MUST attach
  the evidence (assert outcome or a capture) when you report it done.
- **Debug with it.** When something's off, drive + inspect to see what actually happens.

**How:** the `/live` skill, or `npx tsx apps/nebula/harness/drive.ts <scenario>` (`apps/nebula/harness/`).
It boots a fresh local `wrangler dev`, mints an identity, drives + inspects (API via `NebulaClient`; UX
via Playwright — screenshot / a11y / console / network), exits non-zero on failure. Needs `.dev.vars` +
a `wrangler login` session; **Docker only when the scenario declares `needsContainer`** — a
container-free boot skips the image build entirely.

⚠️ **After changing anything a scenario you did NOT write depends on, you MUST sweep the whole
registry — `drive.ts all` (add `--fast` to skip the Docker ones).** The registry is a suite nothing
runs: `/live` is not in CI, so breaking someone else's scenario is silent until whoever owns it
happens to run it, which for an untouched one is never. Measured 2026-09-01: a build shipped its own
five scenarios green while breaking **nine of the seventeen** that came before it — a shared login
helper, an acceptance semantic, and a login form deleted from a screen three scenarios drove. No
vitest suite could see any of it, and the sweep that found it takes about four minutes.

## `/live` is the DEFAULT tier for behavioural coverage (2026-07-30)

**The `/live` scenario MUST be written first. You MAY drop to pool-workers when the behaviour is
genuinely pure — a predicate, a parser, a classification table — and the test MUST then say why it
needed no running system.**
This inverts the older "calibrate, reach for it when runtime behaviour is uncertain" framing, on
evidence rather than taste:

- ⭐ **THE LEADING REASON: a scenario built from real logins has NO FIXTURE TO BUILD WRONG.** This is a
  different claim from fidelity, and a stronger one. Fidelity says the *result* is trustworthy because
  the runtime is real; this says the *test* is trustworthy because there is no hand-built state for it
  to be wrong about. Every in-lane assertion rests on a fixture somebody constructed, and a fixture
  built in the SAFE shape passes whether the code is right or not — which mutation testing cannot
  catch, because mutating the code reddens a safe fixture too. Measured 2026-08-04, one build:
  **four** defects cost real time and **all four were fixture defects** — a mutation-restore that
  corrupted a neighbouring statement via a suffix collision; an acceptance fixture where the guard
  protected the row either way; a "member-less scope" fixture that had a membership on it; and in-lane
  invite tests reading the test-mode `links` map, so the email path was never exercised at all. None
  is constructible in a scenario whose state is produced by the system under test.
- **The repo's own record.** `testing.md`: *"historically `for-docs/` tests have found more bugs than
  all other tests combined."* Nothing comparable has ever been recorded for the isolated tiers. Those
  mini-apps are gone now that we build an app rather than libraries, and `/live` is what replaces
  them — so the tier that found the bugs currently has no successor unless you write one.
- **Mutation cannot substitute.** "Must go red" proves an assertion CAN fail; it is structurally
  blind to whether the thing asserted against resembles production, because mutating the code makes
  an unfaithful fixture red too. Both are required. (Measured 2026-07-30: a mutation-validated
  pool-workers test "covered" `authedFetch`'s refresh-on-expiry using a token *born* already due —
  green, and it proved the re-mint path runs, not that a session survives a real lapse. Only the
  live run produced a real 401 from a real server.)
- **It PREVENTS rather than detects.** `/live` has no test subclass to reach through, no `as any`, no
  mocks — you can only assert on what the real system did. In the same build, seven pool-workers
  tests could not fail; the one `/live` scenario had zero on first write.

⚠️ **The wall-clock objection is retired by a NUMBER, so stop arguing with it.** A full real-email
round trip — boot a fresh `wrangler dev`, claim a Universe, send a real invite, click real emails,
assert, exit — is **~13 s end to end, of which 3–7 s is the scenario** (measured 2026-08-04, three
container-free scenarios). Every objection ever raised against this tier has been worth about thirteen
seconds. The older framing — that the boot costs the AGENT's time, not the reviewer's — is still true
and still the right answer when a scenario IS slow, but it concedes the premise; the measurement does
not. ⚠️ If a run seems to take minutes, **suspect your own scenario before the tier**: a leaked
`waitForEmail` waiter keeps Node's event loop alive, so the process prints its verdict and then hangs,
which is indistinguishable from a slow boot. That exact bug is what made this tier *look* expensive.

⚠️ **The sibling failure blames the mail instead: `waitForEmail({ instance })` filters SERVER-side, so
a waiter armed on the wrong tag waits out its full timeout and reports "No email received" — a
delivery symptom for what is a filter bug.** It arises whenever the tag is decided AFTER the waiter is
armed: a helper that claims a scope but falls back to the scope-less login on a 409 sends `_scopeless`
mail to a waiter listening for the scope, so it fails only for an address with history — which reads
as flaky. ⇒ **When a later branch decides the tag, do not filter on it**; a unique recipient is the
filter that always discriminates. Cost of learning this the other way, 2026-09-01: two sessions and
three wrong theories about the email provider.

⚠️ **DO NOT ASSERT THAT YOU LACK THE ACCESS — CHECK.** The most insidious skip is not "this is slow",
it is *"I can't run that here, it needs Docker / real email / a deployed Worker"* — because it reads as
a **fact** rather than a preference, so nobody challenges it, least of all you. It is a **trained
prior**: in most environments an agent genuinely has none of this. **In this repo that prior is false,
because it was deliberately made false.** What is actually present:

- **A real email round trip**, not a mock and not a test-mode shortcut — `provisionAndLogin` /
  `loginViaEmail` wait on the deployed email-test Worker via the `*@lumenize.io` catch-all, extract the
  link from the message that genuinely arrived, and click it (ADR-009 rung 1).
- **Credentials on disk** — `.dev.vars` plus a `wrangler login` session. Verify with `ls`, do not assume.
- **Docker-free boots** — a scenario declaring `needsContainer = false` skips the image build entirely,
  so auth / impersonation / profile / resource work needs no Docker at all.
- **A scenario registry** in `apps/nebula/harness/drive.ts` — adding one is an import plus a line.

⇒ Before writing *"this can't be tested live"*, run the check that would falsify it. Bit 2026-08-04
three separate times in one session: the harness's default login path was already rung 1, `.dev.vars`
and the wrangler session were both present, and `needsContainer = false` already existed — none of it
discovered until someone asked why the tier had been skipped.

## A `/live` scenario MUST NOT compensate for its environment (2026-09-02)

**A helper under `apps/nebula/harness/` MUST perform only steps production performs, and MUST NOT
bridge a difference between the local stack and production.** The tier is worth its cost for one
reason, stated above: a scenario built from real logins has no fixture to build wrong. A
compensating helper puts the fixture back — it is a fixture that happens to be a function.
`provisionAndLogin` is the allowed kind: every step it takes, a browser takes. `pointLinkAt` was the
forbidden kind: it re-pointed an emailed link's host at the local stack before following it.

**The tell is in the JSDoc.** A helper whose comment explains why the harness environment differs
from production is compensating by definition — `pointLinkAt`'s said *"the auth layer embeds its
configured ISSUER origin in the link, which is not where we're driving against a local
wrangler-dev."* Such a helper MUST be treated as a defect in the environment or the code, never as
harness plumbing: fix what differs, delete the helper, re-run the sweep. **The re-run is the
point** — it surfaces whatever the helper was hiding before Larry meets it by hand, which is the
bottleneck this rule protects (Larry, 2026-09-02: *"the vast majority of all bugs we find after a
task file is finished are because of helpers we used to test during the task file build"*).

**Where it bit (2026-09-02):** local `wrangler dev` inferred its host from `wrangler.jsonc`'s
`routes`, so every login link a local stack emailed pointed at **production** — 22 green scenarios,
found by one hand-driven click. The environment was fixed (`apps/nebula/scripts/local-config.mjs`
strips `routes`; the Studio proxy forwards the real Host) and the helper died with it. The invite
sites needed one more piece the same day — a mesh call carries no request URL, so the facade had
minted at the issuer — and the fix was again the code, not a helper: the Gateway now stamps the
upgrade's origin into `callContext.originRequest` (`mesh-origin-request.md` Phase 1) and the
facade mints from it. That deleted the last two compensators, `pointInviteLinkAt` and its vitest
twin `pointAtOrigin`. ⇒ **Every emailed link is now followed AS SENT in every lane**, which is the
property to defend: a new host-rewriting helper is a regression of this rule, whatever its JSDoc says.

## Two venues, one registry — local is the default; deployed is a deliberate pass (2026-08-29)

Every scenario in `apps/nebula/harness/drive.ts` runs unchanged in two venues: a fresh local
`wrangler dev` (the default), or a deployed worker via `HARNESS_TARGET_URL=<url>`. **Local MUST be
the default venue for writing and iterating on scenarios — container builds included.** Local
`wrangler dev` + Docker runs the FULL contract: no `/dev/fuse` exists there, but computerd
materializes the synced `/workspace` subtree onto the container's real disk, which is functionally
equivalent for a build (`containers.md` § *There is NO source-push step* carries the subtree
contract). Measured: a container-free scenario is ~13 s end to end; the full container `build-box`
is ~110 s including the boot; a deployed iteration costs those same seconds PLUS a 4–8 minute
deploy (docker build, push, rollout, propagation) on every code change.

**A deployed pass MUST still run — at the wipe gate/milestones, and after changes to the container
image, `@cloudflare/computer`, or the toolchain triple** (`bash apps/nebula/scripts/deploy-test.sh`,
then the same drives with `HARNESS_TARGET_URL`). It is not the inner loop and MUST NOT be dropped
either, because it alone catches the deploy-only failure class: the Worker startup CPU limit (error
10021 — which shipped behind weeks of green local tiers, and is why the compilers task existed),
custom-domain claiming, image-rollout/propagation skew, real kernel FUSE, persist-before-`abort`,
and the stuck-flag race. `test-nebula` is the standing deployed target, redeployed in place under
one stable name (deliberate — fresh names would strand a DO-namespace set per run; the script
header carries the reasoning). Do not delete it as clutter.

⚠️ The old belief this section replaces — "a real build needs the deployed mount; local serves
empty" — was the root-level VFS seeding bug observed locally (bisected 2026-08-29,
`experiments/fuse-bisect/RESULTS.md`), and held for a day as a "structural" fact nobody re-probed.
It is the § *DO NOT ASSERT THAT YOU LACK THE ACCESS* failure shape wearing a measurement's costume:
the probe was real, the conclusion was wrong because the fixture underneath it was.

**Check what the harness CONSTRUCTS, not only what a scenario asserts.** A helper that builds
the credential is a mock wearing a helper's name, and every scenario riding it asserts over a
shape production cannot mint. `connectDriver` used to carry a mint path that set the issuing
instance from the scope, so narrowing the scope narrowed the claim in lockstep — a scenario built
on it could not produce a denial by narrowing, which was the exact denial the 2026-08-16
passage/dominion work existed to create. The fix was to re-derive rather than port:
`scenarios/downward-dominion.ts` takes its admin limb from a real login (`provisionAndLogin`,
rung 1) so the server decides the claim. **That mint path was deleted on 2026-09-02** once its
last two callers proved constructible by real paths (the non-admin control by a real invite, the
superuser by the token limb 2 had already refreshed — under a justification that was simply
stale). `connectDriver` now has exactly two ways in: a real login, or a `session` the server
minted. A scenario that needs a wrong-shaped token for a negative control uses
`mintDegradedToken` (rung 4), which is not a login and never reaches `connectDriver`.

⚠️ **A multi-limb scenario reddens on its FIRST failing limb, which hides every later limb's
vacuity — so mutation-check PER LIMB, not per scenario.** Bit 2026-08-16: `passage-not-dominion`
went red under the mutation it was written against, which looked like proof the whole scenario was
capable of failing. It was not — its third limb called a Galaxy method on a Star, so it was refused
for "no such method" rather than for lack of passage, and would have stayed green if that limb's own
property broke. The scenario's redness came entirely from limb 1. ⇒ **Each limb needs a mutation
that isolates IT, and a positive control proving the thing it calls is reachable at all.** And where
a refusal is the assertion, **match the MESSAGE**: a boundary refusal and a dominion refusal are
indistinguishable as booleans, which is exactly the collapse such a scenario usually exists to catch.

⚠️ **Exploration, distinct from automated testing.** `.claude/rules/testing.md` owns the vitest suites
(the capable-of-failing, committed regression net); this is the *running-system* check. Both MUST be
used, cross-linked, and MUST NOT be merged — a finding here worth locking in becomes a vitest test there.
