# Nebula — onBeforeCall higher-admin scope reach

**Status**: ✅ **DONE 2026-06-23** — first child of [`nebula-pre-alpha.md`](../nebula-pre-alpha.md) Wave 1.
Built + panel-verified (`/review-task` two-stage → `/build-task` two-phase verifier fan-out, both CONFORM).
Shipped: the shared `enforceScopeReach(name, claims)` guard in `apps/nebula/src/nebula-do.ts` (admin-gated
reach clause, fail-closed branch order), delegated to by both `NebulaDO.onBeforeCall` and
`NebulaContainer.onBeforeCall`; tests in `scope-isolation.test.ts` (pure-helper matrix + integration) and
`container-node/nebula-container.test.ts` (parity). Mutation-validated: drop the `access.admin` gate → B1
red; reorder the reach clause → M1 red. Nuggets extracted up to the master ([`nebula-pre-alpha.md`](../nebula-pre-alpha.md));
this file is frozen on archive.

## Objective

Let a **higher-level admin reach a lower scope**. Today `NebulaDO.onBeforeCall` admits a call only when
the DO's own scope pattern covers the caller's **active scope (`aud`)** — so a platform `*` admin or a
`{u}.*` universe admin **cannot** call a descendant Galaxy/Star DO without re-minting a token whose `aud`
is narrowed to that exact scope. Change it so an **admin** caller whose **`access.authScopePattern` covers
the target DO's instance** is admitted directly (one admin identity reaches everything in its authority),
**without** weakening tenant isolation (a `{u1}` admin still cannot touch `{u2}`). The reach clause is
**gated on `access.admin`** — pattern-coverage alone is *not* treated as authority (a non-admin keeps
today's aud-narrowed behavior exactly).

This is the capability that lets the platform super-admin (and a Lumenize support engineer) read/write/
admin **any** descendant scope with one token — the basis for the pre-alpha cross-tenant turn-log
inspection instrument and for customer support. (Always the intended design; just not built yet.)

## Background (verified against code 2026-06-23)

- `requireAdmin` (nebula-do.ts) reads `claims.access.admin` (trusts the verified JWT claim); it's
  **orthogonal** to scope reach.
- `NebulaDO.onBeforeCall` (apps/nebula/src/nebula-do.ts): `pattern = buildAuthScopePattern(thisDOname)`
  (Galaxy→`{u}.{g}.*`, Star→exact id, Universe→`{u}.*`); rejects unless `matchAccess(pattern, aud)`.
- `NebulaContainer` (apps/nebula/src/nebula-container.ts) carries the **same** guard inline *today* — this
  task **extracts** it into the shared helper both call (see The change), so there's one audit point rather
  than a lockstep edit.
- `access.authScopePattern` is in the signed JWT, verified upstream by `verifyNebulaAccessToken`, which
  also enforces `matchAccess(authScopePattern, aud)` (a token's authority always covers its active
  scope). So trusting `authScopePattern` here is as sound as trusting `access.admin`.
- **Semantic precedent — a similar gate already ships on the HTTP path.** `verifyAndGateJwt`
  (`packages/nebula-auth/src/router.ts:382`) admits an HTTP request to an instance path via
  `matchAccess(authScopePattern, targetInstanceName)` (a *different* check from the aud-consistency one
  above) — **and additionally requires `admin || adminApproved`** (`router.ts:390`). So reach-by-authority
  is not a novel idea; the mesh clause below is in fact **stricter** (it requires `access.admin`).
- **Account approval is enforced at token-MINT, not at the gate (correcting a prior premise).** An
  unapproved non-admin is rejected at refresh-mint
  (`packages/nebula-auth/src/nebula-auth.ts:1198` — `!isAdmin && !adminApproved → null`) and on the HTTP
  gate (`router.ts:390`), but **not** in `verifyNebulaAccessToken` / `onBeforeCall`. So no unapproved
  account can hold a valid mesh token; this property is **pre-existing and unchanged** by this task (today's
  `onBeforeCall` already doesn't re-check approval). There is no new unapproved-account mesh-reach gap.
- `matchAccess('*', x)` → always true; `matchAccess('{u}.*', '{u}.{g}.{s}')` → true;
  `matchAccess('{u1}.*', '{u2}.…')` → false; `matchAccess('{u}.{g1}.*', '{u}.{g2}')` → false.

## The change

**Extract the guard into one shared, pure, exported helper (M2 / ADR-007 — "one place to audit").** The
guard body is currently duplicated byte-for-byte across `NebulaDO.onBeforeCall` and
`NebulaContainer.onBeforeCall` (they extend different bases — `LumenizeDO` vs `Container` — so they can't
share via inheritance, but they **must** share by composition per ADR-007). Pull the logic into one pure
function (suggested `enforceScopeReach(name, claims)`; build-task finalizes the name/home — co-located in
`nebula-do.ts` next to the exported `requireAdmin`, or a small `scope-guard.ts` both import). Each
`onBeforeCall` then emits its own debug-entry marker (the test namespaces differ —
`nebula.NebulaDO.onBeforeCall` vs `nebula.NebulaContainer.onBeforeCall`) and delegates:

```ts
// shared helper — the single audit point; pure ⇒ all branches unit-mutation-testable without a DO/Container harness
export function enforceScopeReach(name: string | undefined, claims: NebulaJwtPayload | undefined): void {
  if (!name) throw new Error('Mesh call missing callee instance name');   // (a) fail-closed
  if (isPlatformInstance(name)) throw new Error('Active-scope mismatch');  // (b) platform-name reject
  const pattern = buildAuthScopePattern(name);                            // (d) throws on malformed name — fail-closed

  // NEW — higher-ADMIN reach: an ADMIN whose authority pattern covers THIS DO's instance may act on it
  // regardless of its (narrower) active scope. GATED ON access.admin — pattern-coverage alone is NOT
  // authority. Runs only AFTER (b) + (d), so platform-name + malformed-name fail-closes apply to everyone.
  if (claims?.access?.admin && claims.access.authScopePattern
      && matchAccess(claims.access.authScopePattern, name)) return;

  // — existing active-scope path, unchanged (this is all a non-admin ever uses) —
  const aud = claims?.aud;
  if (!aud) throw new Error('Missing active scope (aud)');                 // (c)
  if (!matchAccess(pattern, aud)) throw new Error('Active-scope mismatch');// (e)
}

// both call sites:
onBeforeCall() {
  const name = this.lmz.instanceName;
  debug('nebula.NebulaDO.onBeforeCall').debug('entry', { instanceName: name });  // own namespace
  enforceScopeReach(name, this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined);
}
```

**Branch ORDER is load-bearing (M1):** the admin-reach clause sits **after** the missing-name fail-close,
the `isPlatformInstance(name)` reject, **and** the `buildAuthScopePattern(name)` parse — never before.
Reason: `matchAccess` is pure string matching with no `parseId`, so `matchAccess('*', anyString)` and
`matchAccess('{u}.*', '{u}.anything')` are `true` for *unparseable* names too. Placed first, an admin
token (esp. `*`) would short-circuit **past** the platform-name reject (regressing T-platform) and the
malformed-name fail-close (regressing T-malformed) — invisibly, since the frozen suite's callers are
narrow non-`*` tokens.

The reach clause sits *before* the `if (!aud)` check (c) deliberately — reach is `authScopePattern`-based,
not aud-dependent. An admin token with `authScopePattern` but no `aud` would thus be admitted by the clause
without ever hitting (c); this is **unreachable from verified tokens** (`verifyNebulaAccessToken` requires
both `aud` (router.ts:351) and `authScopePattern` (:354)), so no extra check is needed. T5's no-aud case
still kills branch (c): it sends no `originAuth`, so `claims` is undefined, the reach clause's
`claims?.access?.admin` is falsy, and execution falls through to (c).

## Key decision / risk (flag for the `/review-task` security lens)

For an **admin** token, this makes **`authScopePattern` (max authority), not `aud` (active scope), the
reach boundary** in `onBeforeCall`: an admin reaches everything its authority covers with one identity,
no per-target aud re-mint. **Active scope no longer *narrows* an admin's reach** (it stays a consistency
invariant + UX selection, not a containment boundary). This is the intended semantic; review must confirm
we accept that an admin token's blast radius equals its full authority.

**Why gate on `access.admin` (the B1 decision).** `buildAuthScopePattern` is admin-independent (`isAdmin`
only *adds* `access.admin`; it never narrows the pattern), so a **non-admin** with a wildcard pattern
(`{u}.*` / `{u}.{g}.*`) would otherwise reach descendant Stars too — including the **not-DAG-gated**
`subscribeTree` / `subscribeReload`, whose only containment is `getState()`'s auth check + **`onBeforeCall`'s
aud-lock** (star.ts:545), the very narrowing this change loosens. That would let a non-admin read every
sibling Star's full org/permission tree **within the tenant**. No use case needs that (every consumer —
`*` super-admin, `{u}.*` Universe admin, support engineer, the Universe-admin test-user provisioning flow —
is an admin), it's not reachable in pre-alpha (all wildcard-pattern holders are admins), but it's a latent
hole the moment a non-admin wildcard role exists. Gating the reach clause on `access.admin` closes it
permanently and keeps non-admin behavior byte-for-byte unchanged (they still reach only via the aud path —
own scope / ancestor; a descendant is rejected). So `requireAdmin` (per-method) and the reach clause
(per-scope) **both** read `access.admin` but for different axes — they stay orthogonal: the reach clause
gates *which DOs* an admin reaches; `requireAdmin` gates *which methods* require admin.

