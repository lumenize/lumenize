# Nebula — DevContainer wakeup-after-hibernation recovery (DIAGNOSIS)

**Status**: **✅ COMPLETE / ARCHIVED (2026-07-01) — frozen research record; do not edit.** Diagnosis delivered: Findings Q1–Q5 (below) + the `cf-container-stuck-flag-cloud` memory. Conclusion: **(b)-dominant** — the CF stale-`running` flag, a lifecycle problem, NOT a comms/delivery one (so orthogonal to the mesh work; `callDurable` does not help). Recommendation = **option #1 (`ctx.abort()` on stuck-detect)**, whose lever the **Phase 0 spike confirmed** on real CF. Implementation → **[../nebula-container-wakeup-fix.md](../nebula-container-wakeup-fix.md)**. Newer empirical findings (the deploy-stale self-heal + the abort-mechanic confirmation) live in that fix file's Phase 0 RESULTS + the memory, NOT here.

<sub>_Original kickoff status (for the record): DIAGNOSIS / RESEARCH — READ-ONLY, run in a fresh session parallel to the mesh design work, no source edits (only this findings doc + a memory + an optional fix task file). All satisfied._</sub>

> **Why read-only + why now:** the container-wakeup path touches the same `apps/nebula` DevStudio/DevContainer comms code the mesh work will migrate (`ensureUp` calls `callRaw` to `DEV_CONTAINER`), so a *concurrent fix* would collide with the mesh migration (the exact merge conflict the sequential rule forbids). A **diagnosis** conflicts with nothing and de-risks both: it tells the mesh review whether `callDurable` must cover container wakeup, and tees up the fix to land sequentially.

---

## Problem

After a DevContainer **hibernates** (idle → slept; `sleepAfter = '5m'`, [dev-container.ts:169](../apps/nebula/src/dev-container.ts:169)), **waking it again fails** — the Studio UI is broken on this path. A recovery mechanism *already exists* but is insufficient; the diagnosis is to pin **why the existing recovery still fails** and **what the true remaining failure mode is**, so the fix targets the real cause (not a symptom).

## What already exists (read these first — the recovery is partly built)

- **`DevContainer.ensureUp`** ([dev-container.ts:209-218+](../apps/nebula/src/dev-container.ts:209)) — the liveness probe + stuck-container recovery. A slept container can leave a **stale `this.container.running` flag** that the base proxy can't restart past (`start()`/`startAndWaitForPorts()` fast-path on the flag → "not running" forever — the **2026-06-27 stuck state**). On a failed probe it **force-restarts**: `destroy()` (SIGKILL, unconditional — unlike `stop()` which guards on `running`) resets the flag → the re-probe's `containerFetch` sees `running=false` and auto-starts fresh. **ONE retry only.**
- **`isRetryableContainerError`** ([dev-container.ts:113-122](../apps/nebula/src/dev-container.ts:113)) — matches the runtime/base phrases a stuck/booting container returns (`not running` / `proxying request to container` / `Failed to start container` / `suddenly disconnected` / `provisioning`).
- **The interstitial** ([dev-container.ts:135-143](../apps/nebula/src/dev-container.ts:135)) — served when the container proxy fails; note the comment: **"eviction is precisely what clears a stale `running` flag. Auto-reload therefore *prevents* recovery"** (a reload storm keeps traffic flowing, so the container never idle-evicts → never clears). "A stuck container self-recovers once traffic stops (≤ `sleepAfter`)."
- **`DevStudio.ensureUp`** ([dev-studio.ts:318-323](../apps/nebula/src/dev-studio.ts:318)) — `this.lmz.callRaw(DEV_CONTAINER_BINDING, instance, this.ctn<DevContainer>().ensureUp())` then `applyChanges`. This is a **`callRaw`** site (relevant to the mesh migration).
- **Preview GET path** ([entrypoint.ts:125-149](../apps/nebula/src/entrypoint.ts:125)) — `DEV_CONTAINER` is the only direct-DO-serve target; GET/HEAD reaches `DevContainer.fetch()` (the vite shell + HMR). The preview GET path **can't self-recover** + triggers a **vite reconnect storm** (see the memory below).

