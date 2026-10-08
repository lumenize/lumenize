/**
 * Cloudflare Turnstile server-side verification.
 *
 * ⚠️ **COPIED from `packages/auth/src/turnstile.ts` on 2026-07-31, and this is a DELIBERATE
 * DIVERGENCE that must NOT be re-synced.** Mesh's auth layer does not depend on `@lumenize/auth`
 * (`tasks/archive/nebula-auth-decouple-from-auth.md`); the two copies are free to drift. A future
 * session diffing them and "unifying" them would look diligent while silently restoring the
 * coupling this file exists to delete. Don't.
 *
 * The two copies share the name `verifyTurnstileToken` until `@lumenize/auth` leaves the repo, which
 * `@lumenize/mesh/auth` replaces, so the bare name goes to the copy that stays.
 *
 * @see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Result of Turnstile token verification
 */
export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
}

/**
 * Verify a Turnstile token against the Cloudflare siteverify endpoint.
 *
 * @param secretKey - Turnstile secret key from the Cloudflare dashboard
 * @param token - The `cf-turnstile-response` token from the client widget
 * @returns `{ success: true }` or `{ success: false, errorCodes: [...] }`
 */
export async function verifyTurnstileToken(
  secretKey: string,
  token: string,
): Promise<TurnstileVerifyResult> {
  const formData = new FormData();
  formData.append('secret', secretKey);
  formData.append('response', token);

  const response = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    body: formData,
  });

  const result = await response.json() as {
    success: boolean;
    'error-codes'?: string[];
  };

  return {
    success: result.success,
    errorCodes: result['error-codes'],
  };
}
