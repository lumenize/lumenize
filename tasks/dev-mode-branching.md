# Dev-Mode Storage Branching

**Status**: Stub — design deferred
**Depends on**: `tasks/typia-validator-engine.md`, lazy-migration infrastructure (already decided for prod)

## Objective

Dev loop for vibe coders that does not require `wrangler dev` against the full Nebula stack. The target audience writes TypeScript interfaces — they should not have to manage local D1/KV/R2 bindings, ports, or wrangler configs.

## Approach (sketch)

Test Galaxy + Star pair with copy-on-write storage layered over live storage. Dev Star reads through to live on miss, writes only locally. The lazy-migration mechanism that prod already uses covers schema-version drift on read-through (dev branch on new ontology, live data on old ontology).

## Design points to pin down when the task activates

- Write isolation (ORM relationship traversals must not leak writes back through the read path)
- Lifetime (tie dev Stars to a dev session; TTL or explicit teardown via CLI)
- Multi-dev namespacing (keyed by user/session, not by app)
- Target dev loop: agentic editor → test Galaxy → DW compile → test Star → browser hot-reload, no wrangler
