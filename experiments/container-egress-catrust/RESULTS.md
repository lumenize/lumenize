# Container egress + CA-trust — RESULTS (2026-06-19)

**Question:** Phase 3 (`tasks/nebula-container-dev-loop.md`) proved `enableInternet=false` blocks all egress, but **deferred** opening an *allow-listed HTTPS host*: `interceptHttps` MITMs the connection, so the in-container TLS client must trust the interceptor's CA — node/git/curl don't by default → cert error. Does the documented CA-trust recipe (copy the ephemeral `/etc/cloudflare/certs/cloudflare-containers-ca.crt` + `update-ca-certificates`) make an allow-listed HTTPS host reachable by a **real git/curl client** — and does any of it engage under **local `wrangler dev` on Docker Desktop**? Stand-in host = `github.com`; the real target is `*.artifacts.cloudflare.net` (same mechanism).

**Verdict: YES — fully resolved, locally.** The Phase-3 deferred CA-trust egress blocker is closed.

## Setup
`LumenizeContainer` subclass (`enableInternet=false` pinned by the base) + `allowedHosts=['github.com']` + `interceptHttps=true` + `export { ContainerProxy }`. Image `node:22-slim` (Debian bookworm, git 2.39.5, curl, ca-certificates). `@cloudflare/containers` 0.3.7, wrangler 4.86. Run: `docker context use desktop-linux` (Docker Desktop running), `npx wrangler dev`. Probes driven via `containerFetch` → an in-container command-server (`/exec`). The CA is installed at **runtime** (it's ephemeral — not bakeable), mirroring what a production entrypoint would do.

## Results (`/probe` + `/blocktest`)

| Step | Command | Result |
|---|---|---|
| CA present? | `ls /etc/cloudflare/certs/` | ✅ `cloudflare-containers-ca.crt` (644 B) **present under local wrangler dev** — interception engages locally |
| allow-listed, **before** CA | `curl https://github.com` | ❌ `SSL certificate problem: self-signed certificate in chain` (exit 60) — **reproduces the Phase-3 failure** |
| install CA | `cp … && update-ca-certificates` | ✅ done, ~7.3 s (one-time per container boot) |
| allow-listed, **after** CA | `curl https://github.com` | ✅ **HTTP 200** |
| **real target** | `git clone --depth 1 https://github.com/octocat/Hello-World.git` | ✅ **`clone_exit=0`**, README pulled (~0.4 s) |
| non-allow-listed, CA trusted | `curl https://example.com` | ✅ **HTTP 520 — BLOCKED** (deny-by-default holds; with TLS no longer the failure point, the block surfaces at the egress layer, not as a cert error) |

## Conclusions

1. **The CA-trust recipe works.** Copy `/etc/cloudflare/certs/cloudflare-containers-ca.crt` into the trust store + `update-ca-certificates` → a real git/curl client transits the `interceptHttps` MITM to an allow-listed HTTPS host. `git clone` over HTTPS succeeds.
2. **Secure-by-default still holds.** A non-allow-listed host is blocked (HTTP 520) even with the CA trusted — the allow-list is the gate; CA-trust only removes the TLS-layer false-failure on the *allowed* host.
3. **All of it runs under LOCAL `wrangler dev` on Docker Desktop** — the ephemeral CA is injected locally and interception is active, so the egress dev loop needs no deploy. (Corrects the prior "egress is deploy-only" assumption.)
4. **Production form:** the CA copy must live in the container **entrypoint** (runtime), since the CA is ephemeral and cannot be baked into the image. A 3-line entrypoint (`cp … && update-ca-certificates && exec <main>`) is all the real DevContainer image needs.

## Stage A — Artifacts binding under local wrangler dev (2026-06-19)

Tried to do the *real* Artifacts pull locally (the motivation: "Artifacts runs in wrangler dev"). Added `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "default" }]` and an `/artifacts-info` route (`env.ARTIFACTS.create()`).

**Finding: there is NO working local Artifacts simulator on current tooling — the binding is remote-only and beta-gated.**
- On wrangler **4.86** the binding mode prints `env.ARTIFACTS (default) Artifacts **remote**` (vs the DO's `local`), wrangler "Establishes remote connection," and the call fails: **`You do not have access to use Artifacts … [code: 10015]`**.
- Upgraded test on wrangler **4.103** (via `npx wrangler@4.103.0`): same — `env.ARTIFACTS` still **`remote`** mode.
- The docs imply a local mode (the `remote = true` opt-in note → default local), but it did not engage on either version. Possibly behind an experimental flag or a newer/unreleased wrangler — unconfirmed.

**Consequence:** the Artifacts end-to-end (binding push AND container pull) is gated on **beta access**, even in `wrangler dev`. "Runs in wrangler dev" = proxies to the remote service from wrangler dev, not a local sim. The `artifacts` binding is left **commented out** in `wrangler.jsonc` so this experiment's egress half stays runnable; re-enable once beta access is granted.

## Next (not this experiment)
- **Artifacts-specific pull (BLOCKED on beta access):** re-enable the `artifacts` binding, then swap host → a real `*.artifacts.cloudflare.net` repo + a DevStudio-minted **read** token (`git clone https://x:${TOKEN}@…`). Same egress mechanism as proven above. Form: https://forms.gle/DwBoPRa3CWQ8ajFp7 (submitted 2026-06-19, awaiting access).
- Distinct from the agent-app **runtime** egress (`globalOutbound`→`EgressBroker`, the outside-world task) — that's a separate, broader allow-list.

## Teardown
Throwaway. Remove `experiments/container-egress-catrust` from root `package.json` `workspaces` and `git rm -r` once these findings are folded into `tasks/nebula-dev-flows.md` (done) + the Phase-3 egress note in `tasks/nebula-container-dev-loop.md`.
