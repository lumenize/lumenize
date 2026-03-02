# Nebula Phase 1.95: Enforce Synchronous Guards (in `@lumenize/mesh`)

**Phase**: 1.95
**Status**: Complete
**Package**: `@lumenize/mesh`
**Depends on**: Phase 1.5 (Mesh Extensibility — complete)
**Master task file**: `tasks/nebula.md`

## Goal

Enforce synchronous `MeshGuard` and `onBeforeCall` across all three base classes (LumenizeDO, LumenizeWorker, LumenizeClient). Remove `Promise<void>` from return types and stop awaiting these hooks in the execution pipeline.

**Why:** Async guards and `onBeforeCall` create a window between validation and method execution where state can change — input gates on DOs, external state on Workers, event loop interleaving on Clients. Authorization checks should validate what's already available, not fetch new state. All authorization data is synchronous: `originAuth.claims` (in memory from Gateway), `callContext.state`, and `ctx.storage.kv`/`ctx.storage.sql` (synchronous Cloudflare APIs).

**Future-proofing:** If a legitimate async authorization need emerges later, the right approach is a separate hook (e.g., `onBeforeCallAsync`) with explicit documentation of the interleaving risks, not silently allowing it via the existing hooks.

This is a breaking change to `@lumenize/mesh`.

## Scope

**In scope:**
- `MeshGuard<T>` type: `(instance: T) => void | Promise<void>` → `(instance: T) => void`
- Guard invocation in `execute.ts`: remove `await` from `await guard(target)`
- `LumenizeClient.onBeforeCall()`: `void | Promise<void>` → `void`
- `LumenizeClient` invocation: remove `await` from `await this.onBeforeCall()`
- Update existing async guard tests to be synchronous
- Update documentation (`mesh-api.mdx`, `security.mdx`) if guard/onBeforeCall signatures are shown

**Already sync (verify, no change expected):**
- `LumenizeDO.onBeforeCall(): void` — already sync-only and not awaited
- `LumenizeWorker.onBeforeCall(): void` — already sync-only

## Changes

### 1. Type definition (`mesh-decorator.ts`)

```typescript
// Before
export type MeshGuard<T = any> = (instance: T) => void | Promise<void>;

// After
export type MeshGuard<T = any> = (instance: T) => void;
```

### 2. Guard invocation (`ocan/execute.ts`)

```typescript
// Before (line ~122)
const guard = getMeshGuard(method);
if (guard) {
  await guard(target);
}

// After
const guard = getMeshGuard(method);
if (guard) {
  guard(target);
}
```

### 3. LumenizeClient `onBeforeCall` (`lumenize-client.ts`)

```typescript
// Before (line ~504)
onBeforeCall(): void | Promise<void> {

// After
onBeforeCall(): void {
```

And the invocation:

```typescript
// Before (line ~866)
await this.onBeforeCall();

// After
this.onBeforeCall();
```

### 4. Test updates (`test/test-worker-and-dos.ts`, `test/lumenize-client.test.ts`)

Convert existing async guard test methods to synchronous:

All three follow the same pattern (DO shown; Worker and Client are identical):

```typescript
// Before
@mesh(async (instance: TestDO) => {
  await Promise.resolve();
  const token = instance.lmz.callContext?.state?.['token'];
  if (token !== 'valid-token') {
    throw new Error('Guard: valid token required');
  }
})
guardedAsyncMethod(): string {
  return 'async-guard-passed';
}

// After
@mesh((instance: TestDO) => {
  const token = instance.lmz.callContext?.state?.['token'];
  if (token !== 'valid-token') {
    throw new Error('Guard: valid token required');
  }
})
guardedMethod(): string {
  return 'guard-passed';
}
```

Affected test methods (convert guard to sync and rename):
- `TestDO.guardedAsyncMethod` → `guardedMethod` in `test/test-worker-and-dos.ts`
- `TestWorker.guardedWorkerAsyncMethod` → `guardedWorkerMethod` in `test/test-worker-and-dos.ts`
- `TestClient.guardedClientAsyncMethod` → `guardedClientMethod` in `test/lumenize-client.test.ts`

Also rename string references in `test/call-context.test.ts` (`guardedAsyncMethod` → `guardedMethod`, `guardedWorkerAsyncMethod` → `guardedWorkerMethod`).

Corresponding test cases should still pass — the tests verify guard rejection/acceptance behavior, which is unchanged.

### 5. Documentation

Update guard signature and `onBeforeCall` signature in `website/docs/mesh/mesh-api.mdx`, `website/docs/mesh/security.mdx`, and `website/docs/mesh/lumenize-do.mdx` if they show `Promise<void>` in the type.

## Success Criteria

- [ ] `MeshGuard<T>` type is `(instance: T) => void` (no `Promise<void>`)
- [ ] Guard invocation in `execute.ts` does not `await`
- [ ] `LumenizeClient.onBeforeCall()` return type is `void` (no `Promise<void>`)
- [ ] `LumenizeClient` invocation does not `await` `onBeforeCall()`
- [ ] `LumenizeDO.onBeforeCall()` and `LumenizeWorker.onBeforeCall()` confirmed already sync (no change needed)
- [ ] All existing mesh tests pass (sync guard behavior unchanged)
- [ ] Former async guard tests converted to synchronous equivalents and renamed (`guardedAsyncMethod` → `guardedMethod`, etc.)
- [ ] Documentation updated if guard or onBeforeCall signatures are shown
