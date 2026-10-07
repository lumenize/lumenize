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
⚠️ The sweep `pkill -9 -f workerd`s between scenarios (a stray one starves the next boot), which
takes down a co-running `npm run dev`'s workerd too, and `wrangler dev` does not reliably respawn
it (bit twice 2026-09-02). It then stops every `workerd-nebula-…` container, a co-running stack's
included, since a `wrangler dev` killed that way leaves its containers up and they hang the next
`apps/nebula` vitest run. If a hand-driven stack is up, expect to reboot it after a sweep.
⚠️ **A source edit during a sweep invalidates every scenario after it** — each scenario boots its
own `wrangler dev`, which hot-reloads on a save under `apps/nebula/src/` and answers a mid-request
`503`. Wait for the run, or start a fresh one, as `testing.md` says for a running vitest suite.
Harness and scenario files are not watched, but every child re-imports them at spawn, so an edit
there MUST be a complete, type-checked write. Since 2026-09-06 the sweep DETECTS this rather than
trusting the rule: it fingerprints the watched tree and re-checks it around every scenario, so a
tainted sweep exits non-zero instead of reading as a real one.

## `/live` is the DEFAULT tier for behavioural coverage (2026-07-30)

**The `/live` scenario MUST be written first. You MAY drop to the vitest-plugin lane when the behaviour is
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
  **four** defects cost real time and **all four were fixture defects** — including a "member-less
  scope" fixture that had a membership on it, and in-lane invite tests reading the test-mode `links`
  map, so the email path was never exercised at all. None is constructible in a scenario whose state
  is produced by the system under test.
- **The repo's own record.** `testing.md`: *"historically `for-docs/` tests have found more bugs than
  all other tests combined."* Nothing comparable has ever been recorded for the isolated tiers. Those
  mini-apps are gone now that we build an app rather than libraries, and `/live` is what replaces
  them — so the tier that found the bugs currently has no successor unless you write one.
- **Mutation cannot substitute.** "Must go red" proves an assertion CAN fail; it is structurally
  blind to whether the thing asserted against resembles production, because mutating the code makes
  an unfaithful fixture red too. Both are required. (Measured 2026-07-30: a mutation-validated
  vitest-plugin test "covered" `authedFetch`'s refresh-on-expiry using a token *born* already due —
  green, and it proved the re-mint path runs, not that a session survives a real lapse. Only the
  live run produced a real 401 from a real server.)
- **It PREVENTS rather than detects.** `/live` has no test subclass to reach through, no `as any`, no
  mocks — you can only assert on what the real system did. In the same build, seven vitest-plugin
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


⚠️ **The sibling failure blames the mail instead — a waiter that cannot tell whose email it got
reports as a slow or missing send, never as the filter bug it is.** `testing.md` § *An email waiter
MUST name whose mail it is waiting for* owns it, along with the two shapes it takes and the audit
that checks them, because it is a property of every email waiter, not only of `/live`.

⚠️ **DO NOT ASSERT THAT YOU LACK THE ACCESS — CHECK.** The most insidious skip is not "this is slow",
it is *"I can't run that here, it needs Docker / real email / a deployed Worker"* — because it reads as
a **fact** rather than a preference, so nobody challenges it, least of all you. It is a **trained
prior**: in most environments an agent genuinely has none of this. **In this repo that prior is false,
because it was deliberately made false.** What is actually present:

- **A real email round trip**, not a mock and not a test-mode shortcut — `provisionAndLogin` /
  `loginViaEmail` wait on the deployed email-test Worker via the `*@lumenize-test.dev` catch-all, extract the
  link from the message that genuinely arrived, and click it (ADR-009 rung 1).
- **Credentials on disk** — `.dev.vars` plus a `wrangler login` session. Verify with `ls`, do not assume.
- **Docker-free boots** — a scenario declaring `needsContainer = false` skips the image build entirely,
  so auth / impersonation / profile / resource work needs no Docker at all.
- **A scenario registry** in `apps/nebula/harness/drive.ts` — adding one is an import plus a line.

⇒ Before writing *"this can't be tested live"*, run the check that would falsify it. Bit 2026-08-04
three separate times in one session: the harness's default login path was already rung 1, `.dev.vars`
and the wrangler session were both present, and `needsContainer = false` already existed — none of it
discovered until someone asked why the tier had been skipped.

