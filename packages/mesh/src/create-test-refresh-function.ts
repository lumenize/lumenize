import { signJwt, importPrivateKey, createJwtPayload } from '@lumenize/auth';

/**
 * Options for {@link createTestRefreshFunction}.
 * @see https://lumenize.com/docs/mesh/testing
 */
export interface CreateTestRefreshFunctionOptions {
  /**
   * Private key PEM string.
   * Default: reads `env.JWT_PRIVATE_KEY_BLUE` via `import('cloudflare:test').env` at call time.
   */
  privateKey?: string;

  /** Subject ID for the JWT. Default: `crypto.randomUUID()` */
  sub?: string;

  /** Grant admin approval in the JWT claims. Default: `true` */
  adminApproved?: boolean;

  /** Email verified flag. Default: `true` */
  emailVerified?: boolean;

  /** Grant admin role in the JWT claims. Default: `false` */
  isAdmin?: boolean;

  /** JWT issuer. Should match `LUMENIZE_AUTH_ISSUER` env var. Default: `'https://lumenize.local'` */
  iss?: string;

  /** JWT audience. Should match `LUMENIZE_AUTH_AUDIENCE` env var. Default: `'https://lumenize.local'` */
  aud?: string;

  /** Token TTL in seconds. Default: `3600` */
  ttl?: number;

  /**
   * If `true`, the returned function throws to simulate an expired refresh token.
   * LumenizeClient catches this and fires `onLoginRequired`.
   * Default: `false`
   */
  expired?: boolean;
}

/**
 * Creates a `refresh` callback for LumenizeClient that mints JWTs locally.
 *
 * The returned function signs a JWT using the provided (or default) private key.
 * Auth hooks verify it normally against the corresponding public key —
 * no test mode, no bypass, all production code paths exercised.
 *
 * @see https://lumenize.com/docs/mesh/testing
 */
export function createTestRefreshFunction(
  options: CreateTestRefreshFunctionOptions = {},
): () => Promise<{ access_token: string; sub: string }> {
  const {
    sub = crypto.randomUUID(),
    adminApproved = true,
    emailVerified = true,
    isAdmin = false,
    iss = 'https://lumenize.local',
    aud = 'https://lumenize.local',
    ttl = 3600,
    expired = false,
  } = options;

  return async () => {
    if (expired) {
      throw new Error('Refresh token expired');
    }

    // Resolve the private key: explicit option or from cloudflare:test env
    let privateKeyPem = options.privateKey;
    if (!privateKeyPem) {
      const mod = await import('cloudflare:test');
      const env = (mod as { env?: { JWT_PRIVATE_KEY_BLUE?: string } }).env;
      privateKeyPem = env?.JWT_PRIVATE_KEY_BLUE;
      if (!privateKeyPem) {
        throw new Error(
          'createTestRefreshFunction: no privateKey provided and JWT_PRIVATE_KEY_BLUE not found in cloudflare:test env',
        );
      }
    }

    const privateKey = await importPrivateKey(privateKeyPem);

    const payload = createJwtPayload({
      issuer: iss,
      audience: aud,
      subject: sub,
      expiresInSeconds: ttl,
      emailVerified,
      adminApproved,
      isAdmin: isAdmin || undefined,
    });

    const accessToken = await signJwt(payload, privateKey, 'BLUE');

    return { access_token: accessToken, sub };
  };
}
