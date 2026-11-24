/**
 * Baseline for the spike: how long does TODAY's path — `spawnWranglerDev` (subprocess +
 * stdout "Ready on" scrape) — take to boot the same apps/nebula config? Run this back-to-back
 * with `spike.ts --nebula` so the Docker image cache state matches.
 *
 *   npx tsx baseline.ts
 */
import { spawnWranglerDev } from '@lumenize/testing/wrangler';
import { resolve } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';

const nebulaDir = resolve(import.meta.dirname, '../../apps/nebula');
rmSync(resolve(nebulaDir, '.wrangler/state'), { recursive: true, force: true });
mkdirSync(resolve(nebulaDir, '../nebula-studio-ui/dist'), { recursive: true });

const t0 = performance.now();
const { baseUrl, cleanup } = await spawnWranglerDev({
  configPath: './wrangler.jsonc',
  cwd: nebulaDir,
  readyTimeoutMs: 300_000,
  extraArgs: ['--var', 'PRIMARY_JWT_KEY:BLUE', '--log-level', 'info'],
});
const bootMs = Math.round(performance.now() - t0);

const res = await fetch(`${baseUrl}/_version`);
console.log(JSON.stringify({
  path: 'spawnWranglerDev (subprocess + stdout scrape)',
  bootMs,
  versionStatus: res.status,
  version: (await res.text()).slice(0, 120),
}, null, 2));

await cleanup();
