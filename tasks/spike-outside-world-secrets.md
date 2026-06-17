# Spike: Outside-World Secrets Vault

**Status**: Active — exploratory; the first of three substrate spikes for `tasks/nebula-outside-world.md`. Not for hand-review (the approach will deviate as we learn). Stage 1 kicked off 2026-06-17.

**Context**: Nebula apps talk to the outside world by writing server-side code (an `onRequest` handler + `fetch`) that runs in a **DO facet** the parent DO hands a custom `env`. Those calls need credentials (Resend key, Stripe key, …) the browser must never see. This spike de-risks the **secrets layer**: a two-level encrypted vault + a 3-mode resolver exposed to facet code as `env.secrets.resolve(name)` (model **b** — D1 in the umbrella). Resources are explicitly rejected as a secret store (they sync to the browser).

## Goal

Prove that a secret can be:
1. stored **encrypted at rest** at two levels (Galaxy + Star),
2. resolved by a **configurable, Galaxy-governed mode** — `galaxy-only` / `star-only` / `star-then-galaxy`,
3. handed to **facet-run code** as plaintext,
4. **never** present in any client-facing channel (no Resource, no `onRequest` SPA output, no sync payload).

## Design (will evolve)

**Storage.** Galaxy already has a `config` KV + `@mesh(requireAdmin) setGalaxyConfig(key, value)` (`apps/nebula/src/galaxy.ts:87-97`) — the Galaxy-level vault and the **mode governance setting** live here (e.g. `secret:resend` = sealed blob; `secretMode:resend` = `'star-then-galaxy'`). The Star-level vault is the analogous Star KV. Both are server-only; neither is a Resource.

**Crypto.** AES-256-GCM via `crypto.subtle` (the established path — `packages/auth/src/jwt.ts` uses `crypto.subtle` for Ed25519). At-rest blob = `base64url(iv ‖ ciphertext)`, random 12-byte IV per seal. The 32-byte key is a **Workers Secret** (`NEBULA_SECRETS_KEY`) — root `.dev.vars` (auto-symlinked) + vitest `miniflare.bindings` for tests, never committed, never in `wrangler.jsonc`. Per-tenant key derivation (HKDF keyed by scope) is a hardening follow-up, not v1.

**Resolution.** `resolveSecret(name, mode, key, { star, galaxy })` walks the levels per the mode and returns plaintext (or `undefined` if the configured source is empty). The mode is read from Galaxy config; the Star admin can only *populate* the Star level, never change whether it's consulted.

**Injection (facet).** The parent DO (Star) resolves the secret server-side and hands it to facet code via the custom `env` — proven mechanism is `env: { … }` on `loader.get()` (`experiments/dwl-spike` Test 4). Pre-injecting the app's declared secrets at facet load (vs a lazy `env.secrets.resolve` callback that reenters the DO) sidesteps the input-gate/reentrancy concern for *secrets* specifically; lazy-resolve is the alternative if pre-inject proves too coarse. **This is Stage 2's open question, not settled.**

## Stages

### Stage 1 — crypto + 3-mode resolver ✅ DONE 2026-06-17
Pure, portable, mutation-checkable. Runs in the `unit` pool-workers project (real workerd — faithful for `crypto.subtle`). No DO, no facet yet. 9 tests green, stable across 5 consecutive runs.

**Code**: `apps/nebula/test/spike-secrets-vault/vault.ts` + `vault.test.ts`.

**Success criteria**:
- [x] `seal`→`open` round-trips a secret; wrong key throws (GCM auth tag); tampered blob throws; fresh IV per seal.
- [x] Resolver returns the right level per **each** mode, mirroring the source case-fan-out: `galaxy-only` (ignores star), `star-only` (ignores galaxy), `star-then-galaxy` present→star, `star-then-galaxy` absent→galaxy fallback, configured-source-empty→`undefined`.
- [x] Mutation-checked: mutating `star-only`→galaxy and `star-then-galaxy`→galaxy-first both flipped the matching assertions red; restored to green.

