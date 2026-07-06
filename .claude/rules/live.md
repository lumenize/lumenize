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
via Playwright — screenshot / a11y / console / network), exits non-zero on failure. Needs Docker +
`.dev.vars` + a `wrangler login` session. A ~2-min boot, so calibrate — reach for it when runtime
behavior is uncertain or non-trivial, not for a known one-liner.

⚠️ **Exploration, distinct from automated testing.** `.claude/rules/testing.md` owns the vitest suites
(the capable-of-failing, committed regression net); this is the *running-system* check. Use both,
cross-linked, never merged — a finding here worth locking in becomes a vitest test there.
