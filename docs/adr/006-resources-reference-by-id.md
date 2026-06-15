# ADR-006: Resources Reference Each Other by Id (Relationships Are Separate Ops, Never Embedded)

**Date**: 2026-06-15
**Status**: Accepted
**Deciders**: Larry
**Evidence / history**: `packages/ts-runtime-parser-validator/src/extract-type-metadata.ts` (`writeShapeTypeDefinitions` — relationship refs rewritten to `string` / `string[]`), `apps/nebula/src/galaxy.ts` (`compileOntologyVersion`), `packages/ts-runtime-parser-validator/src/generate-parse-module.ts` (`__enrichRelationshipErrors` — the loud warning), `apps/nebula/src/resources.ts` (`transaction` = atomic multi-op), `.claude/.../feedback_no_server_generated_ids` (client-supplied UUIDs), ADR-004 (per-resource snapshot sequences). Surfaced 2026-06-15 by a cyclic-value diagnostic: a test set `value.self = value` (an embedded, cyclic object) on a relationship field and read the by-id rejection as a bug.

## Context

The ontology lets a field's declared type be another ontology type — `owner: User`, `self?: RichResource`, `members: User[]`. At the value level that admits two readings: **embed** the referenced resource as a nested object, or **reference** it by id.

A fresh contributor — or a fresh LLM session — reaches for embedding, because the JSON-document mental model says "nest the child inside the parent." That is exactly what happened: a test embedded a cyclic object into a relationship field and the validator's by-id rejection looked like a structured-clone / typia bug. It was neither.

Three existing commitments constrain the answer:

- **No server-generated ids.** Entity ids are client-supplied UUIDs, never minted by the server.
- **ADR-004 — each resource is its own independently-versioned snapshot sequence.** A nested sub-object is not a resource; it has no history of its own.
- **References can cross Stars.** A relationship target may live in a different Resources DO entirely.

## Decision

**A field typed as a reference to another ontology type is a *relationship*, expressed by id (foreign key). Resources are never embedded inside one another. Related resources are created and updated as separate ops within one atomic transaction; the client supplies every id and wires the foreign keys.**

- The ontology **write shape** rewrites relationship refs to `string` / `string[]` — the id form the wire and storage use (`extractTypeMetadata().writeShapeTypeDefinitions`). Validation enforces it: a reference field accepts an id string (or array of id strings), not an object.
- **Nesting is reserved for composition *within* a single resource.** Inline object/array fields (`address: { city: string }`) are part of that one resource's value and its single snapshot. A resource's value round-trips the full structured-clone space — `Map`, `Date`, cycles, aliased sub-objects (ADR-002) — but that richness lives *inside* one value; it does not reach *across* resource references, which are always ids.
- **A transaction is a map of independent ops that commit atomically** (single `validFrom`/`eTag`, `transactionSync`; idempotent via `newETag` — ADR-005). "Create a parent and its children together" is N ops in one `transaction(...)` call, each with a client-supplied UUID and reference fields pointing at sibling ids.
- **Embedding an object where an id belongs is a loud, actionable error** — the generated validator names the field and target type and says "reference by id," rather than emitting a bare `expected "(string | undefined)"`.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Server decomposes a nested parent-child object into resources + FKs | Forces server-generated child ids (banned); reintroduces the embed-vs-reference ambiguity we now reject loudly; and it would only fan out into the same per-resource snapshot sequences the client can address explicitly. Convenience bought with three violations. |
| Embed related resources as nested values (document-DB style) | Breaks ADR-004 independent historization — a sub-object isn't its own snapshot sequence; can't span Stars; and duplicates a shared resource at every reference site. |
| Keep it implicit (no contract, no warning) | Relitigation-by-default: every fresh session re-proposes embedding. The bare typia error gives no hint why. |

## Consequences

### Positive
- **One model across wire, storage, and client.** Each resource is a row / snapshot sequence; relationships are FK columns; the client's mental model matches storage exactly.
- Respects no-server-generated-ids and ADR-004 independent historization, and composes with ADR-005 atomic+idempotent transactions.
- **Cross-Star references work** — an id is just a string, eventually-consistent, never an embedded object.
- The loud warning teaches the contract at the point of violation, so the footgun self-corrects (Nebula "no foot-guns" principle).

### Negative / open
- **More work for the client** — generate ids, wire FKs, send N ops. Mitigated: the client supplies ids regardless, and explicit structure is easier for an LLM to reason about and inspect than server-side magic.
- **Referential integrity is NOT enforced today.** Validation checks only that a reference is a well-formed id string; a dangling / nonexistent id is accepted. Whether to enforce "the referenced resource exists, or is created in the same transaction" is a **deferred decision, scoped to intra-Star same-transaction FKs** — cross-Star references are ids that can't be checked at write time and stay eventually-consistent. Tracked in `tasks/backlog.md`.
