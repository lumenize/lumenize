#!/usr/bin/env node
/**
 * The deploy preflight refuses an `https` deployment without `CERTIFICATE_API_TOKEN`, naming it, and
 * an `http` origin needs none. A secret set under its pre-rename name does not count. Run by the
 * package `test` script; the CLI is what both deploy scripts call, so it is driven as they drive it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredSecrets } from './required-secrets.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'required-secrets.mjs');
const list = (names) => JSON.stringify(names.map((name) => ({ name, type: 'secret_text' })));
const run = (origin, names) => spawnSync(process.execPath, [CLI, origin, list(names)], { encoding: 'utf8' });

const base = requiredSecrets('http://lumenize.localhost');
assert.ok(!base.includes('CERTIFICATE_API_TOKEN'), 'an http origin orders nothing, so needs no certificate token');

const without = run('https://lumenize-test.dev', base);
assert.equal(without.status, 1, 'an https deploy without the certificate token must exit non-zero');
assert.match(without.stderr, /CERTIFICATE_API_TOKEN/, 'the refusal must name the missing token');

// The positive control: with it, the preflight passes.
assert.equal(run('https://lumenize-test.dev', [...base, 'CERTIFICATE_API_TOKEN']).status, 0);

// A secret set under its pre-rename name is not the secret the Worker reads: the refusal names the
// new one, so a deploy cannot pass on `NEBULA_AUTH_BOOTSTRAP_EMAIL` alone.
const stale = run('http://lumenize.localhost',
  [...base.filter((name) => name !== 'AUTH_BOOTSTRAP_EMAIL'), 'NEBULA_AUTH_BOOTSTRAP_EMAIL']);
assert.equal(stale.status, 1, 'a list with only the pre-rename bootstrap name must exit non-zero');
assert.match(stale.stderr, /(^|[^_A-Z])AUTH_BOOTSTRAP_EMAIL/, 'the refusal must name the secret under its new name');
console.log('required-secrets selftest passed');
