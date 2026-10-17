import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ProbeMatrix, StubProbe } from '../src/probe';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

describe('rpc-stub-disposability probe — pool-workers (miniflare)', () => {
  it('dumps the 6-stub disposability matrix and asserts the known pool-workers facts', async () => {
    const res = await SELF.fetch('https://example.com/probe?runtime=pool-workers');
    expect(res.status).toBe(200);
    const matrix = (await res.json()) as ProbeMatrix;

    // Emit the full matrix so it can be lifted verbatim into FINDINGS.md.
    console.log('POOL_WORKERS_MATRIX_BEGIN');
    console.log(JSON.stringify(matrix, null, 2));
    console.log('POOL_WORKERS_MATRIX_END');

    const byType: Record<string, StubProbe> = Object.fromEntries(
      matrix.stubs.map((s) => [s.stubType, s]),
    );

    // Capable-of-failing: anchor on the KNOWN 2026-07-14 pool-workers facts so a regression — or an
    // environment that behaves differently — trips the suite instead of passing silently.
    expect(byType['do-stub-getByName'].symbolDispose).toBe('undefined');
    expect(byType['do-stub-getByName'].usingThrew).toBe(true);
    expect(byType['do-stub-get-idFromName'].symbolDispose).toBe('undefined');

    // The pointer tell: a fresh DO stub still sees prior state (pointer, not a held session).
    expect(matrix.behavior.doStatePersistsAcrossFreshStub).toBe(true);
  });
});
