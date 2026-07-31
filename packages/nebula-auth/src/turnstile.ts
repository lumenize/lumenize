/**
 * Cloudflare Turnstile server-side verification.
 *
 * ⚠️ **COPIED from `packages/auth/src/turnstile.ts` on 2026-07-31, and this is a DELIBERATE
 * DIVERGENCE that must NOT be re-synced.** `@lumenize/nebula-auth` no longer depends on
 * `@lumenize/auth` (`tasks/nebula-auth-decouple-from-auth.md`); the two copies are free to drift.
 * A future session diffing them and "unifying" them would look diligent while silently restoring
 * the coupling this file exists to delete. Don't.
 *
 * **Renamed on arrival** (`verifyTurnstileToken` → `verifyNebulaTurnstileToken`): the original stays
 * live in `packages/auth` (`turnstile.ts`, `create-auth-routes.ts`, `index.ts`), so an
 * identically-named copy would be ambiguous at every call site repo-wide. Removing the manifest entry only closes the
 * accidental-*import* hazard inside this package, not the reader-ambiguity one everywhere else.
 *
 * @see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Result of Turnstile token verification
 */
export interface NebulaTurnstileVerifyResult {
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
export async function verifyNebulaTurnstileToken(
  secretKey: string,
  token: string,
): Promise<NebulaTurnstileVerifyResult> {
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
