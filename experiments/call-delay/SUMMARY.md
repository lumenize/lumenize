# Call Delay Experiment - Executive Summary

## Key Findings

### 1. Performance (Production, with validation)
- **Workers RPC**: 4.44ms per operation (50 ops, validated)
- **@lumenize/call**: 26.84ms per operation (45 ops max, validated)
- **Overhead**: 6x slower (acceptable for continuations feature)

### 2. Reliability (Production)
- **Workers RPC**: ✅ Handles 50+ concurrent operations flawlessly
- **@lumenize/call**: ❌ **Reproducible hang at 45-50 operations**

## The Critical Issue

`@lumenize/call` doesn't just perform poorly - it **fails completely** above ~45 concurrent operations in production:

```
25 ops: ✅ Success (642ms)
35 ops: ✅ Success (988ms) 
40 ops: ✅ Success (1025ms)
45 ops: ✅ Success (1535ms)
50 ops: ❌ HANGS at 45/50 (reproducible)
```

This suggests **resource exhaustion or deadlock**, not general slowness.

## What This Means

The current `@lumenize/call` implementation is **fundamentally broken** for production use:
- Performance acceptable (6x overhead might be worth it for continuations)
- **Unreliable** (hard failure threshold at ~45-50 concurrent operations) ← THE BLOCKER
- Complex (queue processing, KV storage, blockConcurrencyWhile, work queue)

## Decision

**Full redesign** with experiments-first approach:
1. Start from clean slate
2. Build reusable experiments tooling ✅ (done: `@lumenize/for-experiments`)
3. Test each design choice before implementing
4. Validate performance and reliability at every step
5. Keep continuations feature (the value-add over Workers RPC)

## Tooling Created

`@lumenize/for-experiments`: Reusable batch-based testing framework
- `ExperimentController` base class (Cloudflare side)
- `node-client` utilities (test runner side)
- Clean WebSocket handling, progress reporting, error collection
- Ready for future experiments

## Next Action

Create clean-slate redesign of `@lumenize/call` with experiments to validate:
- Basic RPC mechanism
- Continuation serialization
- Batch performance
- Reliability under load (target: 100+ concurrent operations)

