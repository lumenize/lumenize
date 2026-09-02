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

**Requires Docker Desktop** — the apps/nebula build-box image builds at `wrangler dev` boot (a cold
build takes a few minutes). The harness probes `docker info` and exits non-zero if it's absent.
It reads the signing key from the repo-root `.dev.vars` (symlinked into `apps/nebula`); no prod
creds needed for local (`--local` drops the remote AI / send_email bindings).

## Identity — a REAL email login by default

⚠️ **`connectDriver` logs in for real (ADR-009 rung 1).** The synthetic mint below is an explicit,
justified opt-in, not the normal path — this harness is the artifact ADR-009 names as *"the path
design reasoning grounds on"*, so running it on a constructed identity is the exact mis-grounding
the ADR was written about.

**Which helper gives which claim — the map, because it is NOT guessable from the names and getting
it wrong costs a scenario run.** All live in `apps/nebula/test/lib/email-login.ts`:

| Helper | `authScope` you get | Use it when |
|---|---|---|
| `provisionAndLogin({ scope })` | **the UNIVERSE**, always — even when `scope` is a Galaxy or Star | you want a covering admin, or you just need the scope tree to exist |
| `provisionStarAdmin({ scope })` | **the STAR itself** (exact) | you need a member whose own scope IS a Star — a genuine tenant |
| `loginViaEmail({ authScope })` | that scope | an identity already exists there |
| `refreshAccessToken(origin, session, activeScope)` | unchanged; only `aud` moves | switching active scope on one session |

🚨 **`provisionAndLogin` CLIMBS — it claims the universe, logs in there, then creates the galaxy/star
beneath with that admin's token and re-issues at `scope`.** So it can never hand you a non-covering
principal, and `connectDriver(stack, { scope: someStar })` gives you a *universe* admin whose `aud`
is that Star. If your scenario is about a refusal, that is the wrong identity and it will pass for
the wrong reason.

⚠️ **`provisionStarAdmin` is not idempotent across identities**: it provisions the universe above as
`owner-${email}`, so calling it twice with *different* emails fails on the second — the universe is
already claimed and there is no identity for the new `owner-` address. Provision the tree once, then
create siblings with the owner's token.

**The one escape hatch on `connectDriver` — `session: { accessToken, sub }`** — builds the client
from a token you already obtained by a real path. Still rung 1 (the server minted the claim); it
exists because the default path always climbs from the universe, so it cannot produce a Star-scoped
member (`provisionStarAdmin`) or a genuine NON-admin (`acceptInviteAndLogin` on a real invite, then
`refreshAccessToken` — `downward-dominion.ts` is the model, and the extra email loop costs about a
second).

⚠️ **There is no `mint` entry, and there is not going to be one.** A rung-3 `mint: { reason, … }`
option existed until 2026-09-02 and was deleted when its last two callers proved constructible by
real paths — one of them under a `reason` that was simply stale. A synthetic identity in this harness
is a fixture that happens to be a function (`live.md` § *A `/live` scenario MUST NOT compensate for
its environment*), and `/live` is the tier whose whole value is having no fixture to build wrong.

**`bootVars`** (exported from a scenario, read by `drive.ts`) sets `--var NAME:VALUE` for that boot
only — never a `.dev.vars` mutation. `superuser-end-to-end` uses it to point
`NEBULA_AUTH_BOOTSTRAP_EMAIL` at the `*@lumenize.io` catch-all, because the real value is a human
mailbox no automated run can read; that is what keeps its bootstrap login a genuine round trip.

**The only tokens this harness signs itself are the WRONG ones.** `mintDegradedToken` (rung 4,
ADR-009) signs deliberately-degraded tokens with the `.dev.vars` key — the base flat-`isAdmin` mesh
shape, and a nebula-issuer token with no `access` claim — and `assertTokenRejected` proves the
gateway refuses each. They are negative controls, never a login, and never reach `connectDriver`.
**Local only** — nothing deployed ever sees a harness-signed token.

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
`--local` + the container makes apps/nebula **hang after the image build** (workerd up, never
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
