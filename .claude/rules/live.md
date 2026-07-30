# Drive the Running System (explore / verify / debug)

For anything a user actually perceives — a Studio flow, a rendered change, a reconnect/reload behavior,
a permission effect — **ground yourself in the RUNNING system, not just the code and green suites.**
Code and runtime diverge (the chat-history capability was fully present in code but never wired into the
UI); a green vitest run is necessary, not sufficient, for what a user sees.

- **Explore first.** Before acting on a UI/behavior request, pull up the running app to confirm you
  understand what the user means and what the current behavior actually IS — the runtime analogue of
  reading the file before editing it (and stronger for UI, since the code can look wired when it isn't).
- **Verify before done.** After a user-facing change, drive the affected flow and attach the evidence
  (assert outcome or a capture) when you report it done.
- **Debug with it.** When something's off, drive + inspect to see what actually happens.

**How:** the `/live` skill, or `npx tsx apps/nebula/harness/drive.ts <scenario>` (`apps/nebula/harness/`).
It boots a fresh local `wrangler dev`, mints an identity, drives + inspects (API via `NebulaClient`; UX
via Playwright — screenshot / a11y / console / network), exits non-zero on failure. Needs `.dev.vars` +
a `wrangler login` session; **Docker only when the scenario declares `needsContainer`** — a
container-free boot skips the image build entirely.

## `/live` is the DEFAULT tier for behavioural coverage (2026-07-30)

**Write the `/live` scenario first. Drop to pool-workers when the behaviour is genuinely pure — a
predicate, a parser, a classification table — and say in the test why it needed no running system.**
This inverts the older "calibrate, reach for it when runtime behaviour is uncertain" framing, on
evidence rather than taste:

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

⚠️ **The wall-clock objection is a training reflex, and here it is also aimed at the wrong person.**
A boot costs the AGENT's time, not the reviewer's — Larry is typically away, walking, or in another
session while it runs. Optimising a cost the human does not pay, at the expense of coverage they do
pay for, is backwards. If the slowness genuinely bites, that pressure is the signal to make the
harness faster (as container-free boots did), not to write a weaker test.

⚠️ **Exploration, distinct from automated testing.** `.claude/rules/testing.md` owns the vitest suites
(the capable-of-failing, committed regression net); this is the *running-system* check. Use both,
cross-linked, never merged — a finding here worth locking in becomes a vitest test there.
