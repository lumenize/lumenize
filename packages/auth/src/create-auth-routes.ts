import { routeDORequest, type CorsOptions } from '@lumenize/utils';
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
 * @see https://lumenize.com/docs/auth/api-reference#createauthroutes
 */
export function createAuthRoutes(
  env: Env,
  options: AuthRoutesOptions = {}
): (request: Request) => Promise<Response | undefined> {
  const {
    authBindingName = 'LUMENIZE_AUTH',
    authInstanceName = 'default',
    cors,
  } = options;

  const prefix = (env as any).LUMENIZE_AUTH_PREFIX || '/auth';

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

    // Rewrite URL to include binding and instance name
    const rewrittenPath = `${cleanPrefix}/${authBindingName}/${authInstanceName}/${endpointPath}`;
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
