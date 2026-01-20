# Simplify CallContext: Remove origin and callee properties

## Status: COMPLETE ✓

## Goal
Simplify `CallContext` by making `callChain` the single source of truth for node identity chain.

## Previous Design (awkward)
```typescript
interface CallContext {
  origin: NodeIdentity;           // First node
  originAuth?: OriginAuth;        // JWT claims
  callChain: NodeIdentity[];      // Nodes AFTER origin: [hop1, hop2, ...]
  callee: NodeIdentity;           // Receiving node
  state: Record<string, unknown>; // Mutable middleware data
}
```
- Immediate caller = `callChain.at(-1) ?? origin` (awkward pattern)
- `callee` duplicated info already available via `this.lmz.*`

## New Design (consistent)
```typescript
interface CallContext {
  callChain: NodeIdentity[];      // ALL nodes: [origin, hop1, hop2, ..., caller]
  originAuth?: OriginAuth;        // JWT claims from callChain[0]
  state: Record<string, unknown>; // Mutable middleware data
}
```
- Origin = `callChain[0]`
- Caller = `callChain.at(-1)`
- Callee = `this.lmz.bindingName` / `this.lmz.instanceName` (already available)

## Implementation Summary

### Files Changed
1. **types.ts** - Updated `CallContext` interface, removed `origin` and `callee` properties
2. **lmz-api.ts** - Updated `buildOutgoingCallContext()` to build callChain with origin included
3. **lumenize-client.ts** - Updated `onBeforeCall()` to use `callChain[0]` instead of `.origin`
4. **lumenize-worker.ts** - Updated JSDoc example to use new pattern
5. **lumenize-client-gateway.ts** - Updated to build callContext with `callChain[0]` as verified origin
6. **test/call-context.test.ts** - Updated all tests to use new semantics
7. **test/test-worker-and-dos.ts** - Updated helper methods (`getCaller`, `getCalleeIdentity`, etc.)
8. **test/lumenize-client-gateway.test.ts** - Updated assertions to use `callChain[0]`

### Key Semantic Changes
1. `callChain` is NEVER empty - it always has at least the origin
2. Direct calls: `callChain = [origin]` (caller and origin are the same)
3. Multi-hop: `callChain = [origin, hop1, hop2, ..., caller]`
4. Caller is always `callChain.at(-1)` (no more `?? origin` fallback)

### Breaking Changes for Users
- `callContext.origin` → `callContext.callChain[0]`
- `callContext.callee` → `this.lmz.bindingName` / `this.lmz.instanceName`
- `callChain.at(-1) ?? origin` → `callChain.at(-1)`
- Empty `callChain` no longer possible

## Test Results
All 184 tests pass (1 skipped - unrelated).

## Bonus: Continuation Type Safety Fixed
During implementation, also removed unnecessary `as any` casts from continuation code in `getting-started.test.ts`. The `Continuation<T>` type system now works correctly without casts.
