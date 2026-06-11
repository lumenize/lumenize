# ADR-002: Full structured-clone Value Space, End-to-End

**Date**: 2026-06-11 (records a commitment made at project start and held since)
**Status**: Accepted
**Deciders**: Larry
**Evidence / history**: `tasks/archive/decision-structured-clone-format-*.md` (format research), `tasks/archive/structured-clone-object-based-wire-format.md` (W4 wire format + RFC 7396 diffs), `packages/structured-clone/`

## Context

Lumenize moves user data across many surfaces: the Mesh wire, DO storage, runtime validation, diff/merge-patch fanout, resource history. JSON's value space is far smaller than JavaScript's — Date, Map, Set, RegExp, Error, TypedArrays, BigInt, `undefined`, NaN/±Infinity, cycles, and aliasing all silently corrupt or throw under JSON round-trips.

While Mesh users are coders, Nebula's user-developers often have no coding experience: they write plain JavaScript values and struggle to debug a Date that came back as a string. The platform had to decide, once, which value space it promises to round-trip.

## Decision

**Every Lumenize surface round-trips the full structured-clone value space, plus extensions:**

- all standard structured-clone types (Date, Map, Set, RegExp, ArrayBuffer/TypedArrays, BigInt, …)
- special numbers (NaN, ±Infinity, -0) and `undefined`
- cycles and aliases, with **identity preserved** — the same object referenced twice deserializes as the same object
- extensions beyond the spec: Errors with stack traces and custom properties (the carrier for Mesh's typed-error design), Web API objects (Request, Response, Headers, URL)

"Surface" means all of them: wire format, storage, validation (`toTypeScript()` is cycle-aware), diff/patch (RFC 7396 adapted to the W4 format), history. **A new surface that only handles JSON is not done.** This is what licenses the docs to promise "write the same way you'd write any in-memory JS object."

## Alternatives considered

| Approach | Why rejected |
|---|---|
| JSON-only value space | Silent corruption (Date→string, Map→`{}`, `undefined` drops). The user least equipped to debug serialization is exactly Nebula's target user. |
| Ecosystem serializers (superjson, devalue, Cap'n Web's serialization) | Partial type coverage, missing or partial cycle/alias identity, dependency risk. (Cap'n Web's format did inform the readable-format research.) |
| Supported subset with warnings | Violates the no-footguns principle; "sometimes works" is worse than either extreme. |

## Consequences

### Positive
- User-developers and Studio's LLM use plain JS values everywhere; there is no serialization vocabulary to learn or teach.
- Typed errors traverse Mesh hops intact (stack, custom props).
- The commitment has already survived a full mechanism swap — indexed tuple format → W4 object-based (2026-05-16, [PR #11](https://github.com/lumenize/lumenize/pull/11)) — confirming the value-space promise, not the encoding, is the stable part.

### Negative
- Every new surface pays a structured-clone tax: it must go through `@lumenize/structured-clone` (or prove full round-trip) rather than adopting off-the-shelf JSON tooling. RFC 7396 had to be adapted; validation needed cycle-aware program generation.
- Wire and storage payloads are a custom encoding — external tools inspecting them see the W4 format, not plain JSON.
