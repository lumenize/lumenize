#!/usr/bin/env node
/**
 * The deployed test target never reaches production: every swap `test-deploy-config.mjs` makes is
 * checked against the real `wrangler.jsonc`. Run by the package `test` script.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveTestDeployConfig, parseJsonc, TEST_ORIGIN } from './test-deploy-config.mjs';

const NEBULA_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const prod = parseJsonc(readFileSync(resolve(NEBULA_DIR, 'wrangler.jsonc'), 'utf8'));
const KV_ID = 'test-kv-namespace-id';
const ZONE_ID = 'test-zone-id';
const cfg = deriveTestDeployConfig({ workerName: 'test-nebula', kvNamespaceId: KV_ID, zoneId: ZONE_ID });

// The refresh records: the test target's own namespace, by an explicit id, never production's.
const prodKv = prod.kv_namespaces.find((b) => b.binding === 'REFRESH_TOKEN_KV');
const kv = cfg.kv_namespaces.find((b) => b.binding === 'REFRESH_TOKEN_KV');
assert.ok(typeof kv?.id === 'string' && kv.id.length > 0, 'REFRESH_TOKEN_KV must name an explicit id');
assert.equal(kv.id, KV_ID, "REFRESH_TOKEN_KV must be the test target's namespace");
assert.notEqual(kv.id, prodKv.id, "REFRESH_TOKEN_KV must never be production's namespace");

// Every self-referencing service binding names the worker deployed, never production's `nebula`.
assert.ok(cfg.services.length > 0, 'the instrument needs a service binding to check');
for (const s of cfg.services) assert.equal(s.service, 'test-nebula', `service binding ${s.binding} must name the test worker`);
assert.ok(!JSON.stringify(cfg.services).includes('"nebula"'), 'no service may name "nebula"');

// Its own hosts and origin.
const testHost = new URL(TEST_ORIGIN).hostname;
assert.ok(cfg.routes.length > 0 && cfg.routes.every((r) => r.pattern === testHost || r.pattern.endsWith(`.${testHost}/*`)),
  `every route must sit under ${testHost}`);
assert.equal(cfg.vars.LUMENIZE_ORIGIN, TEST_ORIGIN);

// Its own blob bucket.
assert.ok(!cfg.r2_buckets.some((b) => b.bucket_name === 'nebula-blobs'), "the blob bucket must not be production's");

// Its own certificate zone, never production's.
assert.equal(cfg.vars.CERTIFICATE_ZONE_ID, ZONE_ID, "CERTIFICATE_ZONE_ID must be the test zone's");
assert.notEqual(cfg.vars.CERTIFICATE_ZONE_ID, prod.vars.CERTIFICATE_ZONE_ID, "CERTIFICATE_ZONE_ID must never be production's");
assert.equal(cfg.vars.NEBULA_AUTH_ACCESS_TOKEN_TTL, '120', 'the test target mints two-minute tokens, so a deployed lapse waits two minutes');
assert.ok(!('NEBULA_AUTH_ACCESS_TOKEN_TTL' in prod.vars), "production's config must not shorten its tokens");

// Refuses without a namespace id or a zone id.
assert.throws(() => deriveTestDeployConfig({ workerName: 'test-nebula', kvNamespaceId: '', zoneId: ZONE_ID }), /namespace id/);
assert.throws(() => deriveTestDeployConfig({ workerName: 'test-nebula', kvNamespaceId: KV_ID, zoneId: '' }), /zone id/);

console.log('test-deploy-config selftest: every swap holds');
