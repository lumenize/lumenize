/**
 * The webhook's signature check, against Svix's own published test vector rather than a signature this
 * file computes: a vector made with the code under test would agree with it however wrong it was.
 */
import { describe, it, expect } from 'vitest';
import { verifySvixSignature, SIGNATURE_TOLERANCE_SECONDS } from '../src/svix-verify';

// Svix's documented example: secret, message id, timestamp, payload and the signature they produce.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TIMESTAMP = 1614265330;
const BODY = '{"test": 2432232314}';
const SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';

const headers = (overrides: Record<string, string> = {}) => new Headers({
  'svix-id': ID, 'svix-timestamp': String(TIMESTAMP), 'svix-signature': SIGNATURE, ...overrides,
});

describe('verifySvixSignature', () => {
  it("accepts Svix's own example delivery", async () => {
    expect(await verifySvixSignature(SECRET, headers(), BODY, TIMESTAMP)).toBe(true);
  });

  it('accepts the good signature among several, as a secret rotation sends', async () => {
    const rotated = headers({ 'svix-signature': `v1,AAAA${SIGNATURE.slice(7)} ${SIGNATURE}` });
    expect(await verifySvixSignature(SECRET, rotated, BODY, TIMESTAMP)).toBe(true);
  });

  it('refuses a body changed by one byte', async () => {
    expect(await verifySvixSignature(SECRET, headers(), BODY.replace('2432232314', '2432232315'), TIMESTAMP)).toBe(false);
  });

  it('refuses another secret', async () => {
    expect(await verifySvixSignature('whsec_' + btoa('not the secret at all'), headers(), BODY, TIMESTAMP)).toBe(false);
  });

  it('refuses a delivery older or newer than the tolerance, and takes one at its edge', async () => {
    expect(await verifySvixSignature(SECRET, headers(), BODY, TIMESTAMP + SIGNATURE_TOLERANCE_SECONDS)).toBe(true);
    expect(await verifySvixSignature(SECRET, headers(), BODY, TIMESTAMP + SIGNATURE_TOLERANCE_SECONDS + 1)).toBe(false);
    expect(await verifySvixSignature(SECRET, headers(), BODY, TIMESTAMP - SIGNATURE_TOLERANCE_SECONDS - 1)).toBe(false);
  });

  it('refuses a missing header and a signature under another version', async () => {
    const noId = headers(); noId.delete('svix-id');
    expect(await verifySvixSignature(SECRET, noId, BODY, TIMESTAMP)).toBe(false);
    expect(await verifySvixSignature(SECRET, headers({ 'svix-signature': SIGNATURE.replace('v1,', 'v2,') }), BODY, TIMESTAMP)).toBe(false);
  });
});
