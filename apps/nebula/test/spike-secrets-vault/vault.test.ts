/**
 * Spike A Stage 1 — crypto round-trip + 3-mode resolver.
 * Runs in the `unit` pool-workers project (real workerd, faithful crypto.subtle).
 * See tasks/spike-outside-world-secrets.md.
 */
import {
  importVaultKey,
  sealSecret,
  openSecret,
  resolveSecret,
  type SecretMode,
  type VaultLevel,
} from './vault';

const randomKey = () => importVaultKey(crypto.getRandomValues(new Uint8Array(32)));

/** An in-memory storage level holding already-sealed blobs, keyed by secret name. */
const level = (entries: Record<string, string>): VaultLevel => ({
  get: (name) => entries[name],
});

describe('vault crypto', () => {
  it('round-trips a secret through seal → open', async () => {
    const key = await randomKey();
    const secret = 're_live_abc123';
    const blob = await sealSecret(key, secret);
    expect(blob).not.toContain(secret); // ciphertext, not plaintext
    expect(await openSecret(key, blob)).toBe(secret);
  });

  it('uses a fresh IV per seal (same plaintext → different blobs)', async () => {
    const key = await randomKey();
    const a = await sealSecret(key, 'same');
    const b = await sealSecret(key, 'same');
    expect(a).not.toBe(b);
  });

  it('rejects a wrong key (GCM auth tag)', async () => {
    const blob = await sealSecret(await randomKey(), 'secret');
    await expect(openSecret(await randomKey(), blob)).rejects.toThrow();
  });

  it('rejects a tampered blob', async () => {
    const key = await randomKey();
    const blob = await sealSecret(key, 'secret');
    // Flip an INTERIOR char (a full-byte position). NOT the last char — its
    // trailing base64url bits can be "don't care" and decode unchanged, which
    // makes the tamper a no-op and the test flaky.
    const i = Math.floor(blob.length / 2);
    const tampered = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1);
    await expect(openSecret(key, tampered)).rejects.toThrow();
  });
});

describe('3-mode resolver', () => {
  let key: CryptoKey;
  let starOnly: { star: VaultLevel; galaxy: VaultLevel };
  let galaxyOnly: { star: VaultLevel; galaxy: VaultLevel };
  let both: { star: VaultLevel; galaxy: VaultLevel };
  let neither: { star: VaultLevel; galaxy: VaultLevel };

  beforeEach(async () => {
    key = await randomKey();
    const starBlob = await sealSecret(key, 'STAR_VALUE');
    const galaxyBlob = await sealSecret(key, 'GALAXY_VALUE');
    starOnly = { star: level({ resend: starBlob }), galaxy: level({}) };
    galaxyOnly = { star: level({}), galaxy: level({ resend: galaxyBlob }) };
    both = { star: level({ resend: starBlob }), galaxy: level({ resend: galaxyBlob }) };
    neither = { star: level({}), galaxy: level({}) };
  });

  const resolve = (mode: SecretMode, levels: { star: VaultLevel; galaxy: VaultLevel }) =>
    resolveSecret('resend', mode, key, levels);

  it("galaxy-only reads galaxy and ignores a populated star", async () => {
    expect(await resolve('galaxy-only', both)).toBe('GALAXY_VALUE');
    expect(await resolve('galaxy-only', starOnly)).toBeUndefined(); // star present, galaxy empty → undefined
  });

  it("star-only reads star and ignores a populated galaxy", async () => {
    expect(await resolve('star-only', both)).toBe('STAR_VALUE');
    expect(await resolve('star-only', galaxyOnly)).toBeUndefined(); // galaxy present, star empty → undefined
  });

  it("star-then-galaxy prefers star when present", async () => {
    expect(await resolve('star-then-galaxy', both)).toBe('STAR_VALUE');
    expect(await resolve('star-then-galaxy', starOnly)).toBe('STAR_VALUE');
  });

  it("star-then-galaxy falls back to galaxy when star is absent", async () => {
    expect(await resolve('star-then-galaxy', galaxyOnly)).toBe('GALAXY_VALUE');
  });

  it("returns undefined when the configured source is empty", async () => {
    expect(await resolve('star-then-galaxy', neither)).toBeUndefined();
    expect(await resolve('galaxy-only', neither)).toBeUndefined();
    expect(await resolve('star-only', neither)).toBeUndefined();
  });
});
