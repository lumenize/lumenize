# Alarms Robustness Testing

**Status**: TODO  
**Priority**: Medium  
**Created**: 2025-11-14

## Context

During the call-alarm-delay experiment, we discovered that the alarm-based approach had severe reliability issues in production:
- Only 60% of alarms completed (4 out of 10 dropped/timed out)
- Massive latency: ~6+ seconds per operation (expected: near-instant for 0-second delays)
- See: `experiments/call-alarm-delay/EXPERIMENT_RESULTS.md`

This suggests potential issues with our alarms multiplexing implementation or undocumented Cloudflare limitations when scheduling many alarms rapidly.

## Goal

Create robust production tests to identify and fix reliability issues with `@lumenize/alarms` under load.

## Investigation Areas

1. **Multiplexing bugs**: Does rapid scheduling of many alarms cause some to be dropped?
2. **Storage visibility**: Are synchronous KV writes immediately visible to subsequent reads?
3. **Native alarm limits**: Does Cloudflare have undocumented rate limits or concurrency restrictions?
4. **Schedule(0) behavior**: Does Cloudflare's alarm system handle 0-second delays properly?

## Phases

### Phase 1: Create Basic Robustness Test

**Goal**: Replicate the reliability failure with a minimal alarms-only test.

- [ ] Create `experiments/alarms-robustness/` directory
- [ ] Copy structure from `call-alarm-delay` (WebSocket-based measurement)
- [ ] Create test DO that:
  - Schedules N alarms rapidly (10, 50, 100)
  - Tracks which ones execute
  - Reports success/failure rates
- [ ] Test locally with `triggerAlarms()` (should be 100%)
- [ ] Deploy to production and measure
- [ ] Document failure rate and patterns

**Expected outcome**: Reproduce the ~40% failure rate with alarms-only code.

### Phase 2: Isolate Root Cause

- [ ] Test 1: Schedule alarms with delays (1s, 5s, 10s) vs 0-second
  - Hypothesis: 0-second delays might be problematic
- [ ] Test 2: Schedule sequentially vs in rapid batch
  - Hypothesis: Race condition in multiplexing logic
- [ ] Test 3: Single alarm (no multiplexing) with 0-second delay
  - Hypothesis: Native alarm system issue vs our multiplexing
- [ ] Test 4: Add explicit delays between schedule() calls
  - Hypothesis: Storage visibility issues
- [ ] Check Cloudflare Workers logs for any errors
- [ ] Review Alarms.schedule() implementation for race conditions

### Phase 3: Fix and Verify

Based on findings from Phase 2:
- [ ] Implement fix in `packages/alarms/src/alarms.ts`
- [ ] Add regression test in `packages/alarms/test/`
- [ ] Re-run robustness test in production
- [ ] Verify 100% reliability under load
- [ ] Document any Cloudflare limitations discovered

### Phase 4: Production Guidelines

- [ ] Document safe usage patterns for alarms package
- [ ] Add warnings if limitations are discovered
- [ ] Update website docs with any caveats
- [ ] Consider adding rate limiting if needed

## Notes

- This is **not a blocker** for the call package - we've already switched to direct async
- Alarms are still useful for scheduled tasks, background work, etc.
- Even if we discover Cloudflare limitations, alarms are valuable for non-immediate scheduling

## Related

- Experiment that surfaced the issue: `experiments/call-alarm-delay/`
- Package under investigation: `packages/alarms/`
- Call package fix (removed alarm dependency): `packages/call/src/call.ts`

