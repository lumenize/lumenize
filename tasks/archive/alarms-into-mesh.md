# Task: Move Alarms into LumenizeDO (Built-in Service)

**Status**: Complete — Alarms is a built-in service in LumenizeDO. `packages/alarms/` deleted, source in `packages/mesh/src/alarms.ts`, docs at `website/docs/mesh/alarms.mdx`.

## Context

This task was created after recognizing that alarms doesn't fit well as a NADIS plugin:

1. **Alarms requires lifecycle hook integration** - the `alarm()` method is a DO lifecycle method that only the DO class can implement. NADIS plugins can't intercept lifecycle methods.

2. **NADIS is for composable services** - plugins that the DO calls (`this.svc.foo.doSomething()`). Alarms needs the reverse - it needs to respond to a lifecycle event.

3. **Fetch depends on alarms** - making alarms more "core" than initially thought.

4. **sql is already hardcoded** - it's in `packages/mesh/src/sql.ts` and initialized directly in LumenizeDO. Alarms should follow the same pattern.

**Decision:** Hardcode alarms into LumenizeDO like sql, removing it as a separate package.

---

## Paused Work

**`tasks/lumenize-mesh-client.md`** has been set aside. Remaining work:

1. **E2E for-docs test** - collaborative document editor from getting-started.mdx
2. **Cleanup and verification** at the bottom of that task file
3. **To-dos in backlog.md**

### Draft Prompt for E2E For-Docs Test (Resume Later)

```markdown
I want to work with you in a careful small-increment way (prompt-implement-review...repeat) to collaboratively implement and test the multi-node (DOs, Workers, Clients, Auth, etc) Lumenize Mesh based collaborative document editor from website/docs/mesh/getting-started.mdx.

Or should I more precisely say, we'll be implementing the mermaid sequence diagram in website/docs/_partials/_mesh-architecture-diagram.mdx because we'll implement the Workspace as shown in the diagram but absent from the getting-started guide code.

The style will be to have a single long-running test where we simulate two users/clients creating, finding, edting, and spell checking documents

The test infrastructure is set up and the connection test already passes.

### Test Structure

The tests are in a separate vitest project with their own wrangler.jsonc:

- **Test file**: `packages/mesh/test/for-docs/mesh/getting-started.test.ts`
- **Test worker**: `packages/mesh/test/for-docs/mesh/test-worker.ts`
- **Wrangler config**: `packages/mesh/test/for-docs/mesh/wrangler.jsonc`

Run tests with: `npm test -- --project mesh-e2e`

### What's Already Implemented

**test-worker.ts** contains:
- `DocumentDO` - content in the DO's KV storage, broadcasts to subscribers, calls SpellCheckWorker, sends last-updated info back to Workspace DO
- `SpellCheckWorker` - mock implementation that flags words containing "teh"
- `LumenizeClientGateway` - re-exported from @lumenize/mesh
- Worker entry with `routeDORequest` + auth middleware, although we don't exercise the auth routes for login, logout, token refresh, etc. because it's difficult to simulate UI in this environment. Maybe we'll do the latter in an examples folder.

**getting-started.test.ts** contains:
- `EditorClient` - extends LumenizeClient with `@mesh` handlers for content updates and spell findings
- `generateTestToken()` helper using `@lumenize/auth` JWT signing directly to avoid the need to exercise login, logout, token refresh, etc. endpoints
- One passing test: "connects to Gateway using Browser.WebSocket"

### Documentation to Validate

- `website/docs/mesh/getting-started.mdx` - The tutorial code we're testing. In the coarse of this test writing, we will make changes to that document.

### Key Patterns to Test

1. ✅ Client connects via WebSocket with JWT auth (DONE)
2. Client subscribes to DocumentDO, receives initial content via callback
3. Client calls `DocumentDO.update()`, DocumentDO broadcasts to all subscribers
4. DocumentDO calls SpellCheckWorker, spell findings flow back to client
5. Multiple clients receiving broadcasts simultaneously
6. `onSubscriptionsLost` callback after reconnection past grace period
7. `onLoginRequired` callback when refresh fails (may require adding a method to LumenizeAuth to force token expiration)

### Technical Notes

- Use `browser.WebSocket as unknown as typeof WebSocket` for type cast
- instanceName format: `${userId}.${tabId}` (Gateway validates userId matches auth)
- SpellCheckWorker mock flags words containing "teh" as typos
- JWT keys are in `.dev.vars` (symlinked): `JWT_PRIVATE_KEY_BLUE`, `JWT_PUBLIC_KEY_BLUE`
- Use `vi.waitFor()` for async assertions, never `setTimeout`
```

---

## Goal

Move alarms from a separate NADIS plugin package into LumenizeDO as a built-in service, like sql.

## Current State

