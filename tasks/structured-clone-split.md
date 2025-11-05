# Structured Clone: Sync/Async API Split

**Goal**: Split `@lumenize/structured-clone` into dual entry points with separate documentation for Sync and Async APIs.

## Motivation
- **Sync API** (default): No `async`/`await`, safe for DO methods, uses RequestSync/ResponseSync
- **Async API** (secondary): Legacy support for native Request/Response, requires `async`/`await`
- Clear separation in docs prevents confusion about when to use each

## Architecture

### Entry Points
```typescript
import { stringify, parse } from '@lumenize/structured-clone';        // Sync (default)
import { stringify, parse } from '@lumenize/structured-clone/async';  // Async
```

### File Structure
```
src/
  index.ts              // Sync API (current implementation)
  async.ts              // Async API (new thin wrapper)
  core/
    preprocess.ts       // Add mode flag for Request/Response handling
    postprocess.ts      // Add mode flag for Request/Response handling
```

### Implementation Strategy
- **Sync API** (current): Handles RequestSync/ResponseSync
- **Async API** (new): Thin wrapper around sync with flag to handle native Request/Response
- Shared core logic in preprocess/postprocess with mode flag

## Phases

### Phase 1: Create Async Wrapper ✅ TODO
- [ ] Create `src/async.ts` with async wrapper functions
- [ ] Add mode flag to preprocess/postprocess for Request/Response handling
- [ ] Update package.json exports: `{ ".": "./src/index.ts", "./async": "./src/async.ts" }`
- [ ] Test both entry points

### Phase 2: TypeDoc Configuration ✅ TODO
- [ ] Add second TypeDoc plugin in `website/docusaurus.config.ts` for async API
- [ ] Configure separate output directories: `docs/structured-clone/api-sync` and `docs/structured-clone/api-async`
- [ ] Update `website/sidebars.ts` to load both TypeDoc sidebars

### Phase 3: Documentation ✅ TODO
> See [/DOCUMENTATION-WORKFLOW.md](/DOCUMENTATION-WORKFLOW.md) for the 4-phase documentation process.

- [ ] Update `website/docs/structured-clone/index.mdx` to explain Sync vs Async
- [ ] Create `website/docs/structured-clone/sync-api.mdx` (current examples, RequestSync/ResponseSync)
- [ ] Create `website/docs/structured-clone/async-api.mdx` (legacy, native Request/Response)
- [ ] Update sidebar structure:
  ```
  Structured Clone
    ├─ Overview
    ├─ Sync API
    │   └─ API Reference (TypeDoc)
    └─ Async API
        └─ API Reference (TypeDoc)
  ```

### Phase 4: Deprecation Notices ✅ TODO
- [ ] Mark old async functions in sync API as deprecated (already done in Phase 5 of structured-clone-sync.md)
- [ ] Add migration guide pointing users to async entry point if they need native Request/Response

### Phase 5: Update Dependent Packages ✅ TODO
- [ ] Confirm all internal packages use sync API (already done)
- [ ] Update any remaining async usage to use `@lumenize/structured-clone/async`

## Package.json Changes
```json
{
  "exports": {
    ".": "./src/index.ts",
    "./async": "./src/async.ts"
  }
}
```

## Documentation Structure
```
Structured Clone
  ├─ Overview                        (When to use Sync vs Async)
  ├─ Sync API                        (No async/await, safe for DOs)
  │   ├─ Guide                       (Examples with RequestSync/ResponseSync)
  │   └─ API Reference (TypeDoc)     (Generated from src/index.ts)
  └─ Async API                       (Legacy, native Request/Response)
      ├─ Guide                       (Examples with native Request/Response)
      └─ API Reference (TypeDoc)     (Generated from src/async.ts)
```

## Key Points
- **Default import** remains sync (no breaking change for current users)
- **Async API** is opt-in via `/async` import
- **Minimal duplication** - async wraps sync with mode flag
- **Clear docs** - users only see relevant API for their use case

