/**
 * Turnstile bypass token — `isTurnstileBypassed` (router.ts). The authorized inspection identity
 * (the `/live` prod-drive) skips Turnstile by presenting the `x-lumenize-turnstile-bypass` header
 * equal to `NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN`; every other request stays Turnstile-gated.
 * See tasks/archive/claude-live-verification.md (the Turnstile-bypass follow-up).
 *
 * Pure-function unit test (no DO): constructs a Request + a plain env and asserts the decision. Each
 * case is capable-of-failing — a getter that ignored the header, the token-unset guard, or the
 * equality check would red at least one.
 */
import { describe, it, expect } from 'vitest';
import { isTurnstileBypassed, TURNSTILE_BYPASS_HEADER } from '../src/router';

const TOKEN = 'bypass-secret-3f9a2c8e1b7d4056a1c2e3f40506a7b8';
const req = (headers: Record<string, string> = {}) =>
  new Request('https://nebula.lumenize.com/auth/nebula-platform/email-magic-link', { method: 'POST', headers });

describe('Turnstile bypass token (isTurnstileBypassed)', () => {
  it('allows the bypass ONLY with the exact token in the header', () => {
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: TOKEN }), { NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN })).toBe(true);
  });

  it('denies a WRONG token (Turnstile stays enforced) — reds if the header value isn\'t actually checked', () => {
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: 'wrong' }), { NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN })).toBe(false);
    // A near-miss (correct prefix, extra char) must also fail — constant-time compare, exact match.
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: TOKEN + 'x' }), { NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN })).toBe(false);
  });

  it('denies when the header is ABSENT (the normal-user path)', () => {
    expect(isTurnstileBypassed(req(), { NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN: TOKEN })).toBe(false);
  });

  it('is DISABLED when the knob is unset/empty (no accidental open bypass) — reds if the unset guard is dropped', () => {
    // Knob unset → even a matching-looking header can't bypass (there's nothing to match).
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: TOKEN }), {})).toBe(false);
    // Empty-string knob must NOT match an empty header (both empty would `constantTimeEqual` true —
    // the `if (!bypassToken) return false` guard prevents that footgun).
    expect(isTurnstileBypassed(req({ [TURNSTILE_BYPASS_HEADER]: '' }), { NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN: '' })).toBe(false);
  });
});
