/**
 * Spike C — egress choke point. NOT production code.
 *
 * Question: what network authority does a facet have by default, and can a bare
 * `fetch()` in (untrusted) facet code bypass a Nebula-controlled egress path?
 *
 * `EgressBroker` (a WorkerEntrypoint) is wired as the facet's `globalOutbound`,
 * so EVERY subrequest the facet makes — including a bare `fetch()` — is routed
 * through it. It enforces an allow-list and denies internal/metadata ranges
 * (the SSRF guard). Hermetic: the allowed path returns a synthetic marker (in
 * production it would do the real fetch + credential injection + metering), so
 * the spike needs no real external network.
 *
 * `EgressProbeDO` loads the probe facet with a chosen `globalOutbound` (the
 * broker, or `null` for "no ambient network") and reports what `fetch` did.
 *
 * Plain `DurableObject` / `WorkerEntrypoint`: test fixtures, not platform logic.
 * See tasks/spike-outside-world-outbound.md.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

/** Hosts the broker will proxy. Everything else is denied (default-deny). */
const ALLOWED_HOSTS = new Set(['example.com', 'api.resend.com']);

/** Loopback, cloud metadata, and RFC-1918 / link-local / ULA ranges — the SSRF deny set. */
function isInternal(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname === '169.254.169.254') return true; // cloud instance metadata
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^(fc|fd)/i.test(hostname)) return true; // IPv6 unique-local
  return false;
}

export class EgressBroker extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const { hostname } = new URL(request.url);
    if (isInternal(hostname)) return new Response('egress-denied:internal', { status: 403 });
    if (!ALLOWED_HOSTS.has(hostname)) return new Response('egress-denied:not-allowlisted', { status: 403 });
    // Reached the choke point and passed policy. Synthetic marker (hermetic).
    return new Response(`egress-allowed:${hostname}`, { status: 200 });
  }
}

/** A bare-`fetch()` probe, loaded as a facet. Reports the response or the error. */
const FACET_MODULE = `
import { DurableObject } from 'cloudflare:workers';
export class EgressProbe extends DurableObject {
  async probe(url) {
    try {
      const res = await fetch(url);
      return { status: res.status, body: await res.text() };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }
}
`;

type ProbeResult = { status: number; body: string } | { error: string };

interface EgressProbeFacet {
  probe(url: string): Promise<ProbeResult>;
}

export class EgressProbeDO extends DurableObject {
  /** Probe with the Nebula broker wired as `globalOutbound`. */
  async probeViaBroker(url: string): Promise<ProbeResult> {
    const egress = (this.env as unknown as Record<string, unknown>).EGRESS as Fetcher;
    return this.#facet(egress).probe(url);
  }

  /** Probe with `globalOutbound: null` — the "no ambient network" case. */
  async probeWithNoEgress(url: string): Promise<ProbeResult> {
    return this.#facet(null).probe(url);
  }

  #facet(globalOutbound: Fetcher | null): EgressProbeFacet {
    const bundleId = `egress-probe:${crypto.randomUUID()}`;
    const stub = this.ctx.facets.get(bundleId, () => {
      const worker = this.env.LOADER.get(bundleId, () => ({
        compatibilityDate: '2026-04-01',
        mainModule: 'probe.js',
        modules: { 'probe.js': FACET_MODULE },
        globalOutbound,
      }));
      return { class: worker.getDurableObjectClass('EgressProbe') };
    });
    return stub as unknown as EgressProbeFacet;
  }
}

export default {
  fetch(): Response {
    return new Response('egress-choke spike harness');
  },
};
