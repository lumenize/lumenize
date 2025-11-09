# Environment Variable Refresh Experiment - Summary

## What We Built

Three test endpoints to determine if Cloudflare environment variables refresh without redeployment:

### 1. Worker-Level Test: `/worker-env-test`
- Simple Worker endpoint (no DO)
- Returns current `env.DEBUG` value
- Tests if Worker env refreshes

### 2. DO Test: `/env-test-do/{instance}/info`
- Durable Object that tracks constructor runs in storage
- Each constructor run records:
  - Timestamp
  - DEBUG value from env at that moment
  - Run number
- Shows both:
  - `debugFromConstructor`: Value captured in constructor
  - `debugFromEnvNow`: Current value from `this.env.DEBUG`
- Tracks all constructor runs in `constructorHistory`

### 3. DO Reset: `/env-test-do/{instance}/reset`
- Forces hard reset via `ctx.abort()`
- Next request will trigger constructor

### 4. DO Clear: `/env-test-do/{instance}/clear`
- Clears storage for fresh start
- Resets constructor history

## The Key Innovation: Storage-Based Constructor Tracking

We use `ctx.blockConcurrencyWhile()` to append to a `constructorRuns` array in storage.

Each entry captures:
```typescript
{
  timestamp: number,
  debugValue: string,  // env.DEBUG at constructor time
  runNumber: number,
  debugValueChanged: boolean  // Did it change from previous run?
}
```

This gives us **definitive proof** of:
1. Whether constructor actually ran
2. What env.DEBUG was at that exact moment
3. Whether it changed between runs

## Why This Matters for Debug System

If env vars refresh without deploy:
- ✅ Users can enable debug logging in production instantly
- ✅ No deploy downtime
- ✅ Can toggle logging on/off for troubleshooting

If env vars require deploy:
- ❌ Need to redeploy to change DEBUG
- ❌ Deploy takes time + might have side effects
- ❌ Less useful for live troubleshooting
- 📝 Need to document this limitation clearly

## Testing Sequence

1. **Initial Deploy**
   ```bash
   cd /Users/larry/Projects/mcp/lumenize/tooling/test-endpoints
   npx wrangler deploy
   ```

2. **Baseline** - Verify initial DEBUG="initial-value"
   - Worker: `curl $URL/worker-env-test`
   - DO: `curl $URL/env-test-do/test/info`

3. **Change DEBUG** (via dashboard or `wrangler secret put`)
   - Try to avoid triggering deploy if possible
   - Note the method used

4. **Test Worker** - Does it show new value?
   - `curl $URL/worker-env-test`

5. **Test DO Hibernation**
   - Wait 15+ seconds (no requests)
   - `curl $URL/env-test-do/test/info`
   - Check `constructorHistory` - did totalRuns increase?
   - If yes, what was the new run's debugValue?

6. **Test DO Hard Reset**
   - `curl -X POST $URL/env-test-do/test/reset`
   - `curl $URL/env-test-do/test/info`
   - Check new constructor run's debugValue

## What To Look For

### Strong Evidence: Constructor History

```json
{
  "constructorHistory": {
    "totalRuns": 2,
    "runs": [
      {
        "runNumber": 1,
        "debugValue": "initial-value",
        "timestamp": 1699564800000,
        "debugValueChanged": false
      },
      {
        "runNumber": 2,
        "debugValue": "changed-value",  // ← Did it change?
        "timestamp": 1699564815000,
        "debugValueChanged": true
      }
    ]
  }
}
```

If `debugValueChanged: true`, env vars ARE being refreshed! ✅

### Edge Case: Constructor vs Current

If we see:
```json
{
  "current": {
    "debugFromConstructor": "initial-value",  // Captured at constructor time
    "debugFromEnvNow": "changed-value"        // Read now from this.env
  }
}
```

This would mean:
- Env object itself is dynamic/mutable
- But constructor only runs with old env
- Very unusual but theoretically possible

## Files Created

- `src/EnvTestDO.ts` - New DO for env testing
- `src/index.ts` - Updated to add Worker endpoint and export EnvTestDO
- `wrangler.jsonc` - Added ENV_TEST_DO binding and DEBUG var
- `ENV_VAR_EXPERIMENT.md` - Detailed experiment protocol
- `WRANGLER_COMMANDS.md` - Command reference
- `EXPERIMENT_SUMMARY.md` - This file

## Ready to Deploy

```bash
cd /Users/larry/Projects/mcp/lumenize/tooling/test-endpoints
npx wrangler deploy

# Then follow ENV_VAR_EXPERIMENT.md for testing protocol
```

## Expected Outcome (Hypothesis)

Based on typical serverless architecture:
- **Env vars are version-bound** (baked into deployment)
- Changing DEBUG will require a redeploy
- `wrangler secret put` does an instant redeploy behind the scenes
- Constructor always sees value from current deployed version

But we're testing to be **certain**, because this affects our debug system UX significantly!

