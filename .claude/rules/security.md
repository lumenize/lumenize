---
paths:
  - "packages/auth/**/*.ts"
  - "packages/nebula-auth/**/*.ts"
  - "apps/nebula/**/*.ts"
---

# Security Invariants

Lumenize-specific, not generic OWASP. Security is on by default — you have to jump through hoops to disable it, and those hoops must never be reachable in production. These are the *conformance* checks; deeper design review (sandbox-escape analysis, permission-model completeness) is a reviewer-panel concern — see `tasks/on-hold/task-review-panel.md`.

- **Secrets never committed** — see [critical.md](critical.md). No tokens/keys in source, `wrangler.jsonc`, or any committed file.
- **Never log secrets — at ANY level.** `@lumenize/debug` gates all output on the `DEBUG` var, so prod is normally silent — but we run broad `DEBUG` in pre-alpha for tracing, so *no log statement may emit a secret* regardless of level. Never log: magic-link tokens/URLs, raw/minted JWTs or access tokens, refresh tokens, cookies/`Authorization` headers, signing keys, or `TURNSTILE_SECRET_KEY`. Log **identifiers** (`sub`, `email`, `instanceName`, `method`) and **`url.pathname`** — **never `request.url`** (a full URL can carry a query-string secret, e.g. `/auth/{scope}/magic-link?token=…`). Emails/subs are identifiers, not secrets, and may be logged. (Audited clean 2026-06-26: the only `request.url` logs were two WS-reject lines in `entrypoint.ts`, tightened to pathname.)
- **Test-mode flags only in vitest `miniflare.bindings`**, never in `wrangler.jsonc` `vars` (see [packaging.md](packaging.md)). A test-mode flag that bypasses auth or admin checks must be unreachable in a deployed Worker. Never weaken `requireAdmin` / admin-bypass paths outside test bindings.
- **JWT verification on every protected path** — verify the token *and* enforce scope (`aud`/`activeScope`) before acting. Auth uses a two-scope model: `authScope` (cookie path) + `activeScope` (JWT `aud`). Don't trust an unverified claim.
- **Refresh tokens — no per-refresh rotation (decision 2026-06-29).** Rotation was dropped: a refresh re-issues the SAME token with a slid expiry, never revoking the old value. Rationale: the cookie is `HttpOnly; Secure; SameSite=Strict`, Path-scoped (`/auth/{authScope}`), host-only — not JS-readable, not cross-site — so the theft surface rotation defends is already closed; and the implementation never had reuse-detection/family-revoke, so rotation only added fragility (overlapping refreshes from a hibernating browser client racing a single-use token → spurious logout) with no detection benefit. **Don't re-introduce per-refresh rotation.** If breach *detection* is wanted later, do it properly: rotation **with a grace window** (old token valid for a short overlap so legit races/retries succeed) **plus family-revoke on post-grace reuse** — never the no-grace, no-family-revoke form. **Keep intact:** JWT verification + scope enforcement on every protected path; **logout still revokes** the refresh token; refresh-token TTL + slide. WebAuthN/MFA (pre-beta) restores defence-in-depth.
- **Permission checks before resource mutation** — resource operations must pass a DAG permission check. When refactoring a permission path, enumerate every throw case so a broadened catch doesn't silently turn a malformed-request error into a permission failure (see the typed-errors note in [durable-objects.md](durable-objects.md)).
- **Parameterized SQL only** — use `this.svc.sql` template binding or `ctx.storage.sql` parameters; never string-concatenate user input into SQL (see [durable-objects.md](durable-objects.md) § Storage).
- **Trust-boundary crossings** — when a design crosses a trust boundary (client → Gateway → DO, or DWL sandbox → host), name it and confirm the receiving side re-validates rather than trusting the sender.
