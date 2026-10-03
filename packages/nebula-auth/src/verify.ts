/**
 * Nebula access-token verification — the shared JWT verify used by the Worker router, the Worker
 * token layer, and the app entrypoint. Extracted from `router.ts` so `router.ts` and `worker-token.ts`
 * can both import it without an import cycle.
 */
import { verifyJwt, verifyJwtWithRotation, importPublicKey } from '@lumenize/crypto';
import { isAtOrAbove } from './parse-id';
import { deploymentOrigin, platformOrigin } from './hosts';
import type { NebulaJwtPayload } from './types';

async function getPublicKeys(env: object): Promise<CryptoKey[]> {
  const e = env as { JWT_PUBLIC_KEY_BLUE?: string; JWT_PUBLIC_KEY_GREEN?: string };
  const pems = [e.JWT_PUBLIC_KEY_BLUE, e.JWT_PUBLIC_KEY_GREEN].filter(Boolean) as string[];
  if (pems.length === 0) throw new Error('No JWT public keys found in env');
  return Promise.all(pems.map(pem => importPublicKey(pem)));
}

/**
 * Verify a Nebula access token: signature, standard claims, and the internal-consistency check that
 * `aud` (the active scope) sits at or below `access.authScope`. Returns the decoded payload if
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

  // A single legal downcast: `NebulaJwtPayload` is structurally a `JwtPayload` (registered
  // claims) plus Nebula's own `access`/`profileId` custom claims, so the two types are
  // comparable and the `as unknown as` double cast this replaced is no longer needed.
  const payload = rawPayload as NebulaJwtPayload;

  if (!payload.aud || typeof payload.aud !== 'string') return null;
  // Each deployment accepts only its own tokens: the issuer derives from the deployment's origin.
  if (payload.iss !== platformOrigin(deploymentOrigin(env))) return null;
  if (!payload.sub) return null;
  if (!payload.access?.authScope) return null;

  // Internal consistency: the active scope (aud) must sit at or below the token's own `authScope`.
  // The mint paths already prevent minting a token that violates this; this catches tampered/stale
  // tokens. Structural — a fact about two strings, with no `scopeAdmin` operand: it says nothing
  // about dominion.
  if (!isAtOrAbove(payload.access.authScope, payload.aud)) return null;
  // A plain membership's token is for its own scope's host alone: passage reads `aud`, so a plain
  // member of `acme.crm` holding a token for `acme.crm.tenant1` would otherwise reach the tenant.
  if (!payload.access.scopeAdmin && payload.aud !== payload.access.authScope) return null;

  return payload;
}
