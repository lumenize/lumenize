/**
 * @lumenize/crypto — Ed25519 JWT signing/verification and hashing primitives
 *
 * A generic primitive package carrying **no auth policy**. Every symbol here is a thin
 * wrapper over a `crypto` global — `crypto.subtle` Ed25519, `getRandomValues`,
 * `subtle.digest` — which is why the package is named for the global rather than for JWTs.
 *
 * ⚠️ **Node-safe by construction.** Nothing here imports `cloudflare:workers`, so this loads
 * cleanly in Node, Bun, Deno, browsers, and Workers alike. That property used to be carried by a
 * dedicated Node-safe subpath of `@lumenize/auth`; here it is structural rather than a subpath
 * convention — keep it that way: a `cloudflare:workers` import anywhere in this package's
 * graph breaks `@lumenize/mesh/client` for browser bundlers, which statically resolve the
 * literal even inside `await import(...)`.
 *
 * @see https://lumenize.com/docs/auth/
 */

export {
  signJwt,
  verifyJwt,
  verifyJwtWithRotation,
  importPrivateKey,
  importPublicKey,
  generateRandomString,
  hashString,
  createJwtPayload,
  parseJwtUnsafe,
} from './jwt';

export type { JwtPayload, JwtHeader, ActClaim } from './types';
