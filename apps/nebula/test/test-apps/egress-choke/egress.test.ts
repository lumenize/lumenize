/**
 * Spike C — egress choke point.
 * Proves the facet's bare `fetch()` is routed through the Nebula `EgressBroker`
 * (no bypass), the broker enforces allow-list + SSRF deny, and `globalOutbound:
 * null` leaves the facet with no network at all. See tasks/spike-outside-world-outbound.md.
 */
import { env } from 'cloudflare:test';

const NS = (env as unknown as { EGRESS_PROBE: DurableObjectNamespace }).EGRESS_PROBE;
const probe = () => NS.get(NS.idFromName(crypto.randomUUID())) as unknown as {
  probeViaBroker(url: string): Promise<{ status: number; body: string } | { error: string }>;
  probeWithNoEgress(url: string): Promise<{ status: number; body: string } | { error: string }>;
};

describe('Spike C — egress choke point', () => {
  it("routes a bare fetch() through the broker for an allow-listed host", async () => {
    const r = await probe().probeViaBroker('https://example.com/anything');
    // The marker can ONLY have come from EgressBroker — real example.com returns
    // HTML — so this proves globalOutbound interception of a bare fetch().
    expect(r).toEqual({ status: 200, body: 'egress-allowed:example.com' });
  });

  it("denies an internal / metadata address (SSRF guard)", async () => {
    const r = await probe().probeViaBroker('http://169.254.169.254/latest/meta-data/');
    // Specifically the isInternal branch (not the allow-list) — proves the
    // request reached the broker AND was caught by the SSRF guard first.
    expect(r).toEqual({ status: 403, body: 'egress-denied:internal' });
  });

  it("denies a non-allow-listed public host (default-deny)", async () => {
    const r = await probe().probeViaBroker('https://evil.example.net/exfil');
    expect(r).toEqual({ status: 403, body: 'egress-denied:not-allowlisted' });
  });

  it("globalOutbound: null leaves the facet with no network", async () => {
    const r = await probe().probeWithNoEgress('https://example.com/anything');
    expect('error' in r).toBe(true);
  });
});
