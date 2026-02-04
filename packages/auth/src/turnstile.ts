/**
 * Cloudflare Turnstile server-side verification.
 *
 * @see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 * @see https://lumenize.com/docs/auth/getting-started#createauthroutes
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
