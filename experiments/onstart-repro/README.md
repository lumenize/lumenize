# Repro: `@cloudflare/vitest-pool-workers` hangs at teardown when a DO `blockConcurrencyWhile` IIFE both emits a `console.*` call and throws

## Summary

A `DurableObject` whose constructor schedules `ctx.blockConcurrencyWhile(async () => { ... })`, and whose IIFE both (a) emits a `console.*` call and (b) throws, causes `@cloudflare/vitest-pool-workers` to hang at isolate teardown. The test assertion passes — the hang happens **after** the test resolves, during vitest's process exit.

Removing either the `console.*` call **or** the throw makes vitest exit cleanly.

The hang is **vitest-only**. The same Worker deployed to `*.workers.dev` handles the same broken DO cleanly: workerd evicts the broken instance and recreates it on the next request, and the rest of the Worker (including other DO classes / other instances of the same class) is unaffected.

## Run

```
npm install
npm test       # hangs (test passes, then process never exits)
```

To see the clean case for comparison, delete the `console.log(...)` line in `src/index.ts` and `npm test` — exits in ~300 ms with the test passing.

## Files

- `src/index.ts` — single DO class with the minimum-trigger constructor
- `wrangler.jsonc` — one DO binding, no compatibility flags beyond the date
- `test/onstart-throw.test.ts` — single `it` that asserts the rejection
- `vitest.config.ts` — minimum `cloudflareTest` config

## Environment

- `vitest@4.1.4`
- `@cloudflare/vitest-pool-workers@0.16.13`
- `wrangler@4.86.0`
- `compatibility_date: "2026-03-12"` (also reproduces under earlier dates we tested)
- macOS 25.3.0 (Darwin), Node 22 LTS

## Production check

A worker with the same DO was deployed to a real `*.workers.dev` host. Calls to the broken instance returned a `500` with the constructor's error message in 200-500 ms each (cold-start range). 20 parallel requests all returned the same error; a sibling healthy DO returned in 21 ms warm immediately afterward. Workerd evicts and recreates the broken DO on each request — there is no permanent input-gate wedge in production.

## Hypothesis

`vitest-pool-workers`'s isolate-shutdown path appears to await drainage of the input gate for any DO that had pending work. A DO whose constructor's `blockConcurrencyWhile` rejected AFTER emitting console output is left in a state the teardown can't drain. Workerd itself doesn't sit on this state in production — it just evicts.
