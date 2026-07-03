import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';

/**
 * Phase 1a feasibility proof for `tasks/mesh-continuation-only-calls.md`.
 *
 * The load-bearing premise (D15 / criterion 10 / the ALS spike): a mesh node's
 * `__executeOperation` **acks early** (admission only), then runs the chain + fire-back as a
 * DETACHED task under `ctx.waitUntil`, re-bound to the envelope's callContext. This file
 * proves, DO→DO under pool-workers:
 *  1. a 4-arg call's traveling handler is delivered via the fire-back (`__handleResponse`);
 *  2. `__executeOperation` returns `{$ack:true}` BEFORE the chain finishes (early-ack, not late);
 *  3. a callee that early-acks then does a REAL 2s post-ack gap STILL fires back
 *     (`DurableObjectState.waitUntil` keeps the DO alive — the premise that, if false,
 *     forces D15 back to a per-node-type branch before Phase 2);
 *  4. interleaved early-ack calls stay isolated — each handler gets its own result.
 *
 * Note: under the new model a caller's identity must be a REAL, resolvable binding (the
 * callee fires back to `env[returnAddr.bindingName]`), so callers init to `TEST_DO` + their
 * own `getByName` name. The true-hibernation confirmation is the Phase-1 `wrangler dev` bullet.
 */

// A bare OCAN chain — [get method, apply args] — hand-built so the test needs no ctn().
function chainFor(method: string, args: any[]) {
  return [{ type: 'get', key: method }, { type: 'apply', args }];
}

describe('@lumenize/mesh — continuation-only calls (Phase 1a feasibility)', () => {
  it('4-arg call: traveling handler + early-ack + fire-back delivers the result (DO→DO)', async () => {
    const caller = env.TEST_DO.getByName('feasib-basic-caller');
    // Caller identity must be its REAL binding+instance so the callee can fire back to it.
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'feasib-basic-caller' });

    caller.testCallSlow('TEST_DO', 'feasib-basic-callee', 'hello', 0);

    await vi.waitFor(async () => {
      expect(await caller.getLastCallResult()).toBe('echo: hello');
    }, { timeout: 5000, interval: 50 });

    // ALS across the fire-back: the handler ran under the propagated response-leg
    // callContext (origin + callee appended), not a bare/empty context.
    expect(await caller.getLastHandlerCallChainLen() as number).toBeGreaterThanOrEqual(2);
  });

  it('__executeOperation ACKS EARLY: {$ack} returns before the slow chain completes', async () => {
    const callee = env.TEST_DO.getByName('feasib-earlyack-callee');

    const envelope = {
      version: 1,
      chain: preprocess(chainFor('slowEcho', ['ea', 1500])),
      callContext: {
        callChain: [{ type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'feasib-earlyack-origin' }],
        state: {},
      },
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'feasib-earlyack-callee' } },
    };

    const ack = await callee.__executeOperation(envelope as any);

    // Admitted — the entry returns an ACK, never the chain's {$result}.
    expect(ack).toEqual({ $ack: true });
    // Early-ack is the point: the post-ack chain has NOT finished yet (its completion marker
    // is written only AFTER the 1500ms delay). Under a late-ack design this would already be set.
    expect(await callee.getSlowDone()).toBeFalsy();

    // …and the detached post-ack tail still completes under ctx.waitUntil.
    await vi.waitFor(async () => {
      expect(await callee.getSlowDone()).toBe('ea');
    }, { timeout: 6000, interval: 50 });
  });

  it('DO-liveness (criterion 10): callee early-acks then does LONG (2s) post-ack work and STILL fires back', async () => {
    const caller = env.TEST_DO.getByName('feasib-slow-caller');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'feasib-slow-caller' });

    caller.testCallSlow('TEST_DO', 'feasib-slow-callee', 'slow', 2000);

    // If DurableObjectState.waitUntil does NOT keep the callee alive across the 2s gap,
    // the fire-back never lands and this times out (the premise fails → D15 must be revisited).
    await vi.waitFor(async () => {
      expect(await caller.getLastCallResult()).toBe('echo: slow');
    }, { timeout: 10_000, interval: 100 });

    expect(await caller.getLastHandlerCallChainLen() as number).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('interleaved early-ack calls stay isolated: each handler receives its OWN result', async () => {
    const caller = env.TEST_DO.getByName('feasib-many-caller');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'feasib-many-caller' });

    const values = ['a', 'b', 'c', 'd', 'e'];
    caller.testCallMany('TEST_DO', 'feasib-many-callee', values, 300);

    await vi.waitFor(async () => {
      const results = await caller.getManyResults();
      expect(results.length).toBe(values.length);
    }, { timeout: 8000, interval: 100 });

    const results = await caller.getManyResults();
    // No cross-contamination: every handler matched its own expected value, and all five
    // distinct results are present.
    expect(results.every((r: any) => r.matches)).toBe(true);
    expect(new Set(results.map((r: any) => r.actual)).size).toBe(values.length);
  }, 12_000);
});

