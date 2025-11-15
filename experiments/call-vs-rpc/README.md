# Call vs RPC Experiment

Validates the production-ready `@lumenize/call` V4 against pure Workers RPC.

## Patterns

### V1: Workers RPC (Baseline)
Standard Cloudflare Workers RPC - the baseline for comparison.

```typescript
async #runV1Rpc(index: number): Promise<void> {
  const stub = this.env.REMOTE_DO.get(id);
  const result = await stub.echo(`v1-${index}`);
  // Validate and mark complete
}
```

### V2: @lumenize/call V4
Production `@lumenize/call` with:
- Synchronous API (no `await`)
- Continuation-based handlers
- `blockConcurrencyWhile` pattern

```typescript
#runV2Call(index: number): void {  // Returns immediately!
  const remoteOp = this.ctn<RemoteDO>().echo(`v2-${index}`);
  const handlerCtn = this.ctn().#handleV2Result(remoteOp, index);
  this.svc.call('REMOTE_DO', 'remote', remoteOp, handlerCtn);
}
```

## Running

**Local development:**
```bash
# Terminal 1: Start dev server
npx wrangler dev --port 8787

# Terminal 2: Run test
npm test 100              # 100 operations
npm test 100 reverse      # Reverse order (test JIT effects)
```

**Production:**
```bash
npx wrangler deploy
TEST_URL=https://call-vs-rpc.YOUR_SUBDOMAIN.workers.dev npm test 100
```

## Expected Results

Both patterns should perform equivalently (~15-20ms/op in production) since network latency dominates.

The key finding is that **@lumenize/call adds zero performance penalty** while providing:
- Synchronous API
- Type-safe continuations
- Operation composition support

## Architecture

Uses `LumenizeExperimentDO` from `@lumenize/for-experiments`:
- Extends `LumenizeBase` (full NADIS support)
- Adds experiment framework via composition
- WebSocket for batch execution
- Client-side timing for accuracy

