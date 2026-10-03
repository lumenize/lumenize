#!/usr/bin/env node
/**
 * The secrets a deployment of this Worker needs before it may deploy, by its origin — one list for
 * `deploy.sh` (production) and `deploy-test.sh` (the test target), so the two cannot drift.
 *
 * An `https` origin orders a certificate pack for every galaxy it creates (`src/certificate.ts`), so
 * it needs `CERTIFICATE_API_TOKEN`, a token scoped to its own zone's SSL and Certificates; one
 * without it fails here rather than deploying a Worker whose every create leaves Studio's host
 * without a certificate. The local stack's `http` origin orders nothing and deploys nowhere.
 *
 * CLI:    node scripts/required-secrets.mjs <origin> <the JSON `wrangler secret list` printed>
 *         exits 1 naming each missing secret, and prints nothing else; never echoes a value.
 * Import: requiredSecrets(origin) → string[], missingSecrets(origin, listJson) → string[]
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every deployment's own: the bootstrap address, the signing pair, and the mail provider's key. */
const BASE = ['NEBULA_AUTH_BOOTSTRAP_EMAIL', 'JWT_PRIVATE_KEY_BLUE', 'JWT_PUBLIC_KEY_BLUE', 'RESEND_API_KEY'];

/** @param {string} origin @returns {string[]} */
export function requiredSecrets(origin) {
  return new URL(origin).protocol === 'https:' ? [...BASE, 'CERTIFICATE_API_TOKEN'] : [...BASE];
}

/**
 * The required secrets `wrangler secret list`'s JSON does not name. Names only — the list carries no
 * values.
 * @param {string} origin @param {string} listJson @returns {string[]}
 */
export function missingSecrets(origin, listJson) {
  let names = [];
  try { names = JSON.parse(listJson).map((s) => s.name); } catch { names = []; }
  return requiredSecrets(origin).filter((s) => !names.includes(s));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin, listJson] = process.argv.slice(2);
  if (!origin) {
    console.error('usage: node scripts/required-secrets.mjs <origin> <secret-list-json>');
    process.exit(2);
  }
  const missing = missingSecrets(origin, listJson ?? '[]');
  if (missing.length > 0) {
    console.error(`❌ Missing secrets: ${missing.join(' ')}`);
    process.exit(1);
  }
}
