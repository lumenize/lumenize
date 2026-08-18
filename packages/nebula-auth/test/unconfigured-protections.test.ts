/**
 * The boot-time signal for protections that silently no-op when unconfigured. ONE check, in the
 * Registry DO's constructor, derived from `UNCONFIGURED_PROTECTIONS` — so these tests iterate the
 * exported list rather than naming protections: a fourth entry inherits coverage instead of
 * falsifying a count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { UNCONFIGURED_PROTECTIONS, reportUnconfiguredProtections } from '../src/router';
import { registryUrl } from './test-helpers';

let sink: any[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => clearDebugSink());

function protectionEntries(from: any[]): any[] {
  return from.filter((e) => e.namespace === 'nebula-auth.Registry.protections');
}

// ⚠️ FIRST in the file, deliberately: the Registry constructs on this isolate's first touch, and
// the in-memory instance survives across `it` blocks — a later position would miss the
// construction. This is the WIRING half (the constructor actually runs the check); the doctored-env
// sweep below carries the per-protection coverage.
describe('the Registry constructor runs the check', () => {
  it('construction emits exactly the protections absent from THIS lane\'s env, at their declared levels', async () => {
    // Touch the singleton so it constructs with the sink installed (discover forwards to the DO;
    // test mode skips Turnstile).
    const resp = await SELF.fetch(new Request(registryUrl('discover'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'construct-probe@example.com' }),
    }));
    expect(resp.status).toBe(200);

    // Expectation COMPUTED from env, not hard-coded: both limiter bindings are declared in this
    // lane's wrangler.jsonc (so no error is expected for them), while TURNSTILE_SECRET_KEY is
    // machine-dependent (.dev.vars) — deriving keeps the assertion true on every checkout and in CI.
    const emitted = protectionEntries(sink);
    for (const { config, level } of UNCONFIGURED_PROTECTIONS) {
      const matching = emitted.filter((e) => e.data.protection === config);
      if ((env as Record<string, unknown>)[config]) {
        expect(matching).toHaveLength(0);
      } else {
        expect(matching).toHaveLength(1);
        expect(matching[0].level).toBe(level);
      }
    }
  });
});

describe('reportUnconfiguredProtections (the check itself, per protection)', () => {
  // Every protection present → silence. The base env sets each config to a truthy placeholder.
  const allConfigured: Record<string, unknown> = Object.fromEntries(
    UNCONFIGURED_PROTECTIONS.map(({ config }) => [config, 'configured-placeholder']));

  it('emits nothing when every protection is configured', () => {
    reportUnconfiguredProtections(allConfigured);
    expect(protectionEntries(sink)).toHaveLength(0);
  });

  it('names each absent protection, at its declared level — driven from the list', () => {
    for (const { config, level } of UNCONFIGURED_PROTECTIONS) {
      sink.length = 0;
      reportUnconfiguredProtections({ ...allConfigured, [config]: undefined });
      const emitted = protectionEntries(sink);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].data.protection).toBe(config);
      expect(emitted[0].level).toBe(level);
    }
  });
});
