# Turn Turnstile ON in prod (fold login to one gated call)

**Status**: ON HOLD — deferred to **post-pre-alpha**. Re-enable trigger: **before public signup opens (alpha)**.
**Home for**: the backlog's 🔴 "Turnstile OFF in prod" caveat (top banner + § Nebula Auth) — those are now pointers here.

## Objective / Target (present tense)
Prod runs **Turnstile ON** on the public unauthenticated endpoints (`email-magic-link`, `claim-universe`, `claim-star`, `discover`). Trusted automation (agent/CI) passes via the `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN` header bypass — **built + canary-verified**. A human logging in faces Turnstile **exactly once**, because login is **one gated call**: a scope-less "start login" endpoint folds discovery server-side.

## Why deferred (dated, fenced — 2026-07-06)
- Turnstile mitigates **bot/abuse at *public* signup**. Pre-alpha is F&F-invite-only / obscure-URL / cost-ceiling-watched → that risk isn't live yet.
- The **bypass is built + canary-verified**, so this deferral does NOT affect my prod automation access (I pass regardless once it's on; while it's off I pass via the no-secret skip). So there's no "I'll be locked out" pressure to rush it.
- Turnstile is **bot-protection, NOT the secure-by-default substrate** (auth / permissions / tenant isolation) — deferring it overrides no security invariant (`security.md`). Contrast: the substrate is never deferrable.
- The widget/endpoint work is a real chunk that shouldn't preempt pre-alpha's actual blockers (F&F invites, chat-history UI wiring, preview-survives-redeploys).
- **This is a fenced, dated deferral — NOT the model.** The Objective above is present-tense truth; "off in prod" is the temporary exception (`interim-unlearning-tax`).

## Current state (2026-07-06)
- Prod: `TURNSTILE_SECRET_KEY` **unset** → Turnstile OFF (confirmed via `wrangler secret list`). `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN` **deployed**.
- **No Turnstile widget provisioned** — no secret key in `.dev.vars`, no site key anywhere in the repo. Turnstile has never actually run except in unit tests + the local canary (both inject a test secret).
- Bypass: `isTurnstileBypassed` in `packages/nebula-auth/src/router.ts` (header `x-lumenize-turnstile-bypass`, constant-time compared). Unit-tested + **end-to-end canary-verified** on a real booted worker.

## Design decision — bypass mechanism (settled)
Chose a **dedicated, revocable header token** over: (a) keying the bypass on automation **email / `test-` scope** — a stolen automation email would then bypass; a token is revocable and isn't an identity; (b) reusing `TURNSTILE_SECRET_KEY` — that key is server-only, so putting it in a wire-travelling header would widen its leak surface.

## Design decision — login is ONE gated call (the fold)
Today `sendMagicLink()` (`apps/nebula-studio-ui/src/App.vue`) fires **two** gated calls back-to-back in one click: `discover` then `email-magic-link` (both *before* any email — the inbox magic-link is a gate-free `GET`). Turnstile tokens are single-use → two tokens → the suspicious-minority would be challenged **twice** (a glitch; the invisible-majority wouldn't notice, but a rapid double-execute can itself provoke a challenge).

**Fix:** a scope-less **"start login"** endpoint takes `{ email, cf-turnstile-response }`, checks Turnstile **once**, discovers the email's scopes server-side, and responds:
- **1 match** → send the magic link for it;
- **0 matches** → "needs claim" (client shows the claim-universe form);
- **>1** → "pick one" (picker is a later feature; today it errors).

Bonus: this removes the standalone **unauthenticated `discover` enumeration-oracle** from the login hot path (aligns with the backlog #428 concern). It does NOT fully close #428 — email-ownership-first is a bigger flow, out of scope here.

## Phases

### Phase 0 — Provision the widget (dashboard, human step)
**Goal**: a real Turnstile widget for `nebula.lumenize.com`.
**Success Criteria**:
- [ ] Turnstile widget created in the CF dashboard → **site key** (public) + **secret key** recorded.
- [ ] Managed mode selected (invisible for most; interactive only for the suspicious minority).
- [ ] Secret key in the root `.dev.vars` (`TURNSTILE_SECRET_KEY`); site key available to the SPA.

### Phase 1 — Fold login to one gated call (the B1 blocker)
**Goal**: cold login faces Turnstile once; `discover` leaves the login hot path.
**Success Criteria**:
- [ ] `nebula-auth` gains a scope-less "start login" endpoint: `{ email, cf-turnstile-response }` → Turnstile-checked once → server-side discover → 1/0/>1 disposition (per the design above). Turnstile-gated; the bypass header still passes.
- [ ] `App.vue` renders/executes ONE Turnstile widget (site key), posts `{ email, token }` to the new endpoint, handles the 3 dispositions; the separate `discover()` call is removed from `sendMagicLink()`.
- [ ] `claimUniverse()` threads `cf-turnstile-response` into its POST (its own single user action → one token).
- [ ] Verified: `drive.ts turnstile-canary` still green; a `/live` browser drive of the folded login shows one-challenge login + working claim flow; capable-of-failing tests for the new endpoint's 1/0/>1 branches.

### Phase 2 — claim-star + latents
**Goal**: no gated surface breaks silently.
**Success Criteria**:
- [ ] When `claim-star` gets a UI, it threads the token (today it's gated but unwired in the SPA).
- [ ] Any test lane pointed at prod (`ui-smoke` `BENCH_BASE_URL` → prod) sends the bypass header (or uses test-mode) so it doesn't 403 on login.

### Phase 3 — Flip it ON in prod
**Goal**: Turnstile ON in prod, automation unaffected.
**Success Criteria**:
- [ ] `wrangler secret put TURNSTILE_SECRET_KEY` on the prod worker; redeploy.
- [ ] `drive.ts turnstile-canary` re-run against the REAL widget (site+secret) — gate + bypass + widget-path all pass.
- [ ] A prod login drive shows one-challenge login working end-to-end.
- [ ] `apps/nebula/harness/prod.ts enumerate` still passes (the bypass carries the harness through) — the deferral's whole premise, re-confirmed live.
- [ ] Remove this file's deferral fence; delete the backlog banner + § pointer (README: delete completed rows).

## Verification tooling
- **`drive.ts turnstile-canary`** (`apps/nebula/harness/scenarios/turnstile-canary.ts`) — boots a real worker with Turnstile forced ON (test secret via `HARNESS_TURNSTILE_SECRET`), probes gate + bypass + wrong-token + widget-path + login-break. All 5 green 2026-07-06.
- Full findings + blocker catalog: `apps/nebula/harness/FINDINGS.md` § Turnstile canary.

## Non-goals
- Fully closing the `discover` enumeration-oracle (#428 — email-ownership-first flow). The fold only removes it from the *login hot path*.
- WebAuthn / MFA (pre-beta).
- The Cloudflare **fraud-detection headers** approach (backlog § Nebula Auth) — complementary, separate item.

## Links
- Bypass: `packages/nebula-auth/src/router.ts` (`isTurnstileBypassed`, `checkTurnstile`, `TURNSTILE_ENDPOINTS`); tests `packages/nebula-auth/test/turnstile-bypass.test.ts`.
- SPA login: `apps/nebula-studio-ui/src/App.vue` — `discover()`, the `email-magic-link` POST in `sendMagicLink()`, and `claimUniverse()`.
- Memory: [[live-prod-drive]], [[autonomous-prod-explore]].
