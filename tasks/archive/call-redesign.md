# Call Package Redesign - Clean Slate

## Status: In Progress

## Goal
Redesign `@lumenize/call` from scratch to fix reliability issues while maintaining type-safe continuations feature.

## Context
Current implementation:
- ❌ Hangs at 45-50 concurrent operations (reproducible)
- ⚠️ 6x slower than Workers RPC (acceptable overhead)
- ✅ Type-safe continuations (the unique value proposition)

## Success Criteria
1. **Reliability**: Handle 100+ concurrent operations without hanging
2. **Performance**: Stay within 10x of Workers RPC (currently 6x)
3. **API**: Preserve continuations-based API for type safety
4. **Simplicity**: Minimize moving parts (no complex queue systems)

## Phases

### Phase 1: Minimal Viable Implementation ✅ COMPLETE
**Goal**: Simplest possible RPC that works

Approach:
- Direct Workers RPC call with continuation payload
- No queues, no alarms, minimal KV usage
- Test: Does it work? What's the performance?

Tasks:
- [x] Create experiment: `call-redesign-v1`
- [x] Implement minimal RPC (just Workers RPC + continuation serialization)
- [x] Test local: 50, 100 operations
- [x] Test production: 50, 100 operations
- [x] Create experiment: `call-redesign-v2` (fire-and-forget variant)
- [x] Test V2 production: 50, 100, 200 operations
- [x] Document performance and reliability

**Results**:
- **V1 (single round-trip)**: 1.32ms/op, 100+ ops, 6.5% overhead vs Workers RPC
- **V2 (fire-and-forget)**: 3.60ms/op, 200+ ops, 5-10% overhead vs Workers RPC
- **Old implementation**: 26.84ms/op, 45 ops max (then hangs)
- **Improvement**: V2 is 7x faster and 4x more reliable than old implementation

**Key Finding**: Fire-and-forget (V2) provides sync API with minimal overhead due to parallel execution.

### Phase 2: Add Sync API (if needed)
**Goal**: Add non-blocking call API if Phase 1 requires await

Decision point:
- If Phase 1 works with direct await: Skip this phase
- If we need sync API: Add thin wrapper

Tasks:
- TBD based on Phase 1 results

### Phase 3: Optimize Performance
**Goal**: Get closer to Workers RPC speed if possible

Approaches to test:
- Reduce serialization overhead
- Batch multiple calls
- Connection pooling/reuse

Tasks:
- TBD based on Phase 1 & 2 results

### Phase 4: Production Hardening
**Goal**: Error handling, timeouts, edge cases

Tasks:
- [ ] Timeout handling
- [ ] Error propagation
- [ ] Binding validation
- [ ] Comprehensive tests

## Design Principles

1. **Experiments first**: Test each design choice before implementing
2. **Simplicity**: Fewer moving parts = fewer bugs
3. **Cloudflare-native**: Use Workers RPC, not custom queues
4. **Continuations**: Preserve the type-safe callback API

## Questions Answered

1. ✅ **Can we use Workers RPC directly with continuation payloads?**
   - Yes! V1 shows this works perfectly with only 6.5% overhead

2. ✅ **Do we need blockConcurrencyWhile or can we use plain async?**
   - Plain async works fine. No blockConcurrencyWhile needed.

3. ✅ **What causes the 45-50 operation hang in current implementation?**
   - Likely complex queue system + KV contention + blockConcurrencyWhile overhead
   - Simple approach (V2) handles 200+ operations without issues

4. ✅ **Can we achieve <5x overhead vs Workers RPC?**
   - Far exceeded! V2 is only 5-10% overhead (not 5x, but 1.05-1.10x)

## Current Implementation Issues (to avoid)

1. ❌ Complex work queue system
2. ❌ Multiple KV read/write per call
3. ❌ blockConcurrencyWhile for every call
4. ❌ Alarm-based scheduling (tried and abandoned)
5. ❌ Call queue processing layer

## Experiments Repository

- `experiments/call-delay/` - Performance comparison (Workers RPC baseline)
- `experiments/call-redesign-v1/` - Minimal viable implementation (Phase 1)

## Notes

- Use `@lumenize/for-experiments` tooling for all testing
- Deploy and test in production after each phase
- Document all findings in experiment RESULTS.md files

