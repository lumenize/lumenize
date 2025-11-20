# Live Integration Testing

This folder contains tests that run against a live `wrangler dev` instance using the `@lumenize/testing` teleportation pattern.

## ✅ Validated

- **Teleportation works**: Can use `createTestingClient` to access DOs in wrangler dev
- **Native alarms work**: Cloudflare native alarms fire correctly in wrangler dev
- **Property access works**: Can read `ctx.id` and other properties via RPC

## Setup

1. **Install dependencies** (auto-symlinks .dev.vars):
   ```bash
   cd /Users/larry/Projects/mcp/lumenize/packages/proxy-fetch
   npm install
   ```

2. **Start wrangler dev** (from this directory):
   ```bash
   cd test/live-integration
   wrangler dev --port 8787
   ```
   
   Wrangler dev will auto-reload when code changes are saved.

3. **Run tests** (from this directory):
   ```bash
   npx vitest --run --config ./vitest.config.js
   ```

## How It Works

- **`wrangler dev`** runs `test-harness.ts` with real Cloudflare runtime
- **vitest** runs `full-flow.test.ts` in `vitest-pool-workers` environment
- **`@lumenize/testing` client** "teleports" from test into wrangler dev DOs via WebSocket

## Test Structure

- `test-worker-and-dos.ts` - Raw DO classes for testing (`TestDO`)
- `test-harness.ts` - Instruments DOs with `@lumenize/testing`
- `wrangler.jsonc` - Configuration (points to `test-harness.ts` as main)
- `full-flow.test.ts` - Test suite

## Tests

✅ **Step 1:** Teleport into DOs and read properties  
⏭️ **Step 2:** External fetch (skipped - NADIS registration issue)  
✅ **Step 3:** Native alarm scheduling and firing ⏰ **CRITICAL**  
⏭️ **Step 4:** Timeout behavior (not yet implemented)  

## Debugging

- **See server logs:** Check wrangler dev terminal output
- **Add logging:** Modify `test-worker-and-dos.ts` and wrangler auto-reloads
- **Inspect state:** Use `@lumenize/testing` client to query DO state
- **Token issues:** Check `.dev.vars` has `TEST_TOKEN`

## Notes

- Tests are skipped by default (`.skip`) until wrangler dev is running
- Alarm tests require waiting ~10 seconds for alarm to fire
- Production test-endpoints URL is hardcoded (we own it, so safe to hit)

