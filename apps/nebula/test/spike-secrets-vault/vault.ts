/**
 * Spike A — two-level secrets vault: encrypt-at-rest + 3-mode resolver.
 *
 * Exploratory spike code, NOT production-blessed (deliberately under test/, not
 * src/). See tasks/spike-outside-world-secrets.md. AES-256-GCM via crypto.subtle
 * — the established crypto path (packages/auth/src/jwt.ts). At-rest blob is
 * base64url(iv ‖ ciphertext) with a fresh 12-byte IV per seal.
 */

export type SecretMode = 'galaxy-only' | 'star-only' | 'star-then-galaxy';

const ALG = 'AES-GCM';
const IV_BYTES = 12;

/** Import a 32-byte raw key (sourced from the NEBULA_SECRETS_KEY Workers Secret). */
export async function importVaultKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ALG, false, ['encrypt', 'decrypt']);
}

/** Encrypt a UTF-8 plaintext into a `base64url(iv ‖ ciphertext)` at-rest blob. */
export async function sealSecret(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: ALG, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const packed = new Uint8Array(IV_BYTES + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), IV_BYTES);
  return toB64Url(packed);
}

/** Inverse of {@link sealSecret}. Throws on a wrong key or a tampered blob (GCM auth tag). */
export async function openSecret(key: CryptoKey, blob: string): Promise<string> {
  const buf = fromB64Url(blob);
  const iv = buf.subarray(0, IV_BYTES);
  const ct = buf.subarray(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: ALG, iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** One storage level (Galaxy or Star). Returns the sealed blob for `name`, or undefined if absent. */
export interface VaultLevel {
  get(name: string): string | undefined | Promise<string | undefined>;
}

/**
 * Resolve a secret across the two levels per the Galaxy-governed `mode`.
 * Returns plaintext, or `undefined` when the configured source(s) hold no value.
 * The mode — not the caller — decides which level(s) are consulted.
 */
export async function resolveSecret(
  name: string,
  mode: SecretMode,
  key: CryptoKey,
  levels: { star: VaultLevel; galaxy: VaultLevel },
): Promise<string | undefined> {
  const tryLevel = async (level: VaultLevel): Promise<string | undefined> => {
    const sealed = await level.get(name);
    return sealed === undefined ? undefined : openSecret(key, sealed);
  };
  switch (mode) {
    case 'galaxy-only':
      return tryLevel(levels.galaxy);
    case 'star-only':
      return tryLevel(levels.star);
    case 'star-then-galaxy': {
      const fromStar = await tryLevel(levels.star);
      return fromStar !== undefined ? fromStar : tryLevel(levels.galaxy);
    }
  }
}

// ─── base64url (workerd has atob/btoa) ───────────────────────────────

function toB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
