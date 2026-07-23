# Auth-shortcut audit — migrate synthetic mints to the real login path (ADR-009)

> **⏸️ DECOMPOSED + PARKED (2026-07-15).** Not a standalone next-up — it was out of order. Its two halves are re-homed to their real consumers; this file is the **method-of-record**, kept for when they resume:
> - **Phase 1 (harness real login + real multi-user)** → now a prerequisite of **[../nebula-galaxy-collapse-and-chat.md](../nebula-galaxy-collapse-and-chat.md)** (its 3-participant test is the real first consumer). Build it *there*, with chat Phase 2 — not ahead of it (chat is paused behind presence, so Phase 1's consumer is ≥2 steps out). Targets the `/live` harness (`apps/nebula/harness/lib/harness.ts`), a different surface from the broken vitest lane — so it is **not** invalidated by the frontend rewrite.
> - **Phase 2 (sweep the vitest mints + decide `create-nebula-test-token`'s fate)** → the finishing step of the **"login flows restoration"** item in [../backlog.md](../backlog.md) § Nebula Auth. It is **downstream of** that restoration, not independent: the baseline lane reds at login today (`test-helpers.ts` still on the pre-surrogate-sub mint-on-login model), and you cannot migrate rung-3 mints *to* real login until real login (`browserLogin`) is restored. Sequenced with profile/presence (LATER).
>
> Why parked: doing it now would audit a test lane that's about to be rewritten, and front-run Phase 1's paused consumer. Reconciliation of the drift (the profile tests added +2 rung-3 sites on 2026-07-14; the `magic_link`→`magicLinkUrl` rename is part of restoration) is in the re-homed pointers. See the 2026-07-15 session analysis.

**Status**: Parked — decomposed into the two homes above; body retained as the detailed method. Applies [ADR-009](../../docs/adr/009-real-auth-path.md) (real email login is the default; synthetic client-side mints are a last resort) to existing code. Prerequisite for the full sweep: the **`lumenize.io` catch-all → email-test Worker** (any `@lumenize.io` address testable via real login).

## Objective
Every place that fakes auth is classified against the ADR-009 ladder and migrated to the highest rung it can reach:
1. **Real login** (email → magic-link → cookie → token) — default; the only path we ground on.
2. **Test-mode server-issuance** (`LUMENIZE_AUTH_TEST_MODE` / `createTestRefreshFunction`) — isolated unit tests that need an authed identity but not the email round-trip.
3. **Client-side synthetic mint** (`create-nebula-test-token`) — last resort; each survivor justified in-place with a one-line comment.
4. **Negative-control mints** — deliberately *wrong-shape* tokens; **keep** (real login can't produce them).

## Finding #1 (pre-decided, LEADS) — convert the `/live` harness to real email login
The live exploratory harness (`apps/nebula/harness/`) uses `create-nebula-test-token` (`lib/harness.ts` `connectDriver` → `createNebulaTestToken`) for its API scenarios — a rung-3 mint we reason about the running system from. **Convert to real login** (rung 1): the harness mints a magic link for an `@lumenize.io` address, the **email-test Worker catches it** (already how the browser scenario + prod-drive work), consumes it → cookie → token → connected `NebulaClient`. Boot is ~2min already, so +~1s real login is negligible.
- **Multi-user capability falls out**: the same real-login flow, run for N distinct `@lumenize.io` addresses (via the catch-all), gives the harness **real multi-user login** — which is exactly what the chat task's 3-participant test needs (and, per ADR-009, a dual-use user-developer feature: log N users into preview tabs). Build it as a reusable harness primitive.
- **Keep** `mintDegradedToken` (rung 4 — negative controls: base-shape / no-`access` tokens must still be rejected at the gateway).
- The browser scenario (`studio-chat-reload`) already uses real magic-link login — no change.

## Phases
### Phase 1 — Harness real login + real multi-user (unblocks the chat task)
**Success Criteria**:
- [ ] `connectDriver` (or a sibling) obtains its token via **real login** (magic link → email-test Worker → cookie → token), not `createNebulaTestToken`. Existing scenarios (`message-roundtrip`, `superadmin-reach`) pass on the real path.
- [ ] A **real multi-user** primitive: log in K distinct `@lumenize.io` identities in one harness run (via the catch-all), each a connected client. `mintDegradedToken` retained for negative controls.
- [ ] Verified by driving it once, end-to-end, against a booted stack.

### Phase 2 — Sweep the remaining sites
**Success Criteria**:
- [ ] Enumerate every synthetic-auth site: `grep -rn "createNebulaTestToken\|create-nebula-test-token" apps packages` (+ any other client-side mint). Classify each against the ladder.
- [ ] Migrate rung-3 sites to rung 1 (real login) or rung 2 (test-mode issuance) where they exercise behavior; leave a justifying comment on any rung-3 survivor.
- [ ] Decide `create-nebula-test-token`'s fate: if no justified rung-3 use remains, **delete it** (+ its `@lumenize/nebula-auth/testing` export); else keep with documented survivors.
- [ ] Add a `testing.md` note pointing at ADR-009 so new tests default to the ladder.

## Notes
- **Sequencing:** Phase 1 leads (chat-task dependency); needs the catch-all set first. Phase 2 is independent cleanup, can trail.
- Not the same as removing test-mode — rung 2 (`LUMENIZE_AUTH_TEST_MODE`) is *sanctioned* for isolated units; the target is the rung-3 client-side mints and any place we *ground reasoning* on a fake path.
