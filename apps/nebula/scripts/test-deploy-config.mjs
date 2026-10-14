#!/usr/bin/env node
/**
 * Derive the wrangler config the deployed TEST target boots from — `wrangler.jsonc` with every
 * value that would otherwise reach production swapped for the test target's own.
 *
 * `scripts/deploy-test.sh` writes it beside `wrangler.jsonc` and deploys from it; `local-config.mjs`
 * is the local twin. Derived from the real config on every run, never a second committed file, so
 * nothing else can drift. Seven swaps, each one a way the test target used to reach production:
 *
 * 1. **`routes`** — production's hosts under `lumenize.dev` become the test target's under
 *    {@link TEST_ORIGIN}. A deploy under any name claims every route in its config, and custom
 *    domains are exclusive, so a test deploy carrying production's routes takes them over.
 * 2. **`LUMENIZE_ORIGIN`** — the test target names its own origin, so it parses its own hosts and
 *    issues and accepts only its own tokens.
 * 3. **`REFRESH_TOKEN_KV`** — the test target's own namespace, by an explicit id. An id-less binding
 *    would be filled with the deployed worker's, and `wrangler.jsonc`'s id is production's.
 * 4. **`services[].service`** — every self-referencing service binding names the worker deployed,
 *    or the test target would send mail and invites through production's Worker.
 * 5. **`r2_buckets`** — the blob bucket `nebula-blobs` becomes `nebula-blobs-test`.
 * 6. **`CERTIFICATE_ZONE_ID`** — the test zone's, so a test galaxy orders and deletes its certificate
 *    pack on `lumenize-test.dev` and never touches a production pack.
 * 7. **`containers[].name`** — `test-nebula-galaxy`, not `nebula-galaxy`. A container application's
 *    name defaults to the config's top-level `name` plus its class, and `--name` does not reach it,
 *    so both targets would claim production's name. Under the `durable_object` scheduling policy an
 *    application is keyed by its Durable Object namespace and must keep its name, so production's
 *    first deploy would collide with the test target's.
 *
 * Two additions are not swaps. **`DEBUG`** gains {@link TEST_DEBUG_ADDED}: a deployed run cannot
 * set a scenario's `bootVars`, and its harness reads the Worker's lines through `wrangler tail` and
 * Workers Logs, so the test target logs every namespace a scenario turns on locally. Production's
 * value is kept and extended, so the two cannot drift. And **`observability`** keeps production's
 * Issues setting and adds Workers Logs, which the harness reads, and traces.
 *
 * Throws when an input is missing or the config's shape has changed, rather than emitting a
 * config nobody reviewed. `scripts/test-deploy-config.selftest.mjs` checks every swap.
 *
 * CLI:    node scripts/test-deploy-config.mjs <workerName> <kvNamespaceId> <outFile> <zoneId>
 * Import: deriveTestDeployConfig({ workerName, kvNamespaceId, zoneId }) → the config object
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NEBULA_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula

/** The `DEBUG` namespaces the test target logs beyond production's: the ones scenarios' `bootVars`
 *  turn on that production's patterns do not match. */
export const TEST_DEBUG_ADDED = 'lmz.mesh';

/** The deployed test target's origin, which the harness also reads for a deployed run. */
export const TEST_ORIGIN = 'https://lumenize-test.dev';

/**
 * JSONC → JSON by a string-aware state machine, not a regex: the config's strings contain `//`
 * (URLs), which a naive comment strip would truncate.
 */
export function parseJsonc(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '"') { // string — copy verbatim through the closing quote
      out += c; i++;
      while (i < src.length && src[i] !== '"') { out += src[i]; if (src[i] === '\\') { out += src[i + 1]; i++; } i++; }
      out += src[i]; i++;
    } else if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

/**
 * @param {{ workerName: string, kvNamespaceId: string, zoneId: string, source?: string }} opts —
 *   `source` is the JSONC text, `wrangler.jsonc` when omitted.
 * @returns {object} the test target's wrangler config
 */
export function deriveTestDeployConfig({ workerName, kvNamespaceId, zoneId, source }) {
  if (!workerName) throw new Error('test-deploy-config: no worker name');
  if (!kvNamespaceId) {
    throw new Error('test-deploy-config: no REFRESH_TOKEN_KV namespace id for the test target. '
      + 'Without one the binding would fall back to production\'s.');
  }
  if (!zoneId) {
    throw new Error('test-deploy-config: no certificate zone id for the test target. '
      + 'Without one its galaxies would order and delete packs on production\'s zone.');
  }
  const cfg = parseJsonc(source ?? readFileSync(resolve(NEBULA_DIR, 'wrangler.jsonc'), 'utf8'));
  const testHost = new URL(TEST_ORIGIN).hostname;

  cfg.routes = [
    { pattern: testHost, custom_domain: true },
    { pattern: `*.${testHost}/*`, zone_name: testHost },
  ];

  if (!cfg.vars || !('LUMENIZE_ORIGIN' in cfg.vars)) {
    throw new Error('test-deploy-config: wrangler.jsonc has no vars.LUMENIZE_ORIGIN to swap');
  }
  cfg.vars.LUMENIZE_ORIGIN = TEST_ORIGIN;
  if (!('CERTIFICATE_ZONE_ID' in cfg.vars)) {
    throw new Error('test-deploy-config: wrangler.jsonc has no vars.CERTIFICATE_ZONE_ID to swap');
  }
  cfg.vars.CERTIFICATE_ZONE_ID = zoneId;
  if (typeof cfg.vars.DEBUG !== 'string') {
    throw new Error('test-deploy-config: wrangler.jsonc has no vars.DEBUG to extend');
  }
  cfg.vars.DEBUG = `${cfg.vars.DEBUG},${TEST_DEBUG_ADDED}`;
  // Workers Logs, on the test target alone: it keeps lines `wrangler tail` drops, and the tail keeps
  // lines it drops (`experiments/tail-abort/RESULTS.md`), so a deployed run can read both. Traces
  // record each RPC hop of a mesh flow, the nesting a subrequest depth error is about.
  cfg.observability = {
    ...cfg.observability,
    logs: { enabled: true, invocation_logs: false },
    traces: { enabled: true },
  };

  const kv = (cfg.kv_namespaces ?? []).find((b) => b.binding === 'REFRESH_TOKEN_KV');
  if (!kv) throw new Error('test-deploy-config: wrangler.jsonc has no REFRESH_TOKEN_KV binding to swap');
  kv.id = kvNamespaceId;

  for (const s of cfg.services ?? []) s.service = workerName;

  for (const b of cfg.r2_buckets ?? []) if (b.bucket_name === 'nebula-blobs') b.bucket_name = 'nebula-blobs-test';

  for (const c of cfg.containers ?? []) c.name = `${workerName}-${String(c.class_name).toLowerCase()}`;

  return cfg;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workerName, kvNamespaceId, outFile, zoneId] = process.argv.slice(2);
  if (!outFile) {
    console.error('usage: node scripts/test-deploy-config.mjs <workerName> <kvNamespaceId> <outFile> <zoneId>');
    process.exit(2);
  }
  writeFileSync(outFile, JSON.stringify(deriveTestDeployConfig({ workerName, kvNamespaceId, zoneId }), null, 2) + '\n');
}
