# Fork @ungap/structured-clone to @lumenize/structured-clone

**Status**: Planning
**Started**: 2025-10-30

## Goal

Create @lumenize/structured-clone - a fork of @ungap/structured-clone with Lumenize-specific extensions for serializing/deserializing complex types used in RPC, including Errors, Web API objects (Request, Response, Headers, URL), and special numbers (NaN, Infinity, -Infinity).

## Motivation

### Current Problem

Our RPC system splits serialization across two layers:

```
Server (lumenize-rpc-do.ts):
  preprocessResult() - walks object, converts special types to markers
    ↓
  @ungap/structured-clone stringify() - walks again, handles cycles
    ↓
  [wire as JSON string]
    ↓
  @ungap/structured-clone parse()
    ↓
Client (client.ts):
  postprocessResult() - walks again, converts markers back to objects
```

**Issues**:
1. **Three object walks**: preprocessResult → structured-clone → postprocessResult
2. **Messy separation**: Transport layer must know about client/server preprocessing
3. **Duplication**: Cycle detection in both our code and structured-clone
4. **Complexity**: Hard to maintain, easy to break
5. **Confusing names**: AI agents think `serialize()` returns a string (it doesn't)

### Proposed Solution

**Single unified package** handling all serialization:

```
@lumenize/structured-clone:
  stringify(value) - one walk, handles everything, returns JSON string
  parse(value) - inverse of stringify
  preprocess(value) - one walk, returns processed object (not string)
  postprocess(value) - inverse of preprocess
```

**Benefits**:
1. ✅ **One object walk**: Hook into structured-clone's traversal
2. ✅ **Clean separation**: Transport only imports @lumenize/structured-clone
3. ✅ **No duplication**: Single cycle detection implementation
4. ✅ **Easier to maintain**: All serialization logic in one place
5. ✅ **Clear API**: Method names match their behavior
6. ✅ **Robust tests**: Build on @ungap's excellent test suite
7. ✅ **Smaller package**: Eliminate duplicated code

## Current @ungap/structured-clone API

```typescript
// @ungap/structured-clone exports:
import { serialize, deserialize } from '@ungap/structured-clone';
import { stringify, parse } from '@ungap/structured-clone/json';

// In-memory cloning (structured clone algorithm)
const cloned = serialize(value);     // Returns processed object (NOT string!)
const restored = deserialize(value); // Inverse

// JSON serialization (what we use for RPC)
const jsonString = stringify(value);  // Returns JSON string
const restored = parse(jsonString);   // Inverse
```

**Key insight**: `serialize()`/`deserialize()` are confusingly named - they return objects, not strings!

## Proposed @lumenize/structured-clone API

```typescript
// @lumenize/structured-clone exports:

/**
 * Convert value to JSON string with full type support.
 * Handles cycles, Errors, Web API objects, special numbers, etc.
 * Async to support Request/Response body reading.
 * One-step: value → string
 */
export async function stringify(value: any): Promise<string>;

/**
 * Restore value from JSON string.
 * Inverse of stringify().
 * One-step: string → value
 */
export async function parse(value: string): Promise<any>;

/**
 * Preprocess value for serialization without converting to string.
 * Returns processed object ready for JSON.stringify().
 * Use when you need control between processing and stringification.
 * Async to support Request/Response body reading.
 * Two-step: value → processed object
 */
export async function preprocess(value: any): Promise<any>;

/**
 * Restore value from preprocessed object.
 * Inverse of preprocess().
 * Two-step: processed object → value
 */
export async function postprocess(value: any): Promise<any>;
```

### API Rationale

**Why `stringify`/`parse`?**
- Matches @ungap/structured-clone/json (already exists)
- Clear: returns/accepts string
- Familiar: like JSON.stringify/parse but with superpowers

**Why `preprocess`/`postprocess`?**
- ✅ Matches our existing terminology (`preprocessResult`, `postprocessResult`)
- ✅ Clear semantics: "prepare before" / "restore after"
- ✅ Not confusing like "serialize" (which sounds like it should return string)
- ✅ Conceptually accurate: they're processing steps, not serialization
- ✅ Shorter than `serializeToObject`/`deserializeToObject`

**When to use each**:
```typescript
// Simple case: stringify/parse (one-step)
const json = await stringify(complexObject);
const restored = await parse(json);

// Advanced case: preprocess/postprocess (two-step)
// Useful for batching, compression, or custom transport
const processed = await preprocess(complexObject);  // Still an object
const json = JSON.stringify(processed);             // Now a string
// ... custom handling (compress, batch, etc.) ...
const parsed = JSON.parse(json);                    // Back to object
const restored = await postprocess(parsed);         // Back to live objects
```

## Special Type Support

### Types We Already Support (to preserve)

1. **Native structured-clone types** (from @ungap):
   - Date, RegExp, Map, Set, TypedArrays
   - ArrayBuffer, DataView
   - Circular references and aliases
   - undefined, null, boolean, number, string, bigint
   - Plain objects and arrays

2. **Special numbers** (our custom extension):
   - NaN, Infinity, -Infinity
   - Currently handled via markers: `{ __isNaN: true }`, etc.

3. **Error objects** (our custom extension):
   - Error, TypeError, RangeError, etc.
   - Preserves: message, name, stack, cause
   - Currently converted to: `{ __isError: true, name, message, stack, cause }`

4. **Web API objects** (our custom extension):
   - Request: url, method, headers, body (as text)
   - Response: status, statusText, headers, body (as text)
   - Headers: converted to object
   - URL: converted to string
   - Currently marked: `{ __isSerializedWebApiType: true, type: 'Request', ... }`

5. **Error thrown vs Error as value** (our custom extension):
   - Current RPC distinguishes between thrown errors and errors returned as values
   - Server catches thrown errors and marks them differently
   - Client can rethrow vs handle as value
   - **Implementation options**:
     - **Option A**: Add non-standard property to Error object (e.g., `__lmz_thrown`)
     - **Option B**: Check if top-level payload is Error → assume thrown
   - **Decision**: TBD during implementation (likely Option B for simplicity)

### Implementation Strategy

**Approach: Full fork with custom extensions**
- Fork @ungap/structured-clone completely (no dependency)
- Find their object walker (likely in serialize/deserialize)
- Add custom handling for our special types during traversal
- One walk handles everything

**Why full fork (not wrapper)**:
- ✅ **Supply chain security**: Can claim "zero runtime dependencies"
- ✅ **Performance**: One object walk vs two
- ✅ **Control**: Can modify internals as needed
- ✅ **Async API**: Can make breaking changes without affecting upstream

**Note**: @ungap/structured-clone is currently our only runtime dependency. Eliminating it has security value.

## Package Structure

```
packages/structured-clone/
├── package.json          # MIT license, follows Lumenize package patterns
├── tsconfig.json         # Extends root, Cloudflare Workers compatible
├── tsconfig.build.json   # Build-time config
├── src/
│   ├── index.ts          # Main exports (stringify, parse, preprocess, postprocess)
│   ├── core.ts           # Fork of @ungap's core logic
│   ├── special-types.ts  # Lumenize extensions (Errors, Web API, etc.)
│   ├── markers.ts        # Marker constants and type guards
│   └── types.ts          # TypeScript types
├── test/
│   ├── core.test.ts      # Tests from @ungap (ported)
│   ├── errors.test.ts    # Error serialization tests
│   ├── web-api.test.ts   # Web API object tests
│   ├── special-numbers.test.ts
│   ├── circular.test.ts  # Circular reference tests
│   └── performance.test.ts
├── README.md
└── LICENSE               # MIT
```

## Implementation Phases

### Phase 0: Setup and Research ✅ COMPLETE

**Goal**: Fork repository, understand @ungap's internals, set up package structure.

**Changes**:
- [x] Research @ungap/structured-clone implementation
  - Found GitHub repository: https://github.com/ungap/structured-clone
  - Identified object walker in `serialize.js` using `serializer()` closure
  - Uses type constants (VOID, PRIMITIVE, ARRAY, OBJECT, DATE, REGEXP, MAP, SET, ERROR, BIGINT)
  - `typeOf()` helper for type detection using `toString.call(value)`
  - Tracks visited objects with Map for cycle detection
  - `deserialize.js` uses `deserializer()` closure with similar pattern
  - Simple, clean architecture - perfect for extension
- [x] Create package directory structure
  - `packages/structured-clone/` with standard Lumenize layout
  - Copied package.json template and adapted
  - Set up tsconfig.json (extends root, Node types)
  - Set up tsconfig.build.json for publish builds
  - Set up vitest.config.js with multi-environment test matrix
    - Node.js project: Standard npm usage, runs all test files
    - Workers project: Cloudflare Workers (primary use case), runs same tests
    - Named projects display as `|node|` and `|workers|` in output
    - Scripts: `test:node`, `test:workers`, `test` (runs both)
    - Each test runs in both environments = 2× test coverage
- [x] License and attribution
  - Copied ISC license from @ungap/structured-clone (preserved original copyright)
  - Added Lumenize copyright for extensions
  - Created root ATTRIBUTIONS.md with full attribution
  - README acknowledges fork and original author
- [x] Initial package.json
  - `"name": "@lumenize/structured-clone"`
  - `"license": "ISC"` (preserved from original)
  - `"type": "module"`
  - `"main": "src/index.ts"`
  - Zero dependencies (forking the code)
- [x] Created placeholder exports (src/index.ts)
  - `stringify`, `parse`, `preprocess`, `postprocess` (all async, throw "not implemented")
  - Full JSDoc comments explaining purpose
  - Ready for Phase 1 implementation

**Testing**:
- [x] Package builds successfully
- [x] Can import from other packages via workspace
- [x] Multi-environment test matrix works perfectly
  - Node.js: ✓ 5 tests passing
  - Workers: ✓ 5 tests passing
  - Total: 10 test executions (5 tests × 2 environments)
  - Ensures compatibility across both target environments

**Key Findings from Research**:
1. **Object Walker**: `serializer()` creates a `pair()` function that recursively walks objects
2. **Type Detection**: Uses `typeof` + `toString.call()` for robust type detection
3. **Cycle Handling**: Map tracks `value → index` to detect revisited objects
4. **Output Format**: Array of `[TYPE, value]` tuples, indexed for cross-references
5. **Clean Hooks**: Easy to add custom type handling in `typeOf()` switch cases
6. **Deserializer**: Mirrors serializer structure, reconstructs from indices
7. **JSON Support**: `json.js` wraps serialize/deserialize with `JSON.stringify/parse`

**Browser Testing (Future)**:
- Browser environment testing deferred (JSDom not realistic enough)
- Could add browser project with Playwright or similar in the future
- Not blocking for Phase 1 - Node + Workers coverage is sufficient

**Next Steps**: Ready for Phase 1 - Port core functionality

### Phase 1: Port Core Functionality ✅ COMPLETE

**Goal**: Port @ungap/structured-clone core to our package, verify basic functionality.

**Changes**:
- [x] Port @ungap's core serialization logic
  - Created `src/types.ts` with type constants (VOID, PRIMITIVE, ARRAY, etc.)
  - Created `src/serialize.ts` with full serializer implementation
    - Object traversal using closure pattern
    - Cycle detection with Map tracking
    - Native type handling (Date, Map, Set, Error, BigInt, TypedArrays)
    - Lossy mode for functions/symbols
  - Created `src/deserialize.ts` with full deserializer
    - Mirrors serializer structure
    - Reconstructs all types from indices
    - Handles circular references correctly
- [x] Implement initial API in `src/index.ts`
  - `stringify()` - combines serialize() + JSON.stringify()
  - `parse()` - combines JSON.parse() + deserialize()
  - `preprocess()` - returns serialize() output (array of records)
  - `postprocess()` - calls deserialize() on preprocessed data
  - All functions async (ready for Phase 4 additions)
  - Re-exports types for users
- [x] Create comprehensive test suite
  - 34 test cases covering all functionality
  - Tests run in both Node and Workers environments
  - All tests passing (68 total: 34 × 2 environments)

**Testing**:
- [x] All tests pass in both environments (68/68)
- [x] Native types work: Date ✓ Map ✓ Set ✓ RegExp ✓ BigInt ✓
- [x] TypedArrays work: Uint8Array ✓ Int16Array ✓ Float32Array ✓ ArrayBuffer ✓ DataView ✓
- [x] Error objects serialized with message preservation ✓
- [x] Circular references: objects ✓ arrays ✓ Maps ✓ Sets ✓ complex structures ✓
- [x] Primitives: undefined ✓ null ✓ boolean ✓ number ✓ string ✓
- [x] Arrays and objects with nesting ✓
- [x] Wrapper types: Boolean ✓ Number ✓ String ✓ BigInt ✓
- [x] Function markers: objects ✓ arrays ✓ nested structures ✓ operation chains ✓
- [x] Symbol handling: throws on values ✓ throws in Maps ✓ throws in Sets ✓
- [x] Preprocess/postprocess workflow ✓
- [x] No linter errors
- [x] Total: 38 test cases × 2 environments = 76 tests passing

**Implementation Notes**:
1. Ported from @ungap/structured-clone v1.3.0 with major enhancements
2. **Function marker support** - functions converted to `{ __lmz_Function: true, __operationChain, __functionName }`
   - Eliminates need for separate preprocessing walk in RPC layer
   - Operation chains tracked during traversal
   - Ready for future Cap'n Web-style function passing
   - ONE recursive object walk (vs two before)
3. **Strict symbol handling** - always throws TypeError on symbol values
   - Symbols non-serializable by design
   - Symbol keys on objects naturally skipped by Object.keys()
   - Symbol keys in Maps throw (they get enumerated)
4. Error subclass types not preserved (TypeError → Error) - limitation of original
5. Currently synchronous internally, wrapped in async for future compatibility
6. Accepts baseOperationChain parameter for RPC integration

### Phase 2: Add Special Number Support

**Goal**: Add NaN, Infinity, -Infinity handling during core traversal.

**Status**: ✅ Complete

**Changes**:
- [x] Define markers in `src/special-numbers.ts` ✓
  ```typescript
  export interface NaNMarker { __lmz_NaN: true; }
  export interface InfinityMarker { __lmz_Infinity: true; }
  export interface NegInfinityMarker { __lmz_NegInfinity: true; }
  ```
- [x] Add special number detection utilities ✓
  - `isSpecialNumber(value)` - returns true for NaN, ±Infinity
  - `serializeSpecialNumber(value)` - converts to marker
  - `deserializeSpecialNumber(marker)` - converts back
  - `isSerializedSpecialNumber(value)` - type guard
- [x] Hook into core traversal ✓
  - In `serialize.ts`: detect and convert before typeOf
  - In `deserialize.ts`: detect markers and restore in PRIMITIVE case
- [x] Export from `index.ts` ✓

**Testing**:
- [x] Test NaN serialization/deserialization ✓
- [x] Test Infinity serialization/deserialization ✓
- [x] Test -Infinity serialization/deserialization ✓
- [x] Test in arrays: `[1, NaN, 2]` ✓
- [x] Test in objects: `{ a: 1, b: Infinity }` ✓
- [x] Test nested: `{ data: [NaN, { x: Infinity }] }` ✓
- [x] Test in Maps and Sets ✓
- [x] Test in circular references ✓
- [x] Test preprocess/postprocess workflow ✓
- [x] Document -0 limitation (JSON converts to +0) ✓

**Test Results**:
- Total: 55 test cases × 2 environments = 110 tests passing
- Special numbers: 17 test cases covering all scenarios
- No linter errors

### Phase 3: Add Error Support

**Goal**: Add Error object serialization with full fidelity.

**Changes**:
- [ ] Define Error marker in `src/markers.ts`
  ```typescript
  export interface ErrorMarker {
    __lmz_Error: true;
    name: string;
    message: string;
    stack?: string;
    cause?: any;
  }
  ```
- [ ] Add Error handling in `src/special-types.ts`
  - `isErrorObject(value)` - checks for Error instances
  - `serializeError(error)` - extracts name, message, stack, cause
  - `deserializeError(marker)` - reconstructs Error with proper type
  - Handle Error subclasses: TypeError, RangeError, etc.
- [ ] Hook into core traversal
  - During preprocess: detect Error and convert to marker
  - During postprocess: detect ErrorMarker and reconstruct
  - Recursively handle `cause` (Error can have Error as cause)

**Testing**:
- [ ] Test basic Error serialization
- [ ] Test Error subclasses (TypeError, RangeError, etc.)
- [ ] Test Error with cause
- [ ] Test Error with nested cause (Error → Error → Error)
- [ ] Test Error in arrays and objects
- [ ] Test Error message and stack preserved
- [ ] Test custom Error properties (best effort)

### Phase 4: Add Web API Object Support

**Goal**: Add Request, Response, Headers, URL serialization.

**Changes**:
- [ ] Define Web API markers in `src/markers.ts`
  ```typescript
  export interface WebApiMarker {
    __lmz_WebApi: true;
    type: 'Request' | 'Response' | 'Headers' | 'URL';
    data: any;
  }
  ```
- [ ] Add Web API handling in `src/special-types.ts`
  - `isWebApiObject(value)` - checks for Request, Response, Headers, URL
  - `serializeRequest(req)` - extract url, method, headers, body
  - `deserializeRequest(marker)` - reconstruct Request
  - `serializeResponse(res)` - extract status, headers, body
  - `deserializeResponse(marker)` - reconstruct Response
  - `serializeHeaders(headers)` - convert to plain object
  - `deserializeHeaders(obj)` - reconstruct Headers
  - `serializeURL(url)` - convert to string
  - `deserializeURL(str)` - reconstruct URL
- [ ] Hook into core traversal
  - Handle async body reading (Request/Response.text())
  - Make preprocess/stringify async (required for Request/Response)
  - Handle Headers iteration
- [ ] Update API signatures to async
  ```typescript
  export async function stringify(value: any): Promise<string>;
  export async function parse(value: string): Promise<any>;
  export async function preprocess(value: any): Promise<any>;
  export async function postprocess(value: any): Promise<any>;
  ```

**Testing**:
- [ ] Test Request serialization (all methods: GET, POST, etc.)
- [ ] Test Request with body
- [ ] Test Response serialization (all status codes)
- [ ] Test Response with body
- [ ] Test Headers serialization
- [ ] Test URL serialization
- [ ] Test nested Web API objects
- [ ] Test Web API objects in arrays/objects
- [ ] Test async/await in all use cases

### Phase 5: Documentation and Examples

**Note on Performance Optimization**: Deliberately skipped. Network round-trip cost dominates RPC performance, making serialization performance differences negligible. Prioritizing quality and shipping speed over micro-optimization. Will address if performance becomes a real issue.

**Goal**: Document the package with working examples.

**Changes**:
- [ ] Create package README.md
  - Overview of fork and extensions
  - API documentation (stringify, parse, preprocess, postprocess)
  - Supported types list
  - Basic usage examples
  - Link to website docs
- [ ] Add website docs at `website/docs/structured-clone/`
  - Overview page
  - API reference
  - Type support guide
  - Migration guide (from direct @ungap usage)
  - Performance notes
- [ ] Create examples
  - Basic usage (stringify/parse)
  - Advanced usage (preprocess/postprocess)
  - Error handling
  - Web API objects
  - Circular references
- [ ] Add JSDoc comments
  - All public functions
  - Type definitions
  - Examples in JSDoc

**Testing**:
- [ ] All examples in docs are @check-example validated
- [ ] README examples work
- [ ] API docs are accurate

## Design Decisions

### 1. Fork vs Wrapper

**Question**: Should we fork @ungap/structured-clone or wrap it?

**Decision**: ✅ **Full fork** (no dependency on @ungap/structured-clone).

**Rationale**:
- **Supply chain security**: Can claim "zero runtime dependencies" (valuable for enterprise adoption)
- **Need to hook into object traversal**: Hard to do externally
- **Eliminate double-walk**: Performance improvement
- **Async API**: Breaking change incompatible with upstream
- **Custom naming**: preprocess/postprocess vs serialize/deserialize
- **@ungap is mature and stable**: Low maintenance burden

**Trade-offs accepted**:
- ✅ More control, better performance, zero dependencies
- ❌ Maintenance burden (but @ungap is stable)
- ❌ Can't easily pull upstream changes (acceptable)

### 2. Async vs Sync API

**Question**: Should stringify/parse be async to handle Request/Response bodies?

**Decision**: ✅ **Option A - Fully async API**.

```typescript
export async function stringify(value: any): Promise<string>;
export async function parse(value: string): Promise<any>;
export async function preprocess(value: any): Promise<any>;
export async function postprocess(value: any): Promise<any>;
```

**Rationale**:
- ✅ Handles Request/Response bodies correctly (must be async)
- ✅ Clean, consistent API (all methods async)
- ✅ No foot-guns (can't forget to pre-read bodies)
- ✅ Transport layer already expects async (not user-facing)
- ❌ Breaking from JSON.stringify/parse (acceptable - this is RPC transport)

**Trade-offs accepted**:
- Forces callers to be async (acceptable for RPC use case)
- Not drop-in replacement for JSON.stringify/parse (not a goal)

### 3. Marker Naming Convention

**Question**: What prefix for markers to avoid collisions?

**Decision**: ✅ **Use `__lmz_` prefix** (abbreviated Lumenize).

**Examples**:
- `__lmz_Error` (not `__isError`)
- `__lmz_NaN` (not `__isNaN`)
- `__lmz_WebApi` (not `__lmz_isSerializedWebApiType`)

**Rationale**:
- ✅ Clear ownership (Lumenize)
- ✅ Short (package size matters in edge environment)
- ✅ Unlikely to collide with user code
- ✅ Doesn't require Symbol support
- ✅ Consistent with OCAN patterns (which regretted being verbose)

**Trade-offs accepted**:
- Less readable than `__lumenize_` (acceptable for internal markers)

### 4. Package License

**Question**: MIT or BSI-1.1?

**Decision**: ✅ **MIT** (same as @ungap/structured-clone).

**Rationale**:
- ✅ @ungap/structured-clone is MIT (must preserve)
- ✅ This is infrastructure, not business logic
- ✅ Wide adoption desired
- ✅ Can be used in both MIT and BSI-1.1 packages
- ✅ Only main "Lumenize" package (framework) will be BSI-1.1
- ✅ Even LumenizeBase will likely be MIT

**Note**: All Lumenize infrastructure packages (rpc, utils, testing, etc.) are MIT. Only the full framework will be BSI-1.1.

## Compatibility and Migration

### Backward Compatibility

**With current RPC code**:
- Phase 5 of downstream-messaging project will migrate RPC to use this package
- No API changes to RPC clients
- Internal implementation swap only

**With direct @ungap users**:
- Drop-in replacement for @ungap/structured-clone/json
- Additional type support is opt-in (errors/etc. just work)
- API naming different (serialize→preprocess, deserialize→postprocess)

### Migration Path

**For internal use** (RPC package):
1. Implement @lumenize/structured-clone (this project)
2. Test thoroughly in isolation
3. Migrate downstream-messaging to use it
4. Migrate existing RPC (downstream-messaging Phase 5)
5. Remove old preprocessing code

**For external users**:
```typescript
// Before (sync):
import { stringify, parse } from '@ungap/structured-clone/json';
const json = stringify(obj);
const restored = parse(json);

// After (async):
import { stringify, parse } from '@lumenize/structured-clone';
const json = await stringify(obj);  // Now async!
const restored = await parse(json); // Now async!
// Errors, Web API objects now work automatically
```

## Success Criteria

### Functional
- ✅ All @ungap/structured-clone features preserved
- ✅ Special numbers (NaN, ±Infinity) supported
- ✅ Error objects with full fidelity
- ✅ Web API objects (Request, Response, Headers, URL)
- ✅ Circular references and aliases
- ✅ All native structured-clone types

### Quality
- ✅ >90% branch coverage
- ✅ All ported @ungap tests pass
- ✅ Comprehensive test suite for extensions
- ✅ Performance ≥ current implementation
- ✅ No memory leaks

### API
- ✅ Clear method names (stringify/parse, preprocess/postprocess)
- ✅ Drop-in replacement for @ungap/structured-clone/json
- ✅ TypeScript types for all public APIs
- ✅ Comprehensive JSDoc

### Integration
- ✅ Works in Cloudflare Workers environment
- ✅ Compatible with vitest
- ✅ Usable from other Lumenize packages via workspace
- ✅ Can be published to npm independently

## Open Questions

### Q1: Should we contribute extensions upstream?

**Question**: After proving our extensions, should we contribute them back to @ungap/structured-clone?

**Decision**: ❌ **No, will not contribute upstream**.

**Rationale**:
- **Async API**: Breaking change incompatible with their API
- **API naming**: preprocess/postprocess vs serialize/deserialize
- **Platform-specific**: Web API objects are Cloudflare Workers-specific
- **Respect upstream**: Show appreciation in docs/attribution, don't force incompatible changes
- **If upstream author wanted async + these extensions, they would have done it**

**Instead**:
- Proper attribution in package README and root ATTRIBUTIONS.md
- Clear documentation that we're a fork with extensions
- Acknowledge @ungap/structured-clone in docs

### Q2: What about other special types?

**Question**: Should we add support for other types (Symbol, WeakMap, WeakRef, ReadableStream, WritableStream, etc.)?

**Decision**: ✅ **Stick with current type list**.

**Rationale**:
- ✅ **Current list is superset of Cloudflare DO KV storage**:
  - DO KV supports: Date, Map, Set, TypedArrays, ArrayBuffer, Headers
  - DO KV missing: Request, Response, URL (we add these)
  - DO KV doesn't support: ReadableStream, WritableStream (neither will we)
- ✅ Symbols are not serializable by design
- ✅ WeakMap/WeakRef are not serializable by design
- ✅ Streams don't make sense for RPC (hence DO KV doesn't support)
- ✅ Custom class instances are too complex (would need registry)

**What we support**:
- All DO KV types + Request, Response, URL
- Everything Cloudflare Workers RPC supports (except streams)

**Document what's NOT supported and why**.

### Q3: How to handle version updates from upstream?

**Question**: If @ungap/structured-clone releases updates, how do we stay in sync?

**Decision**: **Conditional monitoring based on implementation approach**.

**If we hook deeply into their object walk** (hard to maintain with upstream changes):
- Monitor occasionally when remembered
- Manually cherry-pick critical bug fixes only
- Accept that deep integration makes upstream sync difficult

**If we have clean separation** (easier to maintain):
- ✅ **Add version check in doc-test** (preferred)
- Doc-test fails if not on latest @ungap version
- Forces us to upgrade before we can update docs
- Ensures we stay current with upstream
- Example: `expect(@ungap_version).toBe('2.x.x')`

**Rationale**:
- @ungap/structured-clone is very stable (low update frequency)
- Bug fixes worth merging, features rarely applicable
- Version check forces discipline if maintenance is feasible

**Implementation note**: Decide monitoring approach in Phase 1 after understanding code structure.

## Next Steps

Ready to start implementation?

1. **Phase 0**: Setup and research
   - Understand @ungap internals
   - Set up package structure
   - Prepare for porting

2. Ask for code review before Phase 1

Ready to proceed with Phase 0?

