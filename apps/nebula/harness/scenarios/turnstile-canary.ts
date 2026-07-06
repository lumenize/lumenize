/**
 * Turnstile canary — verify, against a REALLY-booted worker with Turnstile genuinely ON, that:
 *   1. the gate BLOCKS a normal request (403 turnstile) — i.e. today's SPA (no widget) would break;
 *   2. the authorized header **bypass** carries automation THROUGH (the path only unit-tested so far);
 *   3. a WRONG bypass token is still blocked (the token is validated, not mere header-presence);
 *   4. a request carrying a Turnstile token PASSES (the widget fix will work once the SPA sends one);
 *   5. the login path (`email-magic-link`) also blocks as-is — the confirmed UI blocker.
 *
 * Run with the always-passes Turnstile TEST secret injected for one boot:
 *   HARNESS_TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
 *     npx tsx apps/nebula/harness/drive.ts turnstile-canary
 *
 * All probes hit `discover` (unauthenticated, NO side effect) except probe 5, which hits
 * `email-magic-link` with no token → it 403s at the gate BEFORE any email is sent. Zero emails.
 *
 * Capable-of-failing: every probe asserts. If probe 1 doesn't block, the gate isn't on (the run is
 * missing HARNESS_TURNSTILE_SECRET) and the scenario fails loudly with that guidance.
 */
import assert from 'node:assert/strict';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';

const BYPASS_HEADER = 'x-lumenize-turnstile-bypass';
/** A Star-tier scope for the login-path probe; the gate runs before scope resolution, so any works. */
const LOGIN_SCOPE = 'claude.sandbox.dev';

interface ProbeResult {
  status: number;
  text: string;
}

/** True when the response is a Turnstile gate rejection (403 whose body names turnstile). */
function isTurnstileBlock(r: ProbeResult): boolean {
  return r.status === 403 && /turnstile/i.test(r.text);
}

export async function run(stack: DevStack): Promise<void> {
  const bypassToken = readDevVar('NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN');

  async function post(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<ProbeResult> {
    const res = await fetch(`${stack.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text().catch(() => '') };
  }

  const email = 'canary@example.com';

  // ── 1. Gate ON: a plain request (what the current SPA sends — no token, no bypass) is BLOCKED ──
  const plain = await post('/auth/discover', { email });
  assert.ok(
    isTurnstileBlock(plain),
    `Probe 1 (gate ON): discover with no token/bypass should 403-turnstile, got ${plain.status} ` +
      `"${plain.text.slice(0, 120)}". If this is a non-turnstile pass-through, the gate isn't on — ` +
      `run with HARNESS_TURNSTILE_SECRET=1x0000000000000000000000000000000AA.`,
  );
  console.error(`  ✓ probe 1 — gate ON, plain request BLOCKED (${plain.status})`);

  // ── 2. Bypass WORKS: the authorized header carries the request THROUGH the gate ──
  const bypassed = await post('/auth/discover', { email }, { [BYPASS_HEADER]: bypassToken });
  assert.ok(
    !isTurnstileBlock(bypassed),
    `Probe 2 (bypass): discover WITH the authorized bypass header must pass the gate, but was ` +
      `turnstile-blocked (${bypassed.status} "${bypassed.text.slice(0, 120)}").`,
  );
  console.error(`  ✓ probe 2 — authorized bypass PASSES the gate (${bypassed.status})`);

  // ── 3. WRONG bypass token is still BLOCKED (validated, not header-presence) ──
  const wrongBypass = await post('/auth/discover', { email }, { [BYPASS_HEADER]: `${bypassToken}x` });
  assert.ok(
    isTurnstileBlock(wrongBypass),
    `Probe 3 (wrong token): a WRONG bypass token must still be blocked, got ${wrongBypass.status} ` +
      `"${wrongBypass.text.slice(0, 120)}" — the token is not being validated.`,
  );
  console.error(`  ✓ probe 3 — wrong bypass token REJECTED (${wrongBypass.status})`);

  // ── 4. Widget path: a request carrying a Turnstile token PASSES (test secret always-passes) ──
  //     Confirms the SPA fix (send `cf-turnstile-response`) will clear the gate. Real siteverify call.
  const widget = await post('/auth/discover', { email, 'cf-turnstile-response': 'canary-dummy-token' });
  assert.ok(
    !isTurnstileBlock(widget),
    `Probe 4 (widget path): discover carrying a Turnstile token should pass (the always-passes test ` +
      `secret verifies any token), but was blocked (${widget.status} "${widget.text.slice(0, 120)}").`,
  );
  console.error(`  ✓ probe 4 — widget token path PASSES the gate (${widget.status})`);

  // ── 5. Login path also blocks as-is: email-magic-link with no token → 403 at the gate, no email ──
  const login = await post(`/auth/${LOGIN_SCOPE}/email-magic-link`, { email });
  assert.ok(
    isTurnstileBlock(login),
    `Probe 5 (login break): email-magic-link with no token should 403-turnstile (the confirmed SPA ` +
      `blocker), got ${login.status} "${login.text.slice(0, 120)}".`,
  );
  console.error(`  ✓ probe 5 — login path (email-magic-link) BLOCKED as-is (${login.status})`);

  console.error(
    '  ── canary result: Turnstile gate ON works; bypass verified end-to-end on a real worker; ' +
      'wrong-token rejected; widget path will clear the gate; login/discover break until the SPA ' +
      'sends a token (the confirmed UI blocker).',
  );
}
