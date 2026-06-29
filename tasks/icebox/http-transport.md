# HTTP Transport

> 🧊 **Iceboxed 2026-06-22.** Complete spec, no consumer — the demo (and current product) runs entirely over Mesh/WebSocket. Revive as a v2 item if a REST consumer appears.

**Status**: On Hold — post-demo (the demo runs entirely over Mesh/WebSocket; REST transport is not on the critical path)

**Depends on**: Phase 5.2.3 (Ontology & Resources Integration)

> De-numbered from "Phase 5.6" 2026-06-15 — this is deferred work, not a gating step in the Phase 5 sequence.

## Scope

REST endpoints for resource operations. `If-Match` header for optimistic concurrency. `GET /discover` endpoint. Content type: `application/vnd.lumenize.structured-clone+json`.

## HTTP Method → `transaction()` Operation Mapping

Each HTTP method maps 1:1 to an `OperationDescriptor` variant from `resources.ts`:

| HTTP Method | Operation | Semantics |
|---|---|---|
| `POST` | `create` | Create a new resource. Body is the full value. `typeName` and `nodeId` required. |
| `PUT` | `put` | Full replacement of an existing resource. Body is the complete new value — all required fields must be present. `If-Match` header carries the eTag for optimistic concurrency. |
| `GET` | (read) | Read a resource. Not a `transaction()` operation — calls `resources.read()` directly. |
| `DELETE` | `delete` | Delete a resource. `If-Match` header carries the eTag. |
| `MOVE` (custom) | `move` | Move a resource to a different DAG node. `If-Match` header carries the eTag. May use a custom HTTP method or a `POST` with action parameter — TBD. |

### Why `PUT`, not `PATCH`

The `put` operation (Phase 5.2.3) is a **full replacement** — the caller sends the complete value, not a partial diff. This maps naturally to HTTP `PUT` (idempotent, full representation). The operation was deliberately named `put` to make this 1:1 mapping explicit.

**`PATCH` (partial update) is an open question.** Adding a `patch` operation would require:
- Deciding on merge semantics (shallow merge? deep merge? JSON Merge Patch RFC 7386? JSON Patch RFC 6902?)
- Merging the patch with the existing value, then validating the full merged result against the ontology's type definitions
- Handling relationship fields in the merge (replace array? append? remove?)

None of this is needed for the initial transport layer. If `PATCH` is added later, it would be a new `patch` variant in `OperationDescriptor` with its own merge-then-validate strategy, not a change to `PUT`/`put`.

## Open Questions

- **Batch endpoint**: `transaction()` accepts multiple operations atomically. Should there be a batch HTTP endpoint (e.g., `POST /batch`) that maps to a single `transaction()` call with multiple operations? Or is single-resource-per-request sufficient initially?
- **`MOVE` method**: Custom HTTP method, or `POST /resources/{id}/move` with `nodeId` in body?
- **Error response format**: `TransactionError` discriminated union maps naturally to JSON. What HTTP status codes? `409 Conflict` for eTag conflicts, `422 Unprocessable Entity` for validation failures?
- **Content negotiation**: Always `application/vnd.lumenize.structured-clone+json`, or support plain `application/json` fallback?
