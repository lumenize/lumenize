import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * Regression tests for mesh call-target validation.
 *
 * Before the fix, routing was decided purely by instance-name presence, so a
 * Worker/service binding called with an instance name was handed to getDOStub →
 * `getByName is not a function`, thrown into an unawaited fire-and-forget promise
 * and silently dropped (no error, no delivery). Now lmz.call/callRaw duck-type the
 * binding (isDONamespace) and throw synchronously at the call site.
 * See packages/mesh/src/lmz-api.ts `assertCallTarget`.
 */
describe('@lumenize/mesh - call target validation', () => {
  it('callRaw: Worker binding + instance name throws (not silently dropped)', async () => {
    const caller = env.TEST_DO.getByName('ctv-callraw-worker-instance');
    await expect(
      caller.testCallRawWithContinuation('TEST_WORKER', 'some-label', 'hi')
    ).rejects.toThrow(/Worker\/service binding .* instance name/);
  });

  it('callRaw: DO binding without an instance name throws', async () => {
    const caller = env.TEST_DO.getByName('ctv-callraw-do-noinstance');
    await expect(
      caller.testCallRawWithContinuation('TEST_DO', undefined, 'hi')
    ).rejects.toThrow(/Durable Object namespace .* requires an instance name/);
  });

  it('callRaw: unknown binding name throws', async () => {
    const caller = env.TEST_DO.getByName('ctv-callraw-unknown');
    await expect(
      caller.testCallRawWithContinuation('NOPE_BINDING', 'x', 'hi')
    ).rejects.toThrow(/no binding named 'NOPE_BINDING'/);
  });

  it('call (fire-and-forget): Worker binding + instance name surfaces synchronously instead of being dropped', async () => {
    const caller = env.TEST_DO.getByName('ctv-call-worker-instance');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'ctv-call-worker-instance' });
    await expect(
      caller.testCallWithContinuations('TEST_WORKER', 'some-label', 'hi')
    ).rejects.toThrow(/Worker\/service binding .* instance name/);
  });

  it('valid DO call still works (positive control)', async () => {
    const caller = env.TEST_DO.getByName('ctv-valid-do-call');
    const result = await caller.testCallRawWithContinuation('TEST_DO', 'ctv-valid-callee', 'ping');
    expect(result).toBe('echo: ping');
  });
});
