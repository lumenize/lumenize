# Call Delay Experiment

## Purpose

Compare DO-to-DO communication latency between:
- `@lumenize/call` - Fire-and-forget with continuations (sync API, async execution)
- Workers RPC - Native Cloudflare RPC (async/await required)

## Questions

**Primary**: How much slower is @lumenize/call compared to Workers RPC?

**Secondary**: Does Workers RPC hit the 6 concurrent request limit for Durable Objects?

## Architecture

Uses batch-based testing for realistic measurements:
- Node.js sends ONE message to start a batch
- Controller DO executes all operations internally (realistic Cloudflare conditions)
- Progress/results reported via WebSocket

This tests the real-world scenario: A DO making many calls to another DO.

## Local Testing

```bash
# Terminal 1: Start dev server
npm run dev

# Terminal 2: Run test (default: 10 operations)
npm test

# Custom operation count
npm test 50
```

## Production Testing

```bash
# Deploy to production
npm run deploy

# Run against production (adjust URL)
TEST_URL=https://call-delay.YOUR-ACCOUNT.workers.dev npm test 50
```

## Tradeoffs

### @lumenize/call
- ✅ **Synchronous API**: No await required at call site
- ✅ **Type-safe continuations**: Compile-time checks for callbacks
- ✅ **No blocking**: Can fire many calls without waiting
- ❌ **Overhead**: Additional complexity (queue processing, continuation serialization)
- ❌ **Consistency boundary**: blockConcurrencyWhile creates async boundary

### Workers RPC
- ✅ **Native**: Built-in Cloudflare feature, minimal overhead
- ✅ **Reliability**: Production-proven
- ❌ **Async only**: Requires await, blocks at call site
- ❌ **No continuations**: Manual callback handling
- ❌ **Concurrency limit?**: May hit 6 simultaneous request limit

## Results

See `EXPERIMENT_RESULTS.md` for detailed findings.
