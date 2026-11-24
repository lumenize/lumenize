# Delegation model + `/delegated-token` escalation fix

**Status**: ✅ **COMPLETE (2026-07-07) — decision record (frozen on archive).** NOW-1 (the `/delegated-token` scope-bounded-mint **escalation fix**) + NOW-2 (the `security.md` invariant pin) **shipped + verified** (see *Build status*). Rehomed: the in-DO chat `actAs` → the chat task S2; the residual `actFor` cleanup + the cross-node `actAs` mechanism → `on-hold/delegation-hardening.md`. **ADR — left open.** This file is the model + decision record; the durable rules live in `security.md`.

## Why now (not idly dormant)
The detour proved the near-term chat need is an **in-DO `changedBy` build** (chat's own path) and the cross-node `actAs` mechanism has no near-term consumer — but it surfaced a **privilege-escalation in `/delegated-token`**. It's un-triggered *today* (prod has only the super-admin), but **Galaxy admins are the collaborators in the multi-user-chat vision** — i.e. the sub-Universe admin that makes this escalation *live* is a near-term, first-class persona. Close it now, while free.

## Model (the foundation every act-chain consumer builds on — the durable record)
**Vocabulary** (the JWT reuses the key `sub` at two levels — never write bare `sub`):
- **authority `sub`** = the **top-level** `sub` = the access-control principal (the human). The **only** identity that carries authority.
- **actor id (`act.sub`)** = the `sub` **inside an `act`** = a nametag for whoever is acting (**human or agent**). Traceability/display only.

**Invariant** — authz reads the **authority principal** (top-level `sub` + its `access` claim) and **never** the actor chain (`act`'s sole reader is `resources.ts` `#buildChangedBy`, provenance). Direction: **outermost `act` = current, most-nested = earliest** (RFC 8693 §4.1). It is **all delegation, never impersonation** — the actor is always recorded (RFC 8693 §1.1) — so `/delegated-token` keeps its name.

**Two operations** (different — even the designer conflated them mid-review):

| Op | where | subject | actor | authz off | gated? | for |
|---|---|---|---|---|---|---|
| **`actFor`** | mint — `POST /delegated-token` (nebula-auth) | **CHANGES** to the target | the caller | the **target** | **yes** | support ("see what they see"), multi-user collab/testing |
| **`actAs`** | append — in-DO now (chat), cross-node later (`lmz.call`) | **fixed** (origin) | the acting node, prepended outermost | the **unchanged** origin | no (grants nothing) | chat, multi-agent |

## NOW-1 — close the `/delegated-token` escalation
**Goal**: the mint cannot issue a token whose scope or `admin` exceeds the **caller's own verified reach**. Today `buildNebulaJwtPayload` sets `access.admin = subject.isAdmin` (the *target's* flag) and `access.authScopePattern = buildAuthScopePattern(instanceName)` (the *instance's*), gated only by `auth.isAdmin` — so acting-for a higher-scoped admin inherits `admin: true` + the instance's reach. All within `nebula-auth`; it touches the shared claim builder (seam below).

- **Auth surface (B1)** — require a **verified Bearer access token**; **reject refresh-cookie auth** on `/delegated-token`. `#authenticateRequest` accepts either, but the cookie path (`#verifyRefreshTokenIdentity`) carries no `access`/`authScopePattern`, so a scope-bounded mint can't derive the caller's reach from it — leaving the escalation reopenable. A scope-sensitive mint must derive from a verified access token.
- **Caller's reach (M1)** — surface the caller's `access.authScopePattern` out of `#verifyBearerToken` (it's on the verified `payload.access`, dropped today; present in both bearer branches — local-subject and wildcard-admin).
- **Gate** — before minting, `matchAccess(`*caller's* `authScopePattern, activeScope)` → **403** if not covered. (Today's inline check at `#handleDelegatedToken` uses the *instance's* pattern, not the caller's.)
- **Bound scope (M3)** — minted `access.authScopePattern = buildAuthScopePattern(activeScope)` — a **pattern**, so galaxy/universe scopes keep child-Star reach; **never** the bare `activeScope` id (would break `enforceScopeReach` child reach) and **never** the instance's pattern. ⊆ the caller's pattern by the gate.
- **Bound admin (M1)** — minted `access.admin = callerIsAdmin` (the gate already bounded the scope; **never** the *target's* `isAdmin`). A non-admin authorized-actor caller → no `admin`. This is a *distinct* check from the scope gate (mutation-test them separately).
- **Seam (M2)** — thread these through an **override** on `buildNebulaAccessEntry`/`buildNebulaJwtPayload` (optional `authScopePattern` + independently-computed `admin`; **default = today's** `buildAuthScopePattern(instanceName)` + passed `isAdmin`, keeping the `matchAccess(pattern, activeScope)` self-check). **Non-regression**: the login/refresh mint (`#generateAccessToken` ← `#handleRefreshToken`) is unaffected because there **caller == subject** (instance-derived is correct); `createNebulaTestToken` keeps its default shape + type-checks.

**Success Criteria** (capable-of-failing; real cross-scope fixtures — every *existing* delegated-token test is same-scope and would false-green. Land NOW-1 **before** the on-hold `AuthorizedActors` removal so #3 can red):
- [x] a lower-scoped admin (pattern narrower than the DO instance) requesting an `activeScope` its *own* pattern doesn't cover → **403**. Mutation: comment the caller-pattern gate → reds.
- [x] the same caller requesting a caller-covered scope → 200, minted `access.authScopePattern` == `buildAuthScopePattern(activeScope)` (not the instance's, not the bare id).
- [x] an `AuthorizedActors` **non-admin** caller acting-for an `isAdmin` target → minted token has **no** `admin: true`. Mutation: comment the admin-bit gate → reds (independently of the scope gate).
- [x] a refresh-**cookie** caller to `/delegated-token` → **rejected**.
- [x] **positive**: a Universe/Galaxy-admin delegated **galaxy-scoped** token still reaches a child Star via `enforceScopeReach` (proves the pattern, not the bare id).
- [x] lock the narrowing into the existing same-scope universe-admin delegation test: assert minted `authScopePattern` == the requested scope's pattern.

## NOW-2 — pin the invariant (read-side AND mint-side)
**Goal**: both load-bearing rules — the read-side, and the **mint-side** rule this fix establishes (whose absence *caused* the escalation) — outlive this soon-archived file.
**Success Criteria**:
- [x] `.claude/rules/security.md` gains **both**:
  - *read-side*: "Delegation/authz decisions read the authority principal (top-level `sub` + its `access` claim) and **never** the `act` chain; `act` (`act.sub`, nested) is traceability/display, sole reader `resources.ts` `#buildChangedBy`. Enforcement: `dag-tree.ts` `requirePermission`, `nebula-do.ts` `enforceScopeReach`."
  - *mint-side*: "A delegated / act-for token mint must never grant scope or `admin` exceeding the **caller's** own verified reach: bind minted `access.authScopePattern` to the caller-covered requested scope; set `admin` only if the caller holds admin covering it; **never** copy the target subject's `isAdmin` or the issuing instance's pattern."

## Build status (2026-07-07 — BUILT, mutation-validated)
- **NOW-1** — `packages/nebula-auth/src/nebula-auth.ts` (`#handleDelegatedToken` B1 cookie-reject + caller-reach gate + scope-bounded mint call; `#verifyBearerToken`/`#authenticateRequest` surface the caller's `authScopePattern`; `#generateAccessToken` `authScopePattern`/`isAdmin` overrides) + `access-claims.ts` (`buildNebulaAccessEntry`/`buildNebulaJwtPayload` optional-override seam, default = today's shape). 4 new cross-scope fixtures in `test/nebula-auth-delegation.test.ts`, + the existing cross-scope test in `test/nebula-auth.test.ts` (`deleg-scope-aud`) amended to assert the minted `authScopePattern` (criterion #6).
- **NOW-2** — `.claude/rules/security.md` gained the read-side + mint-side delegation invariants.
- **Validation** — full `nebula-auth` suite **329 passed / 0 failed** (login/refresh/test-token non-regressing). Mutation-check: reverting the mint to pre-fix behavior (instance pattern + target `isAdmin`, no B1, no caller-gate) reds exactly the **4 new tests** while the **7 existing** delegation tests stay green — the new tests are capable-of-failing. (The 25 `Errors` are pre-existing registry email-validation class-B artifacts, unrelated.)

## Deferred + rehomed (pointers, not work here)
- **In-DO chat `actAs`** — DevStudio's agent-turn write stamps `changedBy = { sub: HUMAN, act: { sub: NEBULA } }` (an in-DO `changedBy` override, per the Model) → **[chat task](nebula-chat-history-multiuser.md) S2**.
- **`actFor` residual guards** (plain-`{ sub }`/Case-B; drop `AuthorizedActors`→admins-only; Star-root-admin + consent eligibility) — trigger: first sub-Universe admin → **[on-hold/delegation-hardening.md](on-hold/delegation-hardening.md)**. (NOW-1 pulls only the escalation forward; the residual stays deferred.)
- **Cross-node `actAs` mechanism** (`CallOptions.actAs` in the shared `buildOutgoingCallContext`; a separate growable field composed by `#buildChangedBy`; append-only, trusted value) — trigger: first external/remote agent → **[on-hold/delegation-hardening.md](on-hold/delegation-hardening.md)**.

## ADR — open question (undecided)
Decide when the on-hold mechanism builds. *Against* a new ADR: the eventual `actAs` `CallOption` conforms to ADR-007, and the model is arguably `website/docs/auth/delegation.mdx` documentation. *For*: "authz off the authority principal, never `act`" + the scope-bounded-mint rule is a cross-package (auth + mesh + nebula) commitment. Also on the table: a note in ADR-007. Not decided.

## Non-goals
- **No wipe** — no multi-level `act` data exists (the mint is single-level by construction; the append mechanism isn't built).
- **Base `@lumenize/auth` is not vulnerable** to this class (flat `isAdmin`, no `authScopePattern` to widen — `jwt.ts` `createJwtPayload`); the fix is nebula-auth-only. The de-fork ([on-hold/auth-token-core-compose-not-fork.md](on-hold/auth-token-core-compose-not-fork.md)) must re-audit if it lifts nebula's scoped `access` shape into base auth.
- **Chained `actFor`** (re-delegating a delegated token) stays unsupported by design — the plain-`{ sub }` guard that enforces it is deferred with the residual (dormant: no re-delegation flow).
