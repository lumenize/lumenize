# @lumenize/crypto

De✨light✨ful Ed25519 JWT signing, verification with key rotation, and hashing primitives.

📖 **[Full documentation](https://lumenize.com/docs/auth/)**

## Features

- **Ed25519 JWT sign / verify** — `signJwt`, `verifyJwt`, and `verifyJwtWithRotation` for
  BLUE/GREEN key rotation
- **PEM key import** — `importPrivateKey` / `importPublicKey`, tolerant of the escaped `\n`
  form environment variables produce
- **No auth policy** — `JwtPayload` is the registered claims (RFC 7519 §4.1) plus an optional
  `customClaims` bag that is spread **flat** at mint, so each layer declares its own claim
  shape instead of inheriting someone else's
- **Hashing and random values** — `hashString` (SHA-256) and `generateRandomString`
- **Runs everywhere** — thin wrappers over `crypto` globals, with no `cloudflare:workers`
  import anywhere in the graph, so it loads in Workers, Node, Bun, Deno, and browsers alike

## Install

```bash
npm install @lumenize/crypto
```