describe('@lumenize/mesh — continuation-only calls (failure modes: D6 / N8 / N9)', () => {
  it('N8: a handler that throws at the sink is caught + logged, never crashes the caller', async () => {
    const entries: any[] = [];
    setDebugSink((e) => entries.push(e));
    try {
      const caller = env.TEST_DO.getByName('n8-caller');
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'n8-caller' });

      caller.testCallThrowingHandler('TEST_DO', 'n8-callee');

      // The handler DID run (marker set), and its throw was surfaced to the debug sink — not
      // silently swallowed, not a crash.
      await vi.waitFor(async () => { expect(await caller.getSinkHandlerRan()).toBe(true); });
      await vi.waitFor(() => {
        expect(entries.some((e) => typeof e.message === 'string' && e.message.includes('post-ack chain threw'))).toBe(true);
      });
      // The caller node is still responsive after the sink throw.
      expect(await caller.testLmzType()).toBe('LumenizeDO');
    } finally {
      clearDebugSink();
    }
  });

  it('N9: a fire-back runs the handler on a COLD caller (zero in-memory state) purely from the envelope', async () => {
    // Drive __handleResponse directly with a hand-built fire-back — no prior call() populated any
    // in-memory state on this instance. The handler runs from the envelope + storage alone, and the
    // cold caller even learns its identity from the fire-back metadata (proves "caller holds ZERO state").
    const caller = env.TEST_DO.getByName('n9-cold-caller');
    const fireBack = {
      version: 1,
      chain: preprocess([{ type: 'get', key: 'handleResultWithContext' }, { type: 'apply', args: ['restored-from-envelope'] }]),
      callContext: {
        callChain: [
          { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'n9-origin' },
          { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'n9-callee' },
        ],
        state: {},
      },
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'n9-cold-caller' } },
    };

    const ack = await caller.__handleResponse(fireBack as any);
    expect(ack).toEqual({ $ack: true });

    await vi.waitFor(async () => { expect(await caller.getLastCallResult()).toBe('restored-from-envelope'); });
    // Identity was restored from the fire-back envelope metadata, not from any prior in-memory call.
    expect(await caller.testLmzGetInstanceName()).toBe('n9-cold-caller');
  });

  it('D6 tier 2: an admission reject returns on the ACK and runs the handler LOCALLY with the Error', async () => {
    const caller = env.TEST_DO.getByName('reject-caller');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'reject-caller' });

    // REJECTING_DO.onBeforeCall throws → the callee rejects at admission → the ack carries the Error
    // → the framework runs the caller's handler LOCALLY (no fire-back — the caller is still hot).
    caller.testCallToRejecter('REJECTING_DO', 'reject-target');

    await vi.waitFor(async () => {
      expect(await caller.getLastCallError()).toContain('admission rejected by onBeforeCall');
    });
  });
});