## Known context (memories — confirm still accurate, don't trust blindly)

- **`cf-container-stuck-flag-cloud`** — CF container stuck "not running" in cloud is **deploy-staled**; `destroy()`/retry does **NOT** clear it (only idle-evict, ~minutes, does); the preview GET path can't self-recover + a vite reconnect storm keeps it alive. Live-confirmed 2026-06-28. **This is the crux to re-verify.** (If `destroy()` genuinely doesn't clear the flag in the cloud, `ensureUp`'s force-restart is a no-op there — that would be the finding.)
- **`lumenize-container-local-dev`** — CF Containers run under local `wrangler dev` on Docker Desktop (NOT Colima); deployed+WARP is the fallback. So the wakeup path **is** reproducible under local `wrangler dev` + Docker.
- **`test-container-changes-with-wrangler-dev`** — container/preview behavior verifies under `wrangler dev` + Docker; can't *construct* `extends Container` in pool-workers but it *runs* under wrangler dev.
- **`cf-container-deploy-proxy`**, **`preview-path-prefix-vite-base`**, **`agent-channel-container-exec`** — adjacent container facts.

## The questions to answer (the deliverable)

1. **What actually fails on wake?** Split the failure into:
   - **(a) the call/proxy not landing** — `ensureUp`'s `callRaw`, or the `containerFetch` proxy, times out / errors reaching a slept container → **mesh-`callDurable` territory** (reliable wake + guaranteed delivery + bounded retry). Feeds the mesh review.
   - **(b) the CF stuck-`running`-flag** — the container is "up" per CF but the flag is stale and `destroy()` doesn't clear it in the cloud → **CF-lifecycle, no clean code fix** (idle-evict is the only clear; the fix is a workaround: stop traffic, or a CF-level mechanism, or wait for a CF binding/API that force-resets).
   - Likely it's a mix — quantify which dominates, locally vs deployed.
2. **Why does the existing `ensureUp` force-restart (`destroy()` + ONE re-probe) not recover it?** Is `destroy()` a no-op on a cloud-stuck flag (per the memory)? Is one retry too few? Does the re-probe race boot?
3. **Does the reload/reconnect storm actively prevent recovery** (traffic keeps the container from idle-evicting → the one thing that clears the flag)? If so, the fix may be *client-side* (stop auto-reloading on the interstitial) more than server-side.
4. **Local `wrangler dev` vs deployed cloud** — does the failure reproduce locally, or is it cloud-only (deploy-staled)? This bounds whether a code fix is even testable pre-deploy.
5. **Recommendation + fix options**, ranked, each tagged **(a) comms/`callDurable`** vs **(b) CF-lifecycle workaround** vs **(c) client-side (reload discipline)** — so the follow-up fix task can pick and land sequentially.

## Method (read-only)
- Trace the wake path end-to-end from the anchors above; read `@cloudflare/containers`' `Container` base (`start`/`stop`/`destroy`/`startAndWaitForPorts`/the `running` flag/`sleepAfter`) to confirm the fast-path-on-flag behavior.
- Reproduce under **local `wrangler dev` + Docker** ([[docker-available-locally]]): bring a DevContainer up, force it to sleep (idle past `sleepAfter`, or stop the Docker container to simulate), then hit `ensureUp`/the preview GET and observe whether recovery fires and where it stalls. **Observe only** — no code edits; if a probe needs a temporary marker, note it in findings rather than committing it.
- Distinguish local (Docker) behavior from the documented cloud stuck-flag — the cloud case may not reproduce locally (deploy-staled).

