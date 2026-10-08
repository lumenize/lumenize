/**
 * Turnstile bypass token — `isTurnstileBypassed` (router.ts). The authorized inspection identity
 * (the `/live` prod-drive) skips Turnstile by presenting the `x-lumenize-turnstile-bypass` header
 * equal to `AUTH_TURNSTILE_BYPASS_TOKEN`; every other request stays Turnstile-gated.
 * See tasks/archive/claude-live-verification.md (the Turnstile-bypass follow-up).
 *
 * Pure-function unit test (no DO): constructs a Request + a plain env and asserts the decision. Each
 * case is capable-of-failing — a getter that ignored the header, the token-unset guard, or the
 * equality check would red at least one.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { isTurnstileBypassed, routeNebulaAuthRequest, TURNSTILE_BYPASS_HEADER } from '../src/router';
import { recordingHooks } from './test-worker-and-dos';
import { PLATFORM } from './test-helpers';

const TOKEN = 'bypass-secret-3f9a2c8e1b7d4056a1c2e3f40506a7b8';
// The URL is inert for these — `isTurnstileBypassed` reads the HEADER — but it names a live route so
// a reader is not sent looking for one that no longer exists.
const req = (headers: Record<string, string> = {}) =>
  new Request(`${PLATFORM}/auth/email-magic-link`, { method: 'POST', headers });

describe('Turnstile bypass token (isTurnstileBypassed)', () => {
  it('allows the bypass ONLY with the exact token in the header', () => {
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: TOKEN }), { AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN })).toBe(true);
  });

  it('denies a WRONG token (Turnstile stays enforced) — reds if the header value isn\'t actually checked', () => {
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: 'wrong' }), { AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN })).toBe(false);
    // A near-miss (correct prefix, extra char) must also fail — constant-time compare, exact match.
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: TOKEN + 'x' }), { AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN })).toBe(false);
  });

  it('denies when the header is ABSENT (the normal-user path)', () => {
    expect(isTurnstileBypassed(req(), { AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN })).toBe(false);
  });

  it('is DISABLED when the knob is unset/empty (no accidental open bypass) — reds if the unset guard is dropped', () => {
    // Knob unset → even a matching-looking header can't bypass (there's nothing to match).
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: TOKEN }), {})).toBe(false);
    // Empty-string knob must NOT match an empty header (both empty would `constantTimeEqual` true —
    // the `if (!bypassToken) return false` guard prevents that footgun).
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: '' }), { AUTH_TURNSTILE_BYPASS_TOKEN: '' })).toBe(false);
  });
});

/**
 * 🔒 Which routes Turnstile GATES — asserted BEHAVIOURALLY, in both directions, on the real path.
 *
 * Mechanism: a PER-TEST env spread passed to `routeNebulaAuthRequest` binding a non-empty secret
 * (`checkTurnstile` no longer short-circuits on `AUTH_TEST_MODE`, so the doctored env
 * reaches the real gated code). A token-less request then answers `403 turnstile_required` on a
 * gated route BEFORE any `siteverify` fetch — so the present/absent sweep costs no network — and
 * something else (never `turnstile_required`) everywhere else. The expectation is ENUMERATED from
 * the route table, not derived: "gated wherever unauthenticated" is false (the cookie routes and
 * the GET navigations carry neither guard).
 */
