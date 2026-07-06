---
name: live
description: Drive + inspect a RUNNING Nebula (local `wrangler dev`) as an authenticated identity — to EXPLORE (see the app's real current behavior before acting on a UI/behavior request — the runtime analogue of reading the code first), VERIFY (confirm a user-facing change works before declaring it done), or DEBUG (find the runtime truth when something's off). Runs the harness at `apps/nebula/harness` (boot → mint identity → drive → inspect/capture → wipe), exiting non-zero on failure. Use when a request is about how the running Studio/Nebula actually behaves — "pull it up", "drive it", "check it live", "does it actually…".
---

# Live

Boot a fresh local `wrangler dev`, mint an authenticated identity, and **drive + inspect the running
Nebula/Studio** — the API side (`NebulaClient` `resources.*`/subscribe/transact) and the browser side
(Playwright: navigate, screenshot, a11y tree, console errors, failed network). It's *drive-a-running-
app-and-look*; what you do with that is up to you. Task: `tasks/archive/claude-live-verification.md`.

## Three uses (explore is first-class, not just "verify")

- **Explore — ground yourself before acting.** For a UI/behavior request, pull up the running app
  first to confirm you understand what the user means and what the current behavior actually IS. This
  is the runtime equivalent of reading the file before editing it — and *stronger* for UI, because the
  code can lie: the chat-history capability looked fully wired in code, but only driving the live UI
  showed the SPA never uses it. When code and runtime might diverge (a recurring Nebula pattern), look.
- **Verify — confirm before declaring done.** After a user-facing change, drive the affected flow and
  assert/capture the result before calling it done. Green vitest suites are necessary, not sufficient,
  for anything a user sees.
- **Debug — find the runtime truth.** When something's off, drive + inspect to see what actually
  happens (the `studio-chat-reload` capture surfaced the exact chat-history gap this way).

⚠️ **Exploration, distinct from the vitest suites** (`.claude/rules/testing.md` owns those) — use it
*alongside* tests, never instead. A finding worth locking in becomes a vitest test there.

**Calibrate:** a cold boot is ~2 min (container + `wrangler dev`; +vite/email for the browser path),
so reach for it when the runtime behavior is uncertain or non-trivial — not reflexively for a known
one-line change.

## Run

```sh
# From the repo root. Boots the stack, runs the scenario, tears down, exits NON-ZERO on any failure.
npx tsx apps/nebula/harness/drive.ts [scenario]        # default: message-roundtrip
HARNESS_DEBUG=1 npx tsx apps/nebula/harness/drive.ts <scenario>   # stream wrangler-dev stdio
```

Scenarios (`apps/nebula/harness/scenarios/`, registered in `drive.ts`):
- **`message-roundtrip`** — API driver: mint a correct-shape token → round-trip a `Message` marker
  (transaction + read + subscribe) → negative controls (base / no-`access` tokens get 403).
- **`superadmin-reach`** — a `*` super-admin reaches an ungranted scope via the `access.admin` bypass;
  a non-admin is denied the same op.
- **`studio-chat-reload`** — browser driver (real magic-link login): login → chat → reload, capturing
  screenshot + a11y + console/network to `harness/.artifacts/` (before AND after the transition, so an
  empty end-state isn't ambiguous).

## Prod drive — autonomous, no boot (`nebula.lumenize.com`)

Drive the DEPLOYED Nebula with no local boot, for exploring/inspecting **prod** data:

```sh
npx tsx apps/nebula/harness/prod.ts enumerate    # list the prod Universes (my-scopes, * token)
```

⚠️ **Standing authorization — when Larry asks me to explore / inspect / read prod data, DO IT
autonomously: no reconfirming, no manual credentialing.** He built this capability precisely so we can
move fast, and explicitly accepted the security tradeoff. This standing OK is **read-mostly**: prod
*writes* / deploys / secret changes stay deliberate + rare (not covered by it).

How it works: a one-time login uses the **Turnstile-bypass token** (`NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN`
in `.dev.vars`, sent as the `x-lumenize-turnstile-bypass` header) to get past prod's Turnstile, then
seeds a gitignored **stored refresh token** (`harness/.prod-session.json`); subsequent runs refresh
headlessly (~2.5s, no email). Needs `claude@lumenize.io` routed to the email-test Worker (an Email
Routing rule → Destination Worker). **Kill-switch: delete `.prod-session.json`.** M1 controls +
details: `apps/nebula/harness/FINDINGS.md`. Add prod commands to `prod.ts` as needed (narrowest
`activeScope` per read).

## Prerequisites (a clean checkout needs only these)

- **Docker Desktop running** — the DevContainer builds at boot (the harness probes `docker info`).
- **`.dev.vars`** with the JWT signing keys (`JWT_PRIVATE_KEY_BLUE`) and `TEST_TOKEN` (browser login).
- **`wrangler login`** OAuth session — the boot uses the **remote** AI / email bindings (NO `--local`).

## The runnable gate

`drive.ts` runs boot → identity → scenario → inspect/assert → wipe → report and **exits non-zero if
any step fails** — so `/live <scenario>` is a real gate, not "can be invoked". A `0` exit means the
scenario's own asserts passed against the live system.

## Boot gotchas (learned the hard way — see `apps/nebula/harness/FINDINGS.md`)

- **Never `--local`.** Boot exactly like `npm run dev`; `--local` + the DevContainer HANGS after the
  image build. (`HARNESS_LOCAL=1` opts in for a no-OAuth env, but the hang means the full stack can't
  yet boot that way.)
- **Hung boot?** `pkill -9 -f workerd` then `rm -rf apps/nebula/.wrangler` (stale/locked state from a
  killed boot; the Docker image cache is separate), then retry. Confirm `npm --prefix apps/nebula run
  dev` reaches `Ready on` — that's the reference boot.
- **Browser login flakes on the email leg** (real CF email loop, variable latency) — a `No email
  received` timeout is that flake, not a defect; re-run.

## Add a scenario

Add `apps/nebula/harness/scenarios/<name>.ts` exporting `async run(stack)`, register it in `drive.ts`'s
`SCENARIOS` map, and drive via the `NebulaClient` public surface only (`resources.*`/`subscribe`/
`callAsync`) — never raw RPC (`.claude/rules/mesh.md`). For a capture scenario, snapshot the transient
state (before the reload/transition), not just the end. Full layout: `apps/nebula/harness/README.md`.
