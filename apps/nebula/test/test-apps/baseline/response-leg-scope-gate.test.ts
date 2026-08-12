/**
 * Response-leg scope gate matrix (B5 / D5, mesh-continuation-only-calls crit 4).
 *
 * The mandatory security carve-out: the fire-back RESPONSE leg lands on `__handleResponse`, which
 * runs the SAME shared `executeEnvelope` → `onBeforeCall` (= `requirePassage`) as the request
 * leg — only the per-method @mesh allowlist is toggled off (`requireMeshDecorator:false`). So the
 * response door is scope-gated BY CONSTRUCTION (D5): a legitimate response leg is admitted, and a
 * forged cross-scope response is rejected.
 *
 * The gate re-checks **origin→node containment** (the propagated origin's `aud` vs THIS node's own
 * `buildAuthScopePattern(instanceName)`), NOT responder identity (M1/N4) — so the admit and reject
 * cases use DIFFERENT origin scopes by construction. Each reject is capable-of-failing: with the
 * gate off (drop `requirePassage` in `NebulaDO.onBeforeCall`, or make `matchAccess` return true),
 * the forged envelope would admit ({$ack}) and every reject assertion flips RED.
 *
 * This is the RESPONSE-leg mirror of the request-leg `scope-isolation.test.ts` branch fan-out.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess, postprocess } from '@lumenize/structured-clone';
import { uniqueStar } from '../../test-helpers';

const PLATFORM = 'nebula-platform';

// Build a fire-back (response-leg) envelope for the STAR node's __handleResponse door. `aud` /
// `access` set the propagated ORIGIN's claims (never re-stamped by a responder — D14); the chain
// is a harmless method that only runs if admission passes (the door is @mesh-off).
function makeResponseEnvelope(opts: { instanceName?: string; aud?: string; access?: unknown }) {
  const callContext: any = { callChain: [], state: {} };
  if (opts.aud !== undefined || opts.access !== undefined) {
    const claims: any = {};
    if (opts.aud !== undefined) claims.aud = opts.aud;
    if (opts.access !== undefined) claims.access = opts.access;
    callContext.originAuth = { sub: 'sys', claims };
  }
  const metadata: any = {};
  if (opts.instanceName !== undefined) {
    metadata.callee = { type: 'LumenizeDO', bindingName: 'STAR', instanceName: opts.instanceName };
  }
  const chain = preprocess([{ type: 'get', key: 'whoAmI' }, { type: 'apply', args: [] }]);
  return { version: 1, chain, callContext, metadata };
}

describe('response-leg scope gate matrix (crit 4 / B5 / D5)', () => {
  type Case = {
    label: string;
    outcome: 'admit' | 'reject';
    match?: RegExp;
    opts: (star: string, foreign: string) => { instanceName?: string; aud?: string; access?: unknown };
  };

  const cases: Case[] = [
    // ── aud accept: the propagated origin is within THIS node's subtree → ADMIT (not false-negatived) ──
    { label: 'legit: origin aud within the node subtree → admitted', outcome: 'admit',
      opts: (star) => ({ instanceName: star, aud: star }) },

    // ── forged: origin aud OUTSIDE the node subtree → REJECT (the M1/N4 core) ──
    { label: 'forged: origin aud OUTSIDE the node subtree → rejected', outcome: 'reject', match: /Active-scope mismatch/,
      opts: (star, foreign) => ({ instanceName: star, aud: foreign }) },

    // ── branch c: no aud → fail-closed ──
    { label: 'no aud (branch c) → rejected fail-closed', outcome: 'reject', match: /Missing active scope/,
      opts: (star) => ({ instanceName: star }) },

    // ── branch a: missing callee instance name → fail-closed ──
    { label: 'missing callee name (branch a) → rejected fail-closed', outcome: 'reject', match: /missing callee instance name/,
      opts: (_star, foreign) => ({ aud: foreign }) },

    // ── branch b: platform-name callee → rejected ──
    { label: 'platform-name callee (branch b) → rejected', outcome: 'reject', match: /Active-scope mismatch/,
      opts: () => ({ instanceName: PLATFORM, aud: PLATFORM }) },

    // ── branch d: unparseable name (>3 segments) → rejected ──
    { label: 'unparseable callee name (branch d) → rejected', outcome: 'reject',
      opts: () => ({ instanceName: 'a.b.c.d.e', aud: 'a.b.c.d.e' }) },

    // ── admin dominion: a platform-admin origin reaches any node, even with a foreign aud → ADMIT ──
    { label: 'admin dominion: platform admin admitted despite a foreign aud', outcome: 'admit',
      opts: (star, foreign) => ({ instanceName: star, aud: foreign, access: { scopeAdmin: true, authScopePattern: '*' } }) },
  ];

  for (const c of cases) {
    it(`response leg — ${c.label}`, async () => {
      const star = uniqueStar();
      const foreign = uniqueStar();
      const opts = c.opts(star, foreign);
      // Address the DO by the name the envelope stamps (or a fresh, never-stamped one for the
      // missing-callee case), so name == routing key holds.
      const routingName = opts.instanceName ?? uniqueStar();
      const stub = (env as any).STAR.getByName(routingName);

      const r = await stub.__handleResponse(makeResponseEnvelope(opts));

      if (c.outcome === 'admit') {
        // Admission passed → early ack. (Gate off would ALSO admit — but the reject cases below
        // are what prove the gate is live; this proves it does not false-negative a legit leg.)
        expect(r).toEqual({ $ack: true });
      } else {
        // Rejected at admission by requirePassage on the RESPONSE door (returned wrapped).
        expect(r.$error, 'gate must reject on the response leg').toBeDefined();
        if (c.match) expect(postprocess(r.$error).message).toMatch(c.match);
      }
    });
  }
});
