/**
 * `*.lumenize.localhost` resolves to IPv4 loopback for Node, as it does in Chromium.
 *
 * The browser lane's Worker serves each scope's host under `lumenize.localhost`, and
 * `wrangler dev` listens on 127.0.0.1 alone. Node resolves a `*.localhost` name to `::1` on macOS
 * and to nothing on a Linux without systemd-resolved, so the global setup's login and the Vite
 * proxy dial these hosts through this lookup, which answers 127.0.0.1 for that one suffix and
 * passes every other name to the real resolver.
 *
 * A copy of `apps/nebula/harness/lib/localhost-lookup.ts`, whose header carries the measurements:
 * Mesh's tests may not import from `apps/` (`npm run audit:dep-direction`).
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
