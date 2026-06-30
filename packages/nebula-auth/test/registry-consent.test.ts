/**
 * Phase 3 — consent recorded at claimUniverse + the consented-corpus filter.
 *
 * claimUniverse throws 409 if the row already exists, so it only ever INSERTs a fresh row — consent
 * is written there (plain INSERT, value 1 = assume-true). The corpus filter returns only consent=1
 * Universes, excluding NULL sub-instances, declined (0) rows, and the reserved platform pseudo-Universe.
 */
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { PLATFORM_INSTANCE_NAME } from '../src/types';

describe('consent at claimUniverse + the consented corpus', () => {
  it('claimUniverse writes consent=1; the Universe appears in the consented corpus', async () => {
    const registry: any = env.NEBULA_AUTH_REGISTRY.getByName(`reg-claim-${crypto.randomUUID()}`);
    await registry.claimUniverse('acme', 'a@example.com', 'https://nebula.example');
    const corpus = await registry.listConsentedInstances();
    expect(corpus).toContain('acme');
    // mutation-check: if claimUniverse's INSERT drops the consent write, 'acme' lands NULL and falls
    // out of the `= 1` corpus filter — this assertion reddens.
  });

  it('corpus filter: only consent=1 user Universes; NULL, declined-0, and platform are excluded', async () => {
    const stub: any = env.NEBULA_AUTH_REGISTRY.getByName(`reg-corpus-${crypto.randomUUID()}`);
    const corpus = await (runInDurableObject as any)(stub, (instance: any, ctx: any) => {
      const now = Date.now();
      const ins = (name: string, consent: number | null) =>
        ctx.storage.sql.exec(
          'INSERT INTO Instances (instanceName, createdAt, improveProductConsent) VALUES (?, ?, ?)',
          name, now, consent,
        );
      ins('acme', 1);                 // consented user Universe → included
      ins('acme.crm', null);          // sub-instance NULL (inherit) → excluded by `= 1`
      ins('beta', 0);                 // declined fixture → excluded (guards `= 1` vs a weakened `IS NOT NULL`)
      ins(PLATFORM_INSTANCE_NAME, 1); // platform: consent=1 but excluded by the `!= platform` filter
      return instance.listConsentedInstances();
    });
    // Exact set: each excluded row is an independent mutation (drop the `!= platform` → platform appears;
    // weaken `= 1` to `IS NOT NULL` → 'beta' appears; both redden this assertion).
    expect(corpus).toEqual(['acme']);
  });
});