describe('Turnstile gating (behavioural, per-test env spread)', () => {
  /** A non-empty secret, no bypass knob — the gate is ON; no request here carries a token. */
  const gatedEnv = { ...env, TURNSTILE_SECRET_KEY: 'gate-on-not-a-real-secret' } as any;
  const post = (path: string, body: unknown = {}) =>
    routeNebulaAuthRequest(new Request(`${PLATFORM}/auth/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), gatedEnv, { hooks: recordingHooks });

  // The open rows — the ONLY bound on them besides the connection limiter: `checkRateLimit`
  // keys on the verified `payload.sub`, so it never runs where there is no JWT. (`discover` was a
  // fourth until it was retired; the list is the table's, not a fixed count.)
  it.each(['claim-star', 'claim-universe'])(
    'gates the open registry route %s (403 turnstile_required, before any siteverify)',
    async (endpoint) => {
      const resp = await post(endpoint, { email: 'x@example.com' });
      expect(resp?.status).toBe(403);
      expect((await resp!.json() as any).error).toBe('turnstile_required');
    });

  it('gates email-magic-link (the open scope-less route)', async () => {
    const resp = await post('email-magic-link', { email: 'x@example.com' });
    expect(resp?.status).toBe(403);
    expect((await resp!.json() as any).error).toBe('turnstile_required');
  });

  it('does NOT gate any other row — enumerated, and none may answer turnstile_required', async () => {
    // Every remaining table row, driven token-less under the same gated env. Each refuses (or
    // 400s) for its OWN reason; a `turnstile_required` from any of them reds this — the direction
    // that catches a route GAINING the guard where it does not belong.
    // ⚠️ **A hand-kept list, and it rots in the quiet direction.** It carried `my-scopes` for a while
    // after that route was retired: a path with no row 404s, which is not `turnstile_required`, so
    // the dead entry passed and the list looked exhaustive while covering one row less. If you retire
    // a route, delete it here too — `turnstile-by-credential.test.ts` is the check that CANNOT rot
    // this way, because it derives its set from the table itself.
    const posts = [
      'coming-soon', 'signup', 'refresh-token', 'logout', 'home-summary', 'pending-membership',
      'accept-membership', 'magic-link', 'magic-link/lookup',
    ];
    for (const path of posts) {
      const resp = await post(path);
      expect((await resp!.json().catch(() => ({})) as any).error, path).not.toBe('turnstile_required');
    }
    // The page GETs need a sharper anchor than not-turnstile_required: a turnstileGuard gained on a
    // bodyless GET fails checkTurnstile's BODY PARSE (400 invalid_request), never
    // turnstile_required — so only the page step's own answer, the missing assets binding, proves
    // no gate ran ahead of it.
    for (const path of ['magic-link', 'login', 'logout']) {
      const resp = await routeNebulaAuthRequest(
        new Request(`${PLATFORM}/auth/${path}`), gatedEnv, { hooks: recordingHooks });
      expect((await resp!.json() as any).error, path).toBe('assets_unavailable');
    }
  });

  // The other direction: a BAD token is refused by a real `siteverify` round trip against
  // Cloudflare's always-fail dummy secret — this is what catches a route silently LOSING
  // `turnstileGuard` while the sweep above stays green on `turnstile_required` alone.
  it('refuses a bad token via a real siteverify (always-fail dummy secret)', { timeout: 10_000 }, async () => {
    const resp = await routeNebulaAuthRequest(new Request(`${PLATFORM}/auth/claim-universe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'x', email: 'x@example.com', turnstileToken: 'dummy-token' }),
    }), { ...env, TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' } as any, { hooks: recordingHooks });
    expect(resp?.status).toBe(403);
    expect((await resp!.json() as any).error).toBe('turnstile_failed');
  });

  // The pass-through paths, each still passing through after the migration:
  it('passes through on an ABSENT/empty secret (the dev + test-lane path)', async () => {
    // The lane's own env — TURNSTILE_SECRET_KEY bound '' — so this reaches the DO and 400s on the
    // missing slug rather than on Turnstile.
    const resp = await routeNebulaAuthRequest(new Request(`${PLATFORM}/auth/claim-universe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    }), env as any, { hooks: recordingHooks });
    expect((await resp!.json() as any).error).not.toBe('turnstile_required');
  });

  it('passes through on the authorized bypass header, with the gate otherwise ON', async () => {
    const resp = await routeNebulaAuthRequest(new Request(`${PLATFORM}/auth/claim-universe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TURNSTILE_BYPASS_HEADER]: TOKEN },
      body: JSON.stringify({ email: 'x@example.com' }), // no slug → the DO's own 400, not Turnstile's
    }), { ...env, TURNSTILE_SECRET_KEY: 'gate-on', AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN } as any, { hooks: recordingHooks });
    expect((await resp!.json() as any).error).not.toBe('turnstile_required');
  });
});