- `packages/alarms/` - separate package with NADIS plugin registration
- `packages/alarms/src/alarms.ts` - main implementation with `Alarms` class
- `packages/alarms/src/types.ts` - TypeScript types
- `packages/mesh/src/sql.ts` - example of built-in service pattern
- LumenizeDO currently has no `alarm()` method (was removed during earlier cleanup)

## Success Criteria

- [ ] Alarms source code lives in `packages/mesh/src/alarms.ts`
- [ ] `this.svc.alarms` works automatically in any LumenizeDO subclass
- [ ] `alarm()` lifecycle method is implemented in LumenizeDO, delegating to alarms
- [ ] No NADIS plugin registration for alarms
- [ ] `packages/alarms/` directory deleted
- [ ] All existing alarms tests pass (moved to mesh package)
- [ ] Documentation updated to reflect alarms is built-in
- [ ] TypeScript compiles cleanly across all packages

---

## Phase 0: Preparation

- [ ] Review current alarms implementation in `packages/alarms/src/`
- [ ] Review how sql is integrated in `packages/mesh/src/sql.ts` and LumenizeDO
- [ ] Identify all imports of `@lumenize/alarms` across the codebase
- [ ] Identify alarms tests that need to move

## Phase 1: Move Source Code

- [ ] Copy `packages/alarms/src/alarms.ts` to `packages/mesh/src/alarms.ts`
- [ ] Copy `packages/alarms/src/types.ts` content into mesh (or merge into existing types)
- [ ] Remove NADIS plugin registration (`NadisPlugin.register(...)`)
- [ ] Update imports to use mesh-internal paths
- [ ] Export only types from `packages/mesh/src/index.ts` (AlarmSchedule, etc.) - not the Alarms class itself

## Phase 2: Integrate into LumenizeDO

- [ ] Add `#alarms` private field to LumenizeDO (lazy initialized like sql)
- [ ] Add `alarms` getter to `this.svc` proxy
- [ ] Implement `alarm()` lifecycle method that delegates to `this.svc.alarms.alarm()`
- [ ] Update LumenizeServices interface with `alarms` property
- [ ] **Remove previous workaround code** - we added various hacks trying to make alarms work as a plugin:
  - [ ] Remove `(this.svc as any)?.alarms` patterns in LumenizeDO
  - [ ] Remove any `@ts-expect-error` comments related to alarms
  - [ ] Remove any conditional checks like `if (this.svc && typeof this.svc.alarms?.alarm === 'function')`
  - [ ] The new code should be clean: direct access to `this.#alarms` or `this.svc.alarms`

## Phase 3: Move Tests

- [ ] Move `packages/alarms/test/` to `packages/mesh/test/alarms/`
- [ ] Update test imports
- [ ] Verify all tests pass: `npm test -- --project mesh`

## Phase 4: Update Consumers

- [ ] Find all `import ... from '@lumenize/alarms'`
- [ ] Change to `import ... from '@lumenize/mesh'` (for types only)
- [ ] Remove `import '@lumenize/alarms'` side-effect imports (no longer needed)
- [ ] **CRITICAL: No TypeScript foo at call sites** - consumers should just use `this.svc.alarms.schedule(...)` with zero type annotations, casts, or interface declarations
- [ ] Remove any `declare global { interface LumenizeServices { alarms: ... } }` from consumer files
- [ ] Remove any `as any` casts related to alarms at call sites
- [ ] Remove any extra interface declarations for alarms in call site files

## Phase 5: Delete Old Package

- [ ] Remove `packages/alarms/` directory
- [ ] Remove `@lumenize/alarms` from root package.json workspaces (if listed)
- [ ] Remove any references in tsconfig paths

## Phase 6: Update Documentation

- [ ] Move `website/docs/alarms/index.mdx` to `website/docs/mesh/alarms.mdx` (keep as separate doc) and delete website/docs folder
- [ ] Update moved alarms doc - remove "import @lumenize/alarms" instructions, explain it's built-in
- [ ] Update `website/docs/mesh/lumenize-do.mdx`:
  - [ ] Add/update "Built-in Services" section listing sql and alarms
  - [ ] Link to the alarms doc for details
- [ ] Update `website/docs/mesh/creating-plugins.mdx` - remove alarms as NADIS plugin example
- [ ] Update sidebar config if needed for moved alarms doc
- [ ] Update any other docs referencing `@lumenize/alarms` import

## Phase 7: Verification

- [ ] `npm run build` succeeds
- [ ] `npm test` passes across all packages
- [ ] `npx tsc --noEmit` clean in mesh, rpc, auth packages
- [ ] Website builds: `cd website && npm run build`

---

## Notes

- The alarms implementation depends on sql for storing scheduled alarms
- Declaration merging for `LumenizeServices.alarms` should stay in mesh
- Alarms has its own types (`AlarmSchedule`, `AlarmHandler`, etc.) - these become mesh exports
