/**
 * The scope GRAMMAR at the two token mints — `/refresh-token` and `/mint-narrower-token`.
 *
 * `isAtOrAbove` is deliberately grammar-free: two strings in, a boolean out, knowing nothing about
 * the 1–3-segment tier tree. That is the right shape for a security predicate — teaching it the
 * tiers is exactly the pattern language this model deleted — but it means **the grammar has to be
 * enforced somewhere else**, and the only correct place is the request boundary, where a malformed
 * value is a client error rather than a comparison.
 *
 * ⚠️ **The deleted `buildAuthScopePattern` was doing this job silently, and its shape is what
 * encoded the grammar.** It returned `{id}.*` for a universe/galaxy but the bare id for a **star**
 * — because a star is a LEAF — so `matchAccess('u.g.s', 'u.g.s.x')` fell to the exact-match arm and
 * answered `false`. Under the replacement, `isAtOrAbove('u.g.s', 'u.g.s.x')` is `true`. Nothing in
 * the diff says so: the function is deleted, and the widening arrives at every call site that used
 * to be bounded by its output. The parse below is what closes it.
 *
 * ⚠️ **This file asserts 400, never merely 4xx, and that distinction is the point.** A bare
 * `parseId` throw inside either handler answers `500 internal_error` through `router.ts`'s blanket
 * catch — a refusal, and one that would satisfy a 4xx-shaped criterion while proving the parse was
 * sited *wrong*. Status plus error code is what separates "refused at the boundary" from "threw
 * somewhere and got swallowed".
 *
 * 🚨 **`/refresh-token` answers 400 here where today's code answers 200, at EVERY tier.** That is
 * the one deliberate verdict change in this conversion: `u.g.s.x` is not a scope any grammar can
 * produce, nothing in the tree asks for one, and admitting it would put an unmintable scope into
 * the token, the logs and the `LIKE` queries. Restored grammar, not accepted widening.
 *
 * ADR-009 rung 2 — real server issuance through the real endpoints, no client mint.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { foundUniverse, inviteAndLogin, adminRequest, url } from './test-helpers';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

/** POST /refresh-token with an arbitrary body, so a test can send a malformed `activeScope`. */
async function refreshWith(scope: string, refreshToken: string, body: Record<string, unknown>) {
  return SELF.fetch(new Request(url(scope, 'refresh-token'), {
    method: 'POST',
    headers: { Cookie: `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/**
 * Both mints, each answering for one `activeScope`. Kept as a pair deliberately: an
 * endpoint-agnostic test is satisfiable on `/mint-narrower-token` alone, which would ship the
 * grammar untested on the path gated by the refresh cookie ALONE — no JWT, no scope check, and
 * therefore the reachable one.
 */
async function bothMints(activeScope: string) {
  const u = uni();
  const admin = await foundUniverse(SELF, u, 'admin@example.com');
  const member = await inviteAndLogin(SELF, u, admin.access_token, 'member@example.com');

  const refresh = await refreshWith(u, admin.refreshToken, { activeScope });
  const narrower = await adminRequest(SELF, u, 'mint-narrower-token', admin.access_token, {
    method: 'POST', body: { activeScope, subOfNarrowerToken: member.parsed.sub },
  });
  return { 'refresh-token': refresh, 'mint-narrower-token': narrower };
}

describe('activeScope must satisfy the id grammar, at BOTH mints', () => {
  // Each case is a value `parseId` refuses and `isAtOrAbove` would happily compare. The
  // four-segment ones are the load-bearing pair — they sit BENEATH a legitimate scope, so the
  // predicate answers `true` and the mint would succeed without this parse.
  it.each([
    ['a FOURTH segment beneath the caller (star tier)', 'FOUR'],
    ['a fourth segment two levels down', 'FOUR2'],
    ['an illegal slug (uppercase)', 'UPPER'],
    ['an illegal slug (underscore)', 'UNDERSCORE'],
    ['an empty segment', 'EMPTY'],
  ])('refuses %s with 400 invalid_request on BOTH mints, and mints nothing', async (_label, kind) => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    const member = await inviteAndLogin(SELF, u, admin.access_token, 'member@example.com');
    const activeScope = {
      FOUR: `${u}.app.tenant.extra`,
      FOUR2: `${u}.app.tenant.a.b`,
      UPPER: `${u}.App`,
      UNDERSCORE: `${u}.my_app`,
      EMPTY: `${u}..app`,
    }[kind]!;

    const resps = {
      'refresh-token': await refreshWith(u, admin.refreshToken, { activeScope }),
      'mint-narrower-token': await adminRequest(SELF, u, 'mint-narrower-token', admin.access_token, {
        method: 'POST', body: { activeScope, subOfNarrowerToken: member.parsed.sub },
      }),
    };

    for (const [endpoint, resp] of Object.entries(resps)) {
      // 400, not 4xx: a 500 would mean the parse throws inside the handler instead of gating at
      // the boundary, and a 403 would mean a containment check refused it for a different reason.
      expect(resp.status, `${endpoint} should refuse at the boundary`).toBe(400);
      const body = await resp.json() as { error?: string; access_token?: string };
      expect(body.error, `${endpoint} error code`).toBe('invalid_request');
      // Assert the ABSENCE of a token, not only the status — the criterion is about what was
      // issued, and a refusal for the wrong reason still issues nothing.
      expect(body.access_token, `${endpoint} must mint nothing`).toBeUndefined();
    }
  });

  // The positive control. Without it, every assertion above stays green against a mint that
  // refuses EVERY activeScope — which is a strictly worse bug than the widening being closed.
  it('still mints for a well-formed activeScope at every tier', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, 'admin@example.com');
    for (const activeScope of [u, `${u}.app`, `${u}.app.tenant`]) {
      const resp = await refreshWith(u, admin.refreshToken, { activeScope });
      expect(resp.status, `refresh at ${activeScope}`).toBe(200);
      const body = await resp.json() as { access_token: string };
      expect(body.access_token, `refresh at ${activeScope}`).toBeTruthy();
    }
  });

  // The grammar is enforced BEFORE the containment check, so a malformed scope the caller could
  // never reach anyway still reports the malformation rather than a scope refusal. Ordering is
  // what makes the 400 diagnostic instead of a misleading 403.
  it('reports the malformation, not a scope refusal, for a malformed scope in ANOTHER universe', async () => {
    const resps = await bothMints('OTHER-UNIVERSE.app.tenant.extra');
    for (const [endpoint, resp] of Object.entries(resps)) {
      expect(resp.status, endpoint).toBe(400);
      expect((await resp.json() as { error: string }).error, endpoint).toBe('invalid_request');
    }
  });
});
