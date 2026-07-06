/**
 * @lumenize/auth/client — Node.js / browser-safe entry point
 *
 * This subpath export exposes only the parts of `@lumenize/auth` that don't
 * require the Cloudflare Workers runtime. Use this from Node.js test harnesses,
 * CLIs, and browser-bundled client code (e.g. `@lumenize/mesh/client`).
 *
 * The main `@lumenize/auth` barrel re-exports `LumenizeAuth` (DurableObject)
 * and `AuthEmailSenderBase` (WorkerEntrypoint) — both of which transitively
 * import `cloudflare:workers` and fail to resolve outside Workers. This file
 * intentionally leaves them out.
 *
 * The split is by intent, not by runtime: callers in browser/Node land know
 * they only need JWT-inspection utilities, and ask for them explicitly via
 * the `/client` subpath. The full barrel remains the server-side import.
 *
 * @example
 * ```typescript
 * import { parseJwtUnsafe, type JwtPayload } from '@lumenize/auth/client';
 * ```
 */

// JWT inspection + the pure signing/crypto primitives. All live in `./jwt`, whose
// only import is `./types` — no `cloudflare:workers` — so they are safe to pull from
// Node test harnesses and CLIs that mint/verify tokens with the `.dev.vars` key
// (e.g. `createNebulaTestToken`). Signing is Web Crypto (`crypto.subtle`), a global
// in Node 18+/Workers/browsers alike.
export {
  parseJwtUnsafe,
  signJwt,
  verifyJwt,
  verifyJwtWithRotation,
  importPrivateKey,
  importPublicKey,
  createJwtPayload,
  generateUuid,
  generateRandomString,
  hashString,
} from './jwt';
export type { JwtPayload, JwtHeader, ActClaim } from './types';
