import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * Regression tests for mesh call-target validation (D6 tier 1 — loud sync-throw at the call site).
 *
 * Routing is decided by binding shape (isDONamespace), not instance-name presence alone. A
 * misrouted target (Worker binding given an instance name, DO binding missing one, unknown
 * binding) throws SYNCHRONOUSLY inside `call()` (via `assertCallTarget`), BEFORE the async hop —
 * so it surfaces as a rejected initiator call rather than a silently-dropped fire-and-forget.
 * See packages/mesh/src/lmz-api.ts `assertCallTarget` + `callShared`.
 */
describe('@lumenize/mesh - call target validation', () => {
  it('Worker binding + instance name throws (not silently dropped)', async () => {
    const caller = env.TEST_DO.getByName('ctv-worker-instance');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'ctv-worker-instance' });
    await expect(
      caller.testCallWithContinuations('TEST_WORKER', 'some-label', 'hi')
    ).rejects.toThrow(/Worker\/service binding .* instance name/);
  });

  it('DO binding without an instance name throws', async () => {
    const caller = env.TEST_DO.getByName('ctv-do-noinstance');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'ctv-do-noinstance' });
    await expect(
      caller.testCallWithContinuations('TEST_DO', undefined, 'hi')
    ).rejects.toThrow(/Durable Object namespace .* requires an instance name/);
  });

  it('unknown binding name throws', async () => {
    const caller = env.TEST_DO.getByName('ctv-unknown');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'ctv-unknown' });
    await expect(
      caller.testCallWithContinuations('NOPE_BINDING', 'x', 'hi')
    ).rejects.toThrow(/no binding named 'NOPE_BINDING'/);
  });

  it('valid DO call still works (positive control)', async () => {
    const caller = env.TEST_DO.getByName('ctv-valid-do-call');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'ctv-valid-do-call' });

    caller.callForOutcome('TEST_DO', 'ctv-valid-callee', 'remoteEcho', ['ping']);

    await vi.waitFor(async () => {
      expect(await caller.getLastCallResult()).toBe('echo: ping');
    });
  });
});
