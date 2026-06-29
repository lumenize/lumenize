/**
 * Spike A Stage 2 — facet env injection + isolation.
 * Proves a resolved secret reaches facet code, the facet cannot see the master
 * key, and nothing plaintext is persisted at rest. See tasks/spike-outside-world-secrets.md.
 */
import { env } from 'cloudflare:test';

const SECRET_BROKER = (env as unknown as { SECRET_BROKER: DurableObjectNamespace }).SECRET_BROKER;
const broker = () => SECRET_BROKER.get(SECRET_BROKER.idFromName(crypto.randomUUID())) as unknown as {
  seedSecret(level: 'star' | 'galaxy', name: string, plaintext: string): Promise<void>;
  runFacet(name: string, mode: 'galaxy-only' | 'star-only' | 'star-then-galaxy'): Promise<{
    has: boolean; length: number; sha256: string | null; masterKeyVisible: boolean; envKeys: string[];
  }>;
  dumpStorage(): Promise<string[]>;
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Stage 2 — facet secret injection', () => {
  it('facet receives the resolved secret; master key is not visible', async () => {
    const b = broker();
    await b.seedSecret('star', 'resend', 'STAR_KEY_xyz');
    const proof = await b.runFacet('resend', 'star-only');

    expect(proof.has).toBe(true);
    expect(proof.length).toBe('STAR_KEY_xyz'.length);
    expect(proof.sha256).toBe(await sha256Hex('STAR_KEY_xyz')); // got the RIGHT value, not just any
    // Isolation: the facet's entire env is the single injected secret — no master
    // key, no LOADER, no parent bindings.
    expect(proof.masterKeyVisible).toBe(false);
    expect(proof.envKeys).toEqual(['RESOLVED_SECRET']);
  });

  it('resolves the Galaxy level through the facet under galaxy-only', async () => {
    const b = broker();
    await b.seedSecret('star', 'resend', 'STAR_KEY');
    await b.seedSecret('galaxy', 'resend', 'GALAXY_KEY');
    const proof = await b.runFacet('resend', 'galaxy-only');
    expect(proof.sha256).toBe(await sha256Hex('GALAXY_KEY')); // ignored the populated star level
  });

  it('injects nothing when the configured source is empty', async () => {
    const b = broker();
    await b.seedSecret('galaxy', 'resend', 'GALAXY_KEY');
    const proof = await b.runFacet('resend', 'star-only'); // star empty under star-only
    expect(proof.has).toBe(false);
    expect(proof.masterKeyVisible).toBe(false);
  });

  it('keeps no plaintext at rest (only sealed blobs in storage)', async () => {
    const b = broker();
    await b.seedSecret('star', 'resend', 'PLAINTEXT_SECRET');
    await b.runFacet('resend', 'star-only');
    const values = await b.dumpStorage();
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).not.toContain('PLAINTEXT_SECRET');
  });
});
