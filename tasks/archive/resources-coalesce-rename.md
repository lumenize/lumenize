# Resources: rename the snapshot-coalesce branch out of "debounce"

**Status:** ✅ **DONE + ARCHIVED 2026-07-18** — built via `/build-task`: `debounceMs` → `coalesceWindowMs` renamed in `resources.ts` + the baseline test callers (`star-resources.test.ts`, `guards.test.ts`), bare-identifier grep clean. ⚠️ **Green-run verification pending** — the baseline auth suite couldn't authenticate in the build sandbox (magic-link test-mode inactive), so it fails at client setup *before* the coalesce code; run `npx vitest run --project baseline star-resources guards` (or CI) to confirm green. *(Originally a pre-build detour for `nebula-galaxy-collapse-and-chat.md` — the sanctioned "one child at a time" exception, done first.)*

## Why now
ADR-004's in-place **snapshot coalesce** — a same-actor write within a window overwrites the *current* snapshot instead of opening a new row — is **mislabeled `debounce`** in the code. That collides with the **real** client-side debounce (the custom Vue store's write-batching before the wire). The Galaxy-collapse task made the collision acute (it nearly added a *third* "debounce" before that was deferred) and the fix is independent of it, so do it on clean ground first. **"coalesce" ≠ "debounce":** coalesce delays and batches *nothing* — the write lands immediately, it just lands on the current snapshot. Naming both "debounce" is a footgun; remove it, don't document it.

## Scope — the coalesce branch only
> **Build note (2026-07-18):** the real callers are the **baseline tests** (`star-resources.test.ts`, `guards.test.ts`) — they set the key via `callStarSetConfig(star, 'debounceMs', 0)`, a **string literal** coupled to the config key — **not** `resource-data-plane.ts` (which has no `debounceMs`). Corrected during `/build-task`.

In [apps/nebula/src/resources.ts](apps/nebula/src/resources.ts) (and its string-key callers in `apps/nebula/test/test-apps/baseline/`):
- `config.debounceMs` (persisted config key, default seed [resources.ts:107](apps/nebula/src/resources.ts)) + the local `const debounceMs` ([:181](apps/nebula/src/resources.ts)) → **`coalesceWindowMs`**.
- `// Debounce check` ([:214](apps/nebula/src/resources.ts)) + any "debounce" prose in that branch → **"coalesce"**.
- **Leave the CLIENT debounce alone** (the Vue store's write-batching `DebounceQueue`) — it is correctly named.

## Phase 1 — rename + verify
- Rename the symbols above. `debounceMs` is a **persisted** KV config key: either migrate on read (accept the old key, write the new) **or** — since pre-alpha wipes freely (memory: *"WIPE DEFERRED to multi-user-chat-UI milestone"*, which rides the Galaxy-collapse milestone this detour precedes) — just rename and let the default re-seed post-wipe. **Decide in review** (lean: plain rename + re-seed, since the wipe is imminent).
- **Grep the bare identifier** after — a text replace misses member-position / string-literal / comment uses ([[workflow.md § Symbol renames]]): `grep -rn '\bdebounceMs\b' apps packages` must return nothing (or only the intended migration-read fallback, if chosen).

**Confirm (capable-of-failing):** the `apps/nebula` suite is green; the coalesce test still asserts one-snapshot-row-on-same-actor-within-window under the new name (`coalesceWindowMs`); the bare-identifier grep is clean.

## Sequencing
- **Do FIRST**, then archive. `nebula-galaxy-collapse-and-chat.md` then references this as done and its Vocabulary drops the "rename candidate (flagged, not done)" note.
