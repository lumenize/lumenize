# Performance Comparisons: Lumenize RPC vs Cap'n Web

This experiment compares the performance characteristics of Lumenize RPC against Cloudflare's Cap'n Web RPC system.

## Structure

- **`src/`**: Shared implementation logic used by both RPC systems
- **`test/`**: Test worker and Durable Objects for benchmarking
- **`MEASUREMENTS.md`**: Running log of all performance measurements

## Architecture

Both implementations use the same business logic (`CounterImpl`) to ensure we're only measuring RPC transport overhead:

- **CounterCapnWeb**: Extends `RpcTarget`, uses `newWorkersRpcResponse()` (Cap'n Web pattern)
- **CounterLumenize**: Extends `DurableObject`, uses `lumenizeRpcDO()` wrapper (Lumenize pattern)

## Running Benchmarks

**Two-process setup to avoid vitest-pool-workers timing issues:**

**Requirements:**
- Node.js v22+ (for native WebSocket support)

1. **Terminal 1** - Start the worker with wrangler:
   ```bash
   npm run dev
   ```

2. **Terminal 2** - Run the benchmarks (connects to localhost:8787):
   ```bash
   npm test
   ```

The tests run in Node.js and connect to the wrangler dev server over HTTP/WebSocket (using Node.js native WebSocket), giving accurate performance measurements without worker runtime clock interference.

## Recording Results

**Best Practice: Always commit code changes before recording measurements.**

This ensures reproducibility - anyone can checkout that exact commit and re-run the benchmarks.

### Workflow

1. Make code changes (optimizations, fixes, etc.)
2. Run tests to verify they work: `npm test`
3. **Commit the changes** with descriptive message
4. Get git hash: `git rev-parse --short HEAD`
5. Run performance benchmark: `npm test`
6. Record results in `MEASUREMENTS.md`:
   - Timestamp (YYYY-MM-DD HH:MM:SS format)
   - Git hash from step 4
   - Description of what changed
   - Formatted performance results
   - Relevant observations
7. Commit the `MEASUREMENTS.md` update

This way, every measurement is tied to a clean, committed state that can be reproduced exactly.

## Optimization Workflow

1. Run benchmark to establish baseline
2. Make optimization to Lumenize RPC
3. Run benchmark again
4. Record results in MEASUREMENTS.md
5. Commit changes with performance notes
