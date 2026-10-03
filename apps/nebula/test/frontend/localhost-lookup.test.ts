/**
 * The local stack's wildcard for Node (`harness/lib/localhost-lookup.ts`): `*.lumenize.localhost`
 * answers loopback without asking the real resolver, and every other name goes to it.
 *
 * In the Node lane, against a stub resolver, since macOS's real one already answers loopback for any
 * `*.localhost` name and so could not tell the hook from its absence. That Linux needs it was
 * measured in a `node:24-slim` container; the CI run on `ubuntu-latest` is its standing witness.
 */
import { describe, it, expect, afterEach } from 'vitest';
import dns from 'node:dns';
import { installLocalhostLookup } from '../../harness/lib/localhost-lookup';

const lookup = (host: string) => new Promise<string>((resolve, reject) =>
  dns.lookup(host, (err, address) => (err ? reject(err) : resolve(address as string))));

describe('installLocalhostLookup', () => {
  const real = dns.lookup;
  afterEach(() => { (dns as { lookup: unknown }).lookup = real; });

  it('answers the suffix itself and passes every other name to the real resolver', async () => {
    const asked: string[] = [];
    (dns as { lookup: unknown }).lookup = (host: string, _o: unknown, cb?: (e: Error) => void) => {
      asked.push(host);
      (cb ?? (_o as (e: Error) => void))(new Error('the real resolver'));
    };
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('lumenize.localhostLookup')];
    installLocalhostLookup();
    expect(await lookup('crm.acme.lumenize.localhost')).toBe('127.0.0.1');
    expect(await lookup('lumenize.localhost')).toBe('127.0.0.1');
    await expect(lookup('notlumenize.localhost')).rejects.toThrow('the real resolver');
    expect(asked).toEqual(['notlumenize.localhost']);
  });
});
