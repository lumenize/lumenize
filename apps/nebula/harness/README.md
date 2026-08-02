# Live self-verification harness

Drive and inspect a **running** Nebula (local `wrangler dev`) as an authenticated identity, so a
UI/behavior change can be verified against a live system before it's reported done — the gap that
let the chat-history and preview-cold-boot bugs ship green. Task: `tasks/archive/claude-live-verification.md`.

This is **exploration, distinct from the vitest suites** (`.claude/rules/testing.md` owns those). It
boots the real stack and asserts against it; it is not a replacement for unit/integration tests.

## Run

```sh
# From the repo root. Boots a fresh local wrangler dev, runs a scenario, tears down,
# and exits non-zero if any step fails.
npx tsx apps/nebula/harness/drive.ts                    # default scenario: message-roundtrip
npx tsx apps/nebula/harness/drive.ts message-roundtrip
HARNESS_DEBUG=1 npx tsx apps/nebula/harness/drive.ts    # stream wrangler-dev stdio
```

**Requires Docker Desktop** — the apps/nebula DevContainer builds at `wrangler dev` boot (a cold
build takes a few minutes). The harness probes `docker info` and exits non-zero if it's absent.
It reads the signing key from the repo-root `.dev.vars` (symlinked into `apps/nebula`); no prod
creds needed for local (`--local` drops the remote AI / send_email bindings).

## Identity — local mint, no email

`createNebulaTestToken` (`@lumenize/nebula-auth/testing`) mints a **correct-shape** Nebula admin
token for a sandbox scope, signed with the `.dev.vars` key — reusing nebula-auth's shared
`buildNebulaJwtPayload` claim-builder, so the token is byte-for-byte what a scope admin's server mint
produces (`access: { authScopePattern, admin }`), NOT the base flat-`isAdmin` mesh shape (which the
gateway rejects). No magic-link loop. **Local only** — prod tokens come via audited login /
stored-refresh, never this mint.

## Layout

- `lib/harness.ts` — reusable core: `bootDevStack`, `connectDriver` (real-WS `NebulaClient`),
  `mintDegradedToken` + `assertTokenRejected` (negative controls), `readDevVar`, `HAS_DOCKER`.
- `scenarios/*.ts` — one file per scenario; each exports `run(stack)` (asserts, doesn't print).
- `drive.ts` — Bash entry point / scenario dispatcher.
- `tsconfig.json` — standalone (plain-Node + Workers types); wired into `scripts/type-check.sh`.

## Boot mode — NO `--local` (uses your wrangler OAuth session)

`bootDevStack` boots exactly like `npm run dev` — plain `wrangler dev`, no `--local`. It relies on
your `wrangler login` OAuth session for the remote `AI` / `send_email` bindings (Phase-1 driving
uses neither; the AI binding being remote only incurs charges if a codegen scenario calls it).

⚠️ **Do NOT pass `--local`.** An earlier auto-detect (`--local` when `CLOUDFLARE_API_TOKEN` was
absent from `process.env`) was wrong locally — a `wrangler login` session isn't a token env var — and
`--local` + the DevContainer makes apps/nebula **hang after the image build** (workerd up, never
ready, no `Ready on`). `HARNESS_LOCAL=1` opts back into `--local` for a no-OAuth environment, but the
container-hang means the full stack can't yet boot that way (same path the ui-smoke lane's
`hostedLocalBoot` uses — flagged as product feedback).

If a boot hangs anyway:
- `pkill -9 -f workerd` (a stuck-mid-boot wrangler doesn't propagate SIGINT to its workerd child).
- `rm -rf apps/nebula/.wrangler` (stale/locked state from a killed boot; the Docker image cache is
  separate, so this doesn't force an image rebuild), then retry.
- Confirm `npm --prefix apps/nebula run dev` reaches `Ready on` — that's the reference boot.

## Add a scenario

Add `scenarios/<name>.ts` exporting `async run(stack: DevStack)`, register it in `drive.ts`'s
`SCENARIOS` map, and drive via `client.resources.*` / `client.orgTree.*` / `subscribe` — the public
mesh **client** surface only (never raw stub RPC / DO-internal access; `callAsync` is the sole
awaitable). If you need a surface the client lacks, that's mesh/nebula product feedback to surface —
not a reason to drop to raw RPC.
