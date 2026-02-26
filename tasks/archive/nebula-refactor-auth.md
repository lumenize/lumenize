# Refactor Nebula Auth To Fit Within Nebula Proper

**Phase**: 1
**Status**: Complete
**Package**: `@lumenize/nebula-auth`
**Depends on**: Phase 0 (Nebula Auth — complete)
**Master task file**: `tasks/nebula.md`

## Goal

Refactor `@lumenize/nebula-auth` from a standalone deployable Worker into a clean library that the main Nebula Worker (`@lumenize/nebula`) imports and composes into its routing. After this phase, nebula-auth looks like a library package — not something you'd deploy on its own.

## Current State

`packages/nebula-auth/` currently:
- Has `wrangler.jsonc` in the package root (looks deployable)
- Exports a default Worker via `NebulaWorker` class in `index.ts`
- Exports `handleRequest` from `nebula-worker.ts` (generic name, not great for importing)
- Exports everything from `index.ts` — DO classes, types, constants, schemas, parsing utilities — most of which are internal implementation details
- Has 231 tests across 8 test files, all passing

## Target State

After this phase:
- `wrangler.jsonc` lives in `test/` (or `test/main/`), not the package root — the package is clearly a library
- The primary export is `routeNebulaAuthRequest(request: Request, env: Env): Promise<Response>` — a single function the Nebula Worker calls to handle auth routes
- `index.ts` exports only what external consumers need:
  - `routeNebulaAuthRequest` — the routing entry point
  - DO classes (`NebulaAuth`, `NebulaAuthRegistry`, `NebulaEmailSender`) — needed for wrangler bindings in the consuming project
  - Types needed by `packages/nebula/` — `NebulaJwtPayload`, `ParsedId`, `Tier`, `AccessEntry`, `Subject`, `DiscoveryEntry`, and possibly others
  - Utility functions needed externally — `parseId`, `matchAccess`, `buildAccessId`, `isValidSlug`
  - Constants needed externally — `NEBULA_AUTH_PREFIX`, `PLATFORM_INSTANCE_NAME`
- The default Worker export (`NebulaWorker` class) is removed from `index.ts` — it was only useful for standalone deployment and moves down to next to wrangler.jsonc and is used only for testing
- All existing tests continue to pass with no logic changes

## Specific Changes

### 1. Rename `handleRequest` → `routeNebulaAuthRequest`

In `src/nebula-worker.ts`:
- Rename the exported function from `handleRequest` to `routeNebulaAuthRequest`
- Update the default Worker export (which calls it) to use the new name
- Update all test files that reference `handleRequest`

### 2. Move `wrangler.jsonc` to `test/`

- Move `packages/nebula-auth/wrangler.jsonc` → `packages/nebula-auth/test/wrangler.jsonc`
- Update `vitest.config.js` to point to the new location (`wrangler: { configPath: './test/wrangler.jsonc' }`)
- Verify `.dev.vars` symlink setup still works (the `setup-symlinks.sh` script finds directories containing `wrangler.jsonc`)
- All tests must pass after the move

### 3. Trim `index.ts` Exports

Audit every export in `src/index.ts`. For each, decide: needed externally (keep) or internal (remove from index.ts).

**Keep** (needed by `packages/nebula/` or wrangler bindings):
- `routeNebulaAuthRequest` (renamed from `handleRequest`)
- `NebulaAuth`, `NebulaAuthRegistry`, `NebulaEmailSender` — DO/Worker classes for wrangler bindings
- `NebulaJwtPayload`, `ParsedId`, `Tier`, `AccessEntry`, `Subject`, `DiscoveryEntry` — types for access control and identity
- `parseId`, `matchAccess`, `buildAccessId`, `isValidSlug`, `isPlatformInstance`, `getParentId` — utilities for ID handling
- `NEBULA_AUTH_PREFIX`, `PLATFORM_INSTANCE_NAME`, `REGISTRY_INSTANCE_NAME` — constants
- `NEBULA_AUTH_ISSUER`, `NEBULA_AUTH_AUDIENCE`, `ACCESS_TOKEN_TTL` — JWT constants (needed for token verification in guards)

**Remove from `index.ts`** (internal implementation):
- Default Worker export (`NebulaWorker` class / default export object)
- `ALL_SCHEMAS`, `REGISTRY_SCHEMAS` — SQL schemas are internal to the DO classes
- `MagicLink`, `InviteToken`, `RefreshToken` — internal token types
- `RegistryInstance`, `RegistryEmail` — internal registry types
- `RegistryError` — internal error class
- Any other types/constants only used within nebula-auth's own code

**Review needed**: Walk through each type/constant and check if `packages/nebula/` will actually need it. Err on the side of keeping — we can trim further later. Removing an export is easier than adding one back.

### 4. Remove Standalone Default Worker Export

The `export default { async fetch(request, env) { ... } }` pattern in `nebula-worker.ts` (or the `NebulaWorker` class) was for standalone deployment. Remove it from `index.ts`. The file itself can keep it for test convenience — the test harness can import it directly from the source file rather than through `index.ts`. The Worker with a default export is only for testing so should be on the same level as wrangler.jsonc

## Test Strategy

No logic changes — this is purely a refactoring of exports and file locations. All 231 existing tests must continue to pass. The test harness (`test/test-worker-and-dos.ts`) may need minor updates to import paths if wrangler.jsonc moves.

Run the full suite after each change:
```bash
cd packages/nebula-auth && npx vitest run
```

## Success Criteria

- [x] `routeNebulaAuthRequest` is the primary named export (replaces `handleRequest`)
- [x] `wrangler.jsonc` and Worker with default export is in `test/`, not package root
- [x] `index.ts` exports only externally-needed items (no SQL schemas, no internal token types, no standalone Worker)
- [x] All 231 tests pass with no logic changes
- [x] `vitest.config.js` updated to find wrangler.jsonc in new location
- [x] `.dev.vars` symlink still works after wrangler.jsonc move
