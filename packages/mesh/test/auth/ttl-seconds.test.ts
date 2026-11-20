/**
 * `ttlSeconds` on the impersonation mint (`mintImpersonationToken`, behind
 * `AuthFacade.impersonate`), and its absence from the refresh, which reads no body and so always
 * mints the default lifetime.
 *
 * The parameter can only ever SHORTEN a token: the ceiling is clamped (not rejected), the lower
 * bound and the type are an accept-list (rejected), and an implausibly short value is warned about
 * but honoured.
 *
 * ⚠️ **Why the type check is the security-relevant one, and a `<= 0` guard is not enough.**
 * `buildAuthClaims` computes `exp: now + (ttlSeconds ?? ACCESS_TOKEN_TTL)`, so a non-numeric
 * value yields `exp: NaN` — and it slips past BOTH naive guards, since `NaN <= 0` is `false` and
 * `Math.min(NaN, 900)` is `NaN`. `signJwt` serializes with `JSON.stringify` (writing `NaN` as
 * `null`), and `verifyJwt`'s check is `if (payload.exp && payload.exp < now)` — a null `exp` is
 * FALSY, so expiry is skipped and the token verifies forever. `security.md` names the short
 * access-TTL as THE mitigation while a revocation propagates through KV, so an `exp`-less token
 * deletes that bound. Hence the finite-`exp` assertion below, which is the property that matters
 * rather than a proxy for it.
 *
 * ADR-009 rung 2 — real server issuance, no email hop, no client mint. The impersonation mint is
 * driven as the function the facade calls, with the claims of a real login's verified token: this
 * lane holds no Gateway to reach the facade through, and the facade adds only the typed refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { foundUniverse, inviteAndLogin, verifiedClaims, authUrl, refreshCookie, scopeOrigin } from './test-helpers';
import { mintImpersonationToken, mintAccessToken, accessTokenCeiling } from '../../src/auth/worker-token';
import { ACCESS_TOKEN_TTL, RECOMMENDED_MIN_TTL_SECONDS } from '../../src/auth/types';

function uni(): string { return `u${crypto.randomUUID().slice(0, 8)}`; }

/** The refresh with a body page script might add, which the route never reads. */
async function refreshWith(scope: string, refreshToken: string, body: Record<string, unknown>) {
  return SELF.fetch(new Request(authUrl('refresh-token'), {
    method: 'POST',
    headers: { Origin: scopeOrigin(scope), Cookie: refreshCookie(scope, refreshToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/** `exp - iat` off a minted token — the actual lifetime, independent of what `expires_in` claims. */
function lifetimeOf(accessToken: string): number {
  const p = parseJwtUnsafe(accessToken)!.payload as { exp: number; iat: number };
  return p.exp - p.iat;
}

/** What one mint answered: a refusal and its message, or the token and its reported lifetime. */
type Outcome = { refused: true; message: string } | { refused: false; access_token: string; expires_in: number };

/**
 * The impersonation mint's answer for a given `ttlSeconds`, keyed by its name so each assertion
 * below says which mint it is about. The refresh is not here: it takes no `ttlSeconds` at all, which
 * the last describe asserts.
 */
async function impersonationMint(ttlSeconds?: unknown): Promise<Record<string, Outcome>> {
  const u = uni();
  // One address per call: each founding writes a first app, and one address may own at most
  // MAX_GALAXIES_PER_OWNER galaxies, so a shared address would hit the cap a few dozen calls in.
  const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
  const member = await inviteAndLogin(SELF, u, admin.access_token, 'member@example.com');
  const minted = await mintImpersonationToken(env as Env, await verifiedClaims(admin.access_token), member.parsed.sub, ttlSeconds);
  const impersonate: Outcome = minted.ok
    ? { refused: false, access_token: minted.accessToken, expires_in: minted.expiresIn }
    : { refused: true, message: minted.message };
  return { impersonate };
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
  ])('refuses %s, naming ttlSeconds', async (_label, value) => {
    const resps = await impersonationMint(value);
    for (const [endpoint, out] of Object.entries(resps)) {
      expect(out.refused, `${endpoint} should refuse`).toBe(true);
      expect((out as { message: string }).message, endpoint).toMatch(/ttlSeconds/);
    }
  });

  it('an ABSENT ttlSeconds is fine and mints the default lifetime', async () => {
    const resps = await impersonationMint(undefined);
    for (const [endpoint, body] of Object.entries(resps)) {
      if (body.refused) throw new Error(`${endpoint} refused: ${body.message}`);
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
  ])('%s is either refused or mints a finite exp', async (_label, ttl) => {
    const resps = await impersonationMint(ttl);
    for (const [endpoint, out] of Object.entries(resps)) {
      if (out.refused) continue; // refused — no token to inspect
      const { access_token } = out;
      const exp = (parseJwtUnsafe(access_token)!.payload as { exp: unknown }).exp;
      expect(Number.isFinite(exp), `${endpoint} minted a token with exp=${JSON.stringify(exp)}`).toBe(true);
    }
  });
});

describe('ttlSeconds — the ceiling is CLAMPED, not rejected', () => {
  // Mutation: pass the requested value straight through → `exp - iat` exceeds the ceiling → reds.
  it('a TTL longer than ACCESS_TOKEN_TTL mints a token clamped to it', async () => {
    const resps = await impersonationMint(ACCESS_TOKEN_TTL * 4);
    for (const [endpoint, body] of Object.entries(resps)) {
      if (body.refused) throw new Error(`${endpoint} refused: ${body.message}`);
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
  it('mints exactly the requested lifetime and reports it', async () => {
    const requested = 300;
    const resps = await impersonationMint(requested);
    for (const [endpoint, body] of Object.entries(resps)) {
      if (body.refused) throw new Error(`${endpoint} refused: ${body.message}`);
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
  it('warns below RECOMMENDED_MIN_TTL_SECONDS, naming both hazards', async () => {
    const requested = RECOMMENDED_MIN_TTL_SECONDS - 1;
    const resps = await impersonationMint(requested);
    for (const out of Object.values(resps)) expect(out.refused).toBe(false);

    expect(warns().length).toBe(1);
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

  it('does NOT warn at or above the threshold', async () => {
    for (const out of Object.values(await impersonationMint(RECOMMENDED_MIN_TTL_SECONDS))) {
      expect(out.refused).toBe(false);
    }
    expect(warns()).toEqual([]);
  });

  // ⚠️ This does NOT discriminate effective-keyed from requested-keyed, and an earlier comment here
  // wrongly claimed it did: the clamp only ever shortens and the ceiling (900) sits far above the
  // threshold (120), so `effective < 120` and `requested < 120` agree on every possible input. What
  // it does pin is that the warn is CONDITIONAL — it reds if the warn is made unconditional or the
  // comparison is inverted.
  it('does not warn for an over-ceiling request, which clamps to a long lifetime', async () => {
    for (const out of Object.values(await impersonationMint(ACCESS_TOKEN_TTL * 4))) {
      expect(out.refused).toBe(false);
    }
    expect(warns()).toEqual([]);
  });

  it('never logs the minted token', async () => {
    await impersonationMint(30);
    for (const w of warns()) {
      expect(JSON.stringify(w.data)).not.toMatch(/eyJ/); // a JWT's base64url header prefix
    }
  });
});

describe('the refresh takes no ttlSeconds', () => {
  // The refresh reads no body, so a page cannot shorten, lengthen or break its own token's
  // lifetime. Mutation: read `ttlSeconds` from a body again, and the short request mints short.
  it.each([
    ['a short value', 30], ['a string', 'abc'], ['zero', 0], ['an over-ceiling value', ACCESS_TOKEN_TTL * 4],
  ])('ignores %s in a body, minting the default lifetime', async (_label, ttlSeconds) => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, `admin-${u}@example.com`);
    const resp = await refreshWith(u, admin.refreshToken, { ttlSeconds });
    expect(resp.status).toBe(200);
    const { access_token, expires_in } = await resp.json() as { access_token: string; expires_in: number };
    expect(lifetimeOf(access_token)).toBe(ACCESS_TOKEN_TTL);
    expect(expires_in).toBe(ACCESS_TOKEN_TTL);
  });
});

describe('AUTH_ACCESS_TOKEN_TTL — the env var may only SHORTEN the lifetime', () => {
  // The parse is a pure function of one var, so it needs no running system;
  // `session-survives-token-lapse` is where a shortened ceiling reaches a real login's refresh.
  it.each([['120', 120], ['1', 1], [String(ACCESS_TOKEN_TTL - 1), ACCESS_TOKEN_TTL - 1]])(
    'honours %s', (value, expected) => {
      expect(accessTokenCeiling({ AUTH_ACCESS_TOKEN_TTL: value })).toBe(expected);
    });
  // Mutation: drop the `< ACCESS_TOKEN_TTL` bound, and the longer values lengthen the token.
  it.each(['', '0', '-5', '90.5', 'abc', String(ACCESS_TOKEN_TTL), String(ACCESS_TOKEN_TTL * 4)])(
    'ignores %j', (value) => {
      expect(accessTokenCeiling({ AUTH_ACCESS_TOKEN_TTL: value })).toBe(ACCESS_TOKEN_TTL);
    });

  // Mutation: clamp to the constant in `mintAccessToken` again, and this mints 900.
  it('the mint honours a shortened ceiling', async () => {
    const scope = uni();
    const { accessToken, effectiveTtlSeconds } = await mintAccessToken(
      { ...env, AUTH_ACCESS_TOKEN_TTL: String(RECOMMENDED_MIN_TTL_SECONDS) },
      { sub: crypto.randomUUID(), universeGalaxyStarId: scope, scopeAdmin: false, activeScope: scope, profileId: crypto.randomUUID() },
    );
    expect(effectiveTtlSeconds).toBe(RECOMMENDED_MIN_TTL_SECONDS);
    expect(lifetimeOf(accessToken)).toBe(RECOMMENDED_MIN_TTL_SECONDS);
  });
});
