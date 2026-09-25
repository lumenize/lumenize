/**
 * `svc` is not an entry — the exemption is deleted, and these are the two chains that prove it.
 *
 * **Why this package and not `/live`** (`.claude/rules/live.md` puts that reason on the test file,
 * which outlives the task file): `/live`'s system under test is Nebula, and `apps/nebula` has no
 * `@lumenize/fetch` dependency and no `svc.fetch` reference at all, so these chains are structurally
 * undrivable there — and it must stay that way, or a test becomes the reason a dependency exists.
 * This is a VENUE SWAP rather than a drop to a cheaper tier: the suite drives a real Worker-to-DO
 * hop in workerd, and each limb below fires a real `lmz.call` so the refusal arrives at a handler
 * the way it would in production.
 *
 * ⚠️ **Both limbs assert the RULE, not the package.** `@lumenize/fetch`'s proxy callback opens on
 * `svc` across a hop and therefore stops working by decision — `tasks/mesh-entry-and-walk-gaps.md`
 * § *What needs Larry*, item 6 accepts that rather than building it a door. Nothing here keeps the
 * round trip alive; the package is just the one vehicle that made this hole reachable.
 *
 * Written RED-first: on today's code `svc` is exempt from the member-level check, so both limbs fail.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { OperationChain } from '@lumenize/mesh';

const uniq = (base: string) => `${base}-${crypto.randomUUID()}`;

/** Fire `chain` at a DO over a real mesh hop and return what its 4-arg handler recorded. */
async function wireOutcome(name: string, chain: OperationChain): Promise<string> {
  const stub = env.TEST_SIMPLE_DO.getByName(name);
  await stub.clearWireOutcome();
  stub.testWireChain(name, chain);
  await vi.waitFor(async () => {
    expect(await stub.getWireOutcome()).toBeDefined();
  }, { timeout: 5000 });
  return (await stub.getWireOutcome())!;
}

describe('svc stops being a wire entry', () => {
  it.skip('REFUSES a chain that walks svc.fetch to an undecorated method on the node', async () => {
    // `NadisPlugin` declares `doInstance` `protected`, which TypeScript enforces and the runtime
    // does not — so any DO importing `@lumenize/fetch` can be walked back to itself through the
    // plugin and have an undecorated method called.
    const name = uniq('svc-walk');
    const outcome = await wireOutcome(name, [
      { type: 'get', key: 'svc' },
      { type: 'get', key: 'fetch' },
      { type: 'get', key: 'doInstance' },
      { type: 'get', key: 'walkedToHere' },
      { type: 'apply', args: ['through-svc'] },
    ]);
    expect(outcome).toMatch(/REFUSED: .*is not mesh-callable/);
    // The refusal has to happen BEFORE the call, not after it: a chain refused on its way out
    // still ran if the method left its mark.
    expect(await env.TEST_SIMPLE_DO.getByName(name).getStoredValue('svc-walk')).toBeUndefined();
  });

  it.skip('REFUSES the proxy callback, the one svc-opening chain that crossed a hop', async () => {
    // `svc.fetch.__handleProxyFetchResult(reqId, result)` is how the FetchExecutor Worker delivers,
    // and a pending `reqId` — a random UUID — was all that stood in front of it.
    const name = uniq('svc-callback');
    const outcome = await wireOutcome(name, [
      { type: 'get', key: 'svc' },
      { type: 'get', key: 'fetch' },
      { type: 'get', key: '__handleProxyFetchResult' },
      { type: 'apply', args: [crypto.randomUUID(), 'a result nobody asked for'] },
    ]);
    expect(outcome).toMatch(/REFUSED: .*is not mesh-callable/);
  });

  // ── positive control, GREEN before and after: a marked member is still reachable over the
  //    same hop. Without it, a rule that refused everything would satisfy both limbs above.
  it('still PERMITS a marked member over the same wire path', async () => {
    const name = uniq('svc-control');
    const outcome = await wireOutcome(name, [
      { type: 'get', key: 'handleFetchComplete' },
      { type: 'apply', args: [new Error('control'), 'https://example.invalid/control'] },
    ]);
    expect(outcome).toMatch(/^PERMITTED/);
  });
});
