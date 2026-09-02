#!/usr/bin/env node
/**
 * Derive the wrangler config a LOCAL `wrangler dev` boots from — `wrangler.jsonc` minus the parts
 * that are only true of a deployed Worker.
 *
 * Why `routes` must go (the reason this file exists, found by hand-driving on 2026-09-02):
 * `wrangler dev` infers the local upstream host from the FIRST `routes` entry, so with the branded
 * custom domain declared the Worker sees `Host: nebula.lumenize.com` no matter what the browser
 * addressed — and magic-link URLs follow the request origin (`worker-token.ts`), so every login link
 * a local stack emailed pointed at PRODUCTION. Clicking one hit a two-month-old deploy, and the
 * test lanes never noticed because a helper re-pointed the host before following it. Stripping
 * `routes` makes wrangler use the real inbound `Host`, which lands the link wherever the caller
 * actually is — `:8787` when driven directly, `:5174` through the Studio vite proxy (whose
 * `changeOrigin: false` forwards that Host untouched). `wrangler dev`'s own knobs cannot express
 * "use the inbound Host": `dev.host` / `--local-upstream` each pin ONE fixed value, and there are
 * two callers. `scripts/deploy-test.sh` strips `routes` for its own reason (custom domains are
 * exclusive to one Worker); this is the local twin.
 *
 * Why `containers` is optional: it is the ONLY thing in the stack that needs Docker. A scenario
 * that declares `needsContainer = false` boots without the image build (~13 s instead of ~110 s).
 *
 * ⚠️ Derived from the real config on every boot, never a second committed file — a parallel config
 * drifts silently the first time someone edits bindings in one and not the other. It is a
 * line-level comment-out rather than a JSONC re-serialisation because no JSONC parser is available
 * here and a regex comment-strip would corrupt any `//` inside a string (an https URL, say).
 *
 * ⚠️ The output MUST sit beside `wrangler.jsonc`: wrangler resolves `main`, `assets.directory` and
 * every other relative path against the CONFIG FILE's directory. Both outputs are gitignored.
 *
 * Throws loudly when the config's shape has changed, rather than emitting a config nobody reviewed.
 *
 * CLI:   node scripts/local-config.mjs [--no-containers]   → prints the derived filename
 * Import: deriveLocalConfig({ containers }) → the derived filename, relative to apps/nebula
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NEBULA_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula
const SOURCE = 'wrangler.jsonc';

/** Comment out one top-level `"key": [ … ]` array block, in place, tagged with `why`. */
function commentOutArray(lines, key, why) {
  const start = lines.findIndex((l) => new RegExp(`^\\s*"${key}"\\s*:\\s*\\[\\s*$`).test(l));
  if (start === -1) {
    throw new Error(
      `local-config: no \`"${key}": [\` line in apps/nebula/${SOURCE}. The config shape changed — `
      + 'update this derivation instead of letting it emit a config nobody reviewed.',
    );
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\],?\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) throw new Error(`local-config: unterminated \`${key}\` array in apps/nebula/${SOURCE}.`);
  for (let i = start; i <= end; i++) lines[i] = `// [local: ${why}] ${lines[i]}`;
}

/**
 * @param {{ containers?: boolean }} [opts] — `containers: false` also drops the image build.
 * @returns {string} the derived config's filename, relative to apps/nebula
 */
export function deriveLocalConfig({ containers = true } = {}) {
  const lines = readFileSync(resolve(NEBULA_DIR, SOURCE), 'utf8').split('\n');
  commentOutArray(lines, 'routes', 'routes stripped so the Worker sees the real inbound Host');
  if (!containers) commentOutArray(lines, 'containers', 'container build disabled');
  const out = containers ? 'wrangler.local.jsonc' : 'wrangler.local-no-container.jsonc';
  writeFileSync(resolve(NEBULA_DIR, out), lines.join('\n'));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const containers = !process.argv.includes('--no-containers');
  process.stdout.write(deriveLocalConfig({ containers }) + '\n');
}