**Finding (test fidelity):** tampering the *last* base64url char is flaky — its trailing bits can be "don't care" and decode unchanged, so the tamper is a no-op and `openSecret` succeeds. Flip an **interior** (full-byte) char instead. Surfaced by a 1-in-N restore run going red; deterministic after the fix.

### Stage 2 — facet env injection ✅ DONE 2026-06-17
A minimal capability-broker DO (`SecretBrokerDO`, plain `DurableObject`) seals secrets at two mock levels, resolves one per mode (reusing the Stage-1 vault), loads a throwaway `SecretEcho` facet via the Worker Loader injecting **only** the resolved plaintext as `env.RESOLVED_SECRET`, and the facet self-reports. 4 tests green, stable across 3 runs.

**Code**: `apps/nebula/test/test-apps/secrets-facet/` (own wrangler with the `LOADER` binding + `SecretBrokerDO`; new `secrets-facet` vitest project; `NEBULA_SECRETS_KEY` = test 32-byte AES key in `miniflare.bindings`, never in wrangler vars).

**Success criteria**:
- [x] Facet code reads the injected secret (SHA-256 of the received value matches an independently-computed digest of the seeded plaintext — proves it got the *right* value, mutation-checked).
- [x] The facet has **no ambient path** to the raw `NEBULA_SECRETS_KEY` — its entire `env` is `['RESOLVED_SECRET']`; `masterKeyVisible` is false. Mutation-checked: leaking the key into the facet env flips both isolation assertions red.
- [x] No plaintext at rest — the broker persists only sealed blobs; `dumpStorage()` never contains the plaintext.

**Findings:**
- Worker-Loader `env` injection (dwl-spike Test 4) works under vitest-pool-workers, and the facet's `env` is **exactly** what's injected — nothing ambient leaks in (not `LOADER`, not the parent's bindings). This is the structural isolation D2 relies on.
- Used **pre-inject** (resolve in the parent, inject plaintext at facet cold-load). The unique-`bundleId`-per-call is load-bearing: the injected env is captured at cold load, so reusing an id would pin the first injection (loader caches by `bundleId` per-Worker).

**Deliberately deferred to Stage 3 (not proven here):**
- The **reentrancy / input-gate** question. This harness's facet never calls *back* into the parent (pure pre-inject), so it doesn't exercise `env.data`/`env.fetch` callbacks. That characterization rides the **outbound** spike (`env.fetch`) and Stage 3 (real `env.data`).
- The full **no-leak-via-client-surface** claim. No Star/Resource here, so only "no plaintext at rest in the broker KV" is shown. The `Star.onRequest` body / Resource-read no-leak assertion lands in Stage 3 against a real Star.

### Stage 3 — wire into Galaxy/Star DOs (next)
`setGalaxySecret` / `setStarSecret` (`requireAdmin`) sealing into KV; the Star-side resolver doing a mesh call to Galaxy for the Galaxy level; mode read from Galaxy config. Real two-DO resolution end to end.

**Success criteria**:
- [ ] All 3 modes resolve correctly across real Galaxy + Star DOs.
- [ ] Admin gating holds (a non-admin cannot set or read a secret).

## Open questions (resolve by doing)
- Pre-inject the declared secret set at facet load, or lazy `env.secrets.resolve` callback? (Reentrancy vs coarseness.)
- Does Galaxy return ciphertext (Star decrypts, both share the key) or plaintext over the mesh (server-internal, trusted)? Stage 3.
- Where do `setGalaxySecret`/`setStarSecret` live — extend `setGalaxyConfig`, or dedicated methods? (Dedicated, so the value never rides the readable `getGalaxyConfig`.)

## Dependencies / sequencing
Independent of the inbound/outbound spikes for Stages 1 & 3. Stage 2 shares the facet-loading mechanism with the outbound spike's egress choke point — coordinate, don't duplicate.

## Where code lives
`apps/nebula/test/spike-secrets-vault/` (picked up by the `unit` project's `test/**/*.test.ts` glob — zero new tooling). Spike module deliberately **not** in `src/` (not production-blessed). Promote to `src/` only after `/review-task`.
