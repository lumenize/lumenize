/**
 * Actor claim for delegation per RFC 8693
 * Recursive: each layer records who delegated to whom
 */
export interface ActClaim {
  /** Actor ID (who is performing the action) */
  sub: string;
  /** Nested delegation chain */
  act?: ActClaim;
}

/**
 * JWT payload — the REGISTERED claims (RFC 7519 §4.1), plus an optional bag of first-party
 * custom claims. It carries **no auth policy**: a layer that mints its own claims declares
 * its own interface for them (`@lumenize/auth`'s is `AuthClaims`).
 *
 * ⚠️ **`customClaims` is an INPUT shape, never the wire shape.** `createJwtPayload` spreads
 * it FLAT into the token, so each key arrives at the payload's top level. `@lumenize/mesh`'s
 * Gateway copies the whole verified payload into `originAuth.claims`, so a nested bag would
 * silently become `originAuth.claims.customClaims.x` and break every consumer reading it.
 *
 * ⚠️ **Registered claims win.** `createJwtPayload` spreads the bag first — a *custom* claim
 * is by definition not a registered one (RFC 7519 §4.3), so it can never shadow `sub`/`exp`.
 *
 * Deliberately carries **no index signature**: registered claims stay statically checked, so
 * reading a custom claim is a deliberate narrowing through a declared interface rather than
 * an untyped property access.
 *
 * @see https://lumenize.com/docs/auth/#jwt-claims
 */
export interface JwtPayload {
  /** Issuer */
  iss: string;
  /** Audience */
  aud: string;
  /** Subject (UUID of the principal) */
  sub: string;
  /** Expiration time (Unix timestamp) */
  exp: number;
  /** Issued at (Unix timestamp) */
  iat: number;
  /** JWT ID (unique identifier) */
  jti: string;
  /** Delegation chain per RFC 8693 */
  act?: ActClaim;
  /** First-party custom claims (RFC 7519 §4.3), spread FLAT at mint — see above. */
  customClaims?: Record<string, unknown>;
}

/**
 * JWT header
 */
export interface JwtHeader {
  alg: 'EdDSA';
  typ: 'JWT';
  /** Key ID - identifies which key was used for signing */
  kid: string;
}
