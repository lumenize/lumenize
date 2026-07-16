# Profile P2 — global "person" / cross-Universe profile unification

**Status**: ICEBOX (parked 2026-07-15) — designed-but-deferred, no planned return. **Trigger to un-ice: a real cross-Universe profile-sharing need.** Extracted from the completed [profile store](../archive/nebula-profile-store.md) (Phases 1–3 built; P1 identity model is [ADR-013](../../docs/adr/013-identity-profileid-resolution.md)) so this parked design isn't frozen in that archive. **Do NOT build the person-layer now.**

## What P2 is
Link many `sub`s' profiles into **one canonical profile a person edits once** (the same person across Universes / different emails). P1 is one `profileId` per `sub`; the `Identities.profileId` **column** + live-resolution ([ADR-013](../../docs/adr/013-identity-profileid-resolution.md)) make this **additive later**: re-point a second `sub` at an existing `profileId` — a one-row `UPDATE`, no re-key, no "person layer above." The `profileId` claim refreshes on the sub's next token refresh.

## Re-point convergence — DECIDED 2026-07-13 (option a)
Re-pointing **mutates** that `sub`'s `profileId`, so the registry **converges** the denormalized copy into the `sub`'s KV refresh record(s) via the existing `isAdmin`-style push — [`setIdentityAdmin`](../../packages/nebula-auth/src/nebula-auth-registry.ts) pattern: enumerate `RefreshTokenIndex WHERE sub`, re-put each with the new `profileId` + the record's **original expiry**. So the `profileId` claim refreshes on next refresh (same convergence machinery as `isAdmin`; additive per ADR-013).
- **Rejected — option b** (drop `profileId` from the JWT/KV to sidestep convergence): fights the pure-KV refresh path and loses the owner-authz claim convenience.

## Unification trigger — the breadcrumb-cookie design seed (2026-07-13)
The one case the **server cannot see**: *different email, same person, same browser* (same-email-across-scopes the registry already links via `discover(email)`, so the cookie isn't redundant with that).
- A **root-path, non-httpOnly breadcrumb cookie** records the last `profileId` seen in this browser, set at **login** (`consumeAndLogin`, riding the existing refresh `Set-Cookie`; refresh no longer re-sets cookies). `Path=/` set **explicitly** (omitting Path scopes to the setting directory, not the origin); `SameSite=Lax`; host-only.
- ⚠️ **UNTRUSTED / advisory ONLY** — it may trigger a "link to your existing profile?" prompt but is **never** an input to the link decision. The link must independently **prove control of both** identities. Safe form: **auto-offer only when a *live* session for the other profile exists**; a stale breadcrumb only prompts a "sign in to link" flow. **Shared/kiosk-browser identity contamination** is the failure mode this rail closes.
- JS may **write** it only to clear it ("not me"); read-only otherwise.
- A manual **"merge profiles"** feature is the fallback for the rest (different browser / cleared cookie).

## Also deferred here
- **Profile-DO teardown on scope deletion.** `executeScopeDeletion` drops `Identities` rows + KV + tokens but does NOT tear down the now-orphaned Profile DOs (fields + `privateNotes` + subscriber rows); in P1 (1 sub : 1 profile) each deleted member orphans one. **Acceptable pre-alpha** — unreachable after the ≤15-min token window, and the pending greenfield wipe clears it. **P2 teardown**: "delete the Profile DO when `Identities WHERE profileId` is empty," folded into the scope-deletion cascade. (Near-term tracking: [backlog.md](../backlog.md) § Nebula Auth.)
- **Per-scope display name** — the way `email` is per-scope. v1 is one `name`/`nickname` per profile; the per-scope door is the same one `email` opened, if ever needed.

## Guardrails carried from P1 (do not violate when this un-ices)
- ADR-013: `profileId` resolved live off `sub`, never copied onto resource records; re-point stays additive.
- ADR-012: public profile fields are globally readable via the unguessable `profileId`; `privateNotes` stays `requireOwnerOrAdmin`.
- The breadcrumb cookie is advisory; linking always proves control of both identities.
