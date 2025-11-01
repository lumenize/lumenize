# Cap'n Web Type Support Upgrade

**Status**: Active
**Started**: 2025-01-27

## Goal
Upgrade Cap'n Web to support all types that Workers RPC supports (except ReadableStream/WritableStream and cycles/aliases). Extract reusable serialization logic from `@lumenize/structured-clone` and adapt it to Cap'n Web's format. Create a pull request to the upstream Cap'n Web repository.

## Context
- Cap'n Web is a JavaScript-native RPC system by Cloudflare
- Currently missing support for: RegExp, Map, Set, ArrayBuffer, special numbers (NaN, ±Infinity), URL, and improved Error serialization
- We have well-isolated serializers in `packages/structured-clone` that we can extract and adapt
- Cap'n Web author explicitly doesn't want cycles/aliases support
- Cap'n Web serialization is **synchronous** (no async/await)
- Cap'n Web uses simple array format: `["type", ...params]` (e.g., `["bigint", "123"]`, `["date", 1234]`)
- Cap'n Web prides itself on "<10kB with no dependencies"

## Design Decisions

### Serialization Approach
**Decision**: Extract serialization logic from structured-clone and adapt it to Cap'n Web's format, inlining the code (no dependency).

**Rationale**:
- Our format uses indexed records with cycle support (`[[TYPE_NUMBER, value], ...]`); Cap'n Web uses simple arrays (`["type", data]`)
- Our serialization is async; Cap'n Web is synchronous
- Cap'n Web explicitly rejects cycle/alias support
- Adding a dependency would violate Cap'n Web's "no dependencies" goal
- Extracting and adapting logic maintains code reuse while respecting Cap'n Web's constraints

**Alternatives Considered**:
- Direct import from `@lumenize/structured-clone`: Rejected due to format mismatch, async/sync mismatch, and dependency requirement

---

### Special Numbers Format
**Decision**: Use `["special-number", "NaN"]`, `["special-number", "Infinity"]`, `["special-number", "-Infinity"]` format.

**Rationale**:
- Matches Cap'n Web's `["type", param]` pattern consistently
- Simple string-based type indicator
- Easy to deserialize

**Alternatives Considered**:
- Marker object format (`{__lmz_NaN: true}`): Rejected because it breaks Cap'n Web's simple array pattern and would require `["primitive", {__lmz_NaN: true}]` which is inconsistent

---

### Headers Support
**Decision**: Headers is not currently supported and should be added.

**Rationale**:
- Headers appears in Cap'n Web's TypeScript type definitions (`types.d.ts`) but only as a type annotation, not serialization support
- `typeForRpc()` returns "unsupported" for Headers instances (no case for Headers.prototype)
- No serialization logic exists in `Devaluator.devaluateImpl()` for Headers
- Cap'n Web README explicitly lists Headers as "not supported as of this writing, but may be added in the future"
- Our type support table correctly marks Headers as not supported
- Headers can be serialized synchronously (no async body reading required)

---

### Web API Objects
**Decision**: 
- ✅ Include URL (can be serialized synchronously)
- ✅ Include Headers (can be serialized synchronously)
- ❌ Skip Request/Response (require async body reading, which would be a major breaking change)

**Rationale**:
- Cap'n Web serialization is synchronous (`JSON.stringify(Devaluator.devaluate(value))`)
- Request/Response require `await request.text()` / `await response.text()` to read bodies
- Making Cap'n Web serialization async would be a major breaking change affecting the entire codebase
- URL can be serialized as a string (`url.href`) synchronously
- Headers can be serialized synchronously by iterating entries (`headers.forEach()`) - no async operations needed

---

### Error Serialization
**Decision**: Upgrade Error serialization to full fidelity, preserving name, message, stack, cause (recursive), and custom properties.

**Rationale**:
- Workers RPC (also from Cloudflare) has better Error support than Cap'n Web
- This appears to be an oversight rather than intentional limitation
- Full fidelity improves debugging and error handling

**Current Cap'n Web Format**: `["error", name, message, stack?]`

**Proposed Format**: `["error", name, message, stack?, cause?, customProps?]` where:
- `cause` is recursively serialized (may be another Error)
- `customProps` is an object of key-value pairs for custom error properties

---

## Implementation Plan

### Phase 1: Document Format Requirements
- [ ] Document exact serialization format for each new type:
  - Special numbers: `["special-number", "NaN"]` format
  - RegExp: `["regexp", {source, flags}]` format
  - Map: `["map", [[key1, val1], [key2, val2], ...]]` format (entries array, recursive)
  - Set: `["set", [val1, val2, ...]]` format (values array, recursive)
  - ArrayBuffer: `["arraybuffer", "base64string"]` format
  - URL: `["url", "https://..."]` format
  - Headers: `["headers", {...headerObject}]` or `["headers", [[key1, val1], ...]]` format
- [ ] Document Error format extension for full fidelity

### Phase 2: Extract Serialization Logic
- [ ] Create Cap'n Web-adapted serializers (extract from structured-clone):
  - Special numbers: `["special-number", "NaN"]`
  - RegExp: `["regexp", {source, flags}]`
  - Map: `["map", [[key1, val1], [key2, val2], ...]]` (recursive, depth-limited, no cycles)
  - Set: `["set", [val1, val2, ...]]` (recursive, depth-limited, no cycles)
  - ArrayBuffer: `["arraybuffer", "base64string"]`
  - URL: `["url", "https://..."]`
- [ ] Extract Error serialization logic and adapt to Cap'n Web format with full fidelity
- [ ] Ensure all serializers are synchronous (no async/await)
- [ ] Ensure no cycle/alias support (simple recursion with depth limit only)

### Phase 3: Integrate into Cap'n Web
- [ ] Add `typeForRpc()` cases for: RegExp, Map, Set, ArrayBuffer, special numbers, URL, Headers
- [ ] Add serialization in `Devaluator.devaluateImpl()` for all new types
- [ ] Add deserialization in `Evaluator.evaluateImpl()` for all new types
- [ ] Upgrade Error serialization to full fidelity format
- [ ] Add Headers serialization support

### Phase 4: Testing and Validation
- [ ] Write comprehensive tests matching Cap'n Web's test style
- [ ] Test all new types round-trip serialization/deserialization
- [ ] Test edge cases:
  - Empty Map/Set
  - Special RegExp flags (global, multiline, etc.)
  - NaN, Infinity, -Infinity
  - Nested structures (Map of Maps, Set of Sets, etc.)
  - Error with cause chain
  - Error with custom properties
- [ ] Verify no cycle/alias support accidentally included (test circular references throw depth error)
- [ ] Run existing Cap'n Web test suite to ensure no regressions

### Phase 5: Prepare Pull Request
- [ ] Review Cap'n Web contribution guidelines
- [ ] Ensure code follows Cap'n Web style:
  - Synchronous functions (no async/await in serialize/deserialize)
  - No dependencies (inline all code)
  - Match existing code style and patterns
- [ ] Update documentation:
  - `README.md` - Add new types to supported list
  - `protocol.md` - Document new serialization formats
- [ ] Create clean commit history
- [ ] Prepare PR description with:
  - Summary of types added
  - Format specifications for each type
  - Test results
  - Examples of usage