## Writing a scenario — `live-scenarios.md`

**What a scenario and a harness helper must and must not do lives in `live-scenarios.md`, which
loads when you touch `apps/nebula/harness/`:** no helper that makes up for a difference between the
local stack and production, guarding and timing a read of the stack's logs, checking what the
harness constructs, and a mutation check for each limb of a multi-limb scenario.

## Two venues, one registry — local is the default; deployed is a deliberate pass (2026-08-29)

Every scenario in `apps/nebula/harness/drive.ts` runs unchanged in two venues: a fresh local
`wrangler dev` (the default), or a deployed worker via `HARNESS_TARGET_URL=<url>`. **Local MUST be
the default venue for writing and iterating on scenarios — container builds included.** Local
`wrangler dev` + Docker runs the FULL contract: no `/dev/fuse` exists there, but computerd
materializes the synced `/workspace` subtree onto the container's real disk, which is functionally
equivalent for a build (`containers.md` § *There is NO source-push step* carries the subtree
contract). Measured: a container-free scenario is ~13 s end to end; the full container `build-box`
is ~110 s including the boot; a deployed iteration costs those same seconds PLUS a 4–8 minute
deploy (docker build, push, rollout, propagation) on every code change. The belief that a real build needs
the deployed mount was the root-level VFS seeding bug observed locally, and it held for a day as a
"structural" fact (bisected 2026-08-29, `experiments/fuse-bisect/RESULTS.md`).

**A deployed pass MUST still run — at the wipe gate/milestones, and after changes to the container
image, `@cloudflare/computer`, or the toolchain triple** (`bash apps/nebula/scripts/deploy-test.sh`,
then the same drives with `HARNESS_TARGET_URL`). It is not the inner loop and MUST NOT be dropped
either, because it alone catches the deploy-only failure class: the Worker startup CPU limit (error
10021 — which shipped behind weeks of green local tiers, and is why the compilers task existed),
custom-domain claiming, image-rollout/propagation skew, real kernel FUSE, persist-before-`abort`,
and the stuck-flag race. `test-nebula` is the standing deployed target, redeployed in place under
one stable name (deliberate — fresh names would strand a DO-namespace set per run; the script
header carries the reasoning). Do not delete it as clutter. A deployed sweep spends most of its time
waiting on Cloudflare, so `drive.ts all --concurrency=N` overlaps the waits: at 2 it took 79.5 min
against 142 one at a time (2026-10-04). A local sweep refuses it.

**A build whose change can only show deployed MUST end its close-out with a deployed pass of its own scenarios** (Larry, 2026-10-07). That covers a change to what a Client hears back, to teardown or `ctx.abort()`, to Workers KV or auth, to certificates or placement, or to a container. Deploy with `deploy-test.sh` and run the scenarios the build wrote or touched beside a `wrangler tail` capture; the full sweep stays at the wipe gate and milestones. The evidence is `nebula-clients-connect-to-their-scope`: its deployed pass found both of that build's real defects, a 4410 close ordered wrong twice, first ahead of a Galaxy's wipe and then behind its abort, and an older stale-KV refusal. No local tier could produce any of them, because no local Galaxy orders a certificate, a local abort delivers every frame, and local KV reads back its own writes.

**A local sweep never runs the deployed-only paths, so a change to what a Client hears back MUST
be checked against them before the deploy.** They are `drive.ts`'s account sweep and the shared
app's cleanup, and every branch on `HARNESS_TARGET_URL` or on the stack's logs being absent
(`grep -rlnE 'HARNESS_TARGET_URL|stack\.logs' apps/nebula/harness`). On 2026-10-06 a deletion's answer became a 4410 close, and three of those
paths still waited for the answer; the first deployed run's account sweep reported ten failed
deletes that had all landed. **A deployed sweep SHOULD run beside a `wrangler tail <worker>
--format json` capture,** since a deployed failure leaves no logs otherwise: one that day passed
when run alone and stayed unexplained.

⚠️ **Exploration, distinct from automated testing.** `.claude/rules/testing.md` owns the vitest suites
(the capable-of-failing, committed regression net); this is the *running-system* check. Both MUST be
used, cross-linked, and MUST NOT be merged — a finding here worth locking in becomes a vitest test there.
