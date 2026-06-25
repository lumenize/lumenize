#!/usr/bin/env node
// Reconstruct a CI `.dev.vars` from GitHub Actions secrets (read from env) plus
// generated ephemeral JWT test keys and non-secret test config. Run this BEFORE
// `npm ci` so the postinstall symlink step links it into every package/test dir
// that has a `wrangler.jsonc`, where pool-workers and spawned `wrangler dev`
// workers read it as worker bindings.
//
// Secret values arrive via env (RESEND_API_KEY / TEST_TOKEN), set from
// `${{ secrets.* }}` in the workflow — GitHub masks them in logs. This script
// never prints a value. The JWT keys are generated fresh each run (nothing
// stored): workers that read keys from vitest `miniflare.bindings` get their own
// ephemeral pair from the vitest config; workers that read keys from `.dev.vars`
// (e.g. mesh's spawned wrangler-dev browser-e2e worker) get these.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const need = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`ci-write-dev-vars: missing required env ${name}`);
    process.exit(1);
  }
  return v;
};

// Ed25519 keypair as `.dev.vars`-escaped PEM: quoted, single line, `\n` escapes
// — the exact shape `.dev.vars.example` documents and the auth importers accept.
const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const esc = (key, type) => key.export({ type, format: 'pem' }).replace(/\n/g, '\\n');
  return { pub: esc(publicKey, 'spki'), priv: esc(privateKey, 'pkcs8') };
};
const blue = keyPair();
const green = keyPair();

const lines = [
  `RESEND_API_KEY=${need('RESEND_API_KEY')}`,
  `TEST_TOKEN=${need('TEST_TOKEN')}`,
  // Non-secret public URL of the deployed test-endpoints worker (fetch suite).
  'TEST_ENDPOINTS_URL=https://test-endpoints.transformation.workers.dev',
  `JWT_PRIVATE_KEY_BLUE="${blue.priv}"`,
  `JWT_PUBLIC_KEY_BLUE="${blue.pub}"`,
  `JWT_PRIVATE_KEY_GREEN="${green.priv}"`,
  `JWT_PUBLIC_KEY_GREEN="${green.pub}"`,
];
writeFileSync('.dev.vars', lines.join('\n') + '\n');
console.log(`ci-write-dev-vars: wrote .dev.vars (${lines.length} entries; values not shown).`);
