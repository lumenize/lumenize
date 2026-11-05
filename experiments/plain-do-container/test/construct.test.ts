import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';

// The KEY Q7 question: a container-bound DO that does NOT `extends Container` —
// does it CONSTRUCT under vitest-pool-workers? The first RPC instantiates the DO,
// so if construction throws, `await stub.ping()` rejects.
it('Q1: container-bound plain DO constructs + runs a non-container method', async () => {
  const stub = env.PLAIN_DO.get(env.PLAIN_DO.idFromName('spike')) as unknown as {
    ping(): Promise<string>;
  };
  const pong = await stub.ping();
  expect(pong).toBe('pong');
});

// Discovery (not an assertion): report whether the raw container API is even present here.
it('DISCOVERY: ctx.container presence under pool-workers', async () => {
  const stub = env.PLAIN_DO.get(env.PLAIN_DO.idFromName('spike')) as unknown as {
    containerApiPresent(): Promise<{ hasContainer: boolean; startType: string }>;
  };
  const info = await stub.containerApiPresent();
  console.log('[SPIKE] ctx.container under pool-workers:', JSON.stringify(info));
  expect(info).toBeDefined();
});
