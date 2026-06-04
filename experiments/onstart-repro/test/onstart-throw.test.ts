import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

describe('DO constructor blockConcurrencyWhile throws after console.debug', () => {
  it('test passes, then vitest hangs at teardown', async () => {
    const stub = env.BROKEN.getByName('broken-1');
    await expect(stub.getValue()).rejects.toThrow(
      'Intentional throw in blockConcurrencyWhile'
    );
  });
});