**Admin-bypass interaction (m1 — name both halves).** A covering **admin** token reaching a descendant Star
both passes `onBeforeCall` (this clause) **and** bypasses every per-resource DAG check via the scope-admin
bypass at `dag-tree.ts:158` — i.e. full read/write/admin on the descendant tree. That is the **intended**
god-mode for `*` / scope admins (covered by `dag-tree.test.ts:843`/`:1177`). A **non-admin** gets neither:
no reach clause, and the DAG check applies normally. The two halves are deliberate; document the split so
the security review confirms it rather than discovering it in `/build-task`.

**Delegated/impersonation-token interaction — NOTE (recorded here, enforced later).** A delegated token
(`act.sub` set) carries `access.authScopePattern` from the **minting NebulaAuth instance**
(`nebula-auth.ts:1353/1358`) and `access.admin` from the **impersonated subject** (`:1359`). Gating the
reach clause on `access.admin` therefore tightens impersonation for free: impersonating a **non-admin** test
user yields **no** descendant reach (the token isn't admin), regardless of the minting instance's width —
the reach matches the impersonated user's authority. Impersonating an **admin** does grant that admin's
reach (expected). Scope-bounded impersonation *enforcement* (beyond this) remains the deferred Out-of-scope
item (and `nebula-pre-alpha.md` § framing); `/build-task` should not chase it.

## Success criteria (capable-of-failing — mutate each)

The guard's branches are mutation-tested **once, as the pure `enforceScopeReach` helper** (no DO/Container
harness needed — this is the payoff of the M2 extraction). Behavioral cases **extend
`scope-isolation.test.ts`** (the established home — do not start a parallel file).