## Coordination with the mesh work
- If the finding is **(a)-dominant** (the wake *call* is the unreliable part), that's direct input to [mesh-continuation-only-calls](mesh-continuation-only-calls.md) — `callDurable` (guaranteed-eventually + bounded retry, off-by-default, never-for-overload) should list "wake + reach a hibernated container" as a motivating case. Flag it there.
- If **(b)-dominant** (CF stuck flag), it's orthogonal to the mesh work → its own fix task, and `callDurable` won't help.
- The **fix lands sequentially** (not in this task): after the mesh primitive exists if it's (a), or as a contained interim if it's (b)/(c) and genuinely urgent. Do not write the fix while the mesh migration is in flight over the same `callRaw`/DevStudio surface.

## Deliverables
1. A **Findings** section appended to this file (the answers to Q1–Q5 + repro notes: what worked, what didn't).
2. A **reference memory** capturing the confirmed failure mode (update/supersede `cf-container-stuck-flag-cloud` if the 2026-06-28 finding has drifted).
3. (Optional) a **follow-up fix task file** with the chosen option, sequenced per § Coordination.

---

# FINDINGS (2026-07-01, read-only diagnosis — no source edits)

## TL;DR
The wake failure is **(b)-dominant: the CF stale-`running`-flag, a cloud-lifecycle problem with no clean code fix via `destroy()`.** It is **orthogonal to the mesh continuation-only work — `callDurable` will NOT help** (the wake *call* lands fine; the DO→container *proxy* is what won't restart). The 2026-06-28 `cf-container-stuck-flag-cloud` memory **holds and is now mechanism-confirmed**, not drifted. I reproduced the *mechanism* locally (see below) even though the cloud *trigger* (deploy-stale) has no local analog: a `docker pause`d container (frozen, but `running=true`) hangs every proxy and **never** self-restarts, and the instant you flip `running`→false (genuine termination) it boots clean. That single fact is the whole diagnosis.

## What I did
- **Read-only trace** of the full wake path: `DevStudio.ensureUp/warmPreview/chat` → `callRaw(DEV_CONTAINER)` → `DevContainer.ensureUp/#cmdJson/fetch` → `NebulaContainer`/`LumenizeContainer` composition → the `@cloudflare/containers` `Container` base (`containerFetch`/`startContainerIfNotRunning`/`startAndWaitForPorts`/`stop`/`destroy`/`renewActivityTimeout`/`alarm`), plus the preview GET path (`entrypoint.ts`) and the client reload path (`nebula-studio-ui/src/App.vue`, `nebula-client.ts`).
- **Live local repro** under `wrangler dev` + Docker Desktop, using `experiments/container-node-phase0` (a real-stack `LumenizeContainer` = vite:5173 + command-server:9000 + mesh — the same base mechanics `DevContainer` rides). No product source touched; `git status` clean but for task files. wrangler/workerd + all containers torn down after.

## The mechanism (the crux, confirmed by reading `@cloudflare/containers` `dist/lib/container.js`)
Two fast-paths gate on `this.container.running`, and **nothing in the base flips that flag except the runtime's own observation of the instance actually going away**:
- `containerFetch()` (base): starts only if `!this.container.running || state.status !== 'healthy'`; otherwise it proxies straight to `tcpPort.fetch()`.
- `startContainerIfNotRunning()` (base): **`if (this.container.running) return 0`** — a fast-path that returns *without starting* and **does not even check `state.status`**. So when `running` is stale-`true` but the instance is dead/frozen, the DO **refuses to launch a replacement**; `waitForPort`/the proxy then fails (fast 500 if the instance is *gone*; a hang up to the port timeouts if it's *frozen*).
- `stop()` guards on `if (this.container.running)`; `destroy()` calls `this.container.destroy()` — **neither writes a local flag**. Recovery depends entirely on the runtime setting `running=false`.
- **Vicious cycle (Q3):** every `containerFetch` attempt calls `renewActivityTimeout()` and `inflightRequests++`, and `isActivityExpired()` returns false while either is active. So *continuous traffic keeps the DO/container from idle-evicting* — and in the cloud, **idle-evict is the only thing that clears the stale flag**. Retrying a stuck preview actively *prevents* its own recovery.

## Local reproduction log (decisive)
| Simulated fault | `docker` state | Re-probe result | Fresh container? |
|---|---|---|---|
| baseline boot (`/cmd`) | — | 200, ~2.3 s cold | yes |
| `docker kill` (SIGKILL, abrupt loss) | gone | **200, ~1.4 s — self-heals** | yes (new id) |
| `docker stop` (SIGTERM = idle-sleep signal) | gone | **200, ~1.4 s — self-heals** | yes (new id) |
| kill → **preview GET `/`** (the "can't self-recover" path) | gone | **200, ~2.6 s — self-heals** | yes (new id) |
| kill → 5× concurrent burst | gone | **all 200, one** container (start coalescing works) | 1 |
| **`docker pause` (frozen, `running=true`)** | `paused running=true` | **HTTP 000, hung full 25 s — twice; NO restart** | **no** |
| pause → external `kill` (flip `running`→false) | gone | **200, ~1.3 s — self-heals** | yes (new id) |

**Reading:** any fault where the runtime *sees the instance leave* (`running`→false) self-heals on the very next call — locally the base `containerFetch` recovery is robust, so `DevContainer.ensureUp`'s extra `destroy()`+re-probe is never even exercised. The **only** way to get stuck locally is to keep `running=true` while the port is dead (`docker pause`) — and that is a faithful analog of the cloud stale flag: stuck, no restart, until the flag flips.

## Answers to Q1–Q5

**Q1 — What actually fails on wake? (a) call/proxy-not-landing vs (b) stuck flag.** **(b) dominates; there is effectively no (a).** The wake *call* always reaches the DO (client→DevStudio is fire-and-forget + direct-delivery already; DevStudio→DevContainer is a reliable DO→DO `callRaw`; the preview GET reaches `DevContainer.fetch` directly). What fails is the **DO→container proxy**: with a stale `running=true` the DO won't start a replacement. So guaranteed delivery / reliable wake buys nothing — the message isn't lost, the container just won't come back. Locally (a) is *not observed at all* (every landed call self-heals).

**Q2 — Why doesn't `ensureUp`'s `destroy()`+ONE-re-probe recover it?** Because in the deploy-staled cloud case **`destroy()` does not flip `running`→false** (2026-06-28: the same dead container id `af6e167d…` persisted across many `ensureUp` attempts, no fresh instance). The re-probe therefore hits the same `startContainerIfNotRunning` fast-path (`running` still `true` → returns without starting) and fails again. One retry isn't "too few" — **no number of same-DO-lifetime retries helps**, since only DO idle-eviction clears it. (Secondary, unverified: even a *working* `destroy()` may not flip the flag *synchronously within the one `ensureUp` invocation* — the runtime updates `running` via the monitor callback, so an immediate re-probe could still read stale `true`. The primary cause stands regardless.) The local pause→kill row proves the corollary: **the moment the instance is truly terminated, recovery is immediate** — so the fix is "make the flag actually flip," which `destroy()` doesn't guarantee.

**Q3 — Does the reload/reconnect storm prevent recovery?** **Yes, mechanically** — every proxy attempt renews the activity timeout, and idle-evict is the only cloud clear; sustained traffic ⇒ no evict ⇒ flag never clears. Current mitigations are *partial*: the top-nav interstitial (`wakingPreviewPage`) is already **manual-reload, no auto-refresh** (the 2026-06-27 regression is fixed + guarded by a test), and the client reload is **event-driven** (chat-done / preview-ready / wipe / >4 m-absence return), not a loop. **Still open:** the 2026-06-28 memory saw a *vite HMR reconnect storm from inside the preview iframe* despite `hmr:false` under the preview prefix (`apps/nebula/container/app/vite.config.ts:35`) — that `hmr:false` *should* silence it, so either it isn't taking effect in the built image or the storm is browser-level retry. **Not reproducible locally with curl (no browser/vite client); needs a cloud/browser re-verification.** This makes reload-discipline a *supporting* fix (option c), not the root fix.

**Q4 — Local `wrangler dev` vs deployed cloud?** **The stuck flag is cloud-only; it does not reproduce locally by killing/stopping the container** (local workerd correctly flips `running`→false, so the base self-heals). The cloud trigger — a new image deploy staling the warm instance under a possibly-hibernating DO — has **no local analog** (`[r]` restarts workerd entirely = fresh DO). **⇒ A stuck-flag code fix cannot be validated on the local dev loop; it must be verified deployed** ([[feedback_test_container_changes_with_wrangler_dev]] still applies, but note the escalation: this is a *deploy-to-Cloudflare* verification, not a `wrangler dev` one). `docker pause` is the closest local proxy for exercising the *mechanism* (not the trigger), and it's useful for testing a candidate fix's restart logic in isolation.

**Q5 — Recommendation + ranked fix options** (all tagged; the fix lands **sequentially**, not in this task):
1. **(b) Force a genuinely fresh instance by making `running` flip — likely `ctx.abort()` on stuck-detection.** The base itself aborts the DO on "Network connection lost" (`container.js` ~L1416) precisely to "reconnect from scratch." Aborting the DevContainer DO on a detected stuck proxy tears it down → reconstruct → `ctx.container.running` re-reads reality → clean boot, *without* waiting minutes for idle-evict. **This is the most promising root fix.** ⚠️ Must be verified *deployed* against a real deploy-staled instance (Q4); confirm abort actually clears what `destroy()` couldn't. Detection = a cold proxy response (`isContainerColdResponse` already classifies the bodies) or a bounded `ensureUp` timeout.
2. **(c) Reload discipline — stop hammering so idle-evict can fire.** Verify `hmr:false` truly silences the iframe vite reconnect storm in the built image (Q3), and ensure no path re-fires `warmPreview` in a loop. Partial mitigation (users still wait ~minutes), but cheap and it removes the recovery-blocking traffic. Pairs with #1.
3. **(b) Deploy-time drain/recycle of DevContainer instances.** The trigger is *deploy*; proactively evict/teardown warm DevContainers at deploy so the next use cold-boots clean. Note `NebulaContainer.teardown` uses `destroy()` — which is exactly what doesn't flip the flag — so this only helps if paired with DO abort/reconstruction (#1's mechanism). Lower priority; more moving parts.
4. **(b) External dependency:** adopt a CF-provided force-reset API/binding if/when one ships. Not actionable now; track.

**Not recommended:** anything framed as improving wake-call *delivery* (retry/`callDurable`/two-one-way) — it targets a failure mode that isn't happening here.

## Coordination with the mesh work (input for [mesh-continuation-only-calls](mesh-continuation-only-calls.md))
**Finding is (b)-dominant ⇒ per this file's § Coordination, container-wake is ORTHOGONAL to the mesh migration.** **Do NOT list "wake + reach a hibernated container" as a `callDurable` motivating case** — the wake call already lands reliably; `callDurable` (guaranteed-eventual + bounded retry) does not address a container that won't restart. The mesh migration can treat the `DevStudio.ensureUp`/`warmPreview`/`chat` → `callRaw(DEV_CONTAINER, …ensureUp())` sites as ordinary reliable DO→DO hops. One mild adjacent note (not a `callDurable` case): against a *stuck* container, `DevContainer.ensureUp` can burn ~40–56 s of DO wall-clock (healthz timeout ~20–28 s + `destroy()` + re-probe ~20–28 s) before returning — a fix (#1) that fails fast + aborts also shrinks that stall.

## Repro assets (disposable)
- Harness: `experiments/container-node-phase0` (already a workspace; `npx wrangler dev` from that dir builds the image on Docker Desktop).
- Fault injection used: `docker kill` / `docker stop` (self-heals) and **`docker pause`** (reproduces the stuck flag) on the `workerd-…-SmokeContainer-…` container.
- No follow-up *fix* task file created (deliverable #3 is optional; fix lands sequentially after the mesh work per § Coordination — recommend option #1). Spin one up when ready to build.
