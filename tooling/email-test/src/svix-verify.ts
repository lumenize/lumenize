/**
 * Verify a Resend webhook delivery. Resend signs through Svix, so this is Svix's documented manual
 * scheme (https://docs.svix.com/receiving/verifying-payloads/how-manual): HMAC-SHA256, keyed with the
 * base64 part of the `whsec_…` secret, over `${svix-id}.${svix-timestamp}.${raw body}`, matched against
 * any of the space-separated `v1,<base64>` entries in `svix-signature`.
 *
 * Written out rather than taken from the `svix` package: it is a dozen lines of WebCrypto, and the
 * receiving Worker then carries no dependency for it.
 */

/** How far `svix-timestamp` may sit from this Worker's clock, so a captured delivery cannot be replayed later. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * `true` only for a delivery signed with `secret` within the tolerance. `body` MUST be the raw request
 * text: parsing and re-serialising it changes the bytes the signature covers.
 */
export async function verifySvixSignature(
  secret: string,
  headers: Headers,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature');
  if (!id || !timestamp || !signatures) return false;
  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(nowSeconds - sentAt) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw', base64ToBytes(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = bytesToBase64(new Uint8Array(mac));
  return signatures.split(' ').some((entry) => {
    const [version, signature] = entry.split(',');
    return version === 'v1' && signature !== undefined && constantTimeEqual(signature, expected);
  });
}

/** Equal strings, compared without stopping at the first difference, so timing says nothing about where it was. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
