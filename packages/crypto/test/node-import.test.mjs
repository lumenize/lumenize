/**
 * Node.js runtime smoke test for `@lumenize/crypto`.
 *
 * Runs under Node's built-in `node:test` runner and imports by PACKAGE NAME, so it exercises
 * the `exports` map a consumer actually resolves — not a relative path that would keep passing
 * if the map were wrong.
 *
 * Modelled on `packages/mesh/test/node-import.test.mjs`. This is the test that fails if anyone
 * introduces a `cloudflare:workers` import into this package's graph, which would silently
 * break `@lumenize/mesh/client` for browser bundlers: they statically resolve the literal even
 * inside `await import(...)`, so a runtime try/catch does not save you.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('@lumenize/crypto imports cleanly in Node and exports its full surface', async () => {
  const mod = await import('@lumenize/crypto');

  for (const name of [
    'signJwt',
    'verifyJwt',
    'verifyJwtWithRotation',
    'importPrivateKey',
    'importPublicKey',
    'generateRandomString',
    'hashString',
    'createJwtPayload',
    'parseJwtUnsafe',
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} exported as a function`);
  }
});

test('the primitives actually work under Node (not merely importable)', async () => {
  const { createJwtPayload, signJwt, verifyJwt, importPrivateKey, importPublicKey } =
    await import('@lumenize/crypto');

  const toPem = (der, label) => {
    const b64 = Buffer.from(der).toString('base64');
    return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----`;
  };

  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privPem = toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY');
  const pubPem = toPem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY');

  const payload = createJwtPayload({
    issuer: 'https://issuer.test',
    audience: 'https://audience.test',
    subject: 'node-smoke',
    expiresInSeconds: 60,
    customClaims: { isAdmin: true },
  });

  const token = await signJwt(payload, await importPrivateKey(privPem), 'BLUE');
  const verified = await verifyJwt(token, await importPublicKey(pubPem));

  assert.ok(verified, 'token verifies under Node');
  assert.equal(verified.sub, 'node-smoke');
  assert.equal(verified.isAdmin, true, 'custom claims arrive FLAT');
});
