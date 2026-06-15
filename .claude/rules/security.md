---
paths:
  - "packages/auth/**/*.ts"
  - "packages/nebula-auth/**/*.ts"
  - "apps/nebula/**/*.ts"
---

# Security Invariants

Lumenize-specific, not generic OWASP. Security is on by default — you have to jump through hoops to disable it, and those hoops must never be reachable in production. These are the *conformance* checks; deeper design review (sandbox-escape analysis, permission-model completeness) is a reviewer-panel concern — see `tasks/on-hold/task-review-panel.md`.

- **Secrets never committed** — see [critical.md](critical.md). No tokens/keys in source, `wrangler.jsonc`, or any committed file.
- **Test-mode flags only in vitest `miniflare.bindings`**, never in `wrangler.jsonc` `vars` (see [packaging.md](packaging.md)). A test-mode flag that bypasses auth or admin checks must be unreachable in a deployed Worker. Never weaken `requireAdmin` / admin-bypass paths outside test bindings.
- **JWT verification on every protected path** — verify the token *and* enforce scope (`aud`/`activeScope`) before acting. Auth uses a two-scope model: `authScope` (cookie path) + `activeScope` (JWT `aud`). Don't trust an unverified claim.
- **Refresh-token rotation** — verification paths and rotation must stay intact when touching auth flows; don't introduce a path that accepts a refresh token without rotating it.
- **Permission checks before resource mutation** — resource operations must pass a DAG permission check. When refactoring a permission path, enumerate every throw case so a broadened catch doesn't silently turn a malformed-request error into a permission failure (see the typed-errors note in [durable-objects.md](durable-objects.md)).
- **Parameterized SQL only** — use `this.svc.sql` template binding or `ctx.storage.sql` parameters; never string-concatenate user input into SQL (see [durable-objects.md](durable-objects.md) § Storage).
- **Trust-boundary crossings** — when a design crosses a trust boundary (client → Gateway → DO, or DWL sandbox → host), name it and confirm the receiving side re-validates rather than trusting the sender.