- [ ] **Reach (positive — admin only):** a `*` **admin** token reaches a Universe/Galaxy/Star DO with **no**
  aud narrowing; a `{u}.*` admin reaches `{u}.{g}` and `{u}.{g}.{s}`; a `{u}.{g}.*` admin reaches
  `{u}.{g}.{s}`. (Mutation: delete the reach clause → these fail.)
- [ ] **Isolation (negative — the guarantees):** (i) a `{u1}.*` admin is **rejected** by every `{u2}.…` DO;
  a `{u}.{g1}.*` admin is **rejected** by a sibling `{u}.{g2}` DO (mutate `{u1}`/`{u2}` independently of
  `{g1}`/`{g2}`; mutation: blind `return` in the reach clause → these fail). (ii) **B1 — a covering-pattern
  NON-admin** (`{u}.*` / `{u}.{g}.*`, **no** `access.admin`) is **rejected** reaching a descendant Star: the
  reach clause requires admin, so it falls through to the aud check, which rejects (incl. the
  not-DAG-gated `subscribeTree`/`subscribeReload`). **Mutation: drop the `access.admin &&` → the non-admin
  wildcard wrongly reaches the descendant.** This is the B1 regression guard.
- [ ] **Fail-closed precedence (M1 — clause must not short-circuit past the guards):** a `*` admin
  addressing `nebula-platform` is still **rejected** (T-platform); a `*` admin addressing a malformed name
  (4 segments / illegal slug) still **fails closed** via `buildAuthScopePattern` (T-malformed). **Mutation:
  move the reach clause *above* the platform reject + parse → both wrongly succeed** (`matchAccess('*', …)`
  is true for any string, incl. unparseable).
