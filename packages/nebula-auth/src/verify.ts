/**
 * Nebula access-token verification — the shared JWT verify used by the Worker router, the Worker
 * token layer, and the app entrypoint. Extracted from `router.ts` so `router.ts` and `worker-token.ts`
 * can both import it without an import cycle.
 */
import {
  verifyJwt,
  verifyJwtWithRotation,
  importPublicKey,
} from '@lumenize/auth';
import { matchAccess } from './parse-id';
import { NEBULA_AUTH_ISSUER } from './types';
import type { NebulaJwtPayload } from './types';

async function getPublicKeys(env: object): Promise<CryptoKey[]> {
  const e = env as { JWT_PUBLIC_KEY_BLUE?: string; JWT_PUBLIC_KEY_GREEN?: string };
  const pems = [e.JWT_PUBLIC_KEY_BLUE, e.JWT_PUBLIC_KEY_GREEN].filter(Boolean) as string[];
  if (pems.length === 0) throw new Error('No JWT public keys found in env');
  return Promise.all(pems.map(pem => importPublicKey(pem)));
}

/**
 * Verify a Nebula access token: signature, standard claims, and the internal-consistency check that
 * `aud` (the active scope) is covered by `access.authScopePattern`. Returns the decoded payload if
 * valid, `null` if invalid/expired. `email` / `adminApproved` are no longer claims — a valid token
 * proves authorized membership by construction (enforced at mint), so there is no gate to feed here.
 */
export async function verifyNebulaAccessToken(
  token: string,
  env: object,
): Promise<NebulaJwtPayload | null> {
  const publicKeys = await getPublicKeys(env);

  const rawPayload = publicKeys.length === 1
    ? await verifyJwt(token, publicKeys[0]!)
    : await verifyJwtWithRotation(token, publicKeys);

  if (!rawPayload) return null;

  const payload = rawPayload as unknown as NebulaJwtPayload;

  if (!payload.aud || typeof payload.aud !== 'string') return null;
  if (payload.iss !== NEBULA_AUTH_ISSUER) return null;
  if (!payload.sub) return null;
  if (!payload.access?.authScopePattern) return null;

  // Internal consistency: the active scope (aud) must be covered by the auth scope pattern. The mint
  // paths already prevent minting a token that violates this; this catches tampered/stale tokens.
  if (!matchAccess(payload.access.authScopePattern, payload.aud)) return null;

  return payload;
}
