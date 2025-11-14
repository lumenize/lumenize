# Call Patterns Comparison

Evaluates different DO-to-DO communication patterns to find the optimal approach for `@lumenize/call`.

## Goal

Find a pattern that:
- ✅ Is as fast as Workers RPC (or close)
- ✅ Provides synchronous API with continuations
- ✅ Has 100% reliability under load
- ✅ Doesn't hang at high concurrency (>45 ops)

## Patterns Under Test

### V1: Pure Workers RPC (baseline) ✅
- Direct Workers RPC calls
- Establishes performance/reliability baseline
- **Expected**: Fast, reliable, but no continuation support

### V2: Operation Chains over RPC (coming soon)
- Send OCAN operation chains via Workers RPC
- Await round-trip response
- **Expected**: Slightly slower than V1, but type-safe and testable

### V3: Fire-and-Forget with Continuations (coming soon)
- Use `blockConcurrencyWhile()` for non-blocking async work
- No await in caller
- **Expected**: Best of both worlds - fast + sync API + continuations

## Usage

```bash
npm run dev          # Start dev server on :8787
npm test 50          # Auto-discovers and runs all patterns
```

Test client automatically discovers available patterns from server.

## Implementation Notes

Uses `@lumenize/for-experiments` framework (see `tooling/for-experiments/README.md` for details).

All patterns share:
- Single `PatternController` that routes to implementations
- Shared `RemoteDO` as target
- Unified test harness with auto-discovery