- [ ] **`requireAdmin` orthogonality (per-scope vs per-method):** a **non-admin reaching its own scope**
  (admitted via the aud path) still gets **rejected by a `@mesh(requireAdmin)` method** on that DO — showing
  the scope gate (`onBeforeCall`) and the method gate (`requireAdmin`) are independent.
- [ ] **No regression — B2 (T6 must be REWRITTEN, not just re-run):** under the new clause the galaxy
  **admin** (aud=galaxy, pattern `{g}.*`) calling a descendant Star now **succeeds** — the old T6 asserts
  *rejection* (`scope-isolation.test.ts:162`) and will go red; rewrite it to assert admission (keep its
  star-aud positive control). **Re-anchor branch (e)'s mutation** to a still-rejecting **exact-star sibling**:
  a star-scoped token (pattern `{u}.{g}.tenant-a`, no admin-reach) calling sibling `{u}.{g}.tenant-b` →
  exact pattern, `matchAccess` false → falls to (e). Then re-confirm the five-branch mapping **with the new
  clause present**: (a)→T5-missing-callee, (b)→T-platform, (c)→T5-no-aud, (d)→T-malformed, (e)→exact-star-
  sibling — each red when its branch is commented out (a 6th accept-path in front can silently cannibalize a
  branch-kill). Star→own-Galaxy reads still work via the unchanged aud path.
- [ ] **NebulaContainer parity (m3 — helper-level, not a full re-matrix):** assert structurally that
  `NebulaContainer.onBeforeCall` delegates to the **same `enforceScopeReach`** (single audit point, M2), plus
  one onBeforeCall-level admit/reject smoke via the existing `CONTAINER_GUARD_HARNESS` non-Container DO
  (`container-no-construct-pool-workers` — assembled `extends Container` can't be built under
  vitest-pool-workers). DAG / `requireAdmin` rows are **NebulaDO-only** (the container harness has no Star
  surface). Confirm the frozen B5 `@mesh`-surface-freeze tests (Galaxy/Universe non-admin set; container
  surface) stay green.

## Out of scope

- The **inspection instrument** + the **provisioning** primitive (separate pre-alpha children that build directly on this reach).
- Scope-bounded **impersonation** enforcement (deferred — all pre-alpha users are Universe admins).

## Refs

- Master: [`nebula-pre-alpha.md`](../nebula-pre-alpha.md) · scope-isolation design (archived/frozen):
  `tasks/archive/nebula-do-scope-isolation.md`
- Code: `apps/nebula/src/nebula-do.ts`, `apps/nebula/src/nebula-container.ts` (the shared helper's two call
  sites); scope helpers `packages/nebula-auth/src/parse-id.ts` (`buildAuthScopePattern` / `matchAccess`).
- Reviewed-against (verify, don't re-derive): `apps/nebula/src/star.ts:545,550,584` (`subscribeTree` /
  `subscribeReload` — not DAG-gated, B1); `apps/nebula/src/dag-tree.ts:158` (scope-admin DAG bypass, m1);
  `packages/nebula-auth/src/{router.ts:382/390,nebula-auth.ts:1198/1353/1359}` (HTTP precedent + approval-at-
  mint + delegated-token claims); frozen matrix `apps/nebula/test/test-apps/baseline/scope-isolation.test.ts`
  (T6 rewrite + branch-(e) re-anchor).
