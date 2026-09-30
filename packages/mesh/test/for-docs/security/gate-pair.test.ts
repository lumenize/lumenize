/**
 * The gate pair, DRIVEN — LumenizeClient → Worker → Gateway → DO, both halves.
 *
 * ⚠️ **A fixture with no assertions passes `npm run test:doc` and the whole-suite run alike.** The
 * `@check-example` checker reads the doc block against the source and never instantiates anything,
 * and `test:doc` does not run this directory — so a published example teaching an access check
 * could sit here with the check never performed. This file is what stops that: it drives the real
 * mesh path and asserts BOTH halves, refused and permitted.
 *
 * ⚠️ Real mesh path, never `createTestingClient` — `testing.md` forbids that for a fixture
 * demonstrating a guard, and the recorder proving the undecorated getter never ran is read back
 * THROUGH the mesh rather than from stdio.
 */
import { it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { SecurityClient } from './security-client.js';
import { createTestRefreshFunction, type LumenizeClientGateway } from '../../../src/index.js';
import type { GatePairDO } from './gate-pair-do.js';

const ORIGIN = 'https://example.com';

async function connect(isAdmin: boolean) {
  const browser = new Browser();
  const ctx = browser.context(ORIGIN);
  const client = new SecurityClient({
    baseUrl: ORIGIN,
    gatewayBindingName: 'LUMENIZE_CLIENT_GATEWAY',
    refresh: createTestRefreshFunction({ sub: `u-${crypto.randomUUID()}`, isAdmin }),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  } as never);
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

it('a `@mesh()` getter gate is reachable and an UNDECORATED one is refused without running', async () => {
  const instance = `gate-pair-${crypto.randomUUID()}`;
  const admin = await connect(true);
  try {
    // PERMITTED — the guard runs at the entry op, then the chain walks onto what it handed back.
    await admin.lmz.callAsync(
      'GATE_PAIR_DO', instance,
      admin.ctn<GatePairDO>().settings.write('on'),
      { timeoutMs: 10_000 },
    );
    expect(await admin.lmz.callAsync(
      'GATE_PAIR_DO', instance, admin.ctn<GatePairDO>().settings.read(), { timeoutMs: 10_000 },
    )).toBe('on');

    // REFUSED — the same capability, reached through the getter that has no `@mesh()`.
    await expect(admin.lmz.callAsync(
      'GATE_PAIR_DO', instance, admin.ctn<GatePairDO>().settingsForResults.read(), { timeoutMs: 10_000 },
    )).rejects.toThrow(/is not mesh-callable/);

    // …and refused WITHOUT running, which is the property a reader cannot infer from the
    // refusal alone: the check reads the descriptor, never the property.
    const node = (env as any).GATE_PAIR_DO.getByName(instance) as DurableObjectStub<GatePairDO>;
    expect(await node.undecoratedGateRan).toBe(false);

    // The GUARD still decides who gets through the `@mesh()` getter — without this, a rule that let
    // anything through the gate would satisfy the two halves above.
    const outsider = await connect(false);
    try {
      await expect(outsider.lmz.callAsync(
        'GATE_PAIR_DO', instance, outsider.ctn<GatePairDO>().settings.read(), { timeoutMs: 10_000 },
      )).rejects.toThrow(/Admin access required/);
    } finally {
      outsider[Symbol.dispose]();
    }
  } finally {
    admin[Symbol.dispose]();
  }
}, 30000);
