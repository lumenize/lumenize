import { routeDORequest, type CorsOptions } from '@lumenize/utils';
import { verifyTurnstileToken } from './turnstile';
import type { AuthRoutesOptions } from './types';

/**
 * Creates an auth routes handler that wraps routeDORequest with URL rewriting.
 *
 * This is a thin Worker-level wrapper — it rewrites the URL to include the
 * DO binding and instance name, then delegates to routeDORequest for CORS
 * handling and DO dispatch. Route handlers live in the LumenizeAuth DO class.
 *
 * All auth configuration (redirect, issuer, audience, TTLs, prefix)
 * is read from environment variables — only Worker-level routing options
 * are passed here.
 *
 * Turnstile validation: POST requests to `email-magic-link` require a valid
 * `cf-turnstile-response` in the JSON body. Skipped in test mode or when
 * `TURNSTILE_SECRET_KEY` is not set (with a console warning).
 *
 * @see https://lumenize.com/docs/auth/getting-started#createauthroutes
 */
export function createAuthRoutes(
  env: Env,
  options: AuthRoutesOptions = {}
): (request: Request) => Promise<Response | undefined> {
  const { cors } = options;

  // Optional env vars not in wrangler.jsonc vars (secrets / test-only — cast required)
  const envRecord = env as unknown as Record<string, unknown>;
  const testMode = envRecord.LUMENIZE_AUTH_TEST_MODE === 'true';
  const turnstileSecretKey = envRecord.TURNSTILE_SECRET_KEY as string | undefined;

  // Warn when Turnstile secret key is missing in non-test mode
  if (!testMode && !turnstileSecretKey) {
    console.warn(
      '[lumenize/auth] TURNSTILE_SECRET_KEY is not set — Turnstile verification is disabled. ' +
      'This leaves your magic-link endpoint unprotected against automated abuse. ' +
      'See https://developers.cloudflare.com/turnstile/get-started/ to obtain a key.'
    );
  }

  // Warn when AUTH_EMAIL_SENDER is missing in non-test mode
  if (!testMode && !envRecord.AUTH_EMAIL_SENDER) {
    console.warn(
      '[lumenize/auth] AUTH_EMAIL_SENDER is not configured — magic links and invites will not be delivered. ' +
      'See https://lumenize.com/docs/auth/getting-started#email-provider'
    );
  }

  const prefix = (envRecord.LUMENIZE_AUTH_PREFIX as string) || '/auth';

  // Normalize prefix (ensure starts with /, no trailing /)
  const normalizedPrefix = prefix.startsWith('/') ? prefix : `/${prefix}`;
  const cleanPrefix = normalizedPrefix.endsWith('/')
    ? normalizedPrefix.slice(0, -1)
    : normalizedPrefix;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const path = url.pathname;

    // Check if this is an auth route
    if (!path.startsWith(cleanPrefix + '/') && path !== cleanPrefix) {
      return undefined;
    }

    // Extract the endpoint path after the prefix
    const endpointPath = path.slice(cleanPrefix.length + 1) || '';

    // Turnstile validation for POST email-magic-link (skipped in test mode or when no secret key)
    if (!testMode && turnstileSecretKey && request.method === 'POST' && endpointPath === 'email-magic-link') {
      // Clone before consuming body so the original streams through to the DO
      const clonedRequest = request.clone();

      let body: Record<string, unknown>;
      try {
        body = await clonedRequest.json() as Record<string, unknown>;
      } catch {
        return new Response(
          JSON.stringify({ error: 'invalid_request', error_description: 'Invalid JSON body' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const turnstileToken = body['cf-turnstile-response'];
      if (!turnstileToken || typeof turnstileToken !== 'string') {
        return new Response(
          JSON.stringify({
            error: 'turnstile_required',
            error_description: 'Missing cf-turnstile-response in request body'
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const result = await verifyTurnstileToken(turnstileSecretKey, turnstileToken);
      if (!result.success) {
        return new Response(
          JSON.stringify({
            error: 'turnstile_failed',
            error_description: 'Turnstile verification failed',
            error_codes: result.errorCodes,
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Fall through — original request body is unconsumed
    }

    // Rewrite URL to include binding and instance name
    const rewrittenPath = `${cleanPrefix}/LUMENIZE_AUTH/default/${endpointPath}`;
    const rewrittenUrl = new URL(request.url);
    rewrittenUrl.pathname = rewrittenPath;

    const rewrittenRequest = new Request(rewrittenUrl.toString(), request.clone() as RequestInit);

    const response = await routeDORequest(rewrittenRequest, env, {
      prefix: cleanPrefix,
      cors: cors as CorsOptions,
    });

    return response ?? undefined;
  };
}
