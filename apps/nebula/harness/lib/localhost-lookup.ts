/**
 * `*.lumenize.localhost` resolves to loopback for Node, as it does on macOS and in Chromium.
 *
 * The local stack serves every scope's host under `lumenize.localhost` — `platform.lumenize.localhost`,
 * `crm.acme.lumenize.localhost` — the way production serves them under a wildcard DNS record. macOS
 * resolves any `*.localhost` name to loopback, and so does a Linux running systemd-resolved, such as
 * GitHub's `ubuntu-latest`. A Linux without such a resolver resolves none of them: in a
 * `node:24-slim` container on 2026-10-03, `fetch` and `WebSocket` to such a host both failed with
 * `ENOTFOUND`, and both connected once this was installed. So the local stack states its wildcard for Node the way
 * production's DNS states it: `dns.lookup`, which Node's `fetch` and `WebSocket` dial through,
 * answers loopback for that one suffix and passes every other name to the real resolver. It stands
 * in for a DNS record, not for any behaviour of ours. Chromium takes the same mapping as
 * `--host-resolver-rules`.
 *
 * Installed once per process, by the harness's entry, the vitest config, and the setup file of each
 * vitest project whose tests dial these hosts; a second install does nothing.
 */
import dns from 'node:dns';

const SUFFIX = 'lumenize.localhost';
const INSTALLED = Symbol.for('lumenize.localhostLookup');

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

export function installLocalhostLookup(): void {
  const state = globalThis as Record<symbol, unknown>;
  if (state[INSTALLED]) return;
  state[INSTALLED] = true;
  const real = dns.lookup;
  (dns as { lookup: unknown }).lookup = function lookup(hostname: string, options: unknown, callback?: LookupCallback) {
    if (typeof options === 'function') { callback = options as LookupCallback; options = {}; }
    if (hostname === SUFFIX || hostname.endsWith(`.${SUFFIX}`)) {
      const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
      process.nextTick(() => all ? callback!(null, [{ address: '127.0.0.1', family: 4 }]) : callback!(null, '127.0.0.1', 4));
      return;
    }
    return (real as (...args: unknown[]) => unknown).call(dns, hostname, options, callback);
  };
}
