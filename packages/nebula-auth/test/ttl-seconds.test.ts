/**
 * `ttlSeconds` on the two token mints — `/refresh-token` and `/mint-narrower-token`.
 *
 * The parameter can only ever SHORTEN a token: the ceiling is clamped (not rejected), the lower
 * bound and the type are an accept-list (rejected), and an implausibly short value is warned about
 * but honoured.
 *
 * ⚠️ **Why the type check is the security-relevant one, and a `<= 0` guard is not enough.**
 * `buildNebulaJwtPayload` computes `exp: now + (ttlSeconds ?? ACCESS_TOKEN_TTL)`, so a non-numeric
 * value yields `exp: NaN` — and it slips past BOTH naive guards, since `NaN <= 0` is `false` and
 * `Math.min(NaN, 900)` is `NaN`. `signJwt` serializes with `JSON.stringify` (writing `NaN` as
 * `null`), and `verifyJwt`'s check is `if (payload.exp && payload.exp < now)` — a null `exp` is
 * FALSY, so expiry is skipped and the token verifies forever. `security.md` names the short
 * access-TTL as THE mitigation while a revocation propagates through KV, so an `exp`-less token
 * deletes that bound. Hence the finite-`exp` assertion below, which is the property that matters
 * rather than a proxy for it.
 *
 * ADR-009 rung 2 — real server issuance through the real endpoints, no email hop, no client mint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { foundUniverse, inviteAndLogin, adminRequest, url } from './test-helpers';
import { ACCESS_TOKEN_TTL, RECOMMENDED_MIN_TTL_SECONDS } from '../src/types';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

/** POST /refresh-token with an arbitrary body, so a test can send a malformed `ttlSeconds`. */
async function refreshWith(scope: string, refreshToken: string, body: Record<string, unknown>) {
  return SELF.fetch(new Request(url(scope, 'refresh-token'), {
    method: 'POST',
    headers: { Cookie: `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/** `exp - iat` off a minted token — the actual lifetime, independent of what `expires_in` claims. */
function lifetimeOf(accessToken: string): number {
  const p = parseJwtUnsafe(accessToken)!.payload as { exp: number; iat: number };
  return p.exp - p.iat;
}

/**
 * Both endpoints, each returning a mint response for a given `ttlSeconds`. Kept as a pair so every
 * criterion below is asserted on BOTH — an endpoint-agnostic test is satisfiable on
 * `/mint-narrower-token` alone, shipping the parameter untested on the cookie-authenticated path,
 * which is the one gated by the refresh cookie ALONE (no JWT, no scope check).
 */
async function bothEndpoints(ttlSeconds?: unknown) {
  const u = uni();
  const admin = await foundUniverse(SELF, u, 'admin@example.com');
  const member = await inviteAndLogin(SELF, u, admin.access_token, 'member@example.com');

  const body: Record<string, unknown> = { activeScope: u };
  if (ttlSeconds !== undefined) body.ttlSeconds = ttlSeconds;

  const refresh = await refreshWith(u, admin.refreshToken, body);
  const narrower = await adminRequest(SELF, u, 'mint-narrower-token', admin.access_token, {
    method: 'POST', body: { ...body, subOfNarrowerToken: member.parsed.sub },
  });
  return { 'refresh-token': refresh, 'mint-narrower-token': narrower };
}

describe('ttlSeconds — the accept-list (type + lower bound)', () => {
  // Mutation: validate with `ttlSeconds <= 0` only → 'abc' passes the guard, `exp` decodes as
  // `null`, and the finite-exp test below reds. Each operand is probed independently
  // (testing.md § capable of failing) rather than toggling the branch as a whole.
  it.each([
    ['a string', 'abc'],
    ['null', null],
    ['an object', {}],
    ['a float', 1.5],
    ['zero', 0],
    ['a negative', -1],
  ])('refuses %s with 400 invalid_request on BOTH endpoints', async (_label, value) => {
    const resps = await bothEndpoints(value);
    for (const [endpoint, resp] of Object.entries(resps)) {
      expect(resp.status, `${endpoint} should refuse`).toBe(400);
      const body = await resp.json() as { error: string; error_description: string };
      expect(body.error, `${endpoint} error code`).toBe('invalid_request');
      expect(body.error_description).toMatch(/ttlSeconds/);
    }
  });

  it('an ABSENT ttlSeconds is fine and mints the default lifetime, on both endpoints', async () => {
    const resps = await bothEndpoints(undefined);
    for (const [endpoint, resp] of Object.entries(resps)) {
      expect(resp.status, endpoint).toBe(200);
      const body = await resp.json() as { access_token: string; expires_in: number };
      expect(lifetimeOf(body.access_token), endpoint).toBe(ACCESS_TOKEN_TTL);
      expect(body.expires_in, endpoint).toBe(ACCESS_TOKEN_TTL);
    }
  });

  // The property that actually protects the revocation bound, stated so it can red on the hole it
  // exists for: NO request — valid or malformed — may end in a minted token without a finite `exp`.
  //
  // ⚠️ It MUST feed the dangerous values, not just the valid ones. An earlier draft looped over
  // `[undefined, 1, …, 99_999]` and asserted 200-plus-finite-exp; under the `<= 0`-only mutation
  // that version stayed GREEN, because it never sent a string — it was asserting finite `exp` for
  // inputs that were already numbers. Refused-or-finite over the WHOLE input set is what makes it
  // capable of failing (`testing.md` § fixture that can't distinguish old from new).
  it.each([
    ['valid: absent', undefined], ['valid: 1', 1], ['valid: recommended', RECOMMENDED_MIN_TTL_SECONDS],
    ['valid: ceiling', ACCESS_TOKEN_TTL], ['valid: over-ceiling', 99_999],
    ['malformed: string', 'abc'], ['malformed: null', null], ['malformed: object', {}],
    ['malformed: float', 1.5], ['malformed: zero', 0], ['malformed: negative', -1],
  ])('%s is either refused or mints a finite exp, on both endpoints', async (_label, ttl) => {
    const resps = await bothEndpoints(ttl);
    for (const [endpoint, resp] of Object.entries(resps)) {
      if (resp.status === 400) continue; // refused — no token to inspect
      expect(resp.status, `${endpoint} must 200 or 400`).toBe(200);
      const { access_token } = await resp.json() as { access_token: string };
      const exp = (parseJwtUnsafe(access_token)!.payload as { exp: unknown }).exp;
      expect(Number.isFinite(exp), `${endpoint} minted a token with exp=${JSON.stringify(exp)}`).toBe(true);
    }
  });
});

describe('ttlSeconds — the ceiling is CLAMPED, not rejected', () => {
  // Mutation: pass the requested value straight through → `exp - iat` exceeds the ceiling → reds.
  it('a TTL longer than ACCESS_TOKEN_TTL mints a token clamped to it, on BOTH endpoints', async () => {
    const resps = await bothEndpoints(ACCESS_TOKEN_TTL * 4);
    for (const [endpoint, resp] of Object.entries(resps)) {
      expect(resp.status, endpoint).toBe(200);
      const body = await resp.json() as { access_token: string; expires_in: number };
      expect(lifetimeOf(body.access_token), `${endpoint} lifetime`).toBe(ACCESS_TOKEN_TTL);
      expect(body.expires_in, `${endpoint} expires_in`).toBe(ACCESS_TOKEN_TTL);
    }
  });
});

describe('ttlSeconds — a short TTL is honoured, and expires_in reports the EFFECTIVE lifetime', () => {
  // Mutation: ignore the parameter → `exp - iat` is the default → reds.
  // The `expires_in` half is separate on purpose: a build that honours `ttlSeconds` in the JWT while
  // leaving the response constant passes the lifetime assertion alone while misreporting by up to
  // 15 minutes on the OAuth-conventional field.
  it('mints exactly the requested lifetime and reports it, on BOTH endpoints', async () => {
    const requested = 300;
    const resps = await bothEndpoints(requested);
    for (const [endpoint, resp] of Object.entries(resps)) {
      expect(resp.status, endpoint).toBe(200);
      const body = await resp.json() as { access_token: string; expires_in: number };
      expect(lifetimeOf(body.access_token), `${endpoint} lifetime`).toBe(requested);
      expect(body.expires_in, `${endpoint} expires_in`).toBe(requested);
    }
  });
});

describe('ttlSeconds — the advisory short-TTL warn', () => {
  let sink: any[] = [];
  beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
  afterEach(() => clearDebugSink());

  const warns = () => sink.filter((e) => e.namespace === 'nebula-auth.worker.ttl.short');

  // Mutation: drop the warn → the marker is absent → reds.
  it('warns below RECOMMENDED_MIN_TTL_SECONDS, on BOTH endpoints, naming both hazards', async () => {
    const requested = RECOMMENDED_MIN_TTL_SECONDS - 1;
    const resps = await bothEndpoints(requested);
    for (const resp of Object.values(resps)) expect(resp.status).toBe(200);

    // One per endpoint — this is the property that keeps the two mints from diverging.
    expect(warns().length).toBe(2);
    for (const w of warns()) {
      expect(w.data.requestedTtlSeconds).toBe(requested);
      expect(w.data.effectiveTtlSeconds).toBe(requested);
      // BOTH hazards, because only one of them is about the value's range — the other is that a
      // shorter TTL bounds the SUBJECT side only. A warn naming just the first teaches the wrong
      // lesson to exactly the reader it exists for.
      expect(w.data.hazards).toHaveLength(2);
      expect(JSON.stringify(w.data.hazards)).toMatch(/re-mints continuously/);
      expect(JSON.stringify(w.data.hazards)).toMatch(/SUBJECT side only/);
    }
  });

  it('does NOT warn at or above the threshold, on either endpoint', async () => {
    for (const resp of Object.values(await bothEndpoints(RECOMMENDED_MIN_TTL_SECONDS))) {
      expect(resp.status).toBe(200);
    }
    expect(warns()).toEqual([]);
  });

  // ⚠️ This does NOT discriminate effective-keyed from requested-keyed, and an earlier comment here
  // wrongly claimed it did: the clamp only ever shortens and the ceiling (900) sits far above the
  // threshold (120), so `effective < 120` and `requested < 120` agree on every possible input. What
  // it does pin is that the warn is CONDITIONAL — it reds if the warn is made unconditional or the
  // comparison is inverted.
  it('does not warn for an over-ceiling request, which clamps to a long lifetime', async () => {
    for (const resp of Object.values(await bothEndpoints(ACCESS_TOKEN_TTL * 4))) {
      expect(resp.status).toBe(200);
    }
    expect(warns()).toEqual([]);
  });

  it('never logs the minted token', async () => {
    await bothEndpoints(30);
    for (const w of warns()) {
      expect(JSON.stringify(w.data)).not.toMatch(/eyJ/); // a JWT's base64url header prefix
    }
  });
});
