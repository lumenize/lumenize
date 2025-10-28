# DO-Based Proxy Fetch - Work in Progress

## Goal
Implement DO-based proxy fetch variant with lower latency than queue-based approach.

## Current Phase: Experiments - Understanding Alarm & Async Behavior

### Questions to Answer
1. Do async operations continue after an alarm completes?
2. Is `ctx.waitUntil()` required for background async work in alarms?
3. Can we fire off multiple parallel fetches from a single alarm execution?
4. What happens to in-flight async work when DO is evicted/restarted?

### Experiments Plan
- [ ] Experiment 1: Alarm with fire-and-forget async (no waitUntil)
- [ ] Experiment 2: Alarm with ctx.waitUntil() for async work
- [ ] Experiment 3: Multiple parallel async operations from alarm
- [ ] Experiment 4: Storage persistence of in-flight operations across DO restart

## Implementation Phases (After Experiments)

### Phase 1: Core Infrastructure
- [ ] Set up test/do/ directory structure
- [ ] Create vitest.do.config.js
- [ ] Create wrangler.jsonc with ProxyFetchDO binding
- [ ] Extract shared retry logic to utils.ts

### Phase 2: Storage Queue
- [ ] Install and configure ulid-workers
- [ ] Implement ULID-based storage queue (enqueue/dequeue)
- [ ] Add in-flight tracking with storage keys
- [ ] Implement constructor recovery logic

### Phase 3: Fetch Processing
- [ ] Implement parallel fetch processing with MAX_IN_FLIGHT=5
- [ ] Add alarm-based queue processing
- [ ] Implement retry logic (in-DO retries)
- [ ] Add callback delivery to origin DOs

### Phase 4: Client Integration
- [ ] Implement proxyFetchDO() client function
- [ ] Add auto-detection wrapper in main proxyFetch()
- [ ] Update types for DO variant

### Phase 5: Testing & Documentation
- [ ] Write integration tests
- [ ] Add documentation
- [ ] Update package.json scripts for both variants

## Design Decisions

### Confirmed
- ✅ Pattern B: Async callback (consistent with Queue variant)
- ✅ Auto-detection of variant based on env bindings
- ✅ Named instance: 'proxy-fetch-global'
- ✅ In-DO retries (not queue-based)
- ✅ MAX_IN_FLIGHT = 5 (hardcoded)
- ✅ MAX_REQUEST_AGE = 30 minutes
- ✅ Alarm interval = 500ms when at capacity
- ✅ Extract timestamp from ULID
- ✅ Skip completed/failed state tracking (for now)
- ✅ Callback errors: try once, log and delete
- ✅ Use check-examples (not doc-test)

### To Be Determined (via experiments)
- ⏳ Whether to use ctx.waitUntil() for parallel fetches
- ⏳ Exact pattern for alarm → async fetch coordination
